# Normalized Node Properties

All content nodes in RagForge use normalized properties for consistent search and embedding.

## Property Definitions

| Property | Purpose | Used For |
|----------|---------|----------|
| `_name` | Searchable name/title/signature | `embedding_name`, fulltext index |
| `_content` | Main textual content | `embedding_content`, fulltext index, chunking |
| `_description` | Description/documentation/metadata | `embedding_description`, fulltext index |

## Mapping by Node Type

### Code Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **Scope** | `signature \|\| name` | `source` (code) | `docstring` |
| **File** | `basename(path)` | null | null |
| **VueSFC** | `componentName \|\| basename` | `templateSource` | uses/imports info |
| **SvelteComponent** | `componentName \|\| basename` | `templateSource` | imports info |
| **Stylesheet** | `basename(file)` | `source` | rules/variables count |
| **GenericFile** | `basename(file)` | `source` | null |
| **ExternalLibrary** | `name` | null | `"${registry} package"` |

### Document Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **MarkdownDocument** | `title \|\| file` | null (container) | frontMatter excerpt |
| **MarkdownSection** | `title` | `ownContent \|\| content` | null |
| **CodeBlock** | `"${language} code block"` | `code` | null |

### Data Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **DataFile** | `basename(file)` | `rawContent` | format/sections/refs info |
| **DataSection** | `path` (JSON path) | `content` | `"key (type, depth)"` |

### Media Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **ImageFile** | `basename(file)` | null | `analysis.description` |
| **ThreeDFile** | `basename(file)` | null* | `analysis.description` |
| **MediaFile** | `basename(file)` | null | `analysis.description` |

*ThreeDFile: Optional GLTF metadata in `_content` with `includeGltfMetadata: true`

### Web Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **WebPage** | `title \|\| url` | `textContent` | `metaDescription` |
| **WebDocument** | `title \|\| file` | `textContent` | null |

### Entity & Chunk Nodes

| Node Type | _name | _content | _description |
|-----------|-------|----------|--------------|
| **Entity** | `name` | null | `entityType` |
| **EmbeddingChunk** | N/A | chunk text | N/A |

## Rules

1. **No duplication**: `_content` and `_description` should not duplicate `_name`
2. **Container nodes**: Nodes that only contain children (MarkdownDocument, File) have `_content = null`
3. **Chunking**: When `_content` > 3000 chars, create `EmbeddingChunk` nodes via `HAS_EMBEDDING_CHUNK`
4. **File._rawContent**: Optional property for storing full file content (max 100KB)

## File-like Nodes Consistency

All file-like nodes use `basename(file)` for `_name`:
- File, ImageFile, ThreeDFile, MediaFile, DataFile, Stylesheet, GenericFile

This ensures:
- `absolutePath` property has the full path for navigation
- `_name` is concise for search display
- No redundancy between properties
