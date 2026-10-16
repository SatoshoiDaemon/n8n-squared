# Arquitetura do n8n-squared

Base: n8n 2.42.7, commit `92e4ff858a6ec0dc3ce3995d8696861575698bd0`.

O n8n mantém a execução de workflows, a API, o editor Vue, o registro de nodes, credenciais e persistência. O Squared adiciona apenas a configuração e o empacotamento necessários para sua distribuição. Os nomes internos dos packages continuam compatíveis com o monorepo original.

## Limites da fundação

- `packages/cli` inicia o backend e serve o editor compilado de `n8n-editor-ui`.
- `packages/workflow`, `packages/core`, `packages/nodes-base` e os demais packages de runtime continuam no fechamento de dependências gerado por pnpm.
- O perfil Square Cloud usa Node.js gerenciado pela plataforma, PostgreSQL externo, chave de criptografia estável e dados binários no banco. O launcher adapta host e porta sem alterar o motor.
- O processo de build produz um diretório de execução, ZIP e manifestos de verificação. O ZIP precisa passar por um teste em diretório limpo antes de qualquer afirmação de compatibilidade hospedada.
- O funcionamento local e em outras PaaS continua disponível pelo CLI original e por variáveis `N8N_*`.

Os quatro pilares futuros são Core, DX, Discord e Cloud. A implementação experimental de temas e Developer Mode permanece numa branch de backup até uma revisão própria.
