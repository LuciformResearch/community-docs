/**
 * Test script for CommunityIngester
 *
 * Tests the new createCommunityIngester factory with file ingestion
 *
 * Usage: npx tsx scripts/test-orchestrator.ts
 */

import { createCommunityIngester } from "../lib/ragforge/community-ingester";
import { getNeo4jClient } from "../lib/ragforge/neo4j-client";
import { Neo4jClient as CoreNeo4jClient } from "@luciformresearch/ragforge";
import neo4j from "neo4j-driver";

async function main() {
  console.log("=== Test CommunityIngester ===\n");

  // Create test file content
  const tsContent = `
/**
 * Test Service for ingester
 */
export interface User {
  id: string;
  name: string;
  email: string;
}

export function createUser(name: string, email: string): User {
  return {
    id: crypto.randomUUID(),
    name,
    email
  };
}

export class UserService {
  private users: Map<string, User> = new Map();

  add(user: User): void {
    this.users.set(user.id, user);
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  list(): User[] {
    return Array.from(this.users.values());
  }
}
`;

  // Initialize Neo4j
  const neo4jClient = getNeo4jClient();
  console.log("Neo4j client obtained");

  // Create Neo4j driver for core client
  const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
  const username = process.env.NEO4J_USER || "neo4j";
  const password = process.env.NEO4J_PASSWORD || "password";

  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));

  // Create core Neo4j client (requires uri, username, password)
  const coreNeo4jClient = new CoreNeo4jClient({ uri, username, password });

  // Create community ingester
  const ingester = createCommunityIngester({
    driver,
    neo4jClient: coreNeo4jClient,
  });

  const projectId = "test-project-001";
  const documentId = "test-doc-001";

  // Test ingestion with metadata using ingestDocument
  console.log("\nIngesting file with community metadata...");
  const stats = await ingester.ingestDocument(
    tsContent,
    "test-service.ts",
    projectId,
    {
      projectId,
      documentId,
      documentTitle: "Test Service Documentation",
      userId: "test-user-001",
      userUsername: "testuser",
      categoryId: "cat-001",
      categorySlug: "typescript",
      categoryName: "TypeScript",
      isPublic: true,
      tags: ["test", "typescript", "service"],
    }
  );

  console.log("\n=== Ingestion Stats ===");
  console.log(`- Files processed: ${stats.filesProcessed}`);
  console.log(`- Scopes created: ${stats.scopesCreated}`);
  console.log(`- Relations created: ${stats.relationsCreated}`);

  // Verify nodes in Neo4j
  console.log("\n=== Verifying nodes in Neo4j ===");
  const result = await neo4jClient.run(`
    MATCH (n {documentId: $documentId})
    RETURN labels(n) as labels, n.name as name, n.documentTitle as title, n.categorySlug as category, n.tags as tags
    LIMIT 10
  `, { documentId });

  console.log(`Found ${result.records.length} nodes:`);
  for (const record of result.records) {
    console.log(`  - [${record.get("labels")}] ${record.get("name")} (category: ${record.get("category")}, tags: ${record.get("tags")})`);
  }

  // Cleanup
  console.log("\n=== Cleanup ===");
  const deleteResult = await neo4jClient.run(`
    MATCH (n {documentId: $documentId})
    DETACH DELETE n
    RETURN count(n) as deleted
  `, { documentId });
  const deletedCount = deleteResult.records[0]?.get("deleted") || 0;
  console.log(`Deleted ${deletedCount} nodes`);

  await driver.close();
  await coreNeo4jClient.close();
  await neo4jClient.close();

  console.log("\n=== Test completed successfully! ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
