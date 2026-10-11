import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { decodeHtmlEntities } from "../html-entities";
import { JOB_INTELLIGENCE_USER_AGENT } from "../user-agent";
import type {
  FreelancerNlDetail,
  FreelancerNlListingItem,
  FreelancerNlListingPage,
} from "./types";
import { FREELANCER_NL_OPDRACHTEN_PATH } from "./types";

export interface FreelancerNlClient {
  fetchDetailHtml: (item: FreelancerNlListingItem) => Promise<string>;
  fetchListing: (page: number) => Promise<FreelancerNlListingPage>;
}

export interface FreelancerNlClientOptions {
  baseUrl?: string;
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://freelancer.nl";
const DETAIL_URL_PATTERN =
  /^\/opdrachten\/(?:[^/]+\/)*[^/]+-(?<reference>[0-9a-f]{8})\/?$/iu;
const TITLE_PATTERN =
  /<h4\b[^>]*class=["'][^"']*\bcard-title\b[^"']*["'][^>]*>(?<title>[\s\S]*?)<\/h4>/iu;
const CARD_MARKER_PATTERN =
  /<div\b[^>]*class=["'][^"']*\bcard\b[^"']*["'][^>]*>/giu;
const DIV_TAG_PATTERN = /<\/?div\b[^>]*>/giu;
const SCRIPT_OR_STYLE_PATTERN = /<(?<tag>script|style)[\s\S]*?<\/\k<tag>>/giu;
const FORM_PATTERN = /<form\b[\s\S]*?<\/form>/giu;

const cleanText = (html: string): string =>
  decodeHtmlEntities(html.replaceAll(/<[^>]+>/gu, " "))
    .replaceAll(/\s+/gu, " ")
    .trim();

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

const extractClassBlock = (
  html: string,
  className: string
): string | undefined => {
  const marker = new RegExp(
    `<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
    "iu"
  );
  const match = marker.exec(html);
  if (!match || match.index === undefined) {
    return;
  }
  return extractBalancedDiv(html, match.index)?.content;
};

const extractTagText = (
  html: string,
  tag: string,
  className: string
): string => {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>(?<text>[\\s\\S]*?)<\\/${tag}>`,
    "iu"
  );
  return cleanText(pattern.exec(html)?.groups?.text ?? "");
};

export const extractFreelancerNlReference = (
  href: string
): string | undefined => {
  try {
    const url = new URL(href, DEFAULT_BASE_URL);
    if (url.hostname !== "freelancer.nl") {
      return;
    }
    return DETAIL_URL_PATTERN.exec(
      url.pathname
    )?.groups?.reference?.toLowerCase();
  } catch {
    // Invalid URLs are not Freelancer.nl detail routes.
  }
};

export const extractFreelancerNlDetailUrl = (
  href: string
): { bronReferentie: string; url: string } | undefined => {
  const bronReferentie = extractFreelancerNlReference(href);
  if (!bronReferentie) {
    return;
  }
  return { bronReferentie, url: new URL(href, DEFAULT_BASE_URL).toString() };
};

const extractListingCards = (html: string): string[] => {
  const cards: string[] = [];
  let searchFrom = 0;
  let match = CARD_MARKER_PATTERN.exec(html);
  while (match) {
    const block = extractBalancedDiv(html, match.index);
    if (block) {
      cards.push(block.content);
      searchFrom = block.end;
    } else {
      searchFrom = match.index + match[0].length;
    }
    CARD_MARKER_PATTERN.lastIndex = searchFrom;
    match = CARD_MARKER_PATTERN.exec(html);
  }
  return cards;
};

const extractDetailUrlFromCard = (
  card: string
): { bronReferentie: string; url: string } | undefined => {
  for (const match of card.matchAll(
    /document\.location\.href\s*=\s*['"](?<href>[^'"]+)['"]/gu
  )) {
    const href = match.groups?.href;
    const detailUrl = href ? extractFreelancerNlDetailUrl(href) : undefined;
    if (detailUrl) {
      return detailUrl;
    }
  }
};

const extractCard = (card: string): FreelancerNlListingItem | undefined => {
  const detailUrl = extractDetailUrlFromCard(card);
  const title = cleanText(TITLE_PATTERN.exec(card)?.groups?.title ?? "");
  if (!(detailUrl && title)) {
    return;
  }
  const info = extractClassBlock(card, "info") ?? "";
  const budget = extractClassBlock(card, "budget");
  return {
    bronReferentie: detailUrl.bronReferentie,
    budget: budget ? cleanText(budget) : undefined,
    geplaatst: extractTagText(info, "div", "posted") || undefined,
    locatie: extractTagText(info, "div", "location") || undefined,
    reacties: extractTagText(info, "div", "offers") || undefined,
    titel: title,
    url: detailUrl.url,
  };
};

export const parseFreelancerNlListing = (
  html: string,
  page: number
): FreelancerNlListingPage => {
  const items = extractListingCards(html)
    .map(extractCard)
    .filter((item): item is FreelancerNlListingItem => item !== undefined);
  const hasNextPage = [
    ...html.matchAll(/href=["'][^"']*[?&]page=(?<page>\d+)/giu),
  ].some((match) => Number(match.groups?.page) > page);
  return { hasNextPage, items };
};

type FreelancerNlLabelField =
  | "categorie"
  | "status"
  | "soortBudget"
  | "locatie"
  | "start"
  | "verwachteDuur";

const LABELS = new Map<string, FreelancerNlLabelField>([
  ["Categorie", "categorie"],
  ["Status", "status"],
  ["Soort Budget", "soortBudget"],
  ["Locatie", "locatie"],
  ["Start", "start"],
  ["Verwachte Duur", "verwachteDuur"],
]);

const parseDetailLabels = (html: string): Partial<FreelancerNlDetail> => {
  const detail: Partial<Record<FreelancerNlLabelField, string>> = {};
  const pattern =
    /<div\b[^>]*class=["'][^"']*\blabel\b[^"']*["'][^>]*>(?<label>[\s\S]*?)<\/div>\s*<div\b[^>]*class=["'][^"']*\bvalue\b[^"']*["'][^>]*>(?<value>[\s\S]*?)<\/div>/giu;
  for (const match of html.matchAll(pattern)) {
    const key = LABELS.get(cleanText(match.groups?.label ?? ""));
    if (key) {
      detail[key] = cleanText(match.groups?.value ?? "");
    }
  }
  return detail;
};

const extractDescriptionHtml = (html: string): string => {
  const descriptionMarker =
    /<div\b[^>]*itemprop=["']description["'][^>]*>/iu.exec(html);
  if (!descriptionMarker || descriptionMarker.index === undefined) {
    return "";
  }
  const description =
    extractBalancedDiv(html, descriptionMarker.index)?.content ?? "";
  return description
    .replaceAll(
      /<div\b[^>]*class=["'][^"']*\bcard-title\b[^"']*["'][^>]*>[\s\S]*?<\/div>/giu,
      ""
    )
    .replaceAll(SCRIPT_OR_STYLE_PATTERN, "")
    .replaceAll(FORM_PATTERN, "")
    .trim();
};

const extractSkills = (html: string): string[] => {
  const skillsBlock = extractClassBlock(html, "tags") ?? "";
  return [
    ...skillsBlock.matchAll(
      /<a\b[^>]*class=["'][^"']*\btag\b[^"']*["'][^>]*>(?<skill>[\s\S]*?)<\/a>/giu
    ),
  ]
    .map((match) => cleanText(match.groups?.skill ?? ""))
    .filter(Boolean);
};

export const parseFreelancerNlDetail = (
  html: string,
  item: Pick<FreelancerNlListingItem, "bronReferentie" | "url">
): FreelancerNlDetail => {
  const labels = parseDetailLabels(html);
  const title = cleanText(
    /<h1\b[^>]*>(?<title>[\s\S]*?)<\/h1>/iu.exec(html)?.groups?.title ?? ""
  );
  const stats = extractClassBlock(html, "stats") ?? "";
  const posted = cleanText(
    /<time\b[^>]*>(?<posted>[\s\S]*?)<\/time>/iu.exec(stats)?.groups?.posted ??
      ""
  );
  const reactions = extractTagText(stats, "div", "offers");
  return {
    bronReferentie: item.bronReferentie,
    ...labels,
    geplaatst: posted || undefined,
    omschrijvingHtml: extractDescriptionHtml(html),
    reacties: reactions || undefined,
    skills: extractSkills(html),
    titel: title,
    url: item.url,
  };
};

export const createFreelancerNlClient = (
  options: FreelancerNlClientOptions = {}
): FreelancerNlClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("freelancer-nl");
  const liveEnabled =
    options.liveEnabled ?? process.env.FREELANCER_NL_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "freelancer-nl/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    cfc3ced1: "freelancer-nl/detail-cfc3ced1.json",
  };
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const headers = { "User-Agent": JOB_INTELLIGENCE_USER_AGENT };

  return {
    fetchDetailHtml: async (item) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[item.bronReferentie];
        if (!relativePath) {
          throw new Error(
            `Missing Freelancer.nl detail fixture for ${item.bronReferentie}`
          );
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return fixture.payload;
      }
      const response = await fetchImpl(item.url, { headers });
      if (!response.ok) {
        throw new Error(
          `Freelancer.nl detail request failed with status ${response.status}`
        );
      }
      return response.text();
    },
    fetchListing: async (page) => {
      if (!liveEnabled) {
        if (page !== 1) {
          return { hasNextPage: false, items: [] };
        }
        const fixture = await loadConnectorFixture<string>(listingFixturePath);
        return parseFreelancerNlListing(fixture.payload, page);
      }
      const url = new URL(`${baseUrl}${FREELANCER_NL_OPDRACHTEN_PATH}`);
      if (page > 1) {
        url.searchParams.set("page", String(page));
      }
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(
          `Freelancer.nl listing request failed with status ${response.status}`
        );
      }
      return parseFreelancerNlListing(await response.text(), page);
    },
  };
};

export { cleanText as cleanFreelancerNlText };
