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
