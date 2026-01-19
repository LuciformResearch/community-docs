# Implementation: Community Ingestion in RagForge Core

**Date**: 2026-01-18
**Status**: En cours d'implémentation

---

## Analyse Initiale

L'analyse montre que:
- FileStateMachine est déjà basé sur Neo4j (pas de dépendance disque)
- La dépendance disque est dans FileProcessor (fs.readFile())
- Il suffit d'abstraire la lecture de contenu, pas toute la state machine

---

## 1. Architecture Cible

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UnifiedProcessor                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Config: {                                                                   │
│    contentSourceType: 'disk' | 'virtual',                                   │
│    contentProvider?: IContentProvider,  // Auto-créé selon contentSourceType │
│  }                                                                           │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     FileStateMachine                                 │    │
│  │                     (INCHANGÉ - déjà Neo4j-based)                    │    │
│  │                                                                      │    │
│  │  States: discovered → parsing → parsed → linked → entities →        │    │
│  │          embedding → embedded                                        │    │
│  │                                                                      │    │
│  │  Modification mineure: getFilesInState() inclut fichiers virtuels   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     FileProcessor                                    │    │
│  │                                                                      │    │
│  │  AVANT: await fs.readFile(file.absolutePath, 'utf-8')               │    │
│  │  APRÈS: await this.contentProvider.readContent(file)                │    │
│  │                                                                      │    │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────┐     │    │
│  │  │ DiskContentProvider │    │ VirtualContentProvider          │     │    │
│  │  │ (fichiers disque)   │    │ (fichiers Neo4j _rawContent)    │     │    │
│  │  │                     │    │                                 │     │    │
│  │  │ fs.readFile(path)   │    │ neo4j.query(_rawContent)        │     │    │
│  │  │ fs.access(path)     │    │ neo4j.query(exists)             │     │    │
│  │  └─────────────────────┘    └─────────────────────────────────┘     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Séparation des Responsabilités

**Important**: Le téléchargement GitHub et le parsing sont deux responsabilités distinctes.

```
TÉLÉCHARGEMENT (fetch)              PARSING (analyse)
──────────────────────              ─────────────────
downloadGitHubRepo()         →      CodeSourceAdapter
downloadZip()                →      (parse TS, Python, etc.)
fs.readFile()                →
                                    ↓
                               ParsedGraph (nodes, rels)
```

- **`downloadGitHubRepo()`** : Utility pour télécharger repos GitHub, retourne `VirtualFile[]`
- **`extractZipToVirtualFiles()`** : Utility pour extraire ZIP, retourne `VirtualFile[]`
- **`createVirtualFileFromContent()`** : Utility pour créer un VirtualFile depuis un buffer
- **`UniversalSourceAdapter`** : Parse du contenu en graph (reste inchangé)
- **`UnifiedProcessor.ingestVirtualFiles()`** : Orchestre l'ingestion de fichiers virtuels

---

## 3. Fichiers Créés/Modifiés (ragforge-core)

### 3.1 `src/brain/content-provider.ts` ✅ CRÉÉ

```typescript
export interface ContentFileInfo {
  uuid: string;
  absolutePath?: string;  // Optionnel pour fichiers virtuels
  projectId?: string;
  state?: FileState;
  isVirtual?: boolean;
}

export interface IContentProvider {
  readContent(file: ContentFileInfo): Promise<string>;
  readContentWithHash(file: ContentFileInfo): Promise<ContentReadResult>;
  exists(file: ContentFileInfo): Promise<boolean>;
  computeHash(file: ContentFileInfo): Promise<string>;
  getStoredHash(file: ContentFileInfo): Promise<string | null>;
  readContentBatch(files: ContentFileInfo[]): Promise<BatchContentResult>;
  readonly type: 'disk' | 'virtual';
}

export class DiskContentProvider implements IContentProvider { ... }
export class VirtualContentProvider implements IContentProvider { ... }
export class HybridContentProvider implements IContentProvider { ... }

export function createContentProvider(
  type: ContentSourceType,
  neo4jClient: Neo4jClient,
  projectId?: string
): IContentProvider;
```

