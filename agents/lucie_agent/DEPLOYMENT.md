# Lucie Agent - Déploiement

Guide pour le déploiement et la maintenance des services.

## Vue d'ensemble

```
Internet
    │
    ▼
┌─────────────────────────────────┐
│  Cloudflare Tunnel (cloudflared) │
│  lucie-agent.luciformresearch.com │
└─────────────┬───────────────────┘
              │ :8000
              ▼
┌─────────────────────────────────┐
│  Lucie Agent (Python/FastAPI)   │
│  Port 8000                      │
└─────────────┬───────────────────┘
              │ :6970
              ▼
┌─────────────────────────────────┐
│  Community Docs API (Node.js)   │
│  Port 6970                      │
└─────────────┬───────────────────┘
              │ :7688
              ▼
┌─────────────────────────────────┐
│  Neo4j (Docker)                 │
│  Port 7688                      │
└─────────────────────────────────┘
```

## Services Systemd

| Service | Port | Description |
|---------|------|-------------|
| `cloudflared` | - | Tunnel Cloudflare vers internet |
| `community-docs-api` | 6970 | API RagForge (recherche, mémoire) |
| `lucie-agent` | 8000 | Agent conversationnel Python |

### Commandes de base

```bash
# Status de tous les services
sudo systemctl status cloudflared community-docs-api lucie-agent

# Redémarrer tout
sudo systemctl restart cloudflared community-docs-api lucie-agent

# Voir les logs en temps réel
sudo journalctl -u lucie-agent -f
sudo journalctl -u community-docs-api -f
sudo journalctl -u cloudflared -f
```

## Fichiers de configuration

### Cloudflare Tunnel

```
/etc/cloudflared/config.yml
/etc/cloudflared/7c89648d-caaa-4c60-a050-113387c398cc.json
```

Config (`/etc/cloudflared/config.yml`):
```yaml
tunnel: 7c89648d-caaa-4c60-a050-113387c398cc
credentials-file: /etc/cloudflared/7c89648d-caaa-4c60-a050-113387c398cc.json

ingress:
  - hostname: lucie-agent.luciformresearch.com
    service: http://localhost:8000
  - service: http_status:404
```

### Agent Python

```
/home/luciedefraiteur/LR_CodeRag/community-docs/agents/lucie_agent/.env
```

Variables:
```bash
ANTHROPIC_API_KEY=sk-ant-...
COMMUNITY_DOCS_API=http://localhost:6970
MODEL_NAME=claude-sonnet-4-20250514
```

## Fichiers des services

### `/etc/systemd/system/cloudflared.service`
Installé automatiquement par `cloudflared service install`

### `/etc/systemd/system/community-docs-api.service`
```ini
[Unit]
Description=Community Docs API - RagForge Search
After=network.target

[Service]
Type=simple
User=luciedefraiteur
WorkingDirectory=/home/luciedefraiteur/LR_CodeRag/community-docs
Environment=PATH=/home/luciedefraiteur/.nvm/versions/node/v20.19.6/bin:/usr/bin:/bin
ExecStart=/home/luciedefraiteur/.nvm/versions/node/v20.19.6/bin/npx tsx lib/ragforge/api/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/lucie-agent.service`
```ini
[Unit]
Description=Lucie Agent - CV Chatbot
After=network.target community-docs-api.service
Wants=community-docs-api.service

[Service]
Type=simple
User=luciedefraiteur
WorkingDirectory=/home/luciedefraiteur/LR_CodeRag/community-docs/agents
Environment=PATH=/home/luciedefraiteur/LR_CodeRag/community-docs/agents/lucie_agent/venv/bin:/usr/bin:/bin
ExecStart=/home/luciedefraiteur/LR_CodeRag/community-docs/agents/lucie_agent/venv/bin/python -m uvicorn lucie_agent.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Installation depuis zéro

### 1. Cloudflare Tunnel

```bash
# Télécharger cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/cloudflared
chmod +x ~/cloudflared

# Login (ouvre un navigateur)
~/cloudflared tunnel login

# Créer le tunnel
~/cloudflared tunnel create lucie-agent

# Configurer le DNS (automatique si domaine sur Cloudflare)
~/cloudflared tunnel route dns lucie-agent lucie-agent.luciformresearch.com

# Copier config pour le service
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
sudo cp ~/.cloudflared/*.json /etc/cloudflared/

# Installer le service
sudo ~/cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### 2. Services Python/Node

```bash
# Copier les fichiers service
sudo cp ~/community-docs-api.service /etc/systemd/system/
sudo cp ~/lucie-agent.service /etc/systemd/system/

# Activer
sudo systemctl daemon-reload
sudo systemctl enable community-docs-api lucie-agent
sudo systemctl start community-docs-api lucie-agent
```

## Dépannage

### Le tunnel ne répond pas
```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared --since "5 min ago"
```

### L'agent ne démarre pas
```bash
# Vérifier que community-docs-api tourne
curl http://localhost:6970/health

# Vérifier les logs
sudo journalctl -u lucie-agent --since "5 min ago"
```

### Neo4j non accessible
```bash
# Vérifier Docker
docker ps | grep neo4j

# Redémarrer si nécessaire
docker restart community-docs-neo4j
```

## URLs

| Environnement | URL |
|---------------|-----|
| Local | http://localhost:8000 |
| Production | https://lucie-agent.luciformresearch.com |

## Rate Limiting

| Protection | Limite |
|------------|--------|
| Anti-spam (IP) | 5 req/min |
| Quota (IP) | 15 req/jour |
| Quota (visitor) | 15 req/jour |
| Localhost | Illimité |

## Contact

- **Email**: luciedefraiteur@luciformresearch.com
- **GitHub**: https://github.com/LuciformResearch
- **Site**: https://luciformresearch.com
