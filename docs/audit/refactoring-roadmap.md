# Roadmap de reconstrução

Prioridades foram escolhidas pelo benefício ao produto e pela dependência entre mudanças. Impacto de RSS continua uma hipótese até o benchmark de [runtime-performance.md](runtime-performance.md).

| Fase | Mudança | Impacto | Esforço | Dependências e critério de saída |
|---|---|---|---|---|
| 0. Correção de manifesto | Mover @n8n/typescript-config de dependencies para devDependencies em @n8n/nodes-langchain | Baixo em ZIP/dependências; RSS desprezível | Baixo | Confirmar build do pacote e empacotar novamente; pacote de configuração não é necessário em produção. |
| 0. Baseline | Instalar/buildar via versão Node suportada, medir artefato limpo, boot, árvore de processos e RSS em PostgreSQL de teste | Alto para reduzir risco | Médio | Congelar versão/config/fixture. Guardar RSS do servidor + runner e tamanho/tempo do ZIP. |
| 1. Remoções comerciais | Excluir trialIntroModal, pesquisa NPS e PersonalizationModal; retirar callbacks, stores, APIs, eventos, traduções e dados de questionário sem uso | Médio em UX/manutenção; RSS baixo provável | Baixo-médio | Mapear referências de personalização usadas por templates; definir fallback neutro; validar primeira execução, salvar workflow e navegação. |
| 1. Idioma Squared | Criar locale pt-BR usando o sistema i18n existente | Alto em adequação do produto | Médio | O diretório atual só contém en.json. Cobrir primeiro acesso, editor, credenciais, mensagens de erro e configurações; conferir textos dinâmicos e pluralização. |
| 1. Telemetria | Remover PostHog/RudderStack e feature flags de experimentos comerciais; manter logs, métricas e erro configurável | Médio | Médio | Substituir cada feature gate útil por configuração local. Aguardar benchmark de cold start e editor sem chamada remota. |
| 1. Inicialização única | Fazer root start e launcher Square usarem a mesma função, com porta, host e comando explícitos; manter npm start | Médio para operação | Baixo | Cobrir local, smoke e ZIP pelo mesmo entrypoint. |
| 2. Perfil Square | Definir módulos necessários e defaults de PostgreSQL, runner, concorrência e retenção para 512/1024 MB | Muito alto se medição confirmar | Médio | Fase 0 concluída. Testar limite de execução e heap do runner sem OOM em workflows representativos. |
| 2. Retirar engine-v2 do pacote inicial | Remover dependência runtime e módulos que exigem banco de data plane separado | Médio em ZIP/dependências; RSS de boot provavelmente baixo pois não é default | Médio-alto | Confirmar decisão de produto de aplicação única. Manter os testes da execução v1 e remoção das referências type/runtime exclusivas. |
| 2. Artefato PostgreSQL-only | Não instalar sqlite3 na distribuição Square se o ambiente aceitar apenas PostgreSQL | Baixo-médio em artefato/instalação | Baixo-médio | Ambiente local continua testável com SQLite. Comparar instalação e smoke PostgreSQL antes de publicar. |
| 3. Nodes por pacotes | Separar core, Square, Discord e provedores opt-in; gerar índice de nodes do perfil empacotado | Alto em tamanho/dependências, médio em manutenção | Alto | Fase 0 e inventário de workflows do Squared. Cada node removido precisa ter plano para workflows que o referenciam. |
| 3. Square Blob | Implementar provider de binary data que persiste em Blob, guardando referências no PostgreSQL | Alto em durabilidade e uso de DB | Médio | Definir credencial, limite/tamanho, limpeza e reconciliação de objetos; não introduzir worker extra antes de medir. |
| 3. Square Applications e AI Gateway | Criar nodes/credentials/client para APIs nativas | Alto em adequação do produto | Médio | Obter contrato de API e operações suportadas pelo ambiente; testar limites, timeout e erros. |
| 3. Discord de workflows | Generalizar o Gateway existente e conectar eventos a triggers com persistência e deduplicação | Alto para bots e eventos | Alto | Reusar DiscordIntegration. Definir idempotência, retry, ack, retenção e liderança; não duplicar sockets. |
| 4. Build filtrado | Compilar fechamento de n8n + editor e ignorar workspaces de testes/authoring que não são dependências | Médio em CI e entrega | Médio | Comparar as tarefas atuais (71 registradas) com o build filtrado e executar smoke do ZIP. |
| 4. Consolidar pacotes | Fundir limites internos somente quando restarem poucos domínios e benefício mensurável; mover backend residual para src/ | Médio em manutenção; efeito de RSS não presumido | Alto | Fases 2–3 estabilizadas. Cada fusão preserva import boundaries úteis e não cria camada substituta por hábito. |
| 5. Metas de memória | Publicar perfis de carga com teto de RSS, concorrência e capacidade de workflows | Muito alto para hospedagem | Médio | Repetir benchmark no ambiente Square ou ambiente container equivalente; aceitar 512 MB e 1024 MB apenas com margem e sem OOM. |

## Remoções imediatas de baixo risco

- Remover o trial/upgrade modal; seus 9 arquivos têm aproximadamente 1.984 linhas, incluindo testes.
- Remover a store de NPS (138 linhas) e os listeners anexados ao evento saved:workflow.
- Remover a pesquisa de perfil (aproximadamente 662 linhas no componente) e o disparo ligado à conta; fazer templates funcionarem sem as respostas.
- Remover analytics/experimentos de PostHog usados só para promoção. Manter feature útil que hoje dependa da mesma flag, controlada localmente.
- Desabilitar por perfil nodes/serviços não utilizados somente depois de classificar workflows nativos do Squared. Não apagar fixtures Docker empregadas por testes ativos.

## Simplificações estruturais

1. Um launcher para start local e Square.
2. Lista de módulos Square explícita; manter funções como auth, workflows, webhooks, scheduling, executions e node registry.
3. Cotas de execução e runner ajustadas à memória contratada.
4. PostgreSQL para dados duráveis e Square Blob para binários; SQLite apenas em dev/teste se necessário.
5. Build de deploy filtrado por dependências do servidor e assets do editor.

## Consolidações e substituições

- Consolidar instruções de startup e diretório/porta.
- Substituir integrações de IA voltadas a billing/provider n8n por gateway Square onde a API cobrir o caso.
- Substituir armazenamento local por Square Blob para binários persistentes.
- Consolidar Discord Agents e triggers de workflow sobre o mesmo adapter Gateway.
- Só fundir packages em src/ após as remoções e o fechamento de produção estarem estáveis; a separação por pacote atualmente ajuda testes e build incremental e não causa RSS por si só.

## Etapas para comprovar 512–1024 MB

1. Registrar baseline do parent e runner em repouso.
2. Limitar workflow concurrency e runner concurrency independentemente; escolher valores por cota.
3. Medir heap e RSS em workflow curto, workflow de dados grandes, Code e IA.
4. Repetir sem PostHog e com módulos mínimos, atribuindo diferenças por mudança.
5. Repetir com nodes/provedores reduzidos.
6. Fazer smoke e reinício no ambiente Square com PostgreSQL externo e persistência de Blob. O benchmark local não prova o comportamento de cota hospedada.
