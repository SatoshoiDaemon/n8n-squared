# Relatório de licenciamento da camada de compatibilidade

## Fontes e componentes investigados

Os manifests históricos locais registram `LicenseRef-n8n-sustainable-use` para `n8n-workflow@2.42.4`, `n8n-core@2.42.5`, `n8n-nodes-base@2.42.5` e `@n8n/n8n-nodes-langchain@2.42.5`. A licença local [`LICENSE.md`](../../LICENSE.md) limita uso/modificação ao uso interno da empresa ou uso não comercial/pessoal e condiciona redistribuição a ser gratuita e não comercial. O mesmo arquivo exclui código `.ee.` da Sustainable Use License; [`LICENSE_EE.md`](../../LICENSE_EE.md) exige licença Enterprise compatível para produção/distribuição de conteúdo Enterprise. Consulte também o resumo oficial da [licença comunitária n8n](https://github.com/n8n-io/n8n-docs/blob/main/docs/n8n-community-license/README.md) e a [documentação oficial do SCA](https://github.com/n8n-io/n8n/blob/master/security/sca/README.md).

Esta branch não copia implementação dos nodes n8n para o runtime, não inclui dependência n8n no ZIP e não distribui o código histórico de `packages/`. Os `.ee.` de Evaluation e Evaluation Trigger aparecem apenas como source para a matriz e estão identificados como Enterprise-restritos; não são carregados ou incluídos no artefato de produção.

O catálogo e os adaptadores TypeScript desta branch são implementação Squared escrita separadamente. A árvore histórica foi consultada como referência para contratos e manifests. O catálogo não contorna licenças, e compatibilidade de formato/JSON não concede direitos sobre implementação de nodes ou pacotes.

Dependências de terceiros de cada pacote comunitário ou oficial mantêm suas licenças próprias. Antes de permitir instalar ou distribuir pacotes, Squared precisa inventariar licenças transitivas, avisos, restrições de marca e termos específicos do pacote. Community packages descobertos: zero nesta etapa.

## Apache-2.0 para código Squared

O objetivo do projeto é usar Apache License 2.0 para código original e independente do Squared. Porém, a raiz atual do repositório contém `LICENSE.md`/`LICENSE_EE.md` referentes ao snapshot histórico n8n e não tem um arquivo raiz `LICENSE` ou outro aviso Apache-2.0 para o código Squared. Portanto, este relatório não afirma que os arquivos originais desta branch já estão juridicamente licenciados sob Apache-2.0. A intenção precisa ser formalizada em um mapa de licenças e avisos separado antes de distribuir a implementação.

## Limite desta análise

Este documento registra metadados presentes no repositório e ligações para fontes oficiais. Não é parecer jurídico. A inclusão de pacotes n8n, código `.ee.`, community nodes ou binários de terceiros precisa de revisão específica antes da distribuição.
