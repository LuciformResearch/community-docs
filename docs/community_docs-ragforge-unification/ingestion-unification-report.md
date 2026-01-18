# Rapport d'Unification: Ingestion Community-Docs ↔ RagForge-Core

**Date**: 2026-01-18
**Objectif**: Analyser l'état actuel et les actions nécessaires pour unifier les pipelines d'ingestion.

---

## 1. GitHub Ingestion

### État Actuel

| Composant | Emplacement | Status |
|-----------|-------------|--------|
| **Documentation/Plan** | `packages/ragforge-core/docs/features/github-ingestion.md` | ✅ Complet |
| **MCP Tool `ingest_github`** | `packages/ragforge-core/src/tools/brain-tools.ts` | ❌ **NON IMPLÉMENTÉ** |
| **Community API Endpoint** | `lib/ragforge/api/server.ts:782` (`POST /ingest/github`) | ✅ **IMPLÉMENTÉ** |
| **Clone Function** | `lib/ragforge/api/server.ts:82-113` (`cloneGitHubRepo`) | ✅ Existe |

### Flow Actuel dans Community-Docs

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
│     - Préfixe les paths: /virtual/{documentId}/{sourceIdentifier}/       │
│     - sourceAdapter.parse({ source: { type: 'virtual', virtualFiles }})  │
│     - Injecte metadata community sur chaque node                         │
│     - ingestionManager.ingestGraph() → Neo4j                             │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  5. EMBED: orchestrator.generateEmbeddingsForDocument(documentId)        │
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
- `ingestVirtual` utilise `sourceAdapter.parse()` (UniversalSourceAdapter)
- Metadata community injectée manuellement sur chaque node

### Architecture Documentée (non implémentée dans ragforge-core)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         MCP Tool: ingest_github                             │
├────────────────────────────────────────────────────────────────────────────┤
│  Input:                                                                     │
│  - url: "owner/repo" ou "https://github.com/owner/repo"                    │
│  - branch: "main" (default)                                                │
│  - path: "src/lib" (optionnel, sous-dossier)                              │
│  - include/exclude: glob patterns                                          │
│  - include_submodules: true (default)                                      │
│  - generate_embeddings: true (default)                                     │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        BrainManager.ingestGitHub()                          │
│                                                                             │
│  1. Clone repo with --depth 1 + submodules                                 │
│  2. Appeler ingestDirectory() sur le clone                                 │
│  3. Nettoyage du dossier temporaire                                        │
└────────────────────────────────────────────────────────────────────────────┘
```

### UnifiedProcessor (RagForge-Core)

Le UnifiedProcessor utilise un **pipeline basé sur disque** avec FileStateMachine:

```
discovered → parsing → parsed → linking → linked → entities → embedding → ready
```

**`processDiscovered()`** (`unified-processor.ts:186-240`):
```typescript
// 1. Get files in 'discovered' state from FileStateMachine
const discoveredFiles = await this.fileStateMachine.getFilesInState(projectId, 'discovered');

// 2. Convert to FileInfo (absolutePath, uuid, state)
const fileInfos = discoveredFiles.map(f => ({
  absolutePath: this.resolveAbsolutePath(f.file),
  uuid: f.uuid,
  state: 'discovered',
}));

// 3. Batch process (single adapter.parse() call)
const batchResult = await this.fileProcessor.processBatchFiles(fileInfos);

