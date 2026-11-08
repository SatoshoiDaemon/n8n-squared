# Arquitetura-alvo recomendada

## Decisão de base

Começar com uma aplicação Node.js e um processo servidor principal, conservando um processo filho isolado somente para executar código de workflow. Reaproveitar o executor, formatos, tipos de node, credenciais e persistência existentes enquanto forem úteis. Não reescrever o motor antes de medir e remover módulos que não servem ao produto.

O perfil de hospedagem alvo é um ZIP com launcher Node, backend compilado, editor SPA compilado e dependências de runtime necessárias. PostgreSQL externo armazena workflows, execuções, credenciais criptografadas e configurações. Square Blob é o destino indicado para binários e arquivos que precisam sobreviver à reinicialização. A chave de criptografia é estável entre deploys.

## Diagrama

~~~mermaid
flowchart LR
  U[Usuário e API] --> H[Servidor HTTP Node]
  H --> E[Editor Vue compilado]
  H --> W[API, webhooks e saúde]
  W --> O[Orquestrador de workflows]
  O --> X[Executor de nodes]
  X --> R[Runner isolado para Code]
  O --> P[(PostgreSQL persistente)]
  X --> S[Nodes core e opt-in]
  S --> SQ[Square Applications]
  S --> BL[Square Blob]
  S --> AI[Square AI Gateway]
  S --> DG[Discord Gateway]
  DG --> EV[(Eventos duráveis no PostgreSQL)]
~~~

## Estrutura de referência

Esta é uma estrutura lógica de destino, não uma instrução para mover todo o monorepo agora:

~~~text
src/
  main.ts
  app/
    config.ts
    composition.ts
    shutdown.ts
  http/
    server.ts
    api/
    webhooks/
    health/
  workflows/
    model/
    expressions/
    execution/
    lifecycle/
  persistence/
    postgres/
    migrations/
    execution-data/
  nodes/
    registry/
    core/
    square-cloud/
    discord/
  integrations/
    square-cloud/
      applications.ts
      blob.ts
      ai-gateway.ts
    discord/
      gateway.ts
      connections.ts
      event-repository.ts
  scheduling/
  assets/
    editor/                 # artefato compilado do editor
frontend/
  editor-ui/                # aplicação Vue existente, compilada em assets/editor
deploy/
  start.cjs
~~~

## Inicialização

Um único caminho local e hospedado deve carregar configuração, abrir PostgreSQL, executar migrações, registrar módulos selecionados, iniciar o runner e expor HTTP, webhooks, health checks e assets do editor. O launcher local pode receber variáveis de porta e diretório; o mesmo bootstrap deve ser exercitado pelo smoke de ZIP.

Manter o runner isolado enquanto o node Code for suportado. Configurar limites de processo em função do total de RAM da aplicação, e não só do heap do processo principal. O servidor e o runner usam a mesma cota administrada pela plataforma.

## Nodes e extensões

Dividir o conjunto entregue em:

- Core: gatilhos manual e webhook, Schedule, HTTP Request, Code isolado, IF/Switch/Merge, campos/dados e primitives de execução.
- Squared: Square Applications, Blob e AI Gateway, publicados como nodes com credenciais e documentação próprias.
- Discord: adapter de bot, evento e trigger de workflow, reaproveitando o Gateway atual do Agents em vez de abrir uma segunda conexão.
- Pacotes opt-in: nodes de provedores externos que usuários realmente habilitem, com política de instalação/atualização compatível com o armazenamento persistente da hospedagem.

O registry resolve os metadados do node no editor e só importa sua implementação durante a execução. Um índice de nodes disponíveis pode ser compilado a partir dos pacotes habilitados. A lista reduzida do artefato precisa preservar os nodes usados pelos workflows padrão do Squared.

## Discord e durabilidade

Reusar DiscordGateway e DiscordIntegration do módulo Agents. A integração já mantém conexões longas, trata liderança, pausa, retomada e reconexão. Ampliar a mesma conexão para eventos de workflow, sem duplicar o cliente Gateway.

As sessões e sockets ficam em memória; não são uma fila durável de eventos. Para garantir eventos após reinício, salvar mensagens recebidas com ID Discord, bot, workflow de destino, estado de entrega e data no PostgreSQL, com deduplicação por ID Discord. Usar polling simples do banco ou o scheduler existente; adicionar Redis ou outro serviço somente se a carga demonstrar necessidade. A entrega precisa definir explicitamente retry, ack e política de retenção.

## Integrações Square Cloud

- Applications: operações de consulta e controle que a API autorizada permitir, por nodes claros e chamadas HTTP com timeout e erros compreensíveis.
- Blob: provider para upload/download e referências de binary data com chave persistente no workflow; não tratar o diretório local do container como armazenamento durável.
- AI Gateway: provider de modelos que usa os modelos, autenticação e limites oferecidos pela Square. As credenciais vêm do ambiente e não entram em workflow exportado.

Cada integração deve compartilhar um client pequeno com autenticação, timeout e tratamento de resposta. Evitar nova camada de filas ou um serviço separado por API.

## Editor e identidade

Manter Vue/Vite, editor visual, i18n, temas light/dark/system e os módulos de edição necessários. Retirar componentes de venda, pesquisa e tracking comercial do manifesto e das rotas. Primeiro entregar PT-BR para telas de primeira execução, editor, credenciais, erros e configurações; ampliar traduções depois.

O frontend permanece um build separado porque precisa de Vite e assets do browser. O backend não precisa carregar o código-fonte Vue no processo. Manter uma lista de módulos de frontend explícita para assegurar que só o que tem rota e função Squared chegue ao bundle.

## Distribuição e build

O ZIP já é o formato adequado e o launcher já executa com Node. Reutilizar a composição do CLI enquanto ela fornecer migração, saúde, APIs e ciclo de vida. Filtrar o build pelas dependências necessárias ao pacote n8n e pelo editor, em vez de executar tarefas de todos os workspaces sem necessidade. O arquivo deve trazer seu lockfile de produção, patches usados e manifesto com bytes e hash.

Uma consolidação gradual em src/ só começa depois de definir o runtime closure final. Diretórios de build, teste, SDK e authoring podem continuar no monorepo sem serem instalados pelo usuário.
