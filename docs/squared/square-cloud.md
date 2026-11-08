# Distribuição do Squared na Square Cloud

O Squared é enviado como uma aplicação Node.js 24 convencional em um ZIP. O ZIP contém `src/`, o lockfile npm e a dependência de produção `pg`. Não contém o monorepo, workspaces pnpm, Docker ou um passo de compilação. O comando de inicialização é `npm start`; o arquivo principal é `src/main.js`.

## Criar o ZIP

Requisitos locais: Node.js 24, npm, `zip` e `unzip`.

```sh
SQUARED_SUBDOMAIN=meu-squared npm run package:squarecloud
```

O resultado fica em `dist/squarecloud/squared-squarecloud.zip`. `manifest.json` registra versão do produto, tamanho, hash SHA-256, entrypoint e dependências. O script instala a dependência de runtime no diretório temporário do artefato com `npm ci --omit=dev`, valida o ZIP e recusa arquivos acima de 100 MB. `SQUARED_DISPLAY_NAME`, `SQUARED_SUBDOMAIN` e `SQUARED_MEMORY_MB` configuram `squarecloud.app`; a memória declarada começa em 1024 MB. Esse valor é uma configuração de deploy, não uma medição de RSS ou uma garantia da meta.

O ZIP já leva `node_modules/pg`; não precisa compilar o monorepo nem instalar 87 workspaces. Na Square Cloud, use Node.js, `MAIN=src/main.js` e o comando `npm start`.

## Variáveis necessárias

Configure segredos no painel da Square Cloud, nunca no ZIP:

```text
SQUARED_DATABASE_URL=postgresql://usuario:senha@host:5432/squared
SQUARED_ENCRYPTION_KEY=<segredo aleatorio com ao menos 32 caracteres>
SQUARED_ACCESS_TOKEN=<token aleatorio com ao menos 24 caracteres>
PORT=80
SQUARED_DATABASE_SSL=require
```

`SQUARED_DATABASE_URL` aceita uma URL PostgreSQL persistente; `DATABASE_URL` também é reconhecida. Ative `SQUARED_DATABASE_SSL=require` se o provedor exigir TLS. Mantenha a chave de criptografia estável entre deploys. O token Bearer protege editor, API e webhooks. O runtime escuta em `0.0.0.0`; usa `PORT` da Square Cloud ou `SQUARED_PORT` e, por padrão, porta 80.

Limites ajustáveis: `SQUARED_MAX_CONCURRENCY` (1 por padrão, máximo 8), `SQUARED_MAX_QUEUED_EXECUTIONS` (16 por padrão, inclui as ativas e pode ser configurado até 1024), `SQUARED_SCHEDULE_POLL_MS` (5 s) e `SQUARED_HTTP_TIMEOUT_MS` (15 s). Não há resultado de benchmark que autorize declarar suporte medido a 512 ou 1024 MB.

## Persistência e recursos

PostgreSQL armazena workflows, execuções e credenciais criptografadas. O container não grava dados duráveis localmente. A integração Square Blob para arquivos binários ainda não foi implementada; esta versão aceita nodes de gatilho manual, webhook e intervalo, além de Set Fields, HTTP Request e IF. O node Code e pacotes npm de terceiros estão fora do runtime até haver um runner isolado adequado.

O editor pode criar, ativar, executar e revisar workflows. Acesse a URL da aplicação e informe `SQUARED_ACCESS_TOKEN`. Para chamar webhook, envie `Authorization: Bearer <token>` e um JSON no corpo.

## Smoke do ZIP

O smoke usa uma base PostgreSQL dedicada para evitar escrita em dados de outra instância. Ele cria registros de teste e não apaga o banco:

```sh
npm run package:squarecloud
SQUARED_SMOKE_DATABASE_URL=postgresql://.../squared_smoke npm run smoke:squarecloud
```

O smoke extrai o ZIP em diretório temporário, inicia por `npm start` e verifica readiness, autenticação, editor, gatilhos manual/webhook, execução e API de credenciais. Teste a retenção após reinicialização no seu PostgreSQL antes de usar o deploy em produção.

## Enviar

Com a CLI da Square Cloud instalada e autenticada:

```sh
npm run deploy:squarecloud
```

Para atualizar uma aplicação existente, defina `SQUARED_SQUARECLOUD_APP_ID`. `SQUARED_SUBDOMAIN` é necessário no empacotamento de uma aplicação nova. Não registre `SQUARECLOUD_API_KEY` no repositório.
