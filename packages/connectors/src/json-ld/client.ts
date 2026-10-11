import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import {
  applyExcludes,
  buildDetailPayload,
  dedupeUrls,
  detailFixtureBody,
  extractJsonListingPagination,
  extractSitemapUrls,
  parseListingSource,
  resolveDetailFetchUrl,
  selectSitemapIndexChildren,
  validateJsonListingPagination,
} from "./discovery";
import type { JsonLdDetailPayload } from "./discovery";
import {
  buildLiveFetchHeaders,
  readLiveHtmlOrThrow,
  toLiveFetchHeadersInit,
} from "./live-fetch";
import type { JsonLdConnectorConfig, JsonLdDiscoveryUrl } from "./types";

export {
  extractJsonListingUrls,
  extractListingLinks,
  extractSitemapUrls,
  selectSitemapIndexChildren,
  type JsonLdDetailPayload,
} from "./discovery";

export interface JsonLdClient {
  fetchDetail: (
    url: string,
    signal?: AbortSignal
  ) => Promise<JsonLdDetailPayload>;
  fetchListing: (signal?: AbortSignal) => Promise<JsonLdDiscoveryUrl[]>;
  /**
   * CTP-624: `sitemap-index` sources only — the index document's selected
   * child sitemap URLs in walk order (highest `chunk` first). Optional so
   * wrapper clients that only override `fetchListing` stay valid; a config
   * that sets `discovery.batchSize` requires it (the connector throws at
   * construction when it is missing).
   */
  fetchSitemapIndex?: (signal?: AbortSignal) => Promise<string[]>;
  /**
   * CTP-624: `sitemap-index` sources only — one child sitemap's `<url>`
   * entries in document order, before cross-child dedupe/excludes (the
   * connector owns corpus shape so cursor offsets stay well-defined).
   */
  fetchSitemapChild?: (
    url: string,
    signal?: AbortSignal
  ) => Promise<JsonLdDiscoveryUrl[]>;
}

/**
 * Thrown in fixture mode when `onMissingDetailFixture: "skip"` is set and a
 * discovered detail URL has no committed fixture. The connector maps it to a
 * `null` fetch result so offline replay scopes to the fixture-backed corpus
 * instead of erroring on every unrecorded URL (CTP-647).
 */
export class MissingDetailFixtureError extends Error {
  constructor(slug: string, url: string) {
    super(`Missing ${slug} detail fixture for ${url}`);
    this.name = "MissingDetailFixtureError";
  }
}

export interface JsonLdClientOptions {
  config: JsonLdConnectorConfig;
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  /**
   * Fixture mode only. `"throw"` (default) keeps the hard `Missing … detail
   * fixture` error so specs fail loudly on unrecorded detail URLs; `"skip"`
   * throws `MissingDetailFixtureError`, which the connector turns into a
   * `null` fetch result. Audit tooling uses `"skip"` to replay only the
   * detail-backed slice of a listing fixture.
   */
  onMissingDetailFixture?: "throw" | "skip";
  /** Maximum time for one live request, including response-body consumption. */
  timeoutMs?: number;
}

