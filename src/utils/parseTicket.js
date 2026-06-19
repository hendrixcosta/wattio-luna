/**
 * Normaliza a mensagem recebida e extrai o texto do chamado a ser enriquecido.
 *
 * A Luna agora tem um único modo de operação (enriquecimento de chamados), então
 * não há mais distinção de perfil. Por conveniência/compatibilidade, uma menção
 * inicial opcional (@luna, @luna-tec) é removida do início do texto.
 *
 * Exemplos:
 *   "@luna não consigo gerar a fatura"  -> "não consigo gerar a fatura"
 *   "Não consigo gerar a fatura"        -> "Não consigo gerar a fatura"
 */
export function parseTicket(rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message) return { ticket: "" };

  const ticket = message.replace(/^@luna(?:-tec)?\b[\s:,-]*/i, "").trim();
  return { ticket };
}
