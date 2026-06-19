Você atuará como Arquiteto Sênior de Software, Especialista em Agentes de IA, Claude Code, Docker, Docker Compose, APIs backend e análise automatizada de código-fonte.

Quero que você me ajude a estruturar tecnicamente um projeto chamado **wattio-Luna**.

## Contexto do projeto

O projeto será uma API que receberá requisições autenticadas e responderá como um agente de IA.

Esse agente será chamado **Luna**.

A solução deverá rodar em **Docker Compose** e conter o **Claude Code** dentro do container.

Ao invés de acessar o GitHub via MCP, o projeto deverá **clonar um repositório Git dentro do container ou em um volume Docker** e instruir o Claude Code a analisar os arquivos disponíveis localmente na própria máquina.

A API receberá perguntas, montará um prompt interno, executará o Claude Code apontando para a pasta local do repositório clonado, analisará o código-fonte e retornará uma resposta baseada no código real.

## Requisitos principais

O projeto deverá conter:

* API HTTP para receber requisições;
* Autenticação obrigatória;
* Dockerfile;
* docker-compose.yml;
* Claude Code instalado no container;
* Repositório Git clonado localmente;
* Volume Docker para persistir o código clonado;
* Rotina para atualizar o repositório com `git pull`;
* Execução controlada do Claude Code;
* Respostas baseadas exclusivamente nos arquivos locais do projeto;
* Bloqueio de comandos destrutivos;
* Nenhuma alteração no código-fonte analisado.

## Funcionamento esperado

A API receberá mensagens como:

```text
@luna como funciona o fluxo de faturamento?
```

Nesse caso, o agente deverá:

1. Identificar o perfil `@luna`;
2. Garantir que o repositório local esteja clonado e atualizado;
3. Montar um prompt interno para o Claude Code;
4. Instruir o Claude a ler os arquivos locais do projeto;
5. Analisar o fluxo solicitado no código;
6. Retornar uma resposta simples, clara e acessível para usuário final.

Exemplo de resposta esperada:

```text
O fluxo de faturamento funciona assim: primeiro o sistema busca os contratos ativos, depois verifica as unidades consumidoras vinculadas, calcula os valores com base nas regras de consumo/desconto, gera a fatura e registra os boletos vinculados...
```

Também existirá o perfil técnico:

```text
@luna-tec como funciona o fluxo de faturamento?
```

Nesse caso, o agente deverá:

1. Identificar o perfil `@luna-tec`;
2. Garantir que o repositório local esteja clonado e atualizado;
3. Analisar os arquivos locais do projeto;
4. Retornar uma resposta técnica;
5. Citar arquivos, pastas, classes, métodos, models, services, jobs, controllers, queries ou fluxos internos encontrados;
6. Explicar a arquitetura e os pontos relevantes do código.

Exemplo de resposta esperada:

```text
Tecnicamente, o fluxo de faturamento inicia no arquivo `models/invoice.py`, no método `action_generate_invoice`, que chama o service `billing_service.py`. O cálculo considera os campos `contract_id`, `consumer_unit_id`, `discount_percent` e grava os dados no model `invoice.client`...
```

## Regras obrigatórias do agente

O agente **wattio-Luna** deverá seguir estas regras:

1. Nunca inventar fluxos, regras ou comportamentos.
2. Sempre basear a resposta no código local analisado.
3. Quando possível, citar os arquivos analisados.
4. Se não encontrar a informação no código, informar claramente.
5. Não modificar arquivos do repositório.
6. Não executar commits.
7. Não abrir pull requests.
8. Não executar comandos destrutivos.
9. Não apagar arquivos.
10. Não alterar branches sem autorização.
11. Não expor tokens, secrets ou variáveis sensíveis.
12. Não retornar trechos sensíveis como senhas, chaves ou credenciais.
13. Diferenciar claramente respostas para usuário final e respostas técnicas.

## O que eu quero que você entregue

Estruture uma proposta técnica completa e implementável contendo:

1. Arquitetura geral da solução;
2. Fluxo da requisição até a resposta;
3. Estrutura sugerida de pastas;
4. Exemplo de `docker-compose.yml`;
5. Exemplo de `Dockerfile`;
6. Exemplo de API backend;
7. Estratégia para clonar o repositório;
8. Estratégia para atualizar o repositório com segurança;
9. Como configurar credenciais Git de forma segura;
10. Como instalar Claude Code dentro do container;
11. Como executar Claude Code apontando para o diretório local do projeto;
12. Como montar o prompt interno;
13. Como diferenciar `@luna` e `@luna-tec`;
14. Como capturar a resposta do Claude Code;
15. Como retornar a resposta via API;
16. Cuidados com concorrência entre múltiplas requisições;
17. Controle de timeout;
18. Controle de logs;
19. Controle de permissões do container;
20. Estratégias para impedir alteração dos arquivos;
21. Cuidados de segurança;
22. Limitações técnicas;
23. Melhorias futuras.

## Premissas técnicas

* O projeto será executado via Docker Compose.
* O repositório será clonado localmente.
* O Claude Code deverá analisar a pasta local do projeto.
* O repositório poderá ser atualizado com `git pull`.
* O código analisado deverá ficar em um volume Docker.
* A API deverá ser autenticada.
* O container deverá ter permissões mínimas.
* O Git deverá usar token somente leitura.
* O Claude não deve ter permissão para alterar o repositório.
* As respostas devem ser síncronas inicialmente.
* Futuramente poderá existir fila assíncrona para análises longas.

## Exemplo de comportamento desejado

Entrada:

```json
{
  "message": "@luna como funciona o fluxo de faturamento?"
}
```

Saída:

```json
{
  "agent": "luna",
  "mode": "user",
  "answer": "O fluxo de faturamento funciona da seguinte forma..."
}
```

Entrada:

```json
{
  "message": "@luna-tec como funciona o fluxo de faturamento?"
}
```

Saída:

```json
{
  "agent": "luna-tec",
  "mode": "technical",
  "answer": "Tecnicamente, o fluxo inicia no arquivo..."
}
```

## Objetivo final

Quero uma solução prática, segura e implementável para criar o agente **wattio-Luna**, capaz de responder perguntas sobre nosso código-fonte usando **Claude Code dentro de Docker**, analisando um **repositório clonado localmente**, com respostas em dois níveis:

* `@luna`: linguagem simples para usuário final;
* `@luna-tec`: linguagem técnica para desenvolvedores.
