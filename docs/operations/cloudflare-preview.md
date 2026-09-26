# Cloudflare preview, migrations, and rollback

TurnoCerto uses a static Cloudflare Pages site and a separate Go WebAssembly API Worker with application and deletion-ledger D1 bindings. The thin TypeScript Worker entry point exists because Cloudflare supplies Fetch requests and D1 as JavaScript runtime objects; it forwards those objects to Go. Go owns the API route, bearer-token authorization, request validation, environment guard, response privacy policy, and prepared SQL statements. The frontend calls the Worker from a separate origin, restricted by the exact Pages origin configured in `WEB_ORIGIN`; CORS is not authentication.

The original issue #1 described a Pages Function. The later Go requirement in `docs/PRODUCT.md` supersedes that infrastructure detail. `wrangler.jsonc` configures only the static Pages site; `wrangler.api.jsonc` configures the Go API Worker and separate D1 bindings. No API or database logic runs in Pages Functions.

The Pages preview alias serves a public static shell. Go requires the invitation token before it reads or changes the preview schedule, and this ticket seeds synthetic demo data only. Do not place real private schedules or credentials in this fixture. The invitation URL is a bearer credential and should be shared privately.

## Anonymous Management Space creation

Anonymous creation is served by the Go API Worker. Each create request must pass Turnstile Siteverify before Go stores the Space and its first schedule. The Management Link can rename both the Space and its schedules. Go stores only the SHA-256 hash of the randomly generated Management Link credential; the raw credential is returned once and kept in the URL fragment by the browser until it moves into tab session storage. Private requests carry it only in the `Authorization` header. Losing the link loses editing access; there is no email recovery. The API applies a Cloudflare Rate Limiting binding before challenge validation and returns a user-readable `429` response when the configured creation limit is reached.

For each environment, create a Turnstile widget restricted to that environment's exact Pages hostname (`preview.turnocerto.pages.dev` for preview and `turnocerto.pages.dev` for production). Configure its public site key as `VITE_TURNSTILE_SITE_KEY` for the Pages build, and store the matching secret in that environment's API Worker with `npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.api.jsonc --env preview`. The Worker configuration pins `TURNSTILE_ALLOWED_HOSTNAME` to the expected hostname and deployment-config checks require it to match `WEB_ORIGIN`. Never use the public test keys outside local integration tests. The creation limit is 10 requests per 60 seconds per Rate Limiting key; Cloudflare's binding is local to a data-center location and eventually consistent, so Turnstile validation remains required on every attempt.

## Free-plan resource scope

The expected preview and production setup is one Pages project, two API Workers, two application D1 databases, and two separate deletion-ledger D1 databases. Current Cloudflare Free limits allow 100 Pages projects, 100 Workers, and 10 D1 databases per account. Workers Free allows 100,000 requests per day and 10 ms CPU per invocation. D1 Free allows 500 MB per database, 5 GB per account, 5 million rows read and 100,000 rows written per day, with seven-day point-in-time recovery. The additional two databases still fit the database-count limit, subject to measured total storage and daily usage. The built Worker bundle for this change is 5.87 MiB uncompressed against the current 64 MiB Worker limit. Local execution is not proof of deployed CPU usage, availability, backup recovery, cellular performance, or capacity for 1,000 management spaces; measure those separately before public launch.

The account-wide quotas may be shared with other Workers and D1 databases. Check current usage before deploying or testing at scale. See Cloudflare's [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Provision the isolated environments

Use the `turnocerto` project and resource names below. Do not select or modify another Pages project. The identifiers are not credentials; do not put `CLOUDFLARE_API_TOKEN` or any other secret in this repository.

1. Confirm Wrangler is authenticated to the intended Cloudflare account with `npx wrangler whoami`.
2. Create the Pages project with `npx wrangler pages project create turnocerto --production-branch main`.
3. Create four isolated D1 databases: application databases `turnocerto-preview` and `turnocerto-production`, plus deletion ledgers `turnocerto-deletion-ledger-preview` and `turnocerto-deletion-ledger-production`. Record each returned database ID. Never share a database between environments or between application data and its deletion ledger.
4. In `wrangler.api.jsonc`, replace each example ID in both the top-level production binding and its environment binding. Set production `DELETION_DB` to `turnocerto-deletion-ledger-production` and preview `DELETION_DB` to `turnocerto-deletion-ledger-preview`. Keep all four database names and IDs distinct. Set the preview `WEB_ORIGIN` to `https://preview.turnocerto.pages.dev`; set the production and top-level production origin to `https://turnocerto.pages.dev`.
5. Verify the selected environments with `node scripts/check-deployment-config.mjs preview --require-real-id` and `node scripts/check-deployment-config.mjs production --require-real-id`. Remote migration and deployment commands remain blocked until both deletion-ledger IDs are configured.
6. Generate a strong random preview token, compute its SHA-256 hex digest locally, and store only that digest as the `PREVIEW_TOKEN_HASH` secret on the preview Worker with `npx wrangler secret put PREVIEW_TOKEN_HASH --config wrangler.api.jsonc --env preview`. Keep the raw token outside the repository and logs, such as in a mode-600 file in a private vault. Invitees use `https://preview.turnocerto.pages.dev/#preview_token=<token>`; the browser stores it for the tab session, removes the fragment from the address bar, and sends it to Go as a bearer token. The API compares only the token hash. Do not create this secret on production.

