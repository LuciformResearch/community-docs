/**
 * Community Ingester - Simplified ingestion facade for Community-Docs
 *
 * This replaces the heavier CommunityOrchestratorAdapter with a lightweight
 * factory function that wraps UnifiedProcessor.
 *
 * @since 2026-01-19
 */

import {
  UnifiedProcessor,
  downloadGitHubRepo,
  extractZipToVirtualFiles,
  createVirtualFileFromContent,
  Neo4jClient as CoreNeo4jClient,
  EmbeddingService,
  type ProcessingStats,
  type VirtualFile,
  type ParserOptionsConfig,
  type GitHubDownloadOptions,
  type ZipExtractOptions,
} from "@luciformresearch/ragforge";
import { getPipelineLogger } from "./logger";

// Use 'any' for Driver to avoid version conflicts between neo4j-driver instances
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Driver = any;

const logger = getPipelineLogger();

// ============================================
// Types
// ============================================

/**
 * Community metadata to inject on all ingested nodes
 */
export interface CommunityMetadata {
  projectId: string;
  documentId?: string;
  documentTitle?: string;
  userId?: string;
  userUsername?: string;
  categoryId?: string;
  categorySlug?: string;
  categoryName?: string;
  isPublic?: boolean;
  tags?: string[];
  [key: string]: unknown; // Allow extra properties
}

/**
 * Configuration for creating a CommunityIngester
 */
export interface CommunityIngesterConfig {
  driver: Driver;
  neo4jClient: CoreNeo4jClient;
  embeddingService?: EmbeddingService;
}

/**
 * The CommunityIngester interface - all methods return ProcessingStats
 */
export interface CommunityIngester {
  // Core ingestion methods
  ingestVirtual(
    files: Array<{ path: string; content: string | Buffer }>,
    projectId: string,
    metadata: CommunityMetadata,
    options?: { sourceIdentifier?: string; generateEmbeddings?: boolean; parserOptions?: ParserOptionsConfig }
  ): Promise<ProcessingStats>;

  ingestFiles(
    files: Array<{ fileName: string; buffer: Buffer }>,
    projectId: string,
    metadata: CommunityMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      render3D?: (modelPath: string) => Promise<Array<{ view: string; buffer: Buffer }>>;
      sectionTitles?: "none" | "detect" | "llm";
      generateTitles?: boolean;
      generateEmbeddings?: boolean;
      extractEntities?: boolean;
    }
  ): Promise<ProcessingStats>;

  // Convenience methods for common sources
  ingestGitHub(
    url: string,
    projectId: string,
    metadata: CommunityMetadata,
    options?: GitHubDownloadOptions
  ): Promise<ProcessingStats>;

  ingestZip(
    zipBuffer: Buffer,
    projectId: string,
    metadata: CommunityMetadata,
    options?: ZipExtractOptions
  ): Promise<ProcessingStats>;

  ingestDocument(
    content: Buffer | string,
    fileName: string,
    projectId: string,
    metadata: CommunityMetadata
  ): Promise<ProcessingStats>;

  ingestBinaryDocument(
    buffer: Buffer,
    fileName: string,
    projectId: string,
    metadata: CommunityMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      sectionTitles?: "none" | "detect" | "llm";
      maxPages?: number;
      generateTitles?: boolean;
    }
  ): Promise<ProcessingStats>;

  ingestMedia(
    buffer: Buffer,
    fileName: string,
    projectId: string,
    metadata: CommunityMetadata,
    options?: {
      enableVision?: boolean;
      visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
      render3D?: (modelPath: string) => Promise<Array<{ view: string; buffer: Buffer }>>;
    }
  ): Promise<ProcessingStats>;

  // Utility methods
  generateEmbeddings(projectId: string): Promise<number>;
  hasEmbeddingService(): boolean;
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a CommunityIngester instance
 *
 * @example
 * const ingester = createCommunityIngester({
 *   driver: neo4jDriver,
 *   neo4jClient: coreNeo4jClient,
 *   embeddingService: embeddingService,
 * });
 *
 * await ingester.ingestVirtual(
 *   [{ path: "readme.md", content: "# Hello" }],
 *   "project-123",
 *   { userId: "user-1", categoryId: "cat-1" }
 * );
 */
