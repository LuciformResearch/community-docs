# Entity Extraction Architecture

## Vue d'ensemble

Architecture pour l'extraction d'entités et relations dans RagForge, utilisant **GLiNER2** comme moteur principal (local, rapide, gratuit) avec fallback LLM optionnel.

## Objectifs

- **Performance** : ~100ms/document vs ~2-5s avec LLM
- **Coût** : Gratuit (local) vs ~$0.01/doc avec Claude
- **Flexibilité** : Types d'entités configurables **par domaine** (code, e-commerce, docs...)
- **Qualité** : Déduplication hybride (heuristique + embeddings + LLM)
- **Portabilité** : Utilisable dans ragforge-core ET community-docs

## Domaines supportés

L'extraction est configurable par domaine. Exemples :

| Domaine | Entités | Relations |
|---------|---------|-----------|
| **Code** | person, organization, technology, framework, api | uses, depends_on, created_by |
| **E-commerce** | product, price, brand, ingredient, certification, hair_type, benefit | compatible_with, complements, recommended_with, targets |
| **Documentation** | person, organization, concept, date, location | works_at, founded_by, located_in |
| **Juridique** | person, organization, law, court, date, amount | party_to, ruled_by, enacted_on |

---

## Auto-détection de domaine (Multi-label)

GLiNER2 supporte la **classification multi-label** pour détecter automatiquement le(s) domaine(s) d'un document et merger les presets correspondants.

### Flow

```
Document: "Apple announced new health monitoring features in their smartwatch, boosting stock price."
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. CLASSIFICATION (multi-label)                                 │
│                                                                 │
│    schema = extractor.create_schema().classification(           │
│        "domains",                                               │
│        ["technology", "business", "health", "ecommerce", ...],  │
│        multi_label=True,                                        │
│        cls_threshold=0.3                                        │
│    )                                                            │
│                                                                 │
│    → {'domains': [                                              │
│        {'label': 'technology', 'confidence': 0.92},             │
│        {'label': 'business', 'confidence': 0.78},               │
│        {'label': 'health', 'confidence': 0.65}                  │
│    ]}                                                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. MERGE PRESETS                                                │
│                                                                 │
│    detected_domains = ['technology', 'business', 'health']      │
│                                                                 │
│    merged_entity_types = set()                                  │
│    merged_relation_types = {}                                   │
│                                                                 │
│    for domain in detected_domains:                              │
│        preset = load_preset(domain)                             │
│        merged_entity_types.update(preset.entity_types)          │
│        merged_relation_types.update(preset.relation_types)      │
│                                                                 │
│    → entity_types: [product, technology, framework, api,        │
│                     company, price, stock, acquisition,         │
│                     condition, symptom, treatment, ingredient]  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. EXTRACT with merged schema                                   │
│                                                                 │
│    schema = extractor.create_schema()                           │
│        .entities(merged_entity_types)                           │
│        .relations(merged_relation_types)                        │
│                                                                 │
│    results = extractor.extract(text, schema)                    │
│                                                                 │
│    → entities: [                                                │
│        {name: "Apple", type: "company"},                        │
│        {name: "smartwatch", type: "product"},                   │
│        {name: "health monitoring", type: "technology"},         │
│        {name: "stock price", type: "stock"}                     │
│    ]                                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

```yaml
entity_extraction:
  # Auto-détection de domaine
  auto_detect_domain: true
  domain_threshold: 0.3        # Seuil pour inclure un domaine
  max_domains: 3               # Max domaines à merger

  # Domaines disponibles pour classification
  available_domains:
    - technology
    - business
    - ecommerce
    - health
    - legal
    - documentation
    - general

  # Fallback si aucun domaine détecté > threshold
  fallback_domain: general
```

### Avantages

- **Pas besoin de spécifier le preset** - auto-détecté
- **Documents multi-thèmes** - merge intelligent des entity types
- **Confidence scores** - filtrer les domaines peu pertinents
- **Fallback** - preset générique si aucun domaine détecté

### Optimisation : Batch par combinaison de domaines

Pour maximiser l'efficacité du batch processing, on regroupe les documents qui ont **la même combinaison de domaines** :

```python
from collections import defaultdict

