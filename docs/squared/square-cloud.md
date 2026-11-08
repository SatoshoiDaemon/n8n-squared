# Publicação do Squared na Square Cloud

O Squared 0.1.0 é um aplicativo Node.js independente. O ZIP contém `src/`, o lockfile npm e a dependência de produção `pg`; não contém o monorepo histórico. A inicialização usa `npm start`, com `src/main.js` como entrypoint.

## Manifesto e rede

O empacotador grava `squarecloud.app` com `RUNTIME=nodejs`, `VERSION=recommended`, `MEMORY=1024`, `MAIN=src/main.js` e `START=npm start`. `recommended` seleciona a linha LTS recomendada pela Square Cloud. A plataforma documenta `recommended` e `latest`; valores numéricos fixos para `VERSION` não são aceitos. O processo registra `process.versions.node` no log de inicialização e o deploy só é considerado válido quando a versão observada começa com `24.`.

A Square Cloud fornece `PORT=80` e espera escuta em `0.0.0.0`. O Squared usa esses padrões. `SQUARED_PORT`, se configurado, precisa continuar em `80`; `SQUARED_HOST`, se configurado, precisa ser `0.0.0.0`. O pré-deploy verifica esses overrides sem alterar variáveis.

O perfil de 1024 MB é a reserva configurada para o container. Não representa memória consumida. A possibilidade de reduzir o perfil para 512 MB depende das amostras reais descritas abaixo.

## Secrets de deploy e variáveis de runtime

Os secrets de deploy são usados somente pelo GitHub Actions:

- `SQUARECLOUD_API_KEY`: autenticação da API oficial da Square Cloud.
- `SQUARECLOUD_APP_ID`: ID do app de destino. Se esse secret estiver ausente, o workflow usa o ID público fornecido para esta implantação.

O token da API precisa dos escopos `account:read`, `apps:read`, `apps:deploy`, `apps:control`, `envs:read`, `snapshots:read` e `snapshots:write` para inspecionar, publicar, acompanhar e recuperar a aplicação.

Eles não configuram o runtime. Antes de enviar o ZIP, o workflow lê as variáveis atuais do app e exige:

- `SQUARED_DATABASE_URL` ou `DATABASE_URL`: URL de um PostgreSQL externo.
- `SQUARED_ENCRYPTION_KEY`: pelo menos 32 caracteres; deve permanecer igual entre os deploys.
- `SQUARED_ACCESS_TOKEN`: pelo menos 24 caracteres; protege a API, o editor e os webhooks.

`SQUARED_DATABASE_SSL=require` ativa TLS quando necessário. `SQUARED_MAX_CONCURRENCY`, `SQUARED_MAX_QUEUED_EXECUTIONS`, `SQUARED_SCHEDULE_POLL_MS` e `SQUARED_HTTP_TIMEOUT_MS` são limites opcionais; os padrões são 1, 16, 5 segundos e 15 segundos. O pipeline não cria, substitui ou imprime variáveis de runtime. Se faltar uma variável indispensável, ou se um override de porta/endereço for incompatível, o deploy para antes de criar snapshot ou enviar código.

O modo `inspect` usa `GET /v2/apps/{app_id}/envs`, mas escreve apenas presença e compatibilidade das chaves no resumo do workflow. Não imprime valores.

## CI, artefato e deploy

O workflow [`.github/workflows/squared-ci.yml`](../../.github/workflows/squared-ci.yml) executa com Node.js 24. Em cada PR para `main`, push em `main` ou execução manual, ele instala dependências, roda `npm test`, verifica a sintaxe de todos os arquivos JavaScript de `src/`, gera o ZIP, confere hash SHA-256 e integridade, roda o smoke test com um PostgreSQL temporário do próprio job e publica o ZIP e `manifest.json` como artefato por 90 dias.

O deploy automático só roda no push para `main`, normalmente após o merge aprovado. O job de deploy depende de todos os testes e verificações, serializa operações para a aplicação e não é executado por `pull_request`. O workflow usa a API oficial da Square Cloud: `POST /v2/apps/{app_id}/commit`, com o ZIP no campo multipart `file`. Como esse endpoint não reinicia o app, o job chama `restart` se ele estava em execução ou `start` se estava parado.

Para inspecionar ou publicar manualmente, abra **Actions → Squared CI and Square Cloud Deploy → Run workflow** e selecione a branch `deploy/squarecloud-production` ou `main`:

1. Escolha `inspect` para ler estado, domínio, memória configurada, disponibilidade das variáveis de runtime e métricas/logs que a API expuser. Essa opção não altera o app.
2. Escolha `deploy` para executar o mesmo pipeline de testes e publicar o ZIP validado. A publicação só segue depois da verificação de variáveis e da criação de um snapshot recuperável.

