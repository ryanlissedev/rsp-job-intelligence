import { resolveEgressFetch } from "../egress";
import { createJsonLdClient } from "../json-ld/client";
import type { JsonLdClient, JsonLdClientOptions } from "../json-ld/client";
import { extractListingLinks } from "../json-ld/discovery";
import { fetchPlanetInterimListingPages } from "./pagination";
import type { PlanetInterimPaginationOptions } from "./pagination";

export interface PlanetInterimClientOptions extends JsonLdClientOptions {
  maxPages?: number;
  pageDelayMs?: number;
}

export const createPlanetInterimClient = (
  options: PlanetInterimClientOptions
): JsonLdClient => {
  const baseClient = createJsonLdClient(options);
  const liveEnabled =
    options.liveEnabled ?? process.env[options.config.liveEnvVar ?? ""] === "1";
  if (!liveEnabled || options.config.discovery.kind !== "listing") {
    return baseClient;
  }
  const { discovery } = options.config;
  const fetchImpl =
    options.fetchImpl ?? resolveEgressFetch(options.config.slug);
  const pagination: PlanetInterimPaginationOptions = {
    fetchImpl,
    maxPages: options.maxPages,
    pageDelayMs: options.pageDelayMs,
    timeoutMs: options.timeoutMs,
    url: discovery.url,
  };
  return {
    fetchDetail: baseClient.fetchDetail,
    fetchListing: async (signal) => {
      const pages = await fetchPlanetInterimListingPages({
        ...pagination,
        signal,
      });
      const seen = new Set<string>();
      return pages.flatMap((page) =>
        extractListingLinks(
          page,
          discovery.linkPattern,
          options.config.detailBaseUrl ?? discovery.url
        ).filter(({ url }) => {
          if (seen.has(url)) {
            return false;
          }
          seen.add(url);
          return true;
        })
      );
    },
  };
};
