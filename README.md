# wattio-Luna 🌙

API autenticada que **enriquece chamados de suporte**. A Luna atua como **Analista de Sistemas Sênior**: recebe um relato em linguagem natural de um usuário final, investiga o **código-fonte** de um repositório usando **Claude Code** (somente leitura, dentro de um container Docker) e devolve uma **descrição técnica e funcional completa**, pronta para ser registrada no Notion.

> O objetivo **não é resolver** o chamado, e sim **compreendê-lo, contextualizá-lo e enriquecê-lo** — reduzindo o tempo de triagem das equipes de suporte, produto e desenvolvimento.

A resposta é um texto estruturado com as seções: **Resumo do Chamado**, **Contexto Encontrado no Sistema**, **Fluxo Identificado**, **Regras de Negócio Encontradas**, **Componentes Relacionados** (módulos, modelos, APIs, jobs, integrações, arquivos), **Possíveis Causas** e **Descrição Enriquecida para o Notion**.

> **Arquitetura:** a Luna não consulta o GitHub via MCP. O repositório é **clonado dentro do container, num volume Docker**, e o Claude Code analisa os **arquivos locais** com ferramentas de leitura (`Read`, `Grep`, `Glob`, `LS`). Todas as conclusões são baseadas exclusivamente no código real analisado; quando não há evidência, a Luna declara isso explicitamente.

---

## 1. Arquitetura geral

```
Cliente (HTTP) ──Bearer token──▶  API Express  ──ensureRepo()──▶  git clone/pull (volume Docker)
                                     │                                    │
                                     │ spawn                              ▼
                                     ▼                          /app/repo (código local)
                              Claude Code (headless -p) ──Read/Grep/Glob/LS──▶ arquivos locais
```

Fluxo de uma requisição:

1. Cliente faz `POST /enrich` (enriquecer) ou `POST /ask` (responder uma pergunta) com `Authorization: Bearer <key>` e `{ "ticket": "…" }`.
2. Middleware valida a API key (comparação em tempo constante).
3. `parseTicket` normaliza o relato (remove uma menção `@luna` inicial opcional) e extrai a referência da task; a rota força o modo (`/enrich` → enrich, `/ask` → answer).
4. `ensureRepo()` garante que o repositório esteja **clonado e atualizado** (`git clone` na primeira vez, `git pull` nas seguintes, com debounce e lock de concorrência).
5. `buildSystemPrompt` combina: papel de Analista de Sistemas Sênior + regras base (somente leitura, "não invente nada") + formato de enriquecimento + caminho local do repositório.
6. `runClaude` executa o binário `claude` em modo *print* (`-p`, `--output-format json`), com `cwd` no diretório do repo, `--allowedTools Read,Grep,Glob,LS` e ferramentas de escrita/rede bloqueadas.
7. O chamado enriquecido (`result`) é devolvido ao cliente em JSON.

## 2. Estrutura de pastas

```
wattio-luna/
├── docker-compose.yml          # orquestração + volume do repo + hardening
├── Dockerfile                  # Node + Claude Code + git + askpass
├── .env.example                # modelo de variáveis (copie para .env)
├── .dockerignore / .gitignore
├── wattio-mcp/                 # clone do MCP de tarefas (OpenSearch) — serviço separado no compose
├── claude/
│   └── settings.json           # allow (leitura + mcp__wattio) / deny (escrita/rede) do Claude Code
├── prompts/
│   ├── system-base.md          # papel (Analista Sênior) + regras inegociáveis + dois modos
│   ├── enriquecimento.md       # modo ENRIQUECER: tarefa + formato estruturado p/ Notion
│   └── resposta.md             # modo RESPONDER: responder uma pergunta sobre a task
├── scripts/
│   ├── ask.sh                  # helper de teste de POST /ask (responder) via curl
│   └── enri.sh                 # helper de teste de POST /enrich (enriquecer) via curl
└── src/
    ├── server.js               # bootstrap Express + clone no boot
    ├── config.js               # leitura/validação de env
    ├── middleware/auth.js      # autenticação por API key
    ├── routes/ask.js           # POST /ask — responder uma pergunta sobre a task
    ├── routes/enrich.js        # POST /enrich — enriquecer o chamado
    ├── services/
    │   ├── repo.js             # git clone/pull (único ponto que escreve em disco)
    │   ├── prompt.js           # montagem do system/user prompt de enriquecimento
    │   └── claude.js           # execução controlada do Claude Code (leitura local)
    └── utils/
        ├── parseTicket.js      # normaliza a entrada e decide o modo (enrich/answer) + extrai taskId/pergunta
        └── logger.js           # logs com redaction de segredos
```

### Dois modos de operação (uma rota cada)

A Luna tem dois modos, cada um exposto por uma rota dedicada:

| Rota | Modo | Entrada | O que a Luna faz |
| --- | --- | --- | --- |
| `POST /enrich` | **enrich** | `TASK-12344` (só a referência) ou `Não consigo gerar a fatura…` (relato livre) | Recupera a task no MCP, lê comentários/anexos, investiga o código e devolve **apenas o enriquecimento** pronto para o Notion. |
| `POST /ask` | **answer** | `TASK-12344` + `question`, ou combinado: `task 12344 - qual permissão está atrelada hoje?` | Entende o domínio, lê comentários/anexos, investiga o código e **responde objetivamente apenas a pergunta**. |

