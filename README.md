# ⚡ AetherDev

> **100% Free · Local-First · Open-Source · Self-Healing AI Developer Agent**
> The complete, production-ready alternative to OpenClaw — 1000% better.

[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue)](https://python.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-Vitest%20%2B%20Pytest-yellow)](tests/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue)](docker-compose.yml)

---

## 🚀 What is AetherDev?

AetherDev is a **fully local, zero-cost, open-source AI developer agent** that runs on your machine using Ollama (or any OpenAI-compatible API). It replaces paid tools like OpenClaw, Cursor, GitHub Copilot Workspace — with **zero subscriptions, zero telemetry, and zero vendor lock-in**.

### Why AetherDev vs OpenClaw?

| Feature | OpenClaw | AetherDev |
|---|---|---|
| **Price** | Paid / freemium | ✅ 100% Free forever |
| **Local LLM** | ❌ Cloud only | ✅ Ollama, LM Studio |
| **Vendor lock-in** | ❌ Locked to cloud | ✅ Zero lock-in |
| **Self-healing** | ❌ None | ✅ Auto-retry + fallback |
| **Multi-agent pipeline** | ❌ Basic | ✅ Planner→Coder→Reviewer→Tester |
| **Security scanning** | ❌ Limited | ✅ 15+ CWE patterns |
| **Plugin system** | ❌ Limited | ✅ Hot-reloadable |
| **Code indexing** | ❌ Basic | ✅ Vector + AST |
| **Git integration** | ❌ Basic | ✅ Commits + PR generation |
| **Telemetry** | ❌ Always on | ✅ Off by default |
| **Open source** | ❌ Closed | ✅ MIT Licensed |

---

## 🛠️ Quick Start

### Option 1: Docker (Recommended)
```bash
git clone https://github.com/aetherdev/aetherdev
cd aetherdev
cp .env.example .env
docker-compose up -d
# Open http://localhost:5173
```

### Option 2: Local Development
```bash
git clone https://github.com/SardarAwais88/aetherdev
cd aetherdev
bash scripts/setup.sh
npm run dev:all
```

### Option 3: CLI Only
```bash
npm install
npm run build
node dist/cli/index.js status
node dist/cli/index.js ask "How do I sort an array in TypeScript?"
```

---

## 🤖 Multi-Agent Pipeline

```
User Prompt
    ↓
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Planner   │───▶│    Coder    │───▶│  Reviewer   │───▶│   Tester   │
│             │    │             │    │             │    │             │
│ Break task  │    │ Generate    │    │ Security +  │    │ Write +     │
│ into steps  │    │ refactor    │    │ quality     │    │ run tests   │
│ with deps   │    │ debug code  │    │ analysis    │    │ + coverage  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                        ↑ Self-Healing (auto-retry + fallback on failure)
```

---

## 📦 Features

### ✅ Core Features
- **AI Code Generation** — Generate complete, production-ready code from natural language
- **Smart Refactoring** — Improve code quality while preserving functionality
- **AI Debugging** — Root cause analysis with step-by-step fixes
- **Test Generation** — Unit, integration, e2e tests with Vitest/Jest/Pytest
- **Code Review** — Security, performance, maintainability analysis
- **Documentation** — Auto-generate API docs, changelogs, architecture diagrams

### 🚀 Advanced Features
- **Self-Healing** — Agents auto-retry with fallback strategies on failure
- **Security Gates** — 15+ CWE pattern detection (injection, XSS, hardcoded secrets, etc.)
- **Complexity Analysis** — Cyclomatic complexity, cognitive complexity, maintainability index
- **Vector Memory** — Context-aware responses using your project's codebase
- **Git Integration** — Conventional commits, PR generation, branch management
- **Hot-Reload Plugins** — Extend functionality without restart
- **Real-time Web UI** — React dashboard with live pipeline monitoring
- **Resource Control** — CPU/memory throttling, sandbox execution

---

## 💻 CLI Commands

```bash
# Chat with AI
aether ask "How do I implement JWT authentication in Node.js?"

# Generate code
aether generate "Create a REST API for user management with SQLite"

# Generate specific files
aether gen "Add input validation" --files src/api/users.ts

# Refactor existing code
aether refactor src/legacy/auth.js --prompt "Convert to TypeScript with proper types"

# Code review
aether review src/api/payments.ts src/utils/crypto.ts

# Security & quality scan
aether scan ./src --ci

# Generate tests
aether test src/services/userService.ts

# Debug an error
aether debug "TypeError: Cannot read property 'id' of undefined" --files src/api/users.ts

# Git operations
aether git status
aether git commit --all       # Auto-generates conventional commit message
aether git pr --base main     # Generate PR template

# Index project for context
aether index ./myproject

# Interactive mode
aether interactive

# Plugin management
aether plugins list
aether plugins reload my-plugin

# System status
aether status
```

---

## 🔌 Plugin System

Create plugins in `./plugins/my-plugin/`:

```json
// plugins/my-plugin/plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Custom plugin",
  "main": "index.js",
  "hooks": ["after:generate", "on:startup"],
  "permissions": ["filesystem:read"]
}
```

```javascript
// plugins/my-plugin/index.js
module.exports = {
  hooks: {
    'after:generate': async (ctx) => {
      // ctx.data has the generated code
      // Return { modified: true, data: ... } to transform output
      console.log('Code generated for:', ctx.projectPath);
    },
    'on:startup': async (ctx) => {
      console.log('AetherDev started!');
    }
  },
  commands: [{
    name: 'format',
    description: 'Format output with Prettier',
    handler: async (args, ctx) => {
      return `Formatted: ${args.file}`;
    }
  }],
  onLoad: async () => { console.log('Plugin loaded'); },
  onUnload: async () => { console.log('Plugin unloaded'); }
};
```

Plugins are **hot-reloaded** — modify and save, AetherDev picks up changes automatically.

---

## ⚙️ Configuration

Copy `.env.example` to `.env`:

```env
# Use Ollama (local, free, recommended)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=codellama:13b

# Or use OpenAI-compatible API
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key-here
OPENAI_MODEL=gpt-4o

# Security sandbox
SANDBOX_ENABLED=true
SANDBOX_TIMEOUT_MS=30000
```

---

## 🏗️ Architecture

```
aetherdev/
├── src/
│   ├── core/
│   │   ├── engine.ts      # LLM interface (Ollama/OpenAI/Anthropic)
│   │   ├── memory.ts      # Vector + SQLite memory store
│   │   ├── sandbox.ts     # Sandboxed execution
│   │   └── quality.ts     # Code quality gates
│   ├── agents/
│   │   ├── base.ts        # Base agent with self-healing
│   │   ├── planner.ts     # Task decomposition
│   │   ├── coder.ts       # Code generation/refactoring
│   │   ├── reviewer.ts    # Code review
│   │   ├── tester.ts      # Test generation
│   │   └── pipeline.ts    # Multi-agent orchestrator
│   ├── plugins/
│   │   └── loader.ts      # Hot-reloadable plugin system
│   ├── utils/
│   │   ├── logger.ts      # Structured logging (Pino)
│   │   ├── validator.ts   # Input validation & security
│   │   ├── fs.ts          # Safe filesystem operations
│   │   └── git.ts         # Git integration
│   └── config/
│       └── index.ts       # Zod-validated config
├── cli/
│   └── index.ts           # CLI entry (Commander.js)
├── web-ui/
│   └── src/               # React + Vite + TailwindCSS
├── tests/                 # Vitest + Playwright
├── plugins/               # User plugins go here
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/ci.yml
```

---

## 🧪 Testing

```bash
# Run all unit tests
npm test

# Run with coverage
npm run test:coverage

# Run E2E tests
npm run test:e2e

# Python tests
pytest tests/ -v
```

---

## 🐍 Python API

```python
from aetherdev.api.server import app
import uvicorn

# Start the Python API server
uvicorn.run(app, host="0.0.0.0", port=8001)
```

---

## 📊 Supported Models

| Provider | Models | Free? |
|---|---|---|
| **Ollama** (Local) | codellama, llama3, mistral, deepseek-coder, qwen2.5-coder | ✅ |
| **LM Studio** | Any GGUF model | ✅ |
| **OpenAI** | gpt-4o, gpt-4-turbo, gpt-3.5-turbo | API key |
| **Anthropic** | claude-3-5-sonnet, claude-3-haiku | API key |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/amazing-feature`
3. Make changes following SOLID, DRY, KISS principles
4. Write tests (90%+ coverage target)
5. Run `npm test && npm run lint`
6. Commit using conventional commits: `feat: add amazing feature`
7. Open a Pull Request

---

## 📜 License

MIT License — Free to use, modify, and distribute. See [LICENSE](LICENSE).

---

<div align="center">
  <strong>⚡ AetherDev — Build faster. Stay local. Stay free.</strong><br>
  <em>Made with ❤️ by developers, for developers.</em>
</div>