// 4. Resolve pending imports (cross-file CONSUMES relationships)
await resolvePendingImports(this.neo4jClient, this.projectId);
```

**`processLinked()`** (`unified-processor.ts:245-529`):
- Entity extraction (GLiNER)
- Multi-embedding generation (name, content, description)
- Parallel processing avec `pLimit`

### Gap: Virtual Files vs Disk Pipeline

| Aspect | Community-Docs (ingestVirtual) | RagForge-Core (UnifiedProcessor) |
|--------|-------------------------------|----------------------------------|
| **Source** | Fichiers en mémoire | Fichiers sur disque |
| **State tracking** | Aucun | FileStateMachine |
| **Incremental** | Non | Oui (hash checking) |
| **Entity extraction** | Séparé | Intégré |
| **Embeddings** | Séparé | Intégré |

### Problème Fondamental: UnifiedProcessor et Fichiers Virtuels

**Le problème:**
- UnifiedProcessor utilise FileStateMachine qui **track les fichiers sur disque**
- Si le temp dir est supprimé après GitHub clone, au prochain cycle le processor voit les fichiers comme "deleted" et **nettoie la DB**
- Pas de support pour projets "virtual-only" (fichiers uniquement en Neo4j)

**Cas d'usage critiques:**
1. **GitHub ingestion** - Clone temporaire, fichiers supprimés après ingestion
2. **Neo4j Aura** - DB hostée, pas de filesystem local
3. **Serverless** - Pas de persistance disque
4. **ZIP uploads** - Fichiers extraits en mémoire seulement

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

### Découverte: CodeSourceAdapter supporte déjà les fichiers virtuels

**Bonne nouvelle !** Le parsing fonctionne déjà 100% en mémoire quand on utilise `virtualFiles`:

```typescript
// code-source-adapter.ts lignes 454-465
if (config.virtualFiles && config.virtualFiles.length > 0) {
  // Virtual files mode: use in-memory content
  console.log(`📦 Virtual files mode: ${config.virtualFiles.length} files in memory`);
  contentMap = new Map();
  for (const vf of config.virtualFiles) {
    const normalizedPath = vf.path.startsWith('/') ? vf.path : `/${vf.path}`;
    files.push(normalizedPath);
    contentMap.set(normalizedPath, vf.content);
  }
}

// Ligne 717-720: Lecture depuis mémoire
if (contentMap && contentMap.has(file)) {
  const virtualContent = contentMap.get(file)!;
  content = typeof virtualContent === 'string' ? virtualContent : ...
}

// Ligne 754-757: Passe contentMap aux code parsers (tree-sitter)
const parsedCode = await this.codeParser.parse({
  files: Array.from(codeContentMap.keys()),
  contentMap: codeContentMap,  // Parsers aussi en mémoire!
});
```

**Conclusion:** `CodeSourceAdapter` + `@luciformresearch/codeparsers` supportent nativement le parsing en mémoire. Le problème est uniquement dans `FileStateMachine` qui assume l'existence sur disque.

### Architecture Décidée: Abstraction IFileStateMachine

On crée une interface commune + classe de base pour factoriser la logique partagée:

```typescript
// ============================================
// Interface commune
// ============================================
interface IFileStateMachine {
  // Queries état
  getFilesInState(projectId: string, state: FileState): Promise<FileStateInfo[]>;
  getStateStats(projectId: string): Promise<Record<FileState, number>>;
  getProgress(projectId: string): Promise<{ processed: number; total: number; percentage: number }>;
  getRetryableFiles(projectId: string, maxRetries: number): Promise<FileStateInfo[]>;
  isProjectFullyProcessed(projectId: string): Promise<boolean>;

  // Transitions
  transition(uuid: string, newState: FileState, options?: TransitionOptions): Promise<void>;
  transitionBatch(uuids: string[], newState: FileState): Promise<void>;

  // Accès fichiers (différent selon mode)
  checkFileExists(path: string): Promise<boolean>;
  getFileContent(path: string): Promise<string | null>;
  getFileHash(path: string): Promise<string | null>;
}

// ============================================
// Classe de base avec logique partagée
// ============================================
abstract class BaseFileStateMachine implements IFileStateMachine {
  protected neo4jClient: Neo4jClient;

  constructor(neo4jClient: Neo4jClient) {
    this.neo4jClient = neo4jClient;
  }

  // PARTAGÉ: Validation des transitions
  protected validateTransition(from: FileState, to: FileState): boolean {
    const validTransitions: Record<FileState, FileState[]> = {
      'discovered': ['parsing', 'error'],
      'parsing': ['linked', 'error'],
      'linked': ['entities', 'error'],
      'entities': ['embedding', 'error'],
      'embedding': ['embedded', 'error'],
      'embedded': ['discovered'], // Re-process
      'error': ['discovered'],    // Retry
    };
    return validTransitions[from]?.includes(to) ?? false;
  }

