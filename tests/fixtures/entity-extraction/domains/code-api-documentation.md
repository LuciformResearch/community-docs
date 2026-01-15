# API Documentation - Entity Extraction Module

Ce document teste l'extraction d'entités pour le domaine **code**.

## Overview

The **entity-extraction** module provides functionality for extracting named entities from text using **GLiNER2**. It integrates with the **search-service** module and stores results in **Neo4j**.

## Core Classes

### EntityExtractionClient

The `EntityExtractionClient` class handles communication with the GLiNER microservice.

```typescript
class EntityExtractionClient {
  constructor(config: EntityExtractionConfig);

  async extract(text: string): Promise<ExtractionResult>;
  async extractBatch(texts: string[]): Promise<ExtractionResult[]>;
}
```

The `EntityExtractionClient` depends on the **neo4j-driver** library for database operations.

### SearchService

The `SearchService` class provides semantic search capabilities. It calls the `searchEntities()` function internally.

```typescript
class SearchService {
  async search(query: string): Promise<SearchResult[]>;
  async vectorSearch(embedding: number[]): Promise<SearchResult[]>;
}
```

The `SearchService` imports functionality from the **entity-extraction** module.

### BrainManager

The `BrainManager` class orchestrates all brain operations. It calls both `SearchService` and `EntityExtractionClient`.

```typescript
class BrainManager {
  private searchService: SearchService;
  private extractionClient: EntityExtractionClient;

  async ingestAndExtract(content: string): Promise<void>;
}
```

## Key Functions

### searchEntities()

The `searchEntities()` function performs entity-aware search:

```typescript
function searchEntities(
  query: string,
  options: SearchOptions
): Promise<Entity[]>;
```

This function calls `vectorSearch()` internally and depends on **fastapi** for the API layer.

### deduplicateEntities()

The `deduplicateEntities()` function removes duplicate entities:

```typescript
function deduplicateEntities(
  entities: Entity[],
  config: DeduplicationConfig
): Promise<DeduplicationResult>;
```

It uses **Levenshtein distance** for fuzzy matching.

### buildEntityGraph()

The `buildEntityGraph()` function constructs the entity relationship graph:

```typescript
function buildEntityGraph(
  entities: Entity[],
  relations: Relation[]
): EntityGraph;
```

## Module Dependencies

```
entity-extraction
├── imports: neo4j-driver
├── imports: gliner2
└── imports: search-service

search-service
├── imports: entity-extraction
├── imports: neo4j-driver
└── depends_on: fastapi

brain
├── imports: search-service
├── imports: entity-extraction
└── depends_on: neo4j-driver
```

## API Endpoints

The module exposes the following **REST API** endpoints:

| Endpoint | Method | Function |
|----------|--------|----------|
| `/extract` | POST | `extract()` |
| `/extract/batch` | POST | `extractBatch()` |
| `/search` | GET | `searchEntities()` |

## Error Handling

The `EntityExtractionError` exception is thrown when extraction fails:

```typescript
class EntityExtractionError extends Error {
  constructor(message: string, cause?: Error);
}
```

The `SearchService` catches `EntityExtractionError` and falls back to keyword search.
