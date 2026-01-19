# Architecture Community-Docs: Vision & Implementation

**Date**: 2026-01-18
**Statut**: En cours d'implémentation
**Dernière mise à jour**: 2026-01-18

---

## 1. Vision Produit

### Community-Docs = Interface Chat Multimodale avec Agent RAG

Community-Docs doit devenir principalement une **interface de chat avec un agent multimodal intelligent**, capable de:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMMUNITY-DOCS CHAT UI                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │  🤖 Agent: J'ai analysé le repo GitHub que tu as partagé.             │ │
│  │     J'ai trouvé 3 fichiers pertinents pour ta question sur            │ │
│  │     l'authentification...                                              │ │
│  │                                                                        │ │
│  │  📎 [github.com/user/repo] ingéré - 245 fichiers indexés              │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │  👤 User: Peux-tu m'expliquer comment fonctionne le login?            │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  [+] │ Comment puis-je t'aider avec ton projet?            │ [Send]   │ │
│  │      │                                                      │          │ │
│  └──────┴──────────────────────────────────────────────────────┴──────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  [+] Menu:                                                              ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       ││
│  │  │ 📄 Document │ │ 📦 ZIP      │ │ 🖼️ Image    │ │ 🔗 GitHub   │       ││
│  │  │ PDF, DOCX,  │ │ Archive de  │ │ Screenshot, │ │ Repo URL    │       ││
│  │  │ MD, TXT     │ │ code        │ │ diagram     │ │             │       ││
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘       ││
│  │  ┌─────────────┐ ┌─────────────┐                                       ││
│  │  │ 🌐 Web Page │ │ 🔍 Web      │                                       ││
│  │  │ URL à       │ │ Search     │                                       ││
│  │  │ ingérer     │ │             │                                       ││
│  │  └─────────────┘ └─────────────┘                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fonctionnalités Clés

| Action | Description | Implémentation |
|--------|-------------|----------------|
| **📄 Upload Document** | PDF, DOCX, MD, TXT, code files | Multipart upload → ingest virtuel |
| **📦 Upload ZIP** | Archive de code/docs | Extraction mémoire → ingest virtuel |
| **🖼️ Upload Image** | Screenshots, diagrams, photos | OCR/Vision → description + embedding |
| **🔗 GitHub Repo** | URL de repo à indexer | Clone temp → ingest virtuel → cleanup |
| **🌐 Web Page** | URL à crawler et indexer | Fetch → parse → ingest |
| **🔍 Web Search** | Recherche Google en temps réel | Tool agent pour infos récentes |

### L'Agent au Centre

L'agent est le coeur de l'application:

```
User Message + Attachments
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                        AGENT MULTIMODAL                          │
│                                                                  │
│  Tools disponibles:                                              │
│  • search_knowledge(query, projectId) - RAG sur le projet       │
│  • grep_code(pattern, projectId) - Recherche exacte             │
│  • read_file(path) - Lire fichier complet                       │
│  • web_search(query) - Recherche Google                         │
│  • fetch_web_page(url) - Crawler une page                       │
│  • ingest_github(url, projectId) - Indexer un repo              │
│  • ingest_document(file, projectId) - Indexer un document       │
│  • analyze_image(image) - Vision/OCR                            │
│                                                                  │
│  Mémoire:                                                        │
│  • Conversation history (avec summarization L1)                  │
│  • Tool call summaries                                           │
│  • Project knowledge graph                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
   Streaming Response
```

---

## 2. Architecture Data: Prisma + Neo4j Dual Database

### Décision Architecturale

> **IMPORTANT**: Les projets sont gérés en **Prisma (PostgreSQL)**, pas en Neo4j.
> Neo4j stocke le knowledge graph avec `projectId` comme attribut sur tous les nodes.

Cette approche permet de:
- Utiliser les libs officielles Prisma pour l'auth et les metadata
- Garder Neo4j focalisé sur le knowledge graph
- Éviter la duplication de données entre les deux DBs

