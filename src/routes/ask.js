import { Router } from "express";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { parseTicket } from "../utils/parseTicket.js";
import { buildSystemPrompt, buildUserPrompt } from "../services/prompt.js";
import { runClaude } from "../services/claude.js";
import { ensureRepo } from "../services/repo.js";

export const askRouter = Router();

/**
 * POST /enrich  (alias: POST /ask)
 * Body: { "ticket": "Não estou conseguindo gerar a fatura desse cliente." }
 *        (também aceita o campo legado "message")
 * Header: Authorization: Bearer <api-key>  (ou x-api-key)
 *
 * A Luna analisa o repositório local configurado em GIT_REPO_URL — garantido como
 * clonado/atualizado por ensureRepo() — e devolve o chamado enriquecido (contexto
 * técnico e funcional) pronto para o Notion.
 */
async function handleEnrich(req, res) {
  const requestId = crypto.randomUUID();
  const body = req.body || {};
  const input = body.ticket ?? body.message;

  if (!input || typeof input !== "string") {
    return res.status(400).json({ error: "Campo 'ticket' (relato do chamado) é obrigatório." });
  }
  if (input.length > config.maxTicketLength) {
    return res.status(413).json({ error: `Chamado excede o limite de ${config.maxTicketLength} caracteres.` });
  }

  const { ticket } = parseTicket(input);
  if (!ticket) {
    return res.status(400).json({ error: "Relato do chamado vazio." });
  }

  logger.info({ requestId, repo: config.repoName, ticketLen: ticket.length }, "Novo chamado para enriquecer.");

  try {
    // Garante que o código local esteja clonado e atualizado antes de analisar.
    await ensureRepo();

    const systemPrompt = await buildSystemPrompt();
    const userPrompt = buildUserPrompt({ ticket });

    const { text, raw, durationMs } = await runClaude({ systemPrompt, userPrompt, requestId });

    logger.info({ requestId, durationMs, costUsd: raw?.total_cost_usd }, "Chamado enriquecido.");

    return res.json({
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
    });
  } catch (err) {
    logger.error({ requestId, err: err.message }, "Erro ao enriquecer o chamado.");
    return res.status(502).json({ requestId, error: err.message });
  }
}

askRouter.post("/enrich", handleEnrich);
askRouter.post("/ask", handleEnrich); // alias de compatibilidade
