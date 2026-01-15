# Entity Extraction - Problèmes d'Intégration Identifiés

Ce document liste les problèmes identifiés lors de l'implémentation de l'entity extraction GLiNER qui doivent être résolus pour une intégration complète.

**Dernière mise à jour**: 2026-01-14

---

## Statut Global

| Catégorie | Statut | Détails |
|-----------|--------|---------|
| Indexes Neo4j | ✅ Corrigé | Entity ajouté à allContentLabels + 4 indexes |
| MULTI_EMBED_CONFIGS | ✅ Corrigé | Entity ajouté pour embeddings + vector indexes |
| NODE_SCHEMAS | ✅ Corrigé | Entity dans CONTENT_NODE_LABELS, NODE_SCHEMAS, FIELD_MAPPING |
| Propriétés système Entity | ✅ Corrigé | uuid, projectId, state, embeddingsDirty ajoutés |
| GLiNER v1 → v2 | ✅ Corrigé | Migration vers GLiNER2 avec schema builder |
| Relations extraction | ✅ Corrigé | Schema builder `.relations()` implémenté |
| Classification multi-label | ✅ Corrigé | `create_schema().classification()` implémenté |
| Déduplication hybride | ✅ Intégré | `deduplicateEntities()` appelé dans transform.ts |
| explore_depth Entity | ✅ Corrigé | `_name`, `entityType`, relations GLiNER2 visibles |

---

## 1. Indexes Neo4j ✅ CORRIGÉ

### 1.1 Fulltext Index ✅

**Fichier**: `packages/ragforge-core/src/brain/brain-manager.ts`

**Correction appliquée**: Entity ajouté à `allContentLabels`:

```typescript
const allContentLabels = [
  'Scope', 'File', 'DataFile', 'DocumentFile', 'PDFDocument', 'WordDocument',
  'SpreadsheetDocument', 'MarkdownDocument', 'MarkdownSection', 'MediaFile',
  'ImageFile', 'ThreeDFile', 'WebPage', 'CodeBlock', 'VueSFC', 'SvelteComponent',
  'Stylesheet', 'GenericFile', 'PackageJson', 'DataSection', 'WebDocument',
  'Entity',  // ✅ AJOUTÉ - Entity extraction nodes (GLiNER)
];
```

### 1.2 Regular Indexes ✅

**Correction appliquée**: 4 indexes ajoutés pour Entity:

```cypher
'CREATE INDEX entity_uuid IF NOT EXISTS FOR (n:Entity) ON (n.uuid)',
'CREATE INDEX entity_projectid IF NOT EXISTS FOR (n:Entity) ON (n.projectId)',
'CREATE INDEX entity_type IF NOT EXISTS FOR (n:Entity) ON (n.entityType)',
'CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n._name)',
```

### 1.3 Vector Indexes ✅

**Correction appliquée**: Entity ajouté à `MULTI_EMBED_CONFIGS` → vector indexes créés automatiquement.

---

## 2. Embedding Generation ✅ CORRIGÉ

### 2.1 MULTI_EMBED_CONFIGS ✅

**Fichier**: `packages/ragforge-core/src/brain/embedding-service.ts`

**Correction appliquée**: Configuration Entity ajoutée:

```typescript
// Entity extraction (GLiNER)
{
  label: 'Entity',
  query: `MATCH (e:Entity {projectId: $projectId})
          RETURN e.uuid AS uuid, e._name AS name, e._content AS content,
                 e.entityType AS entityType, e.normalized AS normalized,
                 e.embedding_name_hash AS embedding_name_hash,
                 e.embedding_content_hash AS embedding_content_hash,
                 e.embedding_provider AS embedding_provider,
                 e.embedding_model AS embedding_model,
                 e.${P.state} AS _state`,
  embeddings: buildEmbeddingConfigs('Entity', false),
},
```

---

## 3. SearchService ✅ CORRIGÉ

Entity est maintenant inclus dans `MULTI_EMBED_CONFIGS`, donc automatiquement inclus dans les requêtes de `brain_search`.

---

## 4. Propriétés Entity Nodes ✅ CORRIGÉ

### 4.1 Propriétés système ajoutées

**Fichier**: `packages/ragforge-core/src/ingestion/entity-extraction/transform.ts`

