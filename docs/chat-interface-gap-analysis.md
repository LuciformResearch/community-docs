# Gap Analysis: Chat Interface Specification vs Existing Features

> **Date**: 2026-01-19 (Updated)
> **Context**: Analysis of existing community-docs and ragforge-core features vs the specification in `chat-interface-specification.md`

## Executive Summary

**Good news**: A significant portion of the required functionality already exists! The backend is largely in place, but the frontend UI and authentication system need to be built.

| Category | Spec Coverage | Status |
|----------|---------------|--------|
| Authentication | 10% | 🔴 Needs work |
| Database | 90% | 🟢 Neo4j complete, Prisma for auth only |
| **Lucie Agent (Python)** | 100% | 🟢 LangGraph + FastAPI + SSE |
| **Lucie Memory API (TS)** | 100% | 🟢 /lucie/* routes in community-docs |
| Conversation Memory | 100% | 🟢 L1 summaries, tool calls, context building |
| Chat Streaming (SSE) | 100% | 🟢 Python agent handles streaming |
| Session Management | 80% | 🟢 Mostly exists via /lucie/* API |
| Agent Tools | 100% | 🟢 search_knowledge, grep_code, get_code_sample |
| RAG / Search | 100% | 🟢 Complete |
| Ingestion | 100% | 🟢 Complete |
| Image Generation | 100% | 🟢 Complete |
| 3D Generation | 100% | 🟢 Complete |
| Chat UI Components | 0% | 🔴 **MVP focus** |

---

## Architecture: Lucie Agent + Memory API

**Important**: The system is NOT "two parallel implementations". It's a clear architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LUCIE AGENT SYSTEM                                │
│                                                                             │
│   ┌─────────────────────┐         ┌──────────────────────────────────────┐ │
│   │   Python Agent      │ ──────► │  community-docs API                  │ │
│   │ agents/lucie_agent/ │  HTTP   │  lib/ragforge/api/                   │ │
│   │                     │         │                                      │ │
│   │ • LangGraph         │         │  /lucie/*  → lucie.ts (memory)       │ │
│   │ • FastAPI + SSE     │         │  /search   → search routes           │ │
│   │ • Intent routing    │         │  /grep     → grep routes             │ │
│   │ • Rate limiting     │         │  /cypher   → cypher routes           │ │
│   │ • Model fallback    │         │                                      │ │
│   └─────────────────────┘         └──────────────────────────────────────┘ │
│             │                                      │                       │
│             ▼                                      ▼                       │
│   ┌─────────────────────┐         ┌──────────────────────────────────────┐ │
│   │  SSE to React UI    │         │  Neo4j Database                      │ │
│   │  (tokens, tools)    │         │  (conversations, messages, etc.)     │ │
│   └─────────────────────┘         └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                      SEPARATE: Chat Route (Vercel AI SDK)                   │
│   lib/ragforge/api/routes/chat.ts                                           │
│   - Different system, not used by Lucie Agent                               │
│   - Has multimodal support, 12+ tools                                       │
│   - Could be unified later but NOT required for MVP                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Lucie Agent (Python) - `agents/lucie_agent/`

The **main chat agent** - a complete LangGraph implementation:

```
agents/lucie_agent/
├── main.py          # FastAPI server with SSE streaming
├── agent.py         # LangGraph with intent routing (TECHNIQUE/PERSONNEL/CODE/CONTACT/OFF_TOPIC)
├── tools.py         # search_knowledge, grep_code, get_code_sample
├── memory.py        # Calls community-docs /lucie/* API for memory
├── prompts.py       # System prompts (FR/EN)
├── summarizer.py    # Tool call summarization
├── retry.py         # Rate limit handling with exponential backoff + fallback model
└── config.py        # Settings (model, API URLs)
```

**Features:**
- ✅ Intent classification (routes to appropriate handler)
- ✅ SSE streaming (`token`, `tool_start`, `tool_end`, `tool_summary`, `rate_limit`, `model_fallback`, `error`)
- ✅ Rate limiting (per IP + per visitor)
- ✅ Conversation memory via `/lucie/*` API (L1 summaries, tool summaries)
- ✅ Fallback model on rate limit (Sonnet → Haiku)
- ✅ Language detection (FR/EN)
- ✅ WhatsApp webhook (Twilio)

**Current Limitations (MVP scope):**
- ❌ No multimodal support (images, 3D) - can add later
- ❌ No attachment handling - can add later
- ❌ Limited tools (3 vs 12+ in TypeScript) - can extend

### Lucie Memory API (TypeScript) - `lib/ragforge/api/routes/lucie.ts`

The **memory service** that Python Lucie Agent calls. NOT a separate chat - it's the persistence layer:

```typescript
// Endpoints (called by Python agent via HTTP):
POST /lucie/conversation     // Get or create conversation for visitor
POST /lucie/message          // Add message with optional tool calls
GET  /lucie/context/:id      // Get summaries + recent messages for LLM context
POST /lucie/summarize/:id    // Force L1 summary creation
GET  /lucie/history/:id      // Get full message history
POST /lucie/tool-summary     // Add tool call summary
GET  /lucie/tool-summaries/:id // Get tool summaries
```

**Features:**
- ✅ Neo4j storage (LucieConversation, LucieMessage, LucieSummary, LucieToolSummary)
- ✅ Auto L1 summarization after 10 messages (using Claude)
- ✅ Tool call logging with JSON serialization
- ✅ Context building: `buildContextString()` combines summaries + recent messages
- ✅ Embeddings on summaries for future RAG

### Chat Route (TypeScript) - SEPARATE SYSTEM

`lib/ragforge/api/routes/chat.ts` is a **different implementation** using Vercel AI SDK:

- Has multimodal support (images, PDFs, 3D)
- Has 12+ agent tools
- Has attachment handling
- Uses different Neo4j nodes (ChatConversation, ChatMessage)
- **NOT used by Lucie Agent**

**For MVP**: We use the Lucie Agent system. The chat.ts route can be unified later if needed.

### MVP Strategy: Use Existing Lucie Agent

1. **React UI** → connects to Python Lucie Agent SSE endpoint
2. **Python Agent** → handles chat logic, intent routing, rate limiting
3. **community-docs API** → provides memory (/lucie/*) + search (/search) + code (/grep, /cypher)
4. **Neo4j** → stores everything

---

## 1. Authentication

### Spec Requirements
- Google OAuth
- Email Magic Link
- Discord OAuth
- GitHub OAuth (optional)
- NextAuth.js integration

### Existing Implementation
**Location**: None found in community-docs

### Gap
🔴 **Full auth system needs to be implemented**

```
Required:
- [ ] Install next-auth
- [ ] Configure providers (Google, Discord, Email)
- [ ] Create auth API routes
- [ ] Session management with JWT
- [ ] User profile pages
```

---

## 2. Database Schema

### Spec Requirements
- PostgreSQL with Prisma
- Tables: User, Session, Account, Message, Attachment, Project, Category

### Existing Implementation
**Location**: Neo4j only (no Prisma schema found)

Chat sessions are stored in Neo4j:
- `packages/ragforge-core/src/runtime/chat/session-manager.ts`
- `lib/ragforge/chat-session-logger.ts`

Neo4j nodes:
- `ChatSession` - sessionId, title, domain, createdAt, lastActiveAt
- `Message` - messageId, content, role, timestamp, tokens
- `ToolCall` - toolName, arguments, result

### Gap
🟢 **Architecture decided: Hybrid approach**

**Neo4j for chat sessions** (keep existing):
- ✅ Already works with full features
- ✅ Graph relationships (Message → ToolCall, Session → User)
- ✅ Embedding-based search on conversation history
- ✅ Recursive summarization (L0 → L1 → L2)
- ✅ Entity extraction on messages (reuse ragforge)
- ✅ Relationship discovery between conversations

**PostgreSQL (Prisma) for simple auth only**:
- User accounts
- OAuth providers (NextAuth Accounts)
- Simple metadata that doesn't need RAG

**Why this approach**:
The ragforge chat system has sophisticated memory features that would be lost with PostgreSQL:

**Conversation class** (`runtime/conversation/conversation.ts`):
- `buildDualContext()`: Recent turns + RAG search on summaries
- `checkHierarchicalSummarization()`: Auto L1→L2→L3 summaries
- `generateMessageEmbedding()`: Vector search on messages
- Tool calls with reasoning stored per message

**ConversationSummarizer** (`runtime/conversation/summarizer.ts`):
- Multi-level summarization (L1 from turns, L2 from L1s)
- **NodeMention extraction**: Links summaries to scopes, webpages, documents via UUID!
- **FileMention extraction**: Links summaries to files
- Embedding generation for summaries (semantic search on conversation history)

**This enables**:
- "What did we discuss about authentication?" → RAG search on summaries
- "Show me the files we modified" → Graph traversal from summary → MENTIONS_FILE → File
- Cross-conversation insights via entity extraction
- Agent can reference past discussions with semantic similarity

---

## 2b. Conversation Memory System (Already Exists!)

### Existing Implementation - VERY SOPHISTICATED

**Location**: `packages/ragforge-core/src/runtime/conversation/`

```
runtime/conversation/
├── conversation.ts      # Main Conversation class with dual context
├── agent.ts             # ConversationAgent orchestration
├── summarizer.ts        # Multi-level summarization
├── storage.ts           # Neo4j storage for conversations
├── types.ts             # Message, Summary, NodeMention types
└── tool-mention-extractor.ts  # Extract file/node mentions from tool calls
```

### Key Features

**Hierarchical Summarization**:
```
Messages (L0) → L1 Summary (every N chars) → L2 Summary (every M L1s) → L3...
```
- Character-based triggers (not turn-based)
- Each summary has embeddings for vector search
- Summaries link to mentioned nodes via `MENTIONS_FILE`, `MENTIONS_NODE`

**Dual Context Building**:
```typescript
async buildDualContext(userMessage: string): Promise<ConversationContext> {
  // 1. Recent context: Last N non-summarized messages
  const recent = await this.buildRecentContext();

  // 2. RAG context: Vector search on summaries using current query
  const rag = await this.searchSummaries(userMessage);

  return { recent, rag };
}
```

**NodeMention Extraction**:
```typescript
interface NodeMention {
  uuid: string;                    // UUID in Neo4j graph!
  name: string;                    // Function name, page title, etc.
  type: 'scope' | 'file' | 'webpage' | 'document' | 'markdown_section' | 'codeblock';
  subtype?: string;                // function, method, class, interface
  file?: string;
  url?: string;
  reason?: string;                 // Why pertinent
}
```

### Gap
🟢 **Fully implemented - just needs UI integration**

The backend supports:
- ✅ Creating conversations with metadata
- ✅ Storing messages with tool calls
- ✅ Auto-summarization based on character count
- ✅ Vector search on conversation history
- ✅ Graph links to mentioned code/documents

---

## 3. Chat API / Streaming

### Spec Requirements
- SSE streaming with events: `token`, `tool_start`, `tool_end`, `tool_summary`, `done`
- Rate limit handling with retry/fallback
- Tool call display

### Existing Implementation
**Location**: `agents/lucie_agent/main.py` (Python FastAPI) ✅

```python
# Full SSE implementation exists in Python Lucie Agent!
# Events emitted via FastAPI StreamingResponse:
# - token: { "type": "token", "content": str }
# - tool_start: { "type": "tool_start", "name": str, "args": dict }
# - tool_end: { "type": "tool_end", "name": str, "output": str }
# - tool_summary: { "type": "tool_summary", ... }
# - rate_limit: { "type": "rate_limit", "delay_seconds": int, "will_fallback": bool }
# - model_fallback: { "type": "model_fallback", "model": str }
# - error: { "type": "error", "content": str }
```

### Gap
🟢 **Fully implemented in Python Lucie Agent**

The Python agent already has:
- ✅ All SSE events
- ✅ Rate limiting with fallback model (Sonnet → Haiku)
- ✅ Tool call streaming with summaries

---

## 4. Session Management

### Spec Requirements
- Create, list, archive, delete sessions
- Pin favorite sessions
- Export sessions (JSON, Markdown)
- Session sidebar UI

### Existing Implementation

**ragforge-core** (`session-manager.ts`):
```typescript
class ChatSessionManager {
  createSession(options: CreateSessionOptions): Promise<ChatSession>
  getSession(sessionId: string): Promise<ChatSession | null>
  addMessage(message: Message): Promise<void>
  getMessages(sessionId: string, limit?: number): Promise<Message[]>
  listSessions(domain?: string): Promise<ChatSession[]>
  deleteSession(sessionId: string): Promise<void>
}
```

**community-docs** (`chat-session-logger.ts`):
```typescript
class ChatSessionLogger {
  startSession(): { conversationId }
  logMessage(role, content, ...): Promise<void>
  logToolCall(toolName, args, result, ...): Promise<void>
  endSession(): void
}
```

### Gap
🟡 **Partial implementation**

Missing:
- [ ] Archive session (soft delete)
- [ ] Pin session (add `isPinned` flag)
- [ ] Export session (JSON/Markdown generation)
- [ ] Session title auto-generation from first message

---

## 5. Agent & Tools

### Spec Requirements
Tools: `brain_search`, `ingest_file`, `ingest_url`, `generate_image`, `generate_3d`, etc.

### Existing Implementation

**Lucie Agent (Python)** - `agents/lucie_agent/`:
```python
# LangGraph agent with intent routing
# File: agents/lucie_agent/agent.py

Intent = Literal["TECHNIQUE", "PERSONNEL", "CODE", "CONTACT", "OFF_TOPIC"]

# Tools (file: agents/lucie_agent/tools.py):
@tool
async def search_knowledge(query, limit=5, explore_depth=1, code_only=True):
    """Search through indexed projects via /search API"""

@tool
async def grep_code(pattern, glob="**/*.{ts,tsx,...}", ignore_case=False):
    """Regex search across all indexed files via /grep API"""

