# Medição do motor de workflows

## Executor do Squared

`npm run compatibility:benchmark` foi executado em Node.js `24.19.0` e `26.13.0`, com 60 aquecimentos e 300 amostras por executor. O workflow sintético contém um trigger manual e um node Set; não acessa rede nem storage persistente.

| Node.js | Importação dos módulos | RSS / heap adicional na importação | p50 / p95 por execução do grafo | Vazão ponta a ponta |
| --- | ---: | ---: | ---: | ---: |
| 24.19.0 | 99.910 ms | +28,651,520 / +4,635,536 bytes | 0.060 / 0.163 ms | 12,762 execuções/s |
| 26.13.0 | 102.123 ms | +18,841,600 / +4,640,472 bytes | 0.049 / 0.109 ms | 16,229 execuções/s |

No executor legado, a execução ponta a ponta foi de 124,673 execuções/s no Node 24.19.0 e 147,958 execuções/s no Node 26.13.0; a parte interna do node teve p50 de 0.002 ms nas duas medições.

No Node 24.19.0, a nova medição ficou no intervalo histórico do PR #6 para p50 (`0.053–0.060 ms`) e vazão (`10,779–13,518 execuções/s`); o p95 observado foi `0.163 ms`, abaixo do intervalo anterior de `0.173–0.243 ms`. São amostras locais e a diferença não é uma comparação estatística controlada.

Na onda atual, uma amostra em Node 26.13.0 mediu importação em `105.336 ms`, com `+19,709,952` bytes de RSS e `+4,645,240` bytes de heap. O grafo teve p50/p95 de `0.053/0.112 ms` e vazão de `15,315 execuções/s`. O p50 ficou no limite inferior histórico do PR #6; Node e processo diferem, então isto confirma faixa semelhante, sem provar ganho ou regressão.

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

Nesta rodada, o benchmark do runtime n8n no Node 26.13.0 descobriu o catálogo em 1,173 ms (+20,262,912 bytes de RSS e +3,293,896 bytes de heap). O primeiro Set v3.5 levou 1,406 ms; aquecido, mediu p50/p95 de 0.159/0.331 ms. O primeiro workflow com cinco nodes levou 2,183 ms e adicionou 48,091,136 bytes de RSS e 22,092,472 bytes de heap; aquecido, o p50/p95 foi 5.279/7.848 ms. Após 20 aquecimentos e 100 execuções, o delta do catálogo ficou em +88,891,392 bytes de RSS e +43,761,568 bytes de heap. Duas amostras antes da otimização levaram 3,453–3,555 ms para descobrir o catálogo. A leitura sequencial agora reutiliza listagens de diretórios durante a resolução de caminhos com diferenças de caixa, reduzindo as leituras repetidas sem importar as classes dos 569 nodes.

Uma nova amostra da onda atual, também em Node 26.13.0, descobriu os 444 nodes-base em `691.946 ms` (+20,357,120 bytes RSS; +3,292,816 heap). O primeiro Set v3.5 levou `656.088 ms` (+38,633,472 RSS; +20,658,256 heap); aquecido, p50/p95 foram `0.116/0.194 ms` em 100 execuções. O workflow de cinco nodes levou `1,091.146 ms` no primeiro carregamento (+61,972,480 RSS; +23,012,808 heap); aquecido, p50/p95 foram `3.627/4.308 ms`. Depois de 20 aquecimentos e 100 execuções, o delta do catálogo foi +106,528,768 bytes RSS e +44,701,912 bytes heap. Estes números são uma amostra de um processo; as variações entre as medições Node 26.13.0 anteriores e atuais impedem atribuir diferenças pequenas às mudanças do runtime.

Após a ampliação do contrato de conexões AI, uma nova amostra em Node 26.13.0 descobriu o catálogo em `1,005.192 ms` (+21,053,440 bytes RSS; +3,292,880 heap). O primeiro Set v3.5 levou `822.911 ms` (+40,255,488 RSS; +20,661,440 heap); aquecido, p50/p95 foram `0.138/0.237 ms`. O workflow com cinco nodes levou `1,404.207 ms` no primeiro carregamento (+66,187,264 RSS; +23,010,224 heap); aquecido, p50/p95 foram `4.992/8.572 ms`. Após 20 aquecimentos e 100 execuções, o delta do catálogo foi +112,779,264 bytes RSS e +44,705,056 heap. O carregamento continua lazy e os 100 ciclos não mostraram crescimento desproporcional de heap; os tempos e RSS variam entre processos e não demonstram regressão causada por esta mudança. Como o PR #6 não tinha benchmark de nodes oficiais equivalente, a comparação direta permanece limitada às medições locais descritas acima.

## Limites da medição

Os casos usam entradas pequenas e determinísticas, sem serviços externos. O benchmark do grafo chama o motor diretamente e exclui fila, banco persistente, HTTP server e processo Square Cloud. RSS inclui módulos carregados e alocações daquele processo; não representa uso sustentado ou pico em produção. A amostra multi-node é nova nesta entrega e não há medida equivalente do PR #6. A compatibilidade está registrada separadamente na [matriz e evidências de execução](compatibility-matrix.md).
