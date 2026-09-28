# Launch capacity record

Status: **desktop-host checks passed; physical Android and cellular 4G gates remain unverified**. The local phone panel is available for a Wi-Fi run at `http://192.168.15.88:8788`; its fixtures contain synthetic names only and use isolated local D1 state. Do not treat LAN Wi-Fi measurements as 4G results.

Start the isolated runner with `TURNOCERTO_CAPACITY_HOST=192.168.15.88 node scripts/serve-launch-capacity.mjs` when the phone and workstation share a trusted local network. Without the environment variable, the runner binds only to loopback. Ctrl+C stops both processes and removes the session's isolated local D1 files and Wrangler log.

## Performance evidence

The repeatable browser checks are in [`tests/e2e/launch-capacity.spec.ts`](../../tests/e2e/launch-capacity.spec.ts). They exercise the real Go API, browser week rendering, one-time date editing, browser-generated PDF and PNG files, visible progress, and a one-shot PNG failure followed by retry. The emulated profile is Chromium using a 412 × 915 CSS-pixel Pixel 7a viewport, 2.625 device scale factor, 4× CPU slowdown, and simulated 4G (100 ms RTT, 10 Mbps down, 3 Mbps up). This is desktop-host emulation, not a physical phone or a Cloudflare deployment.

The latest corrected desktop-host observations for this issue were:

| Path | Samples | p75 | Result |
| --- | ---: | ---: | --- |
| Cold 20-Person, four-week view | 20 | 1,419 ms | Under 3 seconds in emulation |
| 100-Person view | 1 | 1,741 ms | Under 15 seconds in emulation |
| 100-Person edit and refreshed week | 1 | 1,507 ms | Under 15 seconds in emulation |
| 100-Person PDF file generation | 20 | 1,305 ms | Under 15 seconds in emulation |
| 100-Person PNG file generation | 20 | 826 ms | Under 15 seconds in emulation |
| Injected PNG failure and retry | 1 | — | Error was visible; retry completed |

These are observations from the desktop-host test run, not representative-phone acceptance evidence. They meet the thresholds in the simulated profile. Physical phone result is pending JSON evidence from the user; the 4G gate cannot be completed through the LAN URL. The phone panel measures the app's generation message and separately records the user's visual confirmation that the download appeared. It does not time the operating system's final file-save operation. The local headless 100-Person panel smoke verified edit (812 ms), PDF generation (326 ms), PNG generation (294 ms), retry generation (267 ms), visible progress (PDF 1, PNG 2), three visual confirmations, and credential-free JSON. Those timings are local Chromium smoke results, not phone results.

| Physical-phone field | Status |
| --- | --- |
| Device and browser | Pending phone JSON |
| Network | Local Wi-Fi LAN for the pending run; cellular 4G unverified |
| Dataset | Synthetic 20 People with four-week participation history, and synthetic 100 People |
| 20-Person open sample / p75 | Pending phone JSON |
| 100-Person view and edit | Pending phone JSON |
| PDF and PNG generation / visible progress / download confirmation | Pending phone JSON |
| PNG failure and retry | Pending phone JSON |

The LAN smoke and benchmark results intentionally use no account, clinic, Person, or Schedule data. The benchmark JSON records browser and viewport metadata, device label, effective connection hints when available, self-reported LAN Wi-Fi, sample arrays, progress counts, and retry state. It contains no Management Link or token hash.

## Capacity model

This estimate models a steady state of 1,000 active Management Spaces after 1,000 new Spaces are admitted evenly over 30 days. It assumes one management-week open and one date edit per active Space per day. An edit consists of a `POST` plus the frontend's refreshed-week `GET`; each such flow loads the full Management Space three times in D1 (route authorization, store validation, and refresh). Each open loads it once. The 20-Person case is the baseline; 100 People per Space is a stress case. These traffic rates and Person counts are assumptions, not measured usage.

The data shape uses one management-space, schedule, and schedule-revision row, plus one Person, participation, weekly pattern, and seven weekday rows per Person. A full Space load returns at least `1 + 8P` logical rows for `P` People (space/schedule, People, and seven pattern days per participation): 161 at 20 People and 801 at 100 People. The API's create routes repeatedly load the Space while admitting each Person and participation. Summing those result rows gives a lower bound of `12P² − 7P` per new Space: 4,660 at 20 People and 119,300 at 100 People. These are logical rows returned by the current query path, **not Cloudflare `meta.rows_read` measurements**. D1 bills scanned rows, including index rows; actual read usage may be higher. The deployed Worker currently does not retain query `meta.rows_read` values.

