import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Ferramentas de LEITURA sempre permitidas; nada de escrita/Bash/rede aberta.
 *  - Read/Grep/Glob/LS: arquivos do repositório local clonado em config.repoDir.
 *  - WebFetch: abrir links externos citados nos COMENTÁRIOS do chamado (prints,
 *    anexos, imagens) para análise. É só leitura (GET); o system prompt restringe
 *    seu uso a URLs vindas do próprio chamado — não é busca livre na web.
 */
const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch"];

/**
 * Ferramentas do MCP wattio (OpenSearch de tarefas operacionais), liberadas só
 * quando MCP_WATTIO_URL está configurado. Os nomes seguem o padrão
 * mcp__<servidor>__<ferramenta>; `mcp__<servidor>` libera todas do servidor.
 */
const MCP_WATTIO_TOOLS = [
  "list_indices",
  "get_task_by_id",
  // Comentários (notion_comments) e anexos (notion_attachments) NÃO têm tools
  // dedicadas: são buscados via run_opensearch_query, fazendo a junção por page_id.
  "run_opensearch_query",
  "count_tasks",
  "get_index_mapping",
];

/**
 * Ferramentas do MCP postgres (banco de produção, somente leitura), liberadas só
 * quando DATABASE_URI está configurada. Servem para a Luna inspecionar o schema
 * e consultar dados reais que comprovem/contextualizem o caso relatado no chamado.
 * Em --access-mode=restricted o execute_sql só roda SELECT/consultas de leitura.
 */
const MCP_POSTGRES_TOOLS = [
  "list_schemas", // lista os schemas do banco
  "list_objects", // lista tabelas/views de um schema
  "get_object_details", // colunas, tipos, chaves e índices de uma tabela
  "execute_sql", // consultas de LEITURA (somente SELECT no modo restricted)
  "explain_query", // plano de execução (sem rodar a query)
];

/** Monta a lista de ferramentas permitidas conforme os MCPs estejam ou não ativos. */
function buildAllowedTools() {
  const tools = [...READ_TOOLS];
  if (config.mcpWattioUrl) {
    const ns = `mcp__${config.mcpWattioName}`;
    tools.push(ns, ...MCP_WATTIO_TOOLS.map((t) => `${ns}__${t}`));
  }
  if (config.mcpPostgresUrl) {
    const ns = `mcp__${config.mcpPostgresName}`;
    tools.push(...MCP_POSTGRES_TOOLS.map((t) => `${ns}__${t}`));
  }
  return tools.join(",");
}

/**
 * Config dos MCPs passada ao Claude Code via `--mcp-config`. Retorna null quando
 * nenhum MCP está habilitado. Pode conter dois servidores, ambos via rede:
 *  - wattio   (transporte HTTP / streamable-http): chamados/tarefas no OpenSearch.
 *  - postgres (transporte SSE): banco de produção, somente leitura. Roda como
 *    serviço próprio no compose (postgres-mcp --access-mode=restricted); a Luna
 *    apenas conecta na URL, sem precisar de uv/Python nem rootfs gravável.
 */
function buildMcpConfig() {
  const mcpServers = {};
  if (config.mcpWattioUrl) {
    mcpServers[config.mcpWattioName] = { type: "http", url: config.mcpWattioUrl };
  }
  if (config.mcpPostgresUrl) {
    mcpServers[config.mcpPostgresName] = { type: "sse", url: config.mcpPostgresUrl };
  }
  if (Object.keys(mcpServers).length === 0) return null;
  return JSON.stringify({ mcpServers });
}

/**
 * Ferramentas EXPLICITAMENTE bloqueadas — defesa em profundidade.
 * Mesmo que algo escape do allowlist, estas nunca rodam.
 */
const DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebSearch", // sem busca livre na web; WebFetch (links do chamado) é permitido
  "Task",
].join(",");