**Correction appliquée**:

```typescript
entityNodes.push({
  labels: ['Entity'],
  id: entityId,
  properties: {
    // ✅ Propriétés système ajoutées
    uuid: entityId,
    projectId: projectId,
    state: 'linked',
    embeddingsDirty: true,
    // Propriétés Entity
    _name: entity.name,
    _content: entity.name,
    entityType: entity.type,
    confidence: entity.confidence,
    normalized: normalizedName,
  },
});
```

---

## 5. Déduplication ✅ INTÉGRÉ

### 5.1 Module de déduplication

**Fichier**: `packages/ragforge-core/src/ingestion/entity-extraction/deduplication.ts`

Le module exporte 4 stratégies de déduplication:
- `findFuzzyDuplicates()` - Levenshtein distance
- `findEmbeddingDuplicates()` - Cosine similarity
- `buildLLMResolutionPrompt()` - Pour cas ambigus
- `deduplicateEntities()` - Stratégie hybride

### 5.2 Intégration dans transform.ts ✅

**Fichier**: `packages/ragforge-core/src/ingestion/entity-extraction/transform.ts`

```typescript
// Options de configuration
deduplication?: Partial<DeduplicationConfig> | false;
embedFunction?: (texts: string[]) => Promise<number[][]>;

// Après extraction, avant buildEntityGraph
const dedupResult = await deduplicateEntities(allEntities, {
  ...config.deduplication,
  embedFunction: config.embedFunction,
});
canonicalMapping = dedupResult.canonicalMapping;

// buildEntityGraph utilise le mapping canonique
const canonicalName = canonicalMapping?.get(normalizedOriginal) || originalName;
```

### 5.3 Fonctionnalités

- ✅ Déduplication fuzzy par défaut (threshold 0.85)
- ✅ Support pour stratégies embedding et hybrid (si embedFunction fourni)
- ✅ Mapping canonique appliqué aux Entity nodes
- ✅ Stats de déduplication dans les métadonnées
- ✅ Désactivable via `deduplication: false`

---

## 5b. explore_depth pour Entity ✅ CORRIGÉ

### Problème

La fonction `exploreRelationships()` dans `search-post-processor.ts` n'incluait pas les propriétés Entity :
- `_name` au lieu de `name`
- `entityType` au lieu de `type`
- `confidence` non extrait

### Corrections appliquées

**Fichier**: `packages/ragforge-core/src/brain/search-post-processor.ts`

1. **Requêtes Cypher mises à jour** :
```cypher
coalesce(related._name, related.name, related.title, related.signature) as relatedName,
coalesce(related.entityType, related.type, labels(related)[0]) as relatedType,
related.entityType as entityType,
related.confidence as confidence
```

2. **Interface GraphNode enrichie** :
```typescript
export interface GraphNode {
  // ... existing fields ...
  entityType?: string;
  confidence?: number;
}
```

3. **Construction des nodes** :
- Ajout de `entityType` et `confidence` aux nodes explorés
- Les relations extraites (WORKS_FOR, CEO_OF, etc.) sont maintenant visibles

### Fonctionnalités

- ✅ Entity nodes affichent leur nom correct (`_name`)
- ✅ Type d'entité visible (`entityType`: person, organization, etc.)
- ✅ Score de confiance inclus (`confidence`)
- ✅ Relations GLiNER2 explorables (WORKS_FOR, CEO_OF, MENTIONS, etc.)

---

## 6. GLiNER v1 → v2 Migration ✅ CORRIGÉ

### 6.1 Changements effectués

**Fichier**: `services/gliner-service/extractor.py`

| Aspect | Avant (v1) | Après (v2) |
|--------|-----------|------------|
| Import | `from gliner import GLiNER` | `from gliner2 import GLiNER2` |
| Extraction | `model.predict_entities(text, labels)` | `model.extract(text, schema)` |
| Relations | `relations = []` (TODO) | Schema builder `.relations()` |
| Classification | Heuristique mots-clés | `create_schema().classification()` |

### 6.2 Schema Builder implémenté

```python
# Entités + Relations en un appel
schema_builder = self.model.create_schema().entities(entity_types)
if relation_types:
    schema_builder = schema_builder.relations(relation_types)

raw_result = self.model.extract(text, schema)
# → {'entities': {...}, 'relation_extraction': {...}}
```