### Schéma Dual Database

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PRISMA (PostgreSQL)                                  │
│                         Source of truth pour auth, metadata, relations       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  model Project {                                                     │    │
│  │    id             String           @id @default(cuid())              │    │
│  │    name           String                                             │    │
│  │    description    String?                                            │    │
│  │    categoryId     String                                             │    │
│  │    ownerId        String                                             │    │
│  │    searchReady    SearchCapability @default(NONE)                    │    │
│  │    fileCount      Int              @default(0)                       │    │
│  │    scopeCount     Int              @default(0)                       │    │
│  │    embeddingCount Int              @default(0)                       │    │
│  │    embeddingProgress Json?                                           │    │
│  │    createdAt      DateTime         @default(now())                   │    │
│  │    updatedAt      DateTime         @updatedAt                        │    │
│  │  }                                                                   │    │
│  │                                                                      │    │
│  │  enum SearchCapability { NONE, BM25, HYBRID, FULL }                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Project.id ──────────────────────────────────────────────────────────────┐ │
│                                                                            │ │
└────────────────────────────────────────────────────────────────────────────┼─┘
                                                                             │
                              projectId attribute                            │
                                                                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NEO4J (Knowledge Graph)                            │
│                           Tous les nodes ont projectId                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  (:File {                                                                    │
│    uuid: "file-xxx",                                                         │
│    projectId: "clxxx...",        ← Prisma Project.id                        │
│    documentId: "doc-xxx",        ← Optionnel, pour traçabilité source       │
│    file: "/virtual/proj-xxx/src/auth.ts",                                   │
│    _rawContent: "export function...",                                       │
│    _state: "embedded",                                                       │
│  })                                                                          │
│                                                                              │
│  (:Scope {                                                                   │
│    uuid: "scope-xxx",                                                        │
│    projectId: "clxxx...",        ← Même projectId                           │
│    name: "authenticateUser",                                                 │
│    type: "function",                                                         │
│  })                                                                          │
│                                                                              │
│  (:Entity {                                                                  │
│    uuid: "entity-xxx",                                                       │
│    projectId: "clxxx...",        ← Même projectId                           │
│    name: "JWT",                                                              │
│    type: "technology",                                                       │
│  })                                                                          │
│                                                                              │
│  (:Project {                                                                 │
│    projectId: "clxxx...",        ← Prisma Project.id                        │
│    rootPath: "/virtual/clxxx...",                                           │
│    type: "external",             ← Type pour projets Community-Docs         │
│    contentSourceType: "virtual", ← Fichiers stockés dans Neo4j              │
│  })                                                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pourquoi cette approche ?

| Aspect | Prisma | Neo4j |
|--------|--------|-------|
| **Auth** | ✅ User, Session, etc. | ❌ |
| **Relations simples** | ✅ FK classiques | Overkill |
| **Knowledge graph** | ❌ Pas adapté | ✅ Optimisé |
| **Queries complexes** | Joins SQL | ✅ Cypher traversals |
| **ORM/Type-safety** | ✅ Prisma Client | ❌ Queries manuelles |

### Création de Projet: Flow Dual Database

```
POST /api/projects (Next.js)
     │
     ├─► 1. Créer Project en Prisma (PostgreSQL)
     │      → id: "clxxx..." (cuid généré par Prisma)
     │
     └─► 2. Créer node :Project en Neo4j (Cypher direct, pas BrainManager)
            → projectId: "clxxx..." (même ID que Prisma)
            → rootPath: "/virtual/clxxx..."
            → type: "external"
            → contentSourceType: "virtual"

MERGE (p:Project {projectId: $projectId})
SET p.rootPath = '/virtual/' + $projectId,
    p.type = 'external',
    p.contentSourceType = 'virtual',
    p.createdAt = datetime()
```

**Important**:
- Le `projectId` en Neo4j = `Project.id` en Prisma. **Pas de transformation.**
- Community-docs utilise **Cypher direct** pour créer le node :Project (pas BrainManager)
- Puis utilise `UnifiedProcessor` directement avec ce projectId

Un projet peut contenir plusieurs documents/sources:
- GitHub repos
- ZIP uploads
- Single file uploads
- Web pages crawlées

Chaque source peut avoir un `documentId` optionnel pour la traçabilité.

### CommunityNodeMetadata

```typescript
// lib/ragforge/types.ts
export interface CommunityNodeMetadata {
  // Project identity (required - Prisma Project.id)
  projectId: string;

  // Document/Source identity (optional - for source tracking)
  documentId?: string;
  documentTitle: string;

  // User filtering
  userId: string;
  userUsername?: string;

  // Category filtering
  categoryId: string;
  categorySlug: string;
  categoryName?: string;

  // Permissions
  isPublic?: boolean;

  // Tags (future)
  tags?: string[];

  // Media files
  mediaType?: "image" | "pdf" | "3d";
  originalFile?: string;
  renderedViews?: string[];
}
```