### 3.2 `src/brain/file-processor.ts` ✅ MODIFIÉ

```typescript
export interface FileProcessorConfig {
  // ... existing config ...
  contentProvider?: IContentProvider;
  contentSourceType?: ContentSourceType;
}

// Utilise this.contentProvider.readContent() au lieu de fs.readFile()
```

### 3.3 `src/brain/file-state-machine.ts` ✅ MODIFIÉ

```typescript
// getFilesInState() accepte fichiers virtuels
WHERE f._state IN $states
  AND (f.absolutePath IS NOT NULL OR f._rawContent IS NOT NULL)
RETURN ..., f._rawContent IS NOT NULL as isVirtual
```

### 3.4 `src/ingestion/unified-processor.ts` ✅ MODIFIÉ

```typescript
export interface UnifiedProcessorConfig {
  // ... existing ...
  contentSourceType?: ContentSourceType;  // 'disk' | 'virtual'
  contentProvider?: IContentProvider;
}

// Auto-crée le bon provider selon contentSourceType
```

### 3.5 `src/brain/brain-manager.ts` ✅ MODIFIÉ

```typescript
export interface RegisteredProject {
  // ... existing ...
  contentSourceType?: ContentSourceType;  // Persisté dans Neo4j
}

// registerProject() accepte contentSourceType
// updateProjectMetadataInDb() persiste contentSourceType
// listProjectsFromDb() retourne contentSourceType
```

### 3.6 `src/runtime/adapters/github-source.ts` ✅ CRÉÉ

```typescript
export interface GitHubRepoRef {
  owner: string;
  repo: string;
  ref?: string;  // branch, tag, ou commit
}

export interface GitHubDownloadOptions {
  token?: string;              // Pour repos privés
  include?: string[];          // Patterns à inclure
  exclude?: string[];          // Patterns à exclure
  maxFileSize?: number;        // Default: 10MB
  method?: 'api' | 'git';      // ZIP API ou git clone
  includeSubmodules?: boolean; // Default: true
}

export interface GitHubDownloadResult {
  files: VirtualFile[];
  metadata: { owner, repo, ref, totalFiles, totalSize, downloadTimeMs };
  warnings: string[];
}

// Fonctions exportées
export function parseGitHubUrl(url: string): GitHubRepoRef;
export async function downloadGitHubRepo(
  urlOrRef: string | GitHubRepoRef,
  options?: GitHubDownloadOptions
): Promise<GitHubDownloadResult>;
export async function validateGitHubUrl(
  urlOrRef: string | GitHubRepoRef,
  token?: string
): Promise<{ valid: boolean; error?: string; metadata?: GitHubRepoRef }>;
```

### 3.7 `src/runtime/adapters/zip-source.ts` ✅ CRÉÉ

```typescript
export interface ZipExtractOptions {
  exclude?: string[];        // Patterns à exclure
  include?: string[];        // Patterns à inclure
  maxFileSize?: number;      // Default: 10MB
  stripRootDir?: boolean;    // Default: true
}

export interface ZipExtractResult {
  files: VirtualFile[];
  metadata: { totalFiles, totalSize, rootDir? };
  warnings: string[];
}

// Fonctions exportées
export async function extractZipToVirtualFiles(
  zipBuffer: Buffer,
  options?: ZipExtractOptions
): Promise<ZipExtractResult>;

export function createVirtualFileFromContent(
  content: Buffer | string,
  fileName: string,
  metadata?: Record<string, unknown>
): VirtualFile;

export function createVirtualFilesFromUploads(
  files: Array<{ fileName: string; content: Buffer | string }>
): VirtualFile[];
```

---

## 4. À Implémenter

### 4.1 `UnifiedProcessor.ingestVirtualFiles()` ✅ IMPLÉMENTÉ

