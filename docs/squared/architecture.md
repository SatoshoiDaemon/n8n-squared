# Arquitetura atual do Squared

O runtime do produto está em `src/` e é uma aplicação JavaScript ESM executada diretamente pelo Node.js 24. Não importa o CLI, a configuração ou o carregador de módulos do n8n. O n8n continua registrado em [UPSTREAM.md](../../UPSTREAM.md) como origem histórica do código do repositório; a versão do Squared é independente e começa em `0.1.0`.

## Caminho de execução

~~~text
npm start
  └─ src/main.js
      ├─ src/config.js                    valida variáveis opcionais e limites
      ├─ src/persistence/store.js         escolhe SQLite padrão ou PostgreSQL opcional
      ├─ src/persistence/sqlite.js        schema automático no disco persistente
      ├─ src/persistence/postgres.js      backend PostgreSQL opcional
      ├─ src/persistence/persistent-secrets.js chave e código de bootstrap persistidos
      ├─ src/auth/service.js              primeiro administrador, senha e sessões
      ├─ src/http/server.js               editor, auth, API, health e webhooks
      ├─ src/workflows/                   validação e serviço de workflows
      ├─ src/execution/                   fila limitada e executor sequencial
      ├─ src/nodes/                       Set, IF e HTTP Request
      ├─ src/expressions/                 expressões de dados sem eval
      ├─ src/credentials/                 criptografia AES-256-GCM
      └─ src/triggers/                    agendamento por intervalo
~~~

O editor estático em `src/assets/` cria workflows como uma sequência visual de nodes. Os gatilhos disponíveis são manual, webhook e intervalo. O executor limita simultaneamente o número de execuções ativas e enfileiradas. O código de workflow não é executado como JavaScript arbitrário; portanto, o node Code e extensões npm não fazem parte desta primeira fatia.

## Persistência

- Sem URL de banco, o runtime usa `node:sqlite` e cria automaticamente `squared-data/squared.sqlite`, tabelas e índices necessários.
- `SQUARED_DATABASE_URL` ou `DATABASE_URL` seleciona PostgreSQL como alternativa. O schema é criado na inicialização.
- Chave de criptografia e código de primeiro acesso ficam em arquivos separados, privados, dentro de `squared-data/`. Essa pasta não entra no ZIP.
- A configuração da Square Cloud documenta que o disco da aplicação sobrevive a deploys e que um commit substitui somente os arquivos contidos no ZIP. Assim, banco, chave, conta e sessões sobrevivem a reinícios e atualizações.
- `SQUARED_DATA_DIR` permite escolher outro diretório persistente. O runtime rejeita caminhos dentro do diretório temporário do sistema.

## Autenticação e credenciais

- Na primeira execução, o runtime gera uma chave de 256 bits para AES-256-GCM. O arquivo existente é reutilizado. Se `SQUARED_ENCRYPTION_KEY` estiver definido, o valor é persistido no primeiro uso e uma divergência posterior interrompe a inicialização para não inutilizar credenciais cifradas.
- Antes de existir administrador, o runtime gera um código de bootstrap aleatório em `squared-data/bootstrap-code`. O proprietário da Square Cloud pode lê-lo no File Manager. A API só cria a conta quando esse código é informado e uma única inserção atômica vence a disputa.
- A senha administrativa usa scrypt com salt aleatório. As sessões usam tokens aleatórios, armazenados por hash, e cookies `HttpOnly`, `Secure` e `SameSite=Strict`; logout revoga a sessão.
- APIs e editor exigem uma sessão administrativa. `SQUARED_ACCESS_TOKEN` é opcional e serve para integrações que enviam `Authorization: Bearer ...`.
- O runtime não registra senhas, códigos de bootstrap, chaves, valores de credenciais ou URLs de banco.

O runtime mantém 1 execução simultânea e até 16 execuções ativas/em espera por padrão. Esses limites são escolhas operacionais, não evidência de que a meta de 512–1024 MB foi comprovada.

## Origem e material antigo

O código sob `packages/` permanece no repositório como fonte de referência para a reconstrução gradual de capacidades maiores, inclusive o editor Vue original e centenas de integrações. Ele não entra no ZIP, não é instalado pelo comando de deploy e não é importado pelo runtime em `src/`. O caminho anterior de inicialização Square `deploy/squarecloud/start.cjs` e o empacotamento de 46 workspaces foram removidos.

Os documentos em `docs/audit/` registram a auditoria da árvore anterior. Eles são evidência histórica da arquitetura legada, não a especificação atual do runtime.
