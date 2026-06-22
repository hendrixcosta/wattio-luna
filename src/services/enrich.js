import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { parseTicket } from "../utils/parseTicket.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { runClaude, streamClaude } from "./claude.js";
import { ensureRepo } from "./repo.js";

/**
 * Erro de validação do relato (mapeado para 4xx pelas rotas).
 */
export class EnrichValidationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Valida o input e resolve o modo de operação da Luna.
 *
 * Cada rota pode FORÇAR o modo (`/enrich` → "enrich", `/ask` → "answer"); quando
 * `forceMode` é omitido (ex.: a interface de chat em /chat/stream), o modo é
 * inferido do conteúdo por parseTicket — preservando o comportamento clássico.
 *
 * A pergunta pode vir num campo próprio (`question`) ou embutida no texto
 * ("TASK-123 - qual permissão?"); o campo explícito tem prioridade.
 *
 * @param {object} params
 * @param {string} params.input            Relato/ referência bruta (ticket|message).
 * @param {"enrich"|"answer"} [params.forceMode]  Modo forçado pela rota.
 * @param {string} [params.question]       Pergunta explícita (modo answer).
 * @returns {{ ticket: string, mode: "enrich"|"answer", taskId: string|null, question: string }}
 */
function resolveRequest({ input, forceMode, question: explicitQuestion }) {
  if (!input || typeof input !== "string") {
    throw new EnrichValidationError(400, "Campo 'ticket' (relato do chamado) é obrigatório.");
  }
  if (input.length > config.maxTicketLength) {
    throw new EnrichValidationError(413, `Chamado excede o limite de ${config.maxTicketLength} caracteres.`);
  }

  const parsed = parseTicket(input);
  if (!parsed.ticket) {
    throw new EnrichValidationError(400, "Relato do chamado vazio.");
  }

  const mode = forceMode ?? parsed.mode;
  const question =
    typeof explicitQuestion === "string" && explicitQuestion.trim()
      ? explicitQuestion.trim()
      : parsed.question;

  // O modo "answer" responde uma pergunta SOBRE uma task específica: exige ambos.
  if (mode === "answer") {
    if (!parsed.taskId) {
      throw new EnrichValidationError(
        400,
        "Para responder, informe a referência da task (ex.: 'TASK-12344' no campo 'ticket').",
      );
    }
    if (!question) {
      throw new EnrichValidationError(
        400,
        "Campo 'question' (pergunta sobre a task) é obrigatório no modo de resposta.",
      );
    }
  }

  return { ticket: parsed.ticket, mode, taskId: parsed.taskId, question };
}

/**
 * Núcleo do enriquecimento/resposta, compartilhado entre as rotas síncronas
 * (POST /enrich, POST /ask) e o streaming da interface de chat (POST /chat/stream).
 * Valida o relato, garante o repositório clonado/atualizado, monta os prompts e
 * executa o Claude Code.
 *
 * @param {object} params
 * @param {string} params.input  Relato bruto do chamado (campo ticket/message).
 * @param {"enrich"|"answer"} [params.forceMode]  Modo forçado pela rota.
 * @param {string} [params.question]  Pergunta explícita (modo answer).
 * @param {string} [params.requestId]  ID opcional para correlação de logs.
 * @returns {Promise<{requestId,repo,ticket,mode,taskId,enrichment,meta}>}
 */
export async function runEnrichment({ input, forceMode, question: explicitQuestion, requestId = crypto.randomUUID() }) {
  const { ticket, mode, taskId, question } = resolveRequest({ input, forceMode, question: explicitQuestion });

  logger.info({ requestId, repo: config.repoName, mode, taskId, ticketLen: ticket.length }, "Nova solicitação para a Luna.");

  // Garante que o código local esteja clonado e atualizado antes de analisar.
  await ensureRepo();

  const systemPrompt = await buildSystemPrompt({ mode });
  const userPrompt = buildUserPrompt({ ticket, mode, taskId, question });

  const { text, raw, durationMs } = await runClaude({ systemPrompt, userPrompt, requestId });

  logger.info({ requestId, mode, durationMs, costUsd: raw?.total_cost_usd }, "Solicitação concluída.");

  return {
    requestId,
    repo: config.repoName,
    ticket,
    mode,
    taskId,
    enrichment: text,
    meta: {
      model: config.claudeModel,
      durationMs,
      numTurns: raw?.num_turns,
      costUsd: raw?.total_cost_usd,
    },
  };
}

/**
 * Versão STREAMING do enriquecimento, usada pela interface de chat. Valida o
 * relato, prepara o repositório (narrando o passo) e executa o Claude Code em
 * modo stream, repassando cada evento via onEvent.
 *
 * @param {object} params
 * @param {string} params.input
 * @param {"enrich"|"answer"} [params.forceMode]  Modo forçado pela rota.
 * @param {string} [params.question]  Pergunta explícita (modo answer).
 * @param {string} [params.requestId]
 * @param {(evt: object) => void} params.onEvent  status/delta do progresso
 * @returns {Promise<{requestId,repo,ticket,mode,taskId,enrichment,meta}>}
 */
export async function runEnrichmentStream({ input, forceMode, question: explicitQuestion, requestId = crypto.randomUUID(), onEvent = () => {} }) {
  const { ticket, mode, taskId, question } = resolveRequest({ input, forceMode, question: explicitQuestion });

  logger.info({ requestId, repo: config.repoName, mode, taskId, ticketLen: ticket.length }, "Nova solicitação para a Luna (stream).");

  onEvent({ type: "status", icon: "📦", text: `Preparando o repositório ${config.repoName}…` });
  await ensureRepo();

  const systemPrompt = await buildSystemPrompt({ mode });
  const userPrompt = buildUserPrompt({ ticket, mode, taskId, question });

  const { text, raw, durationMs, contextAccess } = await streamClaude({ systemPrompt, userPrompt, requestId, onEvent });

  logger.info({ requestId, mode, durationMs, costUsd: raw?.total_cost_usd, contextAccess }, "Solicitação concluída (stream).");

  return {
    requestId,
    repo: config.repoName,
    ticket,
    mode,
    taskId,
    enrichment: text,
    meta: {
      model: config.claudeModel,
      durationMs,
      numTurns: raw?.num_turns,
      costUsd: raw?.total_cost_usd,
      // Resumo de acesso a comentários/anexos da tarefa, para a home exibir um
      // selo claro de "conseguiu enriquecer com esse contexto" (ou não).
      contextAccess,
    },
  };
}
