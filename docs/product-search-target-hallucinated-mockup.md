Understand this markdown was a bit hallucinated by an llm, given an
example from our brain search on code, but it can provide inspiration 
on how to create entites for products kind of domain:


# Analyse Catalogue: "soins cheveux naturels"

**Résultats:** 3 / 3
**Collections:** Soins capillaires, Bio & Naturel

**Paramètres:**
recherche_sémantique=true | limite=5 | profondeur_tags=2 | boost_attributs=[type_cheveux, durée, composition]

---

## Produits

### 1. Shampoing Doux Hydratant Bio - 250ml ★ 0.40
📍 `Collection: Soins Cheveux > Shampoings`
💶 **19,90 €**

**Entités extraites:**
- **Type de cheveux:** Cheveux secs, Cheveux bouclés
- **Durée:** 2-3 mois (usage quotidien)
- **Composition:** 98% ingrédients naturels, Sans sulfates, Sans parabènes
- **Usage:** Quotidien, Matin et soir
- **Texture:** Crème onctueuse
- **Parfum:** Coco & Vanille

```json
{
  "tags": ["bio", "vegan", "cheveux-secs", "hydratation"],
  "metafields": {
    "type_cheveux": ["secs", "bouclés"],
    "frequence_usage": "quotidien",
    "certification": ["Ecocert", "Cosmébio"]
  },
  "stock": 156,
  "variants": [
    {"size": "250ml", "price": 19.90},
    {"size": "500ml", "price": 32.90}
  ]
}
```

### 2. Masque Réparateur Intense - 200ml ★ 0.35
📍 `Collection: Soins Cheveux > Masques`
💶 **24,50 €**
📝 Soin profond pour cheveux abîmés et colorés

**Entités extraites:**
- **Type de cheveux:** Cheveux abîmés, Cheveux colorés, Cheveux ternes
- **Durée:** 3-4 mois (1-2x/semaine)
- **Composition:** Huile d'argan, Beurre de karité, Protéines de soie
- **Usage:** Hebdomadaire, Pose 10-15 min
- **Bénéfices:** Réparation, Brillance, Protection couleur

```json
{
  "tags": ["réparation", "cheveux-abimes", "anti-casse", "sans-silicones"],
  "metafields": {
    "type_cheveux": ["abîmés", "colorés", "ternes"],
    "temps_pose": "10-15 minutes",
    "frequence": "1-2 fois par semaine",
    "ingredients_cles": ["argan", "karite", "proteines_soie"]
  },
  "stock": 89,
  "category_taxonomy": "Beauty > Hair Care > Treatments"
}
```

### 3. Sérum Anti-Frisottis Léger ★ 0.30
📍 `Collection: Soins Cheveux > Coiffants`
💶 **16,90 €**
📝 Contrôle et définit les boucles sans alourdir

**Entités extraites:**
- **Type de cheveux:** Cheveux bouclés, Cheveux ondulés, Cheveux fins
- **Durée:** 4-5 mois (quelques gouttes/jour)
- **Composition:** Huiles végétales légères, Sans alcool
- **Usage:** Quotidien, Sur cheveux humides ou secs
- **Texture:** Sérum léger non gras
- **Effet:** Anti-frisottis, Définition boucles

```json
{
  "tags": ["boucles", "anti-frisottis", "leger", "naturel"],
  "metafields": {
    "type_cheveux": ["bouclés", "ondulés", "fins"],
    "application": ["humide", "sec"],
    "finish": "naturel",
    "poids": "leger"
  },
  "stock": 203,
  "cross_sell": ["shampoing_boucles", "masque_hydratant"]
}
```

---

## Graph de Connaissances

```
Shampoing Doux Bio ★0.4 @ Collection:Soins/Shampoings | 19,90€
└── [COMPATIBLE_AVEC]
        ├── Type_Cheveux (entité) @ Taxonomie:Attributs
        │   └── [UTILISÉ_PAR]
        │           ├── Masque Réparateur ★0.4 @ Collection:Soins/Masques | 24,50€
        │           ├── Sérum Anti-Frisottis @ Collection:Coiffants | 16,90€
        │           └── Routine_Cheveux_Secs (bundle suggéré)
        ├── Composition_Bio (entité) @ Taxonomie:Certifications
        │   └── [PARTAGÉ_PAR]
        │           ├── Certification Ecocert (metafield)
        │           ├── Label Cosmébio (metafield)
        │           └── Vegan_Society (certification)
        └── Usage_Quotidien (entité) @ Taxonomie:Fréquence
            └── [COMPLÉMENTE]
                    ├── Masque Réparateur (usage hebdomadaire)
                    ├── Huile_Nuit_Cheveux (produit suggéré)
                    └── Brosse_Démêlante (accessoire compatible)

Masque Réparateur ★0.4 @ Collection:Soins/Masques | 24,50€
└── [CIBLE]
        └── Cheveux_Abîmés (segment)
            ├── [ASSOCIÉ_À]
            │       ├── Protection_Couleur (bénéfice)
            │       ├── Réparation_Profonde (bénéfice)
            │       └── Ingrédients_Naturels (composition)
            └── [RECOMMANDÉ_AVEC]
                    ├── Shampoing Doux Bio (étape 1)
                    └── Sérum Anti-Frisottis (étape 3)

Sérum Anti-Frisottis ★0.3 @ Collection:Coiffants | 16,90€
└── [SPÉCIALISÉ_POUR]
        └── Cheveux_Bouclés (segment)
            └── [RECHERCHE]
                    ├── Définition (besoin client)
                    ├── Anti-Humidité (problème résolu)
                    └── Texture_Légère (préférence)
```

---

## Statistiques Entités

| Entité | Occurrences |
|--------|-------------|
| Type de cheveux | 8 valeurs uniques |
| Composition | 15 ingrédients clés |
| Usage | 4 fréquences |
| Certification | 3 labels |
| Prix moyen | 20,43 € |

---

## Suggestions Automatiques

**Entités pertinentes détectées:**
- Type de cheveux (8 variations)
- Durée d'utilisation (standardisable)
- Certifications bio (3 labels identifiés)
- Fréquence d'usage (à normaliser)

**Opportunités d'amélioration:**
- 2 produits sans metafield "temps_pose"
- Taxonomie Shopify applicable: "Beauty > Hair Care"
- Bundles suggérés: 3 routines complètes détectées

**Produits complémentaires suggérés:**
- Après-shampoing pour cheveux bouclés (absent du catalogue)
- Brosse adaptée cheveux bouclés (accessoire)
- Format voyage 50ml (variante à créer)
