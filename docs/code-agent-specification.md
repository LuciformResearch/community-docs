# Code Agent Specification

> **Status**: Design
> **Created**: 2026-01-19
> **Related**: `chat-interface-specification.md`, `chat-interface-gap-analysis.md`

## Overview

Le **Code Agent** est un agent spécialisé dans la génération et modification de code, complémentaire au **Research Agent** (Lucie actuel). Les deux agents travaillent ensemble pour offrir une expérience complète:

| Agent | Rôle | Personnalité |
|-------|------|--------------|
| **Lucie Research** | Recherche, RAG, exploration de code existant | Curieuse, analytique |
| **Lucie Code** | Génération, édition, build de projets | Créative, pratique |

> *"Les deux Lucie" - quand elles parlent à l'utilisateur, c'est amusant de les voir collaborer.*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chat Interface                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User: "Crée-moi une app React avec auth"                      │
│                                                                 │
│  ┌─────────────────┐          ┌─────────────────┐              │
│  │ Lucie Research  │◄────────►│  Lucie Code     │              │
│  │                 │          │                 │              │
│  │ • search_brain  │          │ • create_file   │              │
│  │ • explore_node  │          │ • edit_file     │              │
│  │ • fetch_url     │          │ • build_project │              │
│  │ • grep_files    │          │ • run_command   │              │
│  └────────┬────────┘          └────────┬────────┘              │
│           │                            │                        │
│           ▼                            ▼                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Virtual File System (Neo4j)                    ││
│  │                                                             ││
│  │  /projects/{projectId}/                                     ││
│  │  ├── package.json                                           ││
│  │  ├── src/                                                   ││
│  │  │   ├── App.tsx                                            ││
│  │  │   └── components/                                        ││
│  │  └── ...                                                    ││
│  └─────────────────────────────────────────────────────────────┘│
│           │                            │                        │
│           ▼                            ▼                        │
│  ┌─────────────────┐          ┌─────────────────┐              │
│  │   ZIP Export    │          │  GitHub Sync    │              │
│  │   (Strategy 1)  │          │  (Strategy 2)   │              │
│  └─────────────────┘          └─────────────────┘              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deux Stratégies de Livraison

### Strategy 1: ZIP Export (Sans Auth GitHub)

L'utilisateur travaille avec des fichiers virtuels stockés dans Neo4j. À la fin:
- Download d'un `.zip` contenant tout le projet
- Instructions pour lancer localement
- Preview web si applicable (via iframe sandbox)

**Avantages**:
- Pas besoin d'auth GitHub
- Simple, rapide
- Fonctionne pour tous les utilisateurs

### Strategy 2: GitHub Integration (Avec Auth)

Si l'utilisateur est connecté via GitHub OAuth:
- Création automatique de repo
- Commits au fur et à mesure
- PR pour review
- GitHub Actions pour CI/CD
- GitHub Pages pour preview

**Avantages**:
- Workflow professionnel
- Historique git complet
- Collaboration possible

---

## Tools du Code Agent

### Outils Existants (MCP RagForge) - À Adapter

Ces outils existent déjà mais doivent être adaptés pour le Virtual File System:

| Tool | MCP Original | Adaptation Nécessaire |
|------|--------------|----------------------|
| `read_file` | Lit fichiers locaux | Lire depuis Neo4j VirtualFile |
| `write_file` | Écrit fichiers locaux | Écrire dans Neo4j VirtualFile |
| `edit_file` | old_string/new_string | Même logique sur VirtualFile |
| `delete_path` | Supprime local | Supprimer node VirtualFile |
| `glob_files` | Glob sur filesystem | Glob sur VirtualFile.path |
| `grep_files` | Regex sur fichiers | Regex sur VirtualFile.content |
| `list_directory` | ls local | Liste VirtualFiles par path prefix |

### Nouveaux Outils

```typescript
// Project Management
create_project({
  name: string,
  template?: "react" | "nextjs" | "express" | "python-fastapi" | "blank",
  description?: string
})

build_project({ projectId: string })  // Validates, lints, type-checks
export_zip({ projectId: string })     // Downloads as .zip

// GitHub Integration (Strategy 2)
github_init_repo({ projectId: string, repoName: string, private?: boolean })
github_commit({ projectId: string, message: string, files?: string[] })
github_push({ projectId: string })
github_create_pr({ projectId: string, title: string, body: string, base?: string })

// Preview & Deploy
preview_project({ projectId: string })  // Sandbox iframe preview
deploy_preview({ projectId: string })   // Vercel/Netlify preview URL

// Asset Generation
generate_asset_image({
  prompt: string,
  outputPath: string,  // e.g., "public/logo.png"
  projectId: string
})

generate_asset_3d({
  prompt: string,
  outputPath: string,  // e.g., "public/models/character.glb"
  projectId: string
})

// Templates & Instructions
list_templates()
apply_template({ projectId: string, template: string })
get_framework_docs({ framework: string, topic?: string })
```

---

## Virtual File System

### Neo4j Schema

```cypher
// VirtualFile node
(:VirtualFile {
  uuid: string,
  projectId: string,
  path: string,           // "src/components/Button.tsx"
  content: string,        // File content
  mimeType: string,       // "text/typescript"
  size: number,           // bytes
  createdAt: datetime,
  updatedAt: datetime,
  // For binary files (images, 3D)
  binaryData: string,     // Base64 encoded
  isBinary: boolean
})

// VirtualProject node
(:VirtualProject {
  uuid: string,
  userId: string,         // Link to Prisma User
  name: string,
  description: string,
  template: string,
  createdAt: datetime,
  updatedAt: datetime,
  // GitHub sync info (Strategy 2)
  githubRepo: string,     // "owner/repo"
  githubBranch: string,   // "main"
  lastCommitSha: string
})

// Relationships
(:VirtualFile)-[:IN_PROJECT]->(:VirtualProject)
(:VirtualProject)-[:OWNED_BY]->(:User)  // User from Prisma (via userId)
```

