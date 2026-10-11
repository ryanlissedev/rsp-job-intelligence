/**
 * Shared live-HTTP helpers for json-ld connectors (CTP-528).
 *
 * Every live request identifies itself with the honest
 * `JOB_INTELLIGENCE_USER_AGENT`; it never imitates a browser and never carries
 * Cloudflare clearance cookies (`cf_clearance`, `__cf_bm`, …) or any other
 * ops-supplied Cookie header. A Cloudflare-fronted board that answers with a
 * managed challenge (`cf-mitigated: challenge`) fails closed with a
 * `SourceBlockedError`; the only unblock is the source operator allowing us.
 * Product code must not solve CAPTCHAs or invent scrape hacks.
 * See docs/sources/werkzoeken.md.
 */

import { parseRetryAfterMs } from "../effect-runtime/faults";
import { SourceBlockedError } from "../source-blocked";
import { JOB_INTELLIGENCE_USER_AGENT } from "../user-agent";

/**
 * Named header bag for live json-ld fetches. `Cookie` only ever echoes
 * cookies the source itself set earlier in the same run (a session jar),
 * never an ops-supplied or clearance cookie.
 */
export interface LiveFetchHeaders {
  Accept: string;
  "Accept-Language": string;
  Cookie?: string;
  "User-Agent": string;
}

/** Accept / language negotiation plus the honest product User-Agent. */
export const LIVE_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
  "User-Agent": JOB_INTELLIGENCE_USER_AGENT,
} as const satisfies Omit<LiveFetchHeaders, "Cookie">;

const CF_CHALLENGE_BODY =
  /Just a moment\.\.\.|cdn-cgi\/challenge-platform|cf-mitigated/iu;

export const isCloudflareChallenge = (
  response: Response,
  body?: string
): boolean => {
  if (response.headers.get("cf-mitigated") === "challenge") {
    return true;
  }
  if (response.status !== 403 || body === undefined) {
    return false;
  }
  return CF_CHALLENGE_BODY.test(body);
};

export const cloudflareChallengeError = (options: {
  slug: string;
  url: string;
}): SourceBlockedError =>
  new SourceBlockedError({
    message:
      `${options.slug} fetch blocked by Cloudflare managed challenge at ${options.url}. ` +
      "We identify honestly and carry no clearance cookies, so this source " +
      "stays blocked until its operator allows our User-Agent; " +
      "see docs/sources/werkzoeken.md. Do not use CAPTCHA solvers.",
    url: options.url,
  });

/** The honest default header bag for one live request. */
export const buildLiveFetchHeaders = (): LiveFetchHeaders => ({
  ...LIVE_FETCH_HEADERS,
});

/** Converts the closed header bag into a HeadersInit fetch can accept. */
export const toLiveFetchHeadersInit = (
  headers: LiveFetchHeaders
): [string, string][] => {
  const entries: [string, string][] = [
    ["Accept", headers.Accept],
    ["Accept-Language", headers["Accept-Language"]],
    ["User-Agent", headers["User-Agent"]],
  ];
  if (headers.Cookie !== undefined) {
    entries.push(["Cookie", headers.Cookie]);
  }
  return entries;
};

const GZIP_MAGIC = 0x1f_8b;

/**
 * Decodes a live response body to text, transparently inflating gzip payloads
 * the server sent without `Content-Encoding` (e.g. Techniekwerkt's
 * `application/x-compressed` sitemap at `*.xml.gz`). Sniffing the two magic
 * bytes is safe: no text or XML body can start with 0x1f 0x8b.
 */
export const decodeLiveBodyBytes = async (
  bytes: ArrayBuffer
): Promise<string> => {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 2 && view.getUint16(0, false) === GZIP_MAGIC) {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Typed non-2xx live-response error. Carrying `status` lets callers treat a
 * 404 detail page as "gone at source" instead of failing the whole run.
 */
export class HttpStatusError extends Error {
  /** The host's `Retry-After`, parsed, when it sent one (429/503). */
  readonly retryAfterMs: number | null;
  readonly status: number;
  readonly url: string;

  constructor(options: {
    retryAfterMs?: number | null;
    slug: string;
    status: number;
    url: string;
  }) {
    super(`${options.slug} request failed with status ${options.status}`);
    this.name = "HttpStatusError";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status;
    this.url = options.url;
  }
}

/**
 * Reads a live response body, failing closed on Cloudflare challenges with an
 * ops-actionable message instead of a bare HTTP 403.
 */
export const readLiveHtmlOrThrow = async (options: {
  response: Response;
  slug: string;
  url: string;
}): Promise<string> => {
  const body = await decodeLiveBodyBytes(await options.response.arrayBuffer());
  if (isCloudflareChallenge(options.response, body)) {
    throw cloudflareChallengeError({
      slug: options.slug,
      url: options.url,
    });
  }
  if (!options.response.ok) {
    throw new HttpStatusError({
      retryAfterMs: parseRetryAfterMs(
        options.response.headers.get("Retry-After")
      ),
      slug: options.slug,
      status: options.response.status,
      url: options.url,
    });
  }
  return body;
};
