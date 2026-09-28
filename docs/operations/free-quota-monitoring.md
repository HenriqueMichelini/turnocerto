# Cloudflare Free quota monitoring

This procedure protects existing Espaços de gestão by pausing new creation before account or resource usage approaches a Cloudflare Free ceiling. The API admission check uses only numeric aggregate measurements. A pause affects `POST /api/management-spaces`; existing Space reads and edits do not consult this gate.

## Operator and cadence

The TurnoCerto production operator is responsible for checking the production Cloudflare account. Refresh the usage snapshot at least every two hours while creation is enabled, and after a Cloudflare alert, a quota-related API error, an unexpected traffic increase, or a release that changes database query volume. Daily limits reset at midnight UTC; take a new measurement for the new UTC day. A snapshot older than three hours or from the previous UTC day automatically pauses creation.

Record the observation time in UTC, the Cloudflare account, and the numeric values below in the operational change record. Keep the exact numeric snapshots in the corresponding `FREE_QUOTA_*` variables in `wrangler.api.jsonc`, and set `FREE_QUOTA_MEASURED_AT_UTC` to the measurement time in RFC 3339 UTC form, such as `2026-09-26T12:00:00Z`. Preview and production share account-level D1 quotas, so populate both environments with the same account totals. For per-resource values, use the production API Worker, production Pages project, and the larger of the production and preview D1 database measurements where the threshold is per database.

Do not deploy a remote environment with blank quota snapshots. The deployment configuration checker rejects a remote operation until every measured value is present. At runtime, an incomplete or invalid set of observations pauses new Space creation. If a monitoring source is unavailable or its value is stale, set `SPACE_CREATION_PAUSED` to `true` and deploy the API; resume only after a complete, current snapshot is recorded and is below every threshold.

## Sources, Free ceilings, and admission thresholds

The default threshold is 80% of each documented Free ceiling. The local #11 code currently uses a provisional 50% D1 rows-read threshold (2.5 million rows/day), based on the synthetic 100-Person stress projection. It has not been validated against daily Cloudflare usage history and has not been verified in a remote deployment. Keep this margin provisional until the operator compares it with measured account history and confirms the remote runtime setting. The Go admission check compares the operator's measured numeric snapshot with these limits on every creation request. The quota ceilings below were checked against Cloudflare's official documentation on 2026-09-28; verify the source pages again before changing a ceiling or adjusting the percentage.

