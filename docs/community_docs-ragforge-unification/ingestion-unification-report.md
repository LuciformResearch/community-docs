# Rapport d'Unification: Ingestion Community-Docs ↔ RagForge-Core

**Date**: 2026-01-18
**Objectif**: Analyser l'état actuel et les actions nécessaires pour unifier les pipelines d'ingestion.
**Dernière mise à jour**: 2026-01-18

---

## 0. Changements Récents (2026-01-18)

### Architecture Décidée: Prisma + Neo4j Dual Database

- **Projects** gérés en **Prisma** (PostgreSQL), pas en Neo4j
- **Neo4j** stocke le knowledge graph avec `projectId` comme attribut sur tous les nodes
- **`projectId`** est maintenant **required** dans `CommunityNodeMetadata`
- **`documentId`** est maintenant **optionnel** (pour traçabilité source uniquement)

### Modifications Implémentées

| Fichier | Changement |
|---------|------------|
| `prisma/schema.prisma` | Ajout model `Project` + enum `SearchCapability` |
| `lib/ragforge/types.ts` | `projectId: string` required, `documentId?: string` optional |
| `lib/ragforge/orchestrator-adapter.ts` | Méthode renommée: `generateEmbeddingsForProject()` |
| `lib/ragforge/orchestrator-adapter.ts` | Suppression du pattern `doc-${documentId}` |
| `lib/ragforge/api-client.ts` | Ajout `deleteProject()`, update `buildNodeMetadata()` |
| `lib/ragforge/api/server.ts` | Route `DELETE /project/:projectId` |
| `lib/ragforge/neo4j-client.ts` | Méthode `deleteProject(projectId)` |
| `app/api/projects/*` | CRUD routes pour Project |

---

## 1. GitHub Ingestion

### État Actuel

| Composant | Emplacement | Status |
|-----------|-------------|--------|
| **Documentation/Plan** | `packages/ragforge-core/docs/features/github-ingestion.md` | ✅ Complet |
| **MCP Tool `ingest_github`** | `packages/ragforge-core/src/tools/brain-tools.ts` | ❌ **NON IMPLÉMENTÉ** |
| **Community API Endpoint** | `lib/ragforge/api/server.ts:782` (`POST /ingest/github`) | ✅ **IMPLÉMENTÉ** |
| **Clone Function** | `lib/ragforge/api/server.ts:82-113` (`cloneGitHubRepo`) | ✅ Existe |

### Flow Actuel dans Community-Docs (MISE À JOUR)

