# Inventário arquitetural do n8n-squared

## Escopo e método

Esta leitura cobre os manifestos dos workspaces, os caminhos de inicialização, a execução e o carregamento de nodes, a composição do editor, os módulos de backend e o empacotamento Square Cloud. A árvore deriva do snapshot n8n 2.42.7 indicado em [UPSTREAM.md](../../UPSTREAM.md); a configuração Git local, porém, contém apenas o remoto origin, não o remoto upstream mencionado nesse documento.

Os números abaixo distinguem manifestos, dependências declaradas, arquivos do artefato e memória residente. Contar dependências não mede módulos carregados nem RSS. O fechamento de produção foi recontado a partir de dependencies e optionalDependencies dos manifestos, pela mesma regra usada em [package-squarecloud.mjs](../../scripts/squared/package-squarecloud.mjs).

## Tamanho e fechamento de produção

| Medida | Resultado | Interpretação |
|---|---:|---|
| Manifestos package.json em packages | 94 | Inclui 7 manifestos de templates de nodes que não são workspaces. |
| Projetos vistos por pnpm -r | 88 | Inclui o manifesto raiz; são 87 pacotes de workspace. |
| Pacotes internos no fechamento de n8n | 46 | O empacotador percorre dependencies e optionalDependencies de n8n. |
| Arestas de dependência declaradas nesses 46 pacotes | 732 | Soma de dependências diretas declaradas, incluindo links internos. |
| Nomes externos distintos declarados nesse fechamento | 333 | Não equivale a 333 pastas físicas instaladas; transitivas, peers e deduplicação alteram a instalação. |
| ZIP histórico registrado | 80.834.428 bytes | Medição documentada em [foundation-validation.md](../squared/foundation-validation.md), não refeita nesta auditoria. |
| Limite aplicado pelo empacotador | 100.000.000 bytes | Restavam cerca de 19,2 MB de margem no ZIP histórico. |

O pacote raiz define Node.js >=24 e pnpm 12.4.2. O editor declara versão 2.42.5 enquanto a aplicação declara 2.42.7; confirme se a divergência é intencional antes de publicar a próxima versão.

O inventário reproduzível está em [runtime-closure.mjs](../../scripts/audit/runtime-closure.mjs). Ele mostra o fechamento interno e os totais calculados pelos manifestos sem depender de node_modules.

## Pacotes e responsabilidades

### Fechamento de runtime

| Grupo | Pacotes representativos | Responsabilidade e relação |
|---|---|---|
| Aplicação e execução | n8n, n8n-core, n8n-workflow, n8n-nodes-base | CLI/API, executor de nodes, tipos e formato de workflow, credenciais e nodes comuns. São o núcleo a preservar. |
| Persistência e base de backend | @n8n/db, @n8n/typeorm, @n8n/config, @n8n/di, @n8n/decorators, @n8n/backend-common, @n8n/backend-network, @n8n/backend-services, @n8n/constants, @n8n/errors, @n8n/utils | Configuração, banco, registro de módulos, serviços HTTP, injeção de dependências e contratos transversais usados pelo CLI e pelo motor. |
| Expressões e agendamento | @n8n/expression-runtime, @n8n/scheduler, @n8n/task-runner, @n8n/tournament | Expressões, tarefas duráveis, sandbox de código e coordenação de execução. O task runner interno é um processo filho do servidor. |
| IA e conversação | @n8n/agents, @n8n/ai-node-sdk, @n8n/ai-utilities, @n8n/ai-workflow-builder, @n8n/instance-ai, @n8n/chat-hub, @n8n/n8n-nodes-langchain, @n8n/mcp-apps, @n8n/mcp-browser | Nós, agentes, integrações de chat, MCP e funções de IA. São capacidades reais, mas o conjunto de provedores é grande e pode ser reduzido ou dividido em pacotes. |
| Tipos, blob e transporte | @n8n/api-types, @n8n/blob-storage, @n8n/client-oauth2, @n8n/imap, @n8n/json-schema-to-zod, @n8n/node-engine-compatibility, @n8n/permissions, @n8n/syslog-client, @n8n/telemetry | Contratos públicos, armazenamento binário, OAuth, validação, compatibilidade e observabilidade. O pacote de blob não implementa integração nativa Square Cloud. |
| UI e dependências referenciadas pelo backend | n8n-editor-ui, @n8n/composables, @n8n/design-system, @n8n/frontend-constants, @n8n/frontend-utils, @n8n/i18n | O editor é compilado como SPA. Os assets são servidos pelo CLI; isso não significa que o Node carregue os componentes Vue como módulos de runtime. |
| SDK e pacotes referenciados pelo runtime | @n8n/workflow-sdk, @n8n/tournament, @n8n/engine | O workflow SDK é usado por serviços MCP/IA e pelo catálogo; tournament é usado por avaliação de expressões. @n8n/engine sustenta a via opcional engine-v2 e não é o executor padrão iniciado por start. |

`@n8n/typescript-config` também aparece nos 46 pacotes do fechamento calculado, mas não é runtime: `packages/@n8n/nodes-langchain/package.json` declara-o em `dependencies`, embora ele contenha somente arquivos JSON de configuração TypeScript. É um vazamento de manifesto que deve ser movido para `devDependencies` e removido do ZIP de produção; isso não é uma economia de RSS presumida.

Os outros pacotes de workspace concentram ferramentas de desenvolvimento e teste: pacotes em packages/testing, benchmark, containers, Playwright, geradores de nodes, SDKs, configurações de lint/TypeScript, Storybook, extensões e módulos de frontend. Eles não entram automaticamente no ZIP: só um caminho de dependência a partir de n8n os inclui. Sete manifestos de exemplos em packages/@n8n/node-cli/src/template/templates são modelos publicados pelo gerador, não pacotes instalados no workspace.