@tool
async def get_code_sample(file_path, line_number):
    """Get full scope source code via /cypher API"""
```

**Key Features:**
- Intent classification → routes to appropriate handler
- SSE streaming with events: `token`, `tool_start`, `tool_end`, `tool_summary`, `rate_limit`, `model_fallback`
- Rate limiting (5/min anti-spam + 15/day quota per IP/visitor)
- Conversation memory via community-docs `/lucie/*` API
- Fallback model: Sonnet → Haiku on rate limit
- Language detection (FR/EN) per message

**Agent Tools (TypeScript)** - `lib/ragforge/agent/tools.ts`:
```typescript
// 12 tools for Vercel AI SDK:
- search_brain
- ingest_document
- explore_source
- read_content
- fetch_url
- list_sources
- list_tags
- list_entity_types
- list_entities
- list_attachments
- analyze_attachment
- ingest_attachment
```

**RagForge MCP Server** - `packages/ragforge-core/src/cli/commands/mcp-server.ts`:
```typescript
// All tools via MCP protocol:
// Shell: run_command, run_npm_script, git_status, git_diff
// Context: get_working_directory, get_project_info
// Brain: brain_search, ingest_directory, ingest_web_page, forget_path
// File: read_file, read_files, write_file, edit_file, delete_path, move_file
// Web: search_web, fetch_web_page
// Image: generate_image, edit_image, read_image, describe_image, list_images
// 3D: render_3d_asset, generate_3d_from_image, generate_3d_from_text
// Agent: call_agent, call_research_agent
```

### Gap
🟢 **Exists - no significant gaps**

All required tools are available. The Python Lucie Agent calls community-docs API endpoints, which in turn use ragforge-core tools.

---

## 6. RAG / Search

### Spec Requirements
- Semantic search
- Hybrid search (BM25 + semantic)
- Explore relationships

### Existing Implementation
**Location**: `packages/ragforge-core/src/tools/brain-tools.ts`

```typescript
// brain_search tool:
- Semantic search with embeddings
- Hybrid search (BM25 + RRF fusion)
- explore_depth for relationship discovery
- Summarization with LLM
- Glob filtering
- Score thresholds
```

### Gap
🟢 **Fully implemented**

---

## 7. Ingestion

### Spec Requirements
- File upload (drag & drop)
- URL crawling
- GitHub repo ingestion
- Code parsing

### Existing Implementation

**UnifiedProcessor** - `packages/ragforge-core/src/orchestrator/unified-processor.ts`:
- Parses: TypeScript, Python, Markdown, JSON, YAML, Vue, Svelte
- Extracts scopes (functions, classes, methods)
- Generates embeddings
- Stores in Neo4j

**Community Ingester** - `lib/ragforge/community-ingester.ts`:
```typescript
const ingester = createCommunityIngester({ driver, neo4jClient });
await ingester.ingestDocument(content, filename, projectId, metadata);
await ingester.ingestVirtual(files, projectId, metadata, options);
```

**Tools available**:
- `ingest_directory` - Local directory
- `ingest_web_page` - URL with optional depth
- `ingest_attachment` - Uploaded files (ZIP, images, PDFs, 3D)

### Gap
🟢 **Fully implemented**

Note: GitHub repo ingestion would use `ingest_directory` after git clone, which could be automated.

---

## 8. Image Generation

### Spec Requirements
- Text to image
- Image editing

### Existing Implementation
**Location**: `packages/ragforge-core/src/tools/image-tools.ts`

```typescript
generate_image({ prompt, output_path, aspect_ratio, enhance_prompt })
edit_image({ image_path, prompt, output_path })
read_image({ path })      // OCR
describe_image({ path, prompt })
list_images({ path, recursive, pattern })
generate_multiview_images({ prompt, output_dir, style })  // For 3D
analyze_visual({ path, prompt, page })
```

### Gap
🟢 **Fully implemented**

---

## 9. 3D Generation

### Spec Requirements
- Text to 3D model
- Image to 3D model
- Model rendering

### Existing Implementation
**Location**: `packages/ragforge-core/src/tools/threed-tools.ts`

```typescript
render_3d_asset({ model_path, output_dir, views })
generate_3d_from_image({ image_paths, output_path })
generate_3d_from_text({ prompt, output_path, style })
analyze_3d_model({ model_path, output_dir })
```

### Gap
🟢 **Fully implemented**

---

## 10. Chat UI Components

### Spec Requirements
- Session sidebar with search
- Chat message list with streaming
- Input bar with attachments
- Tool call visualization
- Code blocks with syntax highlighting

### Existing Implementation
**Location**: None found in community-docs

### Gap
🔴 **Needs to be built**

Required components:
```
- [ ] SessionSidebar.tsx
  - Session list with search
  - Create/delete/pin sessions

- [ ] ChatContainer.tsx
  - Message list with virtualization
  - Streaming text display
  - Tool call cards

- [ ] ChatInput.tsx
  - Textarea with submit
  - Attachment button + preview
  - Drag & drop zone

- [ ] ToolCallCard.tsx
  - Collapsible tool info
  - Status indicator

- [ ] MessageBubble.tsx
  - User/assistant styling
  - Markdown rendering
  - Code blocks
```

---

## MVP Implementation Plan

### What Already Works (Don't Touch!)

| Component | Location | Status |
|-----------|----------|--------|
| Python Lucie Agent | `agents/lucie_agent/` | ✅ Complete |
| Lucie Memory API | `lib/ragforge/api/routes/lucie.ts` | ✅ Complete |
| SSE Streaming | Python agent | ✅ Complete |
| Rate Limiting + Fallback | Python agent | ✅ Complete |
| L1 Summaries | lucie.ts | ✅ Complete |
| Tool Calls Storage | lucie.ts | ✅ Complete |
| Search/RAG | community-docs API | ✅ Complete |

### MVP Step 1: Verify Services Running

Before building UI, ensure all services work together:

```bash
# 1. Start community-docs API (TypeScript)
cd community-docs && npm run dev:api

# 2. Start Python Lucie Agent
cd agents/lucie_agent && python main.py

# 3. Test the flow
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Bonjour", "visitor_id": "test-123"}'
```

### MVP Step 2: Minimal React UI

Create a simple chat interface that connects to Python agent:

```
components/chat/
├── ChatPage.tsx        # Main page, SSE connection to Python agent
├── MessageList.tsx     # Display messages with streaming
├── ChatInput.tsx       # Text input + submit
└── ToolCallCard.tsx    # Display tool calls (collapsible)
```

**Key: Connect to Python agent directly**
```typescript
// NOT chat.ts, connect to Python agent
const response = await fetch('http://localhost:8000/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message, visitor_id: visitorId })
});
// Handle SSE stream...
```

### MVP Step 3: Session List (Optional for MVP)

The `/lucie/history/:visitorId` endpoint already exists. UI just needs to:
- Get visitor ID from localStorage or generate one
- Display message history on page load

### Phase 2 (Post-MVP): Authentication

Add NextAuth later when we need user accounts:
1. **NextAuth** with Google + Discord
2. **Link visitorId → userId** in Neo4j
3. **Session sidebar** with user's conversation history

### What We Can Skip for MVP
- All RAG/Search functionality ✅ (already works)
- All ingestion pipelines ✅ (already works)
- All generation tools (image, 3D) ✅ (already works)
- Authentication ⏸️ (use anonymous visitorId for now)
- Session management UI ⏸️ (can add later)

---

## File Reference

### Existing Key Files

| Feature | File |
|---------|------|
| Chat API | `lib/ragforge/api/routes/chat.ts` |
| Session Manager | `packages/ragforge-core/src/runtime/chat/session-manager.ts` |
| Chat Types | `packages/ragforge-core/src/runtime/types/chat.ts` |
| Session Logger | `lib/ragforge/chat-session-logger.ts` |
| Agent Tools (TS) | `lib/ragforge/agent/tools.ts` |
| Lucie Agent (PY) | `agents/lucie_agent/agent.py` |
| MCP Server | `packages/ragforge-core/src/cli/commands/mcp-server.ts` |
| Brain Tools | `packages/ragforge-core/src/tools/brain-tools.ts` |
| Image Tools | `packages/ragforge-core/src/tools/image-tools.ts` |
| 3D Tools | `packages/ragforge-core/src/tools/threed-tools.ts` |
| Community Ingester | `lib/ragforge/community-ingester.ts` |

### Files to Create

| Feature | Suggested Path |
|---------|----------------|
| Prisma Schema | `prisma/schema.prisma` |
| NextAuth Config | `lib/auth.ts` |
| Auth API | `app/api/auth/[...nextauth]/route.ts` |
| Chat Page | `app/chat/page.tsx` |
| Session Sidebar | `components/chat/SessionSidebar.tsx` |
| Chat Container | `components/chat/ChatContainer.tsx` |
| Chat Input | `components/chat/ChatInput.tsx` |
| Message Bubble | `components/chat/MessageBubble.tsx` |
| Tool Call Card | `components/chat/ToolCallCard.tsx` |

---

## Conclusion

**MVP Estimated effort**: Days, not weeks

### Architecture Summary

```
┌────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React UI  │────►│  Python Agent    │────►│ community-docs  │
│ (to build) │ SSE │ agents/lucie_agent│HTTP │ API /lucie/*    │
└────────────┘     └──────────────────┘     └─────────────────┘
                            │                        │
                            ▼                        ▼
                   ┌────────────────┐       ┌───────────────┐
                   │ Claude API     │       │ Neo4j         │
                   │ (chat/tools)   │       │ (memory)      │
                   └────────────────┘       └───────────────┘
```

### What's Already Built (Don't Rebuild!)

| Component | Location | Status |
|-----------|----------|--------|
| **Lucie Agent** | `agents/lucie_agent/` | ✅ LangGraph + FastAPI + SSE |
| **Lucie Memory API** | `lib/ragforge/api/routes/lucie.ts` | ✅ L1 summaries, tool calls |
| All RAG tools | `tools/brain-tools.ts` | ✅ Complete |
| Image generation | `tools/image-tools.ts` | ✅ Complete |
| 3D generation | `tools/threed-tools.ts` | ✅ Complete |
| MCP Server | `cli/commands/mcp-server.ts` | ✅ Complete |

### MVP: What Needs to Be Built

| Component | Priority | Notes |
|-----------|----------|-------|
| React Chat UI | P0 | ~4 components, connect to Python agent |
| Verify services work together | P0 | Test Python ↔ TypeScript API flow |

### Post-MVP

| Component | Priority | Notes |
|-----------|----------|-------|
| NextAuth | P1 | When we need user accounts |
| Session sidebar | P1 | Use existing /lucie/history endpoint |
| More tools in Python agent | P2 | Currently 3, can add more via API calls |

### Key Insight

**Everything is already built except the React UI**. The Python Lucie Agent is a fully functional chat system with:
- Intent routing (TECHNIQUE/CODE/PERSONNEL/CONTACT/OFF_TOPIC)
- SSE streaming with all event types
- Rate limiting with model fallback (Sonnet → Haiku)
- Conversation memory via `/lucie/*` API
- L1 auto-summarization after 10 messages
- Tool calls logged with JSON serialization

### Next Steps (MVP)

1. **Verify services work together** - Test Python agent calling community-docs API
2. **Build minimal React UI** - 4 components connecting to Python agent SSE
3. **Test end-to-end flow** - Message → Agent → Tools → Memory → Response