def process_documents_optimized(documents: list[str], extractor) -> list[dict]:
    """
    1. Classifier tous les documents (batch)
    2. Grouper par combinaison de domaines (triée pour consistance)
    3. Batch extract par groupe
    """

    # 1. Classification batch de tous les documents
    classification_schema = extractor.create_schema().classification(
        "domains",
        AVAILABLE_DOMAINS,
        multi_label=True,
        cls_threshold=0.3
    )
    classifications = extractor.batch_extract(documents, classification_schema)

    # 2. Grouper par domain_key (tuple trié pour consistance)
    # IMPORTANT: sorted() garantit que ["tech", "business"] == ["business", "tech"]
    batches: dict[tuple[str, ...], list[tuple[int, str]]] = defaultdict(list)

    for idx, (doc, classification) in enumerate(zip(documents, classifications)):
        domains = [d['label'] for d in classification.get('domains', [])]
        if not domains:
            domains = [FALLBACK_DOMAIN]

        # Clé triée alphabétiquement pour matching consistant
        domain_key = tuple(sorted(domains))
        batches[domain_key].append((idx, doc))

    # 3. Traiter chaque batch avec son schema mergé
    results = [None] * len(documents)

    for domain_key, indexed_docs in batches.items():
        # Merger les presets pour cette combinaison
        merged_schema = merge_presets_for_domains(domain_key, extractor)

        # Extraire les docs de ce batch
        docs_batch = [doc for _, doc in indexed_docs]
        indices = [idx for idx, _ in indexed_docs]

        # Batch extraction
        batch_results = extractor.batch_extract(docs_batch, merged_schema)

        # Remettre les résultats à leur position originale
        for idx, result in zip(indices, batch_results):
            result['detected_domains'] = list(domain_key)
            results[idx] = result

    return results


def merge_presets_for_domains(domain_key: tuple[str, ...], extractor) -> Schema:
    """
    Merge les presets de tous les domaines dans domain_key.
    """
    merged_entities = set()
    merged_relations = {}

    for domain in domain_key:
        preset = load_preset(domain)
        merged_entities.update(preset.entity_types)
        merged_relations.update(preset.relation_types)

    return (extractor.create_schema()
        .entities(list(merged_entities))
        .relations(merged_relations)
    )
```

**Exemple concret :**

```
Documents à traiter:
  doc1: "Apple lance iPhone 15"           → domains: [business, technology]
  doc2: "Tesla annonce Model Y"           → domains: [business, technology]
  doc3: "Shampoing bio cheveux secs"      → domains: [ecommerce, health]
  doc4: "Microsoft acquiert Activision"   → domains: [business, technology]
  doc5: "Crème hydratante visage"         → domains: [ecommerce, health]

Après groupement (domain_key trié):
  ("business", "technology"): [doc1, doc2, doc4]  → 1 batch, 1 schema
  ("ecommerce", "health"):    [doc3, doc5]        → 1 batch, 1 schema

Résultat: 2 appels batch au lieu de 5 appels individuels
```

**Avantages du batching par domaine :**

| Aspect | Sans optimisation | Avec optimisation |
|--------|-------------------|-------------------|
| Appels GLiNER | N (un par doc) | K (un par combinaison unique) |
| Changements de schema | N | K |
| Utilisation GPU/CPU | Sous-optimale | Maximisée |
| Latence totale | O(N) | O(K + N/batch_size) |

Où K << N (nombre de combinaisons uniques << nombre de documents)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INGESTION PIPELINE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Parse file → Nodes (Scope, MarkdownSection, etc.)              │
│                        │                                            │
│                        ▼                                            │
│  2. GLiNER Service (Python) ◄─── Fast, local, ~100ms/doc           │
│     ├─ extract_entities(text, types)                               │
│     └─ extract_relations(text, entities)                           │
│                        │                                            │
│                        ▼                                            │
│  3. Store RAW entities/relations (avec source node, spans)         │
│     Entity { name, type, confidence, sourceNodeId, span }          │
│     Relation { subject, predicate, object, confidence }            │
│                        │                                            │
│                        ▼                                            │
│  4. Deduplication (configurable, batch en fin d'ingestion)         │
│     ├─ FAST: Fuzzy string (Levenshtein) + même type                │
│     ├─ MEDIUM: Embedding similarity (réutilise embeddings)         │
│     └─ ACCURATE: LLM single call (groupes ambigus seulement)       │
│                        │                                            │
│                        ▼                                            │
│  5. Canonical Entities + MENTIONS/RELATION relationships           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## GLiNER2

### Qu'est-ce que c'est ?

[GLiNER2](https://github.com/fastino-ai/GLiNER2) est un modèle NER (Named Entity Recognition) open-source :

- **205M paramètres** - Tourne sur CPU sans problème
- **Schema-based** - Types d'entités personnalisables
- **Multi-tâches** - NER + Classification + Relations + Structured extraction
- **Confidence scores** - Score de confiance pour chaque extraction
- **Spans** - Position exacte dans le texte source

### Installation

```bash
pip install gliner2
```

### Usage basique (entities seulement)

```python
from gliner2 import GLiNER2

