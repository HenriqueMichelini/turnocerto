# Cloudflare preview, migrations, and rollback

TurnoCerto uses a static Cloudflare Pages site and a separate Go WebAssembly API Worker with a D1 binding. The thin TypeScript Worker entry point exists because Cloudflare supplies Fetch requests and D1 as JavaScript runtime objects; it forwards those objects to Go. Go owns the API route, bearer-token authorization, request validation, environment guard, response privacy policy, and prepared SQL statements. The frontend calls the Worker from a separate origin, restricted by the exact Pages origin configured in `WEB_ORIGIN`; CORS is not authentication.

The original issue #1 described a Pages Function. The later Go requirement in `docs/PRODUCT.md` supersedes that infrastructure detail. `wrangler.jsonc` configures only the static Pages site; `wrangler.api.jsonc` configures the Go API Worker and separate D1 bindings. No API or database logic runs in Pages Functions.

The Pages preview alias serves a public static shell. Go requires the invitation token before it reads or changes the preview schedule, and this ticket seeds synthetic demo data only. Do not place real private schedules or credentials in this fixture. The invitation URL is a bearer credential and should be shared privately.

## Free-plan resource scope

The expected preview and production setup is one Pages project, two API Workers, and two D1 databases. Current Cloudflare Free limits allow 100 Pages projects, 100 Workers, and 10 D1 databases per account. Workers Free allows 100,000 requests per day and 10 ms CPU per invocation. D1 Free allows 500 MB per database, 5 GB per account, 5 million rows read and 100,000 rows written per day, with seven-day point-in-time recovery. The built Worker bundle for this change is 5.87 MiB uncompressed against the current 64 MiB Worker limit. Local execution is not proof of deployed CPU usage, availability, backup recovery, cellular performance, or capacity for 1,000 management spaces; measure those separately before public launch.

The account-wide quotas may be shared with other Workers and D1 databases. Check current usage before deploying or testing at scale. See Cloudflare's [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Provision the isolated environments

Use the `turnocerto` project and resource names below. Do not select or modify another Pages project. The identifiers are not credentials; do not put `CLOUDFLARE_API_TOKEN` or any other secret in this repository.

1. Confirm Wrangler is authenticated to the intended Cloudflare account with `npx wrangler whoami`.
2. Create the Pages project with `npx wrangler pages project create turnocerto --production-branch main`.
3. Create the two isolated D1 databases with `npx wrangler d1 create turnocerto-preview` and `npx wrangler d1 create turnocerto-production`. Record each returned database ID.
4. In `wrangler.api.jsonc`, replace the preview database ID in both the top-level preview binding and `env.preview.d1_databases`. Replace the production ID in both the top-level and `env.production` bindings. Keep the database names and IDs distinct. Set the preview `WEB_ORIGIN` to `https://preview.turnocerto.pages.dev`; set the production and top-level production origin to `https://turnocerto.pages.dev`.
5. Verify the selected environments with `node scripts/check-deployment-config.mjs preview --require-real-id` and `node scripts/check-deployment-config.mjs production --require-real-id`.
6. Generate a strong random preview token, compute its SHA-256 hex digest locally, and store only that digest as the `PREVIEW_TOKEN_HASH` secret on the preview Worker with `npx wrangler secret put PREVIEW_TOKEN_HASH --config wrangler.api.jsonc --env preview`. Keep the token outside the repository and logs. Invitees use `https://preview.turnocerto.pages.dev/#preview_token=<token>`; the browser stores it for the tab session, removes the fragment from the address bar, and sends it to Go as a bearer token. The API compares only the token hash. Do not create this secret on production.

Creating the production D1 database establishes isolation but this ticket does not apply a production migration or deploy production. Production changes require their own reviewed promotion. Never point preview at production.

## Local development and integration tests

Install dependencies with `npm ci`. `npm run test:go` runs Go unit tests. `npm run typecheck` checks the frontend and Worker bridge. `npm run test:integration` builds Go to WebAssembly, runs Go unit and configuration tests, then starts a local Wrangler Worker/D1 and Vite site for Playwright. The preview case uses an ephemeral token, opens the invitation link, renames, reloads, and restores its seeded schedule. It also confirms missing and incorrect tokens are rejected before database access. The production case checks that the preview fixture is unavailable. These local commands use Wrangler's local state and do not contact remote D1.

The Go Wasm runtime starts inside the request handler because its event loop uses timers, which cannot be initialized in Workers global scope. `worker/index.ts` passes the platform `Request` and environment bindings to Go; it does not implement application behavior.

## Preview migration and deployment

Once the preview resources are configured:

1. Apply the schema and preview-only demo data with `npm run db:preview`. This writes only to `turnocerto-preview`.
2. Deploy the API with `npm run deploy:api:preview`. Copy the `workers.dev` origin Wrangler reports for `turnocerto-api-preview`.
3. Confirm preview `WEB_ORIGIN` matches `https://preview.turnocerto.pages.dev`, then deploy Pages with the API URL in the frontend build:

   ```sh
   VITE_API_BASE_URL=https://turnocerto-api-preview.<account-subdomain>.workers.dev npm run deploy:pages:preview
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

Each D1 environment has its own Wrangler migration history. Add a numbered SQL migration, run the local integration suite, apply it to preview with `npm run db:preview`, and complete the deployed preview smoke before proposing production migration. `npm run db:production` is intentionally a separate command. Keep schema changes additive while old and new Worker versions may both run. The initial migration only creates tables and an index.

Rolling back an API Worker does not reverse D1 schema changes. For an application regression, roll back the preview Worker to a known-good version with `npx wrangler rollback --config wrangler.api.jsonc --name turnocerto-api-preview --env preview` and deploy the previous Pages build from the dashboard; preserve schema compatibility with that code. Prefer a forward migration for schema mistakes. For data recovery, restore a D1 point-in-time copy into an isolated database, verify it there, and only then plan a recovery. Do not restore over the source database or attach a restored preview database to production.

## Deployed preview smoke status

The local integration suite is separate from a deployed smoke. Track the actual remote result in [preview-smoke.md](preview-smoke.md); a local pass must never be reported as a deployed pass. Production migration and deployment remain outside this ticket's preview deployment.
