# Runtime de pacotes n8n

## Carregamento e execução

Squared descobre pacotes pelo `package.json` (`n8n.nodes` e `n8n.credentials`) e pelos arquivos auxiliares publicados. Esses JSON não são tratados como implementações. Quando um workflow usa um tipo, o registro resolve e importa o módulo `.node.js` original e escolhe o `typeVersion` solicitado, incluindo versões de `VersionedNodeType`.

O carregamento JavaScript continua sob demanda: descobrir o catálogo não importa todas as classes. Descrições completas vêm da classe real em `GET /api/node-types/:type/description`; o inventário autenticado está em `GET /api/node-types`. Um node só aparece como validado depois de uma execução real aprovada, não apenas por carregar sua classe.

Workflows com `connections` passam pelo executor de grafos TypeScript integrado à fila e ao histórico de execuções do Squared. Workflows nativos sem conexões continuam no executor legado. O runtime dá suporte a inputs e outputs numerados, canais de dados não-main, `supplyData()`, `pairedItem`, parâmetros e expressões usadas nos cenários, helpers de contexto, dados estáticos persistidos, espera e retomada, dados binários persistidos, retries, triggers, polling e webhooks. O node oficial `Code` inicia o `JavaScriptSandbox` publicado nos modos all-items e each-item, passa inputs/helpers do contexto e serializa os itens de saída no limite do task runner.

## Instalação persistente

O registro usa `SQUARED_N8N_PACKAGES_DIR`; o padrão é `squared-data/n8n-nodes/node_modules`. O runner de CI instala versões pinadas e compatíveis de `n8n-nodes-base`, `@n8n/n8n-nodes-langchain`, `n8n-core` e `@n8n/backend-common` e inclui um seed de pacotes no ZIP de deploy. No primeiro boot, o instalador extrai o seed para a pasta persistente sem consultar o registry; reinício reutiliza a instalação. Em um redeploy, o pacote já persistido é mantido, ou o novo seed o repõe caso a pasta não exista. Dependências adicionais em desenvolvimento são instaladas sem remover as que já existem.

Para reproduzir a instalação em desenvolvimento:

```powershell
npm run n8n:install
$env:SQUARED_N8N_PACKAGES_DIR = (Resolve-Path 'squared-data/n8n-nodes/node_modules').Path
npm run compatibility:validate
```

O instalador também é executado pela inicialização normal da aplicação. Os testes verificam extração do seed, pin de versões, instalação idempotente e preservação da árvore existente. Pacotes comunitários podem compartilhar o catálogo quando seus manifests publicam `n8n.nodes`; tipos que colidem, caminhos fora do pacote e arquivos `.ee.node.js` são recusados.

## Contratos integrados

A fachada de execução fornece dados de entrada e parâmetros, node/workflow, modo, IDs e configurações de execução, credenciais do vault, contexto global/node, dados estáticos, resolução de expressões e helpers de itens e binários. O motor preserva `pairedItem` e canais entre nodes, incluindo AI via `supplyData()`. A operação `Wait` persiste estado e retomada no storage. O scheduler restaura workflows ativos no início, ativa e desativa triggers, agenda polling, encaminha eventos para a fila de execução e fecha recursos ao desligar.

O adaptador HTTP cobre métodos, headers, query, JSON/form/multipart, timeout, redirects, respostas JSON/texto/binárias, status de erro, resposta completa e paginação usada pelos nodes testados. Autenticação suporta definições declarativas genéricas e específicas por node, OAuth1 HMAC-SHA1 e OAuth2 com renovação de token gravada novamente no vault cifrado. Atualizações de credenciais usam a persistência existente do Squared.

`Webhook` invoca a classe oficial e registra os caminhos/métodos descritos pela classe ao ativar o workflow; desativar, remover ou editar reconcilia as rotas. GET/HEAD/POST/PUT/PATCH/DELETE aceitam parâmetros de caminho e criam histórico da execução. Autenticação de entrada Basic/Header consulta o vault cifrado. `trigger()` e `poll()` são reconciliados pelo scheduler; triggers ativos são registrados novamente após reinício. O scheduler respeita `pollTimes` e usa 60 segundos quando o node não declara intervalo. Waits de tempo retomam automaticamente, e waits que permitem retomada manual aceitam `POST /api/executions/{id}/resume`. Os pacotes oficial base e LangChain são carregados do armazenamento persistente, sem copiar credenciais da instalação n8n de referência.

## Evidência atual e limites

O snapshot de referência contém 569 tipos: 444 no pacote base e 125 no LangChain. A matriz atual registra 567 classes carregadas, configuráveis e com adapter resolvido; 49 tipos passaram por cenários reais em 69 execuções com os pacotes publicados `n8n-nodes-base@2.42.5` e `@n8n/n8n-nodes-langchain@2.42.5`. Esta rodada acrescenta `Basic LLM Chain` v1.3 e o contrato para conexões AI opcionais desconectadas. A descoberta completa não valida todas as operações: somente as versões/operações registradas têm evidência de execução. Veja [a matriz](compatibility-matrix.md), [a evidência por cenário](compatibility-runtime-results.json) e [o resumo de compatibilidade](n8n-compatibility.md).

Os casos validados usam fixtures locais: HTTP e OAuth contra servidor local; RSS por servidor local; webhook e Interval pela fila/serviço Squared; credenciais sintéticas. `NPM` cobre uma operação declarativa com autenticação; `Character Text Splitter` cobre `supplyData()` sem depender de serviço de LLM. O `Code` validado cobre JavaScript e `$input`/`$json`; Python, o proxy completo de dados do workflow e módulos externos ainda não estão configurados. Ainda não há validação de todos os nodes LangChain, OAuth1 em serviços externos, OAuth interativo de primeira autorização, JWT para webhooks, registro remoto por `webhookMethods`, `Respond to Webhook` ou todos os eventos/hooks especializados. O resolvedor de expressões e os helpers ainda implementam um subconjunto dos contratos de n8n. Código de node executa no mesmo processo do Squared; o diretório persistente não é sandbox para código hostil. Não foi feita comparação diferencial contra uma instalação n8n de referência.

## Testes e matriz

```powershell
$env:SQUARED_N8N_PACKAGES_DIR = (Resolve-Path 'squared-data/n8n-nodes/node_modules').Path
npm run compatibility:validate
npm run compatibility:matrix
npm test
npm run typecheck
```

`compatibility:validate` executa workflows determinísticos contra classes instaladas e grava `compatibility-runtime-results.json`. A geração da matriz combina essa evidência com os manifests descobertos. Tipos não exercitados continuam descobertos ou carregados, e falhas incluem o método/contrato faltante quando identificado.

## Licenças

O adaptador e o motor Squared são código original. O seed de deploy contém pacotes publicados do n8n e dependências com seus próprios termos e avisos de licença; arquivos `.ee.` não são carregados. O seed mantém os arquivos de licença incluídos por cada pacote e não relicencia essas dependências. Nodes comunitários mantêm as licenças declaradas por seus autores.