```
POST /ingest/github
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  1. CLONE: cloneGitHubRepo(url, branch, includeSubmodules)               │
│     - git clone --depth 1 --branch {branch} --recurse-submodules         │
│     - Crée dossier temporaire: /tmp/github-ingest-{random}/              │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  2. SCAN: getCodeFilesFromDir(repoDir, CODE_EXTENSIONS)                  │
│     - Filtre par extensions supportées (.ts, .js, .py, etc.)             │
│     - Skip hidden dirs et node_modules                                   │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  3. READ: Lit tous les fichiers en mémoire                               │
│     - virtualFiles: Array<{ path: string; content: string }>             │
│     - Max 2000 fichiers par défaut                                       │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  4. INGEST: orchestrator.ingestVirtual({ virtualFiles, metadata })       │
│     - metadata.projectId est utilisé directement (plus de doc-${...})    │
│     - Préfixe les paths: /virtual/{projectId}/{sourceIdentifier}/        │
│     - sourceAdapter.parse({ source: { type: 'virtual', virtualFiles }})  │
│     - Injecte metadata community sur chaque node                         │
│     - ingestionManager.ingestGraph() → Neo4j                             │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  5. EMBED: orchestrator.generateEmbeddingsForProject(projectId)          │
│     ← RENOMMÉ de generateEmbeddingsForDocument                           │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  6. CLEANUP: fs.rm(tempDir, { recursive: true })                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Points clés:**
- Utilise SSE (Server-Sent Events) pour streaming des progress
- Fichiers chargés **en mémoire** (virtualFiles), pas de tracking disque
- `metadata.projectId` est utilisé directement sur tous les nodes Neo4j
- Plus de transformation `doc-${documentId}` → utilise `projectId` directement

### Gap: Virtual Files vs Disk Pipeline

| Aspect | Community-Docs (ingestVirtual) | RagForge-Core (UnifiedProcessor) |
|--------|-------------------------------|----------------------------------|
| **Source** | Fichiers en mémoire | Fichiers sur disque |
| **State tracking** | Aucun | FileStateMachine |
| **Incremental** | Non | Oui (hash checking) |
| **Entity extraction** | Séparé | Intégré |
| **Embeddings** | Séparé | Intégré |
| **projectId** | ✅ Direct | À adapter |

### Architecture Cible: Support Fichiers Virtuels

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         UnifiedProcessor                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────┐    ┌─────────────────────────────────────┐     │
│  │   Mode DISK (actuel)    │    │   Mode VIRTUAL (à implémenter)      │     │
│  │                         │    │                                     │     │
│  │ - FileStateMachine      │    │ - VirtualFileStateMachine           │     │
│  │ - Track fichiers disque │    │ - Track fichiers en DB uniquement   │     │
│  │ - Détecte suppressions  │    │ - Pas de check disque               │     │
│  │ - Hash basé sur fs.read │    │ - Hash basé sur _rawContent         │     │
│  └─────────────────────────┘    └─────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Pipeline Commun                                   │    │
│  │  discovered → parsing → linked → entities → embedding → ready       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Virtual Files et `_rawContent`

### État Actuel

| Composant | Status | Notes |
|-----------|--------|-------|
| **Interface `VirtualFile`** | ✅ | `packages/ragforge-core/src/runtime/adapters/types.ts:18-42` |
| **`_rawContent` sur File nodes** | ✅ | Implémenté dans `code-source-adapter.ts` |
| **`getRawContentProp()` helper** | ✅ | `packages/ragforge-core/src/ingestion/parser-types.ts:588-590` |
| **`MAX_RAW_CONTENT_SIZE`** | ✅ | 100KB limit défini |

### Types de fichiers avec `_rawContent`

| Type | `_rawContent` | Notes |
|------|---------------|-------|
| TypeScript/JavaScript | ✅ | Source code |
| Python | ✅ | Source code |
| Vue/Svelte | ✅ | Source code |
| CSS/SCSS | ✅ | Source code |
| Markdown | ✅ | Raw text |
| JSON/YAML | ✅ | Raw content |
| PDF/DOCX | ✅ | **Extracted text** (pas le binaire) |
| Images | ❌ | Binaire, pas de `_rawContent` |
| Audio/Video | ❌ | Binaire, pas de `_rawContent` |
| 3D Models (.glb) | ❌ | Binaire, pas de `_rawContent` |

**Verdict**: `_rawContent` est correctement implémenté pour les fichiers texte/code.

---

## 3. Délégation Complète vers RagForge-Core

### Architecture Actuelle (MISE À JOUR)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           COMMUNITY-DOCS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    PRISMA (PostgreSQL)                             │  │
│  │  • Project { id, name, searchReady, ... }                         │  │
│  │  • Document { id, projectId, title, ... }                         │  │
│  │  • User, Category, etc.                                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              │ projectId                                │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ CommunityOrchestratorAdapter                                       │  │
│  │ (lib/ragforge/orchestrator-adapter.ts)                             │  │
│  │                                                                    │  │
│  │ • ingest() - fichiers disque                                       │  │
│  │ • ingestVirtual() - fichiers mémoire                              │  │
│  │ • ingestFiles() - unifié (dispatch auto)                          │  │
│  │ • generateEmbeddingsForProject(projectId) ← RENOMMÉ               │  │
│  │ • deleteProjectNodes(projectId) ← NOUVEAU                         │  │
│  │                                                                    │  │
│  │ → Tous les nodes reçoivent metadata.projectId directement         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              │ DÉLÈGUE À                                │
│                              ▼                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                           RAGFORGE-CORE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              UniversalSourceAdapter                                │  │
│  │              (src/runtime/adapters/universal-source-adapter.ts)    │  │
│  │                                                                    │  │
│  │  • parse({ source: { type: 'files' | 'virtual', ... } })          │  │
│  │  • Dispatche vers CodeSourceAdapter, WebAdapter, etc.             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              CodeSourceAdapter                                     │  │
│  │              (src/runtime/adapters/code-source-adapter.ts)         │  │
│  │                                                                    │  │
│  │  • parseFiles() - gère virtualFiles nativement                    │  │
│  │  • Supporte: code, markdown, data, media, documents               │  │
│  │  • Ajoute _rawContent sur les File nodes                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Ce Qui Fonctionne Déjà

1. ✅ `CommunityOrchestratorAdapter.ingestVirtual()` → délègue à `UniversalSourceAdapter`
2. ✅ Virtual files supportés nativement par `CodeSourceAdapter.parseFiles()`
3. ✅ `metadata.projectId` propagé sur tous les nodes Neo4j
4. ✅ `generateEmbeddingsForProject(projectId)` utilise le projectId directement
5. ✅ `deleteProjectNodes(projectId)` pour supprimer tous les nodes d'un projet

### Ce Qui Doit Être Unifié

| Fonctionnalité | Community-Docs | RagForge-Core | Action |
|----------------|----------------|---------------|--------|
| Upload ZIP | `CommunityIngestionService` | ❌ Pas de support | Ajouter support ZIP dans core |
| GitHub Clone | `CommunityAPIServer` | ❌ Pas de support | Implémenter dans BrainManager |
| Metadata injection | `transformGraph` hook | ❌ Pas de mécanisme | Ajouter callback/hook |
| Project CRUD | ✅ Prisma | N/A | Déjà fait |

---

## 4. CommunityNodeMetadata (MISE À JOUR)

### Avant (OLD)

```typescript
interface CommunityNodeMetadata {
  documentId: string;  // ← Était required
  // projectId calculé comme doc-${documentId}
  ...
}
```

### Après (NEW)

```typescript
interface CommunityNodeMetadata {
  projectId: string;   // ← REQUIRED (Prisma Project.id)
  documentId?: string; // ← OPTIONAL (pour traçabilité source)
  documentTitle: string;
  userId: string;
  categoryId: string;
  categorySlug: string;
  // ...
}
```

### Impact sur le Code

| Fichier | Changement |
|---------|------------|
| `orchestrator-adapter.ts` | Plus de `doc-${documentId}`, utilise `metadata.projectId` |
| `api/server.ts` | Toutes les routes passent `projectId` dans metadata |
| `agent/tools.ts` | `ToolContext.projectId` utilisé pour les tools |
| `ingestion-service.ts` | `generateEmbeddingsForProject(metadata.projectId)` |
| `api-client.ts` | `buildNodeMetadata()` requiert `projectId` |

---

## 5. Résumé des Actions

### FAIT ✅

| # | Action | Fichier |
|---|--------|---------|
| 1 | Model `Project` Prisma | `prisma/schema.prisma` |
| 2 | CRUD `/api/projects` | `app/api/projects/*` |
| 3 | `projectId` required dans metadata | `lib/ragforge/types.ts` |
| 4 | Supprimer pattern `doc-${documentId}` | `lib/ragforge/orchestrator-adapter.ts` |
| 5 | Renommer `generateEmbeddingsForDocument` → `generateEmbeddingsForProject` | Multiple fichiers |
| 6 | `deleteProject(projectId)` | `neo4j-client.ts`, `api-client.ts`, `server.ts` |
| 7 | Route `DELETE /project/:projectId` | `lib/ragforge/api/server.ts` |

### À FAIRE - Priorité Haute

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 1 | Implémenter `ingest_github` MCP tool | `brain-tools.ts` | 2h |
| 2 | Implémenter `BrainManager.ingestGitHub()` | `brain-manager.ts` | 4h |
| 3 | Routes project-scoped: `/api/projects/:id/search` | `app/api/projects/[id]/search` | 3h |
| 4 | Routes project-scoped: `/api/projects/:id/chat` | `app/api/projects/[id]/chat` | 3h |

### À FAIRE - Priorité Moyenne

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 5 | Ajouter support ZIP dans core | `brain-manager.ts` | 4h |
| 6 | Progress tracking `embeddingProgress` | `orchestrator-adapter.ts` | 2h |
| 7 | UI Project selector | `components/` | 4h |

### À FAIRE - Priorité Basse (optionnel)

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 8 | Incremental GitHub sync | `brain-manager.ts` | 8h |
| 9 | `VirtualFileStateMachine` | `packages/ragforge-core` | 6h |
| 10 | Migration script pour projets existants | `scripts/` | 2h |

---

## 6. Références Code

### Fichiers Clés - Community-Docs

| Fichier | Description |
|---------|-------------|
| `prisma/schema.prisma` | Model `Project` + enum `SearchCapability` |
| `app/api/projects/route.ts` | CRUD list + create |
| `app/api/projects/[id]/route.ts` | CRUD get + update + delete |
| `lib/ragforge/types.ts` | `CommunityNodeMetadata` avec `projectId` required |
| `lib/ragforge/orchestrator-adapter.ts` | `generateEmbeddingsForProject()`, `deleteProjectNodes()` |
| `lib/ragforge/api-client.ts` | HTTP client, `deleteProject()` |
| `lib/ragforge/api/server.ts` | API server (port 6970), route delete |
| `lib/ragforge/neo4j-client.ts` | `deleteProject(projectId)` |
| `lib/ragforge/agent/tools.ts` | `ToolContext.projectId`, tools avec metadata |
| `lib/ragforge/ingestion-service.ts` | Service d'ingestion |

### Fichiers Clés - RagForge-Core

| Fichier | Description |
|---------|-------------|
| `src/tools/brain-tools.ts` | Tools MCP (GitHub à implémenter) |
| `src/brain/brain-manager.ts` | Orchestration principale |
| `src/runtime/adapters/universal-source-adapter.ts` | Dispatcher |
| `src/runtime/adapters/code-source-adapter.ts` | Parsing code + virtualFiles |
| `src/runtime/adapters/types.ts` | Interface `VirtualFile` |
| `src/ingestion/parser-types.ts` | `getRawContentProp`, `MAX_RAW_CONTENT_SIZE` |

---

## 7. Conclusion

**L'unification progresse bien:**

1. ✅ **Architecture Prisma + Neo4j** - Projects en Prisma, knowledge graph en Neo4j
2. ✅ **`projectId` comme identifiant principal** - Plus de transformation `doc-${documentId}`
3. ✅ **CRUD Projects complet** - API routes fonctionnelles
4. ✅ **Delete cascade** - Project → tous les nodes Neo4j
5. ✅ **Metadata cohérente** - `projectId` required partout

**Prochaines étapes:**

1. Routes project-scoped (`/api/projects/:id/search`, `/api/projects/:id/chat`)
2. GitHub ingestion dans ragforge-core MCP tools
3. Progress tracking pour les embeddings
4. UI Project selector
