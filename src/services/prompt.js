import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts");

// Cache simples — os prompts não mudam em runtime.
const cache = new Map();
async function loadPrompt(name) {
  if (cache.has(name)) return cache.get(name);
  const content = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8");
  cache.set(name, content);
  return content;
}

/**
 * Monta o system prompt completo da Luna (agente de enriquecimento de chamados):
 *  - base: papel de Analista de Sistemas Sênior + regras inegociáveis (somente leitura).
 *  - enriquecimento: a tarefa e o formato de saída estruturado para o Notion.
 *  - contexto do repositório LOCAL clonado.
 */
export async function buildSystemPrompt() {
  const base = await loadPrompt("system-base");
  const enrichment = await loadPrompt("enriquecimento");

  const repoContext = [
    "## Repositório alvo (local)",
    "",
    `O código-fonte a ser analisado já está clonado localmente em \`${config.repoDir}\` (repositório \`${config.repoName}\`).`,
    "Leia os arquivos diretamente desse diretório usando as ferramentas de leitura (Read, Grep, Glob, LS).",
    "Não navegue livremente na internet nem acesse o GitHub: para o código, baseie-se exclusivamente nos arquivos locais. As únicas saídas externas permitidas são o MCP de chamados e o WebFetch (apenas para abrir links citados nos comentários do chamado).",
  ].join("\n");

  const parts = [base, enrichment, repoContext];

  // Quando o MCP wattio está ativo, a Luna também pode consultar as tarefas
  // operacionais (OpenSearch) para correlacionar o chamado com registros reais.
  if (config.mcpWattioUrl) {
    const ns = `mcp__${config.mcpWattioName}`;
    parts.push(
      [
        "## Ferramenta principal de entrada: MCP de chamados/tarefas (wattio / OpenSearch)",
        "",
        `Você tem acesso a um MCP (somente leitura) que consulta os chamados/tarefas operacionais registrados no OpenSearch (sincronizados a partir do Notion). Ferramentas: \`${ns}__get_task_by_id\`, \`${ns}__get_task_comments\`, \`${ns}__get_task_attachments\`, \`${ns}__run_opensearch_query\`, \`${ns}__count_tasks\`, \`${ns}__list_indices\` e \`${ns}__get_index_mapping\`.`,
        "",
        "**Este MCP é o seu PONTO DE PARTIDA.** Ao receber uma solicitação, antes de tocar no código, siga esta ordem:",
        "1. **Recupere o chamado** com `get_task_by_id` (ex.: TASK-12341). Se vier só um relato em texto, localize-o antes com `run_opensearch_query`.",
        "2. **Leia os comentários** com `get_task_comments` (índice `notion_comments`): a ferramenta já resolve a junção por `page_id`. Em cada comentário leia `text` e `raw`. Extraia reprodução, mensagens de erro, cliente/módulo afetado e detalhes ausentes no relato.",
        "3. **Analise os anexos** com `get_task_attachments` (índice `notion_attachments`): traz PDFs e imagens/prints do chamado. Para cada anexo, use a `attachment_url` (URL S3 assinada) com `WebFetch` para carregá-lo e **analise a imagem/conteúdo** — descreva o que mostra (erros, telas, valores). Considere também links inline citados em `raw` dos comentários. As URLs são assinadas e expiram (veja `expiry_time`): carregue-as logo e, se alguma não abrir, diga isso explicitamente em vez de supor.",
        "4. **Estabeleça o problema** (relato + comentários + anexos) e só então **investigue o código**.",
        "",
        "Use o MCP também para dimensionar o problema: chamados semelhantes/recorrentes (`run_opensearch_query`) e contagem (`count_tasks`).",
        "",
        "Diretrizes:",
        "- Antes de montar uma query, descubra os índices/campos com `list_indices` e `get_index_mapping`.",
        "- O MCP e o `WebFetch` são **somente leitura** e complementam — não substituem — a análise do código.",
        "- **Nunca invente** dados: se uma busca, comentário ou link não retornar nada, diga isso claramente.",
        "- Não exponha dados sensíveis de clientes além do necessário para contextualizar o chamado.",
        "- Cite os achados do MCP (ex.: IDs de tarefas, comentários) e das imagens analisadas na seção apropriada do enriquecimento.",
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

/**
 * Monta o prompt do usuário: o relato do chamado a ser enriquecido.
 */
export function buildUserPrompt({ ticket }) {
  return [
    "Enriqueça o chamado de suporte abaixo seguindo o formato de resposta definido.",
    "",
    "## Relato do usuário",
    ticket,
  ].join("\n");
}
