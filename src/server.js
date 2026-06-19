import express from "express";
import pinoHttp from "pino-http";
import { config, assertConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { askRouter } from "./routes/ask.js";
import { ensureRepo } from "./services/repo.js";

assertConfig();

// Clona o repositório no boot (sem bloquear o /health). Se falhar aqui, a
// primeira requisição tentará novamente via ensureRepo().
ensureRepo().catch((err) =>
  logger.error({ err: err.message }, "Falha ao preparar o repositório no boot."),
);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(pinoHttp({ logger }));

// Healthcheck — não exige autenticação.
app.get("/health", (req, res) => res.json({ status: "ok", agent: "luna" }));

// Tudo abaixo exige autenticação.
app.use(authMiddleware);
app.use("/", askRouter);

// Handler de erro genérico (ex.: JSON malformado).
app.use((err, req, res, _next) => {
  logger.error({ err: err.message }, "Erro não tratado.");
  res.status(err.status || 500).json({ error: "Erro interno." });
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host, model: config.claudeModel }, "Luna API no ar.");
});

// Encerramento gracioso.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    logger.info({ sig }, "Encerrando Luna API...");
    server.close(() => process.exit(0));
  });
}
