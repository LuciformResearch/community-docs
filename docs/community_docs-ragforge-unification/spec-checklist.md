# Community-Docs + RagForge Unification - Spec Checklist

**Date**: 2026-01-18
**Statut**: En cours d'implémentation
**Dernière mise à jour**: 2026-01-18

---

## 1. Vision

Community-Docs = **Interface chat multimodale** avec agent RAG intelligent.

- L'utilisateur interagit principalement via chat
- Bouton "+" pour ajouter des sources (docs, images, GitHub, web)
- Tout est organisé par **Projet** (conteneur de sources + conversations)
- L'agent a accès à la knowledge base du projet en cours

---

## 2. Modèle Data: Projects

### Architecture Décidée: Prisma + Neo4j Dual Database

> **Décision**: Les projets sont gérés en **Prisma** (PostgreSQL), pas en Neo4j.
> Neo4j stocke uniquement le knowledge graph avec `projectId` comme attribut sur les nodes.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRISMA (PostgreSQL)                             │
│                                                                              │
│  Project ──────┬──────────── Document                                       │
│  - id          │             - id                                           │
│  - name        │             - projectId (FK)                               │
│  - description │             - title                                        │
│  - ownerId     │             - sourceType                                   │
│  - categoryId  │             - ...                                          │
│  - searchReady │                                                            │
│  - fileCount   │                                                            │
│  - scopeCount  │                                                            │
│  - embeddingCount                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ projectId
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NEO4J (Knowledge Graph)                         │
│                                                                              │
│  (:Project {projectId: "clxxx...", type: "external", ...})                  │
│  (:File {projectId: "clxxx...", ...})                                       │
│  (:Scope {projectId: "clxxx...", ...})                                      │
│  (:Entity {projectId: "clxxx...", ...})                                     │
│  (:MarkdownSection {projectId: "clxxx...", ...})                            │
│                                                                              │
│  → Node :Project créé en Neo4j avec projectId = Prisma Project.id           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Project Model (Prisma)

- [x] Créer model `Project` en Prisma (`prisma/schema.prisma`)
- [x] Propriétés: `id`, `name`, `description`, `categoryId`, `ownerId`
- [x] Enum `SearchCapability`: `NONE` | `BM25` | `HYBRID` | `FULL`
- [x] Stats dénormalisées: `fileCount`, `scopeCount`, `embeddingCount`, `embeddingProgress`
- [x] Timestamps: `createdAt`, `updatedAt`
- [x] Relations: `category`, `owner`, `documents`

### 2.2 CommunityNodeMetadata (Types)

- [x] Ajouter `projectId: string` (required) sur `CommunityNodeMetadata`
- [x] Rendre `documentId?: string` optionnel (pour traçabilité source)
- [x] Mettre à jour tous les appels pour inclure `projectId`

### 2.3 Files avec projectId

- [x] Tous les nodes Neo4j utilisent `projectId` directement (plus de transformation `doc-${documentId}`)
- [x] Méthode `generateEmbeddingsForProject(projectId)` au lieu de `generateEmbeddingsForDocument(documentId)`
- [x] Méthode `deleteProjectNodes(projectId)` pour supprimer tous les nodes d'un projet

### 2.4 Document Node (sources) - À FAIRE

- [ ] Ajouter `sourceType`: `github` | `zip` | `upload` | `web`
- [ ] Propriété `sourceUrl` pour GitHub/web
- [ ] Propriété `sourceCommit` pour sync incrémental GitHub

### 2.5 Conversation liée au projet - À FAIRE

- [ ] Ajouter `projectId` sur conversations (ChatConversation, LucieConversation)
- [ ] Filtrer conversations par projet dans l'UI

---

## 3. API Routes

### 3.1 Project CRUD

- [x] `POST /api/projects` - Créer projet
- [x] `GET /api/projects` - Lister projets (avec pagination, filtre category)
- [x] `GET /api/projects/:id` - Détails projet + documents
- [x] `PATCH /api/projects/:id` - Mettre à jour nom/description/category
- [x] `DELETE /api/projects/:id` - Supprimer projet + cascade Neo4j

### 3.2 Neo4j Delete Support

- [x] `DELETE /project/:projectId` sur Community API Server (port 6970)
- [x] `deleteProject(projectId)` dans `Neo4jClient`
- [x] `deleteProject(projectId)` dans `RagForgeAPIClient`

### 3.3 Ingestion scopée - EXISTANT (à migrer vers project-scoped)

- [x] `POST /ingest/file` - Inclut `projectId` dans metadata
- [x] `POST /ingest/batch` - Inclut `projectId` dans metadata
- [x] `POST /ingest/github` - SSE streaming avec projectId

### 3.4 Routes project-scoped - À FAIRE

- [ ] `POST /api/projects/:id/ingest/github` - Ingérer repo GitHub
- [ ] `POST /api/projects/:id/ingest/upload` - Upload fichiers (multipart)
- [ ] `POST /api/projects/:id/ingest/web` - Crawler URL
- [ ] `POST /api/projects/:id/search` - Recherche dans le projet
- [ ] `POST /api/projects/:id/chat` - Chat avec agent scopé

---

## 4. Search Progressive (BM25 → Embeddings)

### Problème

Attendre la fin des embeddings pour chercher = mauvaise UX.
L'ingestion peut prendre plusieurs minutes sur gros projets.

### Solution: Search progressive

