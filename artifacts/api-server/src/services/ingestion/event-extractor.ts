import { openai } from "@workspace/integrations-openai-ai-server";
import { db, extractedEventsTable, extractionErrorsTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";

interface CameoActor {
  name: string;
  role: string;
  country_iso: string;
  entity_type: "person" | "org" | "state";
}

interface CameoTarget {
  name: string;
  country_iso: string;
  entity_type: string;
}

interface CameoLocation {
  country_iso: string;
  region: string;
  city: string;
}

interface ExtractionOutput {
  actors: CameoActor[];
  action_type: string;
  action_label: string;
  target: CameoTarget;
  location: CameoLocation;
  event_date: string;
  stated_intent: string;
  requires_corroboration: boolean;
  confidence: number;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a geopolitical event extractor. Extract structured data from the article. Return ONLY valid JSON. No preamble. No explanation. No markdown fences.

OUTPUT SCHEMA:
{
  "actors": [{"name": str, "role": str, "country_iso": str, "entity_type": "person|org|state"}],
  "action_type": str,
  "action_label": str,
  "target": {"name": str, "country_iso": str, "entity_type": str},
  "location": {"country_iso": str, "region": str, "city": str},
  "event_date": str,
  "stated_intent": str,
  "requires_corroboration": bool,
  "confidence": float
}

action_type must be a CAMEO code like: SANCTION, MOBILIZE_MILITARY, NEGOTIATE, CONDEMN, THREATEN, PROVIDE_AID, SIGN_TREATY, IMPOSE_EMBARGO, EXPEL_DIPLOMAT, CEASEFIRE, PROTEST, ELECTION, POLICY_CHANGE, ECONOMIC_ACTION.
event_date must be ISO 8601 or "UNKNOWN".
requires_corroboration: true if single source AND credibility is uncertain.
confidence: 0.0 to 1.0.`;

export async function extractEventFromArticle(
  articleId: string,
  title: string,
  body: string,
  credibilityTier: number,
  isStateMedia: boolean
): Promise<void> {
  const userContent = `Article title: ${title}\n\nArticle body:\n${body.slice(0, 3000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 600,
    });

    const rawContent = response.choices[0]?.message?.content ?? "";
    let parsed: ExtractionOutput;

    try {
      // Strip markdown fences if model ignored instruction
      const jsonStr = rawContent.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(jsonStr) as ExtractionOutput;
    } catch {
      await db.insert(extractionErrorsTable).values({
        id: randomUUID(),
        articleId,
        errorType: "malformed_json",
        errorMessage: "Failed to parse GPT-4o JSON response",
        rawResponse: rawContent.slice(0, 2000),
      });
      return;
    }

    // requiresCorroboration: force true for state media single-source
    const requiresCorroboration =
      parsed.requires_corroboration || (isStateMedia && credibilityTier >= 3);

    await db.insert(extractedEventsTable).values({
      id: randomUUID(),
      articleId,
      actors: JSON.stringify(parsed.actors ?? []),
      actionType: parsed.action_type ?? "UNKNOWN",
      actionLabel: parsed.action_label ?? "",
      target: JSON.stringify(parsed.target ?? {}),
      location: JSON.stringify(parsed.location ?? {}),
      eventDate: parsed.event_date ?? "UNKNOWN",
      statedIntent: (parsed.stated_intent ?? "").slice(0, 500),
      requiresCorroboration,
      isHypothesis: requiresCorroboration,
      confidence: Math.min(1.0, Math.max(0.0, parsed.confidence ?? 0.5)),
    });

    logger.debug({ articleId, actionType: parsed.action_type }, "event extracted");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rate_limit") || msg.includes("429")) {
      // Back off — caller handles retry
      throw err;
    }
    await db.insert(extractionErrorsTable).values({
      id: randomUUID(),
      articleId,
      errorType: "model_refusal",
      errorMessage: msg.slice(0, 1000),
      rawResponse: null,
    });
    logger.warn({ articleId, err: msg }, "event extraction failed");
  }
}

// Pre-extracted GDELT event — bypass GPT-4o
export async function insertGdeltEvent(
  articleId: string,
  cameoCode: string,
  actionLabel: string,
  actor1Name: string,
  actor1Country: string,
  actor2Name: string,
  actor2Country: string,
  locationCountry: string,
  locationName: string,
  eventDate: string,
  confidence: number
): Promise<void> {
  await db.insert(extractedEventsTable).values({
    id: randomUUID(),
    articleId,
    actors: JSON.stringify([
      { name: actor1Name, role: "primary", country_iso: actor1Country, entity_type: "state" },
      { name: actor2Name, role: "target", country_iso: actor2Country, entity_type: "state" },
    ]),
    actionType: cameoCode,
    actionLabel,
    target: JSON.stringify({ name: actor2Name, country_iso: actor2Country, entity_type: "state" }),
    location: JSON.stringify({ country_iso: locationCountry, region: locationName, city: "" }),
    eventDate,
    statedIntent: "",
    requiresCorroboration: false,
    isHypothesis: false,
    confidence,
  }).onConflictDoNothing();
}
