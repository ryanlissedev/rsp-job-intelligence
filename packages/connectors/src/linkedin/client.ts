import { loadConnectorFixture } from "../fixtures/load";
import { decodeHtmlEntities } from "../html-entities";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import { urlSlugBronReferentie } from "../json-ld/connector";
import type { JsonLdDetailPayload } from "../json-ld/discovery";
import { extractJobPosting } from "../json-ld/extract";
import {
  buildLiveFetchHeaders,
  readLiveHtmlOrThrow,
  toLiveFetchHeadersInit,
} from "../json-ld/live-fetch";
import type { JsonLdNode } from "../json-ld/types";
import {
  LINKEDIN_CRITERIA_LABELS,
  LINKEDIN_LISTING_PATH,
  LINKEDIN_LIVE_ENV,
  LINKEDIN_SEARCH_KEYWORDS,
  LINKEDIN_SEARCH_LOCATION,
} from "./types";
import type { LinkedinListingItem, LinkedinListingPage } from "./types";

export interface LinkedinClient {
  fetchDetail: (item: LinkedinListingItem) => Promise<JsonLdDetailPayload>;
  fetchListing: (start: number) => Promise<LinkedinListingPage>;
}

export interface LinkedinClientOptions {
  baseUrl?: string;
  /** Fixture path per canonical detail URL, keyed by the exact URL string. */
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  keywords?: string;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  location?: string;
  /** Maximum time for one live request, including response-body consumption. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://www.linkedin.com";
const JOB_VIEW_PATH_PATTERN = /^\/jobs\/view\/[^/]+\/?$/u;
const CARD_URN_PATTERN =
  /data-entity-urn=["']urn:li:jobPosting:(?<jobId>\d+)["']/giu;
const FULL_LINK_TAG_PATTERN =
  /<a\b[^>]*class=["'][^"']*\bbase-card__full-link\b[^"']*["'][^>]*>/iu;
const HREF_PATTERN = /href=["'](?<href>[^"']+)["']/iu;
const TITLE_PATTERN =
  /<h3\b[^>]*class=["'][^"']*\bbase-search-card__title\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/h3>/iu;
const COMPANY_PATTERN =
  /<a\b[^>]*class=["'][^"']*\bhidden-nested-link\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/a>/iu;
const LOCATION_PATTERN =
  /<span\b[^>]*class=["'][^"']*\bjob-search-card__location\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/span>/iu;
const LISTDATE_PATTERN =
  /<time\b[^>]*class=["'][^"']*\bjob-search-card__listdate\b[^"']*["'][^>]*datetime=["'](?<datetime>[^"']+)["']/iu;
// The view page renders the title as <h1>, the guest API fragment as <h2>.
const TOPCARD_TITLE_PATTERN =
  /<h[12]\b[^>]*class=["'][^"']*\btopcard__title\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/h[12]>/iu;
const ORG_LINK_PATTERN =
  /<a\b[^>]*class=["'][^"']*\btopcard__org-name-link\b[^"']*["'][^>]*href=["'](?<href>[^"']+)["'][^>]*>(?<text>[\s\S]*?)<\/a>/iu;
const ORG_FLAVOR_PATTERN =
  /<span\b[^>]*class=["'][^"']*\btopcard__flavor\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/span>/iu;
const LOCATION_BULLET_PATTERN =
  /<span\b[^>]*class=["'][^"']*\btopcard__flavor--bullet\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/span>/iu;
const POSTED_AGO_PATTERN =
  /<span\b[^>]*class=["'][^"']*\bposted-time-ago__text\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/span>/iu;
const APPLICANTS_PATTERN =
  /<figcaption\b[^>]*class=["'][^"']*\bnum-applicants__caption\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/figcaption>/iu;
const CRITERIA_ITEM_PATTERN =
  /<li\b[^>]*class=["'][^"']*\bdescription__job-criteria-item\b[^"']*["'][^>]*>(?<body>[\s\S]*?)<\/li>/giu;
const CRITERIA_SUBHEADER_PATTERN =
  /<h3\b[^>]*class=["'][^"']*\bdescription__job-criteria-subheader\b[^"']*["'][^>]*>(?<text>[\s\S]*?)<\/h3>/iu;
const H3_BLOCK_PATTERN = /<h3\b[\s\S]*?<\/h3>/giu;
const DESCRIPTION_DIV_PATTERN =
  /<div\b[^>]*class=["'][^"']*\bshow-more-less-html__markup\b[^"']*["'][^>]*>/iu;
const DIV_TAG_PATTERN = /<\/?div\b[^>]*>/giu;
// Public URLs end either `/jobs/view/<slug>-<jobId>` or `/jobs/view/<jobId>`.
const TRAILING_ID_PATTERN = /[/-](?<jobId>\d+)\/?$/u;

const cleanText = (html: string): string =>
  decodeHtmlEntities(html.replaceAll(/<[^>]+>/gu, " "))
    .replaceAll(/\s+/gu, " ")
    .trim();

const firstText = (pattern: RegExp, html: string): string | undefined => {
  pattern.lastIndex = 0;
  const text = cleanText(pattern.exec(html)?.groups?.text ?? "");
  return text || undefined;
};

/** Slices the inner content of the `<div>` whose opening tag starts at
 * `markerStart` — counts nested `div` open/close tags so a nested markup div
 * never truncates the description body. */
const extractBalancedDiv = (
  html: string,
  markerStart: number
): { content: string; end: number } | undefined => {
  DIV_TAG_PATTERN.lastIndex = markerStart;
  let depth = 0;
  let contentStart: number | undefined;
  let match = DIV_TAG_PATTERN.exec(html);
  while (match) {
    if (match[0].startsWith("</")) {
      depth -= 1;
    } else {
      depth += 1;
      contentStart ??= match.index + match[0].length;
    }
    if (depth === 0 && contentStart !== undefined) {
      return {
        content: html.slice(contentStart, match.index),
        end: match.index,
      };
    }
    match = DIV_TAG_PATTERN.exec(html);
  }
  return undefined;
};

/** Canonical public job URL: origin + pathname only. The published hrefs carry
 * per-request tracking params (`position`, `refId`, `trackingId`) that would
 * make the observation identity rotate every poll. Returns undefined for any
 * href that is not a `/jobs/view/` URL on a linkedin.com host. */
export const canonicalLinkedinJobUrl = (href: string): string | undefined => {
  try {
    const url = new URL(decodeHtmlEntities(href), DEFAULT_BASE_URL);
    if (!url.hostname.endsWith("linkedin.com")) {
      return;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (!JOB_VIEW_PATH_PATTERN.test(pathname)) {
      return;
    }
    return `${url.origin}${pathname}`;
  } catch {
    // Invalid URLs are not LinkedIn job detail routes.
  }
};

export const linkedinJobIdFromUrl = (url: string): string | undefined =>
  TRAILING_ID_PATTERN.exec(new URL(url).pathname)?.groups?.jobId;

const extractListingCard = (
  card: string,
  jobId: string
): LinkedinListingItem | undefined => {
  const anchor = FULL_LINK_TAG_PATTERN.exec(card)?.[0] ?? "";
  const href = HREF_PATTERN.exec(anchor)?.groups?.href;
  const url = href ? canonicalLinkedinJobUrl(href) : undefined;
  const titel = firstText(TITLE_PATTERN, card);
  if (!(url && titel)) {
    return;
  }
  const listdate = LISTDATE_PATTERN.exec(card)?.groups?.datetime?.trim();
  return {
    bronReferentie: urlSlugBronReferentie(url),
    geplaatst: listdate || undefined,
    jobId,
    locatie: firstText(LOCATION_PATTERN, card),
    opdrachtgever: firstText(COMPANY_PATTERN, card),
    titel,
    url,
  };
};

/** Parses one `seeMoreJobPostings` HTML fragment into listing items. Card
 * blocks are sliced between consecutive `urn:li:jobPosting` markers, so
 * non-job cards can never leak fields into a neighbouring card. */
export const parseLinkedinListing = (html: string): LinkedinListingPage => {
  CARD_URN_PATTERN.lastIndex = 0;
  const markers: { index: number; jobId: string }[] = [];
  let marker = CARD_URN_PATTERN.exec(html);
  while (marker) {
    if (marker.groups?.jobId) {
      markers.push({ index: marker.index, jobId: marker.groups.jobId });
    }
    marker = CARD_URN_PATTERN.exec(html);
  }
  const items: LinkedinListingItem[] = [];
  for (const [position, current] of markers.entries()) {
    const end = markers[position + 1]?.index ?? html.length;
    const item = extractListingCard(
      html.slice(current.index, end),
      current.jobId
    );
    if (item) {
      items.push(item);
    }
  }
  return { items };
};

/** Maps `description__job-criteria-item` blocks onto canonical label keys.
 * LinkedIn localises the labels (English on www.linkedin.com, Dutch on
 * nl.linkedin.com); both locales are in LINKEDIN_CRITERIA_LABELS. Unmapped
 * labels are dropped rather than guessed. */
export const parseLinkedinCriteria = (html: string) => {
  const criteria: Record<string, string> = {};
  CRITERIA_ITEM_PATTERN.lastIndex = 0;
  let item = CRITERIA_ITEM_PATTERN.exec(html);
  while (item) {
    const body = item.groups?.body ?? "";
    const label = cleanText(
      CRITERIA_SUBHEADER_PATTERN.exec(body)?.groups?.text ?? ""
    );
    const key = LINKEDIN_CRITERIA_LABELS.get(label.toLowerCase());
    const value = cleanText(body.replaceAll(H3_BLOCK_PATTERN, ""));
    if (key && value && criteria[key] === undefined) {
      criteria[key] = value;
    }
    item = CRITERIA_ITEM_PATTERN.exec(html);
  }
  return criteria;
};

/** LinkedIn's guest `employment type`/`Soort baan` text → the schema.org
 * token JobPosting.employmentType carries on pages that do embed JSON-LD
 * (LinkedIn emits `CONTRACTOR`/`INTERN`, per the 2026-09-18 captures).
 * Unmapped values pass through verbatim — never guessed. */
const toEmploymentTypeToken = (text: string): string => {
  switch (text.trim().toLowerCase()) {
    case "full-time":
    case "fulltime":
    case "voltijd": {
      return "FULL_TIME";
    }
    case "part-time":
    case "parttime":
    case "deeltijd": {
      return "PART_TIME";
    }
    case "contract": {
      return "CONTRACTOR";
    }
    case "temporary":
    case "tijdelijk": {
      return "TEMPORARY";
    }
    case "internship":
    case "stage": {
      return "INTERN";
    }
    case "volunteer":
    case "vrijwilligerswerk": {
      return "VOLUNTEER";
    }
    case "other":
    case "ander": {
      return "OTHER";
    }
    default: {
      return text;
    }
  }
};

const extractDescriptionHtml = (html: string): string => {
  const marker = DESCRIPTION_DIV_PATTERN.exec(html);
  if (!marker || marker.index === undefined) {
    return "";
  }
  return extractBalancedDiv(html, marker.index)?.content.trim() ?? "";
};

/**
 * Rebuilds a minimal JobPosting node from the topcard/criteria/description
 * markup when the detail page carries no `ld+json` block — a real serving
 * variant, not an edge case (2 of 3 recordings on 2026-09-18 had none).
 * Fields the markup cannot honestly supply stay absent: `datePosted` exists
 * only as the relative `posted-time-ago` phrase, `validThrough` is never in
 * markup at all, and `jobLocation` gets locality text only (no region/geo).
 * Returns null when neither a title nor a description is present — fail
 * closed, never guess.
 */
export const synthesizeJobPostingFromLinkedinMarkup = (
  html: string,
  detailUrl: string
): JsonLdNode | null => {
  const title = firstText(TOPCARD_TITLE_PATTERN, html);
  const description = extractDescriptionHtml(html);
  if (!(title || description)) {
    return null;
  }
  const criteria = parseLinkedinCriteria(html);
  const orgLink = ORG_LINK_PATTERN.exec(html);
  const orgName =
    cleanText(orgLink?.groups?.text ?? "") ||
    firstText(ORG_FLAVOR_PATTERN, html);
  const orgHref = orgLink?.groups?.href;
  const jobId = linkedinJobIdFromUrl(detailUrl);

  const hiringOrganization: JsonLdNode = {
    "@type": "Organization",
    name: orgName ?? "",
  };
  if (orgHref) {
    const decoded = decodeHtmlEntities(orgHref);
    hiringOrganization.sameAs = decoded.split("?")[0] ?? decoded;
  }
  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    description,
    hiringOrganization,
    identifier: {
      "@type": "PropertyValue",
      name: "LinkedIn",
      value: jobId ?? "",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressCountry: "NL",
        addressLocality: firstText(LOCATION_BULLET_PATTERN, html) ?? "",
      },
    },
    title: title ?? "",
    url: detailUrl,
  };
  const employmentType = criteria.employment_type;
  if (employmentType) {
    jobPosting.employmentType = toEmploymentTypeToken(employmentType);
  }
  const { industries } = criteria;
  if (industries) {
    jobPosting.industry = industries;
  }
  return jobPosting;
};