### Handling User Uploads

Quand l'utilisateur upload un `.zip`:
1. Extraire tous les fichiers
2. Créer des nodes `VirtualFile` pour chaque fichier
3. Parser le code (via UnifiedProcessor) pour indexer dans le RAG
4. L'agent peut ensuite lire/modifier ces fichiers

---

## Project Templates

### Minimal Templates (Built-in)

```yaml
templates:
  blank:
    files: []
    description: "Empty project"

  react:
    files:
      - package.json (React + Vite)
      - vite.config.ts
      - src/main.tsx
      - src/App.tsx
      - index.html
    description: "React + Vite + TypeScript"

  nextjs:
    files:
      - package.json (Next.js)
      - next.config.js
      - app/layout.tsx
      - app/page.tsx
    description: "Next.js 14 App Router"

  express:
    files:
      - package.json (Express)
      - src/index.ts
      - src/routes/index.ts
    description: "Express + TypeScript"

  python-fastapi:
    files:
      - requirements.txt
      - main.py
      - routers/__init__.py
    description: "FastAPI + Python"
```

### Template Sources (Medium/Advanced)

- GitHub template repos
- User-saved templates
- Community templates

---

## Database Options

### Option A: Virtual SQLite (Minimal)

Fichier SQLite stocké comme VirtualFile binaire:
- Agent génère le schema SQL
- Peut être téléchargé avec le ZIP
- Pas de runtime, juste le fichier

### Option B: Supabase Integration (Advanced)

Si l'utilisateur a un compte Supabase:
- Création de projet Supabase via API
- Génération de migrations
- Seed data
- Connection string fournie au projet

**Coût**: Nécessite abonnement Supabase (ou tier gratuit limité)

### Option C: Prisma + Virtual PostgreSQL (Future)

Vision: Conteneur PostgreSQL éphémère pour preview:
- Spin up un container Docker
- Apply migrations Prisma
- Seed data
- URL de preview temporaire

**Complexité**: Élevée, nécessite infrastructure

---

## Execution Environment

### Le Problème

L'agent doit pouvoir:
- `npm install` / `pip install`
- `npm run dev` / `python main.py`
- Tester des APIs, voir les logs
- Accéder au serveur de dev (localhost:3000)
- Utiliser des bases de données (PostgreSQL, Redis)
- **Tout ça de manière transparente** (elle croit être en local)

### Architecture Hybride: Terminal Browser + Docker Backend ⭐

**L'idée**: L'UI terminal est dans le browser (xterm.js), mais les commandes sont exécutées dans Docker sur le host. L'agent voit un environnement "local" mais c'est isolé dans des containers.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Terminal UI (xterm.js) - Ce que l'USER et l'AGENT voient  │ │
│  │                                                             │ │
│  │  🤖 lucie ~/myapp $ python main.py                         │ │
│  │  INFO:     Uvicorn running on http://0.0.0.0:8000         │ │
│  │  🤖 lucie ~/myapp $ psql -c "SELECT * FROM users"          │ │
│  │   id | name  | email                                       │ │
│  │  ----+-------+------------------                           │ │
│  │    1 | Alice | alice@example.com                           │ │
│  │                                                             │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────┘
                              │ WebSocket (bidirectional)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Host Machine                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Terminal Proxy Server (Node.js)                            │ │
│  │  • Reçoit commandes via WebSocket                          │ │
│  │  • Route vers le bon container Docker                      │ │
│  │  • Stream stdout/stderr en temps réel                      │ │
│  │  • Gère le lifecycle des containers                        │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
│                              │ Docker API                        │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐     │
│  │   Project   │      │   Project   │      │  Services   │     │
│  │  Container  │      │  Container  │      │  Container  │     │
│  │             │      │             │      │             │     │
│  │ • Node.js   │      │ • Python    │      │ • Postgres  │     │
│  │ • Code      │      │ • FastAPI   │      │ • Redis     │     │
│  │ • Port 3001 │      │ • Port 8001 │      │ • MongoDB   │     │
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘     │
│         └────────────────────┼────────────────────┘             │
│                              ▼                                   │
│                 Docker Network "ragforge"                        │
│           (tous les containers communiquent)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Ce que l'Agent Croit vs La Réalité

| L'agent écrit/voit | Ce qui se passe vraiment |
|--------------------|--------------------------|
| `python main.py` | Exécuté dans container Python |
| `npm run dev` | Exécuté dans container Node |
| `localhost:5432` | Container PostgreSQL |
| `localhost:6379` | Container Redis |
| `curl http://api:8000` | Requête inter-container |
| Fichiers dans `~/project` | Volume Docker monté |

### Pourquoi cette Architecture

| Avantage | Explication |
|----------|-------------|
| **Multi-runtime** | Node, Python, Go, Rust, PHP... tout marche |
| **Vraies DBs** | PostgreSQL, MongoDB, Redis réels |
| **Isolation** | Chaque projet dans son container |
| **Réseau réaliste** | Microservices, API calls inter-containers |
| **Agent transparent** | Elle code comme en local |
| **UI moderne** | Terminal dans le browser, pas de SSH |
| **Streaming** | Output en temps réel via WebSocket |

### Options de Fallback

| Mode | Use Case | Ce qui tourne où |
|------|----------|------------------|
| **Docker (recommandé)** | Production | Tout dans Docker |
| **Direct Host** | Demo rapide | Directement sur ta machine |
| **WebContainer only** | Frontend simple | Node.js dans browser (pas de Python/DB) |

---

## Implementation: Terminal Proxy

### Architecture Détaillée

```
Browser                          Host
───────                          ────
xterm.js ◄──── WebSocket ────► Proxy Server ◄──── Docker API ────► Containers
    │                               │
    │ user types                    │ exec command
    │ "npm install"                 │ in container
    │                               │
    ▼                               ▼
 Display ◄─────────────────────── Stream stdout/stderr
```

