# Community Docs - Contexte Complet

> Ce fichier résume l'architecture et le travail effectué sur community-docs.
> Dernière mise à jour: 2026-01-14

---

## Vue d'Ensemble

Community-docs est un hub de documentation avec intégration RagForge pour:
- **Ingestion** de documents (markdown, code, PDF, images, 3D)
- **Recherche sémantique** avec embeddings Ollama
- **Extraction d'entités** via GLiNER2
- **Chat** avec agent Claude (Vercel AI SDK)

---

## Architecture des Fichiers

```
community-docs/
├── lib/ragforge/                      # Code principal
│   ├── api/
│   │   ├── server.ts                  # API Fastify (port 6970)
│   │   └── routes/
│   │       ├── chat.ts                # Chat avec Claude
│   │       ├── vision.ts              # Analyse images/PDF/3D
│   │       └── lucie.ts               # Agent Lucie
│   ├── orchestrator-adapter.ts        # Orchestration ingestion + entity extraction
│   ├── neo4j-client.ts                # Connexion Neo4j
│   ├── embedding-service.ts           # Ollama embeddings (mxbai-embed-large)
│   ├── enrichment-service.ts          # Enrichissement LLM
│   ├── entity-resolution-service.ts   # Déduplication entités
│   ├── entity-embedding-service.ts    # Embeddings + recherche entités
│   ├── parsers.ts                     # Parsers de fichiers
│   ├── logger.ts                      # Logger vers fichiers
│   ├── types.ts                       # Types TypeScript
│   └── index.ts                       # Exports publics
├── packages/ragforge-core/            # Submodule ragforge-core
│   ├── src/brain/transforms/
│   │   └── entity-extraction/         # Transform extraction entités
│   │       ├── index.ts
│   │       ├── client.ts              # Client HTTP vers GLiNER
│   │       ├── deduplication.ts       # Déduplication fuzzy + embeddings
│   │       └── types.ts
│   └── services/gliner_service/       # Service Python GLiNER2
│       ├── main.py                    # FastAPI (port 6971)
│       ├── extractor.py               # GLiNER2 extraction
│       ├── config.py                  # Configuration
│       ├── models.py                  # Pydantic models
│       └── entity-extraction.yaml     # Domain presets
└── tests/
    ├── test-entity-extraction.ts      # Script de test
    └── fixtures/entity-extraction/    # Fichiers markdown de test
```

---

## Services Systemd

### community-docs-api (port 6970)

```bash
sudo systemctl status community-docs-api
sudo systemctl restart community-docs-api
sudo journalctl -u community-docs-api -f
```

**Fichier:** `/etc/systemd/system/community-docs-api.service`
**Logs:** `~/.ragforge/logs/community-docs/api.log`
**Variable:** `RAGFORGE_VERBOSE=true` pour logs entity extraction

### gliner-service (port 6971)

```bash
sudo systemctl status gliner-service
sudo systemctl restart gliner-service
sudo journalctl -u gliner-service -f
```

**Fichier:** `/etc/systemd/system/gliner-service.service`
**Logs:** `~/.ragforge/logs/gliner-service/gliner.log`
**Modèle:** `fastino/gliner2-large-v1`

### Neo4j (port 7688)

- Bolt: `bolt://localhost:7688`
- Browser: http://localhost:7475
- Séparé du CLI RagForge (qui utilise 7687)

---

## API Endpoints (port 6970)

### Health & Status

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Status détaillé (uptime, requests, etc.) |

### Ingestion

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/ingest` | POST | Ingérer un fichier unique |
| `/ingest/batch` | POST | Ingérer plusieurs fichiers |
| `/ingest/github` | POST | Ingérer depuis GitHub |
| `/ingest/upload` | POST | Upload multipart |

**Body `/ingest/batch`:**
```json
{
  "files": [
    { "filePath": "doc.md", "content": "base64..." }
  ],
  "metadata": {
    "documentId": "doc-123",
    "documentTitle": "Mon Document",
    "authorId": "user-1",
    "categoryId": "cat-1",
    "categorySlug": "ma-categorie"
  },
  "generateEmbeddings": true,
  "extractEntities": true
}
```

### Recherche

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/search` | POST | Recherche sémantique/hybride |