---

## 3. API Design

### Project Management (IMPLÉMENTÉ)

```typescript
// ============================================
// POST /api/projects - Créer un projet ✅
// ============================================
// Fichier: app/api/projects/route.ts
Request:
{
  name: "Mon Projet RAG",
  description?: "Description optionnelle",
  categoryId: "cat-xxx"
}

Response:
{
  id: "clxxx...",
  name: "Mon Projet RAG",
  description: "...",
  searchReady: "NONE",
  createdAt: "2026-01-18T..."
}

// ============================================
// GET /api/projects - Lister les projets ✅
// ============================================
Query params: ?categoryId=cat-xxx&page=1&limit=20

Response:
{
  projects: [
    { id: "clxxx...", name: "...", fileCount: 245, searchReady: "FULL", ... }
  ],
  total: 5,
  page: 1,
  limit: 20
}

// ============================================
// GET /api/projects/:id - Détails projet ✅
// ============================================
Response:
{
  id: "clxxx...",
  name: "Mon Projet RAG",
  description: "...",
  searchReady: "HYBRID",
  fileCount: 245,
  scopeCount: 1203,
  embeddingCount: 800,
  embeddingProgress: { done: 800, total: 1203 },
  documents: [
    { id: "doc-1", title: "spec.pdf", type: "PDF", ... }
  ],
  owner: { id: "...", username: "..." },
  category: { id: "...", name: "...", slug: "..." }
}

// ============================================
// PATCH /api/projects/:id - Mettre à jour ✅
// ============================================
Request:
{
  name?: "Nouveau nom",
  description?: "Nouvelle description",
  categoryId?: "new-cat-xxx"
}

// ============================================
// DELETE /api/projects/:id - Supprimer ✅
// ============================================
// Supprime le projet Prisma + tous les nodes Neo4j avec ce projectId
Response:
{
  success: true,
  deletedNodes: 1448  // Nodes Neo4j supprimés
}
```

### Ingestion (IMPLÉMENTÉ - project-scoped à venir)

```typescript
// ============================================
// POST /ingest/file - Ingérer un fichier ✅
// ============================================
// Fichier: lib/ragforge/api/server.ts
Request:
{
  filePath: "document.pdf",
  content: "base64...",  // Optionnel
  metadata: {
    projectId: "clxxx...",      // ← REQUIRED
    documentId?: "doc-xxx",     // ← Optional
    documentTitle: "My Document",
    userId: "user-xxx",
    categoryId: "cat-xxx",
    categorySlug: "typescript"
  },
  generateEmbeddings?: true,
  enableVision?: false,
  sectionTitles?: "detect"
}

// ============================================
// POST /ingest/batch - Ingérer plusieurs fichiers ✅
// ============================================
Request:
{
  files: [
    { filePath: "src/auth.ts", content: "base64..." },
    { filePath: "src/utils.ts", content: "base64..." }
  ],
  metadata: {
    projectId: "clxxx...",
    documentTitle: "Source Code",
    ...
  },
  generateEmbeddings?: true
}

// ============================================
// POST /ingest/github - Ingérer repo GitHub (SSE) ✅
// ============================================
Request:
{
  githubUrl: "https://github.com/user/repo",
  metadata: {
    projectId: "clxxx...",
    documentTitle: "user/repo",
    ...
  },
  branch?: "main",
  maxFiles?: 2000
}

Response (SSE stream):
data: {"type": "progress", "phase": "cloning", "message": "Cloning repository..."}
data: {"type": "progress", "phase": "scanning", "files": 245}
data: {"type": "progress", "phase": "parsing", "current": 50, "total": 245}
data: {"type": "progress", "phase": "embedding", "current": 100, "total": 245}
data: {"type": "complete", "documentId": "doc-xxx", "filesIngested": 245}
```

### Search (À FAIRE - project-scoped)