/**
 * Executa o Claude Code em modo headless (print) sobre o repositório LOCAL e
 * devolve a resposta final.
 *
 * Camadas de garantia (somente leitura):
 *  1. O repositório é clonado por services/repo.js — único ponto que escreve em disco.
 *  2. cwd do Claude = config.repoDir; ele só enxerga os arquivos locais do projeto.
 *  3. allowedTools restrito a Read/Grep/Glob/LS/WebFetch (+ ferramentas do MCP wattio, se ativo).
 *     WebFetch é só leitura (GET) e o system prompt o restringe a links do próprio chamado.
 *  4. disallowedTools bloqueando explicitamente ferramentas de escrita/execução/busca web.
 *  5. MCP wattio (OpenSearch) é SOMENTE LEITURA e só roda se MCP_WATTIO_URL existir.
 *     `--strict-mcp-config` ignora qualquer .mcp.json do projeto/usuário.
 *
 * @returns {Promise<{text: string, raw: object, durationMs: number}>}
 */
export function runClaude({ systemPrompt, userPrompt, requestId }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", userPrompt,
      "--append-system-prompt", systemPrompt,
      "--model", config.claudeModel,
      "--add-dir", config.repoDir,
      "--allowedTools", buildAllowedTools(),
      "--disallowedTools", DISALLOWED_TOOLS,
      "--permission-mode", "default",
      "--max-turns", String(config.maxTurns),
      "--output-format", "json",
    ];

    // Liga o MCP wattio (OpenSearch de tarefas) quando configurado.
    const mcpConfig = buildMcpConfig();
    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
    }

    // Autenticação: com OAuth (assinatura Pro/Max) usamos CLAUDE_CODE_OAUTH_TOKEN
    // e NÃO enviamos ANTHROPIC_API_KEY (se ambos existirem, a API key tem
    // prioridade no binário e o rate limit do tier da API voltaria a valer).
    const authEnv = config.claudeOAuthToken
      ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOAuthToken, ANTHROPIC_API_KEY: undefined }
      : { ANTHROPIC_API_KEY: config.anthropicApiKey };

    const child = spawn(config.claudeBin, args, {
      // O cwd é o próprio repositório clonado: a Luna lê os arquivos daqui.
      cwd: config.repoDir,
      env: {
        ...process.env,
        ...authEnv,
        ANTHROPIC_MODEL: config.claudeModel,
        HOME: "/app",
        // Evita qualquer telemetria/atualização automática dentro do container.
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      logger.warn({ requestId }, "Claude Code excedeu o tempo limite, encerrando.");
      child.kill("SIGKILL");
      reject(new Error("Tempo limite excedido ao executar o Claude Code."));
    }, config.claudeTimeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao iniciar o Claude Code: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      // No formato json, mesmo em erro o Claude costuma emitir um JSON no stdout
      // com is_error=true e a mensagem real em `result` (ex.: erro 429 da API).
      // Tentamos parsear primeiro para propagar a causa real.
      let raw = null;
      if (stdout.trim()) {
        try {
          raw = JSON.parse(stdout);
        } catch {
          /* stdout não-JSON tratado abaixo */
        }
      }

      if (raw) {
        const text = raw.result ?? raw.text ?? "";
        if (raw.is_error || code !== 0 || !text) {
          logger.error({ requestId, code, apiErrorStatus: raw.api_error_status, detail: text.slice(0, 500) }, "Claude Code retornou erro.");
          return reject(new Error(text || `Claude Code finalizou com código ${code}.`));
        }
        return resolve({ text, raw, durationMs });
      }

      logger.error({ requestId, code, stderr: stderr.slice(0, 2000), stdout: stdout.slice(0, 500) }, "Claude Code retornou erro sem JSON.");
      reject(new Error(stderr.trim() || `Claude Code finalizou com código ${code}.`));
    });
  });
}

/** Resumo curto e legível do input de uma ferramenta, para narrar o progresso. */
function describeTool(name, input = {}) {
  switch (name) {
    case "Read":
      return { icon: "📖", label: `Lendo ${shorten(input.file_path)}` };
    case "Grep":
      return { icon: "🔍", label: `Buscando "${shorten(input.pattern, 60)}"${input.path ? ` em ${shorten(input.path)}` : ""}` };
    case "Glob":
      return { icon: "📁", label: `Procurando arquivos ${shorten(input.pattern, 60)}` };
    case "LS":
      return { icon: "📂", label: `Explorando ${shorten(input.path) || "diretório"}` };
    case "WebFetch":
      return { icon: "🌐", label: `Abrindo link do chamado ${shorten(input.url, 60)}` };
    default:
      if (name.startsWith(`mcp__${config.mcpPostgresName}__`)) {
        return describePostgresTool(name.split("__").pop(), input);
      }
      if (name.startsWith("mcp__")) {
        return describeOpenSearchTool(name.split("__").pop(), input);
      }
      // Ferramentas fora do escopo de leitura (ex.: tentativas internas do agente)
      // não viram narração — manteria o painel poluído sem valor para quem testa.
      return null;
  }
}

