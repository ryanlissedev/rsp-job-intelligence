import { resolveEgressFetch } from "../egress";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import { extractListingLinks } from "../json-ld/discovery";
import {
  buildLiveFetchHeaders,
  readLiveHtmlOrThrow,
  toLiveFetchHeadersInit,
} from "../json-ld/live-fetch";

const PLANET_INTERIM_DETAIL_PATTERN =
  /^\/[a-z0-9-]+\/\d+\/p\d+\/default\.html$/u;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class PlanetInterimPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanetInterimPaginationError";
  }
}

export interface PlanetInterimPaginationOptions {
  fetchImpl?: typeof fetch;
  maxPages?: number;
  pageDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  url?: string;
}

const decodeHtmlEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const readAttribute = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "iu"))?.[1];

interface PlanetFormState {
  action: string;
  fields: URLSearchParams;
}

const readHiddenForm = (html: string): PlanetFormState => {
  const formTag = html.match(/<form\b[^>]*>/iu)?.[0];
  if (!formTag) {
    throw new PlanetInterimPaginationError("listing response has no form");
  }
  const action = decodeHtmlEntities(readAttribute(formTag, "action") ?? "");
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/giu)) {
    const [tag] = match;
    if (readAttribute(tag, "type")?.toLowerCase() !== "hidden") {
      continue;
    }
    const name = readAttribute(tag, "name");
    if (name) {
      fields.set(name, decodeHtmlEntities(readAttribute(tag, "value") ?? ""));
    }
  }
  return { action, fields };
};

