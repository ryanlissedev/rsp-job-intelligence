# URL dedup, mark only (follow-up to the unique-key PR)

Status: draft PR, **stacked on #483** (base branch `feat/aanvraag-unique-key-supersede`). It needs migration 0033 (`superseded_*` columns + `curated.aanvraag_dup_archive`) and reuses that mark/archive pattern. Retarget to `main` once #483 is merged. Nothing has run in production.

## Why
The prod dup analysis (2026-10-11, sections 10–11) found live rows of one bron that share a posting URL but carry a different `bron_referentie`. The normalized-key index from #483 cannot catch these.
- **Opdrachtoverheid:** 123 pairs. Each pairs a v1 row (uppercase GUID ref, last seen 6–7 Sep) with a live row (aggregator slug, last seen 17 Sep–11 Oct). These are real duplicates; the live row wins.
- **MI Public:** 121 v1-only pairs, also real duplicates. The keep rule falls through to completeness, then oldest, then lowest id.
- **Flextender (3,329 rows), Striive (816), CTM (13):** the whole bron shares one listing URL. These are not duplicates and must never be touched.

## What the script does
`tools/postgres/url-dedup/url-dedup.sql` (psql):
- **Dry run by default** (`BEGIN READ ONLY … ROLLBACK`; works as `ji_readonly`):
  - rows to mark per bron (v1 vs live split);
  - the total;
  - 20 example pairs, ids only.
- **`-v apply=1`** (as `ji_migrator`): one transaction. In a single statement it snapshots each loser into `curated.aanvraag_dup_archive` (`reason = 'dup-url-v1'`, `to_jsonb` of the full row) and sets `superseded_by = <kept id>`, `superseded_at`, `superseded_reason = 'dup-url-v1'`. **No row is deleted.**
  - Fails closed (rollback) if a marked row has no archive snapshot, or a mark points at a superseded row.
  - `lock_timeout` is 5 s.
- **Normalization:** strip `#fragment` and `?query`, lower, trim, drop trailing `/`. This is the same expression as the dup analysis.
- **Guards** (all must hold):
  1. exactly 2 live rows with that URL in the bron;
  2. the two rows have a different `lower(btrim(bron_referentie))`;
  3. the bron is not hard-excluded: Flextender `…033`, Striive `…008`, CTM `…00b`;
  4. generic guard: 2 / live rows of the bron ≤ `max_url_share` (default 0.05).
- **Keep rule** (first wins, identical to #483): newest `laatst_gezien_op` → live (`v1_id IS NULL`) before v1 → highest `compleetheid_score` → oldest `eerste_gezien_op` → lowest id.
- **Idempotent:** only live rows are considered, so a second run marks 0.
- **`-v only_bron=<uuid>`** scopes a run to one bron, for a staged rollout and the tests.

## Prod operator plan (not run; each write step needs Ryan's GO)
1. **Precondition:** #483 is deployed (0033/0034 applied, its mark step done).
2. **Dry run** (read-only, ji_readonly):
   `psql "<readonly url>" -X -v ON_ERROR_STOP=1 -f tools/postgres/url-dedup/url-dedup.sql`
   - Expect about 123 Opdrachtoverheid + 121 MI Public = **~244 rows**, 0 for every other bron.
   - Opdrachtoverheid: every loser is v1 and every kept row is live.
   - Stop on any bron or count outside this.
3. **Staged apply** (ji_migrator; writers may keep running, since only row locks are taken):
   `-v apply=1 -v only_bron=00000000-0000-4000-8000-0000000000ad` (Opdrachtoverheid).
   Check the counts, then run MI Public with its bron id (from the dry-run output). Alternatively, run once without `only_bron` after the dry run matched.
4. **Verify:** `SELECT superseded_reason, count(*) FROM curated.aanvraag WHERE superseded_reason = 'dup-url-v1' GROUP BY 1;` equals the archive count with `restored_at IS NULL`.

**Rows changed:** about 244 `curated.aanvraag` rows get `superseded_*` set, plus about 244 archive inserts. Rows deleted: 0.

## Rollback
`tools/postgres/url-dedup/90-rollback.sql` (ji_migrator, one transaction, idempotent):
- clears `superseded_*` on every row marked `dup-url-v1` that is in the archive;
- sets `restored_at` on the archive rows, which stay as the audit trail.

It is safe with the 0034 unique index in place: the marked pairs have different normalized refs, so unmarking never recreates a duplicate key.

## Tests
`tools/postgres/url-dedup/url-dedup.spec.ts` runs the real script through `psql` against a migrated test DB:
- the dry run writes nothing and reports 2;
- apply follows the keep rule (newer live wins; on a tie, live beats v1), archives the losers, deletes nothing, and leaves a triple alone;
- a re-run marks 0;
- the generic guard skips a 2-of-4 bron;
- Flextender is never marked;
- rollback restores the rows, keeps the audit rows, and is idempotent.

The spec skips with a warning when `psql` is not on PATH (GitHub `ubuntu-latest` ships it).

## Open: staging
`staging.source_record` has 2 pairs (Randstad, ZZP-Opdrachten.nl). These are out of scope here (curated only); inspect them read-only before any staging unique index.
