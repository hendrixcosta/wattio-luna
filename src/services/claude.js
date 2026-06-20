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
  "get_task_comments",
  "get_task_attachments",
  "run_opensearch_query",
  "count_tasks",
  "get_index_mapping",
];

/** Monta a lista de ferramentas permitidas conforme o MCP esteja ou não ativo. */
function buildAllowedTools() {
  const tools = [...READ_TOOLS];
  if (config.mcpWattioUrl) {
    const ns = `mcp__${config.mcpWattioName}`;
    tools.push(ns, ...MCP_WATTIO_TOOLS.map((t) => `${ns}__${t}`));
  }
  return tools.join(",");
}

/**
 * Config do MCP (transporte HTTP / streamable-http) passada ao Claude Code via
 * `--mcp-config`. Retorna null quando o MCP está desabilitado.
 */
function buildMcpConfig() {
  if (!config.mcpWattioUrl) return null;
  return JSON.stringify({
    mcpServers: {
      [config.mcpWattioName]: { type: "http", url: config.mcpWattioUrl },
    },
  });
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
      if (name.startsWith("mcp__")) {
        const tool = name.split("__").pop();
        return { icon: "🧰", label: `Consultando tarefas (OpenSearch): ${tool}` };
      }
      // Ferramentas fora do escopo de leitura (ex.: tentativas internas do agente)
      // não viram narração — manteria o painel poluído sem valor para quem testa.
      return null;
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

    const timer = setTimeout(() => {
      logger.warn({ requestId }, "Claude Code (stream) excedeu o tempo limite, encerrando.");
      child.kill("SIGKILL");
      finish(new Error("Tempo limite excedido ao executar o Claude Code."));
    }, config.claudeTimeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve({ text: finalText, raw: finalRaw, durationMs: Date.now() - startedAt });
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