extractor = GLiNER2.from_pretrained("fastino/gliner2-base-v1")

text = "Apple CEO Tim Cook announced iPhone 15 for $999 in Cupertino."
entities = extractor.extract_entities(
    text,
    ["person", "organization", "product", "location", "price"],
    include_confidence=True,
    include_spans=True
)
```

### Usage optimal : Schema Builder (entities + relations en un appel)

```python
from gliner2 import GLiNER2

extractor = GLiNER2.from_pretrained("fastino/gliner2-base-v1")

text = """
Elon Musk founded SpaceX in 2002. SpaceX is located in Hawthorne, California.
SpaceX acquired Swarm Technologies in 2021. Many engineers work for SpaceX.
"""

# Schema avec descriptions pour les relations (améliore la qualité)
schema = (extractor.create_schema()
    .entities(["person", "organization", "location", "date", "price"])
    .relations({
        "founded": "Founding relationship where person created organization",
        "acquired": "Acquisition relationship where company bought another",
        "located_in": "Geographic relationship where entity is in a location",
        "works_for": "Employment relationship where person works at organization",
        "costs": "Pricing relationship where product/service has a price"
    })
)

results = extractor.extract(text, schema)
# Output:
# {
#     'entities': {
#         'person': ['Elon Musk', 'engineers'],
#         'organization': ['SpaceX', 'Swarm Technologies'],
#         'location': ['Hawthorne, California'],
#         'date': ['2002', '2021']
#     },
#     'relation_extraction': {
#         'founded': [('Elon Musk', 'SpaceX')],
#         'acquired': [('SpaceX', 'Swarm Technologies')],
#         'located_in': [('SpaceX', 'Hawthorne, California')],
#         'works_for': [('engineers', 'SpaceX')]
#     }
# }
```

### Batch Processing (optimal pour l'ingestion)

```python
# Batch extraction - process multiple texts efficiently
texts = [
    "Google's Sundar Pichai unveiled Gemini AI in Mountain View.",
    "Microsoft CEO Satya Nadella announced Copilot at Build 2023.",
    "Amazon's Andy Jassy revealed new AWS services in Seattle."
]

# Batch entities avec confidence et spans
results = extractor.batch_extract_entities(
    texts,
    ["company", "person", "product", "location"],
    include_confidence=True,
    include_spans=True,
    batch_size=8  # Ajuster selon GPU/CPU
)
# Returns: list of results, one per input text

# Batch relations
relation_results = extractor.batch_extract_relations(
    texts,
    ["works_for", "founded", "announced", "located_in"],
    batch_size=8
)
# Returns: list of relation results for each text
# All requested relation types appear in each result, even if empty
```

### Stratégie optimale pour RagForge

```python
# Combiner batch + schema pour max efficacité
def extract_batch_with_schema(texts: list[str], config: dict) -> list[dict]:
    """
    Extraction optimale : batch + schema en un seul appel par batch.
    """
    schema = (extractor.create_schema()
        .entities(config["entity_types"])
        .relations({
            rel: config["relation_descriptions"].get(rel, rel)
            for rel in config["relation_types"]
        })
    )

    results = []
    for i in range(0, len(texts), config["batch_size"]):
        batch = texts[i:i + config["batch_size"]]
        batch_results = extractor.batch_extract(batch, schema)
        results.extend(batch_results)

    return results
