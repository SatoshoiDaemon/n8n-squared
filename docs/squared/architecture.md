# Arquitetura atual do Squared

O runtime do produto está em `src/` e é uma aplicação JavaScript ESM executada diretamente pelo Node.js 24. Não importa o CLI, a configuração ou o carregador de módulos do n8n. O n8n continua registrado em [UPSTREAM.md](../../UPSTREAM.md) como origem histórica do código do repositório; a versão do Squared é independente e começa em `0.1.0`.

## Caminho de execução

~~~text
npm start
  └─ src/main.js
      ├─ src/config.js                 valida ambiente e limites
      ├─ src/process/lifecycle.js      encerra servidor, agenda e pool PostgreSQL
      ├─ src/persistence/postgres.js   workflows, execuções e credenciais
      ├─ src/http/server.js            editor, API, health e webhooks
      ├─ src/workflows/                validação e serviço de workflows
      ├─ src/execution/                fila limitada e executor sequencial
      ├─ src/nodes/                    Set, IF e HTTP Request
      ├─ src/expressions/              expressões de dados sem eval
      ├─ src/credentials/              criptografia AES-256-GCM
      └─ src/triggers/                 agendamento por intervalo
~~~

O editor estático em `src/assets/` cria workflows como uma sequência visual de nodes. Os gatilhos disponíveis são manual, webhook e intervalo. O executor limita simultaneamente o número de execuções ativas e enfileiradas. O código de workflow não é executado como JavaScript arbitrário; portanto, o node Code e extensões npm não fazem parte desta primeira fatia. Isso mantém o processo principal fora da execução direta de código fornecido por usuários enquanto a sandbox isolada é escolhida.

## Estado e segurança

- PostgreSQL guarda definições, entradas/saídas de execução e credenciais cifradas. O banco precisa ser externo e persistente.
- `SQUARED_ENCRYPTION_KEY` deriva a chave AES-256-GCM. Ela deve ter ao menos 32 caracteres e permanecer igual entre deploys.
- `SQUARED_ACCESS_TOKEN` protege API, editor e webhooks com autenticação Bearer. Esta versão oferece uma credencial de acesso de operador, não contas individuais.
- Nenhum arquivo de dados é persistido no container. O armazenamento de binários via Square Blob ainda não está implementado; nodes que precisam de arquivos não fazem parte do runtime atual.
- O runtime mantém uma pool PostgreSQL de até 4 conexões, 1 execução simultânea e até 16 execuções ativas/em espera por padrão. Esses limites são escolhas operacionais, não evidência de que a meta de 512–1024 MB foi comprovada.

## Origem e material antigo

O código sob `packages/` permanece no repositório como fonte de referência para a reconstrução gradual de capacidades maiores, inclusive o editor Vue original e centenas de integrações. Ele não entra no ZIP, não é instalado pelo comando de deploy e não é importado pelo runtime em `src/`. O caminho anterior de inicialização Square `deploy/squarecloud/start.cjs` e o empacotamento de 46 workspaces foram removidos.

Os documentos em `docs/audit/` registram a auditoria da árvore anterior. Eles são evidência histórica da arquitetura legada, não a especificação atual do runtime.
