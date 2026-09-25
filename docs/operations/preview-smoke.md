# Preview deployment smoke-check record

Status: **preview deployment and smoke check passed**. Production remains unpromoted.

| Field | Result |
| --- | --- |
| Pages deployment ID | `f6db8563-827e-4546-8490-e43fb1f904c0` |
| Preview URL | [https://preview.turnocerto.pages.dev](https://preview.turnocerto.pages.dev) |
| API Worker URL | [https://turnocerto-api-preview.henrique-g-michelini.workers.dev](https://turnocerto-api-preview.henrique-g-michelini.workers.dev) |
| Smoke-check date and operator | 2026-09-25; automated Playwright run in Codex |
| Open, rename, reload persistence | Passed against the deployed preview; the smoke restored the original synthetic schedule name |
| Missing and incorrect invitation tokens rejected | Passed; both requests returned 401 |
| Private response and exact-origin CORS headers | Passed; `private, no-store`, `noindex`, `no-referrer`, and the exact preview origin were returned |
| Preview Worker logs | Two sampled successful invocations (GET 200 and PATCH 200); `logs` arrays were empty, request bodies were absent, the Authorization header value was redacted, and no token, hash, or schedule value appeared in the captured output |
| Application metrics | The Worker emits no application-specific metrics. Cloudflare's built-in metrics aggregate request counts/status and execution time; the historical metrics dashboard was not queried ([Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)) |
| Preview and production D1 isolation | Verified against separate resources: preview `turnocerto-preview` (`3527c507-1a42-4ad3-bce1-6cf26ad0342e`) and production `turnocerto-production` (`719e8c0b-a2e4-429a-b863-9830f5203eff`) |
| Production migration or deployment | Not run; production migration remains pending |

Cloudflare's tail stream redacts headers whose names contain `auth`, `key`, `secret`, or `token` by default ([Tail Handler request redaction](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)). The source review found no application logging or metrics calls in `backend/` or `worker/`; the runtime sample confirmed empty application log arrays. The built-in metrics remain aggregate operational measurements rather than per-schedule or per-credential values.