```typescript
// Dans unified-processor.ts
async ingestVirtualFiles(
  files: VirtualFile[],
  options?: {
    skipProcessing?: boolean;  // Skip processing, only create File nodes
    stripPrefix?: string;      // Root path prefix to strip
  }
): Promise<ProcessingStats> {
  // 1. Créer les File nodes avec _rawContent (batch optimisé)
  const createdCount = await this.createVirtualFileNodes(files, options?.stripPrefix);

  // 2. Si skipProcessing, retourner sans traiter
  if (options?.skipProcessing) {
    return { filesProcessed: createdCount, ... };
  }

  // 3. Lancer le pipeline normal (discovered → embedded)
  // VirtualContentProvider lira depuis Neo4j _rawContent
  return this.processDiscovered();
}
```

**Caractéristiques:**
- Batch optimisé (une seule query Neo4j pour tous les fichiers)
- UUID déterministe basé sur `projectId + path`
- Détection de changement via `_rawContentHash`
- Support des fichiers binaires (Buffer → string)

### 4.2 Simplifier Community-Docs ⏳ TODO

**Flow Simplifié**: Community-docs utilise directement `UnifiedProcessor` (pas BrainManager).

Le `projectId` est le **Prisma Project.id** directement - pas de transformation.

```typescript
// Dans community-docs/lib/ragforge/orchestrator-adapter.ts

class CommunityOrchestratorAdapter {
  /**
   * Créer le node :Project en Neo4j (après création Prisma)
   */
  async createProjectInNeo4j(projectId: string): Promise<void> {
    await this.neo4jClient.run(`
      MERGE (p:Project {projectId: $projectId})
      SET p.rootPath = '/virtual/' + $projectId,
          p.type = 'external',
          p.contentSourceType = 'virtual',
          p.createdAt = datetime()
    `, { projectId });
  }

  /**
   * Ingérer un repo GitHub
   */
  async ingestGitHub(
    url: string,
    projectId: string,
    metadata: CommunityNodeMetadata
  ): Promise<ProcessingStats> {
    // 1. Télécharger
    const { files } = await downloadGitHubRepo(url, {
      method: 'git',
      includeSubmodules: true,
    });

    // 2. Créer processor (mode virtual)
    const processor = new UnifiedProcessor({
      driver: this.driver,
      neo4jClient: this.neo4jClient,
      projectId,  // ← Prisma Project.id directement
      contentSourceType: 'virtual',
    });

    // 3. Ingérer avec metadata
    return processor.ingestVirtualFiles(files, {
      additionalProperties: {
        userId: metadata.userId,
        categoryId: metadata.categoryId,
        documentId: metadata.documentId,  // optionnel, traçabilité
      },
    });
  }

  /**
   * Ingérer un ZIP
   */
  async ingestZip(zipBuffer: Buffer, projectId: string, metadata: CommunityNodeMetadata) {
    const { files } = await extractZipToVirtualFiles(zipBuffer);
    const processor = new UnifiedProcessor({ /* ... */ projectId, contentSourceType: 'virtual' });
    return processor.ingestVirtualFiles(files, { additionalProperties: { ...metadata } });
  }

  /**
   * Ingérer un document seul
   */
  async ingestDocument(content: Buffer, fileName: string, projectId: string, metadata: CommunityNodeMetadata) {
    const file = createVirtualFileFromContent(content, fileName);
    const processor = new UnifiedProcessor({ /* ... */ projectId, contentSourceType: 'virtual' });
    return processor.ingestVirtualFiles([file], { additionalProperties: { ...metadata } });
  }
}
```

---

