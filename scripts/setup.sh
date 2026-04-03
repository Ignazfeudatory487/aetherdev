#!/bin/bash
# ─── AetherDev Setup Script ───────────────────────────────────────────────────
# One-command setup for local development
# Usage: bash scripts/setup.sh

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[AetherDev]${NC} $1"; }
ok()  { echo -e "${GREEN}✓${NC} $1"; }
warn(){ echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo -e "\n${CYAN}⚡ AetherDev Setup${NC}\n"

# Check Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 18+ from https://nodejs.org"
fi
NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
[ "$NODE_VER" -lt 18 ] && err "Node.js 18+ required. Current: $(node -v)"
ok "Node.js $(node -v)"

# Check Python
if ! command -v python3 &>/dev/null; then
  warn "Python3 not found. Python features will be unavailable."
else
  PY_VER=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f2)
  ok "Python $(python3 --version)"
fi

# Check Git
command -v git &>/dev/null && ok "Git $(git --version | cut -d' ' -f3)" || warn "Git not found"

# Check Docker (optional)
command -v docker &>/dev/null && ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')" || warn "Docker not found (optional)"

# Create .env
if [ ! -f ".env" ]; then
  cp .env.example .env
  ok "Created .env from .env.example"
  warn "Please edit .env with your configuration before starting"
else
  ok ".env already exists"
fi

# Install Node.js dependencies
log "Installing Node.js dependencies..."
npm install
ok "Node.js dependencies installed"

# Install web UI dependencies
log "Installing Web UI dependencies..."
cd web-ui && npm install && cd ..
ok "Web UI dependencies installed"

# Install Python dependencies (optional)
if command -v python3 &>/dev/null; then
  log "Installing Python dependencies..."
  python3 -m pip install -e ".[dev]" --quiet 2>/dev/null || warn "Python install failed (optional)"
  ok "Python dependencies installed"
fi

# Create data directories
mkdir -p data plugins
ok "Data directories created"

# Build TypeScript
log "Building TypeScript..."
npm run build 2>/dev/null && ok "TypeScript built" || warn "Build failed — run 'npm run build' manually"

# Check Ollama
if command -v ollama &>/dev/null; then
  ok "Ollama detected"
  log "Pulling default model (codellama:13b)..."
  ollama pull codellama:13b 2>/dev/null && ok "Model pulled" || warn "Model pull failed — run 'ollama pull codellama:13b' manually"
else
  warn "Ollama not found. Install from https://ollama.ai for local LLM support"
  warn "Alternatively, set LLM_PROVIDER=openai in .env with your API key"
fi

echo ""
echo -e "${GREEN}✅ AetherDev setup complete!${NC}"
echo ""
echo "Quick start:"
echo -e "  ${CYAN}npm run dev:all${NC}     — Start backend + Web UI"
echo -e "  ${CYAN}npx ts-node cli/index.ts status${NC}  — Check system status"
echo -e "  ${CYAN}npx ts-node cli/index.ts ask \"Hello\"${NC}  — Chat with AI"
echo -e "  ${CYAN}docker-compose up -d${NC}  — Start with Docker"
echo ""
echo -e "Web UI: ${CYAN}http://localhost:5173${NC}"
echo -e "API:    ${CYAN}http://localhost:3001${NC}"
echo ""
