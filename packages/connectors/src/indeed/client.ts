import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import {
  buildLiveFetchHeaders,
  cloudflareChallengeError,
  decodeLiveBodyBytes,
  HttpStatusError,
  isCloudflareChallenge,
  toLiveFetchHeadersInit,
} from "../json-ld/live-fetch";
import {
  isIndeedBlockedPage,
  parseIndeedEmbeddedViewJob,
  parseIndeedSearchPage,
} from "./extract";
import type { IndeedSearchPage, IndeedViewJob } from "./types";

const DEFAULT_BASE_URL = "https://nl.indeed.com";

export interface IndeedClient {
  fetchListing: (start: number) => Promise<IndeedSearchPage>;
  /** Returns `null` when the source publishes no anonymous viewjob payload
   * for this jobkey (embedded body absent or jobKey mismatch) — the
   * connector turns that into a rejected fetch, never an invented detail. */
  fetchDetail: (jobkey: string) => Promise<IndeedViewJob | null>;
}

export interface IndeedClientOptions {
  baseUrl?: string;
  /** jobkey → fixture path for `fetchDetail` in fixture mode. Defaults to
   * the one embedded viewjob the real 2026-09-18 capture carries. */
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  /** Indeed `l=` location parameter; "Nederland" sweeps the NL catalog. */
  location?: string;
  /** Indeed `q=` parameter; empty string = unfiltered NL search (verified
   * only with q=developer in the 2026-09-18 capture — the unfiltered route
   * is the same endpoint). */
  query?: string;
  timeoutMs?: number;
}

const EMPTY_PAGE: IndeedSearchPage = {
  cards: [],
  pageLinks: [],
  pageNum: null,
  totalNumResults: null,
};

const buildSearchUrl = (
  baseUrl: string,
  query: string,
  location: string,
  start: number
): string => {
  const url = new URL("/jobs", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("l", location);
  if (start > 0) {
    url.searchParams.set("start", String(start));
  }
  return url.toString();
};

const buildEmbeddedViewJobUrl = (
  baseUrl: string,
  query: string,
  location: string,
  jobkey: string
): string => {
  const url = new URL("/jobs", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("l", location);
  // `vjk` selects which card the two-pane auto-opens server-side; the body
  // then lands in _initialData.autoOpenTwoPaneViewjobResponse. UNVERIFIED
  // for arbitrary jks — observed only for the auto-opened first card.
  url.searchParams.set("vjk", jobkey);
  return url.toString();
};

const loadFixtureHtml = async (relativePath: string): Promise<string> => {
  const fixture = await loadConnectorFixture<string>(relativePath);
  // SAFETY: repo-owned fixture envelopes written by record.ts carry the
  // recorded HTML page as their payload string.
  return fixture.payload;
};

export const createIndeedClient = (
  options: IndeedClientOptions = {}
): IndeedClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const liveEnabled = options.liveEnabled ?? process.env.INDEED_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "indeed/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    // The committed listing fixture embeds this jobkey's viewjob body —
    // the only detail the anonymous 2026-09-18 capture reached.
    "12c9e91e86a09037": "indeed/listing-page-0.json",
  };
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const query = options.query ?? "";
  const location = options.location ?? "Nederland";
  const headers = toLiveFetchHeadersInit(buildLiveFetchHeaders());

  const getHtml = async (url: string, signal: AbortSignal): Promise<string> => {
    const response = await fetchImpl(url, {
      headers,
      method: "GET",
      redirect: "follow",
      signal,
    });
    const body = await decodeLiveBodyBytes(await response.arrayBuffer());
    if (isCloudflareChallenge(response, body)) {
      throw cloudflareChallengeError({
        slug: "indeed",
        url,
      });
    }
    if (isIndeedBlockedPage(body)) {
      throw new Error(
        `indeed fetch hit a bot-detection page at ${url} (status ${response.status}); ` +
          "viewjob redirects anonymous clients to login and search serves " +
          "turnstile after the first loads — see docs/sources/indeed.md. " +
          "Do not use CAPTCHA solvers."
      );
    }
    if (!response.ok) {
      throw new HttpStatusError({
        slug: "indeed",
        status: response.status,
        url,
      });
    }
    return body;
  };

  return {
    fetchDetail: async (jobkey) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[jobkey];
        if (!relativePath) {
          return null;
        }
        return parseIndeedEmbeddedViewJob(
          await loadFixtureHtml(relativePath),
          jobkey
        );
      }
      return await withHttpTimeout(async (signal) => {
        const url = buildEmbeddedViewJobUrl(baseUrl, query, location, jobkey);
        const html = await getHtml(url, signal);
        return parseIndeedEmbeddedViewJob(html, jobkey);
      }, timeoutMs);
    },
    fetchListing: async (start) => {
      if (!liveEnabled) {
        if (start !== 0) {
          return EMPTY_PAGE;
        }
        const html = await loadFixtureHtml(listingFixturePath);
        const page = parseIndeedSearchPage(html);
        if (page === null) {
          throw new Error(
            `indeed listing fixture ${listingFixturePath} carries no jobcards providerData`
          );
        }
        return page;
      }
      return await withHttpTimeout(async (signal) => {
        const url = buildSearchUrl(baseUrl, query, location, start);
        const html = await getHtml(url, signal);
        const page = parseIndeedSearchPage(html);
        if (page === null) {
          throw new Error(
            `indeed search page at ${url} carries no jobcards providerData`
          );
        }
        return page;
      }, timeoutMs);
    },
  };
};
