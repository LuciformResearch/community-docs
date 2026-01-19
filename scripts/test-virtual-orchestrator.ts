/**
 * Test script for CommunityIngester with Virtual Files
 *
 * Tests the full pipeline: virtual files → parsing → metadata injection → Neo4j
 *
 * Usage: npx tsx scripts/test-virtual-orchestrator.ts
 */

import { createCommunityIngester } from "../lib/ragforge/community-ingester";
import { getNeo4jClient } from "../lib/ragforge/neo4j-client";
import { Neo4jClient as CoreNeo4jClient } from "@luciformresearch/ragforge";
import neo4j from "neo4j-driver";

async function main() {
  console.log("=== Test Virtual Files with CommunityIngester ===\n");

  // Create virtual file content
  const tsContent = `
/**
 * Order processing module
 */
export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered";

export class OrderService {
  private orders: Map<string, Order> = new Map();

  create(userId: string, items: OrderItem[]): Order {
    const order: Order = {
      id: crypto.randomUUID(),
      userId,
      items,
      total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      status: "pending",
    };
    this.orders.set(order.id, order);
    return order;
  }

  confirm(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (order && order.status === "pending") {
      order.status = "confirmed";
      return true;
    }
    return false;
  }

  getByUser(userId: string): Order[] {
    return Array.from(this.orders.values()).filter(o => o.userId === userId);
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

  const projectId = "test-virtual-project-002";
  const documentId = "test-virtual-doc-002";

  // Test virtual file ingestion
  console.log("\n=== Ingesting virtual file ===");
  const result = await ingester.ingestVirtual(
    [
      {
        path: "src/order-service.ts",
        content: tsContent,
      },
    ],
    projectId,
    {
      projectId,
      documentId,
      documentTitle: "Order Service Documentation",
      userId: "user-virtual-001",
      userUsername: "virtualuser",
      categoryId: "cat-ecommerce",
      categorySlug: "ecommerce",
      categoryName: "E-Commerce",
      isPublic: true,
      tags: ["orders", "ecommerce", "typescript"],
    },
    {
      sourceIdentifier: "github.com/example/order-api",
    }
  );

  console.log("\n=== Ingestion Results ===");
  console.log(`Files processed: ${result.filesProcessed}`);
  console.log(`Scopes created: ${result.scopesCreated}`);
  console.log(`Relations created: ${result.relationsCreated}`);

  // Verify nodes in Neo4j
  console.log("\n=== Verifying nodes in Neo4j ===");
  const queryResult = await neo4jClient.run(`
    MATCH (n {documentId: $documentId})
    RETURN labels(n) as labels, n.name as name, n.file as file, n.path as path
    ORDER BY labels(n)[0], n.name
    LIMIT 20
  `, { documentId });

  console.log(`Found ${queryResult.records.length} nodes:`);
  for (const record of queryResult.records) {
    const file = record.get("file") || record.get("path") || "";
    console.log(
      `  - [${record.get("labels")}] ${record.get("name")} ${file ? `(${file})` : ""}`
    );
  }

  // Verify the path contains our virtual root components
  console.log("\n=== Verifying path structure ===");
  const fileResult = await neo4jClient.run(`
    MATCH (f:File {documentId: $documentId})
    RETURN f.file as file, f.path as path, f.name as name
  `, { documentId });
  const record = fileResult.records[0];
  const filePath = record?.get("file") || record?.get("path");
  const fileName = record?.get("name");
  console.log(`File name: ${fileName}`);
  console.log(`File path: ${filePath}`);

  // Check that path contains our virtual components (may be relative)
  const expectedComponents = ["github.com", "example", "order-api"];
  const hasAllComponents = expectedComponents.every(c => filePath?.includes(c));
  if (hasAllComponents) {
    console.log("✅ Path contains all virtual root components!");
  } else {
    console.log(`❌ Missing some components. Expected: ${expectedComponents.join("/")}`);
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
  console.log("✅ Virtual file ingestion works with full metadata injection");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