Creating the production databases establishes isolation but this ticket does not apply production migrations or deploy production. Production changes require their own reviewed promotion. Never point preview at production or point a Worker at another environment's deletion ledger.

## Local development and integration tests

Install dependencies with `npm ci`. `npm run test:go` runs Go tests. `npm run typecheck` checks the frontend and Worker bridge. `npm run test:integration` builds Go to WebAssembly, runs Go and configuration tests, then starts a local Wrangler Worker with separate application and deletion-ledger D1 fixtures plus the Vite site for Playwright. Browser checks exercise both deletion scopes, link invalidation, wrong-Space denial, an injected ledger failure, safe retry, and repeat attempts. These local commands use Wrangler's local state and do not contact remote D1.

The Go Wasm runtime starts inside the request handler because its event loop uses timers, which cannot be initialized in Workers global scope. `worker/index.ts` passes the platform `Request` and environment bindings to Go; it does not implement application behavior.

## Preview migration and deployment

Once the preview resources and a preview-hostname Turnstile widget are configured:

1. Apply the schema and preview-only demo data with `npm run db:preview`. This writes only to `turnocerto-preview`.
2. Set the preview Turnstile secret with `npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.api.jsonc --env preview`. Keep the secret out of the repository and terminal logs. Deploy the API with `npm run deploy:api:preview`. Copy the `workers.dev` origin Wrangler reports for `turnocerto-api-preview`.
3. Confirm preview `WEB_ORIGIN` matches `https://preview.turnocerto.pages.dev`, then deploy Pages with the API URL and public Turnstile site key in the frontend build:

   ```sh
   VITE_API_BASE_URL=https://turnocerto-api-preview.<account-subdomain>.workers.dev \
   VITE_TURNSTILE_SITE_KEY=<preview-widget-site-key> npm run deploy:pages:preview
   ```

   Replace the example host with the origin Wrangler reported. The command rejects placeholder D1 IDs, placeholder site origins, and missing or non-HTTPS API origins.
4. Run the deployed browser smoke test against the Pages preview and API Worker:

   ```sh
   TURNOCERTO_BASE_URL=https://preview.turnocerto.pages.dev \
   TURNOCERTO_API_BASE_URL=https://turnocerto-api-preview.<account-subdomain>.workers.dev \
   TURNOCERTO_ENV=preview \
   TURNOCERTO_PREVIEW_TOKEN=<token-read-securely> npx playwright test
   ```

   Use the exact API origin Wrangler reported. The smoke runner keeps the supplied token out of the browser URL and disables Playwright tracing while the token is present. The browser flow reads the seeded schedule, saves a unique temporary name, reloads and verifies persistence, then restores the original name. The API checks verify missing and incorrect tokens return 401, while authenticated responses include `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, and the exact allowed CORS origin.
5. Record the Pages deployment ID, preview URL, date, operator, and smoke result in [preview-smoke.md](preview-smoke.md). Do not record schedule contents or credentials.

## Migration and rollback

Each D1 database has its own Wrangler migration history. The application schema is in `db/migrations`; the minimal external deletion register is in `db/deletion-migrations`. Add a numbered migration to the correct directory, run the local integration suite, apply preview migrations with `npm run db:preview`, and complete the deployed preview smoke before proposing production migration. `npm run db:production` is intentionally separate. Keep schema changes additive while old and new Worker versions may both run.

Rolling back an API Worker does not reverse D1 schema changes. For an application regression, roll back the preview Worker to a known-good version with `npx wrangler rollback --config wrangler.api.jsonc --name turnocerto-api-preview --env preview` and deploy the previous Pages build from the dashboard; preserve schema compatibility with that code. Prefer a forward migration for schema mistakes. D1 Time Travel restore overwrites the named database in place and does not clone/fork a historical point. Rehearse only against the disposable synthetic databases described in [the recovery drill](recovery-drill.md). For a real application-data recovery, select the approved target explicitly and reapply the current deletion ledger before attaching restored data to a Worker or reopening traffic. Never restore the deletion ledger from an application backup. Follow [deletion recovery](deletion-recovery.md) for the replay procedure. Do not use production as a rehearsal target or attach a restored preview database to production.

## Deployed preview smoke status

The local integration suite is separate from a deployed smoke. Track the actual remote result in [preview-smoke.md](preview-smoke.md); a local pass must never be reported as a deployed pass. Production migration and deployment remain outside this ticket's preview deployment.
