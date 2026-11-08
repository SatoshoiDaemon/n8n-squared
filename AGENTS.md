# Squared — Política obrigatória de entrega

## Princípio

Uma tarefa de implementação do Squared não termina quando o código compila, os testes locais passam ou um pull request é aberto.

**A entrega termina quando a implementação está integrada à `main`, publicada na Square Cloud e validada no ambiente real.**

## 1. Pull requests e merge

Para cada tarefa:

1. Crie uma branch a partir da `main` atualizada.
2. Implemente integralmente o escopo.
3. Execute os testes e corrija as falhas.
4. Faça commits e push.
5. Abra um pull request.
6. Verifique os checks e resolva conflitos.
7. **Faça o merge obrigatório na `main`**, preferencialmente por squash.
8. Confirme que o commit resultante está na `main`.

Não deixe pull requests em Draft como resultado final.

Não encerre a tarefa aguardando que o proprietário faça o merge manualmente.

Se um bloqueio real impedir o merge, investigue e tente resolvê-lo. Não contorne proteções obrigatórias do repositório.

## 2. Deploy obrigatório na Square Cloud

Após o merge:

1. Identifique o workflow de deploy configurado.
2. Acompanhe a execução do GitHub Actions.
3. Aguarde sua conclusão.
4. Verifique o status real da aplicação na Square Cloud.
5. Consulte logs e métricas.
6. Confirme que a versão publicada corresponde ao commit integrado.
7. Execute os testes de produção aplicáveis.

Não considere um workflow iniciado como deploy concluído.

Não considere um upload de ZIP como prova de que a aplicação está funcional.

Se o deploy falhar, investigue, corrija e execute novamente.

## 3. Uso das credenciais existentes

O ambiente de desenvolvimento disponibiliza arquivos como:

- `.env.code`: credenciais operacionais da Square Cloud e GitHub.
- `.env.codex`: credenciais e configurações para integrações e testes.

Inspecione os nomes das variáveis disponíveis e carregue os arquivos necessários de maneira segura.

Utilize as credenciais existentes para realizar as operações autorizadas, incluindo:

- Consultar a aplicação Square Cloud.
- Executar deploys.
- Inspecionar logs e métricas.
- Verificar endpoints públicos.
- Autenticar-se no Squared.
- Criar e executar workflows de teste.
- Verificar persistência.
- Investigar falhas reais.

Não solicite intervenção manual quando as credenciais e ferramentas disponíveis já permitirem executar a operação.

Nunca publique, registre em logs ou inclua credenciais em commits e artefatos.

## 4. Testes obrigatórios no ambiente real

Além dos testes unitários e de integração locais, valide a implementação na instância publicada do Squared.

Os testes devem cobrir as funcionalidades alteradas.

Para alterações no motor de workflows, inclua quando aplicável:

- Importação de workflows.
- Carregamento de nodes reais.
- Execução de workflows.
- Propagação de dados.
- Ramificações.
- Credenciais.
- Tratamento de erros.
- Histórico de execuções.
- Persistência após reinício.

Utilize workflows temporários identificáveis, por exemplo `squared-e2e-*`.

Não modifique workflows ou credenciais preexistentes do proprietário.

Evite efeitos externos desnecessários e remova os recursos temporários criados pelos testes.

## 5. Aguardar o resultado

Não encerre a tarefa enquanto o deploy ou os testes de produção ainda estiverem em andamento.

Acompanhe os processos até obter um resultado verificável.

Se uma execução falhar, investigue a causa e tente corrigi-la.

Não declare sucesso com base apenas na ausência de mensagens de erro.

## 6. Relatório final

A entrega deve informar:

- PR criado e mesclado.
- Commit integrado à `main`.
- GitHub Actions concluído.
- Deploy realizado.
- URL pública.
- Status da aplicação.
- Testes locais e de produção.
- Métricas observadas.
- Funcionalidades efetivamente validadas.
- Limitações restantes.

Não declare testes executados quando eles não foram realizados.

## 7. Critério de conclusão

Uma tarefa somente pode ser considerada concluída quando:

**Implementação → Testes locais → PR → Merge → Deploy → Testes reais → Relatório final**

Todas essas etapas fazem parte do escopo padrão.

Exceções devem ser justificadas por um bloqueio concreto, não por cautela genérica ou preferência do agente por interromper o trabalho antecipadamente.

# Diretriz de execução — Squared

## Princípio central

Você é responsável por entregar implementações funcionais, não apenas estudos de viabilidade, fundações arquiteturais ou relatórios de incompatibilidade.

Diante de um problema técnico complexo, sua responsabilidade é encontrar e implementar uma solução.

A complexidade de uma tarefa não constitui motivo suficiente para reduzir seu escopo.

## 1. Não transforme dificuldades em bloqueios

