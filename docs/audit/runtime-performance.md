# Inicialização, processos e desempenho

## Resultados e limites da medição

| Métrica | Resultado | Origem |
|---|---|---|
| Fechamento de runtime | 46 pacotes internos, 732 declarações de dependência, 333 nomes externos distintos | Recálculo dos manifestos, reproduzível por scripts/audit/runtime-closure.mjs. |
| ZIP | 80.834.428 bytes | Medição anteriormente registrada em docs/squared/foundation-validation.md; não foi reconstruído nesta auditoria. |
| Limite do ZIP | 100.000.000 bytes | scripts/squared/package-squarecloud.mjs. |
| Memória configurada no manifesto | 2048 MB por padrão; mínimo aceito 512 MB | scripts/squared/package-squarecloud.mjs e docs/squared/square-cloud.md. |
| Instalação limpa | 27m02.9s; 3.409 pacotes resolvidos | `corepack pnpm install --frozen-lockfile`, Windows; inclui workspaces e dependências de desenvolvimento. Não representa instalação de produção nem tempo do runtime. |
| Build filtrado de backend + editor | 27m16.891s; 60 tasks concluídas, 61 no total; seleção de 71/87 workspaces | `turbo run build --filter=n8n... --filter=n8n-editor-ui...`; falhou na task `n8n` ao gerar/bundlar OpenAPI. Test utilities e outras dependências de desenvolvimento ainda aparecem na seleção. |
| RSS de runtime e boot/readiness | Sem benchmark válido nesta auditoria | O build não produziu um artefato completo e executável; não há amostras comparáveis de processo principal + runner. O smoke anterior valida comportamento, mas não registra duração ou memória. |
| Processo de geração de metadados durante build | Um Node chegou a 510.152.704 bytes de working set observado | Amostra isolada no Windows durante geração de metadados LangChain; é memória transitória de build, não RSS do Squared em execução nem soma de processos. Não usar contra a meta de hospedagem. |

O valor de 2048 MB não prova consumo de 2 GB, e o ZIP de 80,8 MB não prevê RSS. O tamanho de arquivos e o número de dependências são indicadores de distribuição e manutenção, não economias de RAM.

O build padrão primeiro parou sem executar tasks porque o Turbo não conseguiu chamar o shim `pnpm.exe` do NVM (`CommandNotFound`). Com um wrapper temporário fora do repositório, a execução filtrada compilou as dependências até a etapa `packages/cli/scripts/build.mjs:153`, quando `redocly` escreveu os dois bundles OpenAPI e o Node 24.19.0 no Windows abortou com `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` em `src/win/async.c:94`. A tentativa isolada posterior de `build:data` não publicou resultado de conclusão; não houve outra tentativa após a instrução para interromper builds. O artefato incompleto não foi usado para medir runtime.

## O que o código inicia

### Processos

1. O processo principal inicia por deploy/squarecloud/start.cjs e packages/cli/bin/n8n.
2. O comando start define needsTaskRunner=true. O padrão de N8N_RUNNERS_MODE é internal; TaskRunnerModule cria um processo Node filho para executar tarefas JavaScript com isolamento.
3. O módulo também verifica se o runner Python está disponível. O processo Python só é iniciado se os requisitos forem atendidos.
4. O runner JavaScript recebe N8N_RUNNERS_MAX_CONCURRENCY. O padrão atual é 10. N8N_RUNNERS_MAX_OLD_SPACE_SIZE fica sem limite explícito se não configurado.

Portanto, no caminho padrão em modo internal, o piso observado no código é um servidor Node e um runner Node. Isso é uma conclusão estática do fluxo de inicialização; a quantidade real de PIDs não foi capturada em uma execução do Squared nesta auditoria. A separação do runner protege a aplicação de código do usuário e não deve ser removida apenas para reduzir a contagem de processos.

### Concorrência

O limite de concorrência de workflows de produção e de avaliação usa -1, que significa ilimitado. Junto ao runner com limite 10, esse conjunto não oferece uma barreira previsível para 512–1024 MB. O pico depende de dados de workflow, execução de Code, nodes de rede, respostas de API, tamanho de itens binários e quantidade de execuções simultâneas.

Para o primeiro perfil Square, testar limites de 1 e 2 para produção e para o runner. Medir com workflows representativos antes de escolher o default. Um limite único não é adequado para perfis de 512 MB e 1024 MB sem medições.

### Nodes e metadados

LoadNodesAndCredentials usa LazyPackageDirectoryLoader para ler JSON conhecido de nodes/credentials. O código e comentários indicam que classes são resolvidas depois, e que descrições podem ser liberadas depois de coletadas. O catálogo JSON ainda precisa ser percorrido e mantido; isso pode compor o pico de inicialização.

Implicação: retirar classes não usadas pode reduzir ZIP, dependências instaladas e heap de módulos efetivamente importados. Porém, o loader já evita importar a implementação de todos os nodes em cada execução. Uma economia de RSS não pode ser calculada pelo total de pastas removidas.

### Serviços inicializados

- BaseCommand inicializa o ErrorReporter, o event bus, PostHog, TelemetryEventRelay e outros relays. PostHog e TelemetryEventRelay também são iniciados em comandos CLI que não precisam servir o editor.
- Start solicita o motor de expressão com poolSize 1, inicia o task runner, módulos, banco e migrações.
- O runtime inicia pruning de execuções, compactação de histórico, rollup de estatísticas, tarefas duráveis e ativações de workflows.
- A lista ModuleRegistry tem 32 módulos padrão. Importar a classe de módulo, coletar entidades, inicializar serviços licenciados e carregar suas implementações são etapas diferentes; só medir cada etapa mostra o custo de cada feature.
- Start gera assets com streams no disco para substituir variáveis do HTML/CSS/JS. O editor executa no browser e não constitui heap Vue residente no processo Node.

