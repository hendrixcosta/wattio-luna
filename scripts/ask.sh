#!/usr/bin/env bash
# Helper para testar a rota POST /ask da Luna (pergunta e resposta sobre uma task).
# A Luna recupera a task no MCP, investiga o código do repositório local e responde
# OBJETIVAMENTE apenas a pergunta. Para enriquecer um chamado, use ./scripts/enri.sh.
# Uso:
#   LUNA_API_KEY=xxx ./scripts/ask.sh "TASK-12344" "qual permissão está atrelada hoje?"
set -euo pipefail

HOST="${LUNA_HOST:-http://localhost:8080}"
KEY="${LUNA_API_KEY:?defina LUNA_API_KEY}"
TICKET="${1:?informe a referência da task, ex: 'TASK-12344'}"
QUESTION="${2:?informe a pergunta, ex: 'qual permissão está atrelada hoje?'}"

BODY=$(jq -n --arg t "$TICKET" --arg q "$QUESTION" '{ticket:$t,question:$q}')

curl -sS -X POST "$HOST/ask" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
