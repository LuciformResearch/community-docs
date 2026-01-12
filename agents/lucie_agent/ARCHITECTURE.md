# Lucie Agent - Architecture

Agent conversationnel LangGraph représentant Lucie Defraiteur pour son CV interactif.

## Informations de contact

- **Email**: luciedefraiteur@luciformresearch.com
- **Site web**: https://luciformresearch.com
- **GitHub**: https://github.com/LuciformResearch

## Architecture du graphe

```
                    ┌─────────────┐
                    │   START     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Classifier │  ← Analyse l'intent de la question
                    └──────┬──────┘
                           │
           ┌───────┬───────┼───────┬───────┐
           ▼       ▼       ▼       ▼       ▼
      ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
      │TECHNIQUE│ │PERSONNEL│ │ CODE   │ │CONTACT │ │OFF-TOPIC│
      └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘
           │         │         │         │         │
           ▼         │         ▼         │         │
      search_knowledge│    get_code_sample│         │
           │         │         │         │         │
           ▼         ▼         ▼         ▼         ▼
                    ┌─────────────┐
                    │   Response  │  ← Génère la réponse finale
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │     END     │
                    └─────────────┘
```

## Routes (Intents)

### 1. TECHNIQUE
Questions sur les projets, technologies, implémentations.

**Exemples**:
- "Comment fonctionne RagForge ?"
- "C'est quoi ton approche pour le parsing de code ?"
- "Parle-moi de ton système de RAG"

**Action**: Appelle `search_knowledge` pour chercher dans les projets indexés.

### 2. PERSONNEL
Questions sur le parcours, la personnalité, les motivations.

**Exemples**:
- "C'est quoi ton parcours ?"
- "Pourquoi tu as créé Luciform Research ?"
- "Tu viens d'où ?"

**Action**: Répond directement depuis la persona (pas de search).

### 3. CODE
Demandes de voir du code spécifique.

**Exemples**:
- "Montre-moi le code du parser TypeScript"
- "Comment tu as implémenté la recherche hybride ?"
- "Je veux voir un exemple de code"

**Action**: Appelle `get_code_sample` pour récupérer du code.

### 4. CONTACT
Questions sur comment contacter Lucie.

**Exemples**:
- "Comment je peux te contacter ?"
- "T'as un email ?"
- "Où je peux voir ton travail ?"

**Action**: Répond avec les infos de contact (pas de search).

**Réponse type**:
```
Tu peux me contacter par email à luciedefraiteur@luciformresearch.com

Tu peux aussi :
- Voir mon travail sur GitHub : https://github.com/LuciformResearch
- Visiter mon site : https://luciformresearch.com
```

### 5. OFF-TOPIC
Questions sans rapport avec le CV ou les projets.

**Exemples**:
- "Raconte-moi une blague"
- "C'est quoi la capitale du Japon ?"
- "Écris-moi un poème"

**Action**: Redirige poliment vers les sujets pertinents.

**Réponse type**:
```
Je suis là pour parler de mon travail et mes projets !
Tu peux me poser des questions sur RagForge, CodeParsers,
mon parcours, ou comment me contacter.
```

## Outils (Tools)

### search_knowledge
Recherche sémantique dans les projets indexés (RagForge, CodeParsers, Community-Docs).

```python
@tool
async def search_knowledge(
    query: str,           # Ce qu'on cherche
    limit: int = 5,       # Nombre de résultats
    explore_depth: int = 1  # Profondeur du graphe de dépendances
) -> str
```

### get_code_sample
Récupère un extrait de code spécifique.

```python
@tool
async def get_code_sample(
    file_path: str,           # Chemin du fichier
    start_line: int = None,   # Ligne de début
    end_line: int = None      # Ligne de fin
) -> str
```

### recall_memory
Récupère l'historique de conversation.

```python
@tool
async def recall_memory(
    conversation_id: str,  # ID de la conversation
    limit: int = 10        # Nombre de messages
) -> str
```

## Rate Limiting

| Protection | Limite | Description |
|------------|--------|-------------|
| Anti-spam IP | 5/min | Évite le flood |
| Quota IP | 15/jour | Limite même si clear localStorage |
| Quota visitor | 15/jour | Limite par session |
| Localhost | Illimité | Pour debug |

## Stack technique

- **Framework**: LangGraph + LangChain
- **LLM**: Claude (Anthropic)
- **API**: FastAPI avec SSE streaming
- **Mémoire**: Neo4j via community-docs API
- **RAG**: RagForge (custom)
- **Tunnel**: Cloudflare Tunnel

## Endpoints

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/health` | GET | Health check |
| `/chat` | POST | Chat avec streaming SSE |
| `/history/{visitor_id}` | GET | Historique des messages |

## Configuration

Variables d'environnement (`.env`):

```bash
ANTHROPIC_API_KEY=sk-ant-...
COMMUNITY_DOCS_API=http://localhost:6970
MODEL_NAME=claude-sonnet-4-20250514
```

## URLs

- **Local**: http://localhost:8000
- **Production**: https://lucie-agent.luciformresearch.com
