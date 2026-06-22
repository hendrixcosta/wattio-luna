/**
 * Normaliza a mensagem recebida e classifica o modo de operação da Luna.
 *
 * A Luna tem dois modos, decididos pelo formato do input:
 *
 *  - "enrich"  → enriquecer o chamado. Disparado quando vem APENAS uma
 *                referência de task (ex.: "TASK-12344", "task 12344",
 *                "task-12344", "13344") ou um relato livre em texto.
 *  - "answer"  → responder a uma pergunta específica sobre a task. Disparado
 *                quando vem uma referência de task SEGUIDA de texto
 *                (ex.: "task 12344 - qual permissão está atrelada hoje?").
 *
 * Uma menção inicial opcional (@luna, @luna-tec) é removida por
 * conveniência/compatibilidade.
 *
 * Exemplos:
 *   "TASK-12344"                              -> { mode: "enrich", taskId: "TASK-12344", question: "" }
 *   "task 12344"                              -> { mode: "enrich", taskId: "TASK-12344", question: "" }
 *   "13344"                                   -> { mode: "enrich", taskId: "TASK-13344", question: "" }
 *   "task 12344 - qual permissão está hoje?"  -> { mode: "answer", taskId: "TASK-12344", question: "qual permissão está hoje?" }
 *   "Não consigo gerar a fatura"              -> { mode: "enrich", taskId: null, question: "" }
 *
 * @returns {{ ticket: string, mode: "enrich"|"answer", taskId: string|null, question: string }}
 */

// Referência de task no INÍCIO do texto: prefixo opcional "task"/"TASK-"/"#"
// seguido de 3+ dígitos. Captura os dígitos no grupo 1.
const TASK_REF_RE = /^(?:task[\s_-]*)?#?(\d{3,})\b/i;

// Separadores que costumam ligar a referência da task à pergunta
// ("task 123 - ...", "task 123: ...", "task 123 — ...").
const LEADING_SEP_RE = /^[\s:\-—–|>.]+/;

export function parseTicket(rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message) return { ticket: "", mode: "enrich", taskId: null, question: "" };

  // Remove a menção inicial opcional (@luna / @luna-tec).
  const ticket = message.replace(/^@luna(?:-tec)?\b[\s:,-]*/i, "").trim();

  const ref = ticket.match(TASK_REF_RE);
  if (ref) {
    const taskId = `TASK-${ref[1]}`;
    // O que sobra depois da referência é a eventual pergunta do usuário.
    const rest = ticket.slice(ref[0].length).replace(LEADING_SEP_RE, "").trim();
    if (rest) {
      return { ticket, mode: "answer", taskId, question: rest };
    }
    return { ticket, mode: "enrich", taskId, question: "" };
  }

  // Sem referência de task reconhecível: relato livre → enriquecimento (como antes).
  return { ticket, mode: "enrich", taskId: null, question: "" };
}
