import { ChromaClient, Collection } from "chromadb";
import { logger } from "../../lib/logger.js";

let _client: ChromaClient | null = null;

export function getChromaClient(): ChromaClient {
  if (_client) return _client;
  const host = process.env["CHROMADB_HOST"] ?? "localhost";
  const port = parseInt(process.env["CHROMADB_PORT"] ?? "8000", 10);
  _client = new ChromaClient({ path: `http://${host}:${port}` });
  return _client;
}

export async function isChromaAvailable(): Promise<boolean> {
  try {
    await getChromaClient().heartbeat();
    return true;
  } catch {
    return false;
  }
}

export async function getOrCreateCollection(name: string): Promise<Collection> {
  const client = getChromaClient();
  return client.getOrCreateCollection({ name, metadata: { "hnsw:space": "cosine" } });
}

export const COLLECTION_ICB = "historical_crises";
export const COLLECTION_ACLED = "acled_windows";
