# Arquitetura do n8n-squared

Base: n8n 2.42.7, commit `92e4ff858a6ec0dc3ce3995d8696861575698bd0`.

O n8n mantém a execução de workflows, a API, o editor Vue, o registro de nodes, credenciais e persistência. O Squared adiciona apenas a configuração e o empacotamento necessários para sua distribuição. Os nomes internos dos packages continuam compatíveis com o monorepo original.

## Limites da fundação

- `packages/cli` inicia o backend e serve o editor compilado de `n8n-editor-ui`.
- `packages/workflow`, `packages/core`, `packages/nodes-base` e os demais packages de runtime continuam no fechamento de dependências gerado por pnpm.
- O perfil Square Cloud usa Node.js gerenciado pela plataforma, PostgreSQL externo, chave de criptografia estável e dados binários no banco. O launcher adapta host e porta sem alterar o motor.
- O processo de build produz um workspace reduzido com 46 pacotes internos compilados, ZIP e manifesto de verificação. O lockfile de produção permite instalar dependências públicas no ambiente gerenciado. O ZIP precisa passar por um teste em diretório limpo antes de qualquer afirmação de compatibilidade hospedada.
- O funcionamento local e em outras PaaS continua disponível pelo CLI original e por variáveis `N8N_*`.

Os quatro pilares futuros são Core, DX, Discord e Cloud. A implementação experimental de temas e Developer Mode permanece numa branch de backup até uma revisão própria.

Fixtures de Docker dentro de pacotes de teste e benchmark permanecem quando os próprios testes as utilizam. Eles não participam do build, do ZIP ou da execução na Square Cloud. O processo de distribuição por imagem do upstream foi removido.

## Configuração Squared

`SQUARED_RUNTIME_PROFILE` é carregado pelo `GlobalConfig` existente com valores `standard`, `lightweight` e `developer`. O padrão é `standard`. Os perfis `lightweight` e `developer` estão registrados, mas ainda não alteram o runtime; otimizações e ferramentas serão habilitadas somente quando implementadas e medidas. Variáveis `SQUARED_DISPLAY_NAME`, `SQUARED_SUBDOMAIN` e `SQUARED_MEMORY_MB` configuram o artefato de distribuição. As variáveis de n8n existentes continuam responsáveis pelo banco, criptografia, webhooks e rede.