A interface de chat (`POST /chat/stream`) mantém a **detecção automática** de modo pelo conteúdo do relato.

A resposta JSON inclui `mode` e `taskId` (quando reconhecido) além de `enrichment` (que carrega o enriquecimento ou a resposta, conforme o modo).

## 3. `docker-compose.yml`

Ver [docker-compose.yml](docker-compose.yml). O repositório é persistido no volume nomeado `luna_repo` montado em `/app/repo`. Destaques de segurança: `read_only: true` no rootfs (o volume do repo permanece gravável só para o git), `cap_drop: ALL`, `no-new-privileges`, `tmpfs` para `/tmp` e `/app/.claude`, limite de memória e healthcheck.

## 4. `Dockerfile`

Ver [Dockerfile](Dockerfile). Instala Claude Code via npm e `git`, cria o script de **askpass** (token via env, sem persistir em disco), roda como usuário `node` (não-root) e usa `tini` como init.

## 5. Claude Code lendo o repositório local

- Instalado globalmente: `npm install -g @anthropic-ai/claude-code`.
- Autenticação por `ANTHROPIC_API_KEY` (injetada via env, nunca no build).
- Modelo configurável por `ANTHROPIC_MODEL` (padrão `claude-sonnet-4-6`).
- Executado em modo headless com `cwd` no repositório clonado:
  `claude -p "<chamado>" --append-system-prompt "<regras+formato>" --add-dir /app/repo --allowedTools Read,Grep,Glob,LS --output-format json`.
- `settings.json` reforça o allow (leitura) / deny (escrita e rede).

## 6. Clonar o repositório (`services/repo.js`)

- **`ensureRepo()`** é o **único** ponto autorizado a escrever em disco. Clona (`--depth 1`) se faltar e faz `git pull` (via `fetch` + `reset --hard` + `clean`) se já existir.
- **Lock de concorrência:** chamadas simultâneas compartilham a mesma Promise (não dispara dois clones/pulls ao mesmo tempo).
- **Debounce de pull:** `REPO_PULL_MIN_INTERVAL_MS` evita um `git fetch` a cada requisição.
- **Tolerância a falhas:** se o `pull` falhar (ex.: rede), a Luna responde com a cópia local existente em vez de quebrar a requisição.

## 7. Credenciais Git (repositórios privados, SOMENTE LEITURA)

- Use um **PAT/deploy token de leitura**. No GitHub, um Fine-grained PAT com `Contents: Read-only` e `Metadata: Read-only`.
- `GIT_USERNAME` (padrão `x-access-token` para GitHub; `oauth2` para GitLab) + `GIT_TOKEN`.
- O token é entregue ao git via **`GIT_ASKPASS`** e **não é persistido** na config do repositório (apenas o username vai para a URL do remoto). Em produção, prefira **Docker secrets** / gestor de segredos.
- Para repositórios públicos, deixe `GIT_TOKEN` vazio.

## 8. API autenticada

`POST /enrich` e `POST /ask` exigem `Authorization: Bearer <key>` (ou `x-api-key`). As chaves vêm de `LUNA_API_KEYS` (lista separada por vírgula). `GET /health` é público. A interface de chat usa `POST /chat/stream` (mesmo núcleo, resposta em streaming NDJSON).

Duas rotas, uma por modo:
- **`POST /enrich`** → **enriquece** o chamado (referência de task `TASK-12344` ou relato livre);
- **`POST /ask`** → **responde** uma pergunta sobre a task (referência + `question`).

```bash
# Enriquecer um chamado
curl -X POST http://localhost:8080/enrich \
  -H "Authorization: Bearer $LUNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"Não estou conseguindo gerar a fatura desse cliente."}'

# Responder uma pergunta sobre uma task
curl -X POST http://localhost:8080/ask \
  -H "Authorization: Bearer $LUNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"TASK-12344","question":"qual permissão está atrelada hoje?"}'
```

O corpo aceita o campo `ticket` (preferencial) ou `message` (legado). Em `/ask`, a pergunta pode vir no campo `question` ou embutida no relato (`task 12344 - …`). Resposta:

```json
{
  "requestId": "…",
  "repo": "wattio/billing",
  "ticket": "Não estou conseguindo gerar a fatura desse cliente.",
  "enrichment": "### Resumo do Chamado\n…\n### Descrição Enriquecida para o Notion\n…",
  "meta": { "model": "…", "durationMs": 0, "numTurns": 0, "costUsd": 0 }
}
```

## 9. Formato da saída (enriquecimento)

A Luna sempre devolve as seções, nesta ordem: **Resumo do Chamado**, **Contexto Encontrado no Sistema**, **Fluxo Identificado**, **Regras de Negócio Encontradas**, **Componentes Relacionados** (módulos, modelos, APIs, jobs, integrações, arquivos), **Possíveis Causas** e **Descrição Enriquecida para o Notion**. O formato é definido em [prompts/enriquecimento.md](prompts/enriquecimento.md).

