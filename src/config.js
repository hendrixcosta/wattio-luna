/**
 * Configuração central — lê variáveis de ambiente e valida o que é obrigatório.
 * Nenhum segredo é logado. Tokens vêm sempre do ambiente / Docker secrets.
 */

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const gitRepoUrl = required("GIT_REPO_URL");

/** Deriva um nome amigável (owner/repo) a partir da URL para exibição/logs. */
function repoNameFromUrl(url) {
  const cleaned = url
    .replace(/\.git$/, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, ""); // remove credenciais embutidas, se houver
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}

export const config = {
  // Servidor HTTP
  port: Number(optional("PORT", "8080")),
  host: optional("HOST", "0.0.0.0"),
  nodeEnv: optional("NODE_ENV", "production"),

  // Autenticação da API (chaves separadas por vírgula)
  apiKeys: required("LUNA_API_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),

  // Claude Code — autenticação por assinatura (OAuth) OU por API key.
  // Se CLAUDE_CODE_OAUTH_TOKEN existir, usa a assinatura (limites do plano Pro/Max,
  // como no VS Code) e a API key é ignorada. Caso contrário, usa ANTHROPIC_API_KEY
  // (cobrança pay-per-token, sujeita ao rate limit do tier da API).
  claudeOAuthToken: optional("CLAUDE_CODE_OAUTH_TOKEN", ""),
  anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),
  claudeModel: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  claudeBin: optional("CLAUDE_BIN", "claude"),

  // --- Repositório clonado localmente (lido pelo Claude Code) ---
  gitRepoUrl, // ex.: https://github.com/wattio/billing.git
  gitBranch: optional("GIT_BRANCH", ""), // vazio = branch padrão do remoto
  gitUsername: optional("GIT_USERNAME", "x-access-token"),
  gitToken: optional("GIT_TOKEN", ""), // PAT/deploy token de LEITURA (repos privados)
  repoDir: optional("REPO_DIR", "/app/repo"),
  repoName: repoNameFromUrl(gitRepoUrl),
  gitAskpassPath: optional("GIT_ASKPASS_PATH", "/app/git-askpass.sh"),

  // Atualização do repositório
  pullOnRequest: bool("REPO_PULL_ON_REQUEST", true), // git pull antes de cada chamado
  pullMinIntervalMs: Number(optional("REPO_PULL_MIN_INTERVAL_MS", "30000")), // debounce do pull
  gitTimeoutMs: Number(optional("GIT_TIMEOUT_MS", "120000")),

  // --- MCP: wattio-mcp (OpenSearch de tarefas operacionais) ---
  // URL do MCP server em transporte HTTP (streamable-http, endpoint /mcp).
  // Vazio = MCP desabilitado (a Luna analisa só o código local, como antes).
  // No compose, aponta para o serviço `wattio-mcp`. Pode apontar também para o
  // MCP hospedado (ex.: https://mcp.wattio.com.br/mcp).
  mcpWattioUrl: optional("MCP_WATTIO_URL", ""),
  // Nome lógico do servidor MCP -> prefixo das ferramentas: mcp__wattio__<tool>.
  mcpWattioName: optional("MCP_WATTIO_NAME", "wattio"),

  // --- MCP: postgres (banco de dados de produção, somente leitura) ---
  // URL do servidor `postgres-mcp` (transporte SSE), rodando como serviço próprio
  // no compose — assim a Luna não precisa de uv/Python nem rootfs gravável. O
  // servidor abre o banco em modo restrito (somente leitura) e a Luna o usa para
  // inspecionar o schema e consultar exatamente o caso relatado no chamado.
  // Vazio = MCP postgres desabilitado (a Luna analisa só código + chamados).
  mcpPostgresUrl: optional("MCP_POSTGRES_URL", ""),
  // Nome lógico do servidor MCP -> prefixo das ferramentas: mcp__postgres__<tool>.
  mcpPostgresName: optional("MCP_POSTGRES_NAME", "postgres"),

  // Limites de execução do Claude
  claudeTimeoutMs: Number(optional("CLAUDE_TIMEOUT_MS", "180000")), // 3 min
  // Tamanho máximo do relato do chamado. Aceita MAX_TICKET_LENGTH (preferencial)
  // ou MAX_QUESTION_LENGTH (legado) para compatibilidade.
  maxTicketLength: Number(optional("MAX_TICKET_LENGTH", optional("MAX_QUESTION_LENGTH", "4000"))),
  maxTurns: Number(optional("CLAUDE_MAX_TURNS", "30")),
};

export function assertConfig() {
  if (config.apiKeys.length === 0) {
    throw new Error("Nenhuma chave de API configurada em LUNA_API_KEYS.");
  }
  if (!config.claudeOAuthToken && !config.anthropicApiKey) {
    throw new Error(
      "Defina CLAUDE_CODE_OAUTH_TOKEN (assinatura) ou ANTHROPIC_API_KEY para autenticar o Claude Code.",
    );
  }
}
