# Matriz de compatibilidade de nodes

Gerada a partir da árvore histórica indicada em [UPSTREAM.md](../../UPSTREAM.md), com evidência de execução de módulos npm reais quando disponível. O snapshot registra n8n 2.42.7, mas os manifests dos pacotes abaixo têm versões próprias.

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
| loaded | 32 / 569 |
| configurable | 32 / 569 |
| executable | 32 / 569 |
| validated | 32 / 569 |

O JSON ao lado registra cada node dos manifests com tipo de execução, versão, dependências detectadas, interfaces, licença e evidência por teste. Nodes com status executável foram carregados do pacote publicado e executaram seu próprio método; nomes e metadados sem uma execução aprovada permanecem como descobertos.

A validação local executou 42 casos determinísticos usando n8n-nodes-base@2.42.5, marcou 32 tipos como validados e carregou 4 schemas de credencial. Os resultados não são uma comparação diferencial com uma instância n8n. Veja [compatibility-runtime-results.json](./compatibility-runtime-results.json). Community packages descobertos na referência: não disponíveis.