## 10. Montagem do prompt interno

`buildSystemPrompt` concatena `system-base.md` (papel de Analista Sênior, somente leitura, "não invente nada", arquivos locais) + `enriquecimento.md` (tarefa e formato de saída) + o caminho local do repositório (`/app/repo`). O relato do chamado vira o *user prompt*.

## 11. Execução do Claude Code via API

`src/services/claude.js` faz `spawn` do binário em modo print, com `cwd` no repositório, timeout, `--max-turns`, allow/deny de ferramentas e `--output-format json`. Stdout é parseado e o campo `result` é a resposta.

## 12. Captura e retorno da resposta

A rota devolve JSON: `{ requestId, repo, ticket, enrichment, meta: { model, durationMs, numTurns, costUsd } }`.

## 13. Cuidados de segurança

- API atrás de autenticação obrigatória; comparação de chave em tempo constante.
- Token Git de leitura via askpass (não persistido) + Claude Code **sem** ferramentas de escrita/Bash/rede (allow/deny).
- O **único** processo que escreve em disco é o `git` controlado em `repo.js`; o Claude só lê.
- Container não-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`; o repositório vive em volume isolado.
- Timeout e limite de turnos evitam execuções descontroladas; limite de tamanho do chamado.
- Segredos só por env/secret manager; redaction nos logs; recomenda-se rate limiting e TLS (reverse proxy) na borda.

## 14. Limitações técnicas

- O repositório é clonado com `--depth 1` (sem histórico). Para perguntas sobre histórico/commits, ajuste a estratégia de clone.
- Custo e latência por requisição (cada chamado é uma execução completa do agente).
- Respostas podem variar entre execuções; o agente é instruído a não inventar, mas validação humana é recomendada para decisões críticas.
- O modo *print* não mantém memória entre requisições (cada chamado é stateless).

## 15. Melhorias futuras

- Suporte a múltiplos repositórios (clone em subdiretórios por nome).
- Cache de respostas por (commit, pergunta) e *embeddings* do código para acelerar.
- Streaming (SSE) da resposta; histórico/threads por usuário.
- Webhook de `git pull` (em vez de pull por requisição) e fila de jobs para alta carga.
- Integração direta com a API do Notion para gravar o chamado enriquecido automaticamente.
- Integração com Slack/Teams para acionar a Luna a partir do chat de suporte.
- Saída opcional em JSON estruturado (uma chave por seção) além do Markdown.

---

## MCP — wattio-mcp (tarefas operacionais)

Além de ler o código local, a Luna pode consultar as **tarefas/chamados operacionais** registrados no OpenSearch através do MCP [`wattio-mcp`](wattio-mcp/) (clonado dentro do projeto e executado como um **serviço separado** no compose). Isso permite correlacionar o chamado com dados reais (tarefas semelhantes, recorrência, histórico do cliente) ao enriquecê-lo.

**Como funciona:**
- O `wattio-mcp` sobe como serviço Docker em transporte HTTP (`streamable-http`), acessível só pela rede interna do compose em `http://wattio-mcp:8000/mcp`.
- O Claude Code dentro da Luna recebe esse MCP via `--mcp-config` (+ `--strict-mcp-config`) e tem as ferramentas `mcp__wattio__*` liberadas no allowlist. Todas são **somente leitura**.
- A orientação de uso do MCP é injetada no system prompt **apenas quando `MCP_WATTIO_URL` está configurado** (ver [src/services/prompt.js](src/services/prompt.js)).

**Ferramentas expostas:** `list_indices`, `get_index_mapping`, `get_task_by_id`, `run_opensearch_query`, `count_tasks`.

**Configuração** (no `.env`):
- `MCP_WATTIO_URL` — URL do MCP. Padrão aponta para o serviço local; pode apontar para o hospedado (`https://mcp.wattio.com.br/mcp`). **Vazio desliga o MCP** (a Luna volta a analisar só o código).
- `OPENSEARCH_URL`, `OPENSEARCH_USER`, `OPENSEARCH_PASSWORD`, `OPENSEARCH_INDEX`, `OPENSEARCH_ALLOWED_INDICES` — credenciais/escopo usados **pelo serviço wattio-mcp**.

**Atualizar o MCP:** como é um clone Git em [wattio-mcp/](wattio-mcp/), rode `git -C wattio-mcp pull` e reconstrua: `docker compose build wattio-mcp`.

## Como rodar

```bash
cp .env.example .env      # preencha LUNA_API_KEYS, ANTHROPIC_API_KEY, GIT_REPO_URL (e GIT_TOKEN se privado),
                          # e as credenciais OPENSEARCH_* para o MCP wattio-mcp
docker compose up --build -d   # sobe os serviços luna + wattio-mcp
curl localhost:8080/health
LUNA_API_KEY=<sua-key> ./scripts/enri.sh "Não estou conseguindo gerar a fatura desse cliente."
LUNA_API_KEY=<sua-key> ./scripts/ask.sh "TASK-12344" "qual permissão está atrelada hoje?"
```