```

---

## Schema Neo4j (Dynamique)

### Noeud Entity (générique)

```cypher
CREATE (e:Entity {
  uuid: "entity-uuid-123",
  name: "Tim Cook",
  normalizedName: "tim cook",
  entityType: "person",           // Dynamique - configuré par l'utilisateur
  aliases: ["Timothy D. Cook", "Timothy Cook"],
  confidence: 0.95,
  properties: {                   // Props spécifiques au type (JSON)
    role: "CEO",
    organization: "Apple"
  },
  embedding: [0.1, 0.2, ...],     // Pour recherche sémantique
  projectIds: ["project-1"],
  createdAt: datetime(),
  updatedAt: datetime()
})
```

### Relations extraites

```cypher
// Relation entre entités (type dynamique)
(e1:Entity)-[:RELATION {
  type: "works_at",               // Dynamique
  confidence: 0.87,
  sourceNodeId: "scope-uuid"
}]->(e2:Entity)

// Mention dans un noeud source
(s:Scope)-[:MENTIONS {
  span: [10, 18],
  confidence: 0.95,
  context: "...CEO Tim Cook announced..."  // Optionnel
}]->(e:Entity)
```

### Index recommandés

```cypher
// Pour la recherche
CREATE INDEX entity_type FOR (e:Entity) ON (e.entityType);
CREATE INDEX entity_name FOR (e:Entity) ON (e.normalizedName);
CREATE FULLTEXT INDEX entity_search FOR (e:Entity) ON EACH [e.name, e.aliases];

// Pour les embeddings (vector search)
CREATE VECTOR INDEX entity_embedding FOR (e:Entity) ON (e.embedding)
OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}};
```

---

## Configuration

### Fichier de configuration

```yaml
# ragforge.config.yaml ou entity-extraction.yaml

entity_extraction:
  enabled: true

  # Provider principal
  provider: gliner           # 'gliner' | 'llm'
  gliner_endpoint: "http://localhost:8100"  # Si microservice séparé

  # Types d'entités à extraire (passés à GLiNER)
  entity_types:
    # Personnes et organisations
    - person
    - organization

    # Lieux
    - location

    # Tech
    - technology
    - programming_language
    - framework
    - library
    - api

    # Produits et business
    - product
    - service
    - price                  # Prix, coûts, tarifs

    # Concepts
    - concept
    - methodology

    # Temporel
    - date
    - event
    - deadline

  # Types de relations à extraire (avec descriptions pour GLiNER)
  relation_types:
    works_at: "Employment relationship where person works at organization"
    founded_by: "Founding relationship where person created organization"
    created_by: "Creation relationship where person/org created something"
    uses: "Usage relationship where entity uses technology/tool"
    depends_on: "Dependency relationship where entity requires another"
    located_in: "Geographic relationship where entity is in a location"
    part_of: "Hierarchical relationship where entity belongs to another"
    costs: "Pricing relationship where product/service has a price"
    released_on: "Temporal relationship where product was released on date"
    acquired_by: "Acquisition relationship where company bought another"

  # Configuration de la déduplication
  deduplication:
    strategy: hybrid         # 'fuzzy' | 'embedding' | 'llm' | 'hybrid'

---

# Presets par domaine

## Preset: E-commerce (Produits)

```yaml
# entity-extraction-ecommerce.yaml
entity_extraction:
  enabled: true
  provider: gliner
  preset: ecommerce

  entity_types:
    # Produit
    - product
    - brand
    - price
    - sku

    # Attributs produit (domain-specific)
    - ingredient
    - certification       # Ecocert, Bio, Vegan...
    - hair_type           # Cheveux secs, bouclés...
    - skin_type           # Peau grasse, sensible...
    - benefit             # Hydratation, Réparation...
    - texture
    - scent
    - usage_frequency     # Quotidien, Hebdomadaire...
    - duration            # 2-3 mois d'utilisation

    # Organisation
    - brand
    - manufacturer
    - distributor

  relation_types:
    compatible_with: "Products that work well together"
    complements: "Products that complete each other in a routine"
    recommended_with: "Products often bought together"
    targets: "Customer segment or need the product addresses"
    specialized_for: "Specific condition or type the product is made for"
    contains: "Ingredient contained in product"
    certified_by: "Certification label for product"
    variant_of: "Product variant relationship"
    cross_sell: "Cross-selling relationship"
    bundle_with: "Products bundled together"

  # Schémas spécifiques e-commerce
  type_schemas:
    product:
      properties:
        - name
        - sku
        - price
        - stock
        - category
        - variants

    price:
      properties:
        - amount
        - currency
        - period          # per unit, per month...
        - original_price  # pour les promos
        - discount

    ingredient:
      properties:
        - name
        - percentage
        - origin          # naturel, synthétique
        - benefit

    certification:
      properties:
        - name
        - issuer
        - valid_until
```

