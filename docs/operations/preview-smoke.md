# Preview deployment smoke-check record

Status: **not run against a deployed Pages preview** (2026-09-24).

The local browser integration test passed against Wrangler Pages and a local D1 database. A deployed result is still pending: this checkout has no configured Cloudflare Pages project or real preview/production D1 IDs. The deployed result must be recorded here after following [the Cloudflare preview runbook](cloudflare-preview.md).

| Field | Result |
| --- | --- |
| Pages deployment ID | Pending |
| Preview URL | Pending |
| Smoke-check date and operator | Pending |
| Schedule load, rename, and reload | Not verified in a deployed preview |
| API no-store and no-index headers | Not verified in a deployed preview |
| Production fixture guard | Verified locally; deployed environment not verified |
| Production promotion steps | See the runbook |
