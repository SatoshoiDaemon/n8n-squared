# Estado da compatibilidade n8n

## Decisão de arquitetura nesta etapa

O Squared ganha uma representação de workflow sem perda de campos, importação/exportação e um executor próprio de grafos em TypeScript. O executor é experimental e não está ligado à execução de produção. O servidor, a fila, SQLite, credenciais cifradas e o editor atual continuam no caminho de produção.

A camada compatível deve usar um host/adaptador com contratos explícitos e versão de node. O catálogo lê manifests e JSONs de descrição, mas nunca importa código de pacote. A implementação não promete executar JavaScript comunitário no processo principal e ainda não oferece um subprocesso seguro e limitado para tal código. A ausência do isolamento e das interfaces de runtime impede marcar nodes como executáveis.

## Formato e execução

`n8n-format.ts` valida o formato JSON exportado, preserva campos não reconhecidos, resolve conexões por nomes de nodes e mantém tipo de canal, índice da saída e índice da entrada. O executor reconhece conexões `main` em grafos acíclicos, múltiplas portas, bifurcações e joins de dados. Só cria conexões implícitas para a sequência legada do Squared. Importar preserva o documento original; duplicar um ID é rejeitado e a criação usa inserção atômica.

O executor TypeScript tem registro de adaptadores por `type` e `typeVersion`, propagação de itens JSON/binário opacos, contextos de execução, resolução de expressões, referências de nodes anteriores, credenciais por ID, retries e opções básicas de continuação de erro. Ele não implementa toda a semântica de agenda, webhook e execução do n8n; `mode` no contexto não instala gatilhos, registra webhooks nem persiste estados. O processo de execução atual continua limitado à lista linear de nodes do Squared.

## Contratos do n8n investigados

A árvore histórica foi consultada como referência em `n8n@2.42.7`. Os manifests locais de `n8n-nodes-base` e `@n8n/n8n-nodes-langchain` são `2.42.5`, portanto o snapshot não representa um único patch coerente nem comprova a versão da instalação online.

Os contratos e subsistemas relevantes encontrados incluem:

- `INodeType` e descrições de nodes: `description`, `execute`, `supplyData`, `trigger`, `poll`, `webhook`, `methods`, `webhookMethods`, `onMessage` e hooks de lifecycle, conforme o tipo.
- `IVersionedNodeType` e seletores de versão: várias versões podem compartilhar código, descrição e migração. A seleção não é equivalente a indexar um único `typeVersion` num registry simples.
- `IExecuteFunctions`: parâmetros por item, input/output, workflow, node, modo e contexto; dados estáticos; subworkflows; estado de execução; checks de credencial; espera/resume; logging; deduplicação; tabelas de dados; e helpers de binary data e sistema de arquivos.
- `IRequestHelper` e `helpers`: requisições HTTP e autenticação genérica/específica, paginação, OAuth, streams, SSH e configurações de rede.
- `ILoadOptionsFunctions`, `IHookFunctions` e contextos de webhook/trigger: opções dinâmicas, credenciais, URLs e lifecycle de gatilhos.
- `INodeExecutionData`, item linking e dados binários: JSON por item, `pairedItem`, metadados de erro e dados binários gerenciados por storage/helpers, que podem ser referências em vez de buffers residentes.
- Credenciais: descrições/versionamento, propriedades secretas, autenticação genérica ou específica, OAuth, e campos internos que os nodes esperam receber pelo contexto de credenciais.
- Expressões: runtime separado com contexto de workflow/execution/node, referências de entrada, itens pareados e helpers auxiliares; não é substituível por simples interpolação de strings.
- Carregamento: manifests e definições compiladas de nodes/credenciais, módulos de pacote e carregamento dinâmico; community packages seguem metadados próprios e importam suas dependências.

O adaptador atual não satisfaz esses contratos completos. Em particular, uma função `execute(context)` que retorna arrays é uma interface interna do Squared, não `IExecuteFunctions`/`INodeType` do n8n. Não vendemos esse adaptador como compatibilidade oficial.

## Expressões, credenciais e binários

O parser de expressões cobre um subconjunto seguro: `$json`, `$binary`, `$input.all/first/last`, `$items("Nome")`, `$node["Nome"]`, `$execution`, `$workflow`, literais, operadores, ternário, acesso seguro a propriedades e alguns métodos comuns. O runtime bloqueia chamadas arbitrárias e acesso a `constructor`/prototype. Ainda faltam APIs de expressão e funções do n8n, Luxon/DateTime, item-linking completo, os objetos de contexto completos e validação diferencial.

Credenciais são resolvidas por ID através do armazenamento Squared e abertas pelo vault existente em memória apenas durante o acesso. Referências só por nome não resolvem; schemas de credencial, tipagem/validação dos campos, métodos de autenticação por node e OAuth não foram conectados. Não foram copiadas credenciais da referência. O executor preserva `binary` como JSON opaco nos itens; ele não implementa o storage de binários do n8n, streaming, conversão nem limites de arquivo.

## Matriz atual

Execute `npm run compatibility:matrix` para regenerar [compatibility-matrix.json](compatibility-matrix.json) e [compatibility-matrix.md](compatibility-matrix.md). O snapshot encontra:

| Pacote | Versão do manifest | Nodes | Schemas de credenciais |
| --- | ---: | ---: | ---: |
| `n8n-nodes-base` | 2.42.5 | 444 | 410 |
| `@n8n/n8n-nodes-langchain` | 2.42.5 | 125 | 38 |

Os 569 registros estão como descobertos. Carregados, configuráveis, executáveis e validados: zero em cada etapa. O gerador inspeciona source histórico apenas para registrar imports/interfaces detectados; não carrega implementações nem declara que essa inferência é execução. Dois nodes com `.ee.` são marcados com licença Enterprise e ficam excluídos de distribuição. Community packages descobertos: zero, pois não há lista autenticada do servidor de referência.

Esse resultado é deliberadamente um relatório de incompatibilidade. Para cobrir o conjunto definido pelo usuário, ainda faltam instalação/carregamento de descrições compiladas, adaptação real dos contratos, isolamento com limites, integração de credenciais, triggers/webhooks, ciclo de execução e testes de regressão por node contra uma referência acessível.
