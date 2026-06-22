# wattio-Luna 🌙

**Luna** é a agente de IA da Wattio que **enriquece e responde chamados de suporte**
analisando o **código-fonte real** do produto. Ela roda o **Claude Code** em modo
headless (somente leitura) sobre um repositório clonado localmente e, opcionalmente,
consulta os **chamados do Notion** (via OpenSearch) e o **banco de produção**
(PostgreSQL, somente leitura) para contextualizar cada caso.

O objetivo da Luna **não é resolver** o chamado, e sim **compreendê-lo e
contextualizá-lo** — reduzindo o tempo de triagem das equipes de suporte, produto e
desenvolvimento. Toda a operação é **somente leitura**: a Luna nunca altera código,
faz commits, abre PRs nem escreve no banco.

---

## Como funciona

```
                      ┌──────────────────────────────────────────────┐
   HTTP (Bearer key)  │                  wattio-luna                  │
  ───────────────────▶│  Express API  ──spawn──▶  Claude Code (CLI)   │
   /enrich /ask        │  (src/server.js)          headless, read-only │
   /chat/stream        │                              │   │   │        │
                       └──────────────────────────────┼───┼───┼────────┘
                                                       │   │   │
                            repo clonado (volume) ◀────┘   │   │  Read/Grep/Glob/LS
                            /app/repo                       │   │
                            MCP wattio (OpenSearch) ◀───────┘   │  chamados/comentários/anexos
                            MCP postgres (SSE, RO)  ◀───────────┘  schema + SELECT do caso
```

1. A API recebe uma requisição autenticada com a referência da task ou um relato livre.
2. Garante que o repositório-alvo esteja **clonado e atualizado** localmente
   ([`services/repo.js`](src/services/repo.js) — único ponto que escreve em disco).
3. Monta os prompts ([`services/prompt.js`](src/services/prompt.js)) e executa o
   **Claude Code** como subprocesso ([`services/claude.js`](src/services/claude.js)),
   restrito a ferramentas de leitura.
4. A Luna investiga o chamado (MCP), o código (arquivos locais) e — quando habilitado
   — o registro concreto no banco, e devolve a resposta.

### Dois modos de operação

| Modo | Quando dispara | O que faz |
|------|----------------|-----------|
| **enrich** (enriquecer) | só a referência da task (`TASK-12344`) **ou** um relato livre | Investiga e devolve uma descrição enriquecida, em linguagem de negócio, pronta para colar no Notion |
| **answer** (responder) | referência da task **+** pergunta (`TASK-12344 - qual permissão está atrelada?`) | Responde objetivamente **apenas** o que foi perguntado, em texto simples |

A classificação automática (quando o modo não é forçado pela rota) está em
[`utils/parseTicket.js`](src/utils/parseTicket.js).

---

## Endpoints

Autenticação obrigatória em todas as rotas (exceto `/health` e a UI estática):
`Authorization: Bearer <api-key>` ou `x-api-key: <api-key>`.

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET`  | `/health` | Healthcheck — não exige autenticação |
| `GET`  | `/` | Interface de chat (página estática em [`public/`](public/)) |
| `POST` | `/enrich` | Enriquecimento do chamado (síncrono, JSON). Força modo `enrich` |
| `POST` | `/ask` | Resposta a uma pergunta sobre uma task (síncrono, JSON). Força modo `answer` |
| `POST` | `/chat/stream` | Streaming NDJSON em tempo real, usado pela UI de chat |

### Exemplos

```bash
# Enriquecer um chamado a partir do relato livre
curl -sS -X POST http://localhost:8080/enrich \
  -H "Authorization: Bearer $LUNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"Não consigo gerar a fatura desse cliente."}'

# Enriquecer a partir da referência da task (recupera o conteúdo no MCP)
curl -sS -X POST http://localhost:8080/enrich \
  -H "Authorization: Bearer $LUNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"TASK-12344"}'

# Responder uma pergunta específica sobre uma task
curl -sS -X POST http://localhost:8080/ask \
  -H "Authorization: Bearer $LUNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"TASK-12344","question":"qual permissão está atrelada hoje?"}'
```

Há também helpers em [`scripts/enri.sh`](scripts/enri.sh) e [`scripts/ask.sh`](scripts/ask.sh)
e uma coleção Postman em [`postman/`](postman/).

**Formato da resposta (síncrona):**

```json
{
  "requestId": "uuid",
  "repo": "watt-io/gera",
  "ticket": "TASK-12344",
  "mode": "enrich",
  "taskId": "TASK-12344",
  "enrichment": "**📌 Resumo** ...",
  "meta": { "model": "claude-sonnet-4-6", "durationMs": 42000, "numTurns": 12, "costUsd": 0.03 }
}
```

> As rotas síncronas mantêm a conexão aberta durante toda a execução do Claude Code
> (pode levar **minutos**). Para tempo real, use `/chat/stream`.

---

## Arquitetura (Docker Compose)

O [`docker-compose.yml`](docker-compose.yml) sobe três serviços:

| Serviço | Imagem | Papel |
|---------|--------|-------|
| **luna** | build local (Node 22 + Claude Code) | A API e o agente |
| **wattio-mcp** | build de [`wattio-mcp/`](wattio-mcp/) | MCP de leitura do OpenSearch (chamados/comentários/anexos do Notion) |
| **postgres-mcp** | `crystaldba/postgres-mcp` | MCP do banco de produção em **modo restrito (somente leitura)** via SSE |

Ambos os MCPs são **opcionais**: se `MCP_WATTIO_URL` / `MCP_POSTGRES_URL` ficarem
vazios, a Luna analisa apenas o código local. A credencial do banco (`DATABASE_URI`)
fica **somente** no container do `postgres-mcp` — a Luna nunca a recebe.

### Início rápido

```bash
cp .env.example .env
# Edite o .env: LUNA_API_KEYS, autenticação do Claude, GIT_REPO_URL/GIT_TOKEN,
# e (opcional) credenciais do OpenSearch e DATABASE_URI.

