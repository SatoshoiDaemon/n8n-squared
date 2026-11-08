# Publicação do Squared na Square Cloud

O Squared 0.1.0 é um aplicativo Node.js independente. O ZIP contém `src/`, o lockfile npm e as dependências de produção; não contém o monorepo histórico nem dados da instalação. A inicialização usa `npm start`, com `src/main.js` como entrypoint.

## Persistência e configuração zero

Sem configuração de banco, o runtime usa SQLite embutido no Node.js e cria `squared-data/squared.sqlite`, o schema e os índices na primeira inicialização. `SQUARED_DATABASE_URL` ou `DATABASE_URL` seleciona PostgreSQL como alternativa. `SQUARED_DATABASE_SSL=require` ativa TLS para PostgreSQL.

O diretório `squared-data/` fica fora do ZIP. A Square Cloud documenta que o disco da aplicação persiste entre deploys e que um commit substitui somente os arquivos contidos no ZIP. Por isso, o banco SQLite e os arquivos de instalação continuam no disco durante um restart ou uma atualização. Não use o diretório temporário do sistema para dados do produto. `SQUARED_DATA_DIR` permite indicar outro diretório persistente.

O template oficial de n8n da Square Cloud também usa um `package.json` mínimo e pede a criação do proprietário no primeiro acesso. O n8n self-hosted usa SQLite por padrão e aceita PostgreSQL opcional; o Squared segue esse modelo com o runtime próprio. [Guia n8n da Square Cloud](https://docs.squarecloud.app/en/tutorials/how-to-deploy-n8n), [banco padrão do n8n](https://docs.n8n.io/deploy/host-n8n/configure-n8n/choose-n8ns-database/), [persistência do disco da aplicação na Square Cloud](https://squarecloud.app/en/learning/security/app-hacked-what-to-do).

## Chave de criptografia e primeiro administrador

Na primeira execução, o Squared gera uma chave aleatória de 256 bits para AES-256-GCM e guarda o valor em `squared-data/encryption-key` com permissão restrita. A mesma chave é reutilizada após reinícios e deploys. `SQUARED_ENCRYPTION_KEY` continua disponível como override avançado; quando já existe uma chave persistida, um valor diferente interrompe a inicialização para preservar a capacidade de descriptografar credenciais antigas.

Antes da criação do administrador, o Squared gera um código de bootstrap de uso único em `squared-data/bootstrap-code`. Esse código não aparece nos logs nem é servido por HTTP. O proprietário encontra o arquivo no **File Manager** da aplicação Square Cloud, abre a URL pública e informa o código, e-mail e uma senha de 12 a 128 caracteres. Depois da criação, o arquivo é removido e novos cadastros são recusados. A criação é atômica para que duas requisições concorrentes não possam reivindicar a conta.

Nos acessos seguintes, a tela pede e-mail e senha. A senha usa scrypt com salt aleatório; a sessão usa cookie `HttpOnly`, `Secure` e `SameSite=Strict`, dura sete dias e pode ser encerrada pelo botão **Sair**. A API e as operações administrativas exigem uma sessão válida. `SQUARED_ACCESS_TOKEN` é opcional e pode ser definido para integrações que usam `Authorization: Bearer ...`; ele não é necessário para abrir o editor.

## Manifesto, runtime e memória

O empacotador grava `squarecloud.app` com `RUNTIME=nodejs`, `VERSION=recommended`, `MEMORY=1024`, `MAIN=src/main.js` e `START=npm start`. A linha `recommended` seleciona a versão recomendada pela Square Cloud. O runtime usa `PORT=80` e `0.0.0.0`, a menos que overrides compatíveis sejam informados.

O perfil inicial permanece em 1024 MB. Esse valor representa memória alocada, não consumo medido. A avaliação de redução para 512 MB depende de medições do Squared sob carga representativa.

## Secrets e variáveis opcionais

Os secrets de deploy são usados somente pelo GitHub Actions:

- `SQUARECLOUD_API_KEY`: autenticação da API da Square Cloud.
- `SQUARECLOUD_APP_ID`: aplicação de destino. O workflow usa o ID definido para esta implantação se o secret estiver ausente.

A chave de API precisa dos escopos `account:read`, `apps:read`, `apps:deploy`, `apps:control`, `envs:read`, `snapshots:read` e `snapshots:write` para inspecionar, publicar, acompanhar e recuperar a aplicação.

Nenhuma variável adicional de runtime é obrigatória. As seguintes opções continuam disponíveis:

- `SQUARED_DATABASE_URL` ou `DATABASE_URL`: PostgreSQL opcional.
- `SQUARED_DATABASE_SSL=require`: TLS para PostgreSQL.
- `SQUARED_ENCRYPTION_KEY`: override estável de pelo menos 32 caracteres; o valor é persistido se ainda não houver chave.
- `SQUARED_ACCESS_TOKEN`: token de integração com pelo menos 24 caracteres.
- `SQUARED_DATA_DIR`: caminho de armazenamento persistente fora do diretório temporário do sistema.
- `SQUARED_MAX_CONCURRENCY`, `SQUARED_MAX_QUEUED_EXECUTIONS`, `SQUARED_SCHEDULE_POLL_MS` e `SQUARED_HTTP_TIMEOUT_MS`: limites opcionais; os padrões são 1, 16, 5 segundos e 15 segundos.

O pipeline lê as variáveis existentes sem imprimir seus valores. Overrides de porta e host incompatíveis param o deploy antes do upload.

## CI, artefato e deploy

O workflow [`.github/workflows/squared-ci.yml`](../../.github/workflows/squared-ci.yml) usa Node.js 24. Em PR para `main`, push em `main` ou execução manual, instala dependências, executa `npm test`, verifica a sintaxe, gera o ZIP, confere hash e integridade, roda o smoke test local e publica o ZIP e `manifest.json` como artefato por 90 dias. O smoke usa SQLite isolado, cria dados temporários e remove todo o diretório ao terminar; não precisa de PostgreSQL ou token.

O job `squarecloud_inspect` pode ser executado manualmente na `main` e na branch desta tarefa. Ele é somente leitura. O deploy automático roda após push em `main`; o deploy manual pode ser executado em `main` ou em `feat/squared-first-boot`. Eventos de pull request não recebem secrets de produção.

O deploy lê estado, domínio, configuração e variáveis opcionais antes de enviar o arquivo. Se uma versão anterior responder pela URL pública, cria um snapshot e exige sua disponibilidade antes de substituir o ZIP. Quando não há versão funcional para recuperar, o primeiro deploy segue sem exigir snapshot. Após o commit, o pipeline reinicia ou inicia a aplicação, aguarda `/healthz/readiness`, confere o editor e consulta logs/métricas quando disponíveis. Falhas depois do commit solicitam a restauração do snapshot quando um foi criado.

O smoke em produção nunca cria o administrador e não tenta tomar posse de uma instalação pública. Ele confirma o estado do primeiro acesso e que um código aleatório inválido é recusado. Se `SQUARED_ACCESS_TOKEN` estiver configurado, também executa operações autenticadas com workflows temporários identificáveis e os remove no final. Sem esse token, executa somente verificações públicas e não altera workflows.

## Health, testes e persistência

O runtime responde em `/healthz` e `/healthz/readiness`. A raiz `/` serve o editor e `/api/auth/status` informa se a instalação precisa ser configurada. Para uma instalação nova, leia `squared-data/bootstrap-code` pelo File Manager da Square Cloud e complete a configuração inicial na URL pública.

O smoke local inicia o ZIP empacotado sem banco ou token, cria um administrador somente no armazenamento descartável do teste, salva e executa workflows manual e webhook, cria uma credencial cifrada, reinicia o processo e confirma a persistência do workflow, da execução, da sessão e da chave. Os dados descartáveis são apagados ao final.

## Logs e métricas

O resumo de deploy registra perfil de memória, readiness, CPU/RAM atuais, uptime, status e erros encontrados nos logs disponíveis. Métricas históricas da Square Cloud são coletadas a cada cinco minutos; por isso, podem não registrar um boot curto ou uma execução rápida. Ausência de amostras ou logs não bloqueia deploy se health e status estiverem disponíveis. Nenhuma métrica ausente é estimada.

O endpoint `GET /v2/apps/{app_id}/status` fornece status e recursos atuais. `GET /v2/apps/{app_id}/metrics?range=24h` fornece as amostras históricas disponíveis. O app informa startup com a versão real do Node.js; se o log não estiver disponível, o resumo indica a ausência em vez de inventar um resultado.

## Recuperação e publicação local

Snapshots de aplicação contêm os arquivos da aplicação. Square Cloud oferece snapshots manuais e restauração; snapshots automáticos de aplicações dependem do plano. Para uma atualização de instalação funcional, o pipeline cria snapshot manual antes de trocar os arquivos e tenta restaurá-lo se o runtime novo falhar.

Para gerar e conferir o ZIP localmente:

```sh
npm ci
npm test
npm run build
npm run package:squarecloud
npm run verify:squarecloud
npm run smoke:squarecloud
```

O artefato fica em `dist/squarecloud/squared-squarecloud.zip`; `manifest.json` registra versão, tamanho e SHA-256. O ZIP contém `src/main.js`, `src/`, `package.json`, `package-lock.json`, `squarecloud.app` e somente os arquivos mínimos de runtime. Não contém `.env*`, `squared-data/`, a árvore herdada `packages/` ou artefatos locais.
