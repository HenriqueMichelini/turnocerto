# TurnoCerto

TurnoCerto is a Brazilian Portuguese schedule planner built with React, TypeScript, Vite, Cloudflare Pages Functions, and D1.

## Local preview

Install dependencies with `npm ci`, then run `npm run preview:local`. This builds the site, applies D1 migrations to local Wrangler state, seeds a preview-only demo Schedule, and starts the Pages app at `http://127.0.0.1:8788`.

The browser integration suite exercises the same Pages Function and D1 path with local state:

```sh
npm run test:integration
```

## Cloudflare environments

The checked-in D1 IDs in `wrangler.jsonc` are local-only examples. Create separate preview and production databases, replace both IDs, and run `node scripts/check-deployment-config.mjs preview --require-real-id` before a remote operation. Remote migration and deployment commands stop while the example IDs remain.

See [the preview and promotion runbook](docs/operations/cloudflare-preview.md) for migration order, rollback guidance, and the deployed smoke-check record.