/** Detail page → JobPosting (+ label block). The explicit `ld+json` node wins
 * when LinkedIn serves it; otherwise the markup synthesizer fills in. The
 * label block always carries the published criteria list plus the relative
 * `posted-time-ago` phrase and applicant count when present. */
export const parseLinkedinDetail = (
  html: string,
  url: string
): JsonLdDetailPayload => {
  const jobPosting =
    extractJobPosting(html) ??
    synthesizeJobPostingFromLinkedinMarkup(html, url);
  const labelBlock = parseLinkedinCriteria(html);
  const geplaatst = firstText(POSTED_AGO_PATTERN, html);
  if (geplaatst) {
    labelBlock.geplaatst = geplaatst;
  }
  const applicants = firstText(APPLICANTS_PATTERN, html);
  if (applicants) {
    labelBlock.applicants = applicants;
  }
  return { jobPosting, labelBlock, url };
};

/** Recorded detail fixtures keyed by the canonical public URL. The first
 * two captures document the real no-JSON-LD serving variant (2026-09-18);
 * the third carries the JobPosting `ld+json` node. */
export const LINKEDIN_DETAIL_FIXTURES = {
  "https://nl.linkedin.com/jobs/view/freelance-ai-multimedia-designer-433-at-433-4419416701":
    "linkedin/detail-freelance-ai-multimedia-designer-433-at-433-4419416701.json",
  "https://nl.linkedin.com/jobs/view/freelance-e-bookmaker-tekst-%2B-design-%E2%80%94-spoelstra-coaching-at-spoelstra-coaching-4468200147":
    "linkedin/detail-freelance-e-bookmaker-4468200147.json",
  "https://nl.linkedin.com/jobs/view/software-engineering-expert-ai-training-%E2%82%AC65%E2%80%9390-h-at-huzzle-com-4456662010":
    "linkedin/detail-software-engineering-expert-4456662010.json",
} satisfies Record<string, string>;