const readNextTarget = (html: string): string | null => {
  const decoded = decodeHtmlEntities(html);
  const pagerPresent =
    /DataListPagerControl|search-pagination|pagination/iu.test(decoded);
  for (const match of decoded.matchAll(/<a\b[^>]*>/giu)) {
    const [tag] = match;
    if (!/nextPostbackButton/iu.test(readAttribute(tag, "id") ?? "")) {
      continue;
    }
    if (/\bdisabled\b/iu.test(readAttribute(tag, "class") ?? "")) {
      return null;
    }
    const target = tag.match(
      /WebForm_DoPostBackWithOptions\(new WebForm_PostBackOptions\(\s*["'](?<target>[^"']+)["']/iu
    )?.groups?.target;
    if (!target) {
      throw new PlanetInterimPaginationError(
        "listing next control has no WebForms postback target"
      );
    }
    return target;
  }
  if (pagerPresent) {
    throw new PlanetInterimPaginationError(
      "listing pager has no next WebForms control"
    );
  }
  return null;
};

const readDetailUrls = (html: string, listingUrl: string): string[] => {
  const urls = extractListingLinks(
    html,
    PLANET_INTERIM_DETAIL_PATTERN,
    listingUrl
  ).map(({ url }) => url);
  if (urls.length === 0) {
    throw new PlanetInterimPaginationError(
      "listing response has no Planet Interim detail URLs"
    );
  }
  return urls;
};

const mergeCookies = (
  jar: Map<string, string>,
  header: string | null
): void => {
  if (!header) {
    return;
  }
  for (const pair of header.split(/;\s*/u)) {
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
};

const updateCookies = (jar: Map<string, string>, response: Response): void => {
  // SAFETY: Bun and undici expose getSetCookie on Headers at runtime; the
  // optional property keeps this connector compatible with standard fetch.
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [];
  for (const value of values) {
    const [pair] = value.split(";", 1);
    if (pair) {
      mergeCookies(jar, pair);
    }
  }
  if (values.length === 0) {
    const fallback = response.headers.get("set-cookie")?.trim() ?? "";
    if (fallback.length === 0) {
      return;
    }
    if (fallback.includes(",")) {
      throw new PlanetInterimPaginationError(
        "ambiguous combined Set-Cookie header"
      );
    }
    const [pair] = fallback.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) {
      throw new PlanetInterimPaginationError("malformed Set-Cookie header");
    }
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
};

const waitForPageDelay = async (
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (delayMs === 0 || signal?.aborted) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    return;
  }
  // oxlint-disable-next-line promise/avoid-new -- cancellable delay has no native promise API.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // oxlint-disable-next-line prefer-const -- assigned after the abort closure is created.
    let timer: ReturnType<typeof setTimeout>;
    const abort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
};

const isBlockPage = (body: string): boolean =>
  /<title[^>]*>\s*(?:just a moment|access denied|request blocked)/iu.test(body);

// oxlint-disable-next-line complexity -- one bounded WebForms state machine keeps request, body, and page guards together.
export const fetchPlanetInterimListingPages = async (
  options: PlanetInterimPaginationOptions = {}
): Promise<string[]> => {
  const listingUrl = options.url ?? "https://planetinterim.nl/opdrachten";
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const timeoutMs = resolveHttpTimeoutMs(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new PlanetInterimPaginationError(
      "maxPages must be a positive integer"
    );
  }
  if (!Number.isFinite(pageDelayMs) || pageDelayMs < 0) {
    throw new PlanetInterimPaginationError("pageDelayMs must be non-negative");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("planet-interim");
  const baseHeaders = buildLiveFetchHeaders();
  // Session jar: only cookies Planet Interim itself sets during this run.
  const cookies = new Map<string, string>();
  const pages: string[] = [];
  const pageSignatures = new Set<string>();

  const fetchPage = async (
    url: string,
    init: RequestInit = {}
  ): Promise<string> => {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const cookie = [...cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const requestBaseHeaders = { ...baseHeaders };
    if (cookie) {
      requestBaseHeaders.Cookie = cookie;
    }
    const headers = toLiveFetchHeadersInit(requestBaseHeaders);
    return await withHttpTimeout(
      async (signal) => {
        const requestHeaders = new Headers(headers);
        if (init.headers) {
          const additionalHeaders = new Headers(init.headers);
          for (const [key, value] of additionalHeaders.entries()) {
            requestHeaders.set(key, value);
          }
        }
        const response = await fetchImpl(url, {
          ...init,
          headers: requestHeaders,
          signal,
        });
        updateCookies(cookies, response);
        const body = await readLiveHtmlOrThrow({
          response,
          slug: "planet-interim",
          url,
        });
        if (isBlockPage(body)) {
          throw new PlanetInterimPaginationError(
            `listing response is a block page at ${url}`
          );
        }
        return body;
      },
      timeoutMs,
      options.signal
    );
  };

  let current = await fetchPage(listingUrl);
  for (let page = 0; page < maxPages; page += 1) {
    const detailUrls = readDetailUrls(current, listingUrl);
    const signature = detailUrls.join("\n");
    if (pageSignatures.has(signature)) {
      throw new PlanetInterimPaginationError(
        `listing page repeated at page ${page + 1}`
      );
    }
    pageSignatures.add(signature);
    pages.push(current);
    const nextTarget = readNextTarget(current);
    if (!nextTarget) {
      return pages;
    }
    if (page + 1 >= maxPages) {
      throw new PlanetInterimPaginationError(
        `listing pagination exceeded maxPages=${maxPages}`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- WebForms state must advance sequentially.
    await waitForPageDelay(pageDelayMs, options.signal);
    const form = readHiddenForm(current);
    form.fields.set("__EVENTTARGET", nextTarget);
    form.fields.set("__EVENTARGUMENT", "");
    const nextUrl = new URL(form.action || listingUrl, listingUrl);
    const listingOrigin = new URL(listingUrl);
    if (
      nextUrl.origin !== listingOrigin.origin ||
      nextUrl.protocol !== listingOrigin.protocol
    ) {
      throw new PlanetInterimPaginationError(
        "listing form action must stay on the Planet Interim origin"
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- the next request needs the current WebForms state.
    current = await fetchPage(nextUrl.toString(), {
      body: form.fields,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: listingUrl,
      },
      method: "POST",
    });
  }
  throw new PlanetInterimPaginationError(
    "listing pagination did not terminate"
  );
};