  // PARTAGÉ: Queries Neo4j pour états
  async getFilesInState(projectId: string, state: FileState): Promise<FileStateInfo[]> {
    const result = await this.neo4jClient.run(`
      MATCH (f:File {projectId: $projectId, _state: $state})
      RETURN f.uuid as uuid, f.file as file, f._state as state,
             f._errorType as errorType, f._retryCount as retryCount
    `, { projectId, state });
    return result.records.map(r => ({ ... }));
  }

  async transitionBatch(uuids: string[], newState: FileState): Promise<void> {
    await this.neo4jClient.run(`
      UNWIND $uuids AS uuid
      MATCH (f:File {uuid: uuid})
      SET f._state = $newState, f._stateUpdatedAt = datetime()
    `, { uuids, newState });
  }

  async getStateStats(projectId: string): Promise<Record<FileState, number>> { ... }
  async getProgress(projectId: string): Promise<...> { ... }

  // ABSTRAIT: Implémentation spécifique au mode
  abstract checkFileExists(path: string): Promise<boolean>;
  abstract getFileContent(path: string): Promise<string | null>;
  abstract getFileHash(path: string): Promise<string | null>;
}

// ============================================
// Implémentation DISK (actuelle, renommée)
// ============================================
class DiskFileStateMachine extends BaseFileStateMachine {
  async checkFileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async getFileContent(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }

  async getFileHash(path: string): Promise<string | null> {
    const content = await this.getFileContent(path);
    return content ? computeHash(content) : null;
  }
}

// ============================================
// Implémentation VIRTUAL (nouvelle)
// ============================================
class VirtualFileStateMachine extends BaseFileStateMachine {
  async checkFileExists(path: string): Promise<boolean> {
    // Fichier "existe" s'il y a un node en DB avec _rawContent
    const result = await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $path})
      WHERE f._rawContent IS NOT NULL
      RETURN count(f) > 0 as exists
    `, { path });
    return result.records[0]?.get('exists') ?? false;
  }

  async getFileContent(path: string): Promise<string | null> {
    // Contenu depuis _rawContent en Neo4j
    const result = await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $path})
      RETURN f._rawContent as content
    `, { path });
    return result.records[0]?.get('content') ?? null;
  }

  async getFileHash(path: string): Promise<string | null> {
    // Hash depuis _rawContentHash en Neo4j (déjà calculé à l'ingestion)
    const result = await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $path})
      RETURN f._rawContentHash as hash
    `, { path });
    return result.records[0]?.get('hash') ?? null;
  }
}
```

### Utilisation dans UnifiedProcessor

```typescript
class UnifiedProcessor {
  private stateMachine: IFileStateMachine;

  constructor(config: UnifiedProcessorConfig) {
    // Sélection automatique selon projectType
    this.stateMachine = config.projectType === 'virtual'
      ? new VirtualFileStateMachine(config.neo4jClient)
      : new DiskFileStateMachine(config.neo4jClient);
  }

  // Le reste du code utilise this.stateMachine sans savoir le mode
  async processDiscovered(): Promise<ProcessingStats> {
    const files = await this.stateMachine.getFilesInState(this.projectId, 'discovered');
    // ... même logique pour les deux modes
  }
}
```

### Changements Requis

#### 1. Ajouter `projectType` aux projets

```typescript
type ProjectType = 'disk' | 'virtual';

interface Project {
  id: string;
  path?: string;           // Seulement pour disk
  virtualRoot?: string;    // Seulement pour virtual
  type: ProjectType;
}
```

#### 2. Refactorer FileStateMachine → BaseFileStateMachine + DiskFileStateMachine

Fichier: `src/brain/file-state-machine.ts`
- Extraire la logique commune dans `BaseFileStateMachine`
- Renommer l'implémentation actuelle en `DiskFileStateMachine`
- Créer `VirtualFileStateMachine`