export const createJsonLdClient = (
  options: JsonLdClientOptions
): JsonLdClient => {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch(config.slug);
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const liveEnabled =
    options.liveEnabled ??
    (config.liveEnvVar ? process.env[config.liveEnvVar] === "1" : false);
  const listingFixturePath =
    options.listingFixturePath ??
    config.listingFixturePath ??
    `${config.slug}/listing-page-0.json`;
  const detailFixtures = options.detailFixtures ?? config.detailFixtures ?? {};
  const sitemapFixtures = config.sitemapFixtures ?? {};

  const fetchLiveText = async (
    url: string,
    parentSignal?: AbortSignal
  ): Promise<string> =>
    await withHttpTimeout(
      async (signal) => {
        const response = await fetchImpl(url, {
          headers: toLiveFetchHeadersInit(buildLiveFetchHeaders()),
          signal,
        });
        return await readLiveHtmlOrThrow({
          response,
          slug: config.slug,
          url,
        });
      },
      timeoutMs,
      parentSignal
    );

  const fetchJsonListingPages = async (
    firstRaw: string,
    fetchPage: (page: number, pageSize: number) => Promise<string>
  ): Promise<JsonLdDiscoveryUrl[]> => {
    if (config.discovery.kind !== "json-listing") {
      return parseListingSource(config, firstRaw);
    }
    const { pagination } = config.discovery;
    if (!pagination) {
      return parseListingSource(config, firstRaw);
    }
    const { page, pageSize, pageCount } = validateJsonListingPagination(
      extractJsonListingPagination(firstRaw, pagination, config.discovery.url),
      pagination,
      config.discovery.url
    );
    const discovered = parseListingSource(config, firstRaw);
    for (let nextPage = page + 1; nextPage <= pageCount; nextPage += 1) {
      // oxlint-disable-next-line no-await-in-loop -- pagination requests stay ordered and bounded.
      const raw = await fetchPage(nextPage, pageSize);
      discovered.push(...parseListingSource(config, raw));
    }
    const seen = new Set<string>();
    return discovered.filter((entry) => {
      if (seen.has(entry.url)) {
        return false;
      }
      seen.add(entry.url);
      return true;
    });
  };

  /** `sitemap-index` only: narrows the discovery config or throws. */
  const sitemapIndexDiscovery = () => {
    const { discovery } = config;
    if (discovery.kind !== "sitemap-index") {
      throw new Error(`${config.slug} is not a sitemap-index source`);
    }
    return discovery;
  };

  /** The index document's selected child sitemap URLs in walk order. */
  const fetchSitemapIndexChildren = async (
    signal?: AbortSignal
  ): Promise<string[]> => {
    const discovery = sitemapIndexDiscovery();
    let index: string;
    if (liveEnabled) {
      index = await fetchLiveText(discovery.url, signal);
    } else {
      const fixture = await loadConnectorFixture<string>(listingFixturePath);
      index = fixture.payload;
    }
    return selectSitemapIndexChildren(
      index,
      discovery.childPattern,
      discovery.newest
    );
  };

  /** One child sitemap's `<url>` entries in document order. */
  const fetchSitemapChildUrls = async (
    childUrl: string,
    signal?: AbortSignal
  ): Promise<JsonLdDiscoveryUrl[]> => {
    sitemapIndexDiscovery();
    if (liveEnabled) {
      return extractSitemapUrls(await fetchLiveText(childUrl, signal));
    }
    const fixturePath = sitemapFixtures[childUrl];
    if (!fixturePath) {
      throw new Error(`Missing ${config.slug} sitemap fixture for ${childUrl}`);
    }
    const fixture = await loadConnectorFixture<string>(fixturePath);
    return extractSitemapUrls(fixture.payload);
  };

  return {
    fetchDetail: async (url, signal) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[url];
        if (!relativePath) {
          if (options.onMissingDetailFixture === "skip") {
            throw new MissingDetailFixtureError(config.slug, url);
          }
          throw new Error(`Missing ${config.slug} detail fixture for ${url}`);
        }
        const fixture = await loadConnectorFixture<unknown>(relativePath);
        return buildDetailPayload(
          config,
          url,
          detailFixtureBody(fixture.payload)
        );
      }
      const html = await fetchLiveText(
        resolveDetailFetchUrl(config, url),
        signal
      );
      return buildDetailPayload(config, url, html);
    },
    fetchListing: async (signal) => {
      if (config.discovery.kind === "sitemap-index") {
        const discovered: JsonLdDiscoveryUrl[] = [];
        for (const childUrl of await fetchSitemapIndexChildren(signal)) {
          // oxlint-disable-next-line no-await-in-loop -- child requests stay sequential
          discovered.push(...(await fetchSitemapChildUrls(childUrl, signal)));
        }
        return applyExcludes(dedupeUrls(discovered), config.excludePatterns);
      }
      if (!liveEnabled) {
        if (config.discovery.kind === "json-listing") {
          const fixture =
            await loadConnectorFixture<unknown>(listingFixturePath);
          return await fetchJsonListingPages(
            JSON.stringify(fixture.payload),
            () => {
              throw new Error(
                `JSON listing fixture ${listingFixturePath} requires an unavailable page`
              );
            }
          );
        }
        const fixture = await loadConnectorFixture<string>(listingFixturePath);
        return parseListingSource(config, fixture.payload);
      }
      const raw = await fetchLiveText(config.discovery.url, signal);
      return await fetchJsonListingPages(raw, async (page, pageSize) => {
        const nextUrl = new URL(config.discovery.url);
        if (config.discovery.kind !== "json-listing") {
          return raw;
        }
        const { pagination } = config.discovery;
        nextUrl.searchParams.set(pagination?.pageParam ?? "page", String(page));
        nextUrl.searchParams.set(
          pagination?.pageSizeParam ?? "pageSize",
          String(pageSize)
        );
        return await fetchLiveText(nextUrl.toString(), signal);
      });
    },
    fetchSitemapChild: fetchSitemapChildUrls,
    fetchSitemapIndex: fetchSitemapIndexChildren,
  };
};
