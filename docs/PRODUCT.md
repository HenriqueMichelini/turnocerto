# TurnoCerto — requisitos do produto

O TurnoCerto permite criar, manter, consultar e compartilhar escalas de trabalho semanais. A primeira versão pública atende ao Brasil, com interface em português brasileiro. Seu núcleo é uma programação recorrente com alterações em datas específicas. O produto não inclui folha de pagamento, controle de ponto, cálculo de horas, aprovação de afastamentos ou funções de planilha genérica.

A escolha de acesso sem cadastro obrigatório está registrada em [ADR 0001 — Acesso por links](adr/0001-acesso-por-links.md). A arquitetura proposta está registrada em [ADR 0002 — Aplicação na Cloudflare](adr/0002-aplicacao-na-cloudflare.md).

## Termos do produto

- **Espaço de gestão:** conjunto de escalas e pessoas compartilhadas sob o mesmo acesso de gestão.
- **Escala:** programação de trabalho de um grupo, organizada por semanas e associada a um fuso horário.
- **Semana:** período de segunda-feira a domingo, identificado por suas datas.
- **Pessoa:** identidade compartilhada entre as escalas de um Espaço de gestão.
- **Participação:** vínculo de uma pessoa com uma escala durante um período definido por datas.
- **Jornada:** período de trabalho com início, fim e, opcionalmente, um intervalo.
- **Estado especial:** alternativa à jornada em uma data; os estados iniciais são Folga, Férias, Ausência e Atestado.
- **Não definido:** dia de participação ainda sem jornada ou estado especial; não equivale a Folga.
- **Padrão recorrente:** programação semanal habitual de uma pessoa, que pode mudar a partir de uma semana determinada.
- **Exceção:** alteração de uma ou mais datas específicas que prevalece sobre o padrão recorrente nessas datas.
- **Link de gestão:** acesso privado que permite editar um Espaço de gestão.
- **Link de leitura:** acesso revogável para consultar um período fixo de uma escala, sem permissão para editá-la.

## Requisitos funcionais

### Escalas e pessoas

1. Quem possui o link de gestão pode criar, nomear, consultar e excluir escalas, além de cadastrar, renomear, ordenar e arquivar pessoas e excluir todo o Espaço de gestão mediante confirmação explícita.
2. Uma pessoa pode participar de várias escalas, inclusive no mesmo período. A entrada e a saída de cada participação podem ocorrer em qualquer data da semana.
3. É possível abrir qualquer semana de uma escala e consultar a programação correspondente àquele período.
4. O fuso horário é definido ao criar a escala, com o fuso de quem a cria sugerido inicialmente. Esse fuso determina a semana atual e quando uma semana passa a ser considerada passada, tanto para edição quanto para leitura.

### Programação

5. É possível atribuir jornadas e estados especiais a uma data ou a várias datas selecionadas, sem editar cada dia separadamente.
6. Ao editar uma semana atual ou futura, quem edita escolhe entre aplicar a alteração apenas às datas selecionadas ou alterar o padrão recorrente desde a semana aberta. Ao editar uma semana passada, somente alterações pontuais são permitidas.
7. Uma semana é apresentada a partir do padrão recorrente válido para suas datas, com as exceções daquela semana aplicadas sobre ele.
8. Uma escala pode ser salva, compartilhada ou exportada mesmo que contenha dias “Não definido”. Antes de compartilhar ou exportar, o produto avisa que há dias sem definição.
9. Ao salvar jornadas sobrepostas da mesma pessoa, inclusive entre escalas diferentes ou após a meia-noite, o produto avisa sobre o conflito e permite continuar.

### Acesso, leitura e exportação

10. A criação e a edição não exigem cadastro. Um link privado de gestão dá acesso às escalas e ao cadastro compartilhado de pessoas de um Espaço de gestão; qualquer pessoa com esse link pode editar.
11. O link de gestão pode ser substituído, invalidando o anterior. A primeira versão não oferece recuperação por e-mail; perder o link implica perder o acesso de edição.
12. Quem edita pode criar e revogar links de leitura separados por escala. Cada link cobre de uma a quatro semanas consecutivas, escolhidas no momento da criação. As datas cobertas não avançam automaticamente, e o link permanece válido até ser revogado.
13. O link de leitura dispensa conta, mostra as alterações posteriores feitas nas semanas cobertas e permite exportar cada uma delas. Não dá acesso às demais semanas nem permite editar.
14. Se outra pessoa alterou a escala desde que o editor a abriu, uma tentativa de salvar a versão desatualizada é bloqueada com aviso. Não há edição colaborativa em tempo real na primeira versão.
15. A primeira versão exporta uma semana completa por arquivo, em PDF paginado ou PNG longo, tanto para quem edita quanto para quem possui um link de leitura que inclua aquela semana. O arquivo inclui todas as pessoas da semana sem reduzir o conteúdo a uma página ilegível.