## Preset: Code / Tech

```yaml
# entity-extraction-code.yaml
entity_extraction:
  enabled: true
  provider: gliner
  preset: code

  entity_types:
    - person
    - organization
    - technology
    - programming_language
    - framework
    - library
    - api
    - database
    - protocol
    - version
    - price              # Pour SaaS/pricing

  relation_types:
    uses: "Technology or library usage"
    depends_on: "Dependency relationship"
    created_by: "Creator/author relationship"
    maintained_by: "Maintainer relationship"
    replaces: "Technology replacement"
    compatible_with: "Compatibility relationship"
    integrates_with: "Integration relationship"
    costs: "Pricing relationship"
```

## Preset: Documentation générale

```yaml
# entity-extraction-docs.yaml
entity_extraction:
  enabled: true
  provider: gliner
  preset: docs

  entity_types:
    - person
    - organization
    - location
    - date
    - event
    - concept
    - price

  relation_types:
    works_at: "Employment relationship"
    founded_by: "Founding relationship"
    located_in: "Geographic relationship"
    happened_on: "Temporal relationship"
    part_of: "Hierarchical relationship"
    related_to: "General relationship"
```

---

    # Seuils pour fuzzy matching (Levenshtein)
    fuzzy_threshold: 0.85

    # Seuils pour similarité embedding
    embedding_threshold: 0.90

    # Pour 'hybrid': range où on fait appel au LLM
    # < 0.75 = différent, > 0.90 = identique, entre = ambigu → LLM
    llm_fallback_range: [0.75, 0.90]

    # Batch size pour l'appel LLM final
    llm_batch_size: 50

  # Schémas par type (propriétés attendues/extraites)
  type_schemas:
    person:
      properties:
        - role
        - title
        - email
        - organization

    organization:
      properties:
        - type           # company, nonprofit, government, etc.
        - industry
        - website
        - location

    technology:
      properties:
        - category       # language, framework, library, tool, etc.
        - version
        - docs_url
        - repo_url

    price:
      properties:
        - amount
        - currency
        - period         # per month, per year, one-time, etc.
        - tier           # free, basic, pro, enterprise, etc.

    location:
      properties:
        - type           # city, country, region, address, etc.
        - parent         # ex: Paris → France
        - coordinates

  # Filtres
  filters:
    min_confidence: 0.6      # Ignorer entités avec confidence < 0.6
    min_name_length: 2       # Ignorer noms trop courts
    exclude_patterns:        # Regex pour exclure
      - "^[0-9]+$"           # Nombres seuls
      - "^(the|a|an)$"       # Articles
```

### Configuration programmatique (TypeScript)

```typescript
import { EntityExtractionConfig } from '@luciformresearch/ragforge';

const config: EntityExtractionConfig = {
  enabled: true,
  provider: 'gliner',
  glinerEndpoint: 'http://localhost:8100',

  entityTypes: [
    'person', 'organization', 'location',
    'technology', 'product', 'price', 'concept'
  ],

  relationTypes: [
    'works_at', 'uses', 'depends_on', 'costs'
  ],

  deduplication: {
    strategy: 'hybrid',
    fuzzyThreshold: 0.85,
    embeddingThreshold: 0.90,
    llmFallbackRange: [0.75, 0.90]
  }
};
```

---

## Types TypeScript

```typescript
// ragforge-core/src/runtime/entity-extraction/types.ts

/**
 * Entité extraite par GLiNER
 */