**Body `/search`:**
```json
{
  "query": "authentication logic",
  "semantic": true,
  "hybrid": true,
  "limit": 20,
  "minScore": 0.3,
  "filters": {
    "categorySlug": "docs",
    "documentId": "doc-123"
  },
  "boostKeywords": ["AuthService", "login"],
  "exploreDepth": 1,
  "summarize": false,
  "rerank": false,
  "format": "json"
}
```

**Réponse:**
```json
{
  "success": true,
  "query": "...",
  "results": [
    {
      "documentId": "...",
      "content": "...",
      "score": 0.85,
      "sourcePath": "src/auth.ts",
      "nodeType": "MarkdownSection",
      "position": { "startLine": 10, "endLine": 25 },
      "metadata": { "documentTitle": "...", "categorySlug": "..." }
    }
  ],
  "count": 5,
  "totalCount": 42
}
```

### Documents

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/document/:documentId` | DELETE | Supprimer un document |

### Entités

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/entities/stats` | GET | Statistiques entités |
| `/admin/generate-entity-embeddings` | POST | Générer embeddings entités |

### Administration

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/indexes/ensure-vector` | POST | Créer indexes Neo4j |
| `/cypher` | POST | Exécuter requête Cypher |
| `/parsers/extensions` | GET | Extensions supportées |
| `/shutdown` | POST | Arrêter le serveur |

---

## Entity Extraction avec GLiNER2

### Flow d'Extraction

```
1. Client appelle POST /ingest/batch avec extractEntities: true
2. orchestrator-adapter.ts crée EntityExtractionTransform
3. Transform appelle http://localhost:6971/extract/batch
4. GLiNER2 extrait entities + relations
5. Déduplication (fuzzy + embeddings)
6. Création nodes Entity + relations MENTIONS dans Neo4j
```

### Domain Presets (entity-extraction.yaml)

| Domaine | Entity Types | Relation Types |
|---------|--------------|----------------|
| ecommerce | product, brand, price, ingredient, certification | contains, certified_by, priced_at |
| code | function, class, module, library, api_endpoint | calls, imports, depends_on |
| documentation | concept, feature, requirement, specification | implements, requires |
| legal | person, organization, contract, clause, date, amount | party_to, grants_right |

### Déduplication

Stratégie hybride:
- **Fuzzy matching** (Levenshtein): threshold 0.85
- **Embedding similarity**: threshold 0.9
- Normalisation: lowercase, trim, remove suffixes (Inc., Corp.)

Exemple: "Tim Cook", "Timothy Cook", "tim cook" → 1 seule entité

### Configuration verbose

Dans `orchestrator-adapter.ts` ligne ~460:
```typescript
transformGraph: createEntityExtractionTransform({
  serviceUrl: 'http://localhost:6971',
  autoDetectDomain: true,
  confidenceThreshold: 0.5,
  verbose: process.env.RAGFORGE_VERBOSE === 'true',
  deduplication: {
    strategy: 'hybrid',
    fuzzyThreshold: 0.85,
    embeddingThreshold: 0.9,
  },
  projectId,
}),
```

---

## Embeddings

### Service Ollama

- **Modèle:** mxbai-embed-large (1024 dimensions)
- **URL:** http://localhost:11434
- **Configuration:** `embedding-service.ts`

### Types d'embeddings

Chaque node peut avoir jusqu'à 3 embeddings:
- `_nameEmbedding`: nom/titre (pour chercher "find the auth function")
- `_contentEmbedding`: contenu code/texte
- `_descriptionEmbedding`: docstrings, descriptions

---

## Recherche Sémantique

### Options de recherche

| Option | Description |
|--------|-------------|
| `semantic` | Utiliser embeddings (default: true) |
| `hybrid` | Combiner BM25 + embeddings (default: true) |
| `embeddingType` | "name", "content", "description", "all" |
| `boostKeywords` | Keywords à booster (fuzzy matching) |
| `exploreDepth` | Explorer relations (0-3) |
| `summarize` | Résumer avec LLM |
| `rerank` | Reranker avec LLM |

### Post-processing

L'orchestrator peut appliquer:
1. **Keyword boosting** - boost results contenant certains mots
2. **Entity boosting** - boost si entities matchent
3. **Relation exploration** - suivre CONSUMES/CONSUMED_BY
4. **Summarization** - résumer avec Gemini
5. **Reranking** - réordonner avec Gemini

---

## Logs

```
~/.ragforge/logs/
├── community-docs/
│   ├── api.log          # Logs API principale
│   ├── pipeline.log     # Logs ingestion
│   └── error.log        # Erreurs uniquement
└── gliner-service/
    └── gliner.log       # Logs GLiNER2