## Regras de negócio

### Participação e histórico

- Cada pessoa tem, em cada data de participação de cada escala, uma jornada, um único estado especial ou “Não definido”. Fora do período de participação, o dia não é tratado como Folga nem como “Não definido”.
- Encerrar uma participação retira a pessoa daquela escala a partir da data escolhida, preservando as semanas anteriores.
- Arquivar uma pessoa encerra suas participações em todas as escalas a partir da data escolhida e preserva o histórico. Uma pessoa arquivada não é fisicamente excluída.
- A identidade da pessoa permanece a mesma entre escalas e semanas. Renomeá-la ou mudar sua ordem em uma escala atualiza a apresentação das semanas antigas, sem alterar as jornadas registradas.
- Excluir uma escala inteira remove imediatamente seus dados ativos e invalida todos os links de leitura daquela escala. O link de gestão continua válido para as demais escalas.
- Excluir um Espaço de gestão remove imediatamente seus dados ativos, inclusive todas as escalas, pessoas, links e revisões técnicas.
- Dados de escalas ou Espaços de gestão excluídos podem permanecer na recuperação pontual do D1 Free por até sete dias; uma restauração não pode reativá-los. Fora dessa janela, a exclusão é definitiva.
- Um Espaço de gestão inativo permanece disponível até ser excluído por quem possui o link de gestão; não há exclusão automática por inatividade na primeira versão.

### Jornadas e estados

- Uma jornada pode terminar no dia seguinte e tem duração máxima de 24 horas. Início e fim no mesmo horário representam uma jornada de 24 horas.
- O intervalo é opcional e único. Quando informado, deve ter duração positiva e estar inteiramente dentro da jornada, inclusive se atravessar a meia-noite.
- Horários incompletos ou incoerentes não podem ser salvos. A sobreposição entre jornadas diferentes gera aviso, mas não impede salvar.
- Jornada e estado especial não coexistem na mesma data. Apenas Folga pode fazer parte do padrão recorrente; Férias, Ausência e Atestado são sempre associados a datas específicas.

### Recorrência e exceções

- Uma alteração pontual cria ou atualiza a exceção das datas selecionadas, sem modificar o padrão recorrente.
- Uma alteração recorrente passa a valer para as pessoas e os dias da semana selecionados desde a segunda-feira da semana aberta. Ela pode começar na semana atual ou em uma semana futura, nunca em uma semana passada.
- Se a alteração recorrente começa na semana atual, alcança também os dias já transcorridos dessa semana. Semanas anteriores mantêm a regra que era válida nelas; correções pontuais posteriores continuam possíveis.
- Uma exceção prevalece sobre o padrão recorrente enquanto existir. Se a mudança de padrão alcançar exceções futuras, quem edita escolhe entre preservá-las ou removê-las somente nas pessoas e nos dias afetados. A opção inicial é preservar.

### Informações compartilhadas

- Em links de leitura e em todo PDF ou PNG exportado, o estado Atestado aparece como “Indisponível”. Quem edita continua vendo o estado específico.
- Quando observações forem oferecidas, cada uma será interna por padrão ou marcada explicitamente como pública. Apenas observações públicas aparecem em links de leitura e exportações. Observações de um dia marcado como Atestado são sempre internas.

## Requisitos não funcionais da primeira versão

### Tecnologia do backend

- A API interna, a autorização, as regras de negócio e o acesso aos dados devem ser implementados em Go. TypeScript permanece na interface web; a implementação atual do backend em Pages Functions deve ser substituída.
- Antes da migração, a execução do backend Go e sua integração com o banco devem ser validadas em prévia e produção. A escolha de infraestrutura deve preservar ou revisar explicitamente as metas de disponibilidade, restauração, capacidade, privacidade e custo abaixo, inclusive as premissas sobre as cotas do Cloudflare Free.

### Confiabilidade e operação

