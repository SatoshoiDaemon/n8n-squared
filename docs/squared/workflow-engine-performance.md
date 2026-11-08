# Medição do motor de workflows

## Executor do Squared

`npm run compatibility:benchmark` foi executado em Node.js `26.13.0`, com 60 aquecimentos e 300 amostras por executor. O workflow sintético contém um trigger manual e um node Set; não acessa rede nem storage persistente.

| Medida | Executor de grafo | Executor legado |
| --- | ---: | ---: |
| Importação dos módulos | 251.255 ms | — |
| RSS / heap / memória externa na importação | +21,778,432 / +4,634,696 / +4,061,656 bytes | — |
| p50 / p95 por execução | 0.063 / 0.344 ms | 0.002 / 0.009 ms de processamento do node |
| Vazão ponta a ponta observada | 7,295 execuções/s | 49,175 execuções/s |
| Vazão do processamento interno do node | — | 226,723 execuções/s |

O resultado anterior do PR #6 foi medido em Node.js `24.19.0`: p50 `0.053–0.060 ms`, p95 `0.173–0.243 ms` e vazão `10,779–13,518 execuções/s` para o grafo. Como versão do Node e medições variam, essa é uma referência histórica, não uma comparação controlada.

## Classes oficiais n8n

`npm run compatibility:benchmark:n8n` mediu carregamento sob demanda e execução com `n8n-nodes-base@2.42.5`, no Windows local, com 100 amostras e 20 aquecimentos. A descoberta lê manifests de 569 tipos, incluindo 444 do pacote base, sem importar cada módulo JavaScript.

| Medida | Set v3.5 | Workflow Set → Date & Time → Crypto → Merge → NoOp |
| --- | ---: | ---: |
| Descoberta do catálogo | 1,169.708 ms | — |
| RSS / heap adicional no catálogo | +13,914,112 / +3,069,224 bytes | — |
| Primeiro carregamento e execução | 1,653.856 ms | 2,542.204 ms |
| RSS / heap no primeiro uso | +37,625,856 / +20,650,656 bytes | +50,782,208 / +22,080,104 bytes |
| Média aquecida | 0.308 ms | 5.378 ms |
| p50 / p95 aquecidos | 0.149 / 1.106 ms | 4.060 / 11.239 ms |
| Vazão observada | 3,234 execuções/s | 186 execuções/s |
| RSS / heap após aquecimento, delta do catálogo | +40,169,472 / +20,899,936 bytes | +95,727,616 / +43,676,352 bytes |

O workflow multi-node conecta dois inputs ao Merge. O primeiro uso inclui importação da classe e dependências. Os valores são amostras do processo, não dimensionamento de Square Cloud. O benchmark do PR #6 usava Node 24 e um único Set; ele não é comparável diretamente com estas medições em Node 26. Repita a medição no runtime e perfil de memória do ambiente de produção.

## Limites da medição

Os casos usam entradas pequenas e determinísticas, sem serviços externos. O benchmark do grafo chama o motor diretamente e exclui fila, banco persistente, HTTP server e processo Square Cloud. RSS inclui módulos carregados e alocações daquele processo; não representa uso sustentado ou pico em produção. A amostra multi-node é nova nesta entrega e não há medida equivalente do PR #6. A compatibilidade está registrada separadamente na [matriz e evidências de execução](compatibility-matrix.md).
