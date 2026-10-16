# n8n-squared

n8n-squared é uma base derivada do [n8n](https://github.com/n8n-io/n8n), preparada para self-hosting e distribuição como aplicação Node.js na Square Cloud. Preserva o motor de workflows, o editor visual, os nodes e os formatos de dados da versão-base **2.42.7**.

Esta fundação concentra-se em uma distribuição reproduzível e no funcionamento local. Temas, Developer Mode, integrações Discord e otimizações de memória serão integrados após a validação da base.

## Desenvolvimento

Use Node.js 24 e o pnpm definido em `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm dev:be
```

Em outro terminal, execute `pnpm dev:fe:editor`. A URL do editor aparece no terminal. Defina `N8N_USER_FOLDER` para um diretório de desenvolvimento dedicado. O cadastro inicial da conta é necessário somente para testar a interface autenticada.

## Distribuição

`pnpm build:deploy` gera um pacote Node.js com pacotes internos compilados, lockfile de produção e configuração da Square Cloud. As dependências públicas são instaladas pela plataforma com pnpm. Consulte [instalação na Square Cloud](docs/squared/square-cloud.md) antes de publicar. Este projeto não constrói nem publica imagens Docker.

## Origem e licenças

[UPSTREAM.md](UPSTREAM.md) registra a tag e o commit do código-base. Os avisos de copyright nos arquivos originais permanecem. A base n8n mantém a [Sustainable Use License](LICENSE.md) e os componentes Enterprise preservam sua [licença separada](LICENSE_EE.md). Os créditos pertencem aos [contribuidores do n8n](https://github.com/n8n-io/n8n/graphs/contributors).
