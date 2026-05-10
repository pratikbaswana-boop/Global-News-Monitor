import neo4j, { Driver, Session, QueryResult } from "neo4j-driver";
import { logger } from "../../lib/logger.js";

let _driver: Driver | null = null;

export function getDriver(): Driver {
  if (_driver) return _driver;

  const uri = process.env["NEO4J_URI"];
  const user = process.env["NEO4J_USER"] ?? "neo4j";
  const password = process.env["NEO4J_PASSWORD"];

  if (!uri || !password) {
    throw new Error("NEO4J_URI and NEO4J_PASSWORD env vars required for Phase 2");
  }

  _driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 15,
    connectionAcquisitionTimeout: 10_000,
  });
  return _driver;
}

export async function isGraphAvailable(): Promise<boolean> {
  try {
    const driver = getDriver();
    await driver.verifyConnectivity();
    return true;
  } catch {
    return false;
  }
}

export async function runCypher(
  query: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult> {
  const driver = getDriver();
  const session: Session = driver.session();
  try {
    return await session.run(query, params);
  } finally {
    await session.close();
  }
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
