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
