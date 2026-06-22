import { Router } from "express";
import { logger } from "../utils/logger.js";
import { runEnrichment, EnrichValidationError } from "../services/enrich.js";

export const askRouter = Router();

/**
 * POST /ask — rota ÚNICA de entrada (síncrona, JSON).
 * Body: { "ticket": "Não estou conseguindo gerar a fatura desse cliente." }
 *        (também aceita o campo legado "message")
 * Header: Authorization: Bearer <api-key>  (ou x-api-key)
 *
 * O comportamento é decidido pelo conteúdo do relato (ver parseTicket):
 *  - veio APENAS a referência da task (ou um relato livre) → enriquecer o chamado;
 *  - veio a task SEGUIDA de uma pergunta → responder apenas a pergunta.
 *
 * A Luna analisa o repositório local configurado em GIT_REPO_URL — garantido como
 * clonado/atualizado por ensureRepo() — e devolve a resposta pronta para o Notion.
 *
 * Observação: esta rota é SÍNCRONA — a conexão fica aberta durante toda a execução
 * do Claude Code. Para o fluxo em tempo real da interface de chat, use o streaming
 * em /chat/stream (ver routes/chat.js).
 */
async function handleEnrich(req, res) {
  const body = req.body || {};
  const input = body.ticket ?? body.message;

  try {
    const result = await runEnrichment({ input });
    return res.json(result);
  } catch (err) {
    if (err instanceof EnrichValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err: err.message }, "Erro ao enriquecer o chamado.");
    return res.status(502).json({ error: err.message });
  }
}

askRouter.post("/ask", handleEnrich);
