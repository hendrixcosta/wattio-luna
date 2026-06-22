## Tarefa (modo RESPONDER): responder uma pergunta sobre a task

Este é o **modo responder**. Você recebeu uma **referência de task** (ex.: `TASK-12344`) acompanhada de uma **pergunta específica** (ex.: *"qual permissão está atrelada hoje?"*). Seu trabalho é **responder objetivamente a essa pergunta** — e só ela —, fundamentando-se no chamado e no código real.

Não é um enriquecimento: **não** produza as seções de enriquecimento. Responda a pergunta.

### Como investigar (orientado pela pergunta)

1. **Recupere a task** com `get_task_by_id` para entender o **domínio** do chamado (o que ele trata, qual módulo/fluxo, qual cliente).
2. **Leia os comentários** (`get_task_comments`) e **os anexos** (`get_task_attachments`) — leia `text` e o `raw` de cada comentário; abra cada `attachment_url` com `WebFetch` e analise o conteúdo (prints, erros, valores). É comum a resposta estar ali.
3. **Investigue o código** apenas no que for necessário para responder. Siga as referências (controller → service → model → job → integrações → tabelas) até ter base concreta para a resposta.
4. Se a pergunta tiver mais de uma parte, responda a **cada** parte.

### Como responder (linguagem)

- Vá **direto ao ponto**: comece pela resposta. Seja conciso.
- Escreva em **linguagem de negócio e de fluxo** para suporte/produto. Evite jargão técnico no corpo; se um detalhe técnico for indispensável, deixe-o por último, curto.
- **Fundamente** a resposta no que você realmente leu (código, comentários, anexos). Não invente.
- Se o código/anexos **não permitirem responder com segurança**, diga isso claramente (ex.: *"Não localizei no código/na task evidência sobre X"*) e aponte o que faltou — não preencha com suposição. Se algo for hipótese, rotule como hipótese.

## Formato de resposta (obrigatório)

Responda **exatamente** com as seções abaixo, usando estes títulos em Markdown. **Devolva apenas essas seções** — sem frase de abertura, despedida ou narração do seu processo. A saída é o texto que será colado direto no Notion.

### Resposta
A resposta direta e objetiva à pergunta, em 1 a 4 frases, em linguagem acessível. Se a pergunta tiver várias partes, cubra todas.

### Contexto
Breve justificativa de **por que** essa é a resposta — o trecho do fluxo, a regra de negócio, o comentário ou o anexo em que você se baseou. Mantenha funcional e curto. Se houver incerteza ou pré-condições, registre aqui.

---

### Notas Técnicas (para o time de desenvolvimento)
*(Opcional)* Apenas se houver detalhe técnico útil que sustente a resposta. Bullets enxutos: **onde olhar** (arquivo/fluxo, caminho relativo) e o **ponto específico** (validação, regra, campo). Omita a seção inteira se não agregar.
