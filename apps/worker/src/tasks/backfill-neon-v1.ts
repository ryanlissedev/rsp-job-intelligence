import {
  buildStarappleLiveIndex,
  STARAPPLE_VACANCY_SITEMAP_URL,
} from "@ji/application/backfill";
import type { StarappleLiveIndex } from "@ji/application/backfill";
import { JOB_INTELLIGENCE_USER_AGENT } from "@ji/connectors";
import { createRawObjectStore } from "@ji/connectors/s3-object-client";
import { runMotianV1Backfill } from "@ji/db";
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

const backfillNeonV1Payload = z.object({
  batchSize: z.number().int().min(1).max(5000).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});

export type BackfillNeonV1Payload = z.infer<typeof backfillNeonV1Payload>;

const STARAPPLE_SITEMAP_TIMEOUT_MS = 15_000;

/**
 * CTP-527: open Starapple rows are verified against the site's own vacancy
 * sitemap, so the backfill needs the live index, not just the optional
 * runner input. A failed or malformed fetch throws: proceeding without it
 * would silently store the same stale URLs this verification exists to fix.
 */
const fetchStarappleLiveIndex = async (): Promise<StarappleLiveIndex> => {
  const response = await fetch(STARAPPLE_VACANCY_SITEMAP_URL, {
    headers: { "User-Agent": JOB_INTELLIGENCE_USER_AGENT },
    signal: AbortSignal.timeout(STARAPPLE_SITEMAP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Starapple vacancy sitemap answered HTTP ${response.status}`
    );
  }
  return buildStarappleLiveIndex(await response.text());
};

/** One-shot Motian Neon v1 historical import into Catapulze Postgres (read-only at source). */
export const backfillNeonV1Task = schemaTask({
  id: "backfill-neon-v1",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 1,
  },
  run: async (payload) => {
    const rawObjectStore = createRawObjectStore({
      RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
      RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
      RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
      RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
      RAW_S3_REGION: process.env.RAW_S3_REGION,
      RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
    });
    const starappleLiveIndex = await fetchStarappleLiveIndex();
    const result = await runMotianV1Backfill({
      batchSize: payload.batchSize,
      concurrency: payload.concurrency,
      executionMode: "production",
      rawObjectStore,
      scope: "full",
      starappleLiveIndex,
    });
    if (result.status === "failed") {
      throw new Error("Motian Neon v1 backfill failed");
    }
    return {
      metrics: result.metrics,
      status: result.status,
    };
  },
  schema: backfillNeonV1Payload,
});