```typescript
// ============================================
// POST /api/projects/:projectId/search - À IMPLÉMENTER
// ============================================
Request:
{
  query: "authentication flow",
  semantic?: true,
  limit?: 20,
  types?: ["function", "class"],
  glob?: "**/*.ts"
}

Response:
{
  success: true,
  results: [...],
  searchMode: "hybrid",  // ou "bm25" si embeddings pas prêts
  capabilities: {
    bm25: true,
    semantic: true,
    hybrid: true
  }
}
```

---

## 4. Intégration Lucie Agent

### Lucie Agent sur Community-Docs

Lucie Agent (Python/LangGraph) peut être déployé comme agent de chat pour community-docs, avec accès aux projets:

```python
# config.py
class Settings:
    community_docs_api: str = "http://localhost:3001/api"
    default_project_id: str | None = None  # Set par session

# tools.py
@tool
async def search_knowledge(
    query: str,
    limit: int = 5,
) -> str:
    """
    Search through the current project's knowledge base.
    The projectId is automatically injected from the conversation context.
    """
    project_id = get_current_project_id()  # From conversation state

    response = await client.post(
        f"/projects/{project_id}/search",
        json={
            "query": query,
            "limit": limit,
            "semantic": True,
            "format": "markdown"
        }
    )
    return response.json().get("formattedOutput", "No results")

@tool
async def ingest_github_repo(
    url: str,
    branch: str = "main",
) -> str:
    """
    Ingest a GitHub repository into the current project.
    """
    project_id = get_current_project_id()

    response = await client.post(
        f"/projects/{project_id}/ingest/github",
        json={"url": url, "branch": branch}
    )
    return f"Repository indexed: {url}"
```

### Flow Conversation avec Projet

```
1. User ouvre Community-Docs
2. User crée/sélectionne un projet
3. Conversation est automatiquement liée au projet
4. Agent tools reçoivent projectId implicitement
5. Toutes les recherches sont scopées au projet
```

---

## 5. RagForge-Core: Support Virtual Projects

### IFileStateMachine Abstraction (À IMPLÉMENTER)

Pour supporter les projets virtuels (sans fichiers sur disque), on abstrait FileStateMachine:

```typescript
// ============================================
// Interface commune
// ============================================
export interface IFileStateMachine {
  getFilesInState(projectId: string, state: FileState): Promise<FileStateInfo[]>;
  getStateStats(projectId: string): Promise<Record<FileState, number>>;
  getProgress(projectId: string): Promise<ProgressInfo>;

  transition(uuid: string, newState: FileState): Promise<void>;
  transitionBatch(uuids: string[], newState: FileState): Promise<void>;

  // Différent selon mode disk/virtual
  checkFileExists(path: string): Promise<boolean>;
  getFileContent(path: string): Promise<string | null>;
  getFileHash(path: string): Promise<string | null>;
}

// ============================================
// Implémentation DISK (actuelle)
// ============================================
export class DiskFileStateMachine extends BaseFileStateMachine {
  async checkFileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async getFileContent(path: string): Promise<string | null> {
    return await fs.readFile(path, 'utf-8');
  }

  async getFileHash(path: string): Promise<string | null> {
    const content = await this.getFileContent(path);
    return content ? computeHash(content) : null;
  }
}

// ============================================
// Implémentation VIRTUAL (à créer)
// ============================================
export class VirtualFileStateMachine extends BaseFileStateMachine {
  async checkFileExists(path: string): Promise<boolean> {
    const result = await this.neo4j.run(`
      MATCH (f:File {absolutePath: $path})
      WHERE f._rawContent IS NOT NULL
      RETURN count(f) > 0 as exists
    `, { path });
    return result.records[0]?.get('exists') ?? false;
  }

  async getFileContent(path: string): Promise<string | null> {
    const result = await this.neo4j.run(`
      MATCH (f:File {absolutePath: $path})
      RETURN f._rawContent as content
    `, { path });
    return result.records[0]?.get('content') ?? null;
  }

  async getFileHash(path: string): Promise<string | null> {
    const result = await this.neo4j.run(`
      MATCH (f:File {absolutePath: $path})
      RETURN f._rawContentHash as hash
    `, { path });
    return result.records[0]?.get('hash') ?? null;
  }
}
```

---

## 6. Search Progressive: BM25 → Embeddings

### Problème

Actuellement, la recherche attend que **tous les embeddings** soient générés avant d'être disponible. Sur un gros projet (1000+ fichiers), ça peut prendre plusieurs minutes. **Mauvaise UX.**

