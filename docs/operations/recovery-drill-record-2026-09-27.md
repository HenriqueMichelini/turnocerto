# D1 recovery drill record — 2026-09-27

Status: **disposable restore/replay, isolated candidate promotion/rollback, and reviewed cleanup passed**. No live preview or production D1 was restored, migrated, or seeded; the existing preview Worker binding was left as configured. The exact disposable D1 names and IDs remain in the parent-reviewed operational record rather than this repository file.

## Run details

| Field | Result |
| --- | --- |
| Drill start / final candidate smoke | 2026-09-27 18:27:07–19:15:18 UTC (15:27:07–16:15:18 BRT) |
| Source commit / Wrangler | `0176e4e` / `4.139.0` |
| Account D1 backend / plan window | `production`; Cloudflare Free Time Travel window verified as seven days |
| Restore bookmark / capture time | `00000000-0000001e-000050f3-e7938e3866839b0202c6676f83a2ff3c` / 2026-09-27 18:30:47 UTC |
| Post-bookmark edit timestamp | `2026-09-27T18:32:27.627Z` |
| RPO sample | 1 minute 40.627 seconds; later synthetic edit was absent after restore. This is below 24 hours. |
| Gross drill elapsed to candidate service readiness after rollback | 48 minutes 11 seconds, from recorded drill start through the final post-rollback smoke. This includes provisioning and candidate setup; it is not a qualifying working-hours RTO measurement. |
| 24-working-hour RTO target | **Not demonstrated.** The run took place Sunday, outside the documented weekday 09:00–18:00 BRT recovery window. |
| Independent review | Parent orchestrator independently checked each destructive target/config before restore, migrations, and candidate promotion. |

## Disposable restore and deletion replay

The app and deletion-ledger D1s used only the checked-in synthetic fixture. The app database was restored in place to the recorded bookmark; no Worker was ever attached to the restored intermediate state. The separate ledger contained exactly two synthetic deletion records: one Schedule scope and one Management Space scope. Both records were replayed against the restored app database before its checks were accepted.

All 18 deleted-row, cascade, stored-credential-hash, and post-bookmark-write checks returned zero after replay. The seven retained-data checks each returned one: saved Space, saved management credential, saved Schedule, saved pre-restore state, Person, weekly Pattern, and scoped read link. App migrations remained fully applied after restore; the ledger was not restored or modified during replay.

The credential evidence is SQL-level absence: deleted credential hashes no longer matched a row after replay. No request was sent to a Worker bound to the restored drill database, so this record does not claim route-level rejection for those deleted credentials. The separate candidate preview smoke tested missing and incorrect candidate preview bearer tokens returning 401.

## Migration compatibility and candidate preview

A fresh compatibility D1 began at app migration 0001, received the old-schema synthetic Space and Schedule, then applied migrations 0002–0005. Read-only post-migration checks each returned one for the original Space and Schedule, the added management credential and time-zone columns, the backfilled Schedule revision, the new scoped read-link table, and the rebuilt date-exceptions table. Wrangler reported no remaining migrations. A separate clean candidate app D1 ran migrations 0001–0005, and its separate candidate deletion ledger ran `0001_deletion_records.sql`; both histories were fully applied.

The earlier Go Worker build from commit `81bbf6e` read and renamed the synthetic preview Schedule against the fully migrated candidate app D1. The current Go Worker and current Vite build were then manually promoted to a unique candidate Pages branch, followed by a rollback to the earlier Worker version and saved earlier static bundle on that same branch. The corrected deployed smoke passed all six checks at each stage (older version, current promotion, and rollback). It covered fixture load/read, rename and reload persistence, exact-origin CORS/private response headers, missing/incorrect preview-token rejection, preview-only fixture access, and the 390px layout. A final D1 readback after rollback found the synthetic Space, original Schedule title, and Schedule revision each present once.

| Stage | Worker version / deployment | Pages deployment |
| --- | --- | --- |
| Older compatible Go Worker and static baseline | Version `1864fd12-3df2-4e7f-a60f-f86e56aecf37`; deployment `26d9be20-2bd6-4962-878e-1469ed287569` | `3494ca36-e04a-439d-b042-038a1e54d879` |
| Current API and static build promotion | Version `43412b26-ca84-48e0-b590-6eb447e09076`; deployment `2ab118c3-d5b6-49dd-843d-7249a4c7b104` | `05225c16-5ed0-4b6d-9411-80a5241f4e68` |
| Rollback and final service-ready smoke | Version `1864fd12-3df2-4e7f-a60f-f86e56aecf37`; deployment `be25217f-ea04-4c5d-b1c8-03347a801edc` | `9d38a386-5b8b-4a26-9233-f4d301c31e52` |

The isolated Pages branch was `codex-issue-10-20260927-185424`; Wrangler reported the alias `https://codex-issue-10-20260927-1854.turnocerto.pages.dev`. The candidate Worker used only the candidate app/ledger bindings, `SPACE_CREATION_PAUSED=true`, blank quota observations, and a generated candidate-only preview-token hash. No Turnstile key or secret was used. Space creation and the Turnstile flow remain unverified. The configured live preview still has a placeholder deletion-ledger ID, blank quota observations, pending migrations 0002–0005, and no configured Turnstile secret; its existing D1 and Worker were left untouched. Production migrations and deployment were not run.

## Test correction

The original browser smoke could capture the visible loading heading before the fixture response arrived, then restore that placeholder as the Schedule name. The smoke now waits until the heading is neither the loading placeholder nor the error text and asserts that the input matches the loaded heading before editing. The earlier green run with the placeholder persisted is excluded; only the corrected 6/6 runs above count. The candidate Schedule was restored through the candidate API, and final D1 readback confirmed the exact synthetic seed title once.

## Cleanup and evidence handling

Cleanup was verified on 2026-09-27 after independent target review. The five disposable D1s, candidate Worker, and all five candidate Pages deployments were deleted. Final authenticated inventory contained only the existing `turnocerto-preview` and `turnocerto-production` D1s; the existing `preview` Pages deployment remained; and the exact candidate Worker Script lookup returned not found. The named live preview and production resources were excluded from cleanup. Temporary configs, helper scripts, generated candidate token/hash, and local drill artifacts were removed from `/tmp`; the Vault token file was not modified.
