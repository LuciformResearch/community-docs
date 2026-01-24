/**
 * Orchestrator Adapter for Community Docs
 *
 * Uses the EXACT same IngestionOrchestrator from @ragforge/core
 * with a transformGraph hook to inject community metadata.
 *
 * This ensures we get the FULL parsing pipeline:
 * - AST analysis, chunking, import resolution
 * - Metadata preservation (embeddings, UUIDs)
 * - Incremental ingestion
 *
 * @since 2025-01-04
 */

import {
  IngestionOrchestrator,
  IncrementalIngestionManager,
  UniversalSourceAdapter,
  Neo4jClient as CoreNeo4jClient,
  EmbeddingService,
  SearchService,
  // Vector index utility
  ensureVectorIndexes,
  // Post-processing functions
  applyKeywordBoost,
  exploreRelationships,
  summarizeSearchResults,
  rerankSearchResults,
  // Markdown formatter
  formatAsMarkdown,
  // Entity extraction (GLiNER)
  EntityExtractionClient,
  createEntityExtractionTransform,
  // NEW: Virtual file ingestion utilities
  UnifiedProcessor,
  downloadGitHubRepo,
  extractZipToVirtualFiles,
  createVirtualFileFromContent,
  type OrchestratorDependencies,
  type FileChange,
  type IngestionStats,
  type VirtualFile,
  type EmbeddingProviderConfig,
  type SearchFilter,
  type ServiceSearchResult,
  type ServiceSearchResultSet,
  type GrepOptions,
  type GrepResult,
  type GrepResultSet,
  // Post-processing types
  type ExplorationGraph,
  type SummaryResult,
  // Formatter types
  type BrainSearchOutput,
  type FormatOptions,
  // Parser options for Vision, etc.
  type ParserOptionsConfig,
  // Entity extraction types
  type EntityExtractionConfig,
  type ProcessingStats,
  type GitHubDownloadOptions,
  type ZipExtractOptions,
  // Path utilities
  getRelativePath,
  getShortDirContext,
} from "@luciformresearch/ragforge";
import type { Neo4jClient } from "./neo4j-client";
import neo4j from "neo4j-driver";
import type { CommunityNodeMetadata } from "./types";
import { getPipelineLogger } from "./logger";
import type { EntityEmbeddingService, EntitySearchResult } from "./entity-embedding-service";
import type { Entity, ExtractedTag } from "./entity-types";

const logger = getPipelineLogger();

/**
 * Graph type from orchestrator
 */
type ParsedGraph = {
  nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
  relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
  metadata: { filesProcessed: number; nodesGenerated: number };
};

/**
 * Options for the community orchestrator
 */
export interface CommunityOrchestratorOptions {
  /** Neo4j client (port 7688) */
  neo4j: Neo4jClient;
  /** Embedding provider config (uses ragforge core EmbeddingService) */
  embeddingConfig?: EmbeddingProviderConfig;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Entity extraction config (GLiNER service) */
  entityExtraction?: Partial<EntityExtractionConfig> & {
    /** Enable entity extraction (default: false) */
    enabled?: boolean;
  };
}

/**
 * Ingestion options with community metadata (disk files)
 */
export interface CommunityIngestionOptions {
  /** Files to ingest (as FileChange array) */
  files: Array<{
    path: string;
    changeType?: "created" | "updated" | "deleted";
  }>;
  /** Community metadata to inject on all nodes */
  metadata: CommunityNodeMetadata;
  /** Project ID (derived from documentId) */
  projectId?: string;
  /** Generate embeddings after ingestion */
  generateEmbeddings?: boolean;
}

/**
 * Search options for community-docs
 */
export interface CommunitySearchOptions {
  /** Search query */
  query: string;
  /** Filter by project ID (Prisma Project.id) */
  projectId?: string;
  /** Filter by category slug */
  categorySlug?: string;
  /** Filter by user ID */
  userId?: string;
  /** Filter by document ID (source within project) */
  documentId?: string;
  /** Filter by public status */
  isPublic?: boolean;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Use semantic search (default: true) */
  semantic?: boolean;
  /** Use hybrid search (default: true when semantic is true) */
  hybrid?: boolean;
  /** Embedding type to use */
  embeddingType?: "name" | "content" | "description" | "all";
  /** Maximum results */
  limit?: number;
  /** Minimum score threshold */
  minScore?: number;

  // === File path filtering ===

  /** Glob pattern to filter results by file path (e.g. match .ts files) */
  glob?: string;

  // === Node type filtering ===

  /** Neo4j labels to filter (e.g., ['Scope'] for code only, ['MarkdownSection'] for docs) */
  labels?: string[];

  // === Post-processing options (from @ragforge/core) ===

  /** Keywords to boost results for (fuzzy Levenshtein matching) */
  boostKeywords?: string[];
  /** Boost weight per keyword match (default: 0.15) */
  boostWeight?: number;

  /** Explore relationships depth (1-3, 0 = disabled) */
  exploreDepth?: number;

  /** Max number of relevant dependencies to keep after semantic filtering (default: 20) */
  exploreTopK?: number;

  /** Summarize results with LLM */
  summarize?: boolean;
  /** Additional context for summarization */
  summarizeContext?: string;

  /** Rerank results with LLM */
  rerank?: boolean;

  // === Entity/Tag boost (enabled by default) ===

  /** Boost results that have matching entities/tags (default: true) */
  entityBoost?: boolean;
  /** Minimum entity/tag match score to apply boost (default: 0.7) */
  entityMatchThreshold?: number;
  /** Boost weight for entity/tag matches (default: 0.05) */
  entityBoostWeight?: number;
  /** Include matched entities/tags in results (default: false) */
  includeMatchedEntities?: boolean;

  // === Output formatting ===

  /** Output format: "json" (default), "markdown" (human-readable), "compact" */
  format?: "json" | "markdown" | "compact";
  /** Include source code in markdown output (default: true for first 5 results) */
  includeSource?: boolean;
  /** Maximum results to include source for (default: 5) */
  maxSourceResults?: number;
}

/**
 * Community search result
 */
export interface CommunitySearchResult {
  /** Node properties */
  node: Record<string, any>;
  /** Similarity score */
  score: number;
  /** File path (if available) */
  filePath?: string;
  /** Matched range info (when a chunk matched instead of the full node) */
  matchedRange?: {
    startLine: number;
    endLine: number;
    startChar: number;
    endChar: number;
    chunkIndex: number;
    chunkScore: number;
    /** Page number from parent document (for PDFs/Word docs) */
    pageNum?: number | null;
  };
  /** Snippet of the matched content (chunk text or truncated content) */
  snippet?: string;
  /** Keyword boost info (if boost_keywords was used) */
  keywordBoost?: {
    keyword: string;
    similarity: number;
    boost: number;
  };
  /** Entity/tag boost applied (if entityBoost was used) */
  entityBoostApplied?: number;
  /** Matched entities/tags (if includeMatchedEntities: true) */
  matchedEntities?: Array<{
    uuid: string;
    name: string;
    type: 'Tag' | 'CanonicalEntity';
    matchScore: number;
  }>;
}

/**
 * Extended search result with post-processing data
 */
export interface CommunitySearchResultSet {
  results: CommunitySearchResult[];
  totalCount: number;
  /** Whether reranking was applied */
  reranked?: boolean;
  /** Whether keyword boosting was applied */
  keywordBoosted?: boolean;
  /** Whether entity/tag boosting was applied */
  entityBoosted?: boolean;
  /** Matching entities/tags found (if entityBoost was used) */
  matchingEntities?: Array<{
    uuid: string;
    name: string;
    type: 'Tag' | 'CanonicalEntity';
    score: number;
  }>;
  /** Whether relationships were explored */
  relationshipsExplored?: boolean;
  /** Whether results were summarized */
  summarized?: boolean;
  /** Relationship graph (if exploreDepth > 0) */
  graph?: ExplorationGraph;
  /** LLM summary (if summarize: true) */
  summary?: SummaryResult;
  /** Formatted output (if format is "markdown" or "compact") */
  formattedOutput?: string;
}

/**
 * Virtual file ingestion options (in-memory, no disk I/O)
 * Use this for scalable deployments where files come from databases/S3
 */
/**
 * Progress callback for long-running operations
 * @param phase - Current phase (parsing, nodes, relationships, etc.)
 * @param current - Current progress count
 * @param total - Total expected count
 * @param message - Optional human-readable message
 */
export type ProgressCallback = (phase: string, current: number, total: number, message?: string) => void;

