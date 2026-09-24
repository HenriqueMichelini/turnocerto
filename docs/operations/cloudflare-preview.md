# Cloudflare preview, migrations, and production promotion

TurnoCerto serves its React/Vite build from Cloudflare Pages, routes `/api/*` through Pages Functions, and stores schedule data in D1. Preview and production must use separate D1 databases. `wrangler.jsonc` defines a `DB` binding in both environments and keeps the default Pages binding pointed at production.

The IDs checked in with this initial slice are example UUIDs for local development. They are deliberately rejected by the remote migration and deployment scripts. Never copy a production database ID into the preview environment.

## Configure the Pages project

1. Create a Cloudflare Pages project named `turnocerto`, connected to this repository. Use `npm ci` as the install command, `npm run build` as the build command, and `dist` as the output directory.
2. Create two D1 databases: `turnocerto-preview` and `turnocerto-production`.
3. Put each returned ID in its matching environment entry in `wrangler.jsonc`. Keep the IDs and names different. Verify the configuration with `node scripts/check-deployment-config.mjs preview --require-real-id` and `node scripts/check-deployment-config.mjs production --require-real-id`.
4. Ensure the Pages preview environment is configured for branch deployments and the production environment uses the `main` branch. Deployments on the `preview` branch use `env.preview`; deployments on `main` use the default production binding.
5. Keep `APP_ENV` set to `preview` for preview deployments and `production` for production. The demo endpoint returns `404` outside preview and does not query D1 there.

For a manual deployment, use `npm run deploy:preview` or `npm run deploy:production`. These commands build before calling `wrangler pages deploy`; the selected branch determines the Pages environment. Normal pull request deployments can use the Pages Git integration.

## Local development and integration tests

Run `npm run preview:local` to build the UI, apply migrations and seed the demo in local Wrangler state, then start the Pages Function server. It binds the example preview database ID to **local** D1 and sets `APP_ENV=preview`; it does not connect to Cloudflare.

`npm run test:integration` runs the typechecked build, configuration safety tests, and Playwright against local Wrangler Pages + D1. It runs preview and production modes sequentially with separate local D1 state. The preview fixture seed is applied only in preview mode.

## Migration workflow

Migrations live in `db/migrations/` and are applied by Wrangler's D1 migration tracker. Each environment has its own D1 migration history.

1. Add a numbered SQL migration and run `npm run test:integration`.
2. Apply it to the preview D1 with `npm run db:preview`. Verify the remote migration list with `npx wrangler d1 migrations list DB --env preview --remote` and complete the deployed smoke check below.
3. After preview passes, apply the migration to production with `npm run db:production`, then deploy the reviewed production build with `npm run deploy:production`.

Keep changes compatible with both the currently deployed build and the incoming build. Prefer additive changes first: add nullable columns or new tables, deploy code that can use the new shape, backfill separately if needed, and remove obsolete columns only in a later release after no deployed code depends on them. Avoid renaming or dropping columns in the same release that changes application code to stop using them.

### Rollback

- If a Pages release fails, roll back to the previous successful Pages deployment in the Cloudflare dashboard. Keep the D1 schema compatible with that prior build.
- Prefer a forward fix for a bad migration. D1 migrations are not automatically undone by a Pages deployment rollback.
- If data recovery is necessary, restore a point-in-time copy into an isolated D1 database first. Verify the restored data and application against preview before any production recovery. Do not point preview at production during recovery.
- For a destructive migration, capture the available D1 recovery point before proceeding and rehearse the restore against an isolated database. The initial migration in this ticket only creates tables and an index, so the Pages deployment can be rolled back without reversing it.

## Deployed preview smoke check

Deploy a non-`main` branch after configuring the real preview D1 ID and applying preview migrations. Use a browser against the resulting Pages preview URL:

1. Open the demo and confirm `Espaço de demonstração` and `Escala de demonstração` load.
2. Rename the Schedule to a temporary value, save it, and reload the page. Confirm the new name remains.
3. In the browser Network panel, confirm the same-origin `GET` and `PATCH /api/schedules/preview-fixture` requests return `200`; the responses include `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`.
4. Open the matching production preview URL or run the production smoke command. Confirm the demo endpoint returns `404`.
5. Record the deployment ID, date, URL, result, and operator in `docs/operations/preview-smoke.md`. Do not record private schedule values or credentials.

The smoke check is intentionally not marked complete from a local run. It needs a Pages project and real D1 IDs configured in the Cloudflare account.