| Product and observation | Free ceiling | Pause threshold | Cloudflare source |
| --- | ---: | ---: | --- |
| Workers and Pages Functions incoming requests across the account in the current UTC day | 100,000/day | 80,000 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Upper-quantile API Worker CPU time per request | 10 ms/request | 8 ms | [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers in the account | 100 | 80 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Pages builds in the current month | 500/month | 400 | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Files in the Pages project | 20,000 | 16,000 | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Pages projects in the account | 100 | 80 | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| D1 rows read by the account in the current UTC day | 5,000,000/day | 2,500,000 (provisional local code threshold) | [D1 pricing and usage](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows written by the account in the current UTC day | 100,000/day | 80,000 | [D1 pricing and usage](https://developers.cloudflare.com/d1/platform/pricing/) |
| Largest D1 database storage | 500,000,000 bytes | 400,000,000 bytes | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Total D1 account storage | 5,000,000,000 bytes | 4,000,000,000 bytes | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 databases in the account | 10 | 8 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |

Enter the observed usage, not the ceiling, in these variables:

| Variable | Measurement |
| --- | --- |
| `FREE_QUOTA_MEASURED_AT_UTC` | UTC time at which this complete snapshot was read from Cloudflare |
| `FREE_QUOTA_WORKER_REQUESTS_PER_DAY` | Sum of the current-day incoming request counts for all Workers and any Pages Functions in the account, including preview and production |
| `FREE_QUOTA_WORKER_HIGH_QUANTILE_CPU_MS` | Higher upper-quantile CPU value from the production and preview API Workers, in milliseconds |
| `FREE_QUOTA_WORKER_COUNT` | Current account Worker count |
| `FREE_QUOTA_PAGES_BUILDS_PER_MONTH` | Total Pages builds used across the account in the current month |
| `FREE_QUOTA_PAGES_ASSET_FILES` | Current file count for the `turnocerto` Pages project |
| `FREE_QUOTA_PAGES_PROJECT_COUNT` | Current account Pages project count |
| `FREE_QUOTA_D1_ROWS_READ_PER_DAY` | Account-wide D1 rows read in the current UTC day |
| `FREE_QUOTA_D1_ROWS_WRITTEN_PER_DAY` | Account-wide D1 rows written in the current UTC day |
| `FREE_QUOTA_D1_LARGEST_DATABASE_BYTES` | Larger current storage value between the production and preview D1 databases |
| `FREE_QUOTA_D1_ACCOUNT_STORAGE_BYTES` | Current total D1 storage for the account |
| `FREE_QUOTA_D1_DATABASE_COUNT` | Current account D1 database count |

The code margins are in `backend/internal/schedule/quota.go`: 80% for all resources except the provisional 50% D1 rows-read threshold. That D1 value is based on the 100-Person stress projection in [the launch capacity record](launch-capacity.md), not Cloudflare history, and is not proof that a 50% margin is sufficient for the real account. Before adopting or changing it in a remote environment, record the observed Cloudflare usage history and review the projected workload. Do not change a measured usage value to make admission pass. Production deployment checks reject missing or stale snapshots; the Go gate also rejects missing values and snapshots older than three hours or from a previous UTC day.

In the Cloudflare dashboard, inspect each account Worker under **Workers & Pages** and sum its current-day incoming requests; include **Functions Metrics** for any Pages project that has Functions. Use the higher upper-quantile CPU value from the production and preview API Workers. Inspect all Pages projects for monthly build totals, and the `turnocerto` project for its file count. For D1, inspect **Billing → Billable Usage** for account-wide rows read and written; open each account D1 database and select **Metrics → Row Metrics** for its storage, then record the largest database value and the account total. Cloudflare documents the D1 dashboard and GraphQL metrics in [D1 metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) and [D1 billing](https://developers.cloudflare.com/d1/observability/billing/).

When any observed value reaches its pause threshold, set `SPACE_CREATION_PAUSED` to `"true"` in both preview and production `vars`, refresh the measurement timestamp, and run `npm run deploy:api:production` and `npm run deploy:api:preview`. This is an admission change only. It does not change any existing Management Link or block the existing API routes. When every value is below threshold and monitoring is current, set the variable to `"false"`, update the numeric observations and timestamp, and deploy again. Keep the config file as the source of truth so a later deploy does not silently undo the operator's choice. A missing, invalid, stale, or previous-day snapshot already pauses creation at runtime; the deployment checker also rejects remote operations until the snapshot is complete and current.

## Data minimization

The quota snapshot contains counts, bytes, and milliseconds only. Do not add API keys, Management Link credentials, email addresses, Person or Schedule names, work times, or special-state values to quota variables, logs, or monitoring records. Cloudflare's aggregate usage charts are the source of the measurements; do not emit request bodies or schedule data to create a custom usage dashboard. D1 Query Insights can show query text, so keep application SQL parameterized and record only the aggregate values needed for this procedure.

## If a Free ceiling is reached

1. Pause new Space creation immediately with `SPACE_CREATION_PAUSED="true"` and deploy the API Worker.
2. Check the Cloudflare dashboard and account email alert to identify the exhausted resource. Do not infer a quota type from user input or expose Cloudflare's raw error to users.
3. For D1 row-read usage, inspect D1 query insights and indexes, then reduce unnecessary scans. For D1 storage, remove only data confirmed safe to remove under the product's retention rules. Do not delete Spaces to recover capacity.
4. D1 daily row-read or row-write exhaustion prevents D1 queries until the Free limit resets at midnight UTC; storage exhaustion prevents writes. Existing reads or edits can therefore fail while Cloudflare enforces an exhausted D1 limit, even though an admission pause itself does not affect them. See [D1 error guidance](https://developers.cloudflare.com/d1/observability/debug-d1/) and [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/).
5. Keep creation paused until the resource is below threshold or the project owner has explicitly approved and completed a plan change. Record the UTC observation and the action taken, refresh all usage snapshots, then resume only after monitoring is complete.

Workers Free daily request limits also reset at midnight UTC. A Workers limit can prevent the Worker from running at all; the admission handler cannot translate a request rejected before Worker execution. The documented warning thresholds exist to pause creation before that platform-level ceiling is reached.