## Gargalos identificados e hipóteses

| Prioridade | Achado | Efeito provável | Como validar |
|---|---|---|---|
| Alta | Concorrência de workflow ilimitada e runner com máximo 10 | Pico de memória cresce com execuções ativas e itens retidos; não é seguro assumir o perfil 512 MB | Comparar RSS agregado dos processos com limites 1, 2 e 4, em workflows curtos e Code/IA. |
| Alta | Runner interno cria segundo processo e deixa heap sem cap explícito | Soma de dois heaps/native RSS; o limite só pode ser escolhido com memória do pai e do filho | Registrar RSS por PID e somar. Definir N8N_RUNNERS_MAX_OLD_SPACE_SIZE junto da cota medida. |
| Média | PostHog e telemetria de produto inicializam no BaseCommand | Importações, estado e tráfego externo sem necessidade para fluxo de execução | Remover analytics em uma build comparável; medir cold start e RSS com instrumentação de processo. |
| Média | 32 módulos default mais módulos explicitamente habilitados | Mais imports, entidades, rotas e timers quando licenciados/ativos | Construir perfil Square mínimo e comparar logs de módulos, tempo e RSS. |
| Média | 333 nomes de dependências externas declaradas no fechamento | ZIP e instalação hospedada grandes; uma dependência só consome heap se carregada | Analisar importações runtime e pacotes de nodes opt-in; comparar ZIP, install time e RSS. |
| Média | SQLite está incluído embora a orientação Square use PostgreSQL externo | Aumenta instalação e pode trazer addon nativo; efeito de RSS depende de import condicional | Fazer build PostgreSQL-only em diretório limpo e comparar bytes, instalação e RSS. |
| Baixa | Build raiz executa Turbo sem filtro; histórico registra 71 tarefas | Aumenta tempo e máquina de release, não memória hospedada | Build de deploy filtrado por n8n e pelo editor, comparando tarefas e artefato. |
| Baixa | ZIP histórico já ocupa 80,8 MB de 100 MB | Pouca margem para adicionar integrações Square e builds de assets | Acompanhar bytes por pacote e remover providers/nodes sem uso antes de adicionar novas dependências. |

## Benchmark reproduzível recomendado

Executar no mesmo Node principal de produção (Node 24), em pasta de dados nova, com PostgreSQL persistente de teste, assets compilados e o mesmo perfil de configuração do artefato. Medir cada PID e a soma do RSS a cada segundo.

| Perfil | Execuções | Node types | Concorrência a comparar | Duração |
|---|---:|---|---|---|
| Base | 0 workflows ativos | Registry padrão | runner 1, workflows 1 | 15 min após readiness |
| HTTP | 1 webhook e retorno pequeno | Webhook + HTTP Request | 1 e 2 | 100 execuções |
| Dados | transformação de itens grandes | Code + Edit Fields + Merge | 1 e 2 | 20 execuções |
| IA/Discord | uma sessão Gateway e uma chamada de modelo | Agents + Discord + gateway | 1 | 15 min e reconexão do bot |

Registrar: boot até /healthz/readiness, RSS máximo e mediano de pai e runner, heapUsed, external, contagem de processos, execução por segundo, erro/timeout, bytes de ZIP e bytes de instalação. Em seguida repetir com PostHog removido, módulos mínimos e pacote de nodes reduzido, uma mudança por vez. Usar a mesma base e dados vazios em cada comparação. Guardar comandos, configuração e saídas para comparar perfis de 512 e 1024 MB.

## Etapas para as metas de memória

1. Fixar o caminho único de start e a configuração PostgreSQL persistente.
2. Instrumentar pai e runner antes de alterar heap ou loader.
3. Definir limites de execução e de heap por perfil, validando throughput e reinicialização por OOM.
4. Desabilitar analytics remoto e módulos que não atendem o perfil Square; repetir o benchmark.
5. Reduzir providers e nodes incluídos no artefato; medir separadamente tamanho, instalação, boot e RSS.
6. Tratar 512 MB como perfil de carga reduzida e 1024 MB como perfil padrão somente se os testes sustentarem o limite de cada um. Até então, não publicar redução do MEMORY como capacidade comprovada.

## Âncoras de código verificadas

- [Start ativa community packages, expression engine e task runner](../../packages/cli/src/commands/start.ts#L70-L74); [BaseCommand faz o bootstrap condicional do runner e do engine](../../packages/cli/src/commands/base-command.ts#L242-L261).
- [Config do runner deixa o heap sem teto explícito e define concorrência 10](../../packages/@n8n/config/src/configs/runners.config.ts#L41-L45); [limites de workflows são -1](../../packages/@n8n/config/src/configs/executions.config.ts#L26-L30); [pool de expressão é 1](../../packages/@n8n/config/src/configs/expression-engine.config.ts#L36).
- [ModuleRegistry lista módulos padrão e acrescenta módulos habilitados](../../packages/@n8n/backend-common/src/modules/module-registry.ts#L44-L92).
- [LoadNodesAndCredentials coleta e libera descrições](../../packages/cli/src/load-nodes-and-credentials.ts#L143-L169), mantendo implementação de nodes sob carregamento lazy.
- [O empacotador Square parte de n8n e percorre dependencies/optionalDependencies](../../scripts/squared/package-squarecloud.mjs#L22-L39); [o manifesto de memória começa em 2048 MB](../../scripts/squared/package-squarecloud.mjs#L55).
