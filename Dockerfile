# ─── AetherDev Dockerfile ─────────────────────────────────────────────────────
# Multi-stage build: Node.js backend + React frontend
# Base: node:20-alpine (minimal, secure)

# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache python3 py3-pip make g++ git sqlite

# Copy package files
COPY package.json package-lock.json* ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --ignore-scripts

# Copy source
COPY src/ ./src/
COPY cli/ ./cli/
COPY scripts/ ./scripts/

# Build TypeScript
RUN npm run build

# Build Web UI
COPY web-ui/package.json web-ui/package-lock.json* ./web-ui/
RUN cd web-ui && npm ci --ignore-scripts
COPY web-ui/ ./web-ui/
RUN cd web-ui && npm run build

# ─── Stage 2: Python dependencies ────────────────────────────────────────────
FROM python:3.11-slim AS py-builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc git && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir --prefix=/install .

# ─── Stage 3: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache python3 py3-pip git sqlite tini curl && rm -rf /var/cache/apk/*

# Copy Python install
COPY --from=py-builder /install /usr/local

# Copy built app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web-ui/dist ./web-ui/dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy .env.example as reference
COPY .env.example ./.env.example

# Create data directory
RUN mkdir -p /app/data /app/plugins && chown -R node:node /app

# Create entrypoint script
COPY scripts/docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Security: run as non-root
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:${AETHER_PORT:-3001}/api/health || exit 1

EXPOSE 3001

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
CMD ["start"]

LABEL org.opencontainers.image.title="AetherDev"
LABEL org.opencontainers.image.description="Free, local-first AI developer agent"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/aetherdev/aetherdev"