```
Ingestion Timeline:
────────────────────────────────────────────────────────────►
│         │              │                │
│ parsing │   linking    │   embedding    │
│  done   │    done      │     done       │
│         │              │                │
▼         ▼              ▼                ▼
BM25      BM25 +         Full hybrid
only      relationships  search ready
```

### 4.1 Availability tracking (Prisma)

- [x] Enum `SearchCapability` sur `Project`: `NONE` | `BM25` | `HYBRID` | `FULL`
- [x] Champ `embeddingProgress: Json?` pour `{ done: 150, total: 245 }`
- [ ] Mettre à jour atomiquement après chaque batch d'embeddings

### 4.2 Search behavior - À FAIRE

- [ ] Si `searchReady = 'BM25'`: BM25 only, warning dans response
- [ ] Si `searchReady = 'HYBRID'`: BM25 + partial semantic
- [ ] Si `searchReady = 'FULL'`: Full hybrid search
- [ ] Inclure `searchCapability` dans response pour UI

### 4.3 Agent notification - À FAIRE

- [ ] WebSocket/SSE channel pour notifications projet
- [ ] Event `search_capability_changed` quand upgrade
- [ ] Agent peut adapter sa stratégie (BM25 first, semantic later)

### 4.4 Agent tool adaptation - À FAIRE

- [ ] Tool `search_knowledge` check capability avant appel
- [ ] Si `bm25` only: utiliser keywords extraction
- [ ] Si `hybrid`: utiliser semantic query
- [ ] Informer l'utilisateur du mode actuel

---

## 5. UI Chat Interface

### 5.1 Project selector - À FAIRE

- [ ] Dropdown/sidebar pour sélectionner projet actif
- [ ] Bouton "New Project" rapide
- [ ] Afficher stats projet (files, scopes, search capability)

### 5.2 Chat input avec attachments - À FAIRE

- [ ] Bouton "+" à gauche de l'input
- [ ] Menu popup avec options: Document, ZIP, Image, GitHub, Web Page, Web Search

### 5.3 Search capability indicator - À FAIRE

- [ ] Badge dans header: "BM25" | "Hybrid" | "Full"
- [ ] Tooltip avec progress embeddings
- [ ] Auto-update quand capability change

---

## 6. RagForge-Core: Virtual Projects

### 6.1 IFileStateMachine interface - À FAIRE

- [ ] Extraire interface `IFileStateMachine`
- [ ] Méthodes: `getFilesInState`, `transition`, `transitionBatch`
- [ ] Méthodes abstraites: `checkFileExists`, `getFileContent`, `getFileHash`

### 6.2 VirtualFileStateMachine - À FAIRE

- [ ] Nouvelle classe pour projets virtuels
- [ ] `checkFileExists`: query Neo4j `_rawContent IS NOT NULL`
- [ ] `getFileContent`: query Neo4j `_rawContent`
- [ ] `getFileHash`: query Neo4j `_rawContentHash`

### 6.3 UnifiedProcessor adaptation - À FAIRE

- [ ] Paramètre `projectType: 'disk' | 'virtual'`
- [ ] Sélection automatique de la state machine
- [ ] Pas de cleanup pour projets virtuels (fichiers persistent en DB)

---

## 7. Lucie Agent Integration

### 7.1 Project-scoped tools - PARTIELLEMENT FAIT

- [x] `ToolContext` inclut `projectId` optionnel
- [x] `ingest_document` tool utilise `projectId`
- [ ] `search_knowledge(query)` - projectId implicite
- [ ] `grep_code(pattern)` - projectId implicite
- [ ] `get_code_sample(file, line)` - projectId implicite

### 7.2 Conversation context - À FAIRE

- [ ] Stocker `projectId` dans conversation state
- [ ] Passer `projectId` à tous les tools automatiquement
- [ ] Agent aware du search capability actuel

---

## 8. Migration

### 8.1 Data migration - À FAIRE

- [ ] Script pour créer `Project` depuis `Document` existants
- [ ] Ajouter `projectId` aux nodes existants qui n'en ont pas
- [ ] Backfill `searchReady` sur projets

### 8.2 API backward compat - À FAIRE

- [ ] Garder anciennes routes fonctionnelles temporairement
- [ ] Deprecation warnings dans responses

---

## 9. Priorités

### P0 - MVP (EN COURS)

- [x] Project model Prisma + CRUD API
- [x] `projectId` sur metadata (CommunityNodeMetadata)
- [x] Renommage `generateEmbeddingsForDocument` → `generateEmbeddingsForProject`
- [x] Delete cascade project → Neo4j
- [ ] Search scopée au projet
- [ ] Chat scopé au projet

### P1 - Search Progressive

- [x] `SearchCapability` enum
- [ ] Tracking progress embeddings
- [ ] BM25 immédiat sans attente
- [ ] Notification capability change

### P2 - UI Chat

- [ ] Project selector
- [ ] Bouton "+" avec menu
- [ ] Attachment upload flow

### P3 - Virtual Projects (RagForge-Core)

- [ ] IFileStateMachine abstraction
- [ ] VirtualFileStateMachine
- [ ] UnifiedProcessor virtual mode

---

## 10. Non-Goals (hors scope initial)

- [ ] Incremental GitHub sync (git fetch + diff)
- [ ] Real-time collaboration multi-user
- [ ] Project sharing/permissions granulaires
- [ ] Billing/usage tracking
