# Squared

Squared é uma aplicação de automação independente, desenvolvida para distribuição na Square Cloud. A versão atual é **0.1.0**. Seu runtime próprio está em `src/` e inicia com Node.js 24 e `npm start`.

O núcleo atual oferece editor visual sequencial, gatilhos manuais/webhook/agendados, execução limitada, expressões de dados, nodes Set/HTTP Request/IF, credenciais criptografadas, conta administrativa inicial e armazenamento SQLite automático. PostgreSQL continua disponível como alternativa. O editor e o runtime não importam o CLI legado. Recursos de código arbitrário e armazenamento de arquivos ainda não fazem parte desta versão.

## Desenvolvimento

Instale as dependências e execute sem configuração de banco ou chave:

```sh
npm ci
npm test
npm start
```

No primeiro acesso, use o código em `squared-data/bootstrap-code` para criar a conta proprietária. Na Square Cloud, o proprietário lê esse arquivo pelo File Manager da aplicação.

`npm run build` verifica a sintaxe do entrypoint; não há compilação do runtime.

## ZIP da Square Cloud

```sh
npm run package:squarecloud
```

O comando cria uma aplicação Node independente em `dist/squarecloud/squared-squarecloud.zip`, com dependências de produção instaladas, `npm start` e `src/main.js`. Não executa Turbo nem depende dos workspaces antigos. Consulte o guia de [Square Cloud](docs/squared/square-cloud.md) para persistência, primeiro acesso, smoke e deploy.

## Código de origem

O repositório ainda contém a árvore histórica `packages/` para referência durante a reconstrução de capacidades, mas ela não participa do runtime nem do ZIP. [UPSTREAM.md](UPSTREAM.md) registra a origem histórica sem vincular o versionamento do Squared aos releases do n8n. Os avisos de copyright e [licenças originais](LICENSE.md) permanecem nos arquivos correspondentes.
