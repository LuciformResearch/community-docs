# Local Tool Calling Experiments

> **Status**: Planned
> **Created**: 2026-01-19
> **Priority**: Medium (après stabilisation du pipeline actuel)

## Contexte

Actuellement, le `StructuredLLMExecutor` dans RagForge utilise du parsing XML pour extraire les appels de fonctions des réponses LLM. Cette approche fonctionne mais présente des limitations:

- Parsing fragile (dépend du format XML exact)
- Pas de validation native des paramètres
- Overhead de prompt pour expliquer le format XML

## Découverte

Plusieurs modèles locaux supportent maintenant le **tool calling natif** (function calling) via l'API OpenAI-compatible:

### Modèles Ollama avec support tool calling

| Modèle | Taille | Performance | Notes |
|--------|--------|-------------|-------|
| `llama3.1` | 8B, 70B, 405B | Excellent | Support natif depuis juillet 2024 |
| `llama3.2` | 1B, 3B | Bon | Versions compactes |
| `llama3.3` | 70B | Excellent | Dernière version |
| `qwen2.5` | 0.5B à 72B | Très bon | Recommandé pour tool calling |
| `mistral-nemo` | 12B | Bon | Bon rapport qualité/taille |
| `firefunction-v2` | 70B | Excellent | Spécialisé function calling |

### vLLM

vLLM supporte également le tool calling via son API OpenAI-compatible pour les modèles qui le supportent nativement.

## Plan d'expérimentation

### Phase 1: Test via LangChain/LangGraph (lucie-agent)

Tester le tool calling natif via l'agent Lucie qui utilise déjà LangChain:

```python
# Exemple avec langchain-ollama
from langchain_ollama import ChatOllama

llm = ChatOllama(
    model="llama3.1",
    temperature=0,
).bind_tools([search_tool, read_file_tool])
```

**Objectifs**:
- Valider la fiabilité du tool calling natif
- Comparer avec l'approche XML actuelle
- Mesurer la latence et la qualité

### Phase 2: Provider Ollama natif pour StructuredLLMExecutor

Si Phase 1 concluante, créer un provider spécifique:

```typescript
// Idée d'architecture
interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): Promise<Response>;
  supportsNativeToolCalling(): boolean;
}

class OllamaToolCallingProvider implements LLMProvider {
  // Utilise l'API native /api/chat avec tools
}

class XMLFallbackProvider implements LLMProvider {
  // Fallback pour les modèles sans support natif
}
```

### Phase 3: Support vLLM

Même approche pour vLLM avec son API OpenAI-compatible.

## API Ollama Tool Calling

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "llama3.1",
  "messages": [{"role": "user", "content": "Search for authentication code"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "brain_search",
      "description": "Search the knowledge base",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"},
          "semantic": {"type": "boolean", "description": "Use semantic search"}
        },
        "required": ["query"]
      }
    }
  }]
}'
```

Réponse avec tool call:
```json
{
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [{
      "function": {
        "name": "brain_search",
        "arguments": {"query": "authentication", "semantic": true}
      }
    }]
  }
}
```

## Avantages attendus

1. **Fiabilité**: Parsing natif vs regex/XML
2. **Performance**: Moins de tokens pour le format
3. **Validation**: Paramètres validés par le modèle
4. **Compatibilité**: API standard OpenAI

## Risques identifiés

- Qualité variable selon les modèles
- Certains modèles peuvent halluciner des tools
- Besoin de fallback pour modèles sans support

## Fichiers concernés

- `packages/ragforge-core/src/llm/structured-executor.ts`
- `packages/ragforge-core/src/llm/providers/` (à créer)
- `lib/ragforge/agent/` (integration community-docs)

## Ressources

- [Ollama Tool Calling Docs](https://ollama.com/blog/tool-support)
- [vLLM OpenAI Compatibility](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)
- [LangChain Ollama Tools](https://python.langchain.com/docs/integrations/chat/ollama/)

---

## Notes de progression

### 2026-01-19
- Documentation initiale créée
- Prochaine étape: tester via lucie-agent avec LangGraph