## 5. Flow Complet

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMMUNITY-DOCS                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  POST /api/projects (création)                                               │
│       │                                                                      │
│       ├── Prisma: créer Project → id: "clxxx..."                            │
│       │                                                                      │
│       └── Neo4j: MERGE (:Project {projectId: "clxxx...", type: "external"}) │
│                                                                              │
│  POST /api/projects/:id/ingest/github                                        │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  CommunityOrchestratorAdapter                                        │    │
│  │                                                                      │    │
│  │  // 1. Télécharger (utility du Core)                                │    │
│  │  const { files } = await downloadGitHubRepo(url);                   │    │
│  │                                                                      │    │
│  │  // 2. Créer processor avec Prisma projectId                        │    │
│  │  const processor = new UnifiedProcessor({                           │    │
│  │    projectId,  // ← Prisma Project.id directement                   │    │
│  │    contentSourceType: 'virtual',                                    │    │
│  │  });                                                                 │    │
│  │                                                                      │    │
│  │  // 3. Ingérer avec metadata community                              │    │
│  │  return processor.ingestVirtualFiles(files, {                       │    │
│  │    additionalProperties: { userId, categoryId, documentId }         │    │
│  │  });                                                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ DÉLÈGUE
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RAGFORGE-CORE                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  UnifiedProcessor.ingestVirtualFiles(files, { additionalProperties })        │
│       │                                                                      │
│       ├── 1. Crée File nodes avec _rawContent + additionalProperties        │
│       │                                                                      │
│       ├── 2. Pipeline: discovered → parsing → linked → embedding            │
│       │       │                                                              │
│       │       ├── VirtualContentProvider.readContent()                      │
│       │       │       └── Lit depuis Neo4j _rawContent                      │
│       │       │                                                              │
│       │       ├── Parse TS, Python, Vue, etc.                               │
│       │       │                                                              │
│       │       └── Crée Scope, Entity nodes                                  │
│       │                                                                      │
│       ├── 3. Propage additionalProperties aux child nodes                   │
│       │       └── Scope, Entity héritent de userId, categoryId, etc.        │
│       │                                                                      │
│       └── 4. Génère embeddings                                              │
│                                                                              │
│  return ProcessingStats                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Résumé des Modifications

| Fichier | Modification | Status |
|---------|--------------|--------|
| **ragforge-core** | | |
| `src/brain/content-provider.ts` | NOUVEAU - Interface + implémentations | ✅ |
| `src/brain/file-processor.ts` | Utilise IContentProvider | ✅ |
| `src/brain/file-state-machine.ts` | Accepte fichiers virtuels | ✅ |
| `src/ingestion/unified-processor.ts` | Option contentSourceType | ✅ |
| `src/brain/brain-manager.ts` | contentSourceType dans RegisteredProject | ✅ |
| `src/runtime/adapters/github-source.ts` | NOUVEAU - downloadGitHubRepo() | ✅ |
| `src/runtime/adapters/zip-source.ts` | NOUVEAU - extractZipToVirtualFiles() | ✅ |
| `src/ingestion/unified-processor.ts` | Méthode ingestVirtualFiles() | ✅ |
| **community-docs** | | |
| `lib/ragforge/orchestrator-adapter.ts` | Simplifier - déléguer au Core | ⏳ |
| `lib/ragforge/api/server.ts` | Utiliser downloadGitHubRepo du Core | ⏳ |

---

## 7. Ordre d'Implémentation

