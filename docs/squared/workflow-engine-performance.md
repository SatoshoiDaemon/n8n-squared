# Medição do motor de workflows

## Executor do Squared

`npm run compatibility:benchmark` foi executado em Node.js `24.19.0` e `26.13.0`, com 60 aquecimentos e 300 amostras por executor. O workflow sintético contém um trigger manual e um node Set; não acessa rede nem storage persistente.

| Node.js | Importação dos módulos | RSS / heap adicional na importação | p50 / p95 por execução do grafo | Vazão ponta a ponta |
| --- | ---: | ---: | ---: | ---: |
| 24.19.0 | 99.910 ms | +28,651,520 / +4,635,536 bytes | 0.060 / 0.163 ms | 12,762 execuções/s |
| 26.13.0 | 102.123 ms | +18,841,600 / +4,640,472 bytes | 0.049 / 0.109 ms | 16,229 execuções/s |

No executor legado, a execução ponta a ponta foi de 124,673 execuções/s no Node 24.19.0 e 147,958 execuções/s no Node 26.13.0; a parte interna do node teve p50 de 0.002 ms nas duas medições.

No Node 24.19.0, a nova medição ficou no intervalo histórico do PR #6 para p50 (`0.053–0.060 ms`) e vazão (`10,779–13,518 execuções/s`); o p95 observado foi `0.163 ms`, abaixo do intervalo anterior de `0.173–0.243 ms`. São amostras locais e a diferença não é uma comparação estatística controlada.

## Classes oficiais n8n

`npm run compatibility:benchmark:n8n` mediu carregamento sob demanda e execução com `n8n-nodes-base@2.42.5`, no Windows local e no Node 24.19.0, com 100 amostras e 20 aquecimentos. A descoberta lê manifests de 569 tipos, incluindo 444 do pacote base, sem importar cada módulo JavaScript.

| Medida | Set v3.5 | Workflow Set → Date & Time → Crypto → Merge → NoOp |
| --- | ---: | ---: |
| Descoberta do catálogo | 580–3,947 ms | — |
| RSS / heap adicional no catálogo | +13.7–19.6 / +3.16 MB | — |
| Primeiro carregamento e execução | 739–2,014 ms | 1,149–4,061 ms |
| RSS / heap no primeiro uso | +35.4–37.6 / +20.85 MB | +57.5–59.7 / +22.08 MB |
| Média aquecida | 0.157–0.772 ms | 3.437–4.177 ms |
| p50 / p95 aquecidos | 0.141–0.234 / 0.217–0.932 ms | 3.177–3.803 / 4.796–6.559 ms |
| Vazão observada | 1,287–6,328 execuções/s | 239–290 execuções/s |
| RSS / heap após 20 aquecimentos + 100 execuções, delta do catálogo | +37.1–41.4 / +21.14–21.23 MB | +97.4–120.7 / +43.92 MB |

As faixas do Node 24.19.0 vêm de três processos independentes com o mesmo pacote. A descoberta e o primeiro carregamento variaram bastante; a execução aquecida também teve um outlier. Um processo separado no Node 26.13.0 mediu descoberta em 418 ms, Set em p50/p95 de 0.135/0.222 ms e workflow multi-node em p95 de 3.555 ms. O workflow multi-node conecta dois inputs ao Merge e o primeiro uso inclui importação das classes e dependências. Essas amostras locais não são dimensionamento de Square Cloud nem comparação controlada entre versões. O PR #6 não tinha benchmark equivalente de carregamento de nodes oficiais.

## Limites da medição

Os casos usam entradas pequenas e determinísticas, sem serviços externos. O benchmark do grafo chama o motor diretamente e exclui fila, banco persistente, HTTP server e processo Square Cloud. RSS inclui módulos carregados e alocações daquele processo; não representa uso sustentado ou pico em produção. A amostra multi-node é nova nesta entrega e não há medida equivalente do PR #6. A compatibilidade está registrada separadamente na [matriz e evidências de execução](compatibility-matrix.md).