- A meta interna de disponibilidade mensal para criar, editar e consultar escalas é de 99,5%, medida continuamente. Não é uma garantia contratual: o limite do plano Cloudflare Free prevalece se as cotas forem esgotadas.
- Em um desastre, a meta de perda máxima de alterações já salvas é de 24 horas. A meta de restauração é de até 24 horas úteis após a detecção, contando apenas de segunda a sexta-feira, das 9h às 18h no horário de Brasília. O acompanhamento humano de incidentes ocorre nessa mesma janela.
- O procedimento de restauração deve ser ensaiado trimestralmente em ambiente isolado e após mudanças de esquema de maior risco. O ensaio deve verificar a reaplicação das exclusões registradas fora do banco restaurado.
- As cotas do plano Free devem ser monitoradas. Antes de esgotá-las, a criação de novos Espaços de gestão deve ser suspensa para priorizar leitura e edição dos existentes; erros por esgotamento de cota devem ser apresentados com clareza. Se os testes mostrarem que o volume planejado não cabe no Free, o limite de admissão será reduzido.

### Desempenho e capacidade

- Em um celular intermediário com conexão 4G, uma semana com 20 pessoas deve ficar utilizável em até 3 segundos no percentil 75 das medições, contados desde a abertura do link. O cenário de referência inclui quatro semanas de dados existentes no Espaço de gestão.
- Uma escala com até 100 pessoas deve continuar consultável, editável e exportável. PDF e PNG de uma semana com 100 pessoas devem ser gerados em até 15 segundos em um celular intermediário, com progresso visível e opção de tentar novamente em caso de falha.
- A arquitetura deve ser dimensionada e testada para 1.000 Espaços de gestão ativos por mês, desde que isso caiba nas cotas medidas do plano Free. Esse volume não autoriza ultrapassar o teto gratuito.

### Acesso, compatibilidade e privacidade

- Todas as funções de gestão, leitura e exportação devem funcionar em celular e computador. A validação de lançamento cobre as versões estáveis de Chrome, Edge, Firefox e Safari, incluindo Safari no iPhone e Chrome no Android, e os fluxos principais devem atender às [WCAG 2.2 nível AA](https://www.w3.org/TR/WCAG22/).
- O site exige conexão para consulta e edição; arquivos já exportados podem ser consultados sem conexão. Não há API pública na primeira versão.
- Links de gestão e leitura são credenciais. Seu conteúdo e seus tokens não podem aparecer em logs ou métricas; respostas privadas não devem ser armazenadas em caches compartilhados nem indexadas. Métricas de uso são agregadas e não incluem nomes, escalas, horários, estados especiais ou e-mails.
- Revisões técnicas de alterações são guardadas por 30 dias para recuperação e diagnóstico, sem interface de histórico ou desfazer na primeira versão. A exclusão de um Espaço de gestão também exclui suas revisões ativas.
- Antes do lançamento público, deve ser concluída uma revisão de privacidade sobre Atestado, compartilhamento por links, exclusão e tratamento de dados fora do Brasil. O produto não exige residência dos dados no Brasil; a localização e os fornecedores devem ser comunicados com clareza. Ver [LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm) e [orientação da ANPD sobre transferência internacional](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados).

### Critérios de lançamento

- Validar autorização e revogação de links, bloqueio de gravações desatualizadas, fusos horários, recorrência, exportações com 100 pessoas, edição móvel, teclado e leitor de tela.
- Medir desempenho em dispositivo e rede representativos e executar teste de carga contra as cotas Free antes de abrir o serviço ao público.
- Validar migrações e restauração na prévia isolada antes da promoção manual para produção.

## Prioridades

**Primeira versão:** gestão de escalas e pessoas, participação por data, ordenação, navegação semanal, jornadas e um intervalo opcional, estados especiais, padrão recorrente, exceções, edição de várias datas, avisos de sobreposição e incompletude, link privado de gestão, links de leitura, exclusão do Espaço de gestão e exportação de uma semana em PDF e PNG.

**Depois da primeira versão:** recuperação opcional por e-mail, exportar o padrão recorrente ou várias semanas de uma vez, fotos, observações e turnos reutilizáveis. Ao recuperar o acesso por e-mail, o link de gestão anterior será substituído. Aplicar um turno reutilizável copiará seus horários para as datas escolhidas; editar o turno depois não modificará jornadas já aplicadas.
