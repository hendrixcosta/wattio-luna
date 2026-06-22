#!/usr/bin/env bash
# Helper para testar a rota POST /enrich da Luna (enriquecimento de chamados).
# A Luna analisa o repositório local configurado em GIT_REPO_URL e devolve o
# chamado enriquecido (contexto técnico e funcional) para o Notion.
# Para responder uma pergunta pontual sobre uma task, use ./scripts/ask.sh.
# Uso:
#   LUNA_API_KEY=xxx ./scripts/enri.sh "Não estou conseguindo gerar a fatura desse cliente."
#   LUNA_API_KEY=xxx ./scripts/enri.sh "TASK-12344"
set -euo pipefail

HOST="${LUNA_HOST:-http://localhost:8080}"
KEY="${LUNA_API_KEY:?defina LUNA_API_KEY}"
TICKET="${1:?informe o relato do chamado ou a referência da task, ex: 'TASK-12344'}"

BODY=$(jq -n --arg t "$TICKET" '{ticket:$t}')

curl -sS -X POST "$HOST/enrich" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