export interface CommunityVirtualIngestionOptions {
  /** Virtual files with content in memory */
  virtualFiles: Array<{
    /** Virtual path (e.g., "src/api.ts") - will be prefixed automatically */
    path: string;
    /** File content as string or Buffer */
    content: string | Buffer;
  }>;
  /** Community metadata to inject on all nodes */
  metadata: CommunityNodeMetadata;
  /**
   * Source identifier for path prefixing.
   * Examples:
   * - GitHub: "github.com/owner/repo"
   * - Gist: "gist/abc123"
   * - Upload: "upload"
   *
   * Final path format: /virtual/{documentId}/{sourceIdentifier}/{filePath}
   */
  sourceIdentifier?: string;
  /** Project ID (derived from documentId) */
  projectId?: string;
  /** Generate embeddings after ingestion */
  generateEmbeddings?: boolean;
  /** Progress callback for SSE/real-time updates */
  onProgress?: ProgressCallback;
}

/**
 * Unified file ingestion options (handles all file types: text, binary docs, media)
 */
export interface UnifiedIngestionOptions {
  /** Files to ingest (buffer-based, no disk I/O) */
  files: Array<{
    /** File name (e.g., "paper.pdf", "image.png", "code.ts") */
    fileName: string;
    /** File content as Buffer */
    buffer: Buffer;
  }>;
  /** Community metadata to inject on all nodes */
  metadata: CommunityNodeMetadata;
  /** Project ID (Prisma Project.id) - required for scoping nodes */
  projectId: string;
  /** Document ID (Prisma Document.id) - for source tracking within project */
  documentId?: string;
  /** Enable Vision-based parsing for PDFs and image analysis (default: false) */
  enableVision?: boolean;
  /** Vision analyzer function for image descriptions (required if enableVision is true for images) */
  visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
  /** 3D render function for model rendering (required if enableVision is true for 3D files) */
  render3D?: (modelPath: string) => Promise<Array<{ view: string; buffer: Buffer }>>;
  /** Section title detection mode for documents (default: 'detect') */
  sectionTitles?: 'none' | 'detect' | 'llm';
  /** Generate titles for sections without one using LLM (default: true) */
  generateTitles?: boolean;
  /** Generate embeddings after ingestion (default: true) */
  generateEmbeddings?: boolean;
  /** Extract entities using GLiNER (default: false) */
  extractEntities?: boolean;
}

/**
 * Unified ingestion result
 */
export interface UnifiedIngestionResult {
  /** Total nodes created */
  nodesCreated: number;
  /** Total relationships created */
  relationshipsCreated: number;
  /** Number of embeddings generated */
  embeddingsGenerated: number;
  /** Stats by file type */
  stats: {
    textFiles: number;
    binaryDocs: number;
    mediaFiles: number;
    skipped: number;
    textNodes: number;
    binaryNodes: number;
    mediaNodes: number;
  };
  /** Entity extraction stats (GLiNER) */
  entityStats?: {
    entitiesExtracted: number;
    filesProcessed: number;
  };
  /** Warnings from parsing */
  warnings?: string[];
}

/**
 * Community Orchestrator Adapter
 *
 * Wraps IngestionOrchestrator with community-specific transformGraph hook
 */
export class CommunityOrchestratorAdapter {
  private orchestrator: IngestionOrchestrator | null = null;
  private sourceAdapter: UniversalSourceAdapter;
  private ingestionManager: IncrementalIngestionManager | null = null;
  private neo4j: Neo4jClient;
  private embeddingConfig: EmbeddingProviderConfig | null;
  private embeddingService: EmbeddingService | null = null;
  private searchService: SearchService | null = null;
  private coreClient: CoreNeo4jClient | null = null;
  private verbose: boolean;

  // Entity/Tag embedding service (for entity boost in search)
  private entityEmbeddingService: EntityEmbeddingService | null = null;

  // Entity extraction client (GLiNER)
  private entityExtractionClient: EntityExtractionClient | null = null;
  private entityExtractionEnabled: boolean;

  // Current metadata for transformGraph hook
  private currentMetadata: CommunityNodeMetadata | null = null;

  constructor(options: CommunityOrchestratorOptions) {
    this.neo4j = options.neo4j;
    this.embeddingConfig = options.embeddingConfig ?? null;
    this.verbose = options.verbose ?? false;
    this.sourceAdapter = new UniversalSourceAdapter();

    // Entity extraction config
    this.entityExtractionEnabled = options.entityExtraction?.enabled ?? false;
    if (this.entityExtractionEnabled) {
      this.entityExtractionClient = new EntityExtractionClient(options.entityExtraction);
      logger.info(`[CommunityOrchestrator] Entity extraction enabled: ${options.entityExtraction?.serviceUrl ?? 'http://localhost:6971'}`);
    }
  }

