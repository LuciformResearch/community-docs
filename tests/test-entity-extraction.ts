/**
 * Test Entity Extraction with GLiNER2
 *
 * Tests:
 * 1. Ingestion of domain-specific markdown files
 * 2. Entity extraction per domain (ecommerce, code, documentation, legal)
 * 3. Cross-file entity deduplication
 * 4. Search functionality for entities
 * 5. Neo4j verification queries
 *
 * Prerequisites:
 * - GLiNER service running on http://localhost:6971
 * - Community-docs API running on http://localhost:6970
 * - Neo4j running on bolt://localhost:7688
 *
 * Run with: npx tsx tests/test-entity-extraction.ts
 * Enable verbose: RAGFORGE_VERBOSE=true (when starting API)
 */

import * as fs from 'fs';
import * as path from 'path';

const API_URL = 'http://127.0.0.1:6970';
const GLINER_URL = 'http://127.0.0.1:6971';
const TEST_DIR = path.join(__dirname, 'fixtures/entity-extraction');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message: string, color?: keyof typeof colors) {
  if (color) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

function success(message: string) {
  log(`✅ ${message}`, 'green');
}

function error(message: string) {
  log(`❌ ${message}`, 'red');
}

function warn(message: string) {
  log(`⚠️  ${message}`, 'yellow');
}

function header(message: string) {
  console.log('\n' + '='.repeat(60));
  log(message, 'cyan');
  console.log('='.repeat(60) + '\n');
}

// Sleep utility
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Collect all markdown files from test directory
async function collectTestFiles(): Promise<string[]> {
  const files: string[] = [];

  const walkDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
        files.push(fullPath);
      }
    }
  };

  walkDir(TEST_DIR);
  return files;
}