As dependências diretas declaradas são grandes nos agregadores: packages/cli/package.json declara 158 dependências e optionalDependencies; packages/nodes-base/package.json declara 88; packages/@n8n/nodes-langchain/package.json declara 90. Esses números são manifestos, não uma medição de memória.

## Caminho de inicialização e execução

~~~mermaid
flowchart TD
  A[Square Cloud: start.cjs] --> B[packages/cli/bin/n8n]
  B --> C[CommandRegistry: start]
  C --> D[BaseCommand: config, erro, DB e migrações]
  D --> E[Start: serviços e módulos ativos]
  E --> F[LoadNodesAndCredentials]
  F --> G[n8n-nodes-base: metadados + carregamento lazy]
  F --> H[langchain nodes: metadados + carregamento lazy]
  E --> I[Server: API, webhooks, saúde e assets do editor]
  E --> J[DurableScheduler e workflows ativos]
  C --> K[TaskRunnerModule]
  K --> L[processo filho JS isolado]
~~~

O launcher de produção [start.cjs](../../deploy/squarecloud/start.cjs) define bind e porta, então chama o CLI. A classe Start, em [start.ts](../../packages/cli/src/commands/start.ts), marca o comando como servidor principal e solicita community packages, motor de expressões e task runner. O caminho da execução cria o banco, executa migrações, inicializa módulos elegíveis, gera a cópia estática do editor, inicia o servidor HTTP, agenda tarefas duráveis e ativa workflows.

O código do editor está em packages/frontend/editor-ui e seus pacotes de suporte em packages/frontend/@n8n. O servidor altera index.html e assets JS/CSS por streaming para substituir configuração e caminhos, conforme Start.generateStaticAssets. O browser executa o editor; o processo Node serve os arquivos.

O registro e a execução do workflow usam vários limites de domínio úteis: packages/workflow descreve workflows e nodes; packages/core oferece contexto e execução; packages/cli coordena banco, gatilhos, API e ciclo de vida; packages/nodes-base fornece integrações. Consolidar tudo em um arquivo ou um único módulo não remove a necessidade funcional desses limites.

## Nodes, módulos e extensões

LoadNodesAndCredentials procura n8n-nodes-base e @n8n/n8n-nodes-langchain em caminhos de node_modules, lê metadados gerados e registra loaders. LazyPackageDirectoryLoader carrega arquivos JSON de tipos conhecidos e descrições; a implementação do node é carregada sob demanda. collectTypes e releaseTypes liberam descrições para evitar retenção desnecessária. O comentário em LoadNodesAndCredentials.collectTypes avisa que manter tipos em memória é caro. A leitura de runtime já tem carregamento lazy; cortar nodes não utilizados ainda pode reduzir download, instalação, ZIP e potencial memória de dependências efetivamente importadas.

ModuleRegistry mantém uma lista padrão de 32 módulos e permite N8N_DISABLED_MODULES e N8N_ENABLED_MODULES. Ele importa os wrappers dos módulos elegíveis antes de iniciar o banco, coleta entidades e loaders, e só inicializa cada módulo se a licença e o tipo de instância permitirem. O código de módulos com configurações específicas tende a ser importado dentro de init. Portanto, a lista de módulos não corresponde a 32 serviços necessariamente ativos nem a 32 processos.

## Frontend e identidade

O editor é Vue e Vite, com Design System, composables, stores, cliente REST, i18n e tema. app/modules.manifest.ts declara 12 módulos de frontend, incluindo Insights, agentes, IA, tabelas e Promotions. O comentário do manifesto registra que a lista estática é intencional; componentes de rota podem ser carregados por import dinâmico e o build Vite decide chunks.

O tema light/dark/system existe no ui.store e deve ser mantido. O sistema i18n também existe, mas `packages/frontend/@n8n/i18n/src/locales` contém somente `en.json`; a única ocorrência encontrada de `pt-BR` é um exemplo em inglês na descrição de uma função. A tradução pt-BR ainda precisa ser criada.

## Squared e limites de implantação

O caminho de produção é ZIP, manifesto e launcher em scripts/squared e deploy/squarecloud; não há Docker como caminho de distribuição principal. O empacotador reduz o workspace a 46 pacotes internos, recria lockfile de produção e rejeita artefato acima de 100 MB. O arquivo de produto documenta PostgreSQL externo, chave estável e binary data no banco. A variável de memória do artefato, porém, tem default 2048 MB, não a meta 512–1024 MB.

Fixtures de Docker, Kubernetes, Redis e outros serviços estão em packages/testing e benchmarks. Permanecem úteis para testes e para reproduzir comportamentos; não devem ser confundidas com requisitos do ZIP Square Cloud.

## Integrações que existem e lacunas

- Discord: existe uma integração de Gateway em packages/cli/src/modules/agents/integrations/platforms/discord-gateway.ts. Ela mantém listeners, reinicia sessões, respeita liderança e é usada pelo módulo Agents. O registro persistente da integração é reconciliado pelo serviço de canais de agentes. A sessão/socket em execução continua sendo estado em memória; não há evidência de uma fila durável genérica de eventos Discord para workflows.
- Square Cloud: a busca por referências no runtime não encontrou adaptadores de Applications, Blob ou AI Gateway. O uso de Square está concentrado em empacotamento, deploy e configuração.
- Discord nodes: a capacidade identificada é orientada a chat de Agents. Não foi encontrado um Discord Trigger genérico em packages/nodes-base/nodes.
- Promoção de workflows: packages/cli/src/modules/promotions.ee e o frontend correspondente gerenciam promoção Git entre ambientes. Isso é controle de workflow, não publicidade comercial.
