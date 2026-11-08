# AGENTS.md — n8n-squared

## Missão

O **n8n-squared** é uma plataforma de automação feita **para a Square Cloud**, construída a partir do código-fonte do n8n. O n8n é **matéria-prima**, não um produto cuja arquitetura, interface, histórico ou compatibilidade devam ser preservados por padrão.

A prioridade é entregar uma aplicação Node.js simples de desenvolver, executar e hospedar na Square Cloud, com integrações nativas, experiência própria e baixo consumo de recursos.

## Princípios de decisão

1. **Preserve apenas o que agrega valor ao Squared.** Reutilize código funcional quando conveniente; simplifique, substitua ou remova o restante. Não mantenha módulos por fidelidade ao n8n original.
2. **Remova funcionalidades desnecessárias por completo**, incluindo componentes, rotas, estados, serviços e dependências exclusivos, quando seguro. Não se limite a esconder elementos na interface. Exemplos de candidatos: questionários de onboarding, promoções do n8n Cloud, pesquisas e fluxos comerciais sem utilidade no Squared.
3. **Priorize implementações diretas e proporcionais.** Não introduza camadas, serviços, filas, abstrações, bancos, mecanismos transacionais ou processos adicionais sem uma necessidade concreta da tarefa.
4. **Não transforme possibilidades em bloqueios.** Riscos hipotéticos, divergências do upstream e melhorias opcionais não devem impedir a entrega solicitada. Registre observações brevemente quando forem relevantes e prossiga.
5. **Não presuma compatibilidade integral com o n8n como requisito.** Preserve comportamentos e formatos somente quando úteis ao produto ou explicitamente exigidos pela tarefa.
6. **Resolva a causa do problema.** Evite workarounds, flags e caminhos paralelos quando a implementação pode ser simplificada diretamente.
7. **Execute, não apenas planeje.** Investigue o código, implemente, teste e entregue. Pergunte somente quando faltar uma decisão indispensável que não possa ser inferida com segurança.

## Direção técnica

- **Runtime:** Node.js, adequado ao modelo de aplicações da Square Cloud; preferir um processo simples e um comando convencional como `npm start` quando isso atender à implementação.
- **Distribuição:** aplicação enviada por **ZIP**. A Square Cloud configura URL, RAM, arquivo principal/runtime e comando de inicialização. Não invente infraestrutura de deploy alternativa.
- **Estrutura:** buscar uma base enxuta, idealmente organizada em `src/`, sem obrigação de preservar o monorepo ou os workspaces originais. A organização deve servir ao código, não o contrário.
- **Build:** não impor uma etapa de build se ela não for necessária. Código executável diretamente é aceitável; compile apenas os componentes que efetivamente precisarem, como assets do editor.
- **Memória:** meta de operação entre **512 MB e 1024 MB** em cenários adequados. Investigue bootstrap, processos, carregamento de nodes, caches e retenção de objetos. Meça antes/depois de otimizações; não confunda tamanho de código com consumo de RAM.
- **Persistência:** manter os dados e segredos necessários ao funcionamento correto, usando serviços externos ou persistentes quando apropriado ao ambiente da Square Cloud.
- **Interface:** identidade própria do Squared, português brasileiro, temas, fluxo de primeiro acesso enxuto e remoção de referências comerciais desnecessárias ao n8n Cloud.
- **Integrações:** priorizar Square Cloud Applications, Blob, gateway de IA e Discord, inclusive bots conectados ao Gateway e eventos persistentes quando a tarefa envolver isso.

Essas são direções de produto, **não pré-requisitos que precisam ser implementados antes de cada tarefa**. Trabalhe no escopo solicitado.

## Git e colaboração

1. **Toda tarefa que modifica o repositório deve começar em uma branch nova**, com nome descritivo e coerente com o trabalho. Exemplos: `feat/square-blob`, `refactor/runtime-bootstrap`, `remove/n8n-onboarding`, `fix/discord-gateway`.
2. Antes de criar a branch, verifique o estado do Git e a branch atual. **Não descarte nem sobrescreva alterações preexistentes**. Se houver trabalho não relacionado, preserve-o e isole a tarefa de maneira segura.
3. Faça commits claros, pequenos quando fizer sentido, contendo apenas mudanças relacionadas à tarefa.
4. **O agente está autorizado a fazer commit, push, abrir ou atualizar pull requests, gerar releases e realizar deploys** quando isso fizer parte do trabalho solicitado ou for o próximo passo operacional necessário. Não adote proibições genéricas de push ou deploy.
5. Use os remotes, credenciais, workflows e ferramentas disponíveis no ambiente. Não exponha tokens, chaves ou segredos em commits, logs ou respostas.
6. Não faça merge na branch principal nem altere produção destrutivamente sem necessidade ou autorização contextual. Prefira branch e PR para integrar mudanças; se a tarefa pedir integração ou deploy, execute o fluxo correspondente.
7. Ao concluir, informe branch, commits, testes executados, push/PR/deploy realizado e eventuais impedimentos reais.

## Fluxo de trabalho esperado

1. Entenda a solicitação e examine **somente** os arquivos e dependências relevantes.
2. Crie a branch de trabalho antes das alterações.
3. Implemente a solução mais simples que atenda ao objetivo, removendo código obsoleto quando pertinente.
4. Execute verificações proporcionais à mudança: testes focados, lint, typecheck, inicialização ou smoke test conforme aplicável. Não transforme a suíte completa em bloqueio automático para alterações pequenas.
5. Corrija falhas introduzidas pela tarefa. Diferencie falhas preexistentes de regressões.
6. Faça commit e, quando pertinente, push, PR e deploy usando o fluxo disponível.
7. Resuma o que mudou e como foi validado, sem longas justificativas sobre decisões já estabelecidas.

## O que evitar

- Tratar o Squared como um fork convencional que deve acompanhar o upstream.
- Defender a manutenção de componentes apenas porque existem no n8n.
- Propor reescrita completa do motor sem motivo concreto; reaproveitar o que funciona é tão válido quanto remover o que não serve.
- Criar requisitos bloqueantes não solicitados ou pedir aprovação para escolhas triviais.
- Transformar deploy por ZIP, `npm start` ou práticas comuns da Square Cloud em projetos de infraestrutura complexos.
- Acrescentar ressalvas genéricas e debates paralelos em vez de implementar.
- Confundir uma meta de arquitetura com obrigação de refatorar todo o repositório antes de entregar uma funcionalidade.

**Regra central:** o Squared não existe para preservar o n8n; o código do n8n existe, neste repositório, para acelerar a construção do Squared.
