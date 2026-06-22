#!/usr/bin/env bash
# Helper para testar a API da Luna (enriquecimento de chamados).
# A Luna analisa sempre o repositório local configurado em GIT_REPO_URL e
# devolve o chamado enriquecido (contexto técnico e funcional) para o Notion.
# Uso:
#   LUNA_API_KEY=xxx ./scripts/ask.sh "Não estou conseguindo gerar a fatura desse cliente."
set -euo pipefail

HOST="${LUNA_HOST:-http://localhost:8080}"
KEY="${LUNA_API_KEY:?defina LUNA_API_KEY}"
TICKET="${1:?informe o relato do chamado, ex: 'Não consigo gerar a fatura desse cliente.'}"

BODY=$(printf '{"ticket":%s}' "$(jq -Rn --arg t "$TICKET" '$t')")

curl -sS -X POST "$HOST/ask" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
