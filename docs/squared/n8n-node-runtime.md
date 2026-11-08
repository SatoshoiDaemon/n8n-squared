# Runtime de pacotes n8n

## Carregamento e execução

Squared descobre pacotes pelo `package.json` (`n8n.nodes` e `n8n.credentials`) e pelos arquivos JSON auxiliares publicados pelo pacote. Esses JSON não são tratados como descrições executáveis. Ao encontrar um tipo usado pelo workflow, o registro resolve o arquivo `.node.js`, importa o módulo original, instancia sua classe e escolhe o `typeVersion` solicitado. `VersionedNodeType` é resolvido pela tabela de versões da classe.

O carregamento de módulos é sob demanda. A inicialização lê manifests e descrições auxiliares; ela não importa todas as implementações JavaScript. Descrições completas vêm da classe real por `GET /api/node-types/:type/description`. O inventário protegido por autenticação está em `GET /api/node-types`.

O executor cria uma fachada `IExecuteFunctions` para cada chamada do node. Ela fornece os dados de entrada, parâmetros com expressões, node/workflow, modo e settings, credenciais do vault, estado de contexto e helpers comuns. Helpers desconhecidos falham com erro explícito. Um método `execute()` existente no módulo, por si só, não marca o node como executável: é necessário completar uma execução bem-sucedida; `validated` também exige um caso de regressão aprovado.

O motor aceita os nodes de gatilho raiz para iniciar manualmente uma execução e executa nodes conectados conforme as saídas do node real. `If` e `Switch` mantêm suas portas de saída; itens seguem os caminhos que os nodes retornam. Workflows sem `connections` continuam no executor linear Squared existente.

## Instalar pacotes fora do artefato Squared

O pacote oficial não é adicionado às dependências nem ao ZIP do Squared. Instale-o na pasta persistente de dados, junto com suas dependências, usando o gerenciador de pacotes do Node 24:

```powershell
npm install --prefix squared-data/n8n-nodes n8n-nodes-base@2.42.5
$env:SQUARED_N8N_PACKAGES_DIR = (Resolve-Path 'squared-data/n8n-nodes/node_modules').Path
node src/main.js
```

Sem `SQUARED_N8N_PACKAGES_DIR`, o padrão é `squared-data/n8n-nodes/node_modules`. Em Square Cloud, mantenha essa pasta no armazenamento persistente junto ao SQLite e à chave do Squared. Não coloque credenciais n8n exportadas nessa árvore.

Pacotes comunitários podem ser instalados na mesma pasta de módulos e entram no catálogo quando seu manifest publica `n8n.nodes`. Tipos que colidem, paths fora do pacote e arquivos `.ee.node.js` são recusados. O runtime não instala pacotes automaticamente.

## Contratos disponíveis e limites

A fachada implementa a parte do contrato exercitada pelos nodes validados, incluindo `getInputData`, `getNodeParameter` (expressões, defaults descritos, caminhos com arrays e extração de filtros), `getNode`, `getWorkflow`, `getMode`, `getExecutionId`, `getTimezone`, `getWorkflowSettings`, `continueOnFail`, `getCredentials`, `evaluateExpression`, `prepareOutputData`, `getWorkflowStaticData`, `getContext`, helpers de itens, binários em base64 no item e requisições HTTP simples. O node HTTP Request usou a classe publicada `HttpHeaderAuth`; o Squared carregou a definição real da credencial, obteve os valores somente pelo provedor do vault e aplicou a configuração genérica declarada pela credencial.

A validação atual cobre 20 tipos e 23 execuções contra o pacote npm `n8n-nodes-base@2.42.5`: `Set` v1 e v3.5, `If` v2.3, `Filter` v2.3, `Switch` v3.3, `NoOp` v1, `HTTP Request` v4.5, `Limit` v1, `Sort` v1, `Remove Duplicates` v2, `Rename Keys` v1, `Split Out` v1, `Aggregate` v1, `Date & Time` v2, `Summarize` v1.1, `Compare Datasets` v2.3, `Convert to/from Binary Data` v1, `GitHub` v1 (`repository:get`), `XML` v1, `HTML` v1.2 e `Markdown` v1. As saídas são comparadas com resultados determinísticos no teste de regressão; HTTP Request e GitHub usam somente um servidor JSON local efêmero. A credencial oficial `GithubApi` aponta para esse servidor e a resposta confirma o header gerado pelo contrato `authenticate` do pacote. Essa evidência cobre os caminhos e versões exercitados, não todas as opções desses nodes nem o catálogo inteiro. A matriz marca outros nodes como não executáveis até uma execução real passar.

Nodes que chamarem interfaces ausentes falham no ponto do contrato com o nome do helper/método indisponível. O pacote tem 444 entradas descobertas nesta instalação, mas só os 20 tipos acima estão validados. `MoveBinaryData` foi executado nos dois sentidos com itens binários inline em base64; ainda não existe armazenamento de binários persistente para payloads grandes. `trigger()`, `poll()` e `webhook()` ainda não são adaptados como contratos de node: endpoints webhook e execução manual do Squared iniciam o grafo, mas não chamam esses métodos do pacote. Contexto e estado estático são mantidos apenas durante uma execução; não há persistência entre execuções, trigger contínuo, polling, OAuth interativo nem `NodeExecuteFunctions` declarativo completo. O adaptador HTTP implementa a parte de requests exercitada e informa erro explícito para helpers ausentes. O runtime não avalia o node Code e não executa código de workflow via `eval` ou `vm`.

Os módulos n8n e comunitários são código JavaScript de terceiros executado no mesmo processo com os privilégios do Squared. Instale apenas pacotes confiáveis e mantenha o acesso de instalação sob controle administrativo. A pasta configurada não equivale a um sandbox para código hostil.

## Testes e matriz

Com o pacote instalado, execute:

```powershell
$env:SQUARED_N8N_PACKAGES_DIR = (Resolve-Path 'squared-data/n8n-nodes/node_modules').Path
npm run compatibility:validate
npm run compatibility:matrix
npm test
```

`compatibility:validate` executa workflows determinísticos sobre classes do pacote instalado e grava `compatibility-runtime-results.json`; a matriz cruza esses resultados com os 569 manifests da árvore histórica. Sem pacote instalado, a suíte opcional pula a integração, e a matriz conserva o último relatório versionado. A validação não é uma comparação diferencial com n8n.

## Licenças

O adaptador e o motor Squared são código original. Os pacotes `n8n-nodes-base`, `n8n-workflow` e demais pacotes do monorepo n8n são regidos pela licença sustentável do n8n; arquivos `.ee.` pertencem à licença Enterprise e não são carregados pelo Squared. Esses componentes não são copiados para o código ou artefato do Squared, não recebem relicenciamento Apache-2.0 e devem ser obtidos e distribuídos conforme seus próprios termos. Nodes comunitários mantêm as licenças declaradas por seus autores.

Consulte a [licença da comunidade n8n](https://github.com/n8n-io/n8n-docs/blob/main/docs/n8n-community-license/README.md), a [análise oficial de composição e licenças](https://github.com/n8n-io/n8n/blob/master/security/sca/README.md) e o [loader oficial de nodes e credenciais](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/load-nodes-and-credentials.ts).
