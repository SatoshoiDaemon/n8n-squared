# Testes diferenciais contra n8n

## Resultado deste PR

Não foi possível executar testes diferenciais. Nenhum workflow de teste foi criado, importado, executado ou removido na instalação configurada.

O processo leu `.env.codex` sem imprimir valores secretos. `N8N_URL` apontava para `https://n8n.olympusstudio.app/`, mas as respostas públicas `/healthz` e `/` identificaram o serviço como Squared 0.1.0. As tentativas de `POST /rest/login` com as credenciais configuradas e `GET /rest/settings` retornaram HTTP 401. Nenhum `N8N_API_KEY` está configurado. Sem um endpoint n8n autenticado, não foi possível descobrir a versão instalada, os community packages, criar testes controlados ou comparar execuções.

A árvore histórica local aponta `n8n@2.42.7` em `UPSTREAM.md`; os manifests dos dois pacotes de nodes listados na matriz são `2.42.5`. Isso não comprova a versão da instalação de referência.

## O que falta para executar a suíte

Para continuar a verificação diferencial, é necessário apontar `N8N_URL` para a instalação n8n correta e fornecer um método válido de autenticação. Uma API key do n8n é necessária se o acesso público da API for configurado para esse método; uma sessão autenticada também pode ser usada se estiver disponível de forma autorizada. E-mail e senha, sozinhos, não autenticaram o endpoint indicado.

Com acesso, a suíte deve:

1. Descobrir a versão e os manifests de community packages sem modificar workflows existentes.
2. Criar workflows com ID/nome marcados como testes, usando nodes sem efeitos externos e dados determinísticos.
3. Executar os mesmos fixtures no n8n e Squared e comparar JSON por item, portas de saída, erros e metadados relevantes.
4. Excluir somente os workflows temporários criados pela própria suíte, mesmo se uma comparação falhar.
5. Persistir fixtures e resultados sanitizados em `docs/squared/` sem credenciais.

Até esses passos serem repetíveis, nenhum node pode ser marcado como validado por teste diferencial. Os testes atuais são testes locais do parser, grafo, catálogo e endpoints de importação/exportação.
