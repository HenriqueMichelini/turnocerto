# Reapply deletion records after restoring application D1

`DELETION_DB` is the durable record of confirmed deletions. It is a different D1 database from `DB` in preview and production. Each row stores only a deletion scope, a Space UUID, an optional Schedule UUID, and the UTC request time. It contains no names, people, credentials, links, or work data. Keep the current deletion ledger when restoring `DB`; restoring an older copy of the ledger can reintroduce already-deleted data.

Cloudflare D1 Time Travel restore overwrites the database named in the command; it does not clone a historical state into another database. The [quarterly recovery drill](recovery-drill.md) uses disposable synthetic databases and never rewinds preview or production.

## Before reopening the restored application database

1. Select and independently verify the exact application database that the approved recovery operation will restore. A Time Travel restore is in-place and destructive to that database. For rehearsals, use only the disposable D1 created by [the recovery drill](recovery-drill.md); never use preview or production as the rehearsal target. Do not attach the restored database to a Worker yet.
2. Read the complete ledger from the matching environment. For production:

   ```sh
   npx wrangler d1 execute DELETION_DB --config wrangler.api.jsonc --env production --remote \
     --command "SELECT scope, space_id, schedule_id, requested_at FROM deletion_records ORDER BY requested_at, scope, space_id, schedule_id"
   ```

   Use `--env preview` for preview. Confirm the query succeeds before changing the restored application database.
3. Replay every returned row against the approved restored application database. For the quarterly drill, replace `<restored-application-database>` with the disposable drill database name. Never use a production or preview database name for rehearsal writes.

   For a `schedule` row, run:

   ```sh
   npx wrangler d1 execute <restored-application-database> --remote \
     --command "DELETE FROM schedules WHERE id = '<schedule_id>' AND management_space_id = '<space_id>'"
   ```

   For a `management_space` row, run:

   ```sh
   npx wrangler d1 execute <restored-application-database> --remote \
     --command "DELETE FROM management_spaces WHERE id = '<space_id>'"
   ```

   Substitute only the UUID values from that ledger row. Both statements are idempotent. The Schedule statement removes only that Schedule and its cascading data and Read Links. The Space statement cascades to its Schedules, People, links, and technical revisions. A Space record also makes older Schedule records for that Space harmless.
4. Repeat the replay commands for every ledger row. If replay fails partway through, keep the restored database isolated, correct the cause, then rerun all rows; completed `DELETE` statements are safe to repeat.
5. Verify that every recorded target is absent from the restored database. Only then configure the application Worker to use that restored application D1 and reopen traffic. Keep the external ledger binding pointed at the current deletion-ledger database.

## Partial API failures

The API writes the external record before deleting application rows. If the ledger write fails, the API returns `503 deletion_record_unavailable` and leaves application data untouched. Restore access to `DELETION_DB` and retry the same confirmed request.

If the ledger write succeeds but the application deletion fails, the API returns a non-success response and keeps the Management Link valid while the application row remains. Retry the same confirmed request. The ledger key is unique by scope and target, so the retry does not add another record and can safely repeat the application `DELETE`. If the application deletion committed but its response was lost, the cascades and ledger row are already durable. A repeated Schedule request receives an opaque denial after the Schedule disappears from the authorized Space; a repeated Space request is denied because its Management Link has been invalidated. The restore replay still removes the target.

Treat only the successful API response as a completed live deletion. A ledger row alone is not proof that the active database operation completed. Always verify the restored database before reopening it.
