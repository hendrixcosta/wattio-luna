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
 * Núcleo do enriquecimento, compartilhado entre a rota síncrona (POST /enrich)
 * e o fluxo assíncrono por jobs (POST /chat/jobs). Valida o relato, garante o
 * repositório clonado/atualizado, monta os prompts e executa o Claude Code.
 *
 * @param {object} params
 * @param {string} params.input  Relato bruto do chamado (campo ticket/message).
 * @param {string} [params.requestId]  ID opcional para correlação de logs.
 * @returns {Promise<{requestId,repo,ticket,enrichment,meta}>}
 */
export async function runEnrichment({ input, requestId = crypto.randomUUID() }) {
  if (!input || typeof input !== "string") {
    throw new EnrichValidationError(400, "Campo 'ticket' (relato do chamado) é obrigatório.");
  }
  if (input.length > config.maxTicketLength) {
    throw new EnrichValidationError(413, `Chamado excede o limite de ${config.maxTicketLength} caracteres.`);
  }

  const { ticket } = parseTicket(input);
  if (!ticket) {
    throw new EnrichValidationError(400, "Relato do chamado vazio.");
  }

  logger.info({ requestId, repo: config.repoName, ticketLen: ticket.length }, "Novo chamado para enriquecer.");

  // Garante que o código local esteja clonado e atualizado antes de analisar.
  await ensureRepo();

  const systemPrompt = await buildSystemPrompt();
  const userPrompt = buildUserPrompt({ ticket });

  const { text, raw, durationMs } = await runClaude({ systemPrompt, userPrompt, requestId });

  logger.info({ requestId, durationMs, costUsd: raw?.total_cost_usd }, "Chamado enriquecido.");

  return {
    requestId,
    repo: config.repoName,
    ticket,
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
 * @param {string} [params.requestId]
 * @param {(evt: object) => void} params.onEvent  status/delta do progresso
 * @returns {Promise<{requestId,repo,ticket,enrichment,meta}>}
 */
export async function runEnrichmentStream({ input, requestId = crypto.randomUUID(), onEvent = () => {} }) {
  if (!input || typeof input !== "string") {
    throw new EnrichValidationError(400, "Campo 'ticket' (relato do chamado) é obrigatório.");
  }
  if (input.length > config.maxTicketLength) {
    throw new EnrichValidationError(413, `Chamado excede o limite de ${config.maxTicketLength} caracteres.`);
  }

  const { ticket } = parseTicket(input);
  if (!ticket) {
    throw new EnrichValidationError(400, "Relato do chamado vazio.");
  }

  logger.info({ requestId, repo: config.repoName, ticketLen: ticket.length }, "Novo chamado para enriquecer (stream).");

  onEvent({ type: "status", icon: "📦", text: `Preparando o repositório ${config.repoName}…` });
  await ensureRepo();

  const systemPrompt = await buildSystemPrompt();
  const userPrompt = buildUserPrompt({ ticket });

  const { text, raw, durationMs } = await streamClaude({ systemPrompt, userPrompt, requestId, onEvent });

  logger.info({ requestId, durationMs, costUsd: raw?.total_cost_usd }, "Chamado enriquecido (stream).");

  return {
    requestId,
    repo: config.repoName,
    ticket,
    enrichment: text,
    meta: {
      model: config.claudeModel,
      durationMs,
      numTurns: raw?.num_turns,
      costUsd: raw?.total_cost_usd,
    },
  };
}
