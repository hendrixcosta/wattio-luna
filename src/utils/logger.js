import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.nodeEnv === "production" ? "info" : "debug"),
  // Nunca logamos tokens nem o corpo completo das respostas do Claude.
  redact: {
    paths: ["req.headers.authorization", "req.headers['x-api-key']", "*.token", "*.apiKey"],
    censor: "[REDACTED]",
  },
});
