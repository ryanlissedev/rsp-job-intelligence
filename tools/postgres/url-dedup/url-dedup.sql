-- URL dedup, mark only (follow-up to tools/postgres/unique-key, needs migration 0033).
--
-- Finds pairs of live (superseded_by IS NULL) aanvragen in ONE bron that share the same
-- normalized posting URL but have a different normalized bron_referentie, e.g. an
-- Opdrachtoverheid v1 GUID next to the live aggregator slug for the same posting.
-- The loser of each pair is snapshotted into curated.aanvraag_dup_archive and marked
-- superseded_by = <kept id>, reason 'dup-url-v1'. Nothing is ever deleted.
--
-- DEFAULT = DRY RUN (read-only, BEGIN READ ONLY ... ROLLBACK, safe as ji_readonly):
--   psql "<url>" -X -v ON_ERROR_STOP=1 -f url-dedup.sql
-- APPLY (WRITES; needs Ryan's GO; as ji_migrator):
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v apply=1 -f url-dedup.sql
-- Optional: -v max_url_share=0.05 (default), see guard 4.
--           -v only_bron=<uuid> limits the run to one bron (staged rollout, tests).
--
-- URL normalization (same as 00-dup-analysis.sql sections 10-11):
--   strip #fragment and ?query, lower, trim, drop trailing slashes.
-- Candidate groups (bron_id, url_norm) must pass ALL guards:
--   1. exactly 2 live rows with a non-empty bron_url;
--   2. the 2 rows have a different lower(btrim(bron_referentie)) (same-key dups are 0034's job);
--   3. bron NOT hard-excluded: Flextender …033, Striive …008, CTM …00b (one generic listing
--      URL for the whole bron, so a shared URL says nothing about the posting);
--   4. generic guard: the URL group must be a small share of the bron, i.e.
--      2 / live rows of the bron <= max_url_share (default 5%), so tiny brons and
--      listing-style URLs are skipped.
-- Keep rule inside a pair (first wins, identical to tools/postgres/unique-key):
--   newest laatst_gezien_op -> live (v1_id IS NULL) before v1 -> highest compleetheid_score
--   -> oldest eerste_gezien_op -> lowest id.
-- Expected on prod (dup report 2026-10-11): ~123 Opdrachtoverheid + ~121 MI Public = ~244 rows.
-- Rollback: 90-rollback.sql (unmarks from the archive, reason 'dup-url-v1').
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?max_url_share}
\else
  \set max_url_share 0.05
\endif
\if :{?only_bron}
  \set bron_filter ' AND a.bron_id = ' :'only_bron' '::uuid'
\else
  \set bron_filter ''
\endif

\if :apply
\echo '== url-dedup: APPLY (writes) =='
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
\else
\echo '== url-dedup: DRY RUN (read-only; pass -v apply=1 to write) =='
BEGIN READ ONLY;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
\endif

-- The plan is a temp-free CTE chain; both modes evaluate the very same text through the
-- psql variable below, so the dry run reports exactly what apply would mark.
\set plan_ctes 'WITH live AS (SELECT a.id, a.bron_id, a.v1_id, a.bron_referentie, a.laatst_gezien_op, a.compleetheid_score, a.eerste_gezien_op, lower(btrim(a.bron_referentie)) AS normalized_referentie, regexp_replace(lower(btrim(split_part(split_part(a.bron_url, ''#'', 1), ''?'', 1))), ''/+$'', '''') AS url_norm FROM curated.aanvraag a WHERE a.superseded_by IS NULL' :bron_filter '), bron_size AS (SELECT bron_id, count(*) AS live_rows FROM live GROUP BY bron_id), candidates AS (SELECT l.* FROM live l WHERE l.url_norm <> '''' AND l.bron_id NOT IN (''00000000-0000-4000-8000-000000000033''::uuid, ''00000000-0000-4000-8000-000000000008''::uuid, ''00000000-0000-4000-8000-00000000000b''::uuid)), groups AS (SELECT c.bron_id, c.url_norm FROM candidates c JOIN bron_size s USING (bron_id) GROUP BY c.bron_id, c.url_norm, s.live_rows HAVING count(*) = 2 AND count(DISTINCT c.normalized_referentie) = 2 AND 2.0 / s.live_rows <= ' :max_url_share '), ranked AS (SELECT c.*, row_number() OVER w AS rank_in_group, first_value(c.id) OVER w AS keep_id FROM candidates c JOIN groups g USING (bron_id, url_norm) WINDOW w AS (PARTITION BY c.bron_id, c.url_norm ORDER BY c.laatst_gezien_op DESC NULLS LAST, (c.v1_id IS NULL) DESC, c.compleetheid_score DESC NULLS LAST, c.eerste_gezien_op ASC, c.id ASC)), mark_plan AS (SELECT r.id, r.keep_id, r.bron_id, r.bron_referentie, r.normalized_referentie, r.url_norm, r.v1_id FROM ranked r WHERE r.rank_in_group > 1)'

\echo '-- per bron: pairs and rows to mark'
:plan_ctes
SELECT b.naam, p.bron_id,
       count(*) AS rows_to_mark,
       count(*) FILTER (WHERE p.v1_id IS NOT NULL) AS v1_rows_to_mark,
       count(*) FILTER (WHERE p.v1_id IS NULL) AS live_rows_to_mark,
       count(*) FILTER (WHERE k.v1_id IS NULL) AS kept_live_rows
  FROM mark_plan p
  JOIN curated.bron b ON b.id = p.bron_id
  JOIN curated.aanvraag k ON k.id = p.keep_id
 GROUP BY b.naam, p.bron_id
 ORDER BY rows_to_mark DESC, b.naam;

\echo '-- total'
:plan_ctes
SELECT count(*) AS rows_to_mark FROM mark_plan;

\echo '-- examples (max 20 pairs; ids only)'
:plan_ctes
SELECT p.bron_id, p.url_norm, p.keep_id, p.id AS mark_id, p.bron_referentie AS mark_referentie,
       k.bron_referentie AS keep_referentie
  FROM mark_plan p JOIN curated.aanvraag k ON k.id = p.keep_id
 ORDER BY p.bron_id, p.url_norm
 LIMIT 20;

\if :apply
-- One statement: plan, archive snapshot and mark share one snapshot.
:plan_ctes
, archived AS (
  INSERT INTO curated.aanvraag_dup_archive
    (aanvraag_id, kept_aanvraag_id, bron_id, bron_referentie, normalized_referentie, reason, row_snapshot)
  SELECT p.id, p.keep_id, p.bron_id, p.bron_referentie, p.normalized_referentie, 'dup-url-v1', to_jsonb(a.*)
    FROM mark_plan p JOIN curated.aanvraag a ON a.id = p.id
  RETURNING aanvraag_id
), marked AS (
  UPDATE curated.aanvraag a
     SET superseded_by = p.keep_id, superseded_at = now(), superseded_reason = 'dup-url-v1'
    FROM mark_plan p
   WHERE a.id = p.id AND a.superseded_by IS NULL
  RETURNING a.id
)
SELECT (SELECT count(*) FROM mark_plan) AS planned,
       (SELECT count(*) FROM archived) AS archived,
       (SELECT count(*) FROM marked) AS marked;

DO $$
DECLARE
  unarchived bigint;
  dangling bigint;
BEGIN
  SELECT count(*) INTO unarchived
    FROM curated.aanvraag a
   WHERE a.superseded_reason = 'dup-url-v1'
     AND NOT EXISTS (SELECT 1 FROM curated.aanvraag_dup_archive r
                      WHERE r.aanvraag_id = a.id AND r.reason = 'dup-url-v1' AND r.restored_at IS NULL);
  -- A kept row must itself be live, otherwise the mark points at a superseded row.
  SELECT count(*) INTO dangling
    FROM curated.aanvraag a JOIN curated.aanvraag k ON k.id = a.superseded_by
   WHERE a.superseded_reason = 'dup-url-v1' AND k.superseded_by IS NOT NULL;
  IF unarchived <> 0 OR dangling <> 0 THEN
    RAISE EXCEPTION 'url-dedup check failed: % marked row(s) without archive snapshot, % mark(s) pointing at a superseded row',
      unarchived, dangling;
  END IF;
  RAISE NOTICE 'url-dedup ok: every marked row has an archive snapshot and points at a live row';
END $$;
COMMIT;
\else
ROLLBACK;
\endif