/**
 * Resume uma instrução SQL para narração: detecta a operação e a tabela alvo.
 * É um parse propositalmente raso (regex), só para dizer "o que está fazendo" —
 * não precisa cobrir todo o dialeto. No modo restricted só roda leitura.
 */
function describeSql(sql) {
  if (!sql) return "Executando consulta SQL";
  const text = String(sql).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  // Tabela alvo: primeiro FROM ou JOIN (ignora subselects simples).
  const tableMatch = text.match(/\b(?:from|join)\s+("?[\w.]+"?)/i);
  const table = tableMatch ? tableMatch[1].replace(/"/g, "") : null;
  const onTable = table ? ` na tabela ${shorten(table, 40)}` : "";

  if (/^\s*select\s+count\s*\(/i.test(text)) return `Contando registros${onTable}`;
  if (lower.startsWith("select")) return `Consultando dados${onTable}`;
  if (lower.startsWith("with")) return `Consultando dados${onTable || " (CTE)"}`;
  if (lower.startsWith("explain")) return "Analisando o plano de execução da consulta";
  if (lower.startsWith("show")) return "Consultando configuração do banco";
  return `Executando consulta${onTable}`;
}

/**
 * Narração específica para cada ferramenta do MCP de postgres (banco de produção,
 * somente leitura). Antes todas caíam num genérico "Analisando o banco de dados:
 * <tool>"; aqui cada ferramenta vira uma frase que diz o que está sendo feito,
 * usando os argumentos da chamada (schema, tabela, SQL) quando disponíveis.
 */
function describePostgresTool(tool, input = {}) {
  const schema = input.schema_name || input.schema;
  const object = input.object_name || input.table_name || input.table;

  switch (tool) {
    case "list_schemas":
      return { icon: "🗄️", label: "Listando os schemas do banco" };
    case "list_objects":
      return { icon: "🗄️", label: `Listando as tabelas${schema ? ` do schema ${shorten(schema, 40)}` : ""}` };
    case "get_object_details":
      return { icon: "📐", label: `Inspecionando a estrutura da tabela ${shorten(object, 40) || "do banco"}` };
    case "explain_query":
      return { icon: "🧠", label: "Analisando o plano de execução da consulta" };
    case "execute_sql":
      return { icon: "🗄️", label: describeSql(input.sql) };
    default:
      return { icon: "🗄️", label: `Analisando o banco de dados: ${tool}` };
  }
}

/**
 * Narração específica para cada ferramenta do MCP de OpenSearch (servidor "wattio").
 * Antes todas caíam num genérico "Consultando tarefas (OpenSearch): <tool>"; aqui
 * cada ferramenta vira uma frase que diz o que está sendo feito, usando os argumentos
 * da chamada (id da tarefa, índice alvo) quando disponíveis.
 */
function describeOpenSearchTool(tool, input = {}) {
  // notion_comments / notion_attachments são índices de contexto da tarefa; o índice
  // padrão (omitido) e database_producao são as próprias tarefas.
  const indexLabel = (index) => {
    if (index === "notion_comments") return "comentários";
    if (index === "notion_attachments") return "anexos";
    if (index === "pessoas") return "pessoas";
    if (index === "projetos") return "projetos";
    return "tarefas";
  };

  switch (tool) {
    case "list_indices":
      return { icon: "🗂️", label: "Listando os índices disponíveis no OpenSearch" };
    case "get_index_mapping":
      return { icon: "🧬", label: `Inspecionando os campos do índice de ${indexLabel(input.index)}` };
    case "get_task_by_id":
      return { icon: "🎯", label: `Buscando a tarefa ${shorten(input.task_id, 40) || "por ID"}` };
    case "count_tasks":
      return { icon: "🔢", label: `Contando ${indexLabel(input.index)}` };
    case "run_opensearch_query":
      return { icon: "🔎", label: `Pesquisando ${indexLabel(input.index)} no OpenSearch` };
    default:
      return { icon: "🧰", label: `Consultando o OpenSearch: ${tool}` };
  }
}

/**
 * Identifica se uma chamada de ferramenta do MCP wattio está acessando o índice
 * de comentários ou de anexos de uma tarefa. Usado para reportar na home se a Luna
 * conseguiu (ou não) puxar esse contexto extra do Notion — já que descrições de
 * tarefa costumam ser incompletas e o detalhe real vive em comentários/anexos.
 * Retorna "comments" | "attachments" | null.
 */
function openSearchContextKind(name, input = {}) {
  if (!name.startsWith("mcp__")) return null;
  if (input.index === "notion_comments") return "comments";
  if (input.index === "notion_attachments") return "attachments";
  return null;
}

/**
 * Extrai o total de hits de um bloco tool_result do stream-json. O conteúdo costuma
 * vir como [{type:"text", text:"<json do run_opensearch_query>"}]; o JSON tem
 * {total, hits:[…]}. Devolve 0 quando não dá para inferir (erro, formato inesperado).
 */
function extractHitsTotal(content) {
  try {
    let text = content;
    if (Array.isArray(content)) {
      text = content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
    }
    if (typeof text !== "string" || !text.trim()) return 0;
    const data = JSON.parse(text);
    if (data && data.error) return 0;
    if (typeof data?.total === "number") return data.total;
    if (Array.isArray(data?.hits)) return data.hits.length;
    return 0;
  } catch {
    return 0;
  }
}

/** Encurta caminhos/strings para exibição (mantém a parte final dos caminhos). */
function shorten(value, max = 48) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= max) return str;
  return "…" + str.slice(-(max - 1));
}

