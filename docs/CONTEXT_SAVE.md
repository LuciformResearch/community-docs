# Context Save - Virtual Files & Content Provider Architecture

**Date**: 2026-01-18
**Session**: Unification Community-Docs + RagForge-Core

---

## Décisions Architecturales

### 1. ProjectType - Utilisation de `'external'`

Le type `'external'` (existant mais inutilisé) sera utilisé pour les projets Community-Docs:

```typescript
type ProjectType = 'quick-ingest' | 'external' | 'touched-files' | 'web-crawl';
```

| Type | Usage |
|------|-------|
| `'quick-ingest'` | Projets ingérés via CLI/MCP (`ingest_directory`) - fichiers sur disque |
| `'external'` | **Projets Community-Docs** - GitHub clone, ZIP upload, etc. |
| `'touched-files'` | Fichiers orphelins (touchés par `read_file`) |
| `'web-crawl'` | Pages web crawlées |

### 2. ContentSourceType - Nouvelle propriété

Nouvelle propriété sur le node `:Project` pour indiquer où lire le contenu des fichiers:

```typescript
type ContentSourceType = 'disk' | 'virtual';
```

- `'disk'`: Fichiers sur le système de fichiers (comportement actuel)
- `'virtual'`: Fichiers stockés dans Neo4j `_rawContent`

### 3. Node Project - Structure

```cypher
(:Project {
  projectId: "proj-xxx",
  rootPath: "/path/or/virtual/path",

  // Type de projet (comment créé)
  type: "external",

  // Source du contenu (NOUVEAU)
  contentSourceType: "virtual",

  // Métadonnées source (pour external)
  sourceUrl: "https://github.com/user/repo",
  sourceType: "github" | "zip" | "upload",

  // Autres
  lastAccessed: datetime(),
  excluded: false,
  autoCleanup: true,
  name: "Display Name"
})
```

### 4. Mapping Type → ContentSourceType

| Cas d'usage | `type` | `contentSourceType` |
|-------------|--------|---------------------|
| `ingest_directory("/path")` | `quick-ingest` | `disk` |
| GitHub clone (Community-Docs) | `external` | `virtual` |
| ZIP upload (Community-Docs) | `external` | `virtual` |
| File upload (Community-Docs) | `external` | `virtual` |
| Web crawl | `web-crawl` | `virtual` |
| Fichiers orphelins | `touched-files` | `disk` |

---

## Implémentation en cours

### Fichiers créés

1. **`packages/ragforge-core/src/brain/content-provider.ts`** ✅
   - Interface `IContentProvider`
   - `DiskContentProvider` - lit depuis le filesystem
   - `VirtualContentProvider` - lit depuis Neo4j `_rawContent`
   - `HybridContentProvider` - auto-détecte disk vs virtual
   - Factory `createContentProvider(type, neo4jClient)`

### Fichiers modifiés

2. **`FileProcessor`** ✅ - Utilise `IContentProvider` au lieu de `fs.readFile()`
   - Ajouté `contentProvider` et `contentSourceType` au config
   - `processFile()` utilise `contentProvider.readContent()`
   - `processBatchFiles()` utilise `contentProvider.readContent()`
   - `needsProcessing()` utilise `contentProvider.readContent()`

3. **`FileStateMachine.getFilesInState()`** ✅ - Inclut fichiers virtuels
   - Query modifiée: `AND (f.absolutePath IS NOT NULL OR f._rawContent IS NOT NULL)`
   - `FileStateInfo` a maintenant `isVirtual?: boolean`

4. **`UnifiedProcessor`** ✅ - Option `contentSourceType`, auto-select provider
   - Ajouté `contentSourceType` et `contentProvider` au config
   - Passe `contentProvider` au `FileProcessor`
   - `readFileContent()` helper pour domain classification

### Fichiers à modifier (TODO)

5. **`RegisteredProject` type** - Ajouter `contentSourceType?: ContentSourceType`
6. **`BrainManager.registerProject()`** - Accepter `contentSourceType`
7. **`BrainManager.updateProjectMetadataInDb()`** - Persister `contentSourceType`

---

## Architecture Cible

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UnifiedProcessor                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Lire contentSourceType depuis Project node                              │
│  2. Créer le bon provider:                                                  │
│     - disk → DiskContentProvider                                            │
│     - virtual → VirtualContentProvider                                      │
│  3. Passer au FileProcessor                                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     FileProcessor                                    │    │
│  │                                                                      │    │
│  │  AVANT: await fs.readFile(file.absolutePath, 'utf-8')               │    │
│  │  APRÈS: await this.contentProvider.readContent(file)                │    │
│  │                                                                      │    │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────┐     │    │
│  │  │ DiskContentProvider │    │ VirtualContentProvider          │     │    │
│  │  │ fs.readFile(path)   │    │ neo4j.query(_rawContent)        │     │    │
│  │  └─────────────────────┘    └─────────────────────────────────┘     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Flow Community-Docs (GitHub/ZIP)

```
POST /api/projects/:id/ingest/github
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  1. Créer/Update Project node avec:                                       │
│     - type: 'external'                                                    │
│     - contentSourceType: 'virtual'                                        │
│     - sourceUrl: githubUrl                                                │
│     - sourceType: 'github'                                                │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  2. Clone GitHub → virtualFiles[]                                         │
│     (fichiers en mémoire, pas sur disque permanent)                       │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  3. Appeler UnifiedProcessor.ingestVirtualFiles(virtualFiles)             │
│     - Crée File nodes avec _rawContent                                    │
│     - Parse → Scope nodes                                                 │
│     - VirtualContentProvider lit depuis _rawContent                       │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  4. Générer embeddings                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## TODO Restant

- [x] Modifier `FileProcessor` pour utiliser `IContentProvider` ✅
- [x] Modifier `FileStateMachine.getFilesInState()` pour inclure fichiers virtuels ✅
- [x] Modifier `UnifiedProcessor` pour option `contentSourceType` ✅
- [x] Ajouter `contentSourceType` à `RegisteredProject` et persistence Neo4j ✅
- [x] Ajouter support GitHub/ZIP source (`downloadGitHubRepo()`) ✅
- [x] Implémenter `UnifiedProcessor.ingestVirtualFiles()` ✅
- [ ] Simplifier `CommunityOrchestratorAdapter` pour déléguer au Core

---

## Fichiers Créés

### `packages/ragforge-core/src/runtime/adapters/github-source.ts`

Utilitaire pour télécharger des repos GitHub et retourner des `VirtualFile[]`:

```typescript
// Types
interface GitHubRepoRef { owner: string; repo: string; ref?: string; }
interface GitHubDownloadOptions {
  token?: string;           // GitHub token (pour repos privés)
  include?: string[];       // Patterns à inclure
  exclude?: string[];       // Patterns à exclure
  maxFileSize?: number;     // Taille max par fichier (10MB default)
  method?: 'api' | 'git';   // Méthode de téléchargement
  includeSubmodules?: boolean; // Inclure submodules (default: true)
}

// Usage
import { downloadGitHubRepo, parseGitHubUrl } from '@luciformresearch/ragforge';

const result = await downloadGitHubRepo('https://github.com/owner/repo', {
  method: 'git',  // ou 'api' pour ZIP
  includeSubmodules: true,
});

// result.files = VirtualFile[] (path + content)
// Passer à UnifiedProcessor.ingestVirtualFiles()
```