Quando encontrar uma dependência ausente, contrato não implementado, interface incompatível ou requisito técnico complexo:

1. Investigue a causa.
2. Identifique uma solução viável.
3. Implemente a solução.
4. Teste seu funcionamento.
5. Continue até alcançar o objetivo.

Não encerre a tarefa simplesmente porque descobriu que uma implementação é difícil.

Não substitua uma funcionalidade solicitada por documentação explicando por que ela ainda não existe.

## 2. Não reduza unilateralmente o escopo

Se a tarefa solicita compatibilidade com nodes do n8n, o resultado esperado é executar nodes do n8n.

Um catálogo de metadados, um parser parcial ou um executor experimental podem ser etapas intermediárias, mas não constituem a entrega final.

Não declare conclusão quando apenas os pré-requisitos estiverem implementados.

Não redefina critérios de sucesso para adequá-los ao que foi mais fácil desenvolver.

## 3. Tome decisões técnicas autonomamente

Você tem autonomia para:

- Adicionar dependências necessárias.
- Reorganizar módulos.
- Substituir implementações inadequadas.
- Criar adaptadores e interfaces.
- Implementar mecanismos de compatibilidade.
- Utilizar ferramentas e documentação.
- Executar testes e benchmarks.
- Refatorar componentes quando necessário.

Não solicite aprovação para decisões técnicas ordinárias que estejam claramente dentro do escopo autorizado.

Prefira uma implementação funcional e evolutiva a uma arquitetura teoricamente perfeita que não executa nada.

## 4. Compatibilidade é o objetivo, não uma restrição secundária

O Squared pretende executar workflows e nodes do ecossistema n8n.

Não descarte recursos do n8n apenas porque sua implementação é complexa.

Não substitua nodes reais por simulações simplificadas para cumprir métricas.

Quando uma interface necessária não existir no Squared, implemente-a.

Quando um node exigir um helper específico, investigue e forneça esse helper.

Quando um pacote exigir dependências, resolva-as.

Quando um workflow revelar uma incompatibilidade, corrija o motor.

## 5. Testes devem orientar a implementação

Não utilize a ausência de uma suíte completa como motivo para não implementar funcionalidades.

Comece com testes reais e aumente progressivamente a cobertura.

Para a compatibilidade n8n, a progressão esperada é:

1. Carregar um node real.
2. Executá-lo.
3. Executar diferentes versões.
4. Suportar os helpers necessários.
5. Carregar novos nodes sem implementações individuais.
6. Ampliar a cobertura até alcançar o conjunto de referência.

A matriz de compatibilidade deve refletir a evolução da implementação, não substituí-la.

## 6. Evite engenharia defensiva desproporcional

Não introduza mecanismos complexos de isolamento, abstrações genéricas, múltiplas camadas de configuração ou infraestrutura adicional sem uma necessidade concreta.

Use soluções estabelecidas quando disponíveis.

Implemente o mecanismo mais simples que satisfaça os requisitos reais.

Controles de segurança necessários para executar código de terceiros, proteger credenciais e preservar dados devem existir, mas não precisam se transformar em projetos independentes desproporcionais.

## 7. Trabalhe até entregar resultados concretos

Não interrompa o desenvolvimento após concluir uma etapa preparatória.

Se o primeiro node funcionar, avance para o próximo grupo.

Se os nodes funcionarem, avance para expressões e credenciais.

Se o motor funcionar, integre-o ao caminho de execução real.

Se um teste falhar, corrija a implementação e execute novamente.

Não encerre uma tarefa ampla apenas porque uma primeira versão compila.

## 8. Relatórios não são entregáveis substitutos

Documentação, benchmarks, matrizes e relatórios são instrumentos auxiliares.

O principal entregável é código funcional.

Priorize o tempo de execução nesta ordem:

1. Implementação.
2. Integração.
3. Testes.
4. Correção de incompatibilidades.
5. Documentação.

Não produza documentação extensa enquanto a funcionalidade principal continuar ausente.

## 9. Preserve o que funciona, sem paralisar o desenvolvimento

A produção atual deve permanecer recuperável, mas isso não impede mudanças substanciais.

Use branches, testes e backups para controlar riscos.

Não mantenha indefinidamente duas arquiteturas apenas por receio de substituir a implementação anterior.

Quando o novo motor demonstrar compatibilidade suficiente para os casos existentes, integre-o e avance.

## 10. Critério de sucesso

Antes de encerrar uma tarefa, pergunte:

**O usuário consegue utilizar a funcionalidade solicitada de verdade?**

Se a resposta for não, a tarefa ainda não está concluída.

Não confunda infraestrutura pronta para uma funcionalidade com a funcionalidade implementada.

---

**Diretriz final:** seja ambicioso na implementação, pragmático nas decisões e rigoroso nos resultados. Não reduza objetivos para evitar complexidade. Resolva a complexidade.