#### 3. Garantir `_rawContent` sur TOUS les File nodes virtuels

```typescript
// Dans code-source-adapter.ts ou virtual ingestion
// OBLIGATOIRE pour fichiers virtuels:
nodes.push({
  labels: ['File'],
  properties: {
    // ...
    _rawContent: content,  // TOUJOURS présent pour virtual
    _rawContentHash: computeHash(content),
    isVirtual: true,       // Flag pour identifier
  }
});
```

#### 4. Modifier UnifiedProcessor pour supporter les deux modes

```typescript
class UnifiedProcessor {
  private fileStateMachine: FileStateMachine | VirtualFileStateMachine;
  private projectType: ProjectType;

  constructor(config: UnifiedProcessorConfig) {
    this.projectType = config.projectType ?? 'disk';

    if (this.projectType === 'virtual') {
      this.fileStateMachine = new VirtualFileStateMachine(config);
    } else {
      this.fileStateMachine = new FileStateMachine(config);
    }
  }

  async processDiscovered(): Promise<ProcessingStats> {
    // Le code reste le même, seule la state machine change
    const discoveredFiles = await this.fileStateMachine.getFilesInState(
      this.projectId, 'discovered'
    );
    // ...
  }
}
```

#### 5. VirtualFileWatcher (optionnel, pour updates)

```typescript
class VirtualFileWatcher {
  // Au lieu de chokidar qui watch le filesystem,
  // expose une API pour signaler les changements:

  async notifyFileChanged(projectId: string, filePath: string, newContent: string) {
    // 1. Update _rawContent et _rawContentHash
    // 2. Mark file as 'discovered' pour re-processing
  }

  async notifyFileDeleted(projectId: string, filePath: string) {
    // 1. Delete File node et ses enfants
  }

  async notifyFileCreated(projectId: string, filePath: string, content: string) {
    // 1. Create File node with _rawContent
    // 2. Mark as 'discovered'
  }
}
```

### Implémentation GitHub Ingestion (avec virtual)

```typescript
async ingestGitHub(options: GitHubIngestionOptions): Promise<IngestionStats> {
  // 1. Clone to temp dir
  const { tempDir, repoDir } = await cloneGitHubRepo(options.url, options.branch);

  try {
    // 2. Read ALL files into memory
    const virtualFiles = await readAllFilesToMemory(repoDir, options.include, options.exclude);

    // 3. Create VIRTUAL project
    const projectId = `github-${owner}-${repo}`;
    await this.registerProject({
      id: projectId,
      type: 'virtual',
      virtualRoot: `/github/${owner}/${repo}`,
    });

    // 4. Use UnifiedProcessor in VIRTUAL mode
    const processor = new UnifiedProcessor({
      ...this.config,
      projectId,
      projectType: 'virtual',  // <-- KEY
    });

    // 5. Ingest virtual files (creates File nodes with _rawContent)
    await this.ingestVirtualFiles(projectId, virtualFiles);

    // 6. Process through pipeline
    await processor.processDiscovered();
    await processor.processLinked();

    return stats;
  } finally {
    // 7. Cleanup temp dir - DB nodes PERSIST because they're virtual
    await fs.rm(tempDir, { recursive: true });
  }
}
```

### Actions Requises

1. **Implémenter `generateGitHubIngestionTool()` dans `brain-tools.ts`**
   - Définition du tool avec schema Zod
   - Handler qui appelle `BrainManager.ingestGitHub()`

2. **Implémenter `BrainManager.ingestGitHub()` dans `brain-manager.ts`**
   ```typescript
   async ingestGitHub(options: {
     url: string;
     branch?: string;
     path?: string;
     include?: string[];
     exclude?: string[];
     includeSubmodules?: boolean;
     generateEmbeddings?: boolean;
   }): Promise<IngestionStats> {
     // 1. Clone to temp dir
     const { tempDir, repoDir } = await this.cloneGitHubRepo(options.url, options.branch);

     try {
       // 2. Use existing ingestDirectory (which uses UnifiedProcessor)
       const targetDir = options.path ? path.join(repoDir, options.path) : repoDir;
       return await this.ingestDirectory(targetDir, {
         include: options.include,
         exclude: options.exclude,
         generateEmbeddings: options.generateEmbeddings,
       });
     } finally {
       // 3. Cleanup
       await fs.rm(tempDir, { recursive: true });
     }
   }
   ```

