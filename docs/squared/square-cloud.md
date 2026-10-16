# Instalação na Square Cloud

O n8n-squared é enviado como uma aplicação Node.js. A Square Cloud gerencia o ambiente de execução; o projeto não requer uma imagem Docker. O ZIP contém o backend compilado, o editor compilado, os nodes, o lockfile de produção, os patches e `squarecloud.app`. A Square Cloud instala as dependências públicas de runtime com pnpm antes de iniciar a aplicação.

## Preparar o artefato

Requisitos locais: Node.js 24, pnpm 12.4.2, `tar`, `zip` e `unzip`.

```sh
corepack enable
pnpm install --frozen-lockfile
SQUARED_SUBDOMAIN=meu-n8n-squared pnpm build:deploy
```

O resultado fica em `dist/squarecloud/n8n-squared-squarecloud.zip`. `manifest.json` registra tamanho e SHA-256. `SQUARED_MEMORY_MB` altera `MEMORY` em `squarecloud.app` (padrão: 2048); escolha um valor compatível com o plano e a memória medida. `SQUARED_DISPLAY_NAME` altera o nome exibido. `SQUARED_SUBDOMAIN` define a publicação web; também é possível configurar o domínio no painel.

O empacotamento inclui os pacotes internos já compilados em um workspace reduzido. O lockfile é derivado das versões fixadas na raiz do projeto. O ZIP não inclui `node_modules`, como recomenda a [documentação da Square Cloud](https://squarecloud.app/en/runtimes/nodejs). O gerenciador definido no pacote é pnpm 12.4.2. Antes do envio, o script rejeita um ZIP maior que 100 MiB. A instalação local com `pnpm install --prod --frozen-lockfile` foi validada, mas a instalação hospedada precisa ser confirmada na conta Square Cloud.

## Persistência e ambiente

Configure as variáveis no painel da aplicação, nunca dentro do ZIP:

```text
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=<host do PostgreSQL persistente>
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=<database>
DB_POSTGRESDB_USER=<usuario>
DB_POSTGRESDB_PASSWORD=<senha>
N8N_ENCRYPTION_KEY=<chave aleatoria estavel entre deploys>
N8N_DEFAULT_BINARY_DATA_MODE=database
N8N_EDITOR_BASE_URL=https://<dominio-publico>/
WEBHOOK_URL=https://<dominio-publico>/
N8N_PROXY_HOPS=1
```

Use SSL no banco conforme o provedor do PostgreSQL. O backend escuta em `0.0.0.0` e na porta `80` por padrão; `N8N_PORT` ou `PORT` podem mudar isso em outros ambientes. `N8N_HOST` deve representar o domínio público, se definido; não o endereço de escuta. A chave de criptografia deve permanecer a mesma entre deploys, pois protege as credenciais salvas. O modo `database` mantém dados binários junto dos workflows no banco. Arquivos locais gravados por nodes ou extensões exigem armazenamento persistente separado; o artefato não o fornece.

## Iniciar e conferir

Teste o ZIP em uma pasta limpa antes de enviar:

```sh
mkdir -p /tmp/n8n-squared-smoke
cd /tmp/n8n-squared-smoke
unzip /caminho/para/n8n-squared-squarecloud.zip
corepack enable
pnpm install --prod --frozen-lockfile
N8N_USER_FOLDER=/tmp/n8n-squared-data N8N_PORT=5678 node start.cjs
```

Em outro terminal, verifique `http://localhost:5678/healthz/readiness` e `http://localhost:5678/`. A página do editor e a resposta de saúde confirmam somente essa execução local. Para persistência hospedada, reinicie após criar um workflow e confirme sua presença e a validade de credenciais.

## Enviar

Com a [CLI oficial da Square Cloud](https://github.com/squarecloudofc/cli) instalada e autenticada:

```sh
pnpm deploy:squarecloud
```

Esse comando usa o ZIP já gerado. Para atualizar uma aplicação existente, defina `SQUARED_SQUARECLOUD_APP_ID` antes de executá-lo. Não coloque credenciais da Square Cloud no repositório. A CLI reconhece `SQUARECLOUD_API_KEY` no ambiente. Após o upload, confira os logs, a URL pública, `/healthz/readiness`, editor, execução de workflow e persistência após reinicialização. A aceitação do ZIP e o teste hospedado dependem de uma conta e um plano disponíveis.
