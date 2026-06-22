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
 * Monta o system prompt completo da Luna conforme o modo de operação:
 *  - base: papel de Analista de Sistemas Sênior + regras inegociáveis (somente leitura)
 *    + ordem de investigação. É comum aos dois modos.
 *  - tarefa: depende do modo —
 *      "enrich"  → `enriquecimento.md` (enriquecer o chamado; saída estruturada p/ Notion).
 *      "answer"  → `resposta.md` (responder uma pergunta específica sobre a task).
 *  - contexto do repositório LOCAL clonado.
 *
 * @param {object} [params]
 * @param {"enrich"|"answer"} [params.mode="enrich"]
 */
export async function buildSystemPrompt({ mode = "enrich" } = {}) {
  const base = await loadPrompt("system-base");
  const taskPrompt = await loadPrompt(mode === "answer" ? "resposta" : "enriquecimento");

  const repoContext = [
    "## Repositório alvo (local)",
    "",
    `O código-fonte a ser analisado já está clonado localmente em \`${config.repoDir}\` (repositório \`${config.repoName}\`).`,
    "Leia os arquivos diretamente desse diretório usando as ferramentas de leitura (Read, Grep, Glob, LS).",
    "Não navegue livremente na internet nem acesse o GitHub: para o código, baseie-se exclusivamente nos arquivos locais. As únicas saídas externas permitidas são o MCP de chamados e o WebFetch (apenas para abrir links citados nos comentários do chamado).",
  ].join("\n");

  const parts = [base, taskPrompt, repoContext];

  // Quando o MCP wattio está ativo, a Luna também pode consultar as tarefas
  // operacionais (OpenSearch) para correlacionar o chamado com registros reais.
  if (config.mcpWattioUrl) {
    const ns = `mcp__${config.mcpWattioName}`;
    parts.push(
      [
        "## Ferramenta principal de entrada: MCP de chamados/tarefas (wattio / OpenSearch)",
        "",
        `Você tem acesso a um MCP (somente leitura) que consulta os chamados/tarefas operacionais registrados no OpenSearch (sincronizados a partir do Notion). Ferramentas: \`${ns}__get_task_by_id\`, \`${ns}__run_opensearch_query\`, \`${ns}__count_tasks\`, \`${ns}__list_indices\` e \`${ns}__get_index_mapping\`. **Não há tools dedicadas de comentários/anexos** — busque-os você mesmo com \`run_opensearch_query\`, fazendo a junção por \`page_id\`.`,
        "",
        "**Este MCP é o seu PONTO DE PARTIDA.** Ao receber uma solicitação, antes de tocar no código, siga esta ordem:",
        "1. **Recupere o chamado** com `get_task_by_id` (ex.: TASK-12341). Se vier só um relato em texto, localize-o antes com `run_opensearch_query`. Do chamado retornado, guarde o `id`/`_id` (UUID da página Notion) e colete também todos os UUIDs Notion que apareçam em relações e URLs do documento — nas duas formas: com hífens (8-4-4-4-12) e compactada (32 hex dentro de URLs `.../slug-<32hex>`, reinserindo os hífens).",
        "2. **Leia os comentários** com `run_opensearch_query` no índice `notion_comments`, juntando pelo UUID da página: `{\"size\":50,\"query\":{\"terms\":{\"page_id.keyword\":[\"<task page UUID>\"]}},\"sort\":[{\"created_time\":{\"order\":\"asc\"}}]}`. Em cada comentário leia `text` e o objeto `raw` completo. Extraia reprodução, mensagens de erro, cliente/módulo afetado e detalhes ausentes no relato.",
        "3. **Analise os anexos** com `run_opensearch_query` no índice `notion_attachments`, usando todos os UUIDs coletados (a página do chamado costuma referenciar sub-páginas): `{\"size\":50,\"query\":{\"terms\":{\"page_id.keyword\":[\"<task page UUID>\",\"<related page UUID>\"]}}}`. Cada anexo tem `attachment_name`, `attachment_type`, `attachment_url` (URL S3 assinada) e `expiry_time`. Use a `attachment_url` com `WebFetch` para carregá-lo e **analise a imagem/conteúdo** — descreva o que mostra (erros, telas, valores). Considere também links inline citados em `raw` dos comentários. As URLs são assinadas e expiram: carregue-as logo e, se alguma não abrir, diga isso explicitamente em vez de supor.",
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
 * Monta o prompt do usuário conforme o modo:
 *
 *  - "answer": há uma pergunta específica sobre uma task. Instrui a Luna a
 *    recuperar a task no MCP, ler comentários/anexos, investigar o código e
 *    responder objetivamente APENAS a pergunta.
 *  - "enrich" com taskId: veio só a referência da task. O "relato" é o próprio
 *    conteúdo da task, que deve ser recuperado no MCP antes de enriquecer.
 *  - "enrich" com relato livre (sem taskId): comportamento clássico — o texto
 *    recebido é o relato a enriquecer.
 *
 * @param {object} params
 * @param {string} params.ticket           Texto normalizado recebido.
 * @param {"enrich"|"answer"} [params.mode="enrich"]
 * @param {string|null} [params.taskId]    Ex.: "TASK-12344" (quando reconhecido).
 * @param {string} [params.question]       Pergunta do usuário (modo "answer").
 */
export function buildUserPrompt({ ticket, mode = "enrich", taskId = null, question = "" }) {
  if (mode === "answer" && taskId) {
    return [
      `Responda à pergunta abaixo sobre a task **${taskId}**, seguindo o formato definido.`,
      "",
      "Primeiro recupere a task no MCP (`get_task_by_id`), entenda o domínio do chamado,",
      "leia os comentários e os anexos (via `run_opensearch_query` nos índices `notion_comments`",
      "e `notion_attachments`, juntando por `page_id`), e",
      "investigue o código relacionado. Só então responda — em **texto simples**, de forma",
      "**sucinta e direta**, na mesma língua/linguagem do usuário, apenas o que foi perguntado.",
      "",
      "## Task",
      taskId,
      "",
      "## Pergunta",
      question,
    ].join("\n");
  }

  if (mode === "enrich" && taskId) {
    return [
      `Enriqueça a task **${taskId}** seguindo o formato de resposta definido.`,
      "",
      "Recupere a task no MCP (`get_task_by_id`) e use o conteúdo dela como o relato do",
      "chamado. Leia os comentários e os anexos (via `run_opensearch_query` nos índices",
      "`notion_comments` e `notion_attachments`, juntando por `page_id`),",
      "investigue o código relacionado e produza a descrição",
      "enriquecida. Retorne **apenas** o enriquecimento, pronto para colar no Notion.",
      "",
      "## Task",
      taskId,
    ].join("\n");
  }

  // Relato livre em texto (sem referência de task reconhecida).
  return [
    "Enriqueça o chamado de suporte abaixo seguindo o formato de resposta definido.",
    "Retorne **apenas** o enriquecimento, pronto para colar no Notion.",
    "",
    "## Relato do usuário",
    ticket,
  ].join("\n");
}
