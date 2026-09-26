# Quarterly D1 recovery drill

Run this drill quarterly and after a higher-risk schema change, before promoting that change. The drill must use disposable D1 databases populated only with the synthetic fixtures in [`db/recovery-drill`](../../db/recovery-drill/). It must never point a Worker at the drill databases or restore a preview or production database.

Cloudflare D1 Free currently retains seven days of Time Travel history. Time Travel restore overwrites the selected database in place; it does not create a clone or fork. The drill therefore rewinds only its disposable application database. Confirm the current [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) and account plan before each run.

## Operators and prerequisites

- **Primary operator:** an application maintainer with authenticated Wrangler access to create, inspect, restore, and delete disposable D1 databases.
- **Independent reviewer:** verifies both disposable database names and IDs, checks every remote command target, and signs off before restore and cleanup.
- **Application maintainer:** confirms the migration set, compatible Worker version, saved-data checks, and preview rollback path.
- Run during the weekday 09:00–18:00 BRT recovery window. Record who performed and reviewed each step.
- Use a current Wrangler release and a Cloudflare account with two spare D1 slots. Check account limits first.
- Confirm the disposable application D1 uses the production D1 storage backend with `wrangler d1 info <database>` (`version: production`) and has a recoverable point inside the Free seven-day window. Stop if it reports `alpha` or the selected point is outside the plan's window.
- Create one disposable application D1 and one separate disposable deletion-ledger D1 with unique names such as `turnocerto-recovery-drill-app-20260926` and `turnocerto-recovery-drill-ledger-20260926`. Record both IDs. Have the reviewer compare them with the preview and production IDs in `wrangler.api.jsonc`; all four IDs must be distinct. Do not use the production or preview databases as a drill target.
- Create a temporary Wrangler config outside the repository that binds `DB` only to the disposable application database and `DELETION_DB` only to the disposable ledger. Point their `migrations_dir` values to this repository's `db/migrations` and `db/deletion-migrations`. Do not include production or preview bindings in that temporary config. Use it for every migration, execute, Time Travel, and verification command below.

For example, the temporary config has this shape. Replace the names, IDs, and migration paths with the disposable values and absolute paths from the checked-out repository:

```json
{
  "name": "turnocerto-recovery-drill",
  "compatibility_date": "2026-09-24",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "turnocerto-recovery-drill-app-YYYYMMDD",
      "database_id": "<disposable-app-database-id>",
      "migrations_dir": "<repository-path>/db/migrations"
    },
    {
      "binding": "DELETION_DB",
      "database_name": "turnocerto-recovery-drill-ledger-YYYYMMDD",
      "database_id": "<disposable-ledger-database-id>",
      "migrations_dir": "<repository-path>/db/deletion-migrations"
    }
  ]
}
```

Keep the temporary config and command output private until the drill record is sanitized. It contains database identifiers, not secrets.

## Drill procedure

1. Open a drill record from the template below. Note the start time in UTC and BRT, operator, independent reviewer, Wrangler version, and current commit. Capture a read-only inventory with `npx wrangler d1 list`. Create two uniquely named D1 databases and record the names and IDs returned by Wrangler:

   ```sh
   DRILL_SUFFIX=$(date -u +%Y%m%dT%H%M%SZ)
   npx wrangler d1 create "turnocerto-recovery-drill-app-$DRILL_SUFFIX"
   npx wrangler d1 create "turnocerto-recovery-drill-ledger-$DRILL_SUFFIX"
   ```

   Check the selected account has room under its D1 database limit first. The reviewer must verify both newly created IDs are distinct from every existing ID in the inventory and from configured preview/production resources, and verify the temporary config has only these two disposable D1 bindings. Run `npx wrangler d1 info <app-database-name>` and `npx wrangler d1 info <ledger-database-name>`; record the backend versions and stop unless the app database reports `version: production`.
2. Apply the current application and ledger migrations to the disposable databases:

   ```sh
   npx wrangler d1 migrations apply DB --config <temporary-config> --remote
   npx wrangler d1 migrations apply DELETION_DB --config <temporary-config> --remote
   npx wrangler d1 migrations list DB --config <temporary-config> --remote
   npx wrangler d1 migrations list DELETION_DB --config <temporary-config> --remote
   ```

   Record the migration names printed by each apply command. The `migrations list` commands report unapplied files; both lists must be empty after apply. Confirm the applied names match the checked-in migration directories. Stop if any migration fails or the schema is not the version expected by the selected Worker.
