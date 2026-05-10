// One-time ingest of ICB Crisis Database and ACLED historical data into ChromaDB.
// ICB: 540 coded historical crises from sites.duke.edu/icbdata (free download)
// ACLED: conflict events aggregated into 30-day country-pair windows
//
// Run via: POST /api/intelligence/corpus/ingest (admin only, idempotent)

import { openai } from "@workspace/integrations-openai-ai-server";
import { getOrCreateCollection, COLLECTION_ICB, COLLECTION_ACLED } from "./chromadb-client.js";
import { logger } from "../../lib/logger.js";

interface IcbCrisis {
  id: string;
  name: string;
  year: number;
  actors: string[];
  outcome: "escalated" | "negotiated" | "frozen" | "other";
  summary: string;
}

interface AcledWindow {
  id: string;
  countryPair: string;
  startDate: string;
  eventCount: number;
  dominantEventType: string;
  summary: string;
}

// GPT-4o generates a 200-word summary of each crisis for embedding
async function summarizeCrisis(crisis: IcbCrisis): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    max_tokens: 250,
    messages: [
      {
        role: "system",
        content: "You generate concise factual summaries of historical international crises for a geopolitical intelligence system. Return only the summary text.",
      },
      {
        role: "user",
        content: `Generate a 200-word factual summary of this historical crisis:
Name: ${crisis.name} (${crisis.year})
Actors: ${crisis.actors.join(", ")}
Outcome: ${crisis.outcome}
Context: ${crisis.summary}`,
      },
    ],
  });
  return response.choices[0]?.message?.content ?? crisis.summary;
}

async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8192),
  });
  return response.data[0].embedding;
}

// Ingest ICB crises into ChromaDB collection
export async function ingestIcbCorpus(crises: IcbCrisis[]): Promise<void> {
  const collection = await getOrCreateCollection(COLLECTION_ICB);
  const existing = await collection.count();
  if (existing >= crises.length) {
    logger.info({ existing }, "ICB corpus already ingested — skipping");
    return;
  }

  logger.info({ total: crises.length }, "starting ICB corpus ingest");

  for (const crisis of crises) {
    try {
      const summary = await summarizeCrisis(crisis);
      const embedding = await embedText(summary);

      await collection.upsert({
        ids: [crisis.id],
        embeddings: [embedding],
        documents: [summary],
        metadatas: [{
          name: crisis.name,
          year: crisis.year,
          actors: crisis.actors.join(","),
          outcome: crisis.outcome,
        }],
      });
    } catch (err) {
      logger.warn({ crisisId: crisis.id, err }, "ICB crisis ingest failed");
    }
  }
  logger.info({ count: crises.length }, "ICB corpus ingest complete");
}

// Ingest ACLED windows into ChromaDB collection
export async function ingestAcledCorpus(windows: AcledWindow[]): Promise<void> {
  const collection = await getOrCreateCollection(COLLECTION_ACLED);
  const existing = await collection.count();
  if (existing >= windows.length) {
    logger.info({ existing }, "ACLED corpus already ingested — skipping");
    return;
  }

  logger.info({ total: windows.length }, "starting ACLED corpus ingest");

  for (const window of windows) {
    try {
      const embedding = await embedText(window.summary);
      await collection.upsert({
        ids: [window.id],
        embeddings: [embedding],
        documents: [window.summary],
        metadatas: [{
          countryPair: window.countryPair,
          startDate: window.startDate,
          eventCount: window.eventCount,
          dominantEventType: window.dominantEventType,
        }],
      });
    } catch (err) {
      logger.warn({ windowId: window.id, err }, "ACLED window ingest failed");
    }
  }
  logger.info({ count: windows.length }, "ACLED corpus ingest complete");
}

// Query both collections for nearest neighbours to a situation summary
export interface HistoricalAnalogue {
  source: "icb" | "acled";
  id: string;
  document: string;
  metadata: Record<string, string | number>;
  similarityScore: number;
}

const SIMILARITY_THRESHOLD = 0.50;

export async function queryHistoricalAnalogues(
  situationText: string,
  topK = 5
): Promise<HistoricalAnalogue[]> {
  const queryEmbedding = await embedText(situationText);

  const [icbCollection, acledCollection] = await Promise.all([
    getOrCreateCollection(COLLECTION_ICB),
    getOrCreateCollection(COLLECTION_ACLED),
  ]);

  const [icbResults, acledResults] = await Promise.all([
    icbCollection.query({ queryEmbeddings: [queryEmbedding], nResults: topK }),
    acledCollection.query({ queryEmbeddings: [queryEmbedding], nResults: topK }),
  ]);

  const analogues: HistoricalAnalogue[] = [];

  const processResults = (results: Awaited<ReturnType<typeof icbCollection.query>>, source: "icb" | "acled") => {
    const ids = results.ids[0] ?? [];
    const docs = results.documents[0] ?? [];
    const metas = results.metadatas[0] ?? [];
    const distances = results.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const cosineDistance = distances[i] ?? 1;
      const similarity = 1 - cosineDistance;
      if (similarity < SIMILARITY_THRESHOLD) continue;
      analogues.push({
        source,
        id: ids[i],
        document: docs[i] ?? "",
        metadata: (metas[i] ?? {}) as Record<string, string | number>,
        similarityScore: similarity,
      });
    }
  };

  processResults(icbResults, "icb");
  processResults(acledResults, "acled");

  return analogues.sort((a, b) => b.similarityScore - a.similarityScore).slice(0, topK);
}