3. **Copier `cloneGitHubRepo()` vers ragforge-core**
   - Depuis `lib/ragforge/api/server.ts:82-113`
   - Vers `packages/ragforge-core/src/utils/git-utils.ts`

4. **Support incremental** (optionnel, phase 2)
   - Stocker le commit SHA du dernier ingest
   - `git fetch` + diff pour sync

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

### Code Existant

```typescript
// packages/ragforge-core/src/ingestion/parser-types.ts
export const MAX_RAW_CONTENT_SIZE = 100 * 1024; // 100KB

export function getRawContentProp(content: string | undefined | null): string | undefined {
  if (!content || content.length > MAX_RAW_CONTENT_SIZE) return undefined;
  return content;
}
```

### Utilisation dans CodeSourceAdapter

```typescript
// code-source-adapter.ts - exemple pour fichiers code
fileMetadata.set(file, {
  rawContentHash,
  mtime,
  rawContent: getRawContentProp(content),  // ✅ Collecté
});

// Puis sur le File node:
nodes.push({
  labels: ['File'],
  properties: {
    // ...
    ...(rawContent && { _rawContent: rawContent }),  // ✅ Stocké
  }
});
```

### Verdict

**`_rawContent` est correctement implémenté** pour les fichiers texte/code. Les agents peuvent lire les fichiers virtuels via le tool `read_file` qui récupère `_rawContent` du node Neo4j.

---

## 3. Délégation Complète vers RagForge-Core

### Architecture Actuelle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           COMMUNITY-DOCS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────┐    ┌────────────────────────────────────┐  │
│  │ CommunityUploadAdapter  │    │ CommunityOrchestratorAdapter       │  │
│  │ (lib/ragforge/upload-   │    │ (lib/ragforge/orchestrator-        │  │
│  │  adapter.ts)            │    │  adapter.ts)                       │  │
│  │                         │    │                                    │  │
│  │ • parse()               │    │ • ingest() - fichiers disque       │  │
│  │ • parseFile()           │    │ • ingestVirtual() - fichiers mém   │  │
│  │ • parseDirectory()      │    │ • ingestFiles() - unifié           │  │
│  └───────────┬─────────────┘    └──────────────┬─────────────────────┘  │
│              │                                  │                        │
│              │         DÉLÈGUE À                │                        │
│              ▼                                  ▼                        │
├─────────────────────────────────────────────────────────────────────────┤
│                           RAGFORGE-CORE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              UniversalSourceAdapter                              │    │
│  │              (src/runtime/adapters/universal-source-adapter.ts)  │    │
│  │                                                                  │    │
│  │  • parse({ source: { type: 'files' | 'virtual', ... } })        │    │
│  │  • Dispatche vers CodeSourceAdapter, WebAdapter, etc.           │    │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              CodeSourceAdapter                                   │    │
│  │              (src/runtime/adapters/code-source-adapter.ts)       │    │
│  │                                                                  │    │
│  │  • parseFiles() - gère virtualFiles nativement                  │    │
│  │  • Supporte: code, markdown, data, media, documents             │    │
│  │  • Ajoute _rawContent sur les File nodes                        │    │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Ce Qui Fonctionne Déjà

1. **`CommunityUploadAdapter.parse()`** → délègue à `UniversalSourceAdapter.parse()`
2. **`CommunityOrchestratorAdapter.ingestVirtual()`** → utilise `UniversalSourceAdapter` avec `source.type = 'virtual'`
3. **Virtual files** → supportés nativement par `CodeSourceAdapter.parseFiles()`

### Ce Qui Doit Être Unifié