export const createLinkedinClient = (
  options: LinkedinClientOptions = {}
): LinkedinClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const liveEnabled =
    options.liveEnabled ?? process.env[LINKEDIN_LIVE_ENV] === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "linkedin/listing-page-0.json";
  const detailFixtures: Record<string, string> =
    options.detailFixtures ?? LINKEDIN_DETAIL_FIXTURES;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const keywords = options.keywords ?? LINKEDIN_SEARCH_KEYWORDS;
  const location = options.location ?? LINKEDIN_SEARCH_LOCATION;

  const fetchLiveText = async (url: string): Promise<string> =>
    await withHttpTimeout(async (signal) => {
      const response = await fetchImpl(url, {
        headers: toLiveFetchHeadersInit(buildLiveFetchHeaders()),
        signal,
      });
      return await readLiveHtmlOrThrow({
        response,
        slug: "linkedin",
        url,
      });
    }, timeoutMs);

  const listingUrl = (start: number): string => {
    const url = new URL(`${baseUrl}${LINKEDIN_LISTING_PATH}`);
    url.searchParams.set("keywords", keywords);
    url.searchParams.set("location", location);
    url.searchParams.set("start", String(start));
    return url.toString();
  };

  return {
    fetchDetail: async (item) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[item.url];
        if (!relativePath) {
          throw new Error(`Missing linkedin detail fixture for ${item.url}`);
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return parseLinkedinDetail(fixture.payload, item.url);
      }
      return parseLinkedinDetail(await fetchLiveText(item.url), item.url);
    },
    fetchListing: async (start) => {
      if (!liveEnabled) {
        if (start !== 0) {
          return { items: [] };
        }
        const fixture = await loadConnectorFixture<string>(listingFixturePath);
        return parseLinkedinListing(fixture.payload);
      }
      return parseLinkedinListing(await fetchLiveText(listingUrl(start)));
    },
  };
};

export { cleanText as cleanLinkedinText };
