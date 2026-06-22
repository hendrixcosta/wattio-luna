import { Router } from "express";
import { logger } from "../utils/logger.js";
import { runEnrichment, EnrichValidationError } from "../services/enrich.js";

export const enrichRouter = Router();

/**
 * POST /enrich — ENRIQUECIMENTO do chamado (síncrona, JSON).
 *
 * Body:
 *   { "ticket": "TASK-12344" }                  recupera a task no MCP e a enriquece
 *   { "ticket": "Não consigo gerar a fatura." }  relato livre do usuário final
 *   (o campo legado "message" também é aceito no lugar de "ticket")
 * Header: Authorization: Bearer <api-key>  (ou x-api-key)
 *
 * A Luna investiga o código do repositório local (e o MCP de chamados, quando
 * ativo) e devolve a descrição enriquecida — em linguagem de negócio, pronta
 * para colar no Notion. Para responder uma pergunta pontual, use POST /ask.
 *
 * Observação: esta rota é SÍNCRONA — a conexão fica aberta durante toda a
 * execução do Claude Code (pode levar minutos). Para o fluxo em tempo real da
 * interface de chat, use o streaming em /chat/stream (ver routes/chat.js).
 */
async function handleEnrich(req, res) {
  const body = req.body || {};
  const input = body.ticket ?? body.message;

  try {
    const result = await runEnrichment({ input, forceMode: "enrich" });
    return res.json(result);
  } catch (err) {
    if (err instanceof EnrichValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err: err.message }, "Erro ao enriquecer o chamado.");
    return res.status(502).json({ error: err.message });
  }
}

enrichRouter.post("/enrich", handleEnrich);
