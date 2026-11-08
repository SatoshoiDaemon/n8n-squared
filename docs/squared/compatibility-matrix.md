# Matriz de compatibilidade de nodes

Gerada a partir da árvore histórica indicada em [UPSTREAM.md](../../UPSTREAM.md). O snapshot registra n8n 2.42.7, mas os manifests dos pacotes abaixo têm versões próprias. A URL configurada para a instalação de referência responde como Squared 0.1.0 e não permite validar uma instalação n8n.

## Pacotes de referência

| Pacote | Versão do manifest | Nodes descobertos |
| --- | ---: | ---: |
| `n8n-nodes-base` | 2.42.5 | 444 |
| `@n8n/n8n-nodes-langchain` | 2.42.5 | 125 |

| Pacote | Versão do manifest | Credenciais descobertas |
| --- | ---: | ---: |
| `n8n-nodes-base` | 2.42.5 | 410 |
| `@n8n/n8n-nodes-langchain` | 2.42.5 | 38 |

## Etapas

| Estado | Cobertura |
| --- | ---: |
| discovered | 569 / 569 |
| loaded | 0 / 569 |
| configurable | 0 / 569 |
| executable | 0 / 569 |
| validated | 0 / 569 |

O JSON ao lado contém um registro por entrada de node nos manifests, com tipo de execução inferido estaticamente, versão encontrada no source, dependências externas detectadas na closure local do source, imports diretos do arquivo de entrada, interfaces reconhecidas, licença declarada e falhas conhecidas. As dependências declaradas no manifest aparecem uma vez por pacote no resumo. A inferência estática não conta como carregamento ou teste.

Não há nodes carregados, configuráveis, executáveis ou validados nesta matriz. O catálogo externo ainda não está instalado no runtime e o código dos nodes não é importado pelo processo Squared. Isso evita marcar nomes/metadados como compatibilidade executável. Community packages: não descobertos; a instância de referência não disponibiliza sua lista autenticada.
