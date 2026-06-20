import { Router } from "express";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { runEnrichmentStream, EnrichValidationError } from "../services/enrich.js";

export const chatRouter = Router();

/**
 * POST /chat/stream  { "ticket": "..." }   (Authorization: Bearer <key>)
 *
 * Streaming estilo LLM para a interface de chat. Responde em NDJSON
 * (application/x-ndjson): uma linha JSON por evento, lida no navegador via
 * fetch + ReadableStream. Eventos:
 *   { "type": "status", "icon": "📖", "text": "Lendo …" }   passo em andamento
 *   { "type": "delta",  "text": "…" }                        pedaço da resposta
 *   { "type": "done",   "meta": { … } }                      fim com metadados
 *   { "type": "error",  "error": "…" }                       falha
 *   { "type": "ping" }                                       heartbeat (anti-timeout)
 *
 * Heartbeats periódicos + cabeçalho X-Accel-Buffering: no mantêm a conexão viva
 * através de proxies (nginx) sem precisar elevar o proxy_read_timeout.
 */
chatRouter.post("/chat/stream", async (req, res) => {
  const requestId = crypto.randomUUID();
  const body = req.body || {};
  const input = body.ticket ?? body.message;

  // Cabeçalhos de streaming. X-Accel-Buffering desliga o buffer do nginx (senão
  // os eventos só chegariam todos no fim, perdendo o efeito de tempo real).
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  // Heartbeat: garante tráfego mesmo durante gaps longos de raciocínio do agente.
  const heartbeat = setInterval(() => send({ type: "ping" }), 15000);

  // Detecta desconexão do CLIENTE pela resposta (res), não pelo request: o
  // 'close' do request dispara assim que o corpo termina de ser lido, o que
  // marcaria "abortado" cedo demais e engoliria os eventos. O 'close' da
  // resposta só dispara no fim real ou se o cliente realmente cair.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    const result = await runEnrichmentStream({
      input,
      requestId,
      onEvent: (evt) => {
        if (!clientGone) send(evt);
      },
    });
    send({ type: "done", requestId, repo: result.repo, meta: result.meta });
  } catch (err) {
    const status = err instanceof EnrichValidationError ? err.status : 502;
    if (!(err instanceof EnrichValidationError)) {
      logger.error({ requestId, err: err.message }, "Erro no stream de enriquecimento.");
    }
    send({ type: "error", status, error: err.message || "Erro ao enriquecer o chamado." });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});