Write estimates count table rows and the primary, unique, and secondary index entries affected by creation. They are derived from `db/migrations/0001_create_management_spaces_and_schedules.sql`, `0003_schedules_people_and_patterns.sql`, and `0004_versioned_schedule_edits.sql`, not measured against Cloudflare D1. Creating a Space requires 8 base writes plus 25 writes per Person (Person, participation, weekly pattern, and seven pattern-day rows with indexes): 508 writes at 20 People and 2,508 at 100 People. A daily one-date edit is approximated as five writes (one revision row and one date-exception row plus its indexes). Other edits, deletions, read-link operations, D1 query-plan index scans, and account traffic are excluded.

| Daily workload at 1,000 active Spaces | 20 People/Space | 100 People/Space |
| --- | ---: | ---: |
| New Spaces per day (1,000 ÷ 30) | 33.3 | 33.3 |
| Worker requests per new Space | 41 | 201 |
| Worker requests/day (creation + one open and one edit per active Space) | ~4,367 | ~9,700 |
| Logical-row read floor per new Space | 4,660 | 119,300 |
| Full Space logical rows per open | 161 | 801 |
| Read floor/day from creates, opens, and edits | ~799,000 | ~7,181,000 |
| D1 indexed writes per new Space | 508 | 2,508 |
| D1 writes/day (creation + one date edit per active Space) | ~21,900 | ~88,600 |

The Worker request projection is below the 100,000/day Free request limit in both scenarios, but it does not measure or predict per-invocation CPU; the Worker Free CPU ceiling is 10 ms per request. The app's PDFs and PNGs are generated in the browser after the week has loaded, so those exports add no API Worker or D1 request in this model. The Pages deployment is static and uses no Pages Functions for these paths; Pages builds and asset counts remain account-level operational measurements.

The 20-Person result is a logical-row floor below the 2.5 million D1 read admission threshold. The 100-Person result is above the 5 million daily Free D1 read ceiling, and its 88,600 estimated writes/day is above the former 80,000 write warning threshold (though below the 100,000 hard limit). Therefore 1,000 active 100-Person Spaces with this daily request mix do not fit the Free plan. The model is deliberately a capacity stress case; it does not establish the average Space size or actual account traffic.

## Storage and account quotas

The local synthetic SQLite application database measured 380,928 bytes for 1,210 logical rows across its seeded row and 20- and 100-Person fixtures, including one date exception and indexes (93 pages × 4,096 bytes). This is about 315 bytes per logical row in this fixture. Applying that local ratio gives a rough 64 MB for 1,000 20-Person Spaces and 316 MB for 1,000 100-Person Spaces. These are SQLite/Wrangler projections, not Cloudflare D1 measurements; they exclude future date exceptions, read links, other account data, and storage variation. The 100-Person projection is below the 500 MB per-database Free limit but leaves limited room for retained data and does not offset the row-read/write findings.

The Cloudflare Free ceilings referenced here are 100,000 Workers requests/day and 10 ms CPU per request; D1 has 5 million rows read/day, 100,000 rows written/day, 500 MB per database, 5 GB total account storage, 10 databases, and 50 D1 queries per Worker invocation. The TurnoCerto config defines four D1 databases across preview/production application and deletion-ledger environments, below the 10-database ceiling. The account's total database inventory and usage are not known, so account-wide headroom cannot be claimed.

## Admission decision and limits

The D1 rows-read admission threshold is lowered from 80% to 50% of the Free ceiling: new Management Space creation pauses at 2.5 million observed D1 rows read/day, leaving half the daily ceiling in reserve. Other resource thresholds remain at 80%. A crossing test verifies the numeric setting. This is an enforceable application guard on new Space creation; it does not block reads or edits to existing Spaces and does not make the 1,000 × 100-Person stress workload fit. Because admission uses the operator's aggregate snapshot, it depends on a complete snapshot refreshed at least every two hours; it is not a live per-query quota counter.

The read-only Cloudflare query on 2026-09-28 listed 2 D1 databases visible to the supplied token, with `file_size` values summing to 69,632 bytes. Today's D1 GraphQL analytics query returned 0 groups, so account rows-read and rows-written usage are unavailable, not zero. The account's Worker requests and CPU, Pages usage, and recent D1 usage history were not measured. The config declares four intended D1 bindings across preview and production, but the two deletion-ledger IDs remain placeholders; the account list cannot be mapped to all configured environments and does not validate a remote deployment.

The repository's preview and production `FREE_QUOTA_*` values are currently blank. The Go runtime therefore fails closed for new Space creation while quota monitoring is not ready, and the deployment checker rejects remote deploys until a complete, current snapshot is recorded. No remote quota value or deployment was changed for this test. The local unit test verifies the provisional 50% code threshold; the remote account setting and current daily account headroom remain unverified. Do not treat the provisional code margin as an operationally verified setting. Do not lift the creation pause until the operator captures account-wide Workers/D1 usage and has a workload plan below the admission thresholds.

Sources (Cloudflare official documentation, checked 2026-09-28): [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing and row accounting](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/), [D1 Free-limit enforcement changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).