// Check if GLiNER service is available
async function checkGlinerService(): Promise<boolean> {
  try {
    const response = await fetch(`${GLINER_URL}/health`);
    if (response.ok) {
      const health = await response.json();
      log(`GLiNER service: ${health.status} (model: ${health.model_name})`, 'dim');
      return health.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}

// Check available domains
async function listDomains(): Promise<Record<string, any>> {
  try {
    const response = await fetch(`${GLINER_URL}/domains`);
    if (response.ok) {
      return await response.json();
    }
    return {};
  } catch {
    return {};
  }
}

// Ingest all files together (realistic batch scenario)
async function ingestAllFiles(filePaths: string[]): Promise<any> {
  const files = filePaths.map(filePath => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    return {
      filePath: fileName,
      content: Buffer.from(content).toString('base64'),
    };
  });

  const documentId = `test-entity-${Date.now()}`;
  log(`Ingesting ${files.length} files with documentId: ${documentId}`, 'dim');

  const response = await fetch(`${API_URL}/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      metadata: {
        documentId,
        documentTitle: 'Entity Extraction Test Suite',
        authorId: 'test-user',
        categoryId: 'entity-extraction-test',
        categorySlug: 'entity-test',
      },
      generateEmbeddings: true,
      extractEntities: true,
    }),
  });

  return response.json();
}

// Search for GLiNER-extracted Entity nodes using the general search endpoint
// Note: /search uses SearchService which searches all node types including Entity
async function searchEntities(query: string): Promise<any[]> {
  const response = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      semantic: true,
      hybrid: true,
      embeddingType: 'all', // Search name, content, description embeddings
      limit: 30,
      minScore: 0.3,
    }),
  });

  if (response.ok) {
    const result = await response.json();
    // Filter for Entity nodes only
    // API returns nodeType (first label) instead of full labels array
    const allResults = result.results || [];
    return allResults.filter((r: any) => r.nodeType === 'Entity');
  }
  return [];
}

// Execute Cypher query
async function runCypher(query: string): Promise<any> {
  const response = await fetch(`${API_URL}/cypher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (response.ok) {
    return response.json();
  }
  throw new Error(`Cypher query failed: ${response.status}`);
}

// Get entity statistics
async function getEntityStats(): Promise<{
  totalEntities: number;
  byType: Record<string, number>;
  timCookCount: number;
  appleCount: number;
  mentionsCount: number;
  relationsCount: number;
}> {
  // Count entities by type
  const typeResult = await runCypher(`
    MATCH (e:Entity)
    RETURN e.entityType as type, count(e) as count
    ORDER BY count DESC
  `);

  const byType: Record<string, number> = {};
  let totalEntities = 0;
  for (const record of typeResult.records || []) {
    const count = typeof record.count === 'object' ? record.count.low : record.count;
    byType[record.type] = count;
    totalEntities += count;
  }

  // Count Tim Cook variants
  const timCookResult = await runCypher(`
    MATCH (e:Entity)
    WHERE e._name CONTAINS 'Tim' OR e._name CONTAINS 'Cook' OR e._name CONTAINS 'Timothy'
    RETURN count(e) as count
  `);
  const timCookCount = timCookResult.records?.[0]?.count?.low ?? timCookResult.records?.[0]?.count ?? 0;

  // Count Apple variants
  const appleResult = await runCypher(`
    MATCH (e:Entity)
    WHERE e._name CONTAINS 'Apple'
    RETURN count(e) as count
  `);
  const appleCount = appleResult.records?.[0]?.count?.low ?? appleResult.records?.[0]?.count ?? 0;

  // Count MENTIONS relationships
  const mentionsResult = await runCypher(`
    MATCH ()-[m:MENTIONS]->()
    RETURN count(m) as count
  `);
  const mentionsCount = mentionsResult.records?.[0]?.count?.low ?? mentionsResult.records?.[0]?.count ?? 0;

  // Count Entity-to-Entity relations
  const relationsResult = await runCypher(`
    MATCH (e1:Entity)-[r]->(e2:Entity)
    WHERE type(r) <> 'MENTIONS'
    RETURN count(r) as count
  `);
  const relationsCount = relationsResult.records?.[0]?.count?.low ?? relationsResult.records?.[0]?.count ?? 0;

  return { totalEntities, byType, timCookCount, appleCount, mentionsCount, relationsCount };
}

// Main test function
async function testEntityExtraction() {
  header('Entity Extraction Test Suite');

  // 1. Check prerequisites
  header('Phase 1: Prerequisites Check');

  const glinerOk = await checkGlinerService();
  if (!glinerOk) {
    error('GLiNER service not available at ' + GLINER_URL);
    error('Start with: cd ragforge/services/gliner-service && uvicorn gliner_service.main:app --port 6971');
    process.exit(1);
  }
  success('GLiNER service available');

  const domains = await listDomains();
  if (domains.domains) {
    log(`Available domains: ${Object.keys(domains.domains).join(', ')}`, 'dim');
  }

  // Check test files exist
  const testFiles = await collectTestFiles();
  if (testFiles.length === 0) {
    error('No test files found in ' + TEST_DIR);
    process.exit(1);
  }
  success(`Found ${testFiles.length} test files`);

  // 2. Ingest test files (batch mode for proper cross-file deduplication)
  header('Phase 2: File Ingestion (Batch)');

  log(`Ingesting ${testFiles.length} files in batch mode...`, 'dim');
  for (const file of testFiles) {
    log(`  - ${path.relative(TEST_DIR, file)}`, 'dim');
  }

  let ingestionResult: any;
  try {
    ingestionResult = await ingestAllFiles(testFiles);

    if (ingestionResult.success) {
      success(`Batch ingestion complete:`);
      log(`  Nodes created: ${ingestionResult.nodesCreated || 0}`, 'dim');
      log(`  Embeddings generated: ${ingestionResult.embeddingsGenerated || 0}`, 'dim');
      if (ingestionResult.entityStats) {
        log(`  Entities extracted: ${ingestionResult.entityStats.entitiesExtracted || 0}`, 'dim');
        log(`  Duplicates removed: ${ingestionResult.entityStats.duplicatesRemoved || 0}`, 'dim');
      }
    } else {
      error(`Batch ingestion failed: ${ingestionResult.error || 'Unknown error'}`);
    }
  } catch (err) {
    error(`Batch ingestion error: ${err}`);
    ingestionResult = { success: false, error: String(err) };
  }

  // 3. Wait for indexing
  header('Phase 3: Waiting for Indexing');
  log('Waiting 5 seconds for Neo4j indexing...', 'dim');
  await sleep(5000);
  success('Indexing wait complete');

  // 4. Verify entities in database
  header('Phase 4: Database Verification');

  try {
    const stats = await getEntityStats();

    console.log('\nEntity Statistics:');
    console.log(`  Total entities: ${stats.totalEntities}`);
    console.log(`  MENTIONS relations: ${stats.mentionsCount}`);
    console.log(`  Entity relations: ${stats.relationsCount}`);

    console.log('\nEntities by type:');
    for (const [type, count] of Object.entries(stats.byType)) {
      console.log(`  - ${type}: ${count}`);
    }

    console.log('\nDeduplication Check:');
    console.log(`  "Tim Cook" variants: ${stats.timCookCount}`);
    console.log(`  "Apple" variants: ${stats.appleCount}`);

    // Verify expectations
    if (stats.totalEntities >= 30) {
      success(`Entities created: ${stats.totalEntities} (expected: ≥30)`);
    } else {
      warn(`Entities created: ${stats.totalEntities} (expected: ≥30)`);
    }

    if (stats.mentionsCount >= 40) {
      success(`MENTIONS relations: ${stats.mentionsCount} (expected: ≥40)`);
    } else {
      warn(`MENTIONS relations: ${stats.mentionsCount} (expected: ≥40)`);
    }

    if (stats.timCookCount === 1) {
      success('"Tim Cook" properly deduplicated (1 entity)');
    } else if (stats.timCookCount <= 2) {
      warn(`"Tim Cook" partially deduplicated (${stats.timCookCount} entities)`);
    } else {
      error(`"Tim Cook" NOT deduplicated (${stats.timCookCount} entities)`);
    }

    if (stats.appleCount === 1) {
      success('"Apple" properly deduplicated (1 entity)');
    } else if (stats.appleCount <= 2) {
      warn(`"Apple" partially deduplicated (${stats.appleCount} entities)`);
    } else {
      error(`"Apple" NOT deduplicated (${stats.appleCount} entities)`);
    }

  } catch (err) {
    error(`Database verification failed: ${err}`);
  }

  // 5. Test search
  header('Phase 5: Search Tests');

  const searchTests = [
    { query: 'Tim Cook Apple CEO', expected: ['Tim Cook', 'Apple'] },
    { query: 'searchEntities function', expected: ['searchEntities'] },
    { query: 'Shampoo produit beauté', expected: ['Shampoo', 'L\'Oréal'] },
    { query: 'Contrat TechCorp', expected: ['TechCorp', 'Contrat'] },
  ];

  for (const test of searchTests) {
    log(`\nSearching: "${test.query}"`, 'dim');

    try {
      const results = await searchEntities(test.query);

      if (results.length === 0) {
        warn(`  No results found`);
      } else {
        log(`  Found ${results.length} Entity results:`, 'dim');
        for (const r of results.slice(0, 5)) {
          // API returns content (which is _name for Entity nodes)
          const name = r.content;
          const type = r.nodeType;
          console.log(`    - ${name} (${type})`);
        }

        const foundExpected = test.expected.filter(e =>
          results.some(r => {
            // API returns content field (which is _name/_content for Entity nodes)
            const content = (r.content || '').toLowerCase();
            return content.includes(e.toLowerCase());
          })
        );

        if (foundExpected.length === test.expected.length) {
          success(`  All expected entities found`);
        } else {
          warn(`  Found ${foundExpected.length}/${test.expected.length} expected entities`);
        }
      }
    } catch (err) {
      error(`  Search failed: ${err}`);
    }
  }

  // 6. Summary
  header('Test Summary');

  log(`Batch ingestion: ${ingestionResult?.success ? 'SUCCESS' : 'FAILED'}`);
  if (ingestionResult?.success) {
    log(`  Files processed: ${testFiles.length}`);
    log(`  Nodes created: ${ingestionResult.nodesCreated || 0}`);
  }

  console.log('\nNext steps:');
  console.log('1. Check API logs for [EntityExtraction] messages');
  console.log('2. Run Neo4j queries from README.md for detailed inspection');
  console.log('3. Adjust deduplication thresholds if needed');
  console.log('4. Test with brain_search MCP tool for semantic search\n');
}

// Run tests
testEntityExtraction().catch(err => {
  error(`Test suite failed: ${err}`);
  process.exit(1);
});
