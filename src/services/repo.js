import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Gestão do repositório clonado LOCALMENTE.
 *
 * A Luna não acessa mais o GitHub via MCP: o código vive em `config.repoDir`
 * (um volume Docker) e o Claude Code lê os arquivos diretamente desse diretório.
 *
 * Este módulo é o ÚNICO ponto autorizado a escrever em disco (git clone/pull).
 * O próprio Claude Code roda sem ferramentas de escrita (ver services/claude.js).
 *
 * Garantias:
 *  - Auth de leitura via GIT_ASKPASS — o token NUNCA é persistido na config do git
 *    (só o username vai para a URL do remoto).
 *  - Lock de concorrência: clone/pull simultâneos compartilham a mesma Promise.
 *  - Debounce de pull para não disparar `git fetch` a cada requisição.
 */

let inflight = null;
let lastPullAt = 0;

/** Remove qualquer credencial embutida de mensagens de erro antes de logar. */
function redact(text) {
  let out = String(text);
  if (config.gitToken) out = out.split(config.gitToken).join("[REDACTED]");
  return out.replace(/\/\/[^@\s/]+@/g, "//[REDACTED]@");
}

/** Injeta apenas o username na URL https (o token é fornecido via askpass). */
function remoteUrl() {
  const url = config.gitRepoUrl;
  if (!config.gitToken) return url;
  if (!/^https:\/\//i.test(url)) return url; // ssh/git: auth via chave montada
  if (/^https:\/\/[^/@]+@/i.test(url)) return url; // já tem credencial embutida
  return url.replace(/^https:\/\//i, `https://${encodeURIComponent(config.gitUsername)}@`);
}

function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // HOME gravável (tmpfs) e sem config global/sistema interferindo.
        HOME: "/tmp",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0", // nunca pedir credencial interativa
        ...(config.gitToken
          ? { GIT_ASKPASS: config.gitAskpassPath, GIT_TOKEN: config.gitToken }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Tempo limite no git ${args[0]}.`));
    }, config.gitTimeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao executar git: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`git ${args[0]} falhou (código ${code}): ${redact(stderr).slice(0, 500)}`));
      }
      resolve(stdout.trim());
    });
  });
}

async function clone() {
  logger.info({ repo: config.repoName, dir: config.repoDir }, "Clonando repositório...");
  const args = ["clone", "--depth", "1"];
  if (config.gitBranch) args.push("--branch", config.gitBranch, "--single-branch");
  args.push(remoteUrl(), config.repoDir);
  await runGit(args);
  logger.info({ repo: config.repoName }, "Repositório clonado.");
}

async function pull() {
  // Reset defensivo: garante que o working tree esteja exatamente como o remoto,
  // mesmo que algo tenha sido alterado, e evita conflitos de merge.
  await runGit(["remote", "set-url", "origin", remoteUrl()], { cwd: config.repoDir });
  await runGit(["fetch", "--depth", "1", "origin"], { cwd: config.repoDir });
  const branch =
    config.gitBranch ||
    (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: config.repoDir }));
  await runGit(["reset", "--hard", `origin/${branch}`], { cwd: config.repoDir });
  await runGit(["clean", "-fdx"], { cwd: config.repoDir });
  logger.info({ repo: config.repoName, branch }, "Repositório atualizado (git pull).");
}

/**
 * Garante que o repositório esteja clonado e (opcionalmente) atualizado.
 * Seguro para chamar concorrentemente: chamadas simultâneas reaproveitam a mesma Promise.
 *
 * @param {{forcePull?: boolean}} [opts]
 */
export function ensureRepo({ forcePull = false } = {}) {
  if (inflight) return inflight;

  inflight = (async () => {
    const hasClone = existsSync(join(config.repoDir, ".git"));

    if (!hasClone) {
      await clone();
      lastPullAt = Date.now();
      return;
    }

    const due = Date.now() - lastPullAt >= config.pullMinIntervalMs;
    if (forcePull || (config.pullOnRequest && due)) {
      try {
        await pull();
        lastPullAt = Date.now();
      } catch (err) {
        // Repo já clonado: um pull falho (ex.: rede instável) não deve derrubar a
        // requisição — seguimos respondendo com a cópia local existente.
        logger.warn({ repo: config.repoName, err: redact(err.message) }, "Falha ao atualizar o repositório; usando cópia local.");
      }
    }
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