### Solution: Search Progressive

La recherche doit être disponible **immédiatement** après le parsing, même sans embeddings:

```
Ingestion Timeline:
══════════════════════════════════════════════════════════════════════►
│              │                 │                    │
│   parsing    │    linking      │    embedding       │
│    done      │     done        │      done          │
│              │                 │                    │
▼              ▼                 ▼                    ▼
┌──────────┐   ┌─────────────┐   ┌────────────────┐   ┌─────────────┐
│  BM25    │   │ BM25 +      │   │ BM25 +         │   │ Full hybrid │
│  only    │   │ relations   │   │ partial embed  │   │ search      │
└──────────┘   └─────────────┘   └────────────────┘   └─────────────┘

User peut chercher ici!     Agent notifié ici!
```

### Tracking sur le Project (Prisma)

```typescript
// prisma/schema.prisma
model Project {
  // ...
  searchReady       SearchCapability @default(NONE)
  embeddingProgress Json?  // { done: 150, total: 245, percentage: 61 }
}

enum SearchCapability {
  NONE    // Pas encore de contenu
  BM25    // Parsing done, text search available
  HYBRID  // Embeddings en cours, partial semantic
  FULL    // Tous embeddings générés
}
```

### Search API Behavior

```typescript
// POST /api/projects/:id/search
Request:
{
  query: "authentication",
  semantic: true,
  waitForEmbeddings: false  // Default: ne pas bloquer
}

Response (si embeddings pas prêts):
{
  success: true,
  results: [...],
  searchMode: "bm25",
  warning: "Semantic search not yet available (61% embeddings)",
  embeddingProgress: { done: 150, total: 245 },
  capabilities: {
    bm25: true,
    semantic: false,
    hybrid: false
  }
}

Response (quand embeddings prêts):
{
  success: true,
  results: [...],
  searchMode: "hybrid",
  capabilities: {
    bm25: true,
    semantic: true,
    hybrid: true
  }
}
```

---

## 7. Fichiers Clés Modifiés

### Community-Docs

| Fichier | Description |
|---------|-------------|
| `prisma/schema.prisma` | Model `Project` + enum `SearchCapability` |
| `app/api/projects/route.ts` | GET (list) + POST (create) |
| `app/api/projects/[id]/route.ts` | GET + PATCH + DELETE |
| `lib/ragforge/types.ts` | `CommunityNodeMetadata` avec `projectId` required |
| `lib/ragforge/orchestrator-adapter.ts` | `generateEmbeddingsForProject()`, `deleteProjectNodes()` |
| `lib/ragforge/api-client.ts` | `deleteProject()`, `buildNodeMetadata()` updated |
| `lib/ragforge/api/server.ts` | DELETE `/project/:projectId` route |
| `lib/ragforge/neo4j-client.ts` | `deleteProject()` method |
| `lib/ragforge/agent/tools.ts` | `ToolContext.projectId`, metadata avec projectId |
| `lib/ragforge/ingestion-service.ts` | Utilise `generateEmbeddingsForProject()` |
| `app/api/ingest/upload/route.ts` | Inclut `projectId` dans document |

---

## 8. Résumé

### Ce qui est FAIT

1. **Project model Prisma** - CRUD complet avec API routes
2. **`projectId` sur metadata** - `CommunityNodeMetadata` updated
3. **Delete cascade** - Project → Neo4j nodes avec `projectId`
4. **Méthodes renommées** - `generateEmbeddingsForDocument` → `generateEmbeddingsForProject`
5. **SearchCapability enum** - Tracking du niveau de recherche disponible

### Ce qui reste À FAIRE

1. **Search project-scoped** - `/api/projects/:id/search`
2. **Chat project-scoped** - `/api/projects/:id/chat`
3. **Progress tracking** - Mise à jour de `embeddingProgress` en temps réel
4. **UI Project selector** - Dropdown pour changer de projet
5. **Virtual projects** - `VirtualFileStateMachine` dans ragforge-core

### Bénéfices

- **UX simplifiée** - Une seule interface pour tout
- **Contexte unifié** - L'agent a accès à tout le projet
- **Multi-source** - GitHub, docs, images, web dans un même projet
- **Scalable** - Supporte Neo4j Aura (cloud) sans filesystem local
- **Type-safe** - Prisma pour metadata, bon tooling
