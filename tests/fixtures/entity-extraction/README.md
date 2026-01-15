# Entity Extraction Test Fixtures

Ce dossier contient des fichiers markdown de test pour valider le système d'extraction d'entités GLiNER2.

## Structure

```
entity-extraction/
├── domains/                          # Tests par domaine
│   ├── ecommerce-product-catalog.md  # Produits, marques, prix, ingrédients
│   ├── code-api-documentation.md     # Fonctions, classes, modules, APIs
│   ├── documentation-requirements.md # Concepts, features, specs
│   └── legal-contract-sample.md      # Personnes, organisations, clauses
├── deduplication/                    # Tests déduplication cross-file
│   ├── company-news-apple.md         # "Tim Cook", "Apple Inc.", "iPhone"
│   ├── tech-review-apple.md          # "Tim Cook", "Apple", "iPhone"
│   └── financial-report-tech.md      # "Timothy Cook", "Apple Inc", "Microsoft"
└── README.md                         # Ce fichier
```

## Objectifs des Tests

### 1. Tests par Domaine

Vérifier que GLiNER2 extrait correctement les entités selon le domaine:

| Domaine | Entités Attendues | Relations Attendues |
|---------|-------------------|---------------------|
| **ecommerce** | product, brand, price, ingredient | contains, certified_by, priced_at |
| **code** | function, class, module, library | calls, imports, depends_on |
| **documentation** | concept, feature, requirement | implements, requires |
| **legal** | person, organization, contract, clause | party_to, grants_right |

### 2. Tests de Déduplication

Vérifier que les entités identiques/similaires sont fusionnées:

| Entité Canonique | Variations à Dédupliquer |
|------------------|--------------------------|
| Tim Cook | "Tim Cook", "Timothy Cook" |
| Apple Inc. | "Apple Inc.", "Apple", "Apple Inc" |
| iPhone | "iPhone", "iPhone 15", "iPhone 15 Pro" |
| Microsoft | "Microsoft", "Microsoft Corporation" |

## Comment Exécuter les Tests

### Prérequis

1. GLiNER service running sur `http://localhost:6971`
2. Community-docs API running sur `http://localhost:6970`
3. Neo4j running sur `bolt://localhost:7688`

### Vérifier le service GLiNER

```bash
# Health check
curl http://localhost:6971/health

# Liste des domaines
curl http://localhost:6971/domains
```

### Ingérer les fichiers de test

```bash
# Via l'API community-docs
curl -X POST http://localhost:6970/ingest/file \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/tests/fixtures/entity-extraction/domains/ecommerce-product-catalog.md"}'
```

### Vérifier les résultats dans Neo4j

```cypher
-- Compter les entités par type
MATCH (e:Entity)
RETURN e.entityType, count(e) as count
ORDER BY count DESC;

-- Vérifier la déduplication de "Tim Cook"
MATCH (e:Entity)
WHERE e._name CONTAINS 'Tim' OR e._name CONTAINS 'Cook'
RETURN e._name, e.entityType, e.confidence;

-- Vérifier les relations MENTIONS
MATCH (d)-[m:MENTIONS]->(e:Entity)
RETURN labels(d)[0] as sourceType, e._name, count(m) as mentions
ORDER BY mentions DESC LIMIT 20;
```

### Tester la recherche

```bash
# Recherche d'entité
curl "http://localhost:6970/search?query=Tim%20Cook&types=Entity"

# Recherche sémantique
curl "http://localhost:6970/search?query=Apple%20CEO&semantic=true"
```

## Critères de Succès

| Critère | Valeur Attendue |
|---------|-----------------|
| Entités créées (après dédup) | ≥ 30 |
| Relations MENTIONS | ≥ 40 |
| Relations extraites | ≥ 10 |
| "Tim Cook" dédupliqué | 1 entité unique |
| "Apple" dédupliqué | 1 entité unique |
| Recherche "Tim Cook" | Retourne entité + documents |

## Logs Attendus

Avec `verbose: true` dans la configuration:

```
[EntityExtraction] Processing 8 nodes...
[EntityExtraction] Batch extraction: 45 entities, 12 relations
[EntityExtraction] Deduplication: removed 8 duplicates (45 -> 37)
[EntityExtraction] Created 37 entities, 12 relations, 45 mentions
```

## Debugging

### Si aucune entité n'est extraite

1. Vérifier que GLiNER service répond: `curl http://localhost:6971/health`
2. Vérifier la config dans `orchestrator-adapter.ts`
3. Vérifier que `entity-extraction.yaml` a les bons domaines

### Si la déduplication ne fonctionne pas

1. Vérifier le seuil fuzzy (default: 0.85)
2. Vérifier que `sameTypeOnly: true` est configuré
3. Regarder les logs pour les paires détectées

### Si la recherche ne retourne pas les entités

1. Vérifier les indexes Neo4j: `SHOW INDEXES`
2. Vérifier que les embeddings sont générés
3. Tester avec `types: ["Entity"]` explicite
