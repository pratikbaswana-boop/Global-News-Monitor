import { getActiveStories, isGraphAvailable } from "../src/services/graph/index.js";
import { isChromaAvailable } from "../src/services/reasoning/chromadb-client.js";
import { runPipeline } from "../src/services/reasoning/pipeline.js";

async function main() {
  const [graphOk, chromaOk] = await Promise.all([
    isGraphAvailable().catch(() => false),
    isChromaAvailable().catch(() => false),
  ]);

  if (!graphOk) { console.error("Neo4j unavailable"); process.exit(1); }
  if (!chromaOk) { console.error("ChromaDB unavailable"); process.exit(1); }

  const stories = await getActiveStories().catch(() => []);
  console.log(`Found ${stories.length} active stories`);

  for (const story of stories) {
    try {
      console.log(`Running pipeline for story: ${story.id} (${story.label || "no label"})`);
      await runPipeline(story.id);
      console.log(`  -> done`);
    } catch (err) {
      console.error(`  -> failed: ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