export interface ExtractedEntity {
  /** Texte de l'entité */
  name: string;

  /** Type d'entité (dynamique, configuré par l'utilisateur) */
  type: string;

  /** Score de confiance [0-1] */
  confidence: number;

  /** Position dans le texte source [start, end] */
  span?: [number, number];

  /** Noms alternatifs détectés */
  aliases?: string[];

  /** Propriétés spécifiques au type */
  properties?: Record<string, unknown>;
}

/**
 * Relation extraite entre deux entités
 */
export interface ExtractedRelation {
  /** Entité source */
  subject: string;

  /** Type de relation (dynamique) */
  predicate: string;

  /** Entité cible */
  object: string;

  /** Score de confiance [0-1] */
  confidence: number;

  /** Position dans le texte source */
  span?: [number, number];
}

/**
 * Résultat d'extraction pour un document/noeud
 */
export interface ExtractionResult {
  /** ID du noeud source */
  sourceNodeId: string;

  /** Type du noeud source */
  sourceNodeType: string;

  /** Entités extraites */
  entities: ExtractedEntity[];

  /** Relations extraites */
  relations: ExtractedRelation[];

  /** Temps de traitement (ms) */
  processingTimeMs: number;
}

/**
 * Configuration de l'extraction d'entités
 */
export interface EntityExtractionConfig {
  enabled: boolean;
  provider: 'gliner' | 'llm';
  glinerEndpoint?: string;

  entityTypes: string[];
  relationTypes?: string[];

  deduplication: DeduplicationConfig;

  typeSchemas?: Record<string, {
    properties: string[];
  }>;

  filters?: {
    minConfidence?: number;
    minNameLength?: number;
    excludePatterns?: string[];
  };
}

/**
 * Configuration de la déduplication
 */
export interface DeduplicationConfig {
  strategy: 'fuzzy' | 'embedding' | 'llm' | 'hybrid';

  fuzzyThreshold?: number;        // Default: 0.85
  embeddingThreshold?: number;    // Default: 0.90
  llmFallbackRange?: [number, number];  // Default: [0.75, 0.90]
  llmBatchSize?: number;          // Default: 50
}

/**
 * Entité canonique (après déduplication)
 */
