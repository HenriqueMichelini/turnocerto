# Aplicação na Cloudflare

**Estado:** parcialmente superada. Os [requisitos não funcionais](../PRODUCT.md#tecnologia-do-backend) agora exigem backend em Go; a escolha de Pages Functions para a API e a integração com o banco precisam ser reavaliadas.

Para lançar o TurnoCerto na web com operação enxuta, a interface será construída com React, TypeScript e Vite no Cloudflare Pages; a API interna do site usará Pages Functions e os dados relacionais ficarão no D1. A escolha concentra aplicação e dados em um fornecedor e facilita a implantação inicial. A alternativa de separar hospedagem, backend e banco daria mais independência, mas aumentaria a integração e a operação desde a primeira versão.

## Consequências

- A semana exibida será derivada de versões do padrão recorrente e de exceções por data, sem tratar a grade semanal como fonte de verdade. Gravações usarão controle de versão para bloquear alterações feitas sobre dados desatualizados.
- PDF paginado e PNG longo serão gerados no navegador a partir de dados já autorizados. O site exige conexão; não haverá API pública na primeira versão.
- Links usarão tokens aleatórios fortes em fragmentos de URL, que não são enviados na requisição inicial, e serão apresentados à API em cabeçalho de autorização. Apenas hashes dos tokens serão armazenados. Cada requisição será autorizada conforme o escopo do link; rotação e revogação invalidarão o token anterior. Respostas privadas usarão política sem cache e de referência restritiva, sem conteúdo ou tokens em logs e métricas.
- A criação anônima de Espaços de gestão usará Turnstile com validação no servidor e limites de taxa. Cotas do plano Free serão monitoradas; novas criações serão suspensas antes de prejudicar espaços existentes. O teto Free prevalece sobre a meta interna de disponibilidade e pode exigir reduzir a quantidade admitida de espaços. Ver [limites de Workers](https://developers.cloudflare.com/workers/platform/limits/) e [limites do D1](https://developers.cloudflare.com/d1/platform/limits/).
- Produção e prévia terão bancos D1 separados; uma versão validada será promovida manualmente, com migrações compatíveis com rollback. Outro banco D1 guardará o registro de exclusões, separado do banco de aplicação restaurado, para reaplicá-las antes de reabrir o serviço. O D1 Free oferece recuperação pontual por até sete dias; seus restores precisam ser ensaiados em ambiente isolado. Ver [recuperação do D1](https://developers.cloudflare.com/d1/reference/time-travel/).
- D1 não garante que dados sejam armazenados no Brasil. Isso é aceito para a primeira versão, sujeito à revisão de privacidade e à comunicação clara antes do lançamento público. Ver [localização do D1](https://developers.cloudflare.com/d1/configuration/data-location/).
