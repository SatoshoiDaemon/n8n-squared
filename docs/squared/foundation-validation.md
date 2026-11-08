# Validação da fundação

> Registro histórico do runtime baseado no n8n. Os números e comandos abaixo não descrevem o Squared 0.1.0: a reconstrução em `src/` substituiu esse caminho, removeu o ZIP de 46 workspaces e não usa o build Turbo. Use `docs/squared/architecture.md` e `docs/squared/square-cloud.md` para o estado atual.

Base: n8n 2.42.7. A validação abaixo foi feita localmente em Node.js 24.19.0 e pnpm 12.4.2, com dados de teste em diretórios temporários isolados.

| Verificação | Resultado |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passou |
| `pnpm build` | Passou; 71 tarefas do Turbo |
| `pnpm --filter @n8n/config test` | Passou; 235 testes |
| `pnpm --filter @n8n/config lint` | Passou |
| `pnpm package:squarecloud` | Passou; 46 pacotes internos, ZIP de 80.834.428 bytes (SHA-256: `1608868e6bb11686f1728a50965b72e7b07a4f760415e7b5590f621c0af52e11`) |
| `pnpm smoke:squarecloud` | Passou; instala o ZIP em diretório limpo, inicia backend, confirma readiness e editor HTTP 200, importa e executa um workflow |
| `pnpm lint` | Interrompido por instabilidade local associada à execução do ESLint; não há resultado de lint completo. Não repetir neste ambiente sem nova orientação. |

O smoke automatizado cria uma conta proprietária fictícia apenas no banco temporário para permitir a importação e a execução pelo CLI. Ele não usa dados da instância local do usuário.

**Pendente:** deploy real na Square Cloud, instalação gerenciada observada nos logs hospedados, publicação web e persistência após reinicialização. Nenhuma conta ou credencial da Square Cloud foi usada nesta validação. O n8n 2.42.7 emite um aviso de que instalações fora da imagem oficial podem ser descontinuadas em versões futuras; isso não impediu a execução desta base, mas deve ser reavaliado em cada atualização do upstream.