1. ✅ IContentProvider + implémentations (base de tout)
2. ✅ FileProcessor avec provider (connecter l'abstraction)
3. ✅ FileStateMachine pour virtual (queries adaptées)
4. ✅ UnifiedProcessor config contentSourceType
5. ✅ RegisteredProject + BrainManager persistence
6. ✅ downloadGitHubRepo() utility (téléchargement GitHub)
7. ✅ extractZipToVirtualFiles() utility (extraction ZIP)
8. ✅ UnifiedProcessor.ingestVirtualFiles() (orchestration virtual)
9. ⏳ **Simplifier Community-Docs** (délégation finale)

**Progression: ~95%** - Il reste uniquement la simplification côté Community-Docs


● Résumé des modifications effectuées:                                                   
                                                                                         
  1. types.ts - Ajouté ParserOptionsConfig avec:                                         
    - enableVision, visionAnalyzer (Vision pour documents et media)                      
    - sectionTitles, maxPages, generateTitles, titleGenerator (documents)                
    - render3D, ocrProvider (media)                                                      
  2. FileProcessor -                                                                     
    - Ajouté parserOptions au config et aux appels adapter.parse()                       
    - Ajouté setParserOptions() pour permettre les updates per-call                      
  3. CodeSourceAdapter -                                                                 
    - Passe parserOptions à parseDocumentFile() et parseMediaFile()                      
    - Mapping des options: enableVision, visionAnalyzer, maxPages, render3D              
  4. media-file-parser.ts -                                                              
    - Ajouté support Vision dans parseMediaFile()                                        
    - Images: lecture + visionAnalyzer() pour description                                
    - 3D: render3D() + visionAnalyzer() pour chaque vue                                  
  5. UnifiedProcessor -                                                                  
    - Ajouté parserOptions au config                                                     
    - Ajouté option parserOptions à ingestVirtualFiles() pour override per-call          
                                                                                         
  Maintenant les parserOptions fonctionnent pour tous les fichiers (disk et virtual). Tu
  veux que je continue avec l'ajout des méthodes binaires simplifiées dans
  CommunityOrchestratorAdapter ?

---

## 8. Audit des Usages de l'Ancien Flux (2026-01-19)

### Problème Identifié

Les endpoints Community-Docs utilisent encore **`IncrementalIngestionManager.ingestGraph()`** au lieu de **`UnifiedProcessor.ingestVirtualFiles()`**.

### Méthodes Simplified Complètes ✅

| Méthode | Utilise | Status |
|---------|---------|--------|
| `ingestGitHubSimplified` | UnifiedProcessor | ✅ |
| `ingestZipSimplified` | UnifiedProcessor | ✅ |
| `ingestDocumentSimplified` | UnifiedProcessor | ✅ |
| `ingestBinaryDocumentSimplified` | UnifiedProcessor | ✅ |
| `ingestMediaSimplified` | UnifiedProcessor | ✅ |
| `ingestVirtualSimplified` | UnifiedProcessor | ✅ (2026-01-19) |
| `ingestFilesSimplified` | UnifiedProcessor | ✅ (2026-01-19) |

### Usages de l'Ancien Flux à Migrer

#### `lib/ragforge/api/server.ts`
- Ligne 667: `ingestFiles` → `ingestFilesSimplified`
- Ligne 740: `ingestFiles` → `ingestFilesSimplified`
- Ligne 899: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 1480: `ingestFiles` → `ingestFilesSimplified`
- Ligne 1577: `ingestFiles` → `ingestFilesSimplified`

#### `lib/ragforge/ingestion-service.ts`
- Ligne 190: `ingestBinaryDocument` → `ingestBinaryDocumentSimplified`
- Ligne 229: `ingestMedia` → `ingestMediaSimplified`
- Ligne 271: `ingestVirtual` → `ingestVirtualSimplified`

#### `lib/ragforge/agent/tools.ts`
- Ligne 295: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 530: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 1057: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 1087: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 1155: `ingestVirtual` → `ingestVirtualSimplified`
- Ligne 1252: `ingestVirtual` → `ingestVirtualSimplified`

### Impact du Non-Migration

Sans migration vers les méthodes Simplified:
1. Les File nodes virtuels n'ont pas `isVirtual: true` (ajouté uniquement par `createVirtualFileNodes()`)
2. Le flux passe par `IncrementalIngestionManager.ingestNodes()` qui sauvegarde `_rawContent` même pour des fichiers disk
3. Pas de bénéfice du pipeline unifié (state machine, content provider, etc.)

### Plan de Migration

1. ✅ Créer `ingestVirtualSimplified(files: VirtualFile[], projectId, metadata)` (2026-01-19)
2. ✅ Créer `ingestFilesSimplified(files: UploadedFile[], projectId, metadata, options)` (2026-01-19)
3. ✅ Ajouter `@deprecated` sur les anciennes méthodes (2026-01-19)
4. ✅ Migrer `server.ts` (5 usages) (2026-01-19)
5. ✅ Migrer `ingestion-service.ts` (3 usages) (2026-01-19)
6. ✅ Migrer `agent/tools.ts` (6 usages) (2026-01-19)
7. ✅ Créer `createCommunityIngester()` factory function (2026-01-19)

### Note sur `_rawContent`

Un filtre a été ajouté dans `IncrementalIngestionManager.ingestNodes()` pour supprimer `_rawContent` des File nodes qui n'ont pas `isVirtual: true`. Ceci est une mesure de sécurité temporaire en attendant la migration complète.

```typescript
// incremental-ingestion.ts ligne 639-647
const isFileNode = node.labels.includes('File') && !node.labels.includes('MediaFile')
  && !node.labels.includes('ImageFile') && !node.labels.includes('ThreeDFile')
  && !node.labels.includes('DocumentFile');
if (isFileNode && !props.isVirtual && props._rawContent) {
  delete props._rawContent;
}
```

---

## 9. Simplification de l'Orchestrateur (2026-01-19)

### Nouveau: `createCommunityIngester()` Factory Function

L'ancien `CommunityOrchestratorAdapter` (classe de ~2000 lignes) a été simplifié en une factory function légère.

**Fichier**: `lib/ragforge/community-ingester.ts`

```typescript
import { createCommunityIngester, type CommunityIngester, type CommunityMetadata } from "./community-ingester";

const ingester = createCommunityIngester({
  driver: neo4jDriver,
  neo4jClient: coreNeo4jClient,
  embeddingService: embeddingService,
});

// Usage
await ingester.ingestVirtual(
  [{ path: "readme.md", content: "# Hello" }],
  "project-123",
  { userId: "user-1", categoryId: "cat-1" }
);

await ingester.ingestGitHub(
  "https://github.com/owner/repo",
  "project-456",
  { userId: "user-1", documentTitle: "My Repo" }
);
```

### Méthodes Disponibles

| Méthode | Description |
|---------|-------------|
| `ingestVirtual(files, projectId, metadata, options?)` | Ingérer des fichiers virtuels |
| `ingestFiles(files, projectId, metadata, options?)` | Ingérer des fichiers uploadés (mix de types) |
| `ingestGitHub(url, projectId, metadata, options?)` | Ingérer un repo GitHub |
| `ingestZip(buffer, projectId, metadata, options?)` | Ingérer un ZIP |
| `ingestDocument(content, fileName, projectId, metadata)` | Ingérer un document texte |
| `ingestBinaryDocument(buffer, fileName, projectId, metadata, options?)` | Ingérer un PDF/DOCX |
| `ingestMedia(buffer, fileName, projectId, metadata, options?)` | Ingérer une image/3D |
| `generateEmbeddings(projectId)` | Générer les embeddings pour un projet |
| `hasEmbeddingService()` | Vérifier si le service d'embedding est disponible |

### Avantages

1. **Simple** - Factory function au lieu d'une classe complexe
2. **Léger** - ~380 lignes vs ~2000 lignes
3. **Unifié** - Toutes les méthodes utilisent `UnifiedProcessor.ingestVirtualFiles()`
4. **Typé** - Interface `CommunityIngester` pour l'autocomplétion
5. **Cacheable** - Processors cachés par projectId

### Migration depuis CommunityOrchestratorAdapter

L'ancien `CommunityOrchestratorAdapter` reste disponible pour la compatibilité mais est marqué comme deprecated. Les nouvelles intégrations doivent utiliser `createCommunityIngester()`.

```typescript
// AVANT (deprecated)
const orchestrator = new CommunityOrchestratorAdapter(config);
await orchestrator.ingestVirtualSimplified(files, projectId, metadata, options);

// APRÈS (recommandé)
const ingester = createCommunityIngester(config);
await ingester.ingestVirtual(files, projectId, metadata, options);
```                                                         
                                       