### Terminal Proxy Server

```typescript
// lib/terminal/proxy-server.ts
import { WebSocketServer, WebSocket } from 'ws';
import Docker from 'dockerode';
import { Duplex } from 'stream';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

interface ProjectSession {
  projectId: string;
  container: Docker.Container;
  execStream: Duplex | null;
}

const sessions = new Map<WebSocket, ProjectSession>();

export function startTerminalProxy(port: number = 8765) {
  const wss = new WebSocketServer({ port });

  wss.on('connection', async (ws, req) => {
    const projectId = new URL(req.url!, `http://localhost`).searchParams.get('projectId');
    if (!projectId) {
      ws.close(1008, 'Missing projectId');
      return;
    }

    console.log(`[Terminal] New connection for project: ${projectId}`);

    // Get or create container for this project
    const container = await getOrCreateProjectContainer(projectId);

    // Start interactive shell
    const exec = await container.exec({
      Cmd: ['/bin/bash'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: [
        'TERM=xterm-256color',
        'PS1=🤖 lucie ~/project $ ',  // Custom prompt
      ],
      WorkingDir: '/app',
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    sessions.set(ws, { projectId, container, execStream: stream });

    // Stream container output → browser
    stream.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: chunk.toString() }));
      }
    });

    // Browser input → container
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'input') {
        stream.write(msg.data);
      } else if (msg.type === 'resize') {
        // Handle terminal resize
        exec.resize({ h: msg.rows, w: msg.cols });
      }
    });

    ws.on('close', () => {
      console.log(`[Terminal] Connection closed for project: ${projectId}`);
      stream.end();
      sessions.delete(ws);
    });
  });

  console.log(`[Terminal] Proxy server running on ws://localhost:${port}`);
}

async function getOrCreateProjectContainer(projectId: string): Promise<Docker.Container> {
  const containerName = `ragforge-project-${projectId}`;

  // Check if container exists
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    if (!info.State.Running) {
      await container.start();
    }
    return container;
  } catch (e) {
    // Container doesn't exist, create it
  }

  // Ensure project directory exists
  const projectDir = `/home/luciedefraiteur/ragforge-projects/${projectId}`;

  // Create container
  const container = await docker.createContainer({
    name: containerName,
    Image: 'ragforge-dev:latest',
    Tty: true,
    OpenStdin: true,
    WorkingDir: '/app',
    HostConfig: {
      Binds: [`${projectDir}:/app`],
      NetworkMode: 'ragforge-network',
      // Port mappings for dev servers
      PortBindings: {
        '3000/tcp': [{ HostPort: '' }],  // Random available port
        '8000/tcp': [{ HostPort: '' }],
      },
    },
    ExposedPorts: {
      '3000/tcp': {},
      '8000/tcp': {},
    },
    Labels: {
      'ragforge.project': projectId,
      'ragforge.type': 'project',
    },
  });

  await container.start();
  return container;
}
```

### Browser Terminal Client

```typescript
// components/code/DockerTerminal.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

interface Props {
  projectId: string;
  onServerReady?: (port: number, url: string) => void;
}

export function DockerTerminal({ projectId, onServerReady }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    // Initialize xterm.js
    const term = new Terminal({
      theme: {
        background: '#1a1b26',  // Tokyo Night
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        black: '#32344a',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#ad8ee6',
        cyan: '#449dab',
        white: '#787c99',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: 'block',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalRef.current!);
    fitAddon.fit();
    termRef.current = term;

    // Connect to terminal proxy
    const ws = new WebSocket(`ws://localhost:8765?projectId=${projectId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln('\x1b[36m🤖 Connected to Lucie environment\x1b[0m');
      term.writeln('\x1b[90mType "lucie help" for custom commands\x1b[0m\n');

      // Send initial resize
      ws.send(JSON.stringify({
        type: 'resize',
        rows: term.rows,
        cols: term.cols,
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'output') {
        term.write(msg.data);

        // Detect server ready messages
        const serverMatch = msg.data.match(/http:\/\/(?:localhost|0\.0\.0\.0):(\d+)/);
        if (serverMatch && onServerReady) {
          onServerReady(parseInt(serverMatch[1]), `http://localhost:${serverMatch[1]}`);
        }
      }
    };

    ws.onerror = (err) => {
      term.writeln(`\x1b[31mConnection error\x1b[0m`);
    };

    ws.onclose = () => {
      term.writeln('\n\x1b[33mDisconnected from environment\x1b[0m');
    };

    // Send keyboard input to container
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'resize',
          rows: term.rows,
          cols: term.cols,
        }));
      }
    });
    resizeObserver.observe(terminalRef.current!);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [projectId]);

  return (
    <div
      ref={terminalRef}
      className="h-full w-full bg-[#1a1b26] rounded-lg overflow-hidden"
    />
  );
}
```

### Docker Image Multi-Runtime

```dockerfile
# images/ragforge-dev.Dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tools
RUN apt-get update && apt-get install -y \
    curl wget git vim nano \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm tsx yarn

# Python 3.12
RUN apt-get update && apt-get install -y \
    python3.12 python3.12-venv python3-pip \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && pip install --upgrade pip poetry

# Database clients
RUN apt-get update && apt-get install -y \
    postgresql-client \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

# Lucie CLI (custom commands)
COPY lucie-cli.sh /usr/local/bin/lucie
RUN chmod +x /usr/local/bin/lucie

WORKDIR /app

# Custom bashrc for nice prompt
RUN echo 'PS1="🤖 lucie \w $ "' >> /root/.bashrc
RUN echo 'alias ll="ls -la"' >> /root/.bashrc

CMD ["/bin/bash"]
```

### Lucie CLI dans le Container

```bash
#!/bin/bash
# /usr/local/bin/lucie - Custom CLI dans le container

case "$1" in
  help)
    echo "🤖 Lucie Commands:"
    echo "  lucie help              Show this help"
    echo "  lucie status            Show project status"
    echo "  lucie db                Connect to database"
    echo "  lucie logs              Show recent logs"
    echo ""
    echo "Standard commands (npm, python, etc.) work normally!"
    ;;

  status)
    echo "📁 Project files:"
    ls -la
    echo ""
    echo "🔌 Running processes:"
    ps aux | grep -E "(node|python|uvicorn)" | grep -v grep
    ;;

  db)
    if [ -f ".env" ]; then
      source .env
    fi
    psql "${DATABASE_URL:-postgresql://postgres:postgres@postgres:5432/app}"
    ;;

  logs)
    tail -f /var/log/app.log 2>/dev/null || echo "No logs found"
    ;;

  *)
    echo "Unknown command: $1"
    echo "Try 'lucie help'"
    exit 1
    ;;
esac
```

### Docker Compose pour les Services

```yaml
# docker-compose.services.yml
version: '3.8'

services:
  # PostgreSQL partagé
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    volumes:
      - ragforge-postgres:/var/lib/postgresql/data
    networks:
      - ragforge
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Redis partagé
  redis:
    image: redis:7-alpine
    networks:
      - ragforge
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Terminal Proxy
  terminal-proxy:
    build:
      context: .
      dockerfile: images/terminal-proxy.Dockerfile
    ports:
      - "8765:8765"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /home/luciedefraiteur/ragforge-projects:/ragforge-projects
    networks:
      - ragforge
    environment:
      - PROJECTS_DIR=/ragforge-projects

networks:
  ragforge:
    driver: bridge

volumes:
  ragforge-postgres:
```

---

## Récapitulatif: Options d'Exécution

| Phase | Mode | Frontend | Backend | DBs |
|-------|------|----------|---------|-----|
| **Minimal** | Direct Host | ❌ | ✅ Node/Python | SQLite |
| **Medium** | Docker Hybrid | xterm.js browser | Docker containers | Postgres/Redis |
| **Advanced** | Full Docker | xterm.js browser | K8s/multi-tenant | Managed DBs |

### Recommandation pour Showcase

```yaml
# Mode recommandé pour demo
execution:
  mode: "docker-hybrid"
  terminal:
    port: 8765
  docker:
    network: "ragforge"
    projectsDir: "~/ragforge-projects"
```

Tout tourne sur ta machine, mais isolé proprement dans Docker. L'agent et l'utilisateur voient un terminal "local" alors que c'est containerisé.

---

## Ancien contenu: Docker Direct (référence)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Code Agent                                   │
│                         │                                        │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Execution Manager                               ││
│  │                                                              ││
│  │  if (config.useDocker) {                                    ││
│  │    → Docker Container per Project                           ││
│  │  } else {                                                   ││
│  │    → Direct execution on host (demo mode)                   ││
│  │  }                                                          ││
│  └─────────────────────────────────────────────────────────────┘│
│                         │                                        │
│         ┌───────────────┼───────────────┐                       │
│         ▼               ▼               ▼                       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ Project A   │ │ Project B   │ │ Project C   │               │
│  │ Container   │ │ Container   │ │ Container   │               │
│  │             │ │             │ │             │               │
│  │ Node 20    │ │ Python 3.12 │ │ Node 20    │               │
│  │ Port: 3001 │ │ Port: 8001  │ │ Port: 3002 │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation: Docker Strategy

#### 1. Base Images

```dockerfile
# images/node.Dockerfile
FROM node:20-slim
WORKDIR /app
# Pre-install common tools
RUN npm install -g pnpm tsx

# images/python.Dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install --upgrade pip
```

#### 2. Project Container Lifecycle

```typescript
interface ProjectContainer {
  projectId: string;
  containerId: string;
  port: number;           // Mapped host port
  status: 'starting' | 'running' | 'stopped' | 'error';
  logs: string[];
  startedAt: Date;
}

class ExecutionManager {
  private containers: Map<string, ProjectContainer> = new Map();
  private portPool: number[] = [3001, 3002, 3003, ...]; // Available ports

  /**
   * Start a dev server for a project
   */
  async startDevServer(projectId: string, command: string): Promise<ProjectContainer> {
    // 1. Export VirtualFiles to temp directory
    const tempDir = await this.exportToTemp(projectId);

    // 2. Detect project type (Node, Python, etc.)
    const projectType = await this.detectProjectType(tempDir);

    // 3. Get available port
    const port = this.portPool.shift()!;

    // 4. Start container
    const containerId = await this.docker.createContainer({
      Image: `ragforge-${projectType}`,
      Cmd: ['sh', '-c', command],  // e.g., "npm install && npm run dev"
      HostConfig: {
        Binds: [`${tempDir}:/app`],
        PortBindings: { '3000/tcp': [{ HostPort: String(port) }] }
      },
      Env: [
        'NODE_ENV=development',
        `PORT=3000`  // Internal port, mapped to host port
      ]
    });

    await this.docker.startContainer(containerId);

    // 5. Track container
    const container: ProjectContainer = {
      projectId,
      containerId,
      port,
      status: 'starting',
      logs: [],
      startedAt: new Date()
    };
    this.containers.set(projectId, container);

    // 6. Stream logs
    this.streamLogs(containerId, container);

    return container;
  }

  /**
   * Run a one-off command (npm install, build, etc.)
   */
  async runCommand(projectId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const tempDir = await this.exportToTemp(projectId);
    const projectType = await this.detectProjectType(tempDir);

    // Run in ephemeral container
    const result = await this.docker.run({
      Image: `ragforge-${projectType}`,
      Cmd: ['sh', '-c', command],
      HostConfig: {
        Binds: [`${tempDir}:/app`],
        AutoRemove: true
      }
    });

    // Sync changes back to VirtualFiles
    await this.syncBackToVirtual(projectId, tempDir);

    return result;
  }

  /**
   * Stop and cleanup a project's container
   */
  async stopDevServer(projectId: string): Promise<void> {
    const container = this.containers.get(projectId);
    if (!container) return;

    await this.docker.stopContainer(container.containerId);
    await this.docker.removeContainer(container.containerId);

    // Return port to pool
    this.portPool.push(container.port);
    this.containers.delete(projectId);
  }
}
```

#### 3. Tools pour l'Agent

```typescript
// New tools for execution
run_command({
  projectId: string,
  command: string,        // "npm install", "npm run build", etc.
  timeout?: number        // Default: 60s
}): Promise<{ stdout, stderr, exitCode }>

start_dev_server({
  projectId: string,
  command?: string        // Default: auto-detect (npm run dev, python main.py)
}): Promise<{ port: number, url: string }>

stop_dev_server({
  projectId: string
}): Promise<void>

get_server_logs({
  projectId: string,
  lines?: number          // Last N lines
}): Promise<string[]>

get_server_status({
  projectId: string
}): Promise<{ status, port, uptime, lastLogs }>
```

#### 4. Example Flow

```
User: "Crée une API Express et teste-la"

[Lucie Code] ⚙️ Je crée le projet Express...
  → create_project({ name: "my-api", template: "express" })

[Lucie Code] 📦 Installation des dépendances...
  → run_command({ projectId, command: "npm install" })

[Lucie Code] 🚀 Je démarre le serveur...
  → start_dev_server({ projectId })
  → Serveur disponible sur http://localhost:3001

[Lucie Code] 🧪 Je teste l'API...
  → fetch("http://localhost:3001/api/health")
  → ✅ Response: { status: "ok" }

[Lucie Code] Le serveur fonctionne! Tu peux accéder à http://localhost:3001
```

### Demo Mode: Direct Execution (Sans Docker)

Pour le showcase sur ta machine, mode simplifié:

```typescript
class DirectExecutionManager {
  private processes: Map<string, ChildProcess> = new Map();
  private projectDirs: Map<string, string> = new Map();

  async startDevServer(projectId: string, command?: string): Promise<{ port: number }> {
    // 1. Export to ~/ragforge-projects/{projectId}/
    const projectDir = path.join(os.homedir(), 'ragforge-projects', projectId);
    await this.exportVirtualFiles(projectId, projectDir);

    // 2. Detect command if not provided
    const cmd = command || await this.detectDevCommand(projectDir);

    // 3. Start process directly
    const port = await this.findAvailablePort(3000);
    const proc = spawn('sh', ['-c', cmd], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port) }
    });

    this.processes.set(projectId, proc);
    this.projectDirs.set(projectId, projectDir);

    return { port };
  }

  async runCommand(projectId: string, command: string): Promise<CommandResult> {
    const projectDir = this.projectDirs.get(projectId)
      || path.join(os.homedir(), 'ragforge-projects', projectId);

    // Export latest VirtualFiles
    await this.exportVirtualFiles(projectId, projectDir);

    // Run command
    const result = await execAsync(command, { cwd: projectDir });

    // Sync back any file changes
    await this.syncBackToVirtual(projectId, projectDir);

    return result;
  }
}
```

**Config:**
```yaml
# ragforge.config.yaml
execution:
  mode: "direct"  # or "docker"
  projectsDir: "~/ragforge-projects"

  # Docker settings (if mode: docker)
  docker:
    socketPath: "/var/run/docker.sock"
    images:
      node: "ragforge-node:latest"
      python: "ragforge-python:latest"
```

### Sync VirtualFiles ↔ Disk

```typescript
/**
 * Export VirtualFiles to disk for execution
 */
async function exportVirtualFiles(projectId: string, targetDir: string): Promise<void> {
  const files = await neo4j.run(`
    MATCH (f:VirtualFile)-[:IN_PROJECT]->(:VirtualProject {uuid: $projectId})
    RETURN f.path AS path, f.content AS content, f.isBinary AS isBinary, f.binaryData AS binaryData
  `, { projectId });

  for (const record of files.records) {
    const filePath = path.join(targetDir, record.get('path'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (record.get('isBinary')) {
      await fs.writeFile(filePath, Buffer.from(record.get('binaryData'), 'base64'));
    } else {
      await fs.writeFile(filePath, record.get('content'));
    }
  }
}

/**
 * Sync disk changes back to VirtualFiles
 * (After npm install adds node_modules, etc.)
 */
async function syncBackToVirtual(projectId: string, sourceDir: string): Promise<void> {
  // Only sync source files, not node_modules
  const patterns = ['**/*.{ts,tsx,js,jsx,json,md,css,html}', '!node_modules/**'];
  const files = await glob(patterns, { cwd: sourceDir });

  for (const file of files) {
    const content = await fs.readFile(path.join(sourceDir, file), 'utf-8');
    await neo4j.run(`
      MERGE (f:VirtualFile {projectId: $projectId, path: $path})
      SET f.content = $content, f.updatedAt = datetime()
    `, { projectId, path: file, content });
  }
}
```

### Roadmap Update

| Phase | Execution Feature |
|-------|-------------------|
| **Minimal** | Direct execution (demo mode), `run_command` tool |
| **Medium** | Docker containers, `start_dev_server`/`stop_dev_server`, log streaming |
| **Advanced** | Ephemeral VMs, multi-tenant isolation, resource limits |

---

## Preview & Deployment

### Sandbox Preview (Minimal)

```typescript
// iframe sandbox pour HTML/JS statique
<iframe
  sandbox="allow-scripts"
  srcDoc={generatedHtml}
/>
```

Limitations:
- Pas de backend
- Pas de routing côté serveur
- CSP restrictive

### WebContainer Preview (Medium) ⭐ RECOMMANDÉ

Utiliser [WebContainers](https://webcontainers.io/) (StackBlitz):
- Node.js dans le browser (WASM)
- npm install, npm run dev
- Preview complète d'apps React/Next.js
- **Zero backend requis pour l'exécution**

#### Architecture WebContainer

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Notre Interface                          │ │
│  │  ┌──────────────┬──────────────┬─────────────────────────┐ │ │
│  │  │  File Tree   │  Code Editor │      Preview            │ │ │
│  │  │              │  (Monaco)    │      (iframe)           │ │ │
│  │  │  src/        │              │  ┌─────────────────┐    │ │ │
│  │  │  ├─ App.tsx  │  export...   │  │  localhost:5173 │    │ │ │
│  │  │  └─ main.tsx │              │  │  (React app)    │    │ │ │
│  │  └──────────────┴──────────────┴──┴─────────────────┴────┘ │ │
│  │  ┌────────────────────────────────────────────────────────┐ │ │
│  │  │                    Terminal (xterm.js)                  │ │ │
│  │  │  $ npm install                                          │ │ │
│  │  │  $ npm run dev                                          │ │ │
│  │  │  $ lucie help        ← Custom command!                  │ │ │
│  │  │  $ lucie generate component Button                      │ │ │
│  │  └────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     WebContainer                            │ │
│  │  • Node.js (WASM)     • File System (in-memory)            │ │
│  │  • npm/pnpm           • Process spawning                   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

#### Console Custom avec Commandes Lucie

On intercepte les commandes et on ajoute les nôtres:

```typescript
import { WebContainer } from '@webcontainer/api';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

class LucieTerminal {
  private webcontainer: WebContainer;
  private terminal: Terminal;
  private currentDir: string = '/';

  // Nos commandes custom
  private customCommands: Record<string, (args: string[]) => Promise<string>> = {
    'lucie': async (args) => this.handleLucieCommand(args),
    'help': async () => this.showHelp(),
    'ask': async (args) => this.askLucie(args.join(' ')),
    'generate': async (args) => this.generateWithLucie(args),
    'explain': async (args) => this.explainCode(args),
    'fix': async (args) => this.fixCode(args),
    'deploy': async () => this.deployProject(),
  };

  async handleInput(input: string): Promise<void> {
    const [cmd, ...args] = input.trim().split(' ');

    // Check if it's a custom command
    if (this.customCommands[cmd]) {
      const result = await this.customCommands[cmd](args);
      this.terminal.writeln(result);
      return;
    }

    // Otherwise, run in WebContainer
    const process = await this.webcontainer.spawn(cmd, args);

    // Stream output to terminal
    process.output.pipeTo(new WritableStream({
      write: (data) => this.terminal.write(data)
    }));

    await process.exit;
  }

  private async handleLucieCommand(args: string[]): Promise<string> {
    const subcommand = args[0];

    switch (subcommand) {
      case 'help':
        return `
🤖 Lucie Commands:
  lucie help                  Show this help
  lucie generate <type> <name>  Generate component/page/api
  lucie explain <file>        Explain code in file
  lucie fix <file>            Fix errors in file
  lucie ask <question>        Ask Lucie anything
  lucie deploy                Deploy to preview URL
  lucie search <query>        Search in knowledge base

Standard commands (npm, node, etc.) work normally!
        `.trim();

      case 'generate':
        return await this.generateWithLucie(args.slice(1));

      case 'search':
        return await this.searchKnowledge(args.slice(1).join(' '));

      default:
        return `Unknown lucie command: ${subcommand}. Try 'lucie help'`;
    }
  }

  private async generateWithLucie(args: string[]): Promise<string> {
    const [type, name] = args;

    // Call Lucie Code agent to generate
    this.terminal.writeln(`\x1b[36m🤖 Lucie is generating ${type} "${name}"...\x1b[0m`);

    // API call to our agent
    const response = await fetch('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ type, name, projectId: this.projectId })
    });

    const { files } = await response.json();

    // Write files to WebContainer
    for (const file of files) {
      await this.webcontainer.fs.writeFile(file.path, file.content);
      this.terminal.writeln(`\x1b[32m✓\x1b[0m Created ${file.path}`);
    }

    return `\x1b[32m✨ Generated ${type} "${name}" successfully!\x1b[0m`;
  }

  private async askLucie(question: string): Promise<string> {
    this.terminal.writeln(`\x1b[36m🤖 Thinking...\x1b[0m`);

    // Stream response from Lucie
    const response = await fetch('/api/agent/ask', {
      method: 'POST',
      body: JSON.stringify({ question, projectId: this.projectId })
    });

    const reader = response.body?.getReader();
    let answer = '\n';

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      answer += text;
      this.terminal.write(text);  // Stream to terminal
    }

    return '';
  }

  private async explainCode(args: string[]): Promise<string> {
    const filePath = args[0];
    const content = await this.webcontainer.fs.readFile(filePath, 'utf-8');

    this.terminal.writeln(`\x1b[36m🤖 Analyzing ${filePath}...\x1b[0m\n`);

    return await this.askLucie(`Explain this code:\n\`\`\`\n${content}\n\`\`\``);
  }

  private async fixCode(args: string[]): Promise<string> {
    const filePath = args[0];
    const content = await this.webcontainer.fs.readFile(filePath, 'utf-8');

    this.terminal.writeln(`\x1b[36m🤖 Fixing ${filePath}...\x1b[0m`);

    const response = await fetch('/api/agent/fix', {
      method: 'POST',
      body: JSON.stringify({ filePath, content, projectId: this.projectId })
    });

    const { fixed, explanation } = await response.json();

    // Write fixed file
    await this.webcontainer.fs.writeFile(filePath, fixed);

    return `\x1b[32m✓\x1b[0m Fixed!\n\n${explanation}`;
  }
}
```

#### Commandes Custom Disponibles

```bash
# Standard (passthrough to Node.js)
$ npm install
$ npm run dev
$ node script.js

# Lucie Commands
$ lucie help                    # Aide
$ lucie generate component Btn  # Génère un composant React
$ lucie generate page /about    # Génère une page
$ lucie generate api /users     # Génère une API route
$ lucie explain src/App.tsx     # Explique le code
$ lucie fix src/App.tsx         # Corrige les erreurs
$ lucie search "auth patterns"  # Cherche dans la knowledge base
$ lucie deploy                  # Deploy preview

# Shortcuts
$ ask "comment ajouter un dark mode?"
$ fix App.tsx
$ explain utils.ts
```

#### Terminal UI avec xterm.js

```typescript
// components/code/LucieTerminal.tsx
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

export function LucieTerminal({ webcontainer, projectId }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#1e1e2e',  // Catppuccin Mocha
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        // ... more colors
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 14,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalRef.current!);
    fitAddon.fit();

    // Custom prompt
    term.write('\x1b[36m🤖 lucie\x1b[0m \x1b[90m~/project\x1b[0m $ ');

    // Handle input
    let currentLine = '';
    term.onKey(({ key, domEvent }) => {
      if (domEvent.key === 'Enter') {
        term.write('\r\n');
        handleCommand(currentLine);
        currentLine = '';
        term.write('\x1b[36m🤖 lucie\x1b[0m \x1b[90m~/project\x1b[0m $ ');
      } else if (domEvent.key === 'Backspace') {
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          term.write('\b \b');
        }
      } else {
        currentLine += key;
        term.write(key);
      }
    });

    setTerminal(term);
  }, []);

  return (
    <div
      ref={terminalRef}
      className="h-64 rounded-b-lg overflow-hidden"
    />
  );
}
```

#### Avantages de cette approche

| Feature | Bénéfice |
|---------|----------|
| **Custom commands** | UX unique, intégration Lucie native |
| **Zero backend pour exec** | Tout tourne dans le browser |
| **Terminal familier** | Les devs connaissent déjà |
| **Streaming responses** | Lucie répond en temps réel dans le terminal |
| **Autocomplete** | On peut ajouter completion pour nos commandes |

#### Ce qu'on peut intercepter

```typescript
// On contrôle TOUT
webcontainer.on('server-ready', (port, url) => {
  // Serveur démarré → afficher preview
});

webcontainer.fs.watch('**/*', (event, path) => {
  // Fichier modifié → hot reload / sync
});

// On peut même simuler des fichiers système
await webcontainer.mount({
  'node_modules/.bin/lucie': {
    file: { contents: '#!/usr/bin/env node\nconsole.log("Lucie CLI")' }
  }
});
```

### Cloud Preview (Advanced)

Déploiement automatique sur:
- Vercel Preview
- Netlify Deploy Preview
- Render.com

---

## Image & 3D Generation for Projects

L'agent peut générer des assets pour le projet:

```typescript
// Example: User asks for a landing page
User: "Crée une landing page pour mon app de fitness"

// Lucie Code generates:
await generate_asset_image({
  prompt: "Modern fitness app logo, minimalist, blue gradient",
  outputPath: "public/logo.png",
  projectId
});

await generate_asset_image({
  prompt: "Hero image for fitness app, person exercising, vibrant",
  outputPath: "public/hero.jpg",
  projectId
});

// If 3D needed:
await generate_asset_3d({
  prompt: "3D dumbbell icon for fitness app",
  outputPath: "public/models/dumbbell.glb",
  projectId
});
```

Utilise les tools existants de ragforge-core (`image-tools.ts`, `threed-tools.ts`).

---

## Roadmaps

### Minimal (MVP) - 2-3 semaines

**Objectif**: Agent fonctionnel avec ZIP export

#### Features
- [ ] Virtual File System dans Neo4j
- [ ] Adaptation des tools read/write/edit pour VirtualFile
- [ ] 3-4 templates de base (blank, react, nextjs, express)
- [ ] ZIP export fonctionnel
- [ ] Instructions de lancement dans le ZIP
- [ ] Intégration avec Lucie Research (search dans le projet)

#### Tools
```
create_project, read_file, write_file, edit_file, delete_path,
glob_files, grep_files, list_directory, export_zip, list_templates,
apply_template
```

#### Pas inclus
- GitHub integration
- Preview live
- Database
- Image/3D generation

---

### Medium - 3-4 semaines supplémentaires

**Objectif**: GitHub sync + Preview + Assets

#### Features
- [ ] GitHub OAuth pour commit/push
- [ ] Création de repo automatique
- [ ] Commits au fur et à mesure de l'édition
- [ ] WebContainer preview (StackBlitz-like)
- [ ] Image generation pour assets (`generate_asset_image`)
- [ ] 3D generation pour assets (`generate_asset_3d`)
- [ ] Plus de templates (tailwind, shadcn, etc.)

#### Tools ajoutés
```
github_init_repo, github_commit, github_push, github_create_pr,
preview_project, generate_asset_image, generate_asset_3d,
get_framework_docs
```

#### Pas inclus
- Database provisioning
- Cloud deployment
- Templates communautaires

---

### Advanced - Design Specification

**Objectif**: Plateforme complète de développement assisté

> *Note: Cette section est spéculative et décrit une vision plutôt que des étapes concrètes.*

#### Vision: Database Provisioning

**Concept**: L'agent peut créer et gérer des bases de données pour les projets.

```
User: "J'ai besoin d'une base de données pour stocker les utilisateurs"

Lucie Code:
1. Analyse le projet (Next.js avec Prisma?)
2. Propose: "Je peux créer un schema Prisma avec une table User"
3. Génère: prisma/schema.prisma
4. Options:
   - SQLite local (dans le ZIP)
   - Supabase (si compte lié)
   - PlanetScale (si compte lié)
   - Neon (si compte lié)
```

**Intégrations possibles**:
- Supabase (PostgreSQL + Auth + Storage)
- PlanetScale (MySQL serverless)
- Neon (PostgreSQL serverless)
- Turso (SQLite edge)

**Défis**:
- Gestion des credentials
- Coûts pour l'utilisateur
- Cleanup des resources

#### Vision: Cloud Deployment

**Concept**: Déploiement one-click vers le cloud.

```
User: "Déploie mon projet"

