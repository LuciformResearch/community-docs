# Community Docs

A collaborative document management platform with RAG (Retrieval-Augmented Generation) capabilities, built on top of [RagForge](https://github.com/LuciformResearch/ragforge-core).

## Features

| Feature | Description |
|---------|-------------|
| **Document Upload** | Upload and process PDFs, DOCX, images, code files |
| **GitHub Ingestion** | Clone and index entire repositories |
| **ZIP Import** | Extract and process archives |
| **Virtual Files** | In-memory processing without disk persistence |
| **Semantic Search** | Find documents by meaning across all content |
| **Multi-tenant** | Organizations, workspaces, and document isolation |
| **AI Chat** | Chat with your documents using Claude |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Community Docs (Next.js)                    │
├─────────────────────────────────────────────────────────────────┤
│  • Web UI (React + Tailwind)                                    │
│  • API Routes (document CRUD, chat, ingestion)                  │
│  • Authentication (NextAuth)                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    RagForge Core (submodule)                     │
├─────────────────────────────────────────────────────────────────┤
│  • UniversalSourceAdapter (parsing)                             │
│  • UnifiedProcessor (ingestion pipeline)                        │
│  • SearchService (semantic + BM25 search)                       │
│  • EmbeddingService (Gemini / TEI / Ollama)                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Services                                 │
├─────────────────────────────────────────────────────────────────┤
│  • Neo4j (knowledge graph)                                      │
│  • GLiNER (entity extraction, optional GPU)                     │
│  • TEI (text embeddings, optional GPU)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 18.0.0 | [Download](https://nodejs.org/) |
| **Docker** | Latest | For Neo4j and optional GPU services |
| **pnpm** | ≥ 8.0 | `npm install -g pnpm` |

## Quick Start

### 1. Clone with submodules

```bash
git clone --recurse-submodules https://github.com/LuciformResearch/community-docs.git
cd community-docs
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

Required environment variables:
```bash
# Database
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password

# AI APIs
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key

# Auth (optional for local dev)
NEXTAUTH_SECRET=your-secret
NEXTAUTH_URL=http://localhost:3000
```

### 4. Start services

```bash
# Start Neo4j (required)
cd packages/ragforge-core/services
docker compose up -d neo4j

# Optional: Start GPU services for faster processing
docker compose up -d gliner tei
```

### 5. Run the application

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
community-docs/
├── app/                    # Next.js app router
│   ├── api/               # API routes
│   ├── (auth)/            # Auth pages
│   └── (dashboard)/       # Main app pages
├── components/            # React components
├── lib/                   # Shared utilities
│   └── ragforge/          # RagForge integration layer
│       ├── orchestrator-adapter.ts
│       ├── upload-adapter.ts
│       └── api/server.ts
├── packages/
│   └── ragforge-core/     # Git submodule
└── docs/                  # Documentation
```

## Key Integrations

### Document Ingestion

```typescript
import { CommunityOrchestratorAdapter } from '@/lib/ragforge/orchestrator-adapter';

const orchestrator = new CommunityOrchestratorAdapter(config);

// Ingest virtual files (in-memory)
await orchestrator.ingestVirtual({
  virtualFiles: [{ path: 'doc.md', content: '# Hello' }],
  metadata: { documentId, organizationId }
});

// Generate embeddings
await orchestrator.generateEmbeddingsForDocument(documentId);
```

### GitHub Repository Ingestion

```typescript
// POST /api/ingest/github
const response = await fetch('/api/ingest/github', {
  method: 'POST',
  body: JSON.stringify({
    url: 'https://github.com/owner/repo',
    branch: 'main',
    includeSubmodules: true
  })
});

// SSE stream for progress updates
const reader = response.body.getReader();
```

### Semantic Search

```typescript
import { CommunityOrchestratorAdapter } from '@/lib/ragforge/orchestrator-adapter';

const results = await orchestrator.search({
  query: 'authentication flow',
  semantic: true,
  limit: 20,
  filters: { organizationId }
});
```

## Development

### Update submodules

```bash
git submodule update --remote --merge
```

### Build

```bash
pnpm build
```

### Run tests

```bash
pnpm test
```

## Deployment

### Docker

```bash
docker build -t community-docs .
docker run -p 3000:3000 community-docs
```

### Vercel / Railway

The app is configured for deployment on serverless platforms. Make sure to:
1. Set all environment variables
2. Configure Neo4j Aura or external Neo4j instance
3. Set up external embedding service (Gemini API or hosted TEI)

## License

### License - Luciform Research Source License (LRSL) v1.1

**2025 Luciform Research. All rights reserved except as granted below.**

**Free to use for:**
- Research, education, personal exploration
- Freelance or small-scale projects (gross monthly revenue up to 100,000 EUR)
- Internal tools (if your company revenue is up to 100,000 EUR/month)

**Commercial use above this threshold** requires a separate agreement.

Contact for commercial licensing: [legal@luciformresearch.com](mailto:legal@luciformresearch.com)

**Grace period:** 60 days after crossing the revenue threshold

Full text: [LICENSE](./LICENSE)

---

**Note:** This is a custom "source-available" license, NOT an OSI-approved open source license.

## Related Projects

- [RagForge Core](https://github.com/LuciformResearch/ragforge-core) - The RAG engine powering Community Docs
- [LR CodeParsers](https://github.com/LuciformResearch/LR_CodeParsers) - Multi-language code parsing with tree-sitter
