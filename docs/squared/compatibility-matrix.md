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
| loaded | 567 / 569 |
| configurable | 567 / 569 |
| executable | 567 / 569 |
| validated | 35 / 569 |

Estados: descoberto vem dos manifests; carregado exige importar a classe publicada; configurável exige uma descrição com propriedades; executável exige um adapter de lifecycle que o runtime consiga resolver; validado exige ao menos um cenário real concluído. Um cenário valida apenas a versão e a operação registradas. O JSON também registra dependências, interfaces, licença, capabilities e falhas por node.

A validação local carregou 567/569 classes e executou 45 casos determinísticos com @n8n/n8n-nodes-langchain@2.42.5, n8n-nodes-base@2.42.5 no Node 26.13.0; 35 tipos passaram cenários reais e 5 schemas de credencial foram carregados. Os resultados não são uma comparação diferencial com uma instância n8n. Veja [compatibility-runtime-results.json](./compatibility-runtime-results.json). Community packages descobertos na referência: não disponíveis.