export function createCommunityIngester(config: CommunityIngesterConfig): CommunityIngester {
  const { driver, neo4jClient, embeddingService } = config;

  // Cache processors by projectId
  const processorCache = new Map<string, UnifiedProcessor>();

  function getProcessor(projectId: string): UnifiedProcessor {
    let processor = processorCache.get(projectId);
    if (!processor) {
      processor = new UnifiedProcessor({
        driver,
        neo4jClient,
        projectId,
        contentSourceType: "virtual",
        embeddingService,
      });
      processorCache.set(projectId, processor);
    }
    return processor;
  }

  function buildAdditionalProperties(
    projectId: string,
    metadata: CommunityMetadata,
    extra?: Record<string, unknown>
  ): Record<string, unknown> {
    return {
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
      ...extra,
    };
  }

  return {
    async ingestVirtual(files, projectId, metadata, options) {
      logger.info(`Ingesting ${files.length} virtual files into project: ${projectId}`);

      const sourceIdentifier = options?.sourceIdentifier ?? "upload";
      const virtualFiles: VirtualFile[] = files.map((f) => ({
        path: `${sourceIdentifier}/${f.path.startsWith("/") ? f.path.slice(1) : f.path}`,
        content: f.content,
      }));

      const processor = getProcessor(projectId);
      const stats = await processor.ingestVirtualFiles(virtualFiles, {
        additionalProperties: buildAdditionalProperties(projectId, metadata, { sourceType: "community-upload" }),
        parserOptions: options?.parserOptions,
      });

      logger.info(`Virtual files ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestFiles(files, projectId, metadata, options) {
      logger.info(`Ingesting ${files.length} files into project: ${projectId}`);

      const virtualFiles: VirtualFile[] = files.map(({ fileName, buffer }) => ({
        path: `upload/${fileName}`,
        content: buffer,
      }));

      const processor = getProcessor(projectId);
      const stats = await processor.ingestVirtualFiles(virtualFiles, {
        additionalProperties: buildAdditionalProperties(projectId, metadata, { sourceType: "upload" }),
        parserOptions: {
          enableVision: options?.enableVision,
          visionAnalyzer: options?.visionAnalyzer,
          render3D: options?.render3D,
          sectionTitles: options?.sectionTitles ?? "detect",
          generateTitles: options?.generateTitles ?? true,
        },
      });

      logger.info(`Files ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestGitHub(url, projectId, metadata, options) {
      logger.info(`Ingesting GitHub repo: ${url} into project: ${projectId}`);

      const { files, metadata: repoMetadata, warnings } = await downloadGitHubRepo(url, {
        method: options?.method ?? "git",
        includeSubmodules: options?.includeSubmodules ?? true,
        token: options?.token,
        exclude: options?.exclude,
        include: options?.include,
        maxFileSize: options?.maxFileSize,
      });

      logger.info(`Downloaded ${files.length} files from ${repoMetadata.owner}/${repoMetadata.repo}`);
      if (warnings.length > 0) {
        logger.warn(`Warnings: ${warnings.join(", ")}`);
      }

      const processor = getProcessor(projectId);
      const stats = await processor.ingestVirtualFiles(files, {
        additionalProperties: buildAdditionalProperties(projectId, metadata, {
          sourceType: "github",
          sourceUrl: url,
          documentTitle: metadata.documentTitle ?? `${repoMetadata.owner}/${repoMetadata.repo}`,
        }),
      });

      logger.info(`GitHub ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestZip(zipBuffer, projectId, metadata, options) {
      logger.info(`Ingesting ZIP into project: ${projectId}`);

      const { files, warnings } = await extractZipToVirtualFiles(zipBuffer, options);

      logger.info(`Extracted ${files.length} files from ZIP`);
      if (warnings.length > 0) {
        logger.warn(`Warnings: ${warnings.join(", ")}`);
      }

      const processor = getProcessor(projectId);
      const stats = await processor.ingestVirtualFiles(files, {
        additionalProperties: buildAdditionalProperties(projectId, metadata, {
          sourceType: "zip",
          documentTitle: metadata.documentTitle ?? "ZIP Upload",
        }),
      });

      logger.info(`ZIP ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestDocument(content, fileName, projectId, metadata) {
      logger.info(`Ingesting document: ${fileName} into project: ${projectId}`);

      const file = createVirtualFileFromContent(content, fileName);
      const processor = getProcessor(projectId);

      const stats = await processor.ingestVirtualFiles([file], {
        additionalProperties: buildAdditionalProperties(projectId, metadata, {
          sourceType: "upload",
          documentTitle: metadata.documentTitle ?? fileName,
        }),
      });

      logger.info(`Document ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestBinaryDocument(buffer, fileName, projectId, metadata, options) {
      logger.info(`Ingesting binary document: ${fileName} into project: ${projectId}`);

      const file = createVirtualFileFromContent(buffer, fileName);
      const processor = getProcessor(projectId);

      const stats = await processor.ingestVirtualFiles([file], {
        additionalProperties: buildAdditionalProperties(projectId, metadata, {
          sourceType: "upload",
          documentTitle: metadata.documentTitle ?? fileName,
          sourceFormat: fileName.split(".").pop()?.toLowerCase(),
        }),
        parserOptions: {
          enableVision: options?.enableVision,
          visionAnalyzer: options?.visionAnalyzer,
          sectionTitles: options?.sectionTitles ?? "detect",
          maxPages: options?.maxPages,
          generateTitles: options?.generateTitles ?? true,
        },
      });

      logger.info(`Binary document ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async ingestMedia(buffer, fileName, projectId, metadata, options) {
      logger.info(`Ingesting media file: ${fileName} into project: ${projectId}`);

      const file = createVirtualFileFromContent(buffer, fileName);
      const processor = getProcessor(projectId);

      const ext = fileName.split(".").pop()?.toLowerCase() || "";
      const is3D = ["glb", "gltf", "obj", "fbx"].includes(ext);

      const stats = await processor.ingestVirtualFiles([file], {
        additionalProperties: buildAdditionalProperties(projectId, metadata, {
          sourceType: "upload",
          documentTitle: metadata.documentTitle ?? fileName,
          mediaType: is3D ? "3d-model" : "image",
        }),
        parserOptions: {
          enableVision: options?.enableVision,
          visionAnalyzer: options?.visionAnalyzer,
          render3D: options?.render3D,
        },
      });

      logger.info(`Media file ingestion complete: ${stats.filesProcessed} files, ${stats.scopesCreated} scopes`);
      return stats;
    },

    async generateEmbeddings(projectId) {
      if (!embeddingService || !embeddingService.canGenerateEmbeddings()) {
        logger.warn("No embedding service configured or not ready");
        return 0;
      }
      const result = await embeddingService.generateMultiEmbeddings({
        projectId,
        incrementalOnly: true,
      });
      return result.totalEmbedded;
    },

    hasEmbeddingService() {
      return !!embeddingService && embeddingService.canGenerateEmbeddings();
    },
  };
}

// Re-export types for convenience
export type { ProcessingStats, VirtualFile, ParserOptionsConfig, GitHubDownloadOptions, ZipExtractOptions };
