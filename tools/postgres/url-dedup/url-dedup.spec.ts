import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../../packages/db/src/migrations"
);
const dedupScript = path.join(import.meta.dir, "url-dedup.sql");
const rollbackScript = path.join(import.meta.dir, "90-rollback.sql");
const psqlBinary = Bun.which("psql");

const FLEXTENDER = "00000000-0000-4000-8000-000000000033";
// Flextender is a fixed id, so its fixture refs and URLs get a per-run suffix.
const RUN = crypto.randomUUID().slice(0, 8);

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}
if (postgresAvailable && psqlBinary === null) {
  console.warn(
    "url-dedup.spec: psql not on PATH, operator script tests skipped"
  );
}

const ignoreNotice = (): void => undefined;

interface PsqlRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runPsql = (
  script: string,
  variables: Record<string, string>
): PsqlRun => {
  const variableArgs = Object.entries(variables).flatMap(([key, value]) => [
    "-v",
    `${key}=${value}`,
  ]);
  const result = Bun.spawnSync({
    cmd: [
      psqlBinary ?? "psql",
      migratorUrl,
      "-X",
      "-A",
      "-t",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      ...variableArgs,
      "-f",
      script,
    ],
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

/** The single number printed after the `-- total` echo of url-dedup.sql. */
const totalToMark = (stdout: string): number => {
  const lines = stdout.split("\n");
  const index = lines.indexOf("-- total");
  return Number(lines[index + 1]);
};

interface FixtureRow {
  readonly bronUrl: string;
  readonly compleetheid?: number;
  readonly laatstGezien: string;
  readonly referentie: string;
  readonly v1?: boolean;
}

const fillers = (prefix: string, count: number): FixtureRow[] =>
  Array.from({ length: count }, (_, index) => ({
    bronUrl: `https://example.test/${prefix}/filler-${index}`,
    laatstGezien: "2026-10-01T00:00:00Z",
    referentie: `${prefix}-filler-${index}`,
  }));

describe
  .skipIf(!postgresAvailable || psqlBinary === null)
  .serial(
    "url-dedup mark-only operator script (tools/postgres/url-dedup)",
    () => {
      let client: ReturnType<typeof postgres>;
      const bigBron = crypto.randomUUID();
      const smallBron = crypto.randomUUID();
      const ids = new Map<string, string>();

      const insertBron = async (id: string, naam: string): Promise<void> => {
        await client`INSERT INTO curated.bron (id, naam, categorie, actief, status, voorwaarden_status)
                   VALUES (${id}, ${naam}, 'jobboard', false, 'deferred', 'te_toetsen')
                   ON CONFLICT (id) DO NOTHING`;
      };

      const insertRows = async (
        bronId: string,
        rows: readonly FixtureRow[]
      ): Promise<void> => {
        const [run] = await client<{ id: string }[]>`
        INSERT INTO curated.scrape_run (bron_id) VALUES (${bronId}) RETURNING id`;
        for (const row of rows) {
          // oxlint-disable-next-line no-await-in-loop -- tiny fixture, order keeps ids readable
          const [inserted] = await client<{ id: string }[]>`
          INSERT INTO curated.aanvraag
            (bron_id, bron_referentie, bron_url, titel, beschrijving, content_hash, extractie_methode,
             raw_payload_ref, scrape_run_id, eerste_gezien_op, laatst_gezien_op, v1_id, compleetheid_score)
          VALUES (${bronId}, ${row.referentie}, ${row.bronUrl}, 'Fixture', 'Fixture', ${crypto.randomUUID()},
                  'json-ld', 'raw/fixture', ${run?.id ?? null}, '2026-09-01T00:00:00Z', ${row.laatstGezien},
                  ${row.v1 === true ? crypto.randomUUID() : null}, ${row.compleetheid ?? null})
          RETURNING id`;
          ids.set(`${bronId}:${row.referentie}`, inserted?.id ?? "");
        }
      };

      const supersededBy = async (
        bronId: string,
        referentie: string
      ): Promise<string | null> => {
        const [row] = await client<{ superseded_by: string | null }[]>`
        SELECT superseded_by FROM curated.aanvraag WHERE id = ${ids.get(`${bronId}:${referentie}`) ?? ""}`;
        return row?.superseded_by ?? null;
      };

      beforeAll(async () => {
        client = postgres(migratorUrl, { max: 1, onnotice: ignoreNotice });
        await migrate(drizzle(client), { migrationsFolder });
        await insertBron(bigBron, `Url dedup big ${bigBron}`);
        await insertBron(smallBron, `Url dedup small ${smallBron}`);
        await insertBron(FLEXTENDER, "Flextender");
        await insertRows(bigBron, [
          ...fillers("big", 40),
          // pair 1: v1 GUID vs newer live slug; URL differs only in case, query, fragment, slash
          {
            bronUrl: "https://example.test/vacature/123?utm=x",
            laatstGezien: "2026-09-06T00:00:00Z",
            referentie: "A1B2C3D4-GUID",
            v1: true,
          },
          {
            bronUrl: "HTTPS://example.test/vacature/123/#top",
            laatstGezien: "2026-10-10T00:00:00Z",
            referentie: "flextender_123",
          },
          // pair 2: same laatst_gezien_op, so live beats v1
          {
            bronUrl: "https://example.test/vacature/456",
            laatstGezien: "2026-10-01T00:00:00Z",
            referentie: "E5F6-GUID",
            v1: true,
          },
          {
            bronUrl: "https://example.test/vacature/456",
            laatstGezien: "2026-10-01T00:00:00Z",
            referentie: "striive_456",
          },
          // triple: not exactly 2 rows, left alone
          ...["t1", "t2", "t3"].map((referentie) => ({
            bronUrl: "https://example.test/listing",
            laatstGezien: "2026-10-01T00:00:00Z",
            referentie,
          })),
        ]);
        // 2 rows of 4 share a URL: 50% of the bron, the generic guard skips it
        await insertRows(smallBron, [
          ...fillers("small", 2),
          {
            bronUrl: "https://example.test/small/1",
            laatstGezien: "2026-09-01T00:00:00Z",
            referentie: "s-old",
          },
          {
            bronUrl: "https://example.test/small/1",
            laatstGezien: "2026-10-01T00:00:00Z",
            referentie: "s-new",
          },
        ]);
        // hard-excluded bron: a valid-looking pair that must never be marked
        await insertRows(FLEXTENDER, [
          ...fillers(`flex-${RUN}`, 40),
          {
            bronUrl: `https://example.test/flex/${RUN}`,
            laatstGezien: "2026-09-01T00:00:00Z",
            referentie: `f-old-${RUN}`,
          },
          {
            bronUrl: `https://example.test/flex/${RUN}`,
            laatstGezien: "2026-10-01T00:00:00Z",
            referentie: `f-new-${RUN}`,
          },
        ]);
      });

      afterAll(async () => {
        await client?.end({ timeout: 1 });
      });

      it("defaults to a read-only dry run that reports the plan and writes nothing", async () => {
        const run = runPsql(dedupScript, { only_bron: bigBron });
        expect(run.stderr).toBe("");
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("DRY RUN");
        expect(totalToMark(run.stdout)).toBe(2);
        expect(await supersededBy(bigBron, "A1B2C3D4-GUID")).toBeNull();
        const [archive] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM curated.aanvraag_dup_archive WHERE bron_id = ${bigBron}`;
        expect(archive?.count).toBe(0);
      });

      it("applies the keep rule, archives every loser and never deletes", async () => {
        const [before] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM curated.aanvraag WHERE bron_id = ${bigBron}`;
        const run = runPsql(dedupScript, { apply: "1", only_bron: bigBron });
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("APPLY");
        expect(run.stdout).toContain("2|2|2");
        const keep1 = ids.get(`${bigBron}:flextender_123`);
        const keep2 = ids.get(`${bigBron}:striive_456`);
        expect(await supersededBy(bigBron, "A1B2C3D4-GUID")).toBe(keep1 ?? "");
        expect(await supersededBy(bigBron, "E5F6-GUID")).toBe(keep2 ?? "");
        expect(await supersededBy(bigBron, "flextender_123")).toBeNull();
        expect(await supersededBy(bigBron, "striive_456")).toBeNull();
        for (const referentie of ["t1", "t2", "t3"]) {
          // oxlint-disable-next-line no-await-in-loop -- three point reads
          expect(await supersededBy(bigBron, referentie)).toBeNull();
        }
        const archive = await client<
          { kept_aanvraag_id: string; reason: string; snapshot_ref: string }[]
        >`SELECT kept_aanvraag_id, reason, row_snapshot->>'bron_referentie' AS snapshot_ref
          FROM curated.aanvraag_dup_archive WHERE bron_id = ${bigBron} ORDER BY snapshot_ref`;
        expect(archive).toEqual([
          {
            kept_aanvraag_id: keep1 ?? "",
            reason: "dup-url-v1",
            snapshot_ref: "A1B2C3D4-GUID",
          },
          {
            kept_aanvraag_id: keep2 ?? "",
            reason: "dup-url-v1",
            snapshot_ref: "E5F6-GUID",
          },
        ]);
        const [after] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM curated.aanvraag WHERE bron_id = ${bigBron}`;
        expect(after?.count).toBe(before?.count ?? -1);
      });

      it("is idempotent: a second apply marks nothing new", () => {
        const run = runPsql(dedupScript, { apply: "1", only_bron: bigBron });
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("0|0|0");
      });

      it("skips a pair that is a large share of its bron (generic guard)", async () => {
        const run = runPsql(dedupScript, { apply: "1", only_bron: smallBron });
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("0|0|0");
        expect(await supersededBy(smallBron, "s-old")).toBeNull();
      });

      it("never marks inside a hard-excluded bron (Flextender)", async () => {
        const run = runPsql(dedupScript, { apply: "1", only_bron: FLEXTENDER });
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("0|0|0");
        expect(await supersededBy(FLEXTENDER, `f-old-${RUN}`)).toBeNull();
      });

      it("rolls back from the archive, keeps the audit rows, and is idempotent", async () => {
        const first = runPsql(rollbackScript, {});
        expect(first.exitCode).toBe(0);
        expect(await supersededBy(bigBron, "A1B2C3D4-GUID")).toBeNull();
        expect(await supersededBy(bigBron, "E5F6-GUID")).toBeNull();
        const archive = await client<{ restored: boolean }[]>`
        SELECT restored_at IS NOT NULL AS restored
          FROM curated.aanvraag_dup_archive WHERE bron_id = ${bigBron}`;
        expect(archive).toEqual([{ restored: true }, { restored: true }]);
        const second = runPsql(rollbackScript, {});
        expect(second.exitCode).toBe(0);
        expect(second.stdout).toContain("0|0");
      });
    }
  );