export interface CanonicalEntity {
  uuid: string;
  name: string;
  normalizedName: string;
  entityType: string;
  aliases: string[];
  properties: Record<string, unknown>;
  embedding?: number[];
  projectIds: string[];
  mentionCount: number;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Structure des fichiers

```
ragforge-core/
├── src/
│   └── runtime/
│       └── entity-extraction/           # NOUVEAU MODULE
│           ├── index.ts                 # Exports publics
│           ├── types.ts                 # Types partagés
│           ├── gliner-client.ts         # Client HTTP vers microservice
│           ├── entity-deduplicator.ts   # Stratégies de dédup
│           ├── entity-store.ts          # CRUD Neo4j pour Entity
│           └── extraction-pipeline.ts   # Orchestration
│
community-docs/
├── services/
│   └── gliner-service/                  # MICROSERVICE PYTHON
│       ├── main.py                      # FastAPI server (port 8100)
│       ├── extractor.py                 # GLiNER2 wrapper
│       ├── models.py                    # Pydantic models
│       ├── config.py                    # Configuration
│       ├── requirements.txt
│       ├── Dockerfile
│       └── README.md
│
├── docs/
│   └── entity-extraction-architecture.md  # Ce fichier
```

---

## API du microservice GLiNER

### Endpoints

```
POST /extract/entities
POST /extract/relations
POST /extract/all          # Entities + Relations en un appel
GET  /health
GET  /config               # Types configurés
```

### Exemple requête/réponse

```bash
POST /extract/all
Content-Type: application/json

{
  "text": "Apple CEO Tim Cook announced iPhone 15 for $999 in Cupertino.",
  "entity_types": ["person", "organization", "product", "location", "price"],
  "relation_types": ["works_at", "costs", "located_in"],
  "include_spans": true
}
```

```json
{
  "entities": [
    {"name": "Tim Cook", "type": "person", "confidence": 0.95, "span": [10, 18]},
    {"name": "Apple", "type": "organization", "confidence": 0.98, "span": [0, 5]},
    {"name": "iPhone 15", "type": "product", "confidence": 0.92, "span": [29, 38]},
    {"name": "Cupertino", "type": "location", "confidence": 0.89, "span": [52, 61]},
    {"name": "$999", "type": "price", "confidence": 0.94, "span": [43, 47], "properties": {"amount": 999, "currency": "USD"}}
  ],
  "relations": [
    {"subject": "Tim Cook", "predicate": "works_at", "object": "Apple", "confidence": 0.91},
    {"subject": "iPhone 15", "predicate": "costs", "object": "$999", "confidence": 0.88}
  ],
  "processing_time_ms": 87
}
```

---

## Stratégies de déduplication

### 1. Fuzzy (rapide, basique)

```typescript
// Levenshtein distance sur noms normalisés
// Même type requis
function fuzzyMatch(a: Entity, b: Entity): number {
  if (a.type !== b.type) return 0;
  return levenshteinSimilarity(
    a.normalizedName,
    b.normalizedName
  );
}
```

### 2. Embedding (précis, utilise vecteurs existants)

```typescript
// Cosine similarity sur embeddings
// Réutilise les embeddings générés pour la recherche
async function embeddingMatch(a: Entity, b: Entity): Promise<number> {
  if (a.type !== b.type) return 0;
  return cosineSimilarity(a.embedding, b.embedding);
}
```

### 3. LLM (très précis, coûteux)

```typescript
// Un seul appel LLM pour un batch de candidats ambigus
async function llmDeduplication(
  candidates: Array<{a: Entity, b: Entity, similarity: number}>
): Promise<Map<string, string>> {
  const prompt = buildDeduplicationPrompt(candidates);
  const result = await llm.call(prompt);
  return parseDeduplicationResult(result);
}
```

### 4. Hybrid (recommandé)

```typescript
async function hybridDeduplication(entities: Entity[]): Promise<CanonicalEntity[]> {
  // 1. Grouper par type
  const byType = groupBy(entities, 'type');

  // 2. Pour chaque type, calculer similarités
  for (const [type, group] of byType) {
    const pairs = getAllPairs(group);

    for (const [a, b] of pairs) {
      const fuzzySim = fuzzyMatch(a, b);

      if (fuzzySim > 0.90) {
        // Clairement identique → merge
        merge(a, b);
      } else if (fuzzySim > 0.75) {
        // Ambigu → vérifier avec embedding
        const embSim = await embeddingMatch(a, b);

        if (embSim > 0.90) {
          merge(a, b);
        } else if (embSim > 0.75) {
          // Encore ambigu → ajouter au batch LLM
          addToLLMBatch(a, b, embSim);
        }
      }
      // < 0.75 → clairement différent, rien à faire
    }
  }

  // 3. Résoudre les cas ambigus avec LLM (un seul appel)
  await resolveLLMBatch();

  return buildCanonicalEntities();
}
```

---

## Intégration dans l'ingestion

### Dans ragforge-core (incremental-ingestion.ts)

```typescript
// Après parsing, avant embeddings
if (config.entityExtraction?.enabled) {
  const extractor = new EntityExtractor(config.entityExtraction);

  for (const node of parsedNodes) {
    if (node.content) {
      const result = await extractor.extract(node.content);

      // Stocker les entités brutes
      await storeRawEntities(result.entities, node.uuid);
      await storeRawRelations(result.relations, node.uuid);
    }
  }
}

// En fin d'ingestion (batch)
if (config.entityExtraction?.deduplication) {
  const deduplicator = new EntityDeduplicator(config.entityExtraction.deduplication);
  await deduplicator.run(projectId);
}
```

---

## TODO

- [ ] Créer le microservice Python GLiNER (`services/gliner-service/`)
- [ ] Implémenter `gliner-client.ts` dans ragforge-core
- [ ] Implémenter `entity-deduplicator.ts` avec les 4 stratégies
- [ ] Intégrer dans `incremental-ingestion.ts`
- [ ] Ajouter configuration YAML
- [ ] Créer le service systemd pour gliner-service
- [ ] Tests unitaires et d'intégration
- [ ] Adapter community-docs pour utiliser le nouveau système
