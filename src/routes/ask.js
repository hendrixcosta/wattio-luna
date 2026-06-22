import { Router } from "express";
import { logger } from "../utils/logger.js";
import { runEnrichment, EnrichValidationError } from "../services/enrich.js";

export const askRouter = Router();

/**
 * POST /ask — PERGUNTA E RESPOSTA sobre uma task específica (síncrona, JSON).
 *
 * Body:
 *   { "ticket": "TASK-12344", "question": "qual permissão está atrelada hoje?" }
 *   — ou, de forma combinada, no próprio relato:
 *   { "ticket": "task 12344 - qual permissão está atrelada hoje?" }
 *   (o campo legado "message" também é aceito no lugar de "ticket")
 * Header: Authorization: Bearer <api-key>  (ou x-api-key)
 *
 * A Luna recupera a task no MCP de chamados, lê comentários/anexos, investiga o
 * código do repositório local e responde OBJETIVAMENTE apenas a pergunta — não
 * enriquece o chamado (para isso, use POST /enrich).
 *
 * Observação: esta rota é SÍNCRONA — a conexão fica aberta durante toda a
 * execução do Claude Code (pode levar minutos).
 */
async function handleAsk(req, res) {
  const body = req.body || {};
  const input = body.ticket ?? body.message;
  const question = body.question;

  try {
    const result = await runEnrichment({ input, forceMode: "answer", question });
    return res.json(result);
  } catch (err) {
    if (err instanceof EnrichValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err: err.message }, "Erro ao responder a pergunta sobre a task.");
    return res.status(502).json({ error: err.message });
  }
}

askRouter.post("/ask", handleAsk);
