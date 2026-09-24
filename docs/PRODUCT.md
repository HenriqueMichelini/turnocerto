# TurnoCerto — requisitos funcionais e regras de negócio

O TurnoCerto permite criar, manter, consultar e compartilhar escalas de trabalho semanais. Seu núcleo é uma programação recorrente com alterações em datas específicas. O produto não inclui folha de pagamento, controle de ponto, cálculo de horas, aprovação de afastamentos ou funções de planilha genérica.

A escolha de acesso sem cadastro obrigatório está registrada em [ADR 0001 — Acesso por links](adr/0001-acesso-por-links.md).

## Termos do produto

- **Escala:** programação de trabalho de um grupo, organizada por semanas e associada a um fuso horário.
- **Semana:** período de segunda-feira a domingo, identificado por suas datas.
- **Pessoa:** identidade compartilhada entre as escalas reunidas no mesmo acesso de gestão.
- **Participação:** vínculo de uma pessoa com uma escala durante um período definido por datas.
- **Jornada:** período de trabalho com início, fim e, opcionalmente, um intervalo.
- **Estado especial:** alternativa à jornada em uma data; os estados iniciais são Folga, Férias, Ausência e Atestado.
- **Não definido:** dia de participação ainda sem jornada ou estado especial; não equivale a Folga.
- **Padrão recorrente:** programação semanal habitual de uma pessoa, que pode mudar a partir de uma semana determinada.
- **Exceção:** alteração de uma ou mais datas específicas que prevalece sobre o padrão recorrente nessas datas.
- **Link de gestão:** acesso privado que permite editar o conjunto de escalas e pessoas.
- **Link de leitura:** acesso revogável para consultar um período fixo de uma escala, sem permissão para editá-la.

## Requisitos funcionais

### Escalas e pessoas

1. Quem possui o link de gestão pode criar, nomear, consultar e excluir escalas, além de cadastrar, renomear, ordenar e arquivar pessoas.
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

10. A criação e a edição não exigem cadastro. Um link privado de gestão reúne as escalas e o cadastro compartilhado de pessoas; qualquer pessoa com esse link pode editar.
11. O link de gestão pode ser substituído, invalidando o anterior. Associar um e-mail para recuperação é opcional. Sem e-mail associado, a perda do link implica perda do acesso de edição.
12. Quem edita pode criar e revogar links de leitura separados por escala. Cada link cobre de uma a quatro semanas consecutivas, escolhidas no momento da criação. As datas cobertas não avançam automaticamente.
13. O link de leitura dispensa conta, mostra as alterações posteriores feitas nas semanas cobertas e permite exportar cada uma delas. Não dá acesso às demais semanas nem permite editar.
14. Se outra pessoa alterou a escala desde que o editor a abriu, uma tentativa de salvar a versão desatualizada é bloqueada com aviso. Não há edição colaborativa em tempo real na primeira versão.
15. A primeira versão exporta uma semana completa por arquivo, em PDF ou PNG, tanto para quem edita quanto para quem possui um link de leitura que inclua aquela semana.

## Regras de negócio

### Participação e histórico

- Cada pessoa tem, em cada data de participação de cada escala, uma jornada, um único estado especial ou “Não definido”. Fora do período de participação, o dia não é tratado como Folga nem como “Não definido”.
- Encerrar uma participação retira a pessoa daquela escala a partir da data escolhida, preservando as semanas anteriores.
- Arquivar uma pessoa encerra suas participações em todas as escalas a partir da data escolhida e preserva o histórico. Uma pessoa arquivada não é fisicamente excluída.
- A identidade da pessoa permanece a mesma entre escalas e semanas. Renomeá-la ou mudar sua ordem em uma escala atualiza a apresentação das semanas antigas, sem alterar as jornadas registradas.
- Excluir uma escala inteira apaga definitivamente seus dados e invalida todos os links de leitura daquela escala. O link de gestão continua válido para as demais escalas.

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

## Prioridades

**Primeira versão:** gestão de escalas e pessoas, participação por data, ordenação, navegação semanal, jornadas e um intervalo opcional, estados especiais, padrão recorrente, exceções, edição de várias datas, avisos de sobreposição e incompletude, link privado de gestão, links de leitura e exportação de uma semana em PDF e PNG.

**Depois da primeira versão:** exportar o padrão recorrente ou várias semanas de uma vez, fotos, observações e turnos reutilizáveis. Aplicar um turno reutilizável copiará seus horários para as datas escolhidas; editar o turno depois não modificará jornadas já aplicadas.
