# TurnoCerto

TurnoCerto is a Brazilian Portuguese schedule planner. The React, TypeScript, and Vite interface is served as a static Cloudflare Pages site. Its internal API is written in Go and compiled to WebAssembly for a separate Cloudflare Worker, which uses D1 for persistence.

## Local development and checks

Install dependencies with `npm ci`. Run the focused backend tests with `npm run test:go`, typecheck the frontend and Worker adapter with `npm run typecheck`, and run the complete local integration suite with:

```sh
npm run test:integration
```

The integration suite builds the Go WebAssembly module, starts a local Worker with Wrangler's local D1 database, starts the static site, and exercises Management Space creation, private-link reopen, Space and Schedule renaming, invalid challenges, rate limiting, and out-of-scope credentials. It also verifies the preview invitation fixture and private response headers. Local Turnstile uses Cloudflare's published test key pair and a dummy token; these test credentials are not valid for deployment. The local run uses Wrangler's local D1 state and never calls Cloudflare's remote D1 API.

## Cloudflare environments

Create separate D1 databases and Worker environments for preview and production. The committed D1 IDs and Pages origins are examples; remote commands reject them. Configure the matching IDs and `WEB_ORIGIN` values in `wrangler.api.jsonc` before remote operations. The frontend build must receive the API Worker origin through `VITE_API_BASE_URL`.

See [the Cloudflare preview runbook](docs/operations/cloudflare-preview.md) for resource setup, migration and rollback steps, deployment commands, and the deployed smoke-check record.
