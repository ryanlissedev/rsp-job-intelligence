import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { NotFoundFault, ValidationFault } from "../effect-runtime";
import {
  createJsonLdClient,
  extractListingLinks,
  extractJsonListingUrls,
  extractSitemapUrls,
  selectSitemapIndexChildren,
} from "./client";
import { asmlConfig } from "./configs/asml";
import { bijOranjeConfig } from "./configs/bij-oranje";
import { bluetrailConfig } from "./configs/bluetrail";
import { heroConfig } from "./configs/hero";
import { proActConfig } from "./configs/pro-act";
import { rabobankConfig } from "./configs/rabobank";
import { tbiConfig } from "./configs/tbi";
import { tenmonksConfig } from "./configs/tenmonks";
import { werkenVoorNederlandConfig } from "./configs/werken-voor-nederland";
import { createJsonLdConnector, urlSlugBronReferentie } from "./connector";
import {
  extractJobPosting,
  extractJsonLdNodes,
  extractLabelBlock,
  pickJobPosting,
} from "./extract";
import { HttpStatusError } from "./live-fetch";
import type { JsonLdConnectorConfig } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("extractJsonLdNodes / pickJobPosting", () => {
  it("expands @graph wrappers and finds the JobPosting among sibling nodes", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},{"@type":"Organization","name":"y"}]}</script><script type="application/ld+json">{"@type":"JobPosting","title":"Tester"}</script>`;
    const nodes = extractJsonLdNodes(html);
    expect(nodes).toHaveLength(3);
    expect(pickJobPosting(nodes)).toMatchObject({ title: "Tester" });
  });

  it("recognises a JobPosting inside an @type array", () => {
    const nodes = extractJsonLdNodes(
      '<script type="application/ld+json">{"@type":["JobPosting","Thing"],"title":"Multi"}</script>'
    );
    expect(pickJobPosting(nodes)?.title).toBe("Multi");
  });

  it("tolerates malformed JSON-LD blocks instead of throwing", () => {
    const html =
      '<script type="application/ld+json">{not valid json</script><script type="application/ld+json">{"@type":"JobPosting","title":"Ok"}</script>';
    expect(extractJobPosting(html)).toMatchObject({ title: "Ok" });
  });

  it("keeps blocks in document order and returns no nodes for a page without JSON-LD", () => {
    const html = [
      '<script type="application/ld+json">{"a":1}</script>',
      "<div>filler</div>",
      '<script type="application/ld+json">{"b":2}</script>',
    ].join("\n");
    expect(extractJsonLdNodes(html)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(extractJsonLdNodes("<html><body>plain</body></html>")).toEqual([]);
  });

  it("finds a JobPosting nested under @graph in a later block", () => {
    const html = [
      '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>',
      '<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"Nested"}]}</script>',
    ].join("\n");
    expect(extractJobPosting(html)).toMatchObject({ title: "Nested" });
  });

  it("returns null when no JobPosting node is present", () => {
    const html =
      '<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>';
    expect(extractJobPosting(html)).toBeNull();
  });
});

describe("extractLabelBlock", () => {
  it("extracts fields from surrounding HTML by default", () => {
    const html =
      "<span><b>Startdatum</b>1 september 2026</span><span><b>Einddatum</b>31 december 2026</span>";
    const result = extractLabelBlock(html, null, {
      eindDatum: { pattern: /<b>Einddatum<\/b>(?<value>[^<]+)/u },
      startDatum: { pattern: /<b>Startdatum<\/b>(?<value>[^<]+)/u },
    });
    expect(result).toEqual({
      eindDatum: "31 december 2026",
      startDatum: "1 september 2026",
    });
  });

  it("extracts fields from the JobPosting description when source is 'description'", () => {
    const jobPosting = {
      "@type": "JobPosting",
      description: "Start: 1 oktober 2026\tEind: 30 juni 2027",
    };
    const result = extractLabelBlock("<html></html>", jobPosting, {
      eindDatum: {
        pattern: /Eind:\s*(?<value>[^<\t]+)/u,
        source: "description",
      },
      startDatum: {
        pattern: /Start:\s*(?<value>[^<\t]+)/u,
        source: "description",
      },
    });
    expect(result).toEqual({
      eindDatum: "30 juni 2027",
      startDatum: "1 oktober 2026",
    });
  });

  it("omits fields whose pattern does not match", () => {
    expect(extractLabelBlock("<html></html>", null)).toEqual({});
    expect(
      extractLabelBlock("<html></html>", null, {
        startDatum: { pattern: /<b>Startdatum<\/b>(?<value>[^<]+)/u },
      })
    ).toEqual({});
  });
});

describe("Pro-Act eindklant label pattern (guards against promoting prose, codex review)", () => {
  const eindklantField = proActConfig.labelBlock?.eindklant;
  if (!eindklantField) {
    throw new Error("expected proActConfig.labelBlock.eindklant to exist");
  }

  const extractEindklant = (description: string): string | undefined =>
    extractLabelBlock(
      "<html></html>",
      { "@type": "JobPosting", description },
      { eindklant: eindklantField }
    ).eindklant;

  it("reads 'eindklant, <Naam>,' phrasing (detail-1 fixture text)", () => {
    expect(
      extractEindklant(
        "Voor onze directe eindklant, Tweede Kamer der Staten-Generaal, zoeken wij"
      )
    ).toBe("Tweede Kamer der Staten-Generaal");
  });

  it("reads 'eindklant de <Naam>,' phrasing (detail-2 fixture text)", () => {
    expect(
      extractEindklant("eindklant de Algemene Rekenkamer, gevestigd")
    ).toBe("Algemene Rekenkamer");
  });

  it("does not promote a lowercase sentence continuation with no real name", () => {
    expect(
      extractEindklant(
        "Voor onze eindklant zoeken wij een senior developer, die"
      )
    ).toBeUndefined();
  });

  it("does not promote a lowercase common-noun phrase ('een grote gemeente')", () => {
    expect(
      extractEindklant("eindklant, een grote gemeente, zoeken")
    ).toBeUndefined();
  });

  it("does not promote a digit-led phrase ('1 van de grootste banken van Nederland', advisor review)", () => {
    expect(
      extractEindklant(
        "eindklant, 1 van de grootste banken van Nederland, zoekt"
      )
    ).toBeUndefined();
  });
});

describe("extractSitemapUrls", () => {
  it("parses <url> entries with and without lastmod, decoding XML entities", () => {
    const xml =
      "<urlset><url><loc>https://example.test/a/?x=1&amp;y=2</loc><lastmod>2026-08-01</lastmod></url><url><loc>https://example.test/b/</loc></url></urlset>";
    expect(extractSitemapUrls(xml)).toEqual([
      { lastmod: "2026-08-01", url: "https://example.test/a/?x=1&y=2" },
      { url: "https://example.test/b/" },
    ]);
  });
});

describe("selectSitemapIndexChildren", () => {
  const childPattern = /\/job-sitemap(?<chunk>\d+)\.xml/u;

  it("filters children and selects highest chunks instead of newest lastmod", () => {
    const xml = `
      <sitemapindex>
        <sitemap><loc>https://example.test/job-sitemap.xml</loc><lastmod>2026-09-17</lastmod></sitemap>
        <sitemap><loc>https://example.test/page-sitemap.xml</loc><lastmod>2026-09-18</lastmod></sitemap>
        <sitemap><loc>https://example.test/job-sitemap2.xml</loc><lastmod>2020-01-01</lastmod></sitemap>
        <sitemap><loc>https://example.test/job-sitemap3.xml</loc><lastmod>2021-01-01</lastmod></sitemap>
      </sitemapindex>`;
    expect(selectSitemapIndexChildren(xml, childPattern, 2)).toEqual([
      "https://example.test/job-sitemap3.xml",
      "https://example.test/job-sitemap2.xml",
    ]);
  });

  it("returns all matching children when newest exceeds the matches", () => {
    const xml =
      "<sitemapindex><sitemap><loc>https://example.test/job-sitemap4.xml</loc></sitemap></sitemapindex>";
    expect(selectSitemapIndexChildren(xml, childPattern, 5)).toEqual([
      "https://example.test/job-sitemap4.xml",
    ]);
  });

  it("decodes XML entities in child URLs", () => {
    const xml =
      "<sitemapindex><sitemap><loc>https://example.test/job-sitemap5.xml?x=1&amp;y=2</loc></sitemap></sitemapindex>";
    expect(selectSitemapIndexChildren(xml, childPattern, 1)).toEqual([
      "https://example.test/job-sitemap5.xml?x=1&y=2",
    ]);
  });
});

describe("sitemap-index client discovery", () => {
  it("fetches newest children sequentially, combines, and deduplicates URLs", async () => {
    const indexUrl = "https://example.test/sitemap.xml";
    const childUrls = {
      1: "https://example.test/job-sitemap1.xml",
      2: "https://example.test/job-sitemap2.xml",
      3: "https://example.test/job-sitemap3.xml",
    };
    const responses = new Map([
      [
        indexUrl,
        `<sitemapindex><sitemap><loc>${childUrls[1]}</loc></sitemap><sitemap><loc>${childUrls[2]}</loc></sitemap><sitemap><loc>${childUrls[3]}</loc></sitemap></sitemapindex>`,
      ],
      [
        childUrls[2],
        "<urlset><url><loc>https://example.test/jobs/shared</loc></url><url><loc>https://example.test/jobs/two</loc></url></urlset>",
      ],
      [
        childUrls[3],
        "<urlset><url><loc>https://example.test/jobs/shared</loc></url><url><loc>https://example.test/jobs/three</loc></url></urlset>",
      ],
    ]);
    const calls: string[] = [];
    const mockFetch: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        const body = responses.get(url);
        if (!body) {
          throw new Error(`unexpected request ${url}`);
        }
        return Promise.resolve(new Response(body, { status: 200 }));
      },
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: {
        discovery: {
          childPattern: /\/job-sitemap(?<chunk>\d+)\.xml$/u,
          kind: "sitemap-index",
          newest: 2,
          url: indexUrl,
        },
        parserVersion: "test/v1",
        slug: "test",
      },
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([
      { url: "https://example.test/jobs/shared" },
      { url: "https://example.test/jobs/three" },
      { url: "https://example.test/jobs/two" },
    ]);
    expect(calls).toEqual([indexUrl, childUrls[3], childUrls[2]]);
    expect(calls).not.toContain(childUrls[1]);
  });
});

describe("extractListingLinks", () => {
  it("resolves relative hrefs against baseUrl, matches linkPattern, and dedupes", () => {
    const html =
      '<a href="/interim-opdrachten/a">A</a><a href="/interim-opdrachten/a">A again</a><a href="/interim-opdrachten">listing</a><a href="/api/x">skip</a>';
    const urls = extractListingLinks(
      html,
      /^\/interim-opdrachten\/[a-z0-9-]+$/u,
      "https://hero.eu"
    );
    expect(urls).toEqual([{ url: "https://hero.eu/interim-opdrachten/a" }]);
  });

  it("also discovers absolute hrefs, matching the pattern against the resolved pathname", () => {
    const html =
      '<a href="https://hero.eu/interim-opdrachten/b">B absolute</a><a href="/interim-opdrachten/b">B relative</a>';
    const urls = extractListingLinks(
      html,
      /^\/interim-opdrachten\/[a-z0-9-]+$/u,
      "https://hero.eu"
    );
    expect(urls).toEqual([{ url: "https://hero.eu/interim-opdrachten/b" }]);
  });

  it("decodes HTML entities in hrefs before resolving URLs", () => {
    const urls = extractListingLinks(
      '<a href="/x?a=1&amp;b=2">X</a>',
      /^\/x$/u,
      "https://host"
    );
    expect(urls).toEqual([{ url: "https://host/x?a=1&b=2" }]);
  });
});

describe("extractJsonListingUrls", () => {
  const linkPattern = /^\/vacatures\/functie\/[^/]+\/?$/u;
  const baseUrl = "https://www.werkenbijprorail.nl/";

  it("walks an array pointer and resolves matching detail URLs", () => {
    expect(
      extractJsonListingUrls(
        JSON.stringify({
          hits: [
            { pageUrl: "/vacatures/functie/woordvoerder" },
            { pageUrl: "/vacatures/functie/technisch-projectleider" },
          ],
        }),
        "hits[].pageUrl",
        linkPattern,
        baseUrl
      )
    ).toEqual([
      { url: "https://www.werkenbijprorail.nl/vacatures/functie/woordvoerder" },
      {
        url: "https://www.werkenbijprorail.nl/vacatures/functie/technisch-projectleider",
      },
    ]);
  });

  it("returns an empty listing when an array expansion is empty", () => {
    expect(
      extractJsonListingUrls(
        '{"hits":[]}',
        "hits[].pageUrl",
        linkPattern,
        baseUrl
      )
    ).toEqual([]);
  });

  it("fetches every page described by JSON listing pagination metadata", async () => {
    const listingUrl = "https://example.test/api/jobs?page=1&pageSize=1";
    const responses = new Map([
      [
        listingUrl,
        JSON.stringify({
          hits: [{ pageUrl: "/jobs/one" }],
          pagination: { page: 1, pageSize: 1, totalMatching: 2 },
        }),
      ],
      [
        "https://example.test/api/jobs?page=2&pageSize=1",
        JSON.stringify({
          hits: [{ pageUrl: "/jobs/two" }],
          pagination: { page: 2, pageSize: 1, totalMatching: 2 },
        }),
      ],
    ]);
    const calls: string[] = [];
    const mockFetch: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        const body = responses.get(url);
        if (!body) {
          throw new Error(`unexpected request ${url}`);
        }
        return Promise.resolve(new Response(body, { status: 200 }));
      },
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: {
        detailBaseUrl: "https://example.test/",
        discovery: {
          kind: "json-listing",
          linkPattern: /^\/jobs\/[^/]+$/u,
          pagination: {
            pageParam: "page",
            pagePointer: "pagination.page",
            pageSizeParam: "pageSize",
            pageSizePointer: "pagination.pageSize",
            totalPointer: "pagination.totalMatching",
          },
          url: listingUrl,
          urlPointer: "hits[].pageUrl",
        },
        parserVersion: "test/v1",
        slug: "test-json-pagination",
      },
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([
      { url: "https://example.test/jobs/one" },
      { url: "https://example.test/jobs/two" },
    ]);
    expect(calls).toEqual([
      listingUrl,
      "https://example.test/api/jobs?page=2&pageSize=1",
    ]);
  });

  it("rejects pagination metadata that cannot be safely bounded", async () => {
    const listingUrl = "https://example.test/api/jobs?page=1&pageSize=50";
    const calls: string[] = [];
    const mockFetch: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        calls.push(String(input));
        return Promise.resolve(
          Response.json({
            hits: [{ pageUrl: "/jobs/one" }],
            pagination: { page: -1_000_000, pageSize: 50, totalMatching: 1 },
          })
        );
      },
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: {
        detailBaseUrl: "https://example.test/",
        discovery: {
          kind: "json-listing",
          linkPattern: /^\/jobs\/[^/]+$/u,
          pagination: {
            pageParam: "page",
            pagePointer: "pagination.page",
            pageSizeParam: "pageSize",
            pageSizePointer: "pagination.pageSize",
            totalPointer: "pagination.totalMatching",
          },
          url: listingUrl,
          urlPointer: "hits[].pageUrl",
        },
        parserVersion: "test/v1",
        slug: "test-json-pagination-invalid",
      },
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).rejects.toThrow(
      "invalid page, page size, or total"
    );
    expect(calls).toEqual([listingUrl]);
  });

  it("walks nested arrays and keeps only string leaves", () => {
    expect(
      extractJsonListingUrls(
        JSON.stringify({
          groups: [
            { jobs: [{ url: "/vacatures/functie/a" }, { url: 123 }] },
            { jobs: [{ url: "/vacatures/functie/b" }] },
          ],
        }),
        "groups[].jobs[].url",
        linkPattern,
        baseUrl
      )
    ).toEqual([
      { url: "https://www.werkenbijprorail.nl/vacatures/functie/a" },
      { url: "https://www.werkenbijprorail.nl/vacatures/functie/b" },
    ]);
  });

  it("filters non-matching paths and deduplicates absolute URLs", () => {
    expect(
      extractJsonListingUrls(
        JSON.stringify({
          hits: [
            { pageUrl: "/vacatures/functie/a" },
            { pageUrl: "/vacatures" },
            { pageUrl: "/vacatures/functie/a" },
            {
              pageUrl: "https://www.werkenbijprorail.nl/vacatures/functie/a",
            },
          ],
        }),
        "hits[].pageUrl",
        linkPattern,
        baseUrl
      )
    ).toEqual([{ url: "https://www.werkenbijprorail.nl/vacatures/functie/a" }]);
  });

  it("throws on invalid JSON and pointer misses", () => {
    expect(() =>
      extractJsonListingUrls("not json", "hits[].pageUrl", linkPattern, baseUrl)
    ).toThrow(/Invalid JSON listing response/u);
    expect(() =>
      extractJsonListingUrls(
        '{"results":[]}',
        "hits[].pageUrl",
        linkPattern,
        baseUrl
      )
    ).toThrow(/did not resolve/u);
  });

  it("throws when an array pointer targets a non-array", () => {
    expect(() =>
      extractJsonListingUrls(
        '{"hits":{"pageUrl":"/vacatures/functie/a"}}',
        "hits[].pageUrl",
        linkPattern,
        baseUrl
      )
    ).toThrow(/expected "hits" to be an array/u);
  });
});

describe("urlSlugBronReferentie", () => {
  it("strips leading/trailing slashes and decodes the path", () => {
    expect(
      urlSlugBronReferentie(
        "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/"
      )
    ).toBe("opdrachten/Interim/ciam-tester");
    expect(
      urlSlugBronReferentie(
        "https://hero.eu/interim-opdrachten/devops-engineer-1f2fde9f"
      )
    ).toBe("interim-opdrachten/devops-engineer-1f2fde9f");
  });
});

const runFixtureIngest = (config: JsonLdConnectorConfig, bronId: string) =>
  runConnector({
    bronId,
    bronSlug: config.slug,
    checkpoint: null,
    connector: createJsonLdConnector({
      bronId,
      client: createJsonLdClient({ config, liveEnabled: false }),
      config,
    }),
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "test",
    runLifecycleStore: new InMemoryRunLifecycleStore(),
    scrapeRunId: `run-${config.slug}-1`,
    startedAt: new Date("2026-08-31T10:30:00.000Z"),
  });

describe.each([
  ["bluetrail", bluetrailConfig],
  ["hero", heroConfig],
  ["pro-act", proActConfig],
])("%s JSON-LD connector", (slug, config) => {
  it("exports its current parser version", () => {
    expect(config.parserVersion).toBe(
      slug === "bluetrail" ? "bluetrail/v3" : `${slug}/v2`
    );
  });

  // BlueTrail's listing fixture carries a 3rd sitemap entry
  // (adviseur-privacy-ibd, added 2026-09-15 to make the live-captured F15
  // skills fixture reachable from the fixture-mode ingest pipeline).
  const expectedItemCount = slug === "bluetrail" ? 3 : 2;

  it("ingests listing + detail fixtures with found/new/changed/rejected/error metrics", async () => {
    const result = await runFixtureIngest(config, `bron-${slug}-fixture`);
    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: expectedItemCount,
      new: expectedItemCount,
      rejected: 0,
    });
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = `bron-${slug}-replay`;
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({ config, liveEnabled: false }),
      config,
    });
    const sharedInput = {
      bronId,
      bronSlug: config.slug,
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore,
      observationRecorder: recorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    };

    await runConnector({ ...sharedInput, scrapeRunId: `run-${slug}-replay-1` });
    await runConnector({ ...sharedInput, scrapeRunId: `run-${slug}-replay-2` });

    expect(recorder.records).toHaveLength(expectedItemCount);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(expectedItemCount);
  });

  it("reports a single, non-paginated discovery pass (hasMore: false)", async () => {
    const bronId = `bron-${slug}-window`;
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({ config, liveEnabled: false }),
      config,
    });
    const result = await connector.discover(null);
    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(expectedItemCount);
  });
});

describe("raw-store write retry (CTP-609)", () => {
  it("retries a transient object-store failure instead of failing the run", async () => {
    const objectStore = new InMemoryObjectStore();
    let putCalls = 0;
    const flakyStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: (path: string) => objectStore.get(path),
      put: (object: Parameters<InMemoryObjectStore["put"]>[0]) => {
        putCalls += 1;
        if (putCalls === 1) {
          return Promise.reject(
            new Error("simulated transient object-store error")
          );
        }
        return objectStore.put(object);
      },
    };
    const bronId = "bron-bluetrail-flaky-store";
    const result = await runConnector({
      bronId,
      bronSlug: bluetrailConfig.slug,
      checkpoint: null,
      connector: createJsonLdConnector({
        bronId,
        client: createJsonLdClient({
          config: bluetrailConfig,
          liveEnabled: false,
        }),
        config: bluetrailConfig,
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: flakyStore,
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy: { ...retryPolicy, maxAttempts: 3 },
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-bluetrail-flaky-1",
      startedAt: new Date("2026-08-31T10:30:00.000Z"),
    });
    expect(result.metrics.error).toBe(0);
    expect(result.metrics.new).toBe(3);
    expect(putCalls).toBeGreaterThan(3);
  });
});

describe("Bij Oranje JSON-LD connector", () => {
  const sampleUrl =
    "https://www.bijoranje.nl/vacatures/onbekend/data-analist-noord-holland-65099";

  it("uses the job sitemap and discovers the sample vacancy", async () => {
    expect(bijOranjeConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://www.bijoranje.nl/sitemap-jobs-1.xml",
    });
    const client = createJsonLdClient({
      config: bijOranjeConfig,
      liveEnabled: false,
    });

    const urls = await client.fetchListing();

    expect(urls).toHaveLength(3);
    expect(urls).toContainEqual({ url: sampleUrl });
  });

  it("parses the literal JobPosting fields from the 65099 detail fixture", async () => {
    const client = createJsonLdClient({
      config: bijOranjeConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error("expected a Bij Oranje JobPosting JSON-LD node");
    }

    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-09-15",
      employmentType: "CONTRACTOR",
      identifier: { value: "65099" },
      title: "Data Analist",
    });
  });

  it("drops category roots and non-www duplicates from sitemap discovery", async () => {
    const sitemapXml =
      "<urlset>" +
      `<url><loc>${sampleUrl}</loc></url>` +
      "<url><loc>https://www.bijoranje.nl/vacatures/ict-informatievoorziening</loc></url>" +
      "<url><loc>https://bijoranje.nl/vacatures/onbekend/data-analist-noord-holland-65099</loc></url>" +
      "</urlset>";
    const mockFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(sitemapXml, { status: 200 })),
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: bijOranjeConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([{ url: sampleUrl }]);
  });
});

describe("TenMonks JSON-LD connector", () => {
  const sampleUrl = "https://tenmonks.nl/opdrachten/34350/data-analist/";

  it("uses assignment-sitemap1 and discovers the sample vacancy", async () => {
    expect(tenmonksConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://tenmonks.nl/assignment-sitemap1.xml",
    });
    const client = createJsonLdClient({
      config: tenmonksConfig,
      liveEnabled: false,
    });

    const urls = await client.fetchListing();

    expect(urls).toHaveLength(3);
    expect(urls).toContainEqual({ url: sampleUrl });
  });

  it("parses the literal JobPosting fields from the 34350 detail fixture", async () => {
    const client = createJsonLdClient({
      config: tenmonksConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error("expected a TenMonks JobPosting JSON-LD node");
    }

    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-09-15",
      employmentType: ["FULL_TIME"],
      identifier: { value: "JP033750" },
      title: "Data Analist",
    });
  });

  it("drops the opdrachten root, malformed detail paths, and wp-admin URLs", async () => {
    const sitemapXml =
      "<urlset>" +
      `<url><loc>${sampleUrl}</loc></url>` +
      "<url><loc>https://tenmonks.nl/opdrachten/</loc></url>" +
      "<url><loc>https://tenmonks.nl/opdrachten/not-a-detail</loc></url>" +
      "<url><loc>https://tenmonks.nl/wp-admin/edit.php</loc></url>" +
      "</urlset>";
    const mockFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(sitemapXml, { status: 200 })),
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: tenmonksConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([{ url: sampleUrl }]);
  });
});

describe("Werken voor Nederland JSON-LD connector", () => {
  const sampleUrl =
    "https://www.werkenvoornederland.nl/vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570";

  it("uses sitemap-vacatures.xml and discovers the sample vacancy", async () => {
    expect(werkenVoorNederlandConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://www.werkenvoornederland.nl/sitemap-vacatures.xml",
    });
    const client = createJsonLdClient({
      config: werkenVoorNederlandConfig,
      liveEnabled: false,
    });

    const urls = await client.fetchListing();

    expect(urls).toHaveLength(2);
    expect(urls).toContainEqual({ lastmod: "2026-09-09", url: sampleUrl });
  });

  it("parses the literal JobPosting fields from the sample detail fixture", async () => {
    const client = createJsonLdClient({
      config: werkenVoorNederlandConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error(
        "expected a Werken voor Nederland JobPosting JSON-LD node"
      );
    }

    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-09-09",
      employmentType: "TEMPORARY",
      identifier: { value: "69005" },
      title: "Kubernetes Software Platform Engineer",
    });
  });

  it("keeps only exact one-segment vacancy detail URLs", async () => {
    const sitemapXml =
      "<urlset>" +
      `<url><loc>${sampleUrl}</loc></url>` +
      "<url><loc>https://www.werkenvoornederland.nl/vacatures</loc></url>" +
      "<url><loc>https://www.werkenvoornederland.nl/login</loc></url>" +
      "<url><loc>https://www.werkenvoornederland.nl/over-de-rijksoverheid</loc></url>" +
      "<url><loc>https://www.werkenvoornederland.nl/vacatures/afdeling/rol</loc></url>" +
      "</urlset>";
    const mockFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(sitemapXml, { status: 200 })),
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: werkenVoorNederlandConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([{ url: sampleUrl }]);
  });
});

describe("Rabobank careers JSON-LD connector", () => {
  const sampleUrl =
    "https://rabobank.jobs/en/job/active-directory-engineer/JR_00144349/";
  const siblingUrl =
    "https://rabobank.jobs/en/job/business-analyst-data-lineage-platform/JR_00145415/";
  const nlTwinUrl =
    "https://rabobank.jobs/nl/vacature/active-directory-engineer/JR_00144349/";

  it("uses the sitemap and keeps only EN JR detail URLs", async () => {
    expect(rabobankConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://rabobank.jobs/api/sitemap/",
    });
    expect(rabobankConfig.liveEnvVar).toBe("RABOBANK_LIVE");
    expect(rabobankConfig.parserVersion).toBe("rabobank/v2");
    expect(rabobankConfig.detailSynthesizer).toBeUndefined();

    const client = createJsonLdClient({
      config: rabobankConfig,
      liveEnabled: false,
    });
    const urls = await client.fetchListing();

    expect(urls).toHaveLength(2);
    expect(urls).toContainEqual({
      lastmod: "2026-09-15T12:35:39.315Z",
      url: sampleUrl,
    });
    expect(urls).toContainEqual({
      lastmod: "2026-09-15T12:35:39.315Z",
      url: siblingUrl,
    });
    expect(urls).not.toContainEqual({
      lastmod: "2026-09-15T12:35:39.315Z",
      url: nlTwinUrl,
    });
    expect(urls.some(({ url }) => url.includes("/en/jobs/"))).toBe(false);
    expect(urls.some(({ url }) => url.includes("/artikel/"))).toBe(false);
    expect(urls.some(({ url }) => url.includes("job-alert"))).toBe(false);
  });

  it("parses literal JobPosting fields from the sample detail fixture", async () => {
    const client = createJsonLdClient({
      config: rabobankConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error("expected a Rabobank JobPosting JSON-LD node");
    }

    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-09-15",
      employmentType: "fulltime",
      identifier: { value: "JR_00144349" },
      jobLocation: {
        address: { addressLocality: "Utrecht" },
      },
      title: "Active Directory  Engineer",
    });
  });
});

describe("TBI Drupal/ubeeo JSON-LD connector", () => {
  const sampleUrl =
    "https://werkenbij.tbi.nl/vacatures/service-technicus-w-1280611";
  const siblingUrl =
    "https://werkenbij.tbi.nl/vacatures/hoofduitvoerder-middenspanning-1148185";

  it("uses the sitemap and keeps only canonical vacancy detail URLs", async () => {
    expect(tbiConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://werkenbij.tbi.nl/sitemap.xml",
    });
    expect(tbiConfig.liveEnvVar).toBe("TBI_LIVE");
    expect(tbiConfig.parserVersion).toBe("tbi/v2");

    const client = createJsonLdClient({
      config: tbiConfig,
      liveEnabled: false,
    });
    const urls = await client.fetchListing();

    expect(urls).toHaveLength(2);
    expect(urls).toContainEqual({ url: sampleUrl });
    expect(urls).toContainEqual({ url: siblingUrl });
    expect(urls.some(({ url }) => url === "https://werkenbij.tbi.nl/")).toBe(
      false
    );
    expect(urls.some(({ url }) => url.includes("/ondernemingen/"))).toBe(false);
  });

  it("honours robots by excluding query URLs and non-detail sitemap noise", async () => {
    const mockFetch: typeof fetch = Object.assign(
      () =>
        Promise.resolve(
          new Response(
            "<urlset>" +
              `<url><loc>${sampleUrl}</loc></url>` +
              `<url><loc>${sampleUrl}?opleiding=techniek</loc></url>` +
              "<url><loc>https://werkenbij.tbi.nl/node/123</loc></url>" +
              "<url><loc>https://werkenbij.tbi.nl/vacatures/</loc></url>" +
              "</urlset>"
          )
        ),
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: tbiConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    await expect(client.fetchListing()).resolves.toEqual([{ url: sampleUrl }]);
  });

  it("parses literal JobPosting fields from the sample detail fixture", async () => {
    const client = createJsonLdClient({
      config: tbiConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error("expected a TBI JobPosting JSON-LD node");
    }

    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-05-23T12:36:00+02:00",
      employmentType: "Fulltime",
      hiringOrganization: {
        "@id": "ubeeo-8038",
        name: "Croonwolter&amp;dros",
      },
      identifier: { value: "1280611" },
      jobLocation: [{ address: { addressLocality: "Amersfoort" } }],
      title: "Service Technicus W",
    });
  });
});

describe("ASML Sitecore/Workday JSON-LD connector", () => {
  const sampleUrl =
    "https://www.asml.com/en/careers/find-your-job/senior-electrical-safety-expert-nominated-person--installatie-verantwoordelijke-euv-factory-j00333473";

  it("uses the job-posting sitemap and excludes the listing root", async () => {
    expect(asmlConfig.discovery).toEqual({
      kind: "sitemap",
      url: "https://www.asml.com/en/job_posting-sitemap.xml",
    });
    const client = createJsonLdClient({
      config: asmlConfig,
      liveEnabled: false,
    });

    const urls = await client.fetchListing();

    expect(urls).toHaveLength(2);
    expect(urls).toContainEqual({
      lastmod: "2026-08-17",
      url: sampleUrl,
    });
    expect(urls).not.toContainEqual({
      lastmod: "2026-09-16",
      url: "https://www.asml.com/en/careers/find-your-job",
    });
  });

  it("synthesises literal JobPosting and Workday label fields from __NEXT_DATA__", async () => {
    const client = createJsonLdClient({
      config: asmlConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(sampleUrl);
    if (!detail.jobPosting) {
      throw new Error("expected ASML JobPosting synthesis");
    }

    expect(detail.jobPosting).toMatchObject({
      "@type": "JobPosting",
      datePosted: "2026-08-17T00:00:00",
      employmentType: "FULL_TIME",
      identifier: { value: "J-00333473" },
      jobLocation: {
        address: { addressCountry: "NL", addressLocality: "Veldhoven" },
      },
      title:
        "Senior Electrical Safety Expert (Nominated Person – Installatie verantwoordelijke EUV Factory)",
      url: sampleUrl,
    });
    expect(detail.labelBlock.referentienummer).toBe("J-00333473");
    expect(detail.labelBlock.workdayApplyUrl).toBe(
      "https://asml.wd3.myworkdayjobs.com/ASMLEXT1/job/Veldhoven-Netherlands/Senior-Electrical-Safety-Expert--Nominated-Person---Installatie-verantwoordelijke-EUV-Factory-_J-00333473/apply"
    );
  });
});

describe("BlueTrail excludePatterns", () => {
  it("does not exclude a real vacancy slug that happens to start with 'or-'", async () => {
    const sitemapXml =
      "<urlset>" +
      "<url><loc>https://www.bluetrail.nl/opdrachten/</loc></url>" +
      "<url><loc>https://www.bluetrail.nl/opdrachten/?order=asc</loc></url>" +
      "<url><loc>https://www.bluetrail.nl/opdrachten/?_sft_categorie=interim</loc></url>" +
      "<url><loc>https://www.bluetrail.nl/opdrachten/Interim/or-adviseur/</loc></url>" +
      "</urlset>";
    const mockFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(sitemapXml, { status: 200 })),
      { preconnect: () => {} }
    );
    const client = createJsonLdClient({
      config: bluetrailConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });

    const urls = await client.fetchListing();

    expect(urls).toEqual([
      { url: "https://www.bluetrail.nl/opdrachten/Interim/or-adviseur/" },
    ]);
  });
});

describe("BlueTrail label-block extraction", () => {
  it("reads Startdatum/Einddatum/Uren per week/Sluitingsdatum from the sidebar table", async () => {
    const bronId = "bron-bluetrail-labels";
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({
        config: bluetrailConfig,
        liveEnabled: false,
      }),
      config: bluetrailConfig,
    });
    const discovered = await connector.discover(null);
    const item = discovered.items.find((entry) =>
      entry.bronReferentie.includes("ciam-tester")
    );
    if (!item) {
      throw new Error("expected a ciam-tester discover item");
    }
    const fetched = await connector.fetch(item);
    if (!fetched || fetched.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    // SAFETY: connector.fetch() serialises a JsonLdFetchedPayload as JSON body above.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      labelBlock: Record<string, string>;
    };
    expect(payload.labelBlock).toMatchObject({
      eindDatum: "31 december 2026",
      locatie: "Apeldoorn",
      referentienummer: "2026-08243",
      sluitingsDatum: "2 september 2026",
      startDatum: "1 september 2026",
      urenPerWeek: "32u p/w",
    });
  });

  it("reads the 'Competenties:' list from a live 2026-09-15 capture (F15)", async () => {
    const client = createJsonLdClient({
      config: bluetrailConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(
      "https://www.bluetrail.nl/opdrachten/Interim/adviseur-privacy-ibd/"
    );
    expect(detail.labelBlock.competenties).toContain(
      "Analytisch &amp; conceptueel sterk"
    );
    expect(detail.labelBlock.competenties).toContain(
      "Sterke schrijfvaardigheid"
    );
    // The raw captured block must NOT swallow the following "Eisen"/"Wensen"
    // sentences -- only the Competenties <ul> itself.
    expect(detail.labelBlock.competenties).not.toContain("afgeronde hbo");
  });
});

describe("BlueTrail eindklant label pattern (F02)", () => {
  const eindklantField = bluetrailConfig.labelBlock?.eindklant;
  if (!eindklantField) {
    throw new Error("expected bluetrailConfig.labelBlock.eindklant to exist");
  }
  const extractEindklant = (description: string): string | undefined =>
    extractLabelBlock(
      "<html></html>",
      { "@type": "JobPosting", description },
      { eindklant: eindklantField }
    ).eindklant;

  it.each([
    [
      "<span >Voor Gemeente Stichtse Vecht zoeken wij een Architect",
      "Gemeente Stichtse Vecht",
    ],
    [
      "Voor de Belastingdienst zoeken wij een ervaren Senior Solution architect",
      "Belastingdienst",
    ],
    [
      "Voor het College ter Beoordeling van Geneesmiddelen (CBG) zoeken wij een",
      "College ter Beoordeling van Geneesmiddelen (CBG)",
    ],
  ])(
    "reads the end client from a live broker-fronted opening (%s)",
    (text, expected) => {
      expect(extractEindklant(text)).toBe(expected);
    }
  );

  it.each([
    "Voor de afdeling Burgerzaken zoeken wij een medewerker",
    "Voor onze klant zoeken wij een senior developer",
    "De Operatie van de Politie en haar ketenpartners vragen om",
    "Je werkt bij de uitvoering. Voor de Belastingdienst zoeken wij ook een tester",
  ])("leaves prose without an explicit named client unmatched (%s)", (text) => {
    expect(extractEindklant(text)).toBeUndefined();
  });

  it("reads Gemeente Stichtse Vecht from the Circle8-fronted live capture", async () => {
    const client = createJsonLdClient({
      config: bluetrailConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(
      "https://www.bluetrail.nl/opdrachten/Interim/architect-ict-en-informatielandschap/"
    );
    expect(detail.jobPosting?.hiringOrganization).toMatchObject({
      name: "Circle8",
    });
    expect(detail.labelBlock.eindklant).toBe("Gemeente Stichtse Vecht");
  });
});

describe("Pro-Act label-block extraction from JobPosting description", () => {
  it("reads Start/Eind/Inzet/Tarief/Locatie out of the description text", async () => {
    const bronId = "bron-proact-labels";
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({ config: proActConfig, liveEnabled: false }),
      config: proActConfig,
    });
    const discovered = await connector.discover(null);
    const item = discovered.items.find((entry) =>
      entry.bronReferentie.includes("senior-azure-operations-engineer")
    );
    if (!item) {
      throw new Error("expected a senior-azure-operations-engineer item");
    }
    const fetched = await connector.fetch(item);
    if (!fetched || fetched.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    // SAFETY: connector.fetch() serialises a JsonLdFetchedPayload as JSON body above.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      labelBlock: Record<string, string>;
    };
    expect(payload.labelBlock).toMatchObject({
      eindDatum: "30 juni 2027",
      eindklant: "Tweede Kamer der Staten-Generaal",
      locatie: "hybride",
      startDatum: "1 oktober 2026",
      tarief: "marktconform",
      urenPerWeek: "36 uur per week",
    });
  });

  it("reads the eindklant label from the 'eindklant de <naam>,' phrasing too (detail-2 fixture)", async () => {
    const bronId = "bron-proact-eindklant-2";
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({ config: proActConfig, liveEnabled: false }),
      config: proActConfig,
    });
    const discovered = await connector.discover(null);
    const item = discovered.items.find((entry) =>
      entry.bronReferentie.includes("iso-8783")
    );
    if (!item) {
      throw new Error("expected an iso-8783 item");
    }
    const fetched = await connector.fetch(item);
    if (!fetched || fetched.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    // SAFETY: connector.fetch() serialises a JsonLdFetchedPayload as JSON body above.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      labelBlock: Record<string, string>;
    };
    expect(payload.labelBlock).toMatchObject({
      eindklant: "Algemene Rekenkamer",
    });
  });
});

describe("rejected fetch paths", () => {
  it("rejects when listing payload is missing a url", async () => {
    const bronId = "bron-bluetrail-missing-url";
    const connector = createJsonLdConnector({
      bronId,
      client: createJsonLdClient({
        config: bluetrailConfig,
        liveEnabled: false,
      }),
      config: bluetrailConfig,
    });
    const fetched = await connector.fetch({
      bronReferentie: "x",
      contentHash: "hash",
      listingPayload: {},
    });
    expect(fetched).toMatchObject({ status: "rejected" });
  });

  it("rejects when the detail page has no JobPosting JSON-LD", async () => {
    const bronId = "bron-no-jobposting";
    const noJobPostingClient = {
      fetchDetail: () =>
        Promise.resolve({
          jobPosting: null,
          labelBlock: {},
          url: "https://x.test/a",
        }),
      fetchListing: () => Promise.resolve([]),
    };
    const connectorWithNoJobPosting = createJsonLdConnector({
      bronId,
      client: noJobPostingClient,
      config: bluetrailConfig,
    });
    const fetched = await connectorWithNoJobPosting.fetch({
      bronReferentie: "a",
      contentHash: "hash",
      listingPayload: { url: "https://x.test/a" },
    });
    expect(fetched).toMatchObject({ status: "rejected" });
  });

  it("rejects a detail URL that is gone at source (404) instead of failing the run", async () => {
    const gone404Client = {
      fetchDetail: () =>
        Promise.reject(
          new HttpStatusError({
            slug: "datajobs",
            status: 404,
            url: "https://x.test/gone",
          })
        ),
      fetchListing: () => Promise.resolve([]),
    };
    const connector = createJsonLdConnector({
      bronId: "bron-gone-404",
      client: gone404Client,
      config: bluetrailConfig,
    });
    const fetched = await connector.fetch({
      bronReferentie: "gone",
      contentHash: "hash",
      listingPayload: { url: "https://x.test/gone" },
    });
    expect(fetched).toMatchObject({ status: "rejected" });
  });

  it("rejects a detail URL gone via the Effect client (NotFoundFault)", async () => {
    const goneFaultClient = {
      fetchDetail: () =>
        Promise.reject(new NotFoundFault({ message: "gone", status: 404 })),
      fetchListing: () => Promise.resolve([]),
    };
    const connector = createJsonLdConnector({
      bronId: "bron-gone-fault",
      client: goneFaultClient,
      config: bluetrailConfig,
    });
    const fetched = await connector.fetch({
      bronReferentie: "gone",
      contentHash: "hash",
      listingPayload: { url: "https://x.test/gone" },
    });
    expect(fetched).toMatchObject({ status: "rejected" });
  });

  it.each([
    [
      "HttpStatusError 410",
      new HttpStatusError({
        slug: "randstad",
        status: 410,
        url: "https://x.test/closed",
      }),
    ],
    [
      "Effect ValidationFault 410",
      new ValidationFault({ message: "gone", status: 410 }),
    ],
  ])(
    "rejects a detail URL that answers 410 Gone (%s) instead of failing the run",
    async (_label, error) => {
      const connector = createJsonLdConnector({
        bronId: "bron-gone-410",
        client: {
          fetchDetail: () => Promise.reject(error),
          fetchListing: () => Promise.resolve([]),
        },
        config: bluetrailConfig,
      });
      const fetched = await connector.fetch({
        bronReferentie: "closed",
        contentHash: "hash",
        listingPayload: { url: "https://x.test/closed" },
      });
      expect(fetched).toEqual({
        bronReferentie: "closed",
        kind: "gone",
        reason: "detail page returned 410 — removed at source",
        status: "rejected",
      });
    }
  );

  it("keeps other 4xx detail failures fatal", async () => {
    const connector = createJsonLdConnector({
      bronId: "bron-400",
      client: {
        fetchDetail: () =>
          Promise.reject(new ValidationFault({ message: "bad", status: 400 })),
        fetchListing: () => Promise.resolve([]),
      },
      config: bluetrailConfig,
    });
    await expect(
      connector.fetch({
        bronReferentie: "bad",
        contentHash: "hash",
        listingPayload: { url: "https://x.test/bad" },
      })
    ).rejects.toBeInstanceOf(ValidationFault);
  });

  it("still propagates non-404 detail failures (500 stays fatal)", async () => {
    const serverErrorClient = {
      fetchDetail: () =>
        Promise.reject(
          new HttpStatusError({
            slug: "datajobs",
            status: 500,
            url: "https://x.test/oops",
          })
        ),
      fetchListing: () => Promise.resolve([]),
    };
    const connector = createJsonLdConnector({
      bronId: "bron-500",
      client: serverErrorClient,
      config: bluetrailConfig,
    });
    await expect(
      connector.fetch({
        bronReferentie: "oops",
        contentHash: "hash",
        listingPayload: { url: "https://x.test/oops" },
      })
    ).rejects.toThrow(HttpStatusError);
  });
});

describe("json-ld live fetch honest identity / Cloudflare (CTP-528)", () => {
  it("sends the honest product User-Agent and no Cookie on live listing fetch", async () => {
    const seen: RequestInit[] = [];
    const sitemapXml =
      "<urlset><url><loc>https://www.werkzoeken.nl/vacature/demo/</loc></url></urlset>";
    const mockFetch: typeof fetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init ?? {});
        return Promise.resolve(new Response(sitemapXml, { status: 200 }));
      },
      { preconnect: () => {} }
    );
    const { werkzoekenConfig } = await import("./configs/werkzoeken");
    const client = createJsonLdClient({
      config: werkzoekenConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });
    const urls = await client.fetchListing();
    expect(urls).toEqual([{ url: "https://www.werkzoeken.nl/vacature/demo/" }]);
    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("User-Agent")).toMatch(/^NewonesJobIntelligence\//u);
    expect(headers.get("User-Agent")).not.toContain("Chrome");
    expect(headers.get("Accept-Language")).toContain("nl-NL");
    expect(headers.get("Cookie")).toBeNull();
  });

  it("fails closed with SourceBlocked on a Cloudflare challenge", async () => {
    const mockFetch: typeof fetch = Object.assign(
      () =>
        Promise.resolve(
          new Response("<title>Just a moment...</title>", {
            headers: { "cf-mitigated": "challenge" },
            status: 403,
          })
        ),
      { preconnect: () => {} }
    );
    const { werkzoekenConfig } = await import("./configs/werkzoeken");
    const client = createJsonLdClient({
      config: werkzoekenConfig,
      fetchImpl: mockFetch,
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toThrow(
      /Cloudflare managed challenge/u
    );
    await expect(client.fetchListing()).rejects.toThrow(
      /carry no clearance cookies/u
    );
  });
});