3. Seed synthetic application rows, then capture the current D1 bookmark before simulating deletions:

   ```sh
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/seed-application.sql
   npx wrangler d1 time-travel info DB --config <temporary-config> --json
   ```

   Save the bookmark and its UTC capture time in the private drill record. The fixture contains only fake names, UUIDs, and credential hashes. Never replace them with real values. Wait at least one full UTC minute after capturing the bookmark so the later write falls after the selected recovery point.
4. Make a synthetic saved edit after the bookmark, record its `updated_at` as the latest write, write both confirmed deletion records to the separate ledger D1, then simulate the application deletions. This matches the API's ledger-before-application ordering:

   ```sh
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/post-bookmark-write.sql
   npx wrangler d1 execute DB --config <temporary-config> --remote --command "SELECT updated_at FROM schedules WHERE id = '20000000-0000-4000-8000-000000000001'"
   npx wrangler d1 execute DELETION_DB --config <temporary-config> --remote --file=./db/recovery-drill/seed-deletion-ledger.sql
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/simulate-deletions.sql
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/verify-deletions.sql
   ```

   Query the ledger with `SELECT scope, count(*) FROM deletion_records GROUP BY scope ORDER BY scope` and record counts only. The deleted targets should be absent from the application D1 and present in the ledger. The post-bookmark Schedule edit, saved Space, management credential hash, and read-link hash should remain present.
5. With the reviewer watching the target name and ID, restore the **disposable application D1** to the bookmark from step 3:

   ```sh
   npx wrangler d1 time-travel restore DB --config <temporary-config> --bookmark=<bookmark-from-step-3>
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/verify-restored-before-replay.sql
   ```

   Wrangler Time Travel restore is destructive to the named database. Stop if the selected ID is not the disposable application D1. Do not point this command at preview or production. Before replay, verify the old deleted Schedule, Space, management hash, and read-link hash have returned in the isolated database; do not connect a Worker or serve this state.
6. Reapply every row from the separate deletion ledger. For the synthetic fixture, apply the same two idempotent deletes represented by those rows:

   ```sh
   npx wrangler d1 execute DELETION_DB --config <temporary-config> --remote \
     --command "SELECT scope, space_id, schedule_id FROM deletion_records ORDER BY scope, space_id, schedule_id"
   npx wrangler d1 execute DB --config <temporary-config> --remote \
     --command "DELETE FROM schedules WHERE id = '20000000-0000-4000-8000-000000000002' AND management_space_id = '10000000-0000-4000-8000-000000000002'"
   npx wrangler d1 execute DB --config <temporary-config> --remote \
     --command "DELETE FROM management_spaces WHERE id = '10000000-0000-4000-8000-000000000003'"
   ```

   Confirm the ledger output contains exactly the Schedule and Space rows whose UUIDs appear in the two commands. The IDs in this fixture are synthetic and may be retained in the code; do not copy them into evidence. For a real recovery, export the complete current ledger from its separate database and replay every recorded row, as described in [`deletion-recovery.md`](deletion-recovery.md). Keep the current ledger; never rewind it with the application database.
7. Verify target absence and saved-data availability:

   ```sh
   npx wrangler d1 execute DB --config <temporary-config> --remote --file=./db/recovery-drill/verify-after-replay.sql
   npx wrangler d1 migrations list DB --config <temporary-config> --remote
   ```

   In `verify-after-replay.sql`, checks for deleted rows, credential hashes, and the post-bookmark write must return zero; `saved_space`, `saved_management_credential`, `saved_schedule`, `saved_pre_restore_state`, `saved_person`, `saved_pattern`, and `saved_read_link` must each return one. The schedule-deletion Space and its management credential must remain, while its deleted Schedule, dependent revision, participation, and read link must be absent. The deleted Space, its management credential, and all cascaded rows must be absent. These checks establish that the Go API's stored-credential lookups have no deleted hash to match; they do not claim a route-level response. Stop if a count differs.
