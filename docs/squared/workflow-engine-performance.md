# Medição do motor de workflows

## Amostra

Medições locais em Node.js `24.19.0`, com `npm run compatibility:benchmark`, 60 aquecimentos e 300 amostras por motor em cada execução do script. Duas execuções consecutivas estão resumidas abaixo. O workflow determinístico contém um trigger manual e um node Set que copia `$json.value` para `result`. O armazenamento do motor legado é em memória. O benchmark também importa o executor TypeScript, parser, formato e catálogo de metadados e mede o delta de memória do processo.

| Medida | Executor de grafo | Executor atual |
| --- | ---: | ---: |
| Amostras por execução do script | 300 | 300 |
| Tempo médio por execução | 0.073–0.092 ms | 0.004–0.009 ms de duração interna do node |
| p50 | 0.053–0.060 ms | 0.002 ms |
| p95 | 0.173–0.243 ms | 0.007–0.015 ms |
| Vazão observada | 10,779–13,518 execuções/s ponta a ponta | 71,313–90,359 execuções/s ponta a ponta |
| Tempo total | 22.192–27.833 ms | 3.320–4.207 ms |

Importar os módulos demorou `114.478–125.673 ms`. O delta RSS depois da coleta de lixo foi `+17,612,800–19,857,408` bytes (~16.8–18.9 MiB), heap usado `+4,566,384` bytes (~4.35 MiB) e memória externa `+9,996,564` bytes (~9.53 MiB).

## Limites da medição

É uma amostra sintética de um item e dois nodes, sem rede, storage SQLite, binários, pacotes de nodes ou execução sustentada. A vazão do grafo mede chamadas sequenciais a `execute`; a vazão legada mede submissão de uma fila e `drain`. A duração interna do node legado mede apenas o processamento do node. O delta RSS/heap é uma medida de um processo e não representa baseline ou estado sustentado em produção. O executor de grafo ainda não é usado na produção.

Esses números caracterizam apenas o custo e o desempenho desta implementação local. Não demonstram capacidade de memória de produção, compatibilidade, nem uma meta de RAM. Rode `npm run compatibility:benchmark` novamente no ambiente-alvo antes de usar esses valores para dimensionamento.

## Pacote real de nodes n8n

Uma amostra separada foi executada com Node.js `24.19.0` e o pacote npm externo `n8n-nodes-base@2.42.5`, usando `npm run compatibility:benchmark:n8n` e 100 execuções medidas de um workflow real com `Set` v3.5. A inicialização do catálogo percorreu 444 nodes sem importar seus módulos JavaScript; o primeiro uso importou o node e dependências sob demanda.

| Medida | Resultado observado |
| --- | ---: |
| Catálogo: duração | 193.328 ms |
| Catálogo: delta RSS / heap | +6,041,600 / +2,546,424 bytes |
| Primeiro import e execução de Set v3.5 | 819.375 ms |
| Primeiro import: delta RSS / heap | +41,230,336 / +21,961,240 bytes |
| Set aquecido: média / p50 / p95 | 0.130 / 0.111 / 0.207 ms |
| Set aquecido: vazão sequencial | 7,658 execuções/s |

O delta RSS/heap aquecido foi +41,873,408 / +22,257,856 bytes em relação à amostra após catálogo. Uma só execução de benchmark não é baseline de produção: RSS inclui dependências carregadas por `Set`, o ambiente era Windows local e o pacote permaneceu externo. Repita no alvo Square Cloud e com os pacotes instalados que pretende oferecer antes de dimensionar uma instância de 1024 MB.