  /**
   * Initialize the orchestrator
   */
  async initialize(): Promise<void> {
    if (this.orchestrator) return;

    // Create a CoreNeo4jClient for IncrementalIngestionManager and EmbeddingService
    // Uses same env vars as community-docs Neo4jClient
    this.coreClient = new CoreNeo4jClient({
      uri: process.env.NEO4J_URI || "bolt://localhost:7688",
      username: process.env.NEO4J_USER || "neo4j",
      password: process.env.NEO4J_PASSWORD || "communitydocs",
    });

    // Get driver from coreClient to avoid type conflicts between neo4j-driver versions
    const driver = this.coreClient.getDriver();

    // Create EmbeddingService from ragforge core (with batching, multi-embedding support)
    if (this.embeddingConfig) {
      this.embeddingService = new EmbeddingService(this.coreClient, this.embeddingConfig);
      const providerType = "type" in this.embeddingConfig ? this.embeddingConfig.type : "unknown";
      logger.info(`[CommunityOrchestrator] EmbeddingService initialized (${providerType})`);
    }

    // Create SearchService from ragforge core (for semantic/hybrid search)
    this.searchService = new SearchService({
      neo4jClient: this.coreClient,
      embeddingService: this.embeddingService ?? undefined,
      verbose: this.verbose,
    });
    logger.info("[CommunityOrchestrator] SearchService initialized");

    // Ensure vector indexes exist (1024 dimensions for Ollama mxbai-embed-large)
    const indexResult = await ensureVectorIndexes(this.coreClient, {
      dimension: 1024,
      verbose: this.verbose,
    });
    logger.info(
      `[CommunityOrchestrator] Vector indexes: ${indexResult.created} created, ${indexResult.skipped} existed`
    );

    // Create IncrementalIngestionManager with CoreNeo4jClient
    this.ingestionManager = new IncrementalIngestionManager(this.coreClient);

    // Create orchestrator dependencies with transformGraph hook
    const deps: OrchestratorDependencies = {
      driver,

      // Parse files using UniversalSourceAdapter
      parseFiles: async (options) => {
        const result = await this.sourceAdapter.parse({
          source: {
            type: "files",
            root: options.root,
            include: options.include,
          },
          projectId: options.projectId,
          existingUUIDMapping: options.existingUUIDMapping,
        });

        return {
          nodes: result.graph.nodes,
          relationships: result.graph.relationships,
          metadata: {
            filesProcessed: result.graph.metadata.filesProcessed,
            nodesGenerated: result.graph.metadata.nodesGenerated,
          },
        };
      },

      // Ingest graph using IncrementalIngestionManager
      ingestGraph: async (graph, options) => {
        await this.ingestionManager!.ingestGraph(
          { nodes: graph.nodes, relationships: graph.relationships },
          { projectId: options.projectId, markDirty: true }
        );
      },

      // Delete nodes for files
      deleteNodesForFiles: async (files, _projectId) => {
        return this.ingestionManager!.deleteNodesForFiles(files);
      },

      // Generate embeddings (optional)
      // Note: We handle embeddings separately via generateEmbeddingsForDocument()
      // which uses ragforge core's EmbeddingService with batching
      generateEmbeddings: this.embeddingService
        ? async (_projectId) => {
            // Return 0 here, embeddings are handled separately after ingestion
            return 0;
          }
        : undefined,

      // Transform graph to inject community metadata + entity extraction
      transformGraph: async (graph) => {
        if (!this.currentMetadata) {
          return graph;
        }

        const metadata = this.currentMetadata;
        logger.info(`Injecting community metadata on ${graph.nodes.length} nodes (projectId: ${metadata.projectId})`);

        // Inject metadata on all nodes
        for (const node of graph.nodes) {
          // IMPORTANT: projectId is required for EmbeddingService to find nodes
          node.properties.projectId = metadata.projectId;
          // Document/Source identity (optional, for tracking which source within project)
          if (metadata.documentId) {
            node.properties.documentId = metadata.documentId;
          }
          node.properties.documentTitle = metadata.documentTitle;

          // User info
          node.properties.userId = metadata.userId;
          if (metadata.userUsername) {
            node.properties.userUsername = metadata.userUsername;
          }

          // Category info
          node.properties.categoryId = metadata.categoryId;
          node.properties.categorySlug = metadata.categorySlug;
          if (metadata.categoryName) {
            node.properties.categoryName = metadata.categoryName;
          }

          // Permissions
          if (metadata.isPublic !== undefined) {
            node.properties.isPublic = metadata.isPublic;
          }

          // Tags
          if (metadata.tags && metadata.tags.length > 0) {
            node.properties.tags = metadata.tags;
          }

          // Mark as community content
          node.properties.sourceType = "community-upload";

          // Extract sourceFormat from frontMatter if present (for PDF/DOCX parsed via vision)
          const frontMatter = node.properties.frontMatter as string | undefined;
          if (frontMatter && typeof frontMatter === 'string') {
            // Parse YAML frontmatter to extract sourceFormat
            const sourceFormatMatch = frontMatter.match(/sourceFormat:\s*["']?(\w+)["']?/);
            if (sourceFormatMatch) {
              node.properties.sourceFormat = sourceFormatMatch[1];
            }
            const parsedFromMatch = frontMatter.match(/parsedFrom:\s*["']?([\w-]+)["']?/);
            if (parsedFromMatch) {
              node.properties.parsedFrom = parsedFromMatch[1];
            }
          }
        }

        // Entity extraction (if enabled)
        if (this.entityExtractionEnabled && this.entityExtractionClient) {
          try {
            const isAvailable = await this.entityExtractionClient.isAvailable();
            if (isAvailable) {
              const nodesBefore = graph.nodes.length;

              // Debug: check node types and content
              const nodeTypes = graph.nodes.reduce((acc, n) => {
                const label = n.labels[0] || 'unknown';
                acc[label] = (acc[label] || 0) + 1;
                return acc;
              }, {} as Record<string, number>);

              const nodesWithContent = graph.nodes.filter(n => n.properties._content).length;

              logger.info(
                `[CommunityOrchestrator] Starting entity extraction: ${nodesBefore} nodes, ` +
                `${nodesWithContent} with extractable content, types: ${JSON.stringify(nodeTypes)}`
              );

              // Create embedding function for hybrid deduplication
              const embedFunction = this.embeddingService
                ? async (texts: string[]) => {
                    return await this.embeddingService!.embedBatch(texts);
                  }
                : undefined;

              const entityTransform = createEntityExtractionTransform({
                ...this.entityExtractionClient.getConfig(),
                projectId: metadata.projectId, // Pass projectId so Entity nodes get correct project assignment
                verbose: this.verbose,
                deduplication: {
                  strategy: 'hybrid',
                  fuzzyThreshold: 0.85,
                  embeddingThreshold: 0.9,
                },
                embedFunction,
              });
              graph = await entityTransform(graph as any) as typeof graph;

              // Count entity nodes and MENTIONS relationships
              const entityNodes = graph.nodes.filter(n => n.labels.includes('Entity'));
              const mentionsRels = graph.relationships.filter(r => r.type === 'MENTIONS');

              logger.info(
                `[CommunityOrchestrator] Entity extraction completed: ` +
                `${entityNodes.length} Entity nodes, ${mentionsRels.length} MENTIONS relations, ` +
                `total nodes: ${nodesBefore} → ${graph.nodes.length}`
              );

              if (entityNodes.length > 0) {
                const entityTypes = entityNodes.reduce((acc, node) => {
                  const type = node.properties.entityType || 'unknown';
                  acc[type] = (acc[type] || 0) + 1;
                  return acc;
                }, {} as Record<string, number>);
                logger.info(`[CommunityOrchestrator] Entity types: ${JSON.stringify(entityTypes)}`);
              }
            } else {
              logger.warn("[CommunityOrchestrator] GLiNER service not available, skipping entity extraction");
            }
          } catch (error) {
            logger.error("[CommunityOrchestrator] Entity extraction failed:", error);
            // Continue without entity extraction
          }
        }

        return graph;
      },
    };

    // Create orchestrator
    this.orchestrator = new IngestionOrchestrator(deps, {
      verbose: this.verbose,
      batchIntervalMs: 500,
      maxBatchSize: 50,
    });

    await this.orchestrator.initialize();
    logger.info("[CommunityOrchestrator] Initialized with transformGraph hook");
  }

  /**
   * Set the EntityEmbeddingService for entity/tag boost in search
   * This is initialized separately in server.ts
   */
  setEntityEmbeddingService(service: EntityEmbeddingService): void {
    this.entityEmbeddingService = service;
    logger.info("[CommunityOrchestrator] EntityEmbeddingService set for entity boost");
  }

  // ==========================================================================
  // NEW: Simplified Ingestion Methods using RagForge Core UnifiedProcessor
  // ==========================================================================

  /**
   * Create the :Project node in Neo4j for a Prisma project.
   * Call this after creating the project in Prisma.
   *
   * @param projectId - Prisma Project.id (will be used as projectId in Neo4j)
   */
  async createProjectInNeo4j(projectId: string): Promise<void> {
    await this.neo4j.run(`
      MERGE (p:Project {projectId: $projectId})
      SET p.rootPath = '/virtual/' + $projectId,
          p.type = 'external',
          p.contentSourceType = 'virtual',
          p.createdAt = datetime()
    `, { projectId });
    logger.info(`[CommunityOrchestrator] Created :Project node in Neo4j: ${projectId}`);
  }

  /**
   * Create a UnifiedProcessor for a project (virtual mode).
   * Uses the existing coreClient from initialize().
   */
  private async getUnifiedProcessor(projectId: string): Promise<UnifiedProcessor> {
    await this.initialize();

    if (!this.coreClient) {
      throw new Error("Core client not initialized");
    }

    return new UnifiedProcessor({
      driver: this.coreClient.getDriver(),
      neo4jClient: this.coreClient,
      projectId,
      contentSourceType: "virtual",
      verbose: this.verbose,
      embeddingService: this.embeddingService ?? undefined,
      glinerServiceUrl: this.entityExtractionEnabled ? "http://localhost:6971" : undefined,
    });
  }

  /**
   * Ingest a GitHub repository using Core utilities.
   *
   * This is the NEW simplified method that:
   * 1. Downloads repo with downloadGitHubRepo()
   * 2. Ingests with UnifiedProcessor.ingestVirtualFiles()
   * 3. Propagates community metadata to all nodes
   *
   * @param url - GitHub repository URL
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - GitHub download options
   */
  async ingestGitHubSimplified(
    url: string,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: GitHubDownloadOptions
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting GitHub repo: ${url} into project: ${projectId}`);

    // 1. Download repository
    const { files, metadata: repoMetadata, warnings } = await downloadGitHubRepo(url, {
      method: options?.method ?? "git",
      includeSubmodules: options?.includeSubmodules ?? true,
      token: options?.token,
      exclude: options?.exclude,
      include: options?.include,
      maxFileSize: options?.maxFileSize,
    });

    logger.info(`[CommunityOrchestrator] Downloaded ${files.length} files from ${repoMetadata.owner}/${repoMetadata.repo}`);
    if (warnings.length > 0) {
      logger.warn(`[CommunityOrchestrator] Warnings: ${warnings.join(", ")}`);
    }

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Ingest with metadata
    const stats = await processor.ingestVirtualFiles(files, {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle ?? `${repoMetadata.owner}/${repoMetadata.repo}`,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: "github",
        sourceUrl: url,
      },
    });

    logger.info(`[CommunityOrchestrator] GitHub ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest a ZIP archive using Core utilities.
   *
   * @param zipBuffer - ZIP file content as Buffer
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - ZIP extraction options
   */
  async ingestZipSimplified(
    zipBuffer: Buffer,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: ZipExtractOptions
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting ZIP into project: ${projectId}`);

    // 1. Extract ZIP
    const { files, metadata: zipMetadata, warnings } = await extractZipToVirtualFiles(zipBuffer, options);

    logger.info(`[CommunityOrchestrator] Extracted ${files.length} files from ZIP`);
    if (warnings.length > 0) {
      logger.warn(`[CommunityOrchestrator] Warnings: ${warnings.join(", ")}`);
    }

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Ingest with metadata
    const stats = await processor.ingestVirtualFiles(files, {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle ?? "ZIP Upload",
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: "zip",
      },
    });

    logger.info(`[CommunityOrchestrator] ZIP ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest a single document/file using Core utilities.
   *
   * Note: For binary documents (PDF, DOCX) and media files (images, 3D),
   * use the existing ingestBinaryDocument() and ingestMedia() methods
   * which have specialized parsing logic.
   *
   * This method is for text files (code, markdown, etc.).
   *
   * @param content - File content as Buffer or string
   * @param fileName - File name with extension
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   */
  async ingestDocumentSimplified(
    content: Buffer | string,
    fileName: string,
    projectId: string,
    metadata: CommunityNodeMetadata
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting document: ${fileName} into project: ${projectId}`);

    // 1. Create virtual file
    const file = createVirtualFileFromContent(content, fileName);

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Ingest with metadata
    const stats = await processor.ingestVirtualFiles([file], {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle ?? fileName,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: "upload",
      },
    });

    logger.info(`[CommunityOrchestrator] Document ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest a binary document (PDF, DOCX, etc.) using Core UnifiedProcessor with parserOptions.
   *
   * This is the NEW simplified method that:
   * 1. Creates a VirtualFile from the buffer
   * 2. Uses UnifiedProcessor.ingestVirtualFiles() with parserOptions for Vision, etc.
   * 3. Propagates community metadata via additionalProperties
   *
   * Use this for Vision-enabled parsing of PDFs and documents.
   *
   * @param buffer - Binary content of the file
   * @param fileName - File name with extension (e.g., "paper.pdf")
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - Parser options (enableVision, visionAnalyzer, etc.)
   */
  async ingestBinaryDocumentSimplified(
    buffer: Buffer,
    fileName: string,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      sectionTitles?: 'none' | 'detect' | 'llm';
      maxPages?: number;
      generateTitles?: boolean;
      titleGenerator?: (sections: Array<{ index: number; content: string }>) => Promise<Array<{ index: number; title: string }>>;
    }
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting binary document (simplified): ${fileName} into project: ${projectId}`);

    // 1. Create virtual file
    const file = createVirtualFileFromContent(buffer, fileName);

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Build parserOptions
    const parserOptions: ParserOptionsConfig = {
      enableVision: options?.enableVision,
      visionAnalyzer: options?.visionAnalyzer,
      sectionTitles: options?.sectionTitles ?? 'detect',
      maxPages: options?.maxPages,
      generateTitles: options?.generateTitles ?? true,
      titleGenerator: options?.titleGenerator ?? this.createDefaultTitleGenerator(),
    };

    // 4. Ingest with metadata and parserOptions
    const stats = await processor.ingestVirtualFiles([file], {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle ?? fileName,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: "upload",
        sourceFormat: fileName.split('.').pop()?.toLowerCase(),
      },
      parserOptions,
    });

    logger.info(`[CommunityOrchestrator] Binary document ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest a media file (image, 3D model) using Core UnifiedProcessor with parserOptions.
   *
   * This is the NEW simplified method that:
   * 1. Creates a VirtualFile from the buffer
   * 2. Uses UnifiedProcessor.ingestVirtualFiles() with parserOptions for Vision analysis
   * 3. Propagates community metadata via additionalProperties
   *
   * Use this for Vision-enabled analysis of images and 3D models.
   *
   * @param buffer - Binary content of the file
   * @param fileName - File name with extension (e.g., "image.png", "model.glb")
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - Parser options (enableVision, visionAnalyzer, render3D)
   */
  async ingestMediaSimplified(
    buffer: Buffer,
    fileName: string,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      render3D?: (modelPath: string) => Promise<Array<{ view: string; buffer: Buffer }>>;
    }
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting media file (simplified): ${fileName} into project: ${projectId}`);

    // 1. Create virtual file
    const file = createVirtualFileFromContent(buffer, fileName);

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Build parserOptions
    const parserOptions: ParserOptionsConfig = {
      enableVision: options?.enableVision,
      visionAnalyzer: options?.visionAnalyzer,
      render3D: options?.render3D,
    };

    // 4. Ingest with metadata and parserOptions
    const stats = await processor.ingestVirtualFiles([file], {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle ?? fileName,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: "upload",
        mediaType: this.is3DModel('.' + (fileName.split('.').pop()?.toLowerCase() || '')) ? '3d-model' : 'image',
      },
      parserOptions,
    });

    logger.info(`[CommunityOrchestrator] Media file ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest virtual files using Core UnifiedProcessor.
   *
   * This is the NEW simplified method that:
   * 1. Uses UnifiedProcessor.ingestVirtualFiles() directly
   * 2. Propagates community metadata via additionalProperties
   *
   * Replaces the old ingestVirtual() method which used IncrementalIngestionManager.ingestGraph().
   *
   * @param virtualFiles - Array of virtual files with path and content
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - Additional options (sourceIdentifier, generateEmbeddings, parserOptions)
   */
  async ingestVirtualSimplified(
    virtualFiles: Array<{ path: string; content: string | Buffer }>,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: {
      sourceIdentifier?: string;
      generateEmbeddings?: boolean;
      parserOptions?: ParserOptionsConfig;
    }
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting ${virtualFiles.length} virtual files (simplified) into project: ${projectId}`);

    // 1. Convert to VirtualFile format expected by UnifiedProcessor
    const sourceIdentifier = options?.sourceIdentifier ?? 'upload';
    const files: VirtualFile[] = virtualFiles.map((f) => {
      // Normalize path: remove leading slash if present
      const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
      return {
        path: `${sourceIdentifier}/${normalizedPath}`,
        content: f.content,
      };
    });

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Ingest with metadata
    const stats = await processor.ingestVirtualFiles(files, {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: 'community-upload',
      },
      parserOptions: options?.parserOptions,
    });

    logger.info(`[CommunityOrchestrator] Virtual files ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  /**
   * Ingest multiple files (mixed types) using Core UnifiedProcessor.
   *
   * This is the NEW simplified method that:
   * 1. Converts all files to VirtualFile format
   * 2. Uses UnifiedProcessor.ingestVirtualFiles() with appropriate parserOptions
   * 3. Propagates community metadata via additionalProperties
   *
   * Handles text files, binary documents (PDF, DOCX), and media files (images, 3D).
   * Replaces the old ingestFiles() method which used IncrementalIngestionManager.ingestGraph().
   *
   * @param files - Array of files with fileName and buffer
   * @param projectId - Prisma Project.id
   * @param metadata - Community metadata to inject on all nodes
   * @param options - Parser options and flags
   */
  async ingestFilesSimplified(
    files: Array<{ fileName: string; buffer: Buffer }>,
    projectId: string,
    metadata: CommunityNodeMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      render3D?: (modelPath: string) => Promise<Array<{ view: string; buffer: Buffer }>>;
      sectionTitles?: 'none' | 'detect' | 'llm';
      generateTitles?: boolean;
      generateEmbeddings?: boolean;
      extractEntities?: boolean;
    }
  ): Promise<ProcessingStats> {
    logger.info(`[CommunityOrchestrator] Ingesting ${files.length} files (simplified) into project: ${projectId}`);

    // 1. Convert all files to VirtualFile format
    const virtualFiles: VirtualFile[] = files.map(({ fileName, buffer }) => ({
      path: `upload/${fileName}`,
      content: buffer,
    }));

    // 2. Get processor
    const processor = await this.getUnifiedProcessor(projectId);

    // 3. Build parserOptions
    const parserOptions: ParserOptionsConfig = {
      enableVision: options?.enableVision,
      visionAnalyzer: options?.visionAnalyzer,
      render3D: options?.render3D,
      sectionTitles: options?.sectionTitles ?? 'detect',
      generateTitles: options?.generateTitles ?? true,
      titleGenerator: (options?.generateTitles ?? true) ? this.createDefaultTitleGenerator() : undefined,
    };

    // 4. Ingest with metadata and parserOptions
    const stats = await processor.ingestVirtualFiles(virtualFiles, {
      additionalProperties: {
        projectId,
        documentId: metadata.documentId,
        documentTitle: metadata.documentTitle,
        userId: metadata.userId,
        userUsername: metadata.userUsername,
        categoryId: metadata.categoryId,
        categorySlug: metadata.categorySlug,
        categoryName: metadata.categoryName,
        isPublic: metadata.isPublic,
        tags: metadata.tags,
        sourceType: 'upload',
      },
      parserOptions,
    });

    logger.info(`[CommunityOrchestrator] Files ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
    return stats;
  }

  // ==========================================================================
  // File Type Detection Helpers
  // ==========================================================================

  private static readonly BINARY_DOC_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.rtf']);
  private static readonly IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
  private static readonly THREED_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.3ds']);
  private static readonly TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyi',
    '.md', '.mdx', '.markdown',
    '.json', '.yaml', '.yml', '.toml',
    '.html', '.htm', '.css', '.scss', '.less',
    '.vue', '.svelte',
    '.java', '.kt', '.scala',
    '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
    '.rb', '.php', '.swift', '.m',
    '.sql', '.graphql', '.prisma',
    '.sh', '.bash', '.zsh', '.fish',
    '.xml', '.csv', '.txt', '.env', '.gitignore',
  ]);

  private isBinaryDocument(ext: string): boolean {
    return CommunityOrchestratorAdapter.BINARY_DOC_EXTENSIONS.has(ext.toLowerCase());
  }

  private isMediaFile(ext: string): boolean {
    const extLower = ext.toLowerCase();
    return CommunityOrchestratorAdapter.IMAGE_EXTENSIONS.has(extLower) ||
           CommunityOrchestratorAdapter.THREED_EXTENSIONS.has(extLower);
  }

  private is3DModel(ext: string): boolean {
    return CommunityOrchestratorAdapter.THREED_EXTENSIONS.has(ext.toLowerCase());
  }

  private isTextFile(ext: string): boolean {
    return CommunityOrchestratorAdapter.TEXT_EXTENSIONS.has(ext.toLowerCase());
  }

  /**
   * Create a default title generator (disabled - no LLM enrichment).
   * Title generation is now disabled as EnrichmentService was removed.
   */
  private createDefaultTitleGenerator(): (sections: Array<{ index: number; content: string }>) => Promise<Array<{ index: number; title: string }>> {
    return async (sections) => {
      // Title generation disabled - EnrichmentService removed
      return [];
    };
  }

  // ==========================================================================
  // Embedding Generation
  // ==========================================================================

  /**
   * Generate embeddings for all nodes of a project
   * Uses ragforge core EmbeddingService with batching and multi-embedding support
   *
   * @param projectId - The project ID to generate embeddings for
   * @param onProgress - Optional callback for progress updates (current, total)
   * @returns Number of embeddings generated
   */
  async generateEmbeddingsForProject(
    projectId: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<number> {
    if (!this.embeddingService) {
      logger.warn("No embedding service configured, skipping embeddings");
      return 0;
    }

    logger.info(`Generating embeddings for project: ${projectId}`);

    try {
      // Count nodes that need embeddings (for progress reporting)
      // Note: This is an estimate - actual count may differ due to incremental processing
      if (onProgress) {
        const countResult = await this.neo4j.run(
          `MATCH (n {projectId: $projectId})
           WHERE n.embeddingsDirty = true OR n.nameEmbedding IS NULL
           RETURN count(n) as total`,
          { projectId }
        );
        const estimatedTotal = countResult.records[0]?.get("total")?.toNumber() ?? 0;
        onProgress(0, estimatedTotal);
      }

      // Use ragforge core's multi-embedding generation with batching
      const result = await this.embeddingService.generateMultiEmbeddings({
        projectId,
        incrementalOnly: true,
        verbose: this.verbose,
        batchSize: 50,
      });

      // Report completion
      if (onProgress) {
        onProgress(result.totalEmbedded, result.totalEmbedded);
      }

      logger.info(
        `Generated embeddings for project ${projectId}: ` +
          `${result.totalEmbedded} total (name: ${result.embeddedByType.name}, ` +
          `content: ${result.embeddedByType.content}, description: ${result.embeddedByType.description}), ` +
          `${result.skippedCount} cached, ${result.durationMs}ms`
      );

      return result.totalEmbedded;
    } catch (err) {
      logger.error(`Failed to generate embeddings for project ${projectId}: ${err}`);
      return 0;
    }
  }

  /**
   * Check if embedding service is available
   */
  hasEmbeddingService(): boolean {
    return this.embeddingService !== null && this.embeddingService.canGenerateEmbeddings();
  }

  /**
   * Check if search service can do semantic search
   */
  canDoSemanticSearch(): boolean {
    return this.searchService?.canDoSemanticSearch() ?? false;
  }

  /**
   * Search across community documents
   *
   * Uses SearchService from ragforge core with community-specific filters.
   * Supports post-processing: reranking, keyword boosting, relationship exploration, summarization.
   *
   * @example
   * const results = await adapter.search({
   *   query: "authentication",
   *   categorySlug: "tutorials",
   *   semantic: true,
   *   limit: 20,
   *   boostKeywords: ["login", "auth"],
   *   exploreDepth: 1,
   * });
   */
  async search(options: CommunitySearchOptions): Promise<CommunitySearchResultSet> {
    await this.initialize();

    if (!this.searchService) {
      throw new Error("SearchService not initialized");
    }

    // Build community-specific filters
    const filters: SearchFilter[] = [];

    if (options.projectId) {
      filters.push({ property: "projectId", operator: "eq", value: options.projectId });
    }
    if (options.categorySlug) {
      filters.push({ property: "categorySlug", operator: "eq", value: options.categorySlug });
    }
    if (options.userId) {
      filters.push({ property: "userId", operator: "eq", value: options.userId });
    }
    if (options.documentId) {
      filters.push({ property: "documentId", operator: "eq", value: options.documentId });
    }
    if (options.isPublic !== undefined) {
      filters.push({ property: "isPublic", operator: "eq", value: options.isPublic });
    }
    // Note: tags filter would need special handling for array containment
    // For now, we skip it - could be added later with a custom Cypher clause

    const semantic = options.semantic ?? true;
    const hybrid = options.hybrid ?? semantic;
    const originalLimit = options.limit ?? 20;

    // Fetch more candidates if post-processing needs them
    const needsMoreCandidates = options.rerank || (options.boostKeywords && options.boostKeywords.length > 0);
    const searchLimit = needsMoreCandidates ? Math.max(originalLimit, 100) : originalLimit;

    logger.info(
      `[CommunityOrchestrator] Search: "${options.query.substring(0, 50)}..." ` +
        `(semantic: ${semantic}, hybrid: ${hybrid}, filters: ${filters.length})`
    );

    const result = await this.searchService.search({
      query: options.query,
      semantic,
      hybrid,
      embeddingType: options.embeddingType ?? "all",
      limit: searchLimit,
      minScore: options.minScore ?? 0.3,
      filters,
      glob: options.glob,
      labels: options.labels,
    });

    // Map to community format with snippets
    let communityResults: CommunitySearchResult[] = result.results.map((r) => {
      // Use normalized field names: _content, _description, _name
      const content = (r.node._content || r.node._description || r.node._name || "") as string;

      // Generate snippet: prefer chunkText, fallback to truncated content
      let snippet: string | undefined;
      if (r.matchedRange?.chunkText) {
        // Use the actual chunk text that matched
        snippet = r.matchedRange.chunkText;
        if (snippet.length > 800) {
          snippet = snippet.substring(0, 800) + "...";
        }
      } else if (content.length > 500) {
        // Truncate long content
        snippet = content.substring(0, 500) + "...";
      } else {
        snippet = content;
      }

      return {
        node: r.node,
        score: r.score,
        filePath: r.filePath,
        matchedRange: r.matchedRange ? {
          startLine: r.matchedRange.startLine,
          endLine: r.matchedRange.endLine,
          startChar: r.matchedRange.startChar,
          endChar: r.matchedRange.endChar,
          chunkIndex: r.matchedRange.chunkIndex,
          chunkScore: r.matchedRange.chunkScore,
          pageNum: r.matchedRange.pageNum,
        } : undefined,
        snippet,
      };
    });

    // === Post-processing ===
    let reranked = false;
    let keywordBoosted = false;
    let entityBoosted = false;
    let matchingEntities: Array<{ uuid: string; name: string; type: 'Tag' | 'CanonicalEntity'; score: number }> | undefined;
    let relationshipsExplored = false;
    let summarized = false;
    let graph: ExplorationGraph | undefined;
    let summary: SummaryResult | undefined;

    // 1. Reranking (if enabled)
    if (options.rerank && communityResults.length > 0) {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey) {
        try {
          logger.info(`[CommunityOrchestrator] Applying LLM reranking to ${communityResults.length} results`);
          const rerankResult = await rerankSearchResults(communityResults, {
            query: options.query,
            apiKey: geminiKey,
          });
          if (rerankResult.evaluationCount > 0) {
            communityResults = rerankResult.results;
            reranked = true;
            logger.info(`[CommunityOrchestrator] Reranking complete: ${rerankResult.evaluationCount} evaluations`);
          }
        } catch (err: any) {
          logger.warn(`[CommunityOrchestrator] Reranking failed: ${err.message}`);
        }
      } else {
        logger.warn("[CommunityOrchestrator] Reranking requested but GEMINI_API_KEY not set");
      }
    }

    // 2. Keyword boosting (if enabled)
    if (options.boostKeywords && options.boostKeywords.length > 0 && communityResults.length > 0) {
      logger.info(`[CommunityOrchestrator] Applying keyword boost: ${options.boostKeywords.join(", ")}`);
      const boostedResults = await applyKeywordBoost(communityResults, {
        keywords: options.boostKeywords,
        boostWeight: options.boostWeight,
      });
      communityResults = boostedResults.map((b) => ({
        ...b.result,
        keywordBoost: b.keywordBoost,
      }));
      keywordBoosted = true;
      logger.info(`[CommunityOrchestrator] Keyword boost complete`);
    }

    // 3. Entity/Tag boosting (enabled by default)
    const entityBoostEnabled = options.entityBoost !== false; // default: true
    if (entityBoostEnabled && this.entityEmbeddingService && communityResults.length > 0) {
      const threshold = options.entityMatchThreshold ?? 0.7;
      const boostWeight = options.entityBoostWeight ?? 0.05;

      try {
        // 3a. Search for matching entities/tags
        const entityResults = await this.entityEmbeddingService.search({
          query: options.query,
          semantic: true,
          hybrid: true,
          limit: 10,
          minScore: threshold, // Only get strong matches
        });

        if (entityResults.length > 0) {
          // Store matching entities for response
          matchingEntities = entityResults.map(e => ({
            uuid: e.uuid,
            name: e.name,
            type: e.nodeType as 'Tag' | 'CanonicalEntity',
            score: e.score,  // For matchingEntities in response
          }));

          // Also create version with matchScore for result.matchedEntities
          const matchedEntitiesForResults = entityResults.map(e => ({
            uuid: e.uuid,
            name: e.name,
            type: e.nodeType as 'Tag' | 'CanonicalEntity',
            matchScore: e.score,
          }));

          logger.info(`[CommunityOrchestrator] Found ${entityResults.length} matching entities/tags (threshold: ${threshold})`);

          // 3b. Get UUIDs of nodes linked to these entities/tags
          const entityUuids = entityResults.filter(e => e.nodeType === 'CanonicalEntity').map(e => e.uuid);
          const tagUuids = entityResults.filter(e => e.nodeType === 'Tag').map(e => e.uuid);

          // Query Neo4j to find which result nodes have these entities/tags
          const linkedNodesQuery = `
            // Find sections with matching tags
            OPTIONAL MATCH (section)-[:HAS_TAG]->(tag:Tag)
            WHERE tag.uuid IN $tagUuids
            WITH collect(DISTINCT section.uuid) as tagLinkedSections, $tagUuids as tagUuids

            // Find sections with matching entities (via canonical)
            OPTIONAL MATCH (section)-[:CONTAINS_ENTITY]->(entity:Entity)-[:CANONICAL_IS]->(canonical:CanonicalEntity)
            WHERE canonical.uuid IN $entityUuids
            WITH tagLinkedSections, collect(DISTINCT section.uuid) as entityLinkedSections

            // Return all linked section UUIDs
            RETURN tagLinkedSections + entityLinkedSections as linkedUuids
          `;

          const linkedResult = await this.neo4j.run(linkedNodesQuery, { tagUuids, entityUuids });
          const linkedUuids = new Set<string>(
            linkedResult.records[0]?.get('linkedUuids')?.filter((u: any) => u != null) || []
          );

          if (linkedUuids.size > 0) {
            // 3c. Apply boost to results that have matching entities/tags
            let boostedCount = 0;
            for (const result of communityResults) {
              const nodeUuid = result.node.uuid;
              if (linkedUuids.has(nodeUuid)) {
                // Find best matching entity/tag for this result
                const bestMatch = entityResults.reduce((best, e) => e.score > best.score ? e : best, entityResults[0]);
                const boost = bestMatch.score * boostWeight;
                result.score += boost;
                result.entityBoostApplied = boost;

                // Include matched entities if requested
                if (options.includeMatchedEntities) {
                  result.matchedEntities = matchedEntitiesForResults;
                }
                boostedCount++;
              }
            }

            if (boostedCount > 0) {
              // Re-sort by score
              communityResults.sort((a, b) => b.score - a.score);
              entityBoosted = true;
              logger.info(`[CommunityOrchestrator] Entity boost applied to ${boostedCount} results`);
            }
          }
        }
      } catch (err: any) {
        logger.warn(`[CommunityOrchestrator] Entity boost failed: ${err.message}`);
      }
    }

    // 4. Apply final limit
    if (communityResults.length > originalLimit) {
      communityResults = communityResults.slice(0, originalLimit);
    }

    // 5. Relationship exploration (if enabled)
    if (options.exploreDepth && options.exploreDepth > 0 && communityResults.length > 0 && this.coreClient) {
      logger.info(`[CommunityOrchestrator] Exploring relationships (depth: ${options.exploreDepth})`);
      graph = await exploreRelationships(communityResults, {
        neo4jClient: this.coreClient,
        depth: options.exploreDepth,
      });
      if (graph && graph.nodes.length > 0) {
        relationshipsExplored = true;
        logger.info(`[CommunityOrchestrator] Found ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

        // Filter graph nodes by semantic relevance to query
        // Get UUIDs of non-search-result nodes (dependencies)
        const dependencyUuids = graph.nodes
          .filter(n => !n.isSearchResult)
          .map(n => n.uuid);

        if (dependencyUuids.length > 0 && this.searchService) {
          // Do a hybrid search filtered to dependency UUIDs
          const depSearchResult = await this.searchService.search({
            query: options.query,
            semantic: true,
            hybrid: true,
            limit: Math.min(dependencyUuids.length, options.exploreTopK ?? 20),
            minScore: 0.3,
            uuids: dependencyUuids,
          });

          // Keep only relevant dependency nodes
          const relevantUuids = new Set(depSearchResult.results.map(r => r.node.uuid as string));
          // Also keep all search result nodes
          const searchResultUuids = new Set(graph.nodes.filter(n => n.isSearchResult).map(n => n.uuid));

          // Filter nodes
          graph.nodes = graph.nodes.filter(n => relevantUuids.has(n.uuid) || searchResultUuids.has(n.uuid));

          // Filter edges to only include those between remaining nodes
          const remainingUuids = new Set(graph.nodes.map(n => n.uuid));
          graph.edges = graph.edges.filter(e => remainingUuids.has(e.from) && remainingUuids.has(e.to));

          logger.info(`[CommunityOrchestrator] Filtered graph to ${graph.nodes.length} relevant nodes`);
        }
      }
    }

    // 6. Summarization (if enabled)
    if (options.summarize && communityResults.length > 0) {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey) {
        try {
          logger.info(`[CommunityOrchestrator] Summarizing ${communityResults.length} results`);
          summary = await summarizeSearchResults(communityResults, {
            query: options.query,
            context: options.summarizeContext,
            apiKey: geminiKey,
          });
          summarized = true;
          logger.info(`[CommunityOrchestrator] Summary: ${summary.snippets.length} snippets, ${summary.findings.length} chars`);
        } catch (err: any) {
          logger.warn(`[CommunityOrchestrator] Summarization failed: ${err.message}`);
        }
      } else {
        logger.warn("[CommunityOrchestrator] Summarization requested but GEMINI_API_KEY not set");
      }
    }

    logger.info(`[CommunityOrchestrator] Search returned ${communityResults.length} results`);

    // 7. Format output (if requested)
    let formattedOutput: string | undefined;
    if (options.format === "markdown" || options.format === "compact") {
      // Convert to BrainSearchOutput format for the formatter
      const brainSearchOutput: BrainSearchOutput = {
        results: communityResults.map((r) => ({
          node: r.node,
          score: r.score,
          projectId: r.node.projectId || "unknown",
          projectPath: r.node.absolutePath || r.filePath || "",
          filePath: r.node.absolutePath || r.filePath || r.node.file || "",
          matchedRange: r.matchedRange,
        })),
        totalCount: result.totalCount,
        searchedProjects: [], // community-docs uses Prisma projects
        graph,
        summary,
      };

      if (options.format === "markdown") {
        const formatOptions: FormatOptions = {
          includeSource: options.includeSource ?? true,
          maxSourceResults: options.maxSourceResults ?? 5,
          includeGraph: !!graph,
        };
        formattedOutput = formatAsMarkdown(brainSearchOutput, options.query, formatOptions);
        logger.info(`[CommunityOrchestrator] Formatted as markdown (${formattedOutput.length} chars)`);
      }
      // Note: compact format would need formatAsCompact, but we focus on markdown for now
    }

    return {
      results: communityResults,
      totalCount: result.totalCount,
      reranked: reranked || undefined,
      keywordBoosted: keywordBoosted || undefined,
      entityBoosted: entityBoosted || undefined,
      matchingEntities: matchingEntities,
      relationshipsExplored: relationshipsExplored || undefined,
      summarized: summarized || undefined,
      graph,
      summary,
      formattedOutput,
    };
  }

  /**
   * Grep search - regex pattern matching on indexed content
   *
   * Uses SearchService.grep() to search _content field with regex patterns.
   * Supports glob filtering, context lines, and community-specific filters.
   *
   * @example
   * ```typescript
   * const results = await orchestrator.grep({
   *   pattern: 'async function.*Handler',
   *   glob: '**\/*.ts',
   *   ignoreCase: true,
   *   contextLines: 2,
   *   categorySlug: 'ragforge',
   * });
   * ```
   */
  async grep(options: {
    pattern: string;
    ignoreCase?: boolean;
    glob?: string;
    limit?: number;
    contextLines?: number;
    // Community-specific filters
    categorySlug?: string;
    userId?: string;
    documentId?: string;
  }): Promise<GrepResultSet> {
    await this.initialize();

    if (!this.searchService) {
      throw new Error("SearchService not initialized");
    }

    // Build community-specific filters
    const filters: SearchFilter[] = [];

    if (options.categorySlug) {
      filters.push({
        property: "categorySlug",
        operator: "eq",
        value: options.categorySlug,
      });
    }

    if (options.userId) {
      filters.push({
        property: "userId",
        operator: "eq",
        value: options.userId,
      });
    }

    if (options.documentId) {
      filters.push({
        property: "documentId",
        operator: "eq",
        value: options.documentId,
      });
    }

    logger.info(
      `[CommunityOrchestrator] Grep: "${options.pattern}" (glob: ${options.glob || '*'}, filters: ${filters.length})`
    );

    return this.searchService.grepVirtual({
      pattern: options.pattern,
      ignoreCase: options.ignoreCase,
      glob: options.glob,
      limit: options.limit,
      contextLines: options.contextLines,
      filters,
    });
  }

  /**
   * Extract dependency hierarchy for a scope at file:line
   *
   * Finds the scope containing the given line and returns its dependency graph:
   * - CONSUMES: what the scope depends on (imports, calls)
   * - CONSUMED_BY: what uses this scope (consumers)
   *
   * @param options - file path, line number, depth, direction
   * @returns Dependency hierarchy with root scope, dependencies, consumers, and graph
   */
  async extractDependencyHierarchy(options: {
    file: string;
    line: number;
    depth?: number;
    direction?: 'both' | 'consumes' | 'consumed_by';
    maxNodes?: number;
    includeCodeSnippets?: boolean;
    codeSnippetLines?: number;
    format?: 'json' | 'markdown';
  }): Promise<{
    success: boolean;
    error?: string;
    root: {
      uuid: string;
      name: string;
      type: string;
      file: string;
      startLine: number;
      endLine: number;
      snippet?: string;
    } | null;
    dependencies: Array<{
      uuid: string;
      name: string;
      type: string;
      file: string;
      startLine: number;
      endLine: number;
      depth: number;
      snippet?: string;
    }>;
    consumers: Array<{
      uuid: string;
      name: string;
      type: string;
      file: string;
      startLine: number;
      endLine: number;
      depth: number;
      snippet?: string;
    }>;
    graph: {
      nodes: Array<{ uuid: string; name: string; type: string; file: string; startLine: number; endLine: number }>;
      edges: Array<{ from: string; to: string; type: string; depth: number }>;
    };
    formattedOutput?: string;
  }> {
    await this.initialize();

    const {
      file,
      line,
      depth = 2,
      direction = 'both',
      maxNodes = 50,
      includeCodeSnippets = true,
      codeSnippetLines = 10,
      format = 'json',
    } = options;

    const toNumber = (value: any): number => {
      if (typeof value === 'number') return value;
      if (value?.toNumber) return value.toNumber();
      return 0;
    };

    try {
      // 1. Find scope at file:line (smallest scope containing that line)
      // s.file contains just the filename, so we need to join with File node
      // or match via DEFINED_IN relationship
      const result = await this.neo4j.run(
        `MATCH (s:Scope)-[:DEFINED_IN]->(f:File)
         WHERE f.absolutePath ENDS WITH $file
           AND s.startLine IS NOT NULL
           AND s.endLine IS NOT NULL
           AND s.startLine <= $line
           AND s.endLine >= $line
           AND NOT s:MarkdownSection
           AND NOT s:WebPage
         RETURN s.uuid AS uuid, s.name AS name, s.type AS type,
                s.startLine AS startLine, s.endLine AS endLine,
                f.absolutePath AS file, s.source AS source
         ORDER BY (s.endLine - s.startLine) ASC
         LIMIT 1`,
        { file, line: neo4j.int(line) }
      );

      const scopeResult = result.records.length > 0 ? result : null;

      if (!scopeResult || scopeResult.records.length === 0) {
        return {
          success: false,
          error: `No scope found at ${file}:${line}`,
          root: null,
          dependencies: [],
          consumers: [],
          graph: { nodes: [], edges: [] },
        };
      }

      const rootRecord = scopeResult.records[0];
      const rootUuid = rootRecord.get('uuid') as string;
      const rootName = rootRecord.get('name') as string;
      const rootType = rootRecord.get('type') as string;
      const rootFile = rootRecord.get('file') as string;
      const rootStartLine = toNumber(rootRecord.get('startLine'));
      const rootEndLine = toNumber(rootRecord.get('endLine'));
      const rootSource = rootRecord.get('source') as string | null;

      // 2. Build Cypher query to extract hierarchy
      const queries: Array<{ query: string; type: 'consumes' | 'consumed_by' }> = [];

      if (direction === 'both' || direction === 'consumes') {
        queries.push({
          query: `
            MATCH path = (root:Scope {uuid: $rootUuid})-[:CONSUMES*1..${depth}]->(dep:Scope)
            WHERE NOT dep.uuid = $rootUuid
            WITH dep, length(path) AS depth_level
            ORDER BY depth_level, dep.name
            LIMIT $maxNodes
            RETURN DISTINCT dep.uuid AS uuid, dep.name AS name, dep.type AS type,
                   COALESCE(dep.absolutePath, dep.file) AS file,
                   dep.startLine AS startLine, dep.endLine AS endLine,
                   dep.source AS source, depth_level AS depth
          `,
          type: 'consumes',
        });
      }

      if (direction === 'both' || direction === 'consumed_by') {
        queries.push({
          query: `
            MATCH path = (consumer:Scope)-[:CONSUMES*1..${depth}]->(root:Scope {uuid: $rootUuid})
            WHERE NOT consumer.uuid = $rootUuid
            WITH consumer, length(path) AS depth_level
            ORDER BY depth_level, consumer.name
            LIMIT $maxNodes
            RETURN DISTINCT consumer.uuid AS uuid, consumer.name AS name, consumer.type AS type,
                   COALESCE(consumer.absolutePath, consumer.file) AS file,
                   consumer.startLine AS startLine, consumer.endLine AS endLine,
                   consumer.source AS source, depth_level AS depth
          `,
          type: 'consumed_by',
        });
      }

      // 3. Execute queries and build results
      const dependencies: Array<any> = [];
      const consumers: Array<any> = [];
      const nodes = new Map<string, any>();
      const edges: Array<any> = [];

      // Add root node
      const rootSnippet = includeCodeSnippets && rootSource
        ? rootSource.split('\n').slice(0, codeSnippetLines).join('\n')
        : undefined;

      nodes.set(rootUuid, {
        uuid: rootUuid,
        name: rootName,
        type: rootType,
        file: rootFile,
        startLine: rootStartLine,
        endLine: rootEndLine,
      });

      for (const { query, type } of queries) {
        const result = await this.neo4j.run(query, { rootUuid, maxNodes: neo4j.int(maxNodes) });

        for (const record of result.records) {
          const uuid = record.get('uuid') as string;
          const name = record.get('name') as string;
          const nodeType = record.get('type') as string;
          const nodeFile = record.get('file') as string;
          const startLine = toNumber(record.get('startLine'));
          const endLine = toNumber(record.get('endLine'));
          const source = record.get('source') as string | null;
          const depthLevel = toNumber(record.get('depth'));

          const snippet = includeCodeSnippets && source
            ? source.split('\n').slice(0, codeSnippetLines).join('\n')
            : undefined;

          const nodeData = {
            uuid,
            name,
            type: nodeType,
            file: nodeFile,
            startLine,
            endLine,
            depth: depthLevel,
            snippet,
          };

          nodes.set(uuid, { uuid, name, type: nodeType, file: nodeFile, startLine, endLine });

          if (type === 'consumes') {
            dependencies.push(nodeData);
            edges.push({ from: rootUuid, to: uuid, type: 'CONSUMES', depth: depthLevel });
          } else {
            consumers.push(nodeData);
            edges.push({ from: uuid, to: rootUuid, type: 'CONSUMES', depth: depthLevel });
          }
        }
      }

      logger.info(
        `[CommunityOrchestrator] Hierarchy extracted for ${rootName}: ` +
        `${dependencies.length} dependencies, ${consumers.length} consumers`
      );

      // Format as ASCII tree if requested
      let formattedOutput: string | undefined;
      if (format === 'markdown') {
        formattedOutput = this.formatHierarchyAsMarkdown({
          root: { uuid: rootUuid, name: rootName, type: rootType, file: rootFile, startLine: rootStartLine, endLine: rootEndLine, snippet: rootSnippet },
          dependencies,
          consumers,
        });
      }

      return {
        success: true,
        root: {
          uuid: rootUuid,
          name: rootName,
          type: rootType,
          file: rootFile,
          startLine: rootStartLine,
          endLine: rootEndLine,
          snippet: rootSnippet,
        },
        dependencies,
        consumers,
        graph: {
          nodes: Array.from(nodes.values()),
          edges,
        },
        formattedOutput,
      };
    } catch (error: any) {
      logger.error(`[CommunityOrchestrator] Hierarchy extraction failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        root: null,
        dependencies: [],
        consumers: [],
        graph: { nodes: [], edges: [] },
      };
    }
  }

  /**
   * Format hierarchy as ASCII tree markdown with inline code snippets
   */
  private formatHierarchyAsMarkdown(data: {
    root: { uuid: string; name: string; type: string; file: string; startLine: number; endLine: number; snippet?: string };
    dependencies: Array<{ uuid: string; name: string; type: string; file: string; startLine: number; endLine: number; depth: number; snippet?: string }>;
    consumers: Array<{ uuid: string; name: string; type: string; file: string; startLine: number; endLine: number; depth: number; snippet?: string }>;
  }): string {
    const lines: string[] = [];
    const { root, dependencies, consumers } = data;
    const rootFile = root.file;

    // Helper to format node header with relative paths
    const formatNodeHeader = (node: { name: string; type: string; file: string; startLine: number; endLine?: number }, isRoot = false): string => {
      const lineInfo = node.endLine && node.endLine !== node.startLine
        ? `${node.startLine}-${node.endLine}`
        : `${node.startLine}`;
      // Root shows filename, dependencies/consumers show relative path from root
      const pathDisplay = isRoot
        ? (node.file.split('/').pop() || node.file)
        : getRelativePath(rootFile, node.file);
      return `[${node.type}] ${node.name} (${pathDisplay}:${lineInfo})`;
    };

    // Helper to add snippet lines with proper prefix
    const addSnippetLines = (snippet: string | undefined, prefix: string, isLastNode: boolean): void => {
      if (!snippet) return;
      const snippetLines = snippet.split('\n');
      const continuationPrefix = prefix + (isLastNode ? '    ' : '│   ');
      lines.push(`${continuationPrefix}┈┈┈`);
      for (const snippetLine of snippetLines) {
        lines.push(`${continuationPrefix}${snippetLine}`);
      }
      lines.push(`${continuationPrefix}┈┈┈`);
    };

    // Title with path context
    const shortContext = getShortDirContext(rootFile);
    lines.push('## Dependency Hierarchy');
    lines.push(`*Paths relative to ${shortContext}*`);
    lines.push('');

    // Root node
    lines.push(`◉ ${formatNodeHeader(root, true)}`);
    if (root.snippet) {
      const snippetLines = root.snippet.split('\n');
      lines.push('│ ┈┈┈');
      for (const snippetLine of snippetLines) {
        lines.push(`│ ${snippetLine}`);
      }
      lines.push('│ ┈┈┈');
    }

    const hasDeps = dependencies.length > 0;
    const hasCons = consumers.length > 0;

    // Dependencies (CONSUMES - what root uses)
    if (hasDeps) {
      const branchPrefix = hasCons ? '├' : '└';
      lines.push(`${branchPrefix}── CONSUMES (${dependencies.length} dependencies)`);

      const depPrefix = hasCons ? '│   ' : '    ';

      for (let i = 0; i < dependencies.length; i++) {
        const node = dependencies[i];
        const isLast = i === dependencies.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const depthIndicator = node.depth > 1 ? `↳${node.depth} ` : '';
        lines.push(`${depPrefix}${connector}${depthIndicator}${formatNodeHeader(node)}`);

        if (node.snippet) {
          const snippetPrefix = depPrefix + (isLast ? '    ' : '│   ');
          const snippetLines = node.snippet.split('\n');
          lines.push(`${snippetPrefix}┈┈┈`);
          for (const snippetLine of snippetLines) {
            lines.push(`${snippetPrefix}${snippetLine}`);
          }
          lines.push(`${snippetPrefix}┈┈┈`);
        }
      }
    }

    // Consumers (CONSUMED_BY - what uses root)
    if (hasCons) {
      lines.push(`└── CONSUMED_BY (${consumers.length} consumers)`);

      const consPrefix = '    ';

      for (let i = 0; i < consumers.length; i++) {
        const node = consumers[i];
        const isLast = i === consumers.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const depthIndicator = node.depth > 1 ? `↳${node.depth} ` : '';
        lines.push(`${consPrefix}${connector}${depthIndicator}${formatNodeHeader(node)}`);

        if (node.snippet) {
          const snippetPrefix = consPrefix + (isLast ? '    ' : '│   ');
          const snippetLines = node.snippet.split('\n');
          lines.push(`${snippetPrefix}┈┈┈`);
          for (const snippetLine of snippetLines) {
            lines.push(`${snippetPrefix}${snippetLine}`);
          }
          lines.push(`${snippetPrefix}┈┈┈`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Delete all nodes for a document (source within a project)
   */
  async deleteDocument(documentId: string): Promise<number> {
    await this.initialize();

    // Delete by documentId (source tracking within project)
    const result = await this.neo4j.run(
      `MATCH (n {documentId: $documentId}) DETACH DELETE n RETURN count(n) as count`,
      { documentId }
    );

    const count = result.records[0]?.get("count")?.toNumber() ?? 0;
    logger.info(`Deleted ${count} nodes for document: ${documentId}`);

    return count;
  }

  /**
   * Delete all nodes for a project
   */
  async deleteProjectNodes(projectId: string): Promise<number> {
    await this.initialize();

    // Delete by projectId
    const result = await this.neo4j.run(
      `MATCH (n {projectId: $projectId}) DETACH DELETE n RETURN count(n) as count`,
      { projectId }
    );

    const count = result.records[0]?.get("count")?.toNumber() ?? 0;
    logger.info(`Deleted ${count} nodes for project: ${projectId}`);

    return count;
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    if (this.orchestrator) {
      await this.orchestrator.stop();
      this.orchestrator = null;
    }
  }
}

/**
 * Singleton instance
 */
let orchestratorAdapter: CommunityOrchestratorAdapter | null = null;

export function getCommunityOrchestrator(
  options: CommunityOrchestratorOptions
): CommunityOrchestratorAdapter {
  if (!orchestratorAdapter) {
    orchestratorAdapter = new CommunityOrchestratorAdapter(options);
  }
  return orchestratorAdapter;
}

export function resetCommunityOrchestrator(): void {
  if (orchestratorAdapter) {
    orchestratorAdapter.stop();
    orchestratorAdapter = null;
  }
}
