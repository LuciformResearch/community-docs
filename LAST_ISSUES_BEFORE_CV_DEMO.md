# Issues à Résoudre Avant Démo CV

## 1. EmbeddingChunks de Classes - Numéros de Ligne Incorrects

### Description
Quand une recherche (sémantique OU BM25) retourne un EmbeddingChunk dont le parent est une classe (ou interface, enum, namespace, module), les numéros de ligne `startLine`/`endLine` dans `matchedRange` sont incorrects car ils sont calculés depuis le résumé "Members:" au lieu du code source réel.

### Cause
Les classes ont un `_content` qui est un résumé structuré (généré par `enrichClassNodesWithMembers` dans code-source-adapter.ts:3709) :
```
export class CSSParser {

Members:
  - async initialize(): Promise<void> (L36-50)
  - async parseFile(...): Promise<...> (L55-140)
  ...
```

Quand on crée des EmbeddingChunks de ce `_content`, les `startLine`/`endLine` sont calculés relativement au texte du résumé, pas au fichier source.

### Query exacte pour voir le problème dans la DB
```bash
curl -s -X POST http://localhost:6970/cypher \
  -H "Content-Type: application/json" \
  -d '{"query": "MATCH (s:Scope {type: \"class\"})-[:HAS_EMBEDDING_CHUNK]->(c:EmbeddingChunk) RETURN s._name, s.startLine, s.endLine, c.chunkIndex, c.startLine as chunkStart, c.endLine as chunkEnd, substring(c._content, 0, 100) as preview LIMIT 5"}' | jq '.records'
```

Résultat montrant le PROBLÈME :
```json
[
  {
    "s._name": "class BaseScopeExtractionParser()",
    "s.startLine": 158,     // La classe va de 158 à 2892
    "s.endLine": 2892,
    "c.chunkIndex": 0,
    "chunkStart": 158,      // Chunk 0 dit 158-174
    "chunkEnd": 174,        // FAUX! Ces lignes sont relatives au résumé
    "preview": "export class BaseScopeExtractionParser {\n\nMembers:\n  - protected isNodeType..."
  },
  {
    "s._name": "class CSSParser()",
    "s.startLine": 29,
    "s.endLine": 504,
    "c.chunkIndex": 0,
    "chunkStart": 29,
    "chunkEnd": 71,         // FAUX! La classe fait 29-504, pas 29-71
    "preview": "export class CSSParser {\n\nMembers:\n  - async initialize()..."
  }
]
```

### Reproduction via recherche
```bash
# Recherche BM25 (sans semantic) sur "Members" pour trouver les classes
curl -s -X POST http://localhost:6970/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Members initialize parseFile traverseNode", "limit": 5, "semantic": false, "labels": ["Scope"]}' | jq '.results[:2]'
```

### Correction Appliquée
Dans `search-service.ts`, la méthode `resolveChunkMatches` a été modifiée pour utiliser les `startLine`/`endLine` du parent Scope quand le type est un "container" (class, interface, enum, namespace, module).

```typescript
const containerTypes = new Set(['class', 'interface', 'enum', 'namespace', 'module']);
const parentType = parentNode.type as string | undefined;
const useParentLineRange = parentType && containerTypes.has(parentType);

const matchedRange = {
  startLine: useParentLineRange ? (parentNode.startLine ?? 1) : (chunk.startLine ?? 1),
  endLine: useParentLineRange ? (parentNode.endLine ?? 1) : (chunk.endLine ?? 1),
  // ...
};
```

### Status
- [x] Fix implémenté dans `search-service.ts` pour vectorSearch (`resolveChunkMatches`)
- [x] Fix implémenté dans `search-service.ts` pour fullTextSearch (appel à `resolveChunkMatches`)
- [x] Code compilé vérifié
- [ ] Nécessite test avec un vrai match de chunk de classe

---

## 1b. EmbeddingChunk manquant dans l'index Fulltext

### Description
`EmbeddingChunk` n'était PAS inclus dans l'index `unified_fulltext`, donc la recherche BM25/keyword ne trouvait pas les chunks.

### Fix
1. Ajouté `EmbeddingChunk` à `FULLTEXT_LABELS` dans `ensure-indexes.ts`
2. Recréé l'index manuellement :
```bash
# Drop l'ancien
curl -s -X POST http://localhost:6970/cypher \
  -H "Content-Type: application/json" \
  -d '{"query": "DROP INDEX unified_fulltext"}'

# Recréer avec EmbeddingChunk
curl -s -X POST http://localhost:6970/cypher \
  -H "Content-Type: application/json" \
  -d '{"query": "CREATE FULLTEXT INDEX unified_fulltext IF NOT EXISTS FOR (n:Scope|File|DataFile|DocumentFile|PDFDocument|WordDocument|SpreadsheetDocument|MarkdownDocument|MarkdownSection|MediaFile|ImageFile|ThreeDFile|WebPage|CodeBlock|VueSFC|SvelteComponent|Stylesheet|GenericFile|PackageJson|DataSection|WebDocument|Entity|EmbeddingChunk) ON EACH [n._name, n._content, n._description]"}'
```

### Status
- [x] Index recréé avec EmbeddingChunk
- [x] `fullTextSearch` modifié pour résoudre les chunks vers leurs parents

---

## 2. Grep Cherchait dans les Résumés au lieu du Code Source

### Description
L'endpoint `/grep` cherchait dans `_content` de tous les nodes (Scopes, EmbeddingChunks), ce qui retournait des résultats incorrects pour les classes car leur `_content` est un résumé.

### Correction Appliquée
`grepVirtual()` a été réécrit pour chercher directement dans `File._rawContent` :

```typescript
const cypher = `
  MATCH (f:File)
  WHERE f._rawContent IS NOT NULL ${filterClause} ${containsFilter}
  RETURN f
  LIMIT 5000
`;
```

### Status
- [x] Fix implémenté
- [x] Index fulltext `file_rawcontent_fulltext` créé
- [x] Testé et fonctionne - retourne des Files avec les bons numéros de ligne

---

## 3. Index Fulltext pour Grep sur _rawContent

### Création manuelle de l'index
```bash
curl -s -X POST http://localhost:6970/cypher \
  -H "Content-Type: application/json" \
  -d '{"query": "CREATE FULLTEXT INDEX file_rawcontent_fulltext IF NOT EXISTS FOR (n:File) ON EACH [n._rawContent]"}'
```

### Vérification
```bash
curl -s -X POST http://localhost:6970/cypher \
  -H "Content-Type: application/json" \
  -d '{"query": "SHOW INDEXES YIELD name, type WHERE name CONTAINS \"fulltext\" RETURN name, type"}' | jq '.records'
```

---

## Fichiers Modifiés

| Fichier | Modification |
|---------|--------------|
| `packages/ragforge-core/src/brain/search-service.ts` | `grepVirtual()` réécrit pour Files, `resolveChunkMatches` corrigé pour containers, `fullTextSearch` résout les chunks |
| `packages/ragforge-core/src/brain/ensure-indexes.ts` | Ajout `EmbeddingChunk` à `FULLTEXT_LABELS`, ajout index `file_rawcontent_fulltext` |

## Rebuild & Restart

```bash
cd /home/luciedefraiteur/LR_CodeRag/community-docs/packages/ragforge-core
npm run build

sudo systemctl restart community-docs-api.service
```
