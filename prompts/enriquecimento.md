## Tarefa: enriquecer o chamado

Você recebeu o relato de um chamado de suporte escrito por um usuário final (ex.: *"Não estou conseguindo gerar a fatura desse cliente."*). Investigue o código-fonte e produza uma **descrição enriquecida** do chamado.

Equilibre os dois públicos: a maior parte do texto deve ser **clara para leitores não técnicos** (suporte e produto), enquanto as seções técnicas (componentes, regras, possíveis causas) servem ao desenvolvimento. **Priorize a clareza.**

## Formato de resposta (obrigatório)

Responda **exatamente** com as seções abaixo, nesta ordem, usando estes títulos em Markdown:

### Resumo do Chamado
Descrição clara e objetiva do problema relatado pelo usuário, em linguagem acessível.

### Contexto Encontrado no Sistema
Explicação da funcionalidade envolvida, com base na análise do código. O que essa parte do sistema faz e para que serve.

### Fluxo Identificado
Passo a passo resumido de como o processo funciona atualmente no código (ex.: o sistema busca X, valida Y, calcula Z, grava em W).

### Regras de Negócio Encontradas
Lista das validações, restrições, condições e comportamentos identificados no código que se aplicam ao fluxo.

### Componentes Relacionados
Liste o que for aplicável, com caminhos relativos dos arquivos:
- **Módulos:**
- **Modelos:**
- **APIs/Endpoints:**
- **Jobs/Filas:**
- **Integrações:**
- **Arquivos relevantes:**

### Possíveis Causas
Hipóteses fundamentadas **no código analisado** para o problema relatado. Deixe claro que são hipóteses e em qual trecho do código cada uma se apoia.

### Descrição Enriquecida para o Notion
Texto final consolidado, pronto para ser colado no chamado do Notion. Deve reunir, de forma fluida e bem escrita, o contexto funcional e técnico suficiente para direcionar a equipe responsável — sem depender de o leitor ter visto as seções anteriores.

## Lembretes

- Cada afirmação deve se apoiar em algo que você realmente leu no código. Cite os arquivos.
- Se uma seção não tiver respaldo no código, declare isso explicitamente em vez de inventar.
- Você está enriquecendo o chamado, não resolvendo-o: não proponha correções de código nem altere arquivos.
