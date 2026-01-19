# Community Docs Chat Interface - Specification

> **Codename**: RagChat / Lucie Chat
> **Version**: 1.0 Draft
> **Created**: 2026-01-19
> **Status**: Design Phase

---

## Vision

Créer un chat IA nouvelle génération combinant:
- **La puissance de ChatGPT** (génération de contenu, code, images, rapports)
- **Un cerveau RAG massif** (RagForge) pour la connaissance contextuelle
- **Des capacités d'ingestion avancées** (fichiers, web, GitHub, 3D)
- **Une UX premium** pour showcase et démonstration aux investisseurs

**Pitch**: "ChatGPT rencontre un cerveau illimité qui n'oublie jamais."

---

## Table des Matières

1. [Architecture Globale](#1-architecture-globale)
2. [Authentification](#2-authentification)
3. [Sessions de Chat](#3-sessions-de-chat)
4. [Interface de Chat](#4-interface-de-chat)
5. [Agent IA (Lucie)](#5-agent-ia-lucie)
6. [Capacités d'Ingestion](#6-capacités-dingestion)
7. [Génération de Contenu](#7-génération-de-contenu)
8. [Intégration RAG](#8-intégration-rag)
9. [API Backend](#9-api-backend)
10. [Base de Données](#10-base-de-données)
11. [Phases d'Implémentation](#11-phases-dimplémentation)
12. [Métriques de Succès](#12-métriques-de-succès)

---

## 1. Architecture Globale

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Next.js 16)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  Session        │  │  Chat Interface │  │  File Upload    │         │
│  │  Sidebar        │  │  (Streaming)    │  │  Zone           │         │
│  │                 │  │                 │  │                 │         │
│  │ • Session List  │  │ • Messages      │  │ • Drag & Drop   │         │
│  │ • Search        │  │ • Tool Calls    │  │ • URL Input     │         │
│  │ • New Chat      │  │ • Attachments   │  │ • GitHub Link   │         │
│  │ • Export/Import │  │ • Markdown      │  │ • Progress      │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ SSE / REST
┌─────────────────────────────────────────────────────────────────────────┐
│                           API LAYER (Next.js)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Auth Middleware ──► Session API ──► Chat API ──► Ingest API            │
│        │                  │              │             │                │
│        ▼                  ▼              ▼             ▼                │
│  ┌──────────┐      ┌───────────┐  ┌───────────┐  ┌──────────┐          │
│  │ NextAuth │      │ Sessions  │  │ Streaming │  │ RagForge │          │
│  │ + Custom │      │ CRUD      │  │ Handler   │  │ Ingester │          │
│  └──────────┘      └───────────┘  └───────────┘  └──────────┘          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           AGENT LAYER                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────┐       │
│  │                    Lucie Agent (LangGraph)                   │       │
│  │                                                              │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │       │
│  │  │ RAG      │  │ Code     │  │ Report   │  │ Media    │    │       │
│  │  │ Search   │  │ Generate │  │ Writer   │  │ Generate │    │       │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │       │
│  │                                                              │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │       │
│  │  │ Web      │  │ File     │  │ Vision   │  │ 3D       │    │       │
│  │  │ Crawler  │  │ Reader   │  │ Analyzer │  │ Generate │    │       │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │       │
│  │                                                              │       │
│  └─────────────────────────────────────────────────────────────┘       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │   PostgreSQL    │  │     Neo4j       │  │   Object Store  │         │
│  │                 │  │   (RagForge)    │  │   (S3/R2/Local) │         │
│  │ • Users         │  │                 │  │                 │         │
│  │ • Sessions      │  │ • Knowledge     │  │ • Uploaded      │         │
│  │ • Messages      │  │ • Embeddings    │  │   Files         │         │
│  │ • Attachments   │  │ • Entities      │  │ • Generated     │         │
│  │ • API Keys      │  │ • Relations     │  │   Content       │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Authentification

### 2.1 Providers Supportés

| Provider | Priorité | Use Case |
|----------|----------|----------|
| **Google OAuth2** | P0 | Connexion rapide, compte existant |
| **Email/Password** | P0 | Utilisateurs sans compte social |
| **Magic Link** | P1 | Passwordless, UX premium |
| **Discord OAuth2** | P1 | Communauté, intégration serveurs |
| **GitHub OAuth2** | P2 | Développeurs, liaison repos |

### 2.2 Schema Utilisateur

```typescript
interface User {
  id: string;                    // UUID
  email: string;                 // Unique
  name?: string;
  avatarUrl?: string;

  // Auth
  provider: 'google' | 'email' | 'discord' | 'github';
  providerId?: string;           // ID externe
  passwordHash?: string;         // Si email auth
  emailVerified: boolean;

  // Profil
  preferences: {
    language: 'fr' | 'en';
    theme: 'dark' | 'light' | 'system';
    defaultModel: string;
  };

  // Quota
  tier: 'free' | 'pro' | 'enterprise';
  quotaUsed: number;
  quotaLimit: number;

  // Timestamps
  createdAt: Date;
  lastLoginAt: Date;
}
```

### 2.3 Flow NextAuth

```typescript
// Configuration NextAuth
export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: 'email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        // Validate credentials against DB
      },
    }),
    EmailProvider({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, account }) => {
      // Add custom claims
    },
    session: async ({ session, token }) => {
      // Enrich session
    },
  },
};
```

---

## 3. Sessions de Chat

### 3.1 Modèle de Session

```typescript
interface ChatSession {
  id: string;
  userId: string;

  // Metadata
  title: string;
  description?: string;
  tags: string[];

  // State
  status: 'active' | 'archived' | 'deleted';
  isPinned: boolean;

  // Context
  projectId?: string;            // Lié à un projet RagForge
  attachedDocuments: string[];   // IDs de documents ingérés

  // Stats
  messageCount: number;
  tokenCount: number;
  lastMessageAt: Date;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

### 3.2 Interface Sidebar

```
┌─────────────────────────────────┐
│  🔍 Rechercher...               │
├─────────────────────────────────┤
│  ➕ Nouvelle conversation       │
├─────────────────────────────────┤
│                                 │
│  📌 ÉPINGLÉES                   │
│  ├─ Projet RagForge v2         │
│  └─ Documentation API          │
│                                 │
│  📅 AUJOURD'HUI                 │
│  ├─ Analyse du code Python    │
│  ├─ Génération rapport Q4     │
│  └─ Debug WebSocket           │
│                                 │
│  📅 HIER                        │
│  ├─ Review PR #234            │
│  └─ Architecture microservices │
│                                 │
│  📅 7 DERNIERS JOURS           │
│  └─ ...                        │
│                                 │
├─────────────────────────────────┤
│  ⚙️ Paramètres  📊 Stats       │
└─────────────────────────────────┘
```

### 3.3 Actions sur Session

- **Renommer**: Double-clic ou menu contextuel
- **Épingler**: Garder en haut de liste
- **Archiver**: Masquer sans supprimer
- **Exporter**: JSON, Markdown, ou PDF
- **Partager**: Lien public (optionnel)
- **Dupliquer**: Copier comme template
- **Supprimer**: Soft delete puis purge

### 3.4 Génération Automatique de Titre

```typescript
async function generateSessionTitle(
  userMessage: string,
  assistantResponse: string
): Promise<string> {
  // 1. Appel LLM pour générer titre
  const prompt = `
    Génère un titre concis (max 50 caractères) pour cette conversation:
    User: ${userMessage.slice(0, 500)}
    Assistant: ${assistantResponse.slice(0, 500)}

    Titre:
  `;

  // 2. Fallback: extraction de mots-clés
  if (llmFails) {
    return extractKeywords(userMessage).slice(0, 3).join(' ');
  }
}
```

---

## 4. Interface de Chat

### 4.1 Layout Principal

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌─────────┐                                          ┌────────────┐ │
│  │ Sidebar │                  CHAT AREA               │ Context    │ │
│  │         │                                          │ Panel      │ │
│  │         │  ┌────────────────────────────────────┐  │            │ │
│  │ Sessions│  │                                    │  │ • Sources  │ │
│  │         │  │  Messages avec:                    │  │ • Files    │ │
│  │         │  │  • Markdown rendu                  │  │ • Links    │ │
│  │         │  │  • Code syntax highlight           │  │ • Entities │ │
│  │         │  │  • Tool calls inline               │  │            │ │
│  │         │  │  • Images/Previews                 │  │ ────────── │ │
│  │         │  │  • File attachments                │  │            │ │
│  │         │  │                                    │  │ Quick      │ │
│  │         │  │                                    │  │ Actions:   │ │
│  │         │  │                                    │  │ • Export   │ │
│  │         │  │                                    │  │ • Share    │ │
│  │         │  │                                    │  │ • Settings │ │
│  │         │  └────────────────────────────────────┘  │            │ │
│  │         │                                          │            │ │
│  │         │  ┌────────────────────────────────────┐  │            │ │
│  │         │  │ 📎 ➕ │  Écrivez votre message...  │  │            │ │
│  │         │  └────────────────────────────────────┘  │            │ │
│  └─────────┘                                          └────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 Composants de Message

#### Message Utilisateur
```tsx
<UserMessage>
  <Avatar user={user} />
  <Content>
    <Text>{message.content}</Text>
    {message.attachments.map(att => (
      <AttachmentPreview key={att.id} attachment={att} />
    ))}
  </Content>
  <Timestamp>{message.createdAt}</Timestamp>
</UserMessage>
```

#### Message Assistant (avec Tool Calls)
```tsx
<AssistantMessage>
  <Avatar variant="assistant" />
  <ContentBlocks>
    {blocks.map(block => {
      if (block.type === 'text') {
        return <MarkdownContent content={block.text} />;
      }
      if (block.type === 'tool') {
        return (
          <ToolCallBlock
            name={block.toolCall.name}
            args={block.toolCall.args}
            output={block.toolCall.output}
            isLoading={block.toolCall.isLoading}
          />
        );
      }
      if (block.type === 'image') {
        return <GeneratedImage src={block.url} prompt={block.prompt} />;
      }
      if (block.type === 'file') {
        return <GeneratedFile file={block.file} />;
      }
    })}
  </ContentBlocks>
</AssistantMessage>
```

### 4.3 Zone d'Input Enrichie

```tsx
<InputArea>
  {/* Attachments preview */}
  {attachments.length > 0 && (
    <AttachmentsBar>
      {attachments.map(att => (
        <AttachmentChip
          key={att.id}
          attachment={att}
          onRemove={() => removeAttachment(att.id)}
        />
      ))}
    </AttachmentsBar>
  )}

  {/* Main input */}
  <InputRow>
    <AttachButton onClick={openFilePicker}>
      <PaperclipIcon />
    </AttachButton>

    <UrlButton onClick={openUrlDialog}>
      <LinkIcon />
    </UrlButton>

    <TextArea
      value={input}
      onChange={setInput}
      onKeyDown={handleKeyDown}
      placeholder="Écrivez votre message... (Shift+Enter pour nouvelle ligne)"
      rows={1}
      maxRows={6}
    />

    <SendButton
      onClick={sendMessage}
      disabled={!input.trim() && attachments.length === 0}
    >
      <SendIcon />
    </SendButton>
  </InputRow>

  {/* Quick actions */}
  <QuickActions>
    <QuickAction icon="🔍" label="Rechercher" onClick={openSearch} />
    <QuickAction icon="📄" label="Générer rapport" onClick={openReportDialog} />
    <QuickAction icon="🖼️" label="Générer image" onClick={openImageDialog} />
    <QuickAction icon="📦" label="Exporter code" onClick={openExportDialog} />
  </QuickActions>
</InputArea>
```

### 4.4 Streaming et Tool Calls

#### Event Types SSE
```typescript
type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; output: string }
  | { type: 'image_start'; prompt: string }
  | { type: 'image_end'; url: string }
  | { type: 'file_generated'; file: GeneratedFile }
  | { type: 'source_added'; source: Source }
  | { type: 'error'; error: string }
  | { type: 'done'; usage: TokenUsage };
```

#### Affichage Tool Call
```
┌─────────────────────────────────────────────┐
│ 🔧 brain_search                             │
│ ▼ Arguments                                 │
│   query: "authentication patterns"          │
│   semantic: true                            │
├─────────────────────────────────────────────┤
│ ▼ Résultat (3 sources trouvées)            │
│   • auth-service.ts (score: 0.92)          │
│   • middleware.ts (score: 0.87)            │
│   • README.md (score: 0.81)                │
└─────────────────────────────────────────────┘
```

---

## 5. Agent IA (Lucie)

### 5.1 Architecture Agent

```python
# LangGraph-based agent
from langgraph.prebuilt import create_react_agent
from langchain_ollama import ChatOllama

class LucieAgent:
    def __init__(self, config: AgentConfig):
        self.llm = self._create_llm(config)
        self.tools = self._create_tools(config)
        self.graph = create_react_agent(
            self.llm,
            self.tools,
            checkpointer=self.memory,
        )

    def _create_tools(self, config) -> List[Tool]:
        return [
            # RAG Tools
            BrainSearchTool(ragforge_client),
            DocumentReaderTool(ragforge_client),

            # Ingestion Tools
            IngestFileTool(ragforge_client),
            IngestUrlTool(ragforge_client),
            IngestGitHubTool(ragforge_client),

            # Generation Tools
            GenerateImageTool(gemini_client),
            Generate3DTool(trellis_client),
            GenerateReportTool(report_generator),
            GenerateCodeTool(code_generator),

            # Analysis Tools
            VisionAnalyzerTool(gemini_client),
            OCRTool(tesseract_client),

            # Utility Tools
            WebSearchTool(tavily_client),
            CalculatorTool(),
            DateTimeTool(),
        ]
```

### 5.2 Tools Disponibles

| Catégorie | Tool | Description |
|-----------|------|-------------|
| **RAG** | `brain_search` | Recherche sémantique dans Neo4j |
| **RAG** | `read_document` | Lire un document indexé |
| **RAG** | `list_sources` | Lister les sources disponibles |
| **Ingestion** | `ingest_file` | Indexer un fichier uploadé |
| **Ingestion** | `ingest_url` | Crawler et indexer une URL |
| **Ingestion** | `ingest_github` | Cloner et indexer un repo |
| **Génération** | `generate_image` | Créer image via Gemini |
| **Génération** | `generate_3d` | Créer modèle 3D via Trellis |
| **Génération** | `generate_report` | Créer rapport PDF |
| **Génération** | `generate_code_zip` | Exporter code en ZIP |
| **Analyse** | `analyze_image` | Vision sur image |
| **Analyse** | `extract_text` | OCR sur document |
| **Web** | `web_search` | Recherche web |
| **Web** | `fetch_page` | Récupérer contenu page |

### 5.3 Personnalité de l'Agent

```yaml
name: Lucie
personality:
  tone: friendly, professional
  language: adapts to user (fr/en)
  specialties:
    - Code analysis and generation
    - Document synthesis
    - Visual content creation
    - Knowledge management

behaviors:
  - Cite sources when using RAG
  - Ask for clarification when ambiguous
  - Suggest follow-up actions
  - Warn about limitations

system_prompt: |
  Tu es Lucie, une assistante IA experte en analyse de code,
  gestion de connaissances et création de contenu.

  Tu as accès à un cerveau RAG puissant contenant des documents,
  du code, et des connaissances structurées.

  Quand tu utilises des sources, cite-les.
  Quand tu génères du contenu, propose des améliorations.
  Quand tu ne sais pas, dis-le honnêtement.
```

---

## 6. Capacités d'Ingestion

### 6.1 Types de Fichiers Supportés

| Catégorie | Extensions | Traitement |
|-----------|------------|------------|
| **Code** | .ts, .js, .py, .go, .rs, .java, .cpp, .c, .rb, .php | AST parsing, scopes |
| **Documents** | .pdf, .docx, .doc, .odt, .rtf | Extraction texte + OCR |
| **Données** | .xlsx, .xls, .csv, .json, .yaml, .xml | Parsing structuré |
| **Markdown** | .md, .mdx | Sections, liens, code blocks |
| **Images** | .png, .jpg, .gif, .webp, .svg | Vision description |
| **3D** | .glb, .gltf, .obj, .fbx | Multi-view rendering |
| **Archives** | .zip, .tar.gz | Extraction + traitement récursif |

### 6.2 Sources d'Ingestion

#### Upload Direct
```tsx
<DropZone
  accept={{
    'application/pdf': ['.pdf'],
    'application/zip': ['.zip'],
    'image/*': ['.png', '.jpg', '.gif', '.webp'],
    // ... autres types
  }}
  maxSize={100 * 1024 * 1024} // 100MB
  onDrop={handleFileDrop}
>
  <DropZoneContent>
    <UploadIcon />
    <Text>Glissez vos fichiers ici</Text>
    <Text variant="muted">ou cliquez pour parcourir</Text>
  </DropZoneContent>
</DropZone>
```

#### URL Web
```tsx
<UrlIngestionDialog>
  <Input
    type="url"
    placeholder="https://example.com/page"
    value={url}
    onChange={setUrl}
  />
  <Options>
    <Checkbox label="Crawler récursif" checked={recursive} />
    <Select
      label="Profondeur max"
      options={[1, 2, 3, 5]}
      value={depth}
    />
    <Input
      label="Patterns à inclure"
      placeholder="/docs/*, /api/*"
    />
  </Options>
  <Button onClick={ingestUrl}>Importer</Button>
</UrlIngestionDialog>
```

#### GitHub Repository
```tsx
<GitHubIngestionDialog>
  <Input
    placeholder="https://github.com/user/repo"
    value={repoUrl}
    onChange={setRepoUrl}
  />
  <Options>
    <Input label="Branch" defaultValue="main" />
    <Input
      label="Patterns à inclure"
      placeholder="src/**/*.ts, docs/**/*.md"
    />
    <Input
      label="Patterns à exclure"
      placeholder="node_modules/**, dist/**"
    />
    <Checkbox label="Inclure submodules" />
  </Options>
  <Button onClick={ingestGitHub}>Importer</Button>
</GitHubIngestionDialog>
```

### 6.3 Progress et Feedback

```tsx
<IngestionProgress>
  <ProgressHeader>
    <FileIcon type={file.type} />
    <FileName>{file.name}</FileName>
    <Status>{status}</Status>
  </ProgressHeader>

  <ProgressBar value={progress} max={100} />

  <ProgressDetails>
    <Detail label="Fichiers traités" value="42/128" />
    <Detail label="Nœuds créés" value="1,234" />
    <Detail label="Embeddings" value="856" />
  </ProgressDetails>

  {errors.length > 0 && (
    <ErrorList>
      {errors.map(err => (
        <ErrorItem key={err.file}>{err.message}</ErrorItem>
      ))}
    </ErrorList>
  )}
</IngestionProgress>
```

---

## 7. Génération de Contenu

### 7.1 Génération d'Images

```typescript
interface ImageGenerationRequest {
  prompt: string;
  enhance: boolean;           // Amélioration auto du prompt
  style?: 'realistic' | 'artistic' | 'technical' | '3d_render';
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3';
}

interface GeneratedImage {
  id: string;
  prompt: string;
  enhancedPrompt?: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: Date;
}
```

#### UX Flow
1. User demande "génère une image de..."
2. Agent améliore le prompt (optionnel)
3. Affiche preview "Génération en cours..."
4. Image apparaît inline dans le chat
5. Options: télécharger, régénérer, varier

### 7.2 Génération 3D

```typescript
interface ThreeDGenerationRequest {
  prompt?: string;            // Génération text-to-3D
  imageUrls?: string[];       // Génération image-to-3D
  style?: '3d_render' | 'realistic' | 'cartoon' | 'lowpoly';
}

interface Generated3DModel {
  id: string;
  glbUrl: string;
  thumbnailUrl: string;
  prompt?: string;
  sourceImages?: string[];
  createdAt: Date;
}
```

#### UX Flow
1. User uploade image(s) ou décrit l'objet
2. Génération multi-view si text-to-3D
3. Conversion via Trellis
4. Preview 3D inline avec viewer Three.js
5. Options: télécharger GLB, exporter autres formats

### 7.3 Génération de Rapports

```typescript
interface ReportRequest {
  title: string;
  sections: string[];         // Titres de sections à générer
  sources?: string[];         // Documents à synthétiser
  format: 'pdf' | 'docx' | 'md' | 'html';
  style?: 'formal' | 'technical' | 'executive';
  includeTableOfContents: boolean;
  includeSourceCitations: boolean;
}

interface GeneratedReport {
  id: string;
  title: string;
  format: string;
  downloadUrl: string;
  previewUrl: string;         // HTML preview
  pageCount: number;
  wordCount: number;
  sources: SourceCitation[];
  createdAt: Date;
}
```

#### Pipeline de Génération PDF
```
Sources RAG
    ↓
Synthèse par section (LLM)
    ↓
Assemblage Markdown
    ↓
Conversion HTML (avec styles)
    ↓
PDF via Puppeteer/WeasyPrint
    ↓
Upload vers Object Store
```

### 7.4 Génération de Code

```typescript
interface CodeGenerationRequest {
  description: string;
  language: string;
  framework?: string;
  includeTests: boolean;
  includeDocumentation: boolean;
}

interface GeneratedCode {
  id: string;
  files: CodeFile[];
  zipUrl?: string;            // Si multiple fichiers
  previewUrl: string;         // Syntax highlighted preview
}

interface CodeFile {
  path: string;
  content: string;
  language: string;
}
```

---

## 8. Intégration RAG

### 8.1 Recherche Contextuelle

```typescript
interface RAGSearchOptions {
  query: string;
  sessionId: string;          // Pour contexte session

  // Filters
  projectIds?: string[];
  documentTypes?: string[];
  dateRange?: { from: Date; to: Date };

  // Search params
  semantic: boolean;
  limit: number;
  minScore: number;

  // Enhancement
  rerank: boolean;
  summarize: boolean;
}

interface RAGSearchResult {
  sources: Source[];
  summary?: string;
  suggestedQueries?: string[];
}

interface Source {
  id: string;
  type: 'file' | 'scope' | 'section' | 'entity';
  title: string;
  path: string;
  content: string;
  score: number;
  highlights: string[];
  metadata: Record<string, unknown>;
}
```

### 8.2 Context Panel

Le panel contextuel affiche en temps réel:

```
┌─────────────────────────────┐
│ 📚 SOURCES UTILISÉES        │
├─────────────────────────────┤
│                             │
│ 📄 auth-service.ts          │
│    Score: 0.92              │
│    Lignes: 45-89            │
│    [Voir] [Copier]          │
│                             │
│ 📄 middleware.ts            │
│    Score: 0.87              │
│    Lignes: 12-34            │
│    [Voir] [Copier]          │
│                             │
├─────────────────────────────┤
│ 🔗 LIENS SUGGÉRÉS           │
│                             │
│ • Documentation Auth0       │
│ • JWT Best Practices        │
│                             │
├─────────────────────────────┤
│ 🏷️ ENTITÉS DÉTECTÉES        │
│                             │
│ AuthService (class)         │
│ validateToken (function)    │
│ JWT (technology)            │
│                             │
└─────────────────────────────┘
```

### 8.3 Attachement de Documents à la Session

```typescript
// Attacher un document à la session pour référence permanente
async function attachDocumentToSession(
  sessionId: string,
  documentId: string
): Promise<void> {
  // Le document sera inclus dans le contexte de toutes les requêtes
}

// L'agent peut référencer ces documents directement
const sessionContext = await getSessionContext(sessionId);
// Inclut: messages récents + documents attachés + entités mentionnées
```

---

## 9. API Backend

### 9.1 Endpoints Principaux

#### Auth
```
POST   /api/auth/[...nextauth]     # NextAuth handlers
GET    /api/auth/session           # Get current session
POST   /api/auth/register          # Email registration
POST   /api/auth/verify-email      # Email verification
```

#### Sessions
```
GET    /api/sessions               # List user sessions
POST   /api/sessions               # Create session
GET    /api/sessions/:id           # Get session details
PUT    /api/sessions/:id           # Update session (rename, etc.)
DELETE /api/sessions/:id           # Delete session
POST   /api/sessions/:id/archive   # Archive session
POST   /api/sessions/:id/export    # Export session
```

#### Messages
```
GET    /api/sessions/:id/messages  # Get session messages
POST   /api/sessions/:id/messages  # Add message (non-streaming)
```

#### Chat (Streaming)
```
POST   /api/chat                   # Stream chat response (SSE)
```

#### Ingestion
```
POST   /api/ingest/upload          # Upload and ingest files
POST   /api/ingest/url             # Ingest from URL
POST   /api/ingest/github          # Ingest GitHub repo
GET    /api/ingest/:id/status      # Get ingestion status
```

#### Generation
```
POST   /api/generate/image         # Generate image
POST   /api/generate/3d            # Generate 3D model
POST   /api/generate/report        # Generate report/PDF
POST   /api/generate/code          # Generate code
```

#### RAG
```
POST   /api/search                 # Search knowledge base
GET    /api/documents              # List indexed documents
GET    /api/documents/:id          # Get document details
DELETE /api/documents/:id          # Remove from index
```

### 9.2 Streaming Handler

```typescript
// /api/chat/route.ts
export async function POST(request: Request) {
  const { sessionId, message, attachments } = await request.json();
  const user = await getAuthUser(request);

  // Create stream
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  // Send SSE event helper
  const sendEvent = (event: StreamEvent) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  // Process in background
  (async () => {
    try {
      // Save user message
      await saveMessage(sessionId, 'user', message, attachments);

      // Get agent response with streaming
      const agentStream = await lucieAgent.stream({
        sessionId,
        message,
        attachments,
        userId: user.id,
      });

      for await (const event of agentStream) {
        sendEvent(event);
      }

      // Save assistant message
      await saveMessage(sessionId, 'assistant', accumulatedContent, generatedFiles);

      sendEvent({ type: 'done', usage: tokenUsage });
    } catch (error) {
      sendEvent({ type: 'error', error: error.message });
    } finally {
      writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

---

## 10. Base de Données

### 10.1 Schema PostgreSQL (Prisma)

```prisma
model User {
  id              String    @id @default(uuid())
  email           String    @unique
  name            String?
  avatarUrl       String?

  // Auth
  provider        String
  providerId      String?
  passwordHash    String?
  emailVerified   Boolean   @default(false)

  // Profile
  preferences     Json      @default("{}")
  tier            String    @default("free")
  quotaUsed       Int       @default(0)
  quotaLimit      Int       @default(1000)

  // Relations
  sessions        ChatSession[]
  apiKeys         ApiKey[]
  generatedImages GeneratedImage[]

  // Timestamps
  createdAt       DateTime  @default(now())
  lastLoginAt     DateTime?

  @@map("users")
}

model ChatSession {
  id                String    @id @default(uuid())
  userId            String
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Metadata
  title             String
  description       String?
  tags              String[]

  // State
  status            String    @default("active")
  isPinned          Boolean   @default(false)

  // Context
  projectId         String?
  attachedDocuments String[]

  // Stats
  messageCount      Int       @default(0)
  tokenCount        Int       @default(0)
  lastMessageAt     DateTime?

  // Relations
  messages          Message[]
  attachments       SessionAttachment[]

  // Timestamps
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@index([userId, status])
  @@index([userId, updatedAt])
  @@map("chat_sessions")
}

model Message {
  id              String      @id @default(uuid())
  sessionId       String
  session         ChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  role            String      // 'user' | 'assistant'
  content         String
  contentBlocks   Json?       // For tool calls, images, etc.

  // Metadata
  metadata        Json?
  tokenCount      Int?

  // Relations
  attachments     MessageAttachment[]
  generatedFiles  GeneratedFile[]

  // Timestamps
  createdAt       DateTime    @default(now())

  @@index([sessionId, createdAt])
  @@map("messages")
}

model MessageAttachment {
  id          String    @id @default(uuid())
  messageId   String
  message     Message   @relation(fields: [messageId], references: [id], onDelete: Cascade)

  type        String    // 'file' | 'url' | 'github'
  name        String
  url         String?
  mimeType    String?
  size        Int?

  // Ingestion status
  ingestStatus String   @default("pending")
  documentId   String?  // Reference to Neo4j document

  createdAt   DateTime  @default(now())

  @@map("message_attachments")
}

model GeneratedFile {
  id          String    @id @default(uuid())
  messageId   String
  message     Message   @relation(fields: [messageId], references: [id], onDelete: Cascade)

  type        String    // 'image' | '3d' | 'report' | 'code'
  name        String
  url         String
  mimeType    String
  size        Int?

  // Generation metadata
  prompt      String?
  metadata    Json?

  createdAt   DateTime  @default(now())

  @@map("generated_files")
}

model GeneratedImage {
  id              String    @id @default(uuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  prompt          String
  enhancedPrompt  String?
  url             String
  thumbnailUrl    String?

  width           Int
  height          Int

  createdAt       DateTime  @default(now())

  @@map("generated_images")
}
```

### 10.2 Intégration Neo4j (RagForge)

Les documents ingérés sont stockés dans Neo4j via RagForge:
- `File` nodes avec metadata Community
- `Scope` nodes (fonctions, classes)
- `Entity` nodes (personnes, concepts)
- Embeddings multi-dimensionnels

Lien avec PostgreSQL via `documentId` dans les attachments.

---

## 11. Phases d'Implémentation

### Phase 1: Foundation (2-3 semaines)
- [ ] Setup NextAuth avec Google OAuth
- [ ] Schema Prisma sessions/messages
- [ ] UI Sidebar sessions basique
- [ ] Chat interface avec streaming
- [ ] Intégration Lucie Agent existant
- [ ] Tool calls display

### Phase 2: Ingestion (2 semaines)
- [ ] Upload fichiers dans le chat
- [ ] Ingestion URL avec crawler
- [ ] Ingestion GitHub repos
- [ ] Progress feedback temps réel
- [ ] Attachments dans messages

### Phase 3: Génération (2 semaines)
- [ ] Génération images Gemini
- [ ] Génération 3D Trellis
- [ ] Génération rapports PDF
- [ ] Export code ZIP
- [ ] Preview inline

### Phase 4: RAG Avancé (1-2 semaines)
- [ ] Context panel sources
- [ ] Attachement documents session
- [ ] Recherche dans session
- [ ] Citations automatiques
- [ ] Entity highlighting

### Phase 5: Polish (1-2 semaines)
- [ ] Auth Email + Discord
- [ ] Export/Import sessions
- [ ] Responsive mobile
- [ ] Thèmes dark/light
- [ ] Onboarding flow
- [ ] Rate limiting

### Phase 6: Showcase (1 semaine)
- [ ] Landing page démo
- [ ] Exemples pré-chargés
- [ ] Vidéo démo
- [ ] Documentation utilisateur

---

## 12. Métriques de Succès

### Techniques
- [ ] Latence streaming < 100ms first token
- [ ] Ingestion 1000 fichiers < 5 minutes
- [ ] Recherche RAG < 500ms
- [ ] Uptime > 99.9%

### UX
- [ ] Session switch < 200ms
- [ ] Upload progress smooth
- [ ] Tool calls visibles immédiatement
- [ ] Mobile responsive

### Business
- [ ] Démo investisseurs prête
- [ ] 3 use cases showcases documentés
- [ ] Comparaison ChatGPT favorable
- [ ] Testimonials beta users

---

## Annexes

### A. Références Implémentation

| Feature | Référence |
|---------|-----------|
| Streaming chat | `luciform-hub/app/components/ChatWidget.tsx` |
| Session management | `lr_chat/src/lib/sessions/` |
| Tool calls display | `luciform-hub/app/components/ChatWidget.tsx:124-145` |
| Auth middleware | `lr_chat/src/lib/auth/middleware.ts` |
| Markdown rendering | `luciform-hub` react-markdown + remark-gfm |

### B. Stack Technique

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, React 19, Tailwind 4 |
| Backend | Next.js API Routes, tRPC (optionnel) |
| Database | PostgreSQL (Prisma), Neo4j (RagForge) |
| Auth | NextAuth.js v5 |
| Agent | LangGraph, LangChain, Ollama/Gemini |
| Storage | S3/R2/Local filesystem |
| PDF | Puppeteer ou WeasyPrint |
| 3D | Three.js viewer, Trellis generation |

### C. Variables d'Environnement

```env
# Auth
NEXTAUTH_SECRET=
NEXTAUTH_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Database
DATABASE_URL=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=

# AI
GEMINI_API_KEY=
OLLAMA_URL=
REPLICATE_API_TOKEN=

# Storage
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Agent
LUCIE_AGENT_URL=
```

---

*Document vivant - Mis à jour au fur et à mesure de l'implémentation.*