/**
 * Variante STREAMING do runClaude: usa `--output-format stream-json` para emitir
 * eventos do agente em tempo real e os traduz em narração amigável + texto parcial.
 *
 * Chama `onEvent(evt)` para cada evento. Tipos de evt:
 *   { type: "status", icon, text }   passo de raciocínio / uso de ferramenta
 *   { type: "delta",  text }         pedaço incremental da resposta final
 *
 * Resolve com { text, raw, durationMs } igual ao runClaude.
 *
 * @param {object} params
 * @param {(evt: object) => void} params.onEvent
 */
export function streamClaude({ systemPrompt, userPrompt, requestId, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", userPrompt,
      "--append-system-prompt", systemPrompt,
      "--model", config.claudeModel,
      "--add-dir", config.repoDir,
      "--allowedTools", buildAllowedTools(),
      "--disallowedTools", DISALLOWED_TOOLS,
      "--permission-mode", "default",
      "--max-turns", String(config.maxTurns),
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];

    const mcpConfig = buildMcpConfig();
    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
    }

    const authEnv = config.claudeOAuthToken
      ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOAuthToken, ANTHROPIC_API_KEY: undefined }
      : { ANTHROPIC_API_KEY: config.anthropicApiKey };

    const child = spawn(config.claudeBin, args, {
      cwd: config.repoDir,
      env: {
        ...process.env,
        ...authEnv,
        ANTHROPIC_MODEL: config.claudeModel,
        HOME: "/app",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startedAt = Date.now();
    let stderr = "";
    let buffer = "";
    let finalText = "";
    let finalRaw = null;
    let settled = false;

    // Rastreia acesso aos índices de contexto (comentários/anexos) para reportar
    // na home se a Luna conseguiu enriquecer com esse material. `queried` = a Luna
    // chegou a consultar; `found` = maior total retornado (evita somar consultas
    // repetidas). `pending` correlaciona o tool_use (que sabe o índice) com o
    // tool_result correspondente (que traz o total), via tool_use_id.
    const contextAccess = {
      comments: { queried: false, found: 0 },
      attachments: { queried: false, found: 0 },
    };
    const pending = new Map(); // tool_use_id -> "comments" | "attachments"
    let contextSummarySent = false;

    const timer = setTimeout(() => {
      logger.warn({ requestId }, "Claude Code (stream) excedeu o tempo limite, encerrando.");
      child.kill("SIGKILL");
      finish(new Error("Tempo limite excedido ao executar o Claude Code."));
    }, config.claudeTimeoutMs);

    /**
     * Narra, ao final, se a Luna acessou comentários/anexos da tarefa. Só dispara
     * quando algum desses índices chegou a ser consultado (em chamados sem tarefa
     * associada não há contexto a reportar) e apenas uma vez.
     */
    function emitContextSummary() {
      if (contextSummarySent) return;
      if (!contextAccess.comments.queried && !contextAccess.attachments.queried) return;
      contextSummarySent = true;
      const part = (info, singular, plural) => {
        if (!info.queried) return null;
        if (info.found > 0) return `${info.found} ${info.found === 1 ? singular : plural} acessado${info.found === 1 ? "" : "s"}`;
        return `nenhum ${singular} indexado`;
      };
      const c = part(contextAccess.comments, "comentário", "comentários");
      const a = part(contextAccess.attachments, "anexo", "anexos");
      const anyFound = contextAccess.comments.found > 0 || contextAccess.attachments.found > 0;
      onEvent({
        type: "status",
        icon: anyFound ? "🗂️" : "📭",
        text: `Contexto da tarefa — 💬 ${c || "não consultado"} · 📎 ${a || "não consultado"}`,
      });
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      emitContextSummary();
      resolve({ text: finalText, raw: finalRaw, durationMs: Date.now() - startedAt, contextAccess });
    }

    /** Processa um objeto de evento do stream-json. */
    function handleEvent(evt) {
      switch (evt.type) {
        case "system":
          if (evt.subtype === "init") {
            onEvent({ type: "status", icon: "🧠", text: "Analisando o chamado e o código do repositório…" });
          }
          break;

        case "assistant": {
          // Mensagem (parcial ou completa) do assistente: blocos de texto e tool_use.
          const content = evt.message?.content || [];
          for (const block of content) {
            if (block.type === "tool_use") {
              const desc = describeTool(block.name, block.input);
              if (desc) onEvent({ type: "status", icon: desc.icon, text: desc.label });
              // Marca consultas a comentários/anexos para casar com o resultado.
              const kind = openSearchContextKind(block.name, block.input);
              if (kind) {
                contextAccess[kind].queried = true;
                if (block.id) pending.set(block.id, kind);
              }
            }
          }
          break;
        }

        case "user": {
          // Resultados das ferramentas voltam aqui (tool_result). Para as consultas
          // de comentários/anexos que marcamos, lemos o total de hits encontrados.
          const content = evt.message?.content || [];
          for (const block of content) {
            if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
              const kind = pending.get(block.tool_use_id);
              pending.delete(block.tool_use_id);
              const total = block.is_error ? 0 : extractHitsTotal(block.content);
              contextAccess[kind].found = Math.max(contextAccess[kind].found, total);
            }
          }
          break;
        }

        case "stream_event": {
          // Deltas incrementais — é daqui que sai o preenchimento gradual do texto.
          const inner = evt.event;
          if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            const piece = inner.delta.text || "";
            finalText += piece;
            onEvent({ type: "delta", text: piece });
          }
          break;
        }

        case "result": {
          finalRaw = evt;
          // O texto consolidado do result é a fonte da verdade (caso deltas falhem).
          const consolidated = evt.result ?? evt.text ?? "";
          if (evt.is_error) {
            return finish(new Error(consolidated || "Claude Code retornou erro."));
          }
          if (consolidated && consolidated.length >= finalText.length) {
            finalText = consolidated;
          }
          finish(null);
          break;
        }
      }
    }

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* linha não-JSON (ruído); ignora */
        }
      }
    });

    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => finish(new Error(`Falha ao iniciar o Claude Code: ${err.message}`)));

    child.on("close", (code) => {
      if (settled) return;
      if (finalText.trim()) return finish(null); // terminou sem evento result explícito
      logger.error({ requestId, code, stderr: stderr.slice(0, 2000) }, "Claude Code (stream) encerrou sem resposta.");
      finish(new Error(stderr.trim() || `Claude Code finalizou com código ${code}.`));
    });
  });
}