### 6.3 Classification multi-label implémentée

```python
schema = self.model.create_schema().classification(
    "domains",
    domain_labels,
    multi_label=True,
    cls_threshold=threshold
)
result = self.model.extract(text, schema)
# → {'domains': [{'label': 'tech', 'confidence': 0.92}, ...]}
```

### 6.4 Fallback heuristique conservé

En cas d'échec de la classification GLiNER2, un fallback heuristique par mots-clés est disponible.

---

## 7. Résumé des Corrections

### Fichiers TypeScript modifiés

| Fichier | Modification | Statut |
|---------|--------------|--------|
| `brain-manager.ts` | Entity dans allContentLabels + 4 indexes | ✅ |
| `embedding-service.ts` | Entity dans MULTI_EMBED_CONFIGS | ✅ |
| `node-schema.ts` | CONTENT_NODE_LABELS, NODE_SCHEMAS, FIELD_MAPPING | ✅ |
| `transform.ts` | Propriétés système (uuid, projectId, state, embeddingsDirty) | ✅ |

### Fichiers Python modifiés

| Fichier | Modification | Statut |
|---------|--------------|--------|
| `extractor.py` | Migration GLiNER2 API complète | ✅ |
| `models.py` | Pas de changement nécessaire | ✅ |
| `main.py` | Pas de changement nécessaire | ✅ |

---

## 8. Actions Restantes

### ✅ P2 - Complété

1. ~~**Déduplication hybride**~~ - ✅ Intégré dans `transform.ts`
2. ~~**explore_depth pour Entity**~~ - ✅ Corrigé dans `search-post-processor.ts`

### P3 - Enhancement (futures fonctionnalités)

1. **Dédup cross-batch** - Vérifier entités existantes en DB avant création
2. **Configuration YAML** - Comme prévu dans l'architecture
3. **Tests unitaires** - Pour le microservice Python

---

## 9. Commandes de Vérification

```bash
# Rebuild ragforge-core
cd /home/luciedefraiteur/LR_CodeRag/community-docs/packages/ragforge-core
npm run build

# Vérifier si Entity nodes existent (après ingestion)
echo "MATCH (e:Entity) RETURN count(e) AS count" | cypher-shell -a bolt://localhost:7688 -u neo4j -p ragforge

# Vérifier indexes Entity
echo "SHOW INDEXES WHERE labelsOrTypes = ['Entity']" | cypher-shell -a bolt://localhost:7688 -u neo4j -p ragforge

# Vérifier fulltext index inclut Entity
echo "SHOW FULLTEXT INDEXES WHERE name = 'unified_fulltext'" | cypher-shell -a bolt://localhost:7688 -u neo4j -p ragforge

# Tester le service GLiNER (après démarrage)
curl -X POST http://localhost:6971/extract \
  -H "Content-Type: application/json" \
  -d '{"text": "Tim Cook is the CEO of Apple Inc.", "entity_types": ["person", "organization"]}'

# Tester brain_search avec Entity
# Via MCP: brain_search({ query: "Tim Cook Apple", semantic: true, types: ["Entity"] })
```

---

## 10. Architecture Finale

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INGESTION PIPELINE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Parse file → Nodes (Scope, MarkdownSection, etc.)              │
│                        │                                            │
│                        ▼                                            │
│  2. GLiNER2 Service (Python, port 6971)                            │
│     ├─ create_schema().entities(...).relations(...)                │
│     ├─ extract(text, schema) → entities + relations                │
│     └─ create_schema().classification(...) → domain detection      │
│                        │                                            │
│                        ▼                                            │
│  3. Entity Transform (TypeScript)                                   │
│     ├─ buildEntityGraph() → Entity nodes avec propriétés système   │
│     └─ MENTIONS relationships vers source nodes                     │
│                        │                                            │
│                        ▼                                            │
│  4. Neo4j Storage                                                   │
│     ├─ Indexes: uuid, projectId, entityType, _name                 │
│     ├─ Fulltext: unified_fulltext (avec Entity)                    │
│     └─ Vector: embedding_name, embedding_content                    │
│                        │                                            │
│                        ▼                                            │
│  5. brain_search → Entity nodes trouvables !                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```
