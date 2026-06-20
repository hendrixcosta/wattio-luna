import { Router } from "express";
import { logger } from "../utils/logger.js";
import { runEnrichment, EnrichValidationError } from "../services/enrich.js";

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
 *
 * Observação: esta rota é SÍNCRONA — a conexão fica aberta durante toda a execução
 * do Claude Code. Atrás de um proxy com timeout curto (ex.: nginx 60s), prefira o
 * fluxo assíncrono por jobs em /chat/jobs (ver routes/chat.js).
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

askRouter.post("/enrich", handleEnrich);
askRouter.post("/ask", handleEnrich); // alias de compatibilidade
