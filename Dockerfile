# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOME=/app \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Dependências de sistema mínimas. `git` é necessário para clonar/atualizar o repositório.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git tini \
    && rm -rf /var/lib/apt/lists/*

# Instala o Claude Code globalmente.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Instala dependências da API primeiro (camada de cache).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o restante da aplicação.
COPY src ./src
COPY prompts ./prompts
COPY claude ./claude
COPY public ./public

# Script de askpass para o git: fornece o token via env GIT_TOKEN sem
# persisti-lo na configuração do repositório (auth de LEITURA em repos privados).
RUN printf '#!/bin/sh\nprintf "%%s" "$GIT_TOKEN"\n' > /app/git-askpass.sh \
    && chmod 0555 /app/git-askpass.sh

# /app/repo é onde o repositório será clonado (montado como volume Docker).
# /app/.claude guarda config/cache do Claude Code.
RUN mkdir -p /app/repo /app/.claude \
    && cp /app/claude/settings.json /app/.claude/settings.json \
    && chown -R node:node /app

USER node

EXPOSE 8080

# tini como init para repassar sinais e evitar processos zumbis do Claude Code.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