8. Record the recovery-point gap and elapsed recovery work using the definitions below. Record the exact migration list and whether the previous Worker remains compatible with that schema. Do not count this SQL-only drill as a preview deployment or application smoke test.
9. Delete both disposable D1 databases only after the reviewer confirms the checks passed and the sanitized evidence is saved:

   ```sh
   npx wrangler d1 delete <app-database-name>
   npx wrangler d1 delete <ledger-database-name>
   npx wrangler d1 list
   ```

   Verify the deleted resource names/IDs are the two drill databases and no other database was removed. Never delete preview or production databases.

## Migration, preview promotion, and rollback check

Use the drill and each higher-risk migration to check the migration compatibility contract:

- Apply numbered migrations in order to a fresh disposable database and to the disposable database already at the prior schema. Retain existing data and ensure the old deployed Worker can still read and write while the new schema is present. Schema changes must remain additive during the manual rollout window.
- On preview, apply migrations first, deploy the Go API Worker, then deploy the static Pages build. Run the deployed preview smoke and record its deployment IDs and result. Preview and production D1 and deletion-ledger IDs must remain distinct.
- Promote manually only after review of the preview migration and smoke evidence. Apply the same reviewed migration set to production, deploy the Go API Worker, and then promote the Pages build. Production migration and deployment are not part of this drill.
- Validate rollback on preview by rolling the API Worker back to its known-good version and restoring the prior Pages deployment. Confirm the old code operates against the additive schema. Worker rollback does not reverse D1 migrations; use a forward migration for schema corrections. Application-data recovery is a separate operation and must reapply the current deletion ledger before any restored data is exposed.

Use the Cloudflare steps in [`cloudflare-preview.md`](cloudflare-preview.md) for preview deployment and rollback. If the preview promotion or rollback is not actually run and checked, record it as unverified; a local build or SQL drill is not proof.

## Targets, failures, and evidence

- **Data-loss interval target:** no more than 24 hours. Record the selected restore point and `updated_at` of the post-bookmark synthetic edit. Their UTC difference is the demonstrated loss window; verify the edit is absent after restore. For an incident, record the incident's latest confirmed write timestamp and the actual restored-to timestamp.
- **Recovery-work target:** no more than 24 working hours. Measure active elapsed work from recovery declaration/start to the point that migration, deletion replay, access checks, saved-data checks, and service readiness are complete. Exclude time outside the weekday 09:00–18:00 BRT working window and record the excluded wait separately.
- **Failure handling:** keep the restored database isolated if a restore, migration, ledger query, replay, or verification step fails. Do not expose it. Preserve the ledger. Record the failing command without credentials or SQL row values, correct the cause, and restart verification from the complete ledger; delete statements are idempotent. Escalate an unsupported `alpha` D1 backend or a restore point outside the Free window instead of improvising.
- **Evidence:** retain the sanitized drill record, operator/reviewer names, commit, Wrangler version, database names (IDs may be retained in access-controlled records), restore bookmark and UTC time, migration names, verification counts, RPO/RTO calculations, failure notes, and preview deployment IDs when applicable. Never retain raw credentials, access tokens, real schedule content, or fixture hashes beyond what the sanitized check output requires. Retain each quarterly record through the next four completed quarterly drills; retain incident evidence under the incident-record policy.

### Drill record

Copy this table to the access-controlled operational record for each run:

| Field | Result |
| --- | --- |
| Drill date and UTC/BRT start/end | |
| Commit and Wrangler version | |
| Primary operator and independent reviewer | |
| Disposable app / ledger names and IDs checked | |
| D1 backend version and Free history window | |
| Restore bookmark and UTC restore point | |
| Migration names and old Worker compatibility | |
| Target data / credential checks | |
| Saved data checks | |
| Demonstrated data-loss interval / 24-hour target | |
| Active recovery work / 24-working-hour target | |
| Preview promotion and rollback result / evidence | |
| Failures, external waits, and evidence location | |
| Cleanup verified by reviewer | |

**Current rehearsal status (2026-09-26):** remote disposable D1 restore and deletion replay, and preview promotion/rollback, were not run. Wrangler is unauthenticated in the available environment, and the configured deletion-ledger IDs are placeholders. No recovery target or production data was changed. SQL-level credential absence is covered by the local fixture, but has not been demonstrated against D1. The 24-hour data-loss target and 24-working-hour recovery target were not demonstrated and are unmet for this rehearsal; the deployed promotion/rollback path also remains unverified.