O ZIP é disponibilizado como artefato da execução. Secrets só são passados ao job de inspeção/deploy; eventos de pull request não recebem os secrets de produção.

## Verificação e smoke test em produção

Antes do commit, o workflow consulta status, domínio, variáveis existentes e cria um snapshot pelo endpoint oficial. Depois do commit, ele aguarda `GET /healthz` e `GET /healthz/readiness`, testa o editor, confirma que a API rejeita chamadas sem Bearer, lê o token já configurado sem mostrá-lo e verifica operações PostgreSQL reais.

O smoke test cria dois workflows temporários com nomes `Tarefa 003 smoke ...`, lê os registros de volta, executa um workflow manual, chama um webhook, lê as execuções no PostgreSQL e remove os workflows temporários. As execuções permanecem no histórico normal; esta versão não expõe uma API de exclusão de execuções. O teste não modifica workflows ou credenciais preexistentes. Se uma verificação após o commit falhar, o pipeline solicita a restauração do snapshot pré-deploy e aguarda a saúde antes de encerrar.

O runtime responde em `/healthz` e `/healthz/readiness`. A raiz `/` serve o editor. APIs e webhooks usam `Authorization: Bearer <SQUARED_ACCESS_TOKEN>`. O deploy consulta os logs da Square Cloud, confirma a linha de inicialização do Squared e verifica que o Node observado é 24.

## Logs, métricas e recuperação

O resumo da execução do workflow registra o resultado, tempo de readiness, domínio, tamanho e SHA-256 do artefato, status, uptime e amostras disponíveis. A API não mostra valores de ambiente no resumo.

As métricas documentadas em `GET /v2/apps/{app_id}/metrics?range=24h` têm CPU em percentual e RAM em MB, com uma amostra a cada cinco minutos e cache de até 2,5 minutos. `GET /v2/apps/{app_id}/status` também informa CPU e RAM atuais. O workflow registra:

- CPU e RAM após readiness, como amostra de repouso;
- amostras de inicialização e de execução apenas quando a API fornece timestamps dentro dessas janelas;
- o último ponto histórico após o deploy, se for novo.

A telemetria de cinco minutos pode não registrar um boot curto ou um workflow simples. Nessa situação, o resumo informa que a medição não está disponível. O endpoint documentado não fornece uma contagem de reinicializações; o workflow registra estado, uptime e erros encontrados nos logs disponíveis. Compare o consumo medido em repouso e durante cargas representativas com o limite de 1024 MB antes de avaliar 512 MB.

Cada execução de deploy mantém um artefato inspecionável por 90 dias e cria um snapshot Square Cloud antes de trocar os arquivos. O job tenta restaurar esse snapshot se a nova versão não passar nos checks. Se precisar recuperar manualmente, use **Snapshots** no painel da Square Cloud ou a API documentada `POST /v2/apps/{app_id}/snapshots/restore`, enviando `snapshotId` e `versionId` obtidos de `GET /v2/apps/{app_id}/snapshots` no corpo JSON. A restauração reinicia o app automaticamente.

## Publicação local do ZIP

Requisitos: Node.js 24, npm, `zip` e `unzip`.

```sh
npm ci
npm test
npm run build
SQUARED_MEMORY_MB=1024 npm run package:squarecloud
npm run verify:squarecloud
```

O resultado fica em `dist/squarecloud/squared-squarecloud.zip`; `manifest.json` registra versão, tamanho e hash SHA-256. O empacotamento executa `npm ci --omit=dev` somente no diretório temporário do app e valida o limite oficial de upload de 100 MB.

## Documentação oficial consultada

- [Arquivo `squarecloud.app`](https://docs.squarecloud.app/en/getting-started/config-file)
- [Commit de ZIP numa aplicação](https://docs.squarecloud.app/en/api-reference/endpoint/apps/commit)
- [Leitura das variáveis de ambiente](https://docs.squarecloud.app/en/api-reference/endpoint/apps/envs/get)
- [Status da aplicação](https://docs.squarecloud.app/en/api-reference/endpoint/apps/status)
- [Logs](https://docs.squarecloud.app/en/api-reference/endpoint/apps/logs)
- [Métricas](https://docs.squarecloud.app/en/api-reference/endpoint/apps/metrics)
- [Criação e listagem de snapshots](https://docs.squarecloud.app/en/api-reference/endpoint/apps/snapshots/create)
- [Restauração de snapshot](https://docs.squarecloud.app/en/api-reference/endpoint/apps/snapshots/restore)
