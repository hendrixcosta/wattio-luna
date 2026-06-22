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
 * Monta o system prompt completo da Luna conforme o modo de operação. A ORDEM dos
 * blocos segue a ordem de investigação: papel/regras → ferramentas de entrada (MCP)
 * → código local → formato de saída do modo (último, junto ao user prompt):
 *  - base: papel de Analista de Sistemas Sênior + regras inegociáveis (somente leitura)
 *    + ordem de investigação canônica. É comum aos dois modos.
 *  - MCP de chamados (wattio) e MCP de banco (postgres), quando habilitados: as
 *    ferramentas que executam a ordem de investigação definida na base.
 *  - contexto do repositório LOCAL clonado.
 *  - tarefa: depende do modo —
 *      "enrich"  → `enriquecimento.md` (enriquecer o chamado; saída estruturada p/ Notion).
 *      "answer"  → `resposta.md` (responder uma pergunta específica sobre a task).
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
    "Não navegue livremente na internet nem acesse o GitHub: para o código, baseie-se exclusivamente nos arquivos locais. As saídas externas permitidas são apenas: o MCP de chamados, o MCP de banco de dados (quando habilitado) e o WebFetch (somente para abrir links citados nos comentários do chamado).",
  ].join("\n");

  // Ordem: base (papel + ordem de investigação) → ferramentas de entrada (MCP) →
  // repositório local → tarefa do modo (formato de saída, por último). Os blocos
  // MCP vêm logo após a base porque é nela que a ordem de investigação os referencia.
  const parts = [base];

  // Quando o MCP wattio está ativo, a Luna também pode consultar as tarefas
  // operacionais (OpenSearch) para correlacionar o chamado com registros reais.
  if (config.mcpWattioUrl) {
    const ns = `mcp__${config.mcpWattioName}`;
    parts.push(
      [
        "## MCP de chamados/tarefas (wattio / OpenSearch) — ferramentas de entrada",
        "",
        `MCP somente leitura sobre os chamados/tarefas do OpenSearch (sincronizados do Notion). Ferramentas: \`${ns}__get_task_by_id\`, \`${ns}__run_opensearch_query\`, \`${ns}__count_tasks\`, \`${ns}__list_indices\` e \`${ns}__get_index_mapping\`. **Não há tools dedicadas de comentários/anexos** — busque-os com \`run_opensearch_query\`, fazendo a junção por \`page_id\`.`,
        "",
        "Use estas ferramentas para executar a **ordem de investigação definida no system prompt** (recuperar o chamado → comentários → anexos → estabelecer o problema → código). O que é específico de cada passo:",
        "- **Recuperar o chamado:** `get_task_by_id` (ex.: TASK-12341); para relato livre, localize-o antes com `run_opensearch_query`. Do retorno, guarde o `id`/`_id` (UUID da página Notion) e os UUIDs que apareçam em relações e URLs — nas duas formas: com hífens (8-4-4-4-12) e compactada (32 hex em URLs `.../slug-<32hex>`, reinserindo os hífens).",
        "- **Comentários:** `run_opensearch_query` no índice `notion_comments`, junção pelo UUID da página: `{\"size\":50,\"query\":{\"terms\":{\"page_id.keyword\":[\"<task page UUID>\"]}},\"sort\":[{\"created_time\":{\"order\":\"asc\"}}]}`. Em cada comentário leia `text` e o objeto `raw` completo (reprodução, erros, cliente/módulo afetado).",
        "- **Anexos:** `run_opensearch_query` no índice `notion_attachments`, com todos os UUIDs coletados (a página costuma referenciar sub-páginas): `{\"size\":50,\"query\":{\"terms\":{\"page_id.keyword\":[\"<task page UUID>\",\"<related page UUID>\"]}}}`. Cada anexo tem `attachment_name`, `attachment_type`, `attachment_url` (URL S3 assinada) e `expiry_time`; abra a `attachment_url` com `WebFetch`. Considere também links inline citados em `raw` dos comentários.",
        "",
        "Use o MCP também para dimensionar o problema: chamados semelhantes/recorrentes (`run_opensearch_query`) e contagem (`count_tasks`).",
        "",
        "Diretrizes:",
        "- Antes de montar uma query, descubra os índices/campos com `list_indices` e `get_index_mapping`.",
        "- Não exponha dados sensíveis de clientes além do necessário para contextualizar o chamado.",
        "- Cite os achados do MCP (ex.: IDs de tarefas, comentários) e das imagens analisadas na seção apropriada.",
      ].join("\n"),
    );
  }

  // Quando o MCP postgres está ativo, a Luna também pode inspecionar o banco de
  // produção (somente leitura) para verificar exatamente o caso relatado no chamado.
  if (config.mcpPostgresUrl) {
    const ns = `mcp__${config.mcpPostgresName}`;
    parts.push(
      [
        "## Ferramenta de verificação: MCP de banco de dados (postgres — SOMENTE LEITURA)",
        "",
        `Você tem acesso a um MCP de banco de dados PostgreSQL de produção, em **modo restrito (somente leitura)**. Use-o para **inspecionar o schema** (tabelas, colunas, chaves, índices) e **consultar os dados reais** ligados ao caso relatado — confirmando estados, valores e registros que comprovem ou contextualizem o problema. Ferramentas: \`${ns}__list_schemas\`, \`${ns}__list_objects\`, \`${ns}__get_object_details\`, \`${ns}__execute_sql\` e \`${ns}__explain_query\`.`,
        "",
        "**Quando usar:** depois de entender o chamado (relato + comentários + anexos) e identificar no código quais tabelas/entidades estão envolvidas, vá ao banco para **olhar o caso concreto** — o cliente, o contrato, a fatura, o registro específico citado no chamado. É isto que diferencia uma hipótese genérica de um diagnóstico baseado no dado real.",
        "",
        "Fluxo sugerido:",
        "1. **Mapeie o schema** com `list_schemas` → `list_objects` → `get_object_details` para confirmar a estrutura real das tabelas que o código manipula (nomes de colunas, relacionamentos, índices).",
        "2. **Consulte o caso concreto** com `execute_sql`, sempre em **SELECT** e **filtrando pelo identificador citado no chamado** (cliente, contrato, fatura, etc.). Confira o estado real dos registros (status, datas, flags, valores) que o fluxo de código avalia.",
        "3. **Correlacione** o dado encontrado com a regra de negócio do código e com o sintoma relatado — ex.: \"o código exige contrato ativo para gerar a fatura; no banco, o contrato do cliente está com status `inativo`, o que explica a falha\".",
        "",
        "Diretrizes:",
        "- Antes de montar um SELECT, **descubra o schema real** com as ferramentas de inspeção; não presuma nomes de tabelas/colunas — confirme.",
        "- **Somente leitura.** Nunca tente INSERT/UPDATE/DELETE/DDL nem alterar dados; use apenas SELECT (e `explain_query` quando útil). O modo restrito bloqueia escrita, mas a responsabilidade também é sua.",
        "- **Filtre sempre** pelo registro do chamado e **limite** os resultados (`LIMIT`); não faça varreduras amplas nem traga tabelas inteiras.",
        "- **Privacidade:** consulte só o necessário para contextualizar o caso. Não exponha dados pessoais/sensíveis (CPF, e-mail, telefone, etc.) além do indispensável; mascare ou resuma quando puder, e nunca reproduza credenciais.",
        "- Se uma consulta não retornar nada ou você não localizar a tabela, diga isso explicitamente em vez de supor.",
        "- Traga o achado do banco para o corpo da resposta em **linguagem de negócio** (ex.: \"o contrato do cliente está inativo\"), deixando nomes de tabela/coluna apenas nas **Notas Técnicas**, quando o formato pedir.",
      ].join("\n"),
    );
  }

  // O contexto do repositório e a tarefa do modo fecham o prompt: a tarefa
  // (formato de saída) fica o mais próximo possível do user prompt.
  parts.push(repoContext, taskPrompt);

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
  // Frase extra ligada só quando o MCP de banco está habilitado: orienta a Luna a
  // verificar no banco o registro concreto do caso relatado.
  const dbHint = config.mcpPostgresUrl
    ? " Quando for útil para confirmar o caso concreto, consulte o banco de dados (MCP postgres, somente leitura): inspecione o schema e rode SELECT filtrando pelo registro citado no chamado."
    : "";

  if (mode === "answer" && taskId) {
    return [
      `Responda à pergunta abaixo sobre a task **${taskId}**, seguindo o formato definido.`,
      "",
      "Primeiro recupere a task no MCP (`get_task_by_id`), entenda o domínio do chamado,",
      "leia os comentários e os anexos (via `run_opensearch_query` nos índices `notion_comments`",
      "e `notion_attachments`, juntando por `page_id`), e",
      `investigue o código relacionado.${dbHint} Só então responda — em **texto simples**, de forma`,
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
      `investigue o código relacionado${dbHint ? " e verifique no banco de dados o registro concreto do caso" : ""} e produza a descrição`,
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