```

Suivre tous les logs:
```bash
tail -f ~/.ragforge/logs/community-docs/api.log ~/.ragforge/logs/gliner-service/gliner.log
```

---

## Tests Entity Extraction

### Fichiers de test

```
tests/fixtures/entity-extraction/
├── domains/
│   ├── ecommerce-product-catalog.md    # Produits, marques, prix
│   ├── code-api-documentation.md       # Fonctions, classes, modules
│   ├── documentation-requirements.md   # Concepts, features, specs
│   └── legal-contract-sample.md        # Personnes, orgs, clauses
└── deduplication/
    ├── company-news-apple.md           # "Tim Cook", "Apple Inc."
    ├── tech-review-apple.md            # "Tim Cook", "Apple"
    └── financial-report-tech.md        # "Timothy Cook", "Apple Inc"
```

### Lancer les tests

```bash
cd /home/luciedefraiteur/LR_CodeRag/community-docs
npx tsx tests/test-entity-extraction.ts
```

### Critères de succès

| Critère | Attendu |
|---------|---------|
| Entités créées | >= 30 |
| Relations MENTIONS | >= 40 |
| "Tim Cook" dédupliqué | 1 seule entité |
| "Apple" dédupliqué | 1 seule entité |

---

## Requêtes Cypher Utiles

```cypher
-- Compter entités par type
MATCH (e:Entity)
RETURN e.entityType, count(e) as count
ORDER BY count DESC;

-- Vérifier déduplication Tim Cook
MATCH (e:Entity)
WHERE e._name CONTAINS 'Tim' OR e._name CONTAINS 'Cook'
RETURN e._name, e.entityType, e.confidence;

-- Relations MENTIONS
MATCH (d)-[m:MENTIONS]->(e:Entity)
RETURN labels(d)[0] as sourceType, e._name, count(m) as mentions
ORDER BY mentions DESC LIMIT 20;

-- Relations entity-to-entity
MATCH (e1:Entity)-[r]->(e2:Entity)
WHERE type(r) <> 'MENTIONS'
RETURN type(r), e1._name, e2._name LIMIT 50;

-- Stats globales
MATCH (n) RETURN labels(n)[0] as label, count(n) as count ORDER BY count DESC;
```

---

## Dépendances Python (GLiNER)

```bash
pip install gliner2 fastapi uvicorn pydantic pydantic-settings pyyaml
```

Le modèle `fastino/gliner2-large-v1` (~1-2GB) est téléchargé automatiquement au premier démarrage.

---

## TODO

- [ ] Tester ingestion complète avec fichiers de test
- [ ] Vérifier logs [EntityExtraction] dans l'API
- [ ] Valider déduplication dans Neo4j
- [ ] Ajuster thresholds si nécessaire
- [ ] Ajouter domain presets supplémentaires