Lucie Code:
1. Détecte le type de projet (static, Node.js, Python)
2. Propose les options:
   - Vercel (Next.js optimal)
   - Netlify (static/functions)
   - Railway (full-stack)
   - Fly.io (containers)
3. Configure automatiquement:
   - Environment variables
   - Build commands
   - Domain preview
```

**Intégrations possibles**:
- Vercel API (projects, deployments)
- Netlify API (sites, deploys)
- Railway API (services, variables)
- GitHub Actions (CI/CD)

#### Vision: Template Marketplace

**Concept**: Templates créés par la communauté.

```
Templates:
├── Official/
│   ├── react-vite
│   ├── nextjs-app
│   └── express-ts
├── Community/
│   ├── @user/saas-starter
│   ├── @user/blog-template
│   └── @user/ecommerce-kit
└── User/
    └── my-saved-templates
```

**Features**:
- Upload de templates depuis GitHub repos
- Versioning
- Variables de configuration
- Reviews et ratings

#### Vision: Multi-Agent Collaboration

**Concept**: Les deux Lucie collaborent de manière visible.

```
User: "Crée une app de todo avec auth et une belle UI"

[Lucie Research] 🔍 Je cherche les best practices pour l'auth...
[Lucie Research] 📚 Trouvé: NextAuth avec Prisma adapter est recommandé
[Lucie Code] ⚙️ Je crée le projet Next.js avec le template auth...
[Lucie Code] 📁 Création de app/api/auth/[...nextauth]/route.ts
[Lucie Research] 🎨 Je cherche des inspirations UI pour todo apps...
[Lucie Code] 🖼️ Je génère une image de hero pour la landing page...
[Lucie Code] ✅ Projet prêt! Preview disponible.
```

**Architecture**:
- Orchestrator qui dispatch entre Research et Code
- Conversation partagée (dual context)
- Handoff explicite avec contexte

#### Vision: Live Collaboration

**Concept**: Plusieurs utilisateurs sur le même projet.

- Cursors temps réel (comme Figma)
- Chat intégré
- Historique des changements par utilisateur
- Merge conflicts assistés par l'agent

**Complexité**: Très élevée (CRDT, WebSockets, etc.)

#### Vision: AI Code Review

**Concept**: L'agent review le code avant commit.

```
[Lucie Code] 📝 Review de tes changements:

✅ Bonnes pratiques:
- Typage TypeScript correct
- Composants bien découpés

⚠️ Suggestions:
- Ligne 42: Cette query N+1 pourrait être optimisée
- Ligne 87: Ajouter un try/catch pour cette API call

🔒 Sécurité:
- Ligne 15: Ne pas exposer cette clé API côté client
```

---

## Intégration avec l'Interface Chat

### UI Additions

```
┌──────────────────────────────────────────────────────────────────┐
│ [Sessions] [Projects ▼]                                   [User] │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Project: my-fitness-app                                         │
│  ┌─────────────────┬────────────────────────────────────────────┐│
│  │ Files           │  src/App.tsx                              ││
│  │ ├── src/        │  ┌────────────────────────────────────────┐││
│  │ │   ├── App.tsx │  │ 1  import React from 'react'          │││
│  │ │   └── main.tsx│  │ 2                                     │││
│  │ ├── public/     │  │ 3  export default function App() {    │││
│  │ └── package.json│  │ 4    return <div>Hello</div>          │││
│  │                 │  │ 5  }                                   │││
│  │ [+ New File]    │  └────────────────────────────────────────┘││
│  └─────────────────┴────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ [Preview] [Download ZIP] [GitHub ▼]                         ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Chat                                                         ││
│  │ ────────────────────────────────────────────────────────────││
│  │ [Lucie] J'ai créé le composant App.tsx. Que veux-tu ajouter?││
│  │                                                              ││
│  │ [You] Ajoute un header avec un logo                         ││
│  │                                                              ││
│  │ [Lucie Code] ⚙️ Je modifie App.tsx...                       ││
│  │ [Lucie Code] 🖼️ Je génère un logo...                        ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ [📎] Message...                                    [Send ➤] ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Components Additionnels

```
components/code/
├── ProjectExplorer.tsx      # File tree
├── CodeEditor.tsx           # Monaco editor
├── ProjectPreview.tsx       # iframe/WebContainer
├── ProjectActions.tsx       # ZIP, GitHub buttons
└── AgentIndicator.tsx       # Shows which Lucie is active
```

---

## Fichiers Clés à Créer/Modifier

### Minimal

| Fichier | Description |
|---------|-------------|
| `lib/ragforge/virtual-fs.ts` | Virtual File System operations |
| `lib/ragforge/agent/code-tools.ts` | Code agent tools |
| `lib/ragforge/templates/` | Project templates |
| `app/api/projects/route.ts` | Project CRUD API |
| `app/api/projects/[id]/export/route.ts` | ZIP export |

### Medium

| Fichier | Description |
|---------|-------------|
| `lib/github/client.ts` | GitHub API wrapper |
| `lib/github/sync.ts` | Sync VirtualFiles ↔ GitHub |
| `app/api/github/callback/route.ts` | OAuth callback |
| `components/code/WebContainerPreview.tsx` | StackBlitz-like preview |

### Advanced

| Fichier | Description |
|---------|-------------|
| `lib/database/supabase.ts` | Supabase provisioning |
| `lib/deploy/vercel.ts` | Vercel deployment |
| `lib/templates/marketplace.ts` | Community templates |

---

## Résumé

| Phase | Durée | Deliverables |
|-------|-------|--------------|
| **Minimal** | 2-3 sem | Virtual FS, basic tools, templates, ZIP export |
| **Medium** | +3-4 sem | GitHub sync, preview, image/3D generation |
| **Advanced** | Design | DB provisioning, cloud deploy, marketplace, collab |

Le Code Agent transforme community-docs en une plateforme de développement assisté par IA, complémentaire au Research Agent pour une expérience complète.