docker compose up -d --build
curl http://localhost:8080/health   # {"status":"ok","agent":"luna"}
```

Acesse a UI de chat em `http://localhost:8080/` (informe a API key no campo do topo).

Para desenvolvimento local sem Docker:

```bash
npm install
# exporte as variáveis de ambiente do .env
npm run dev    # node --watch src/server.js
```

---

## Configuração (variáveis de ambiente)

Veja [`.env.example`](.env.example) para a lista completa e comentada. Principais:

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `LUNA_API_KEYS` | ✅ | Chaves de API aceitas (separadas por vírgula). Gere com `openssl rand -hex 32` |
| `CLAUDE_CODE_OAUTH_TOKEN` | ⚠️ | Token de assinatura Pro/Max (`claude setup-token`). **Tem prioridade** sobre a API key |
| `ANTHROPIC_API_KEY` | ⚠️ | API key pay-per-token (alternativa ao OAuth) |
| `ANTHROPIC_MODEL` | — | Modelo (padrão `claude-sonnet-4-6`) |
| `GIT_REPO_URL` | ✅ | Repositório que a Luna analisa |
| `GIT_BRANCH` | — | Branch a clonar (vazio = padrão do remoto) |
| `GIT_TOKEN` / `GIT_USERNAME` | — | Token de **leitura** para repos privados (via askpass, nunca persistido) |
| `MCP_WATTIO_URL` | — | MCP de chamados (vazio desliga) |
| `MCP_POSTGRES_URL` | — | MCP do banco (vazio desliga) |
| `CLAUDE_TIMEOUT_MS` / `CLAUDE_MAX_TURNS` | — | Limites de execução do agente |
| `MAX_TICKET_LENGTH` | — | Tamanho máximo do relato (caracteres) |

⚠️ É obrigatório definir **uma** das formas de autenticação do Claude (OAuth **ou**
API key) — ver [`config.js`](src/config.js) `assertConfig()`.

---

## Segurança — garantias de "somente leitura"

Camadas de defesa em profundidade ([`services/claude.js`](src/services/claude.js)):

1. **Clone isolado**: o repositório vive em `/app/repo` (volume Docker); só
   [`services/repo.js`](src/services/repo.js) escreve nele (clone/pull).
2. **`cwd` do Claude = `/app/repo`**: ele só enxerga os arquivos locais do projeto.
3. **`--allowedTools`** restrito a `Read,Grep,Glob,LS,WebFetch` (+ ferramentas de
   leitura dos MCPs, quando ativos).
4. **`--disallowedTools`** bloqueando explicitamente `Bash,Write,Edit,NotebookEdit,WebSearch,Task`.
5. **`--strict-mcp-config`**: ignora qualquer `.mcp.json` do projeto/usuário; só os
   MCPs configurados pela aplicação valem.
6. **MCP postgres em `--access-mode=restricted`**: apenas `SELECT`.
7. **Container endurecido** ([`docker-compose.yml`](docker-compose.yml)): `read_only`,
   `cap_drop: ALL`, `no-new-privileges`, rootfs gravável só em `tmpfs`.
8. **Auth da API** em tempo constante ([`middleware/auth.js`](src/middleware/auth.js))
   e **token do git** fornecido via askpass, nunca persistido em disco.

---

## Estrutura do projeto

```
src/
  server.js              # bootstrap Express, middlewares, rotas, shutdown gracioso
  config.js              # configuração central a partir do ambiente
  middleware/auth.js     # autenticação por API key (Bearer / x-api-key)
  routes/
    enrich.js            # POST /enrich  (modo enrich)
    ask.js               # POST /ask     (modo answer)
    chat.js              # POST /chat/stream (NDJSON streaming p/ a UI)
  services/
    repo.js              # clone/pull do repositório (único que escreve em disco)
    claude.js            # spawn do Claude Code (runClaude / streamClaude)
    prompt.js            # montagem dos system/user prompts
    enrich.js            # orquestração: valida → repo → prompts → Claude
  utils/
    parseTicket.js       # classifica modo (enrich/answer) e extrai taskId/pergunta
    logger.js            # pino
prompts/                 # system-base + enriquecimento + resposta (Markdown)
public/                  # UI de chat (HTML/CSS/JS estáticos)
wattio-mcp/              # MCP server do OpenSearch (Python) — ver seu próprio README
scripts/                 # helpers de teste (enri.sh, ask.sh)
postman/                 # coleção Postman
```

---

## Limitações e melhorias futuras

- **Execução síncrona**: `/enrich` e `/ask` mantêm a conexão aberta por minutos.
  Uma fila assíncrona para análises longas é um próximo passo natural.
- **Sem testes automatizados** no momento (`npm run lint` faz apenas `node --check`).
- **Concorrência**: cada requisição dispara um processo Claude Code; sob carga, vale
  limitar o paralelismo / adicionar fila.
