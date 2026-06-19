import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Autenticação obrigatória por API key.
 * Aceita "Authorization: Bearer <key>" ou header "x-api-key: <key>".
 * Comparação em tempo constante para evitar timing attacks.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractKey(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const headerKey = req.headers["x-api-key"];
  if (headerKey) return String(headerKey).trim();
  return null;
}

export function authMiddleware(req, res, next) {
  const provided = extractKey(req);
  if (!provided) {
    return res.status(401).json({ error: "Autenticação obrigatória. Envie um Bearer token ou x-api-key." });
  }

  const valid = config.apiKeys.some((key) => timingSafeEqual(provided, key));
  if (!valid) {
    return res.status(403).json({ error: "Chave de API inválida." });
  }

  next();
}