| Fonctionnalité | Community-Docs | RagForge-Core | Action |
|----------------|----------------|---------------|--------|
| Upload ZIP | `CommunityIngestionService` | ❌ Pas de support | Ajouter support ZIP dans core |
| GitHub Clone | `CommunityAPIServer` | ❌ Pas de support | Implémenter dans BrainManager |
| Metadata injection | `transformGraph` hook | ❌ Pas de mécanisme | Ajouter callback/hook |

### Plan d'Unification

#### Phase 1: GitHub Ingestion dans RagForge-Core

```typescript
// brain-manager.ts
async ingestGitHub(options: GitHubIngestionOptions): Promise<IngestionStats> {
  const tmpDir = await this.cloneRepository(options.url, options.branch);
  try {
    return await this.ingestDirectory(tmpDir, {
      include: options.include,
      exclude: options.exclude,
      generateEmbeddings: options.generateEmbeddings,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}
```

#### Phase 2: ZIP Support dans RagForge-Core

```typescript
// Option A: Dans BrainManager
async ingestZip(zipBuffer: Buffer, options: ZipIngestionOptions): Promise<IngestionStats> {
  // Extraire en mémoire → VirtualFile[]
  const virtualFiles = await extractZipToVirtualFiles(zipBuffer);
  return this.adapter.parse({
    source: { type: 'virtual', virtualFiles, root: options.rootPath },
    projectId: options.projectId,
  });
}

// Option B: Dans UniversalSourceAdapter (nouveau source type)
source: { type: 'zip', buffer: zipBuffer, root: '/upload' }
```

#### Phase 3: Metadata Hook dans RagForge-Core

```typescript
// brain-manager.ts ou adapter config
interface IngestionHooks {
  transformNode?: (node: ParsedNode) => ParsedNode;
  transformGraph?: (graph: ParseResult) => ParseResult;
}
```

---

## 4. Résumé des Actions

### Priorité Haute

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 1 | Implémenter `ingest_github` MCP tool | `brain-tools.ts` | 2h |
| 2 | Implémenter `BrainManager.ingestGitHub()` | `brain-manager.ts` | 4h |

### Priorité Moyenne

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 3 | Ajouter support ZIP dans core | `brain-manager.ts` ou nouveau fichier | 4h |
| 4 | Ajouter hooks metadata | `brain-manager.ts` | 2h |

### Priorité Basse (optionnel)

| # | Action | Fichier | Effort |
|---|--------|---------|--------|
| 5 | Incremental GitHub sync | `brain-manager.ts` | 8h |
| 6 | Migrer community-docs vers appels core uniquement | `orchestrator-adapter.ts` | 4h |

---

## 5. Références Code

### Fichiers Clés - RagForge-Core

- `src/tools/brain-tools.ts` - Tools MCP
- `src/brain/brain-manager.ts` - Orchestration principale
- `src/runtime/adapters/universal-source-adapter.ts` - Dispatcher
- `src/runtime/adapters/code-source-adapter.ts` - Parsing code
- `src/runtime/adapters/types.ts` - Interface `VirtualFile`
- `src/ingestion/parser-types.ts` - `getRawContentProp`, `MAX_RAW_CONTENT_SIZE`

### Fichiers Clés - Community-Docs

- `lib/ragforge/orchestrator-adapter.ts` - `CommunityOrchestratorAdapter`
- `lib/ragforge/upload-adapter.ts` - `CommunityUploadAdapter`
- `lib/ragforge/ingestion-service.ts` - `CommunityIngestionService`
- `lib/ragforge/api/server.ts` - `cloneGitHubRepo()`
- `app/api/ingest/github` - API endpoint

---

## 6. Conclusion

**L'unification est bien avancée** - community-docs délègue déjà le parsing à ragforge-core via `UniversalSourceAdapter`. Les points manquants sont:

1. **GitHub ingestion** - Documenté mais non implémenté dans les MCP tools
2. **ZIP support** - Géré côté community-docs, devrait être dans core
3. **Metadata hooks** - Community-docs utilise `transformGraph`, core n'a pas d'équivalent

**`_rawContent` est correctement géré** pour tous les types de fichiers texte, permettant aux agents de lire les fichiers virtuels.
