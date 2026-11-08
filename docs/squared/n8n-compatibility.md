# Compatibilidade com nodes n8n

## Referência e estado

O snapshot upstream é `n8n@2.42.7`; os manifests npm usados aqui são `n8n-nodes-base@2.42.5` e `@n8n/n8n-nodes-langchain@2.42.5`. O catálogo tem 569 tipos: 444 do pacote base e 125 do LangChain.

A matriz foi gerada com módulos npm instalados e registra **30 tipos validados em 39 cenários determinísticos**. Os 25 tipos já validados antes deste trabalho continuam cobertos; cinco novos tipos foram exercitados: `Code`, `Merge`, `Wait`, `Webhook` e `RSS Feed Trigger`. A validação usa as classes publicadas, registra versão/operação/contratos/resultados e não equivale a validar todas as operações de um node. O detalhamento está em [compatibility-matrix.json](compatibility-matrix.json) e [compatibility-runtime-results.json](compatibility-runtime-results.json).

| Estado da matriz | Tipos |
| --- | ---: |
| Descoberto | 569 / 569 |
| Carregado | 30 / 569 |
| Configurável | 30 / 569 |
| Executável | 30 / 569 |
| Validado por cenário real | 30 / 569 |

## Runtime integrado

Workflows no formato n8n passam pelo executor de grafos TypeScript dentro da fila e do histórico de execuções do Squared. A lista linear antiga continua atendendo workflows nativos do Squared. Os pacotes oficiais são carregados sob demanda de `SQUARED_N8N_PACKAGES_DIR`; por padrão, ficam em `squared-data/n8n-nodes/node_modules`, fora do artefato de deploy e no armazenamento persistente.

O runner de CI instala versões compatíveis de `n8n-nodes-base`, `@n8n/n8n-nodes-langchain`, `n8n-core` e `@n8n/backend-common` e inclui um seed verificado no ZIP de deploy. No primeiro boot, Squared extrai o seed para `squared-data/n8n-nodes/node_modules`; reinícios reutilizam essa pasta, e novos deploys repõem os pacotes caso o armazenamento persistente não os tenha. O boot de produção não precisa resolver centenas de dependências no registry. `Merge` v3 e `Wait` carregam as classes oficiais junto com `n8n-core`/`@n8n/backend-common`; não usam implementações substitutas.

O runtime agora cobre execução por versão, portas de entrada e saída, `pairedItem` básico, conexões de dados não-main, `supplyData()`, expressões usadas pelos cenários, dados estáticos persistidos, espera e retomada, binários persistidos por referência, retries, execução de `poll()`, ativação de `trigger()` e chamadas `webhook()`. O servidor e o scheduler registram workflows ativos no início, param triggers ao desativar ou encerrar, fazem polling e retomam execuções após espera.

As classes validadas exercitaram processamento de dados e arquivos, ramificações, dois inputs de `Merge`, persistência de `Wait`, execução JavaScript da classe oficial `Code` em modos all-items e each-item via `JavaScriptSandbox`, Webhook HTTP real com chamada downstream, polling de um RSS local, HTTP Request com autenticação por header/OAuth1/OAuth2 e renovação persistida de token, além de GitHub contra um servidor local. A ativação registra os caminhos e métodos definidos pela classe oficial do Webhook, remove as rotas ao desativar o workflow, encaminha parâmetros de path e valida autenticação Basic/Header pelo provedor do vault. O scheduler honra `pollTimes` (ou usa um intervalo padrão de 60 segundos) para não executar `poll()` a cada ciclo interno de cinco segundos. Nenhuma conta externa foi usada. Nenhuma credencial da instalação n8n de referência foi copiada.

## Credenciais e requests

O provedor resolve IDs ou nomes não ambíguos pelo armazenamento cifrado do Squared e só abre valores durante a execução. Atualizações de tokens OAuth voltam ao vault cifrado. O runtime aplica autenticação genérica declarada e autenticação específica do pacote, OAuth2 com refresh e OAuth1 HMAC-SHA1. Os testes usam apenas credenciais sintéticas.

Os helpers HTTP aceitam métodos, headers, query, bodies JSON/form/multipart, timeout, redirects, resposta JSON/texto/binária, status de erro e resposta completa. A paginação usa as opções do node e o limite por request. Opções de rede que dependem de agent/proxy/socket específicos do n8n ainda não têm equivalência completa.

## Limites conhecidos

- Os 125 tipos LangChain estão descobertos, mas nenhum tipo LangChain está validado com uma classe real. `supplyData()` e conexões AI já têm contrato no executor, porém cadeias/agents reais ainda exigem helpers e objetos específicos do ecossistema.
- Os 30 tipos representam apenas as versões e operações registradas na matriz. Credenciais específicas, opções raras e todas as versões não ficam comprovadas por um cenário.
- `Code` v2 foi validado em JavaScript all-items e each-item com o `JavaScriptSandbox` publicado; o runner Python e a execução em processo isolado do task runner ainda não estão integrados.
- Expressões cobrem um subconjunto seguro de `$json`, `$binary`, `$input`, `$items`, `$node`, `$execution` e `$workflow`; objetos/helpers de expressão do n8n ainda não estão completos.
- A ativação/polling chama os métodos `trigger()`/`poll()` carregados da versão solicitada. O registro HTTP local usa as descrições oficiais de webhook e suporta auth Basic/Header; registro remoto por `webhookMethods`, JWT/OAuth interativo para webhooks, respostas síncronas por `Respond to Webhook`, `onMessage` e hooks especializados ainda precisam ser implementados/testados por família. Waits de tempo retomam pelo scheduler e waits que aceitam retomada manual usam `POST /api/executions/{id}/resume`.
- Código oficial de node roda no mesmo processo do Squared. O diretório persistente não é um sandbox para código hostil.
- Não foi feita execução diferencial contra uma instância n8n de referência. A validação de produção Squared é relatada separadamente após deploy.

## Regenerar e reproduzir

```powershell
$env:SQUARED_N8N_PACKAGES_DIR = (Resolve-Path 'squared-data/n8n-nodes/node_modules').Path
npm run compatibility:validate
npm run compatibility:matrix
npm test
npm run typecheck
```

`compatibility:validate` importa classes do pacote instalado, executa workflows fixtures e grava evidência. `compatibility:matrix` cruza essa evidência com os 569 manifests da árvore de referência. Nodes não exercitados permanecem descobertos, e falhas registram o método ou contrato ausente quando conhecido.
