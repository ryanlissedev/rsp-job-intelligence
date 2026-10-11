import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import { HttpStatusError } from "../json-ld/live-fetch";
import { JOB_INTELLIGENCE_USER_AGENT } from "../user-agent";
import type {
  WerkNlSearchItem,
  WerkNlSearchResponse,
  WerkNlVacatureDetail,
} from "./types";

const API_BASE =
  "https://www.werk.nl/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api";
const XSRF_COOKIE = "XSRF-TOKEN";
const XSRF_HEADER = "X-XSRF-TOKEN";
const MAX_REDIRECT_HOPS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface WerkNlClient {
  fetchListing: (
    page: number,
    shiftType: string
  ) => Promise<WerkNlSearchResponse>;
  fetchDetail: (referenceNumber: string) => Promise<WerkNlVacatureDetail>;
}

export interface WerkNlClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  liveEnabled?: boolean;
  listingFixturePath?: string;
  detailFixtures?: Record<string, string>;
  timeoutMs?: number;
}

interface StoredCookie {
  name: string;
  value: string;
  /** Cookie domain (leading dot stripped), or the origin host for host-only. */
  domain: string;
  hostOnly: boolean;
}

const cookieKey = (cookie: StoredCookie): string =>
  `${cookie.domain} ${cookie.name}`;

const storeSetCookies = (
  jar: Map<string, StoredCookie>,
  setCookies: readonly string[],
  originHost: string
): void => {
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    let domain = originHost;
    let hostOnly = true;
    for (const attribute of attributes) {
      const [rawKey, rawValue] = attribute.split("=");
      if (rawKey?.trim().toLowerCase() === "domain" && rawValue) {
        domain = rawValue.trim().replace(/^\./u, "").toLowerCase();
        hostOnly = false;
      }
    }
    jar.set(cookieKey({ domain, hostOnly, name, value }), {
      domain,
      hostOnly,
      name,
      value,
    });
  }
};

const cookiesForHost = (
  jar: ReadonlyMap<string, StoredCookie>,
  host: string
): string => {
  const hostLower = host.toLowerCase();
  const parts: string[] = [];
  for (const cookie of jar.values()) {
    const matches = cookie.hostOnly
      ? cookie.domain === hostLower
      : hostLower === cookie.domain || hostLower.endsWith(`.${cookie.domain}`);
    if (matches) {
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }
  return parts.join("; ");
};

interface WerkNlSession {
  jar: Map<string, StoredCookie>;
  xsrfToken: string;
}

/** ASP.NET can rotate XSRF-TOKEN mid-session via Set-Cookie; always read the
 * current jar value rather than the bootstrap-time snapshot. */
const xsrfTokenOf = (
  jar: ReadonlyMap<string, StoredCookie>
): string | undefined => {
  for (const cookie of jar.values()) {
    if (cookie.name === XSRF_COOKIE) {
      return cookie.value;
    }
  }
  return undefined;
};

const readJson = async <Payload>(
  response: Response,
  url: string
): Promise<Payload> => {
  if (!response.ok) {
    throw new HttpStatusError({
      slug: "werk-nl",
      status: response.status,
      url,
    });
  }
  // SAFETY: werk.nl zoekenvacatures API responses match the typed schemas.
  return (await response.json()) as Payload;
};

const keep = <Value>(value: Value | null | undefined): Value | null =>
  value ?? null;

/** DEC-008: whitelist the detail response on the way in — a fresh object
 * naming each field the pipeline actually reads. Unlisted upstream fields
 * (externalReferenceId, employerInternalVacatureId, contact/employer
 * referenceNumbers, cvOffer.sources/languageSkills/workExperiences/
 * educations, addressForeign, soortTypes) never reach the stored body. */
const projectWerkNlVacature = (
  detail: WerkNlVacatureDetail
): WerkNlVacatureDetail => {
  const { proposition } = detail;
  return {
    applicationMethods:
      detail.applicationMethods?.map((method) => ({
        sollicitatieWijze: keep(method.sollicitatieWijze),
        urlApplicationForm: keep(method.urlApplicationForm),
      })) ?? null,
    contactPerson: detail.contactPerson
      ? {
          department: keep(detail.contactPerson.department),
          email: keep(detail.contactPerson.email),
          name: keep(detail.contactPerson.name),
          phoneNumber: keep(detail.contactPerson.phoneNumber),
        }
      : null,
    createdDate: keep(detail.createdDate),
    cvOffer: detail.cvOffer
      ? {
          driversLicenses: keep(detail.cvOffer.driversLicenses),
          educationLevel: keep(detail.cvOffer.educationLevel),
          otherRequirements: keep(detail.cvOffer.otherRequirements),
        }
      : null,
    description: keep(detail.description),
    employer: detail.employer
      ? {
          addressNetherlands: detail.employer.addressNetherlands
            ? {
                city: keep(detail.employer.addressNetherlands.city),
                houseNumber: keep(
                  detail.employer.addressNetherlands.houseNumber
                ),
                postcode: keep(detail.employer.addressNetherlands.postcode),
                streetName: keep(detail.employer.addressNetherlands.streetName),
              }
            : null,
          organizationName: keep(detail.employer.organizationName),
        }
      : null,
    expirationDate: keep(detail.expirationDate),
    isAcquisitionNotAppreciated: detail.isAcquisitionNotAppreciated ?? false,
    isEuresPriority: detail.isEuresPriority ?? false,
    modifiedDate: keep(detail.modifiedDate),
    proposition: proposition
      ? {
          contract: proposition.contract
            ? {
                endDate: keep(proposition.contract.endDate),
                startDate: keep(proposition.contract.startDate),
                type: keep(proposition.contract.type),
              }
            : null,
          function: proposition.function
            ? {
                code: keep(proposition.function.code),
                customDescription: keep(proposition.function.customDescription),
                description: keep(proposition.function.description),
                name: keep(proposition.function.name),
              }
            : null,
          salary: proposition.salary
            ? {
                amountIndication: keep(proposition.salary.amountIndication),
                type: keep(proposition.salary.type),
              }
            : null,
          termsOfEmploymentDescription: keep(
            proposition.termsOfEmploymentDescription
          ),
          workLocation: proposition.workLocation
            ? {
                city: keep(proposition.workLocation.city),
                countryCode: keep(proposition.workLocation.countryCode),
                employerLocationDistance: keep(
                  proposition.workLocation.employerLocationDistance
                ),
                postcode: keep(proposition.workLocation.postcode),
                type: keep(proposition.workLocation.type),
              }
            : null,
          workhours: proposition.workhours
            ? {
                maximumHours: keep(proposition.workhours.maximumHours),
                minimumHours: keep(proposition.workhours.minimumHours),
                werktijden: keep(proposition.workhours.werktijden),
              }
            : null,
        }
      : null,
    referenceNumber: detail.referenceNumber,
    source: keep(detail.source),
    title: detail.title,
  };
};

const buildSearchBody = (page: number, shiftType: string): string =>
  JSON.stringify({
    currentPage: page,
    facets: [
      {
        description: shiftType === "1" ? "Kantoortijden" : "Anders",
        propertyCode: "JOB_SHIFT_TYPE",
        value: shiftType,
      },
    ],
    includeFirstExpansion: false,
    includeSecondExpansion: false,
    keywords: "",
    keywordsChanged: false,
    location: "",
    sort: { by: 1, direction: 1 },
  });

/** DEC-008: whitelist a search item the same way — drops score, resultDepth,
 * internalReferenceNumber and distance, which the pipeline never reads. */
const projectWerkNlSearchItem = (item: WerkNlSearchItem): WerkNlSearchItem => ({
  contractType: item.contractType,
  key: item.key,
  leerbaan: item.leerbaan,
  maxHours: item.maxHours,
  minHours: item.minHours,
  modified: item.modified,
  organisation: item.organisation,
  profession: item.profession,
  referenceNumber: item.referenceNumber,
  stageplaats: item.stageplaats,
  studyLevel: item.studyLevel,
  vacatureTitle: item.vacatureTitle,
  workLocationCity: item.workLocationCity,
  workLocationForeignCity: item.workLocationForeignCity,
  workLocationForeignCountry: item.workLocationForeignCountry,
  workLocationType: item.workLocationType,
});

export const createWerkNlClient = (
  options: WerkNlClientOptions = {}
): WerkNlClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("werk-nl");
  const liveEnabled = options.liveEnabled ?? process.env.WERK_NL_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "werk-nl/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    "56790376": "werk-nl/detail-56790376.json",
    "66198242": "werk-nl/detail-66198242.json",
  };
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const apiBase = options.baseUrl ?? API_BASE;

  let session: WerkNlSession | null = null;
  /** Fixture replay serves the recorded page once — the first shiftType seen
   * becomes "the" fixture shard; other shards answer an empty, finite result
   * set so a replayed sweep terminates instead of duplicating page 1. */
  let fixtureShard: string | null = null;

  /** One request through the session jar. With `followRedirects` the OAM
   * anonymous-auth chain (werk.nl -> login.werk.nl -> werk.nl) is replayed
   * hop by hop: every Set-Cookie lands in the jar and each hop only receives
   * the cookies scoped to its host. Authenticated API calls pass
   * `followRedirects: false` — a 3xx there means a stale session, not a URL
   * to chase (a POST 302 must not be downgraded to a GET against OAM). */
  const request = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    followRedirects: boolean
  ): Promise<Response> => {
    let current = url;
    let method = init.method ?? "GET";
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const { host } = new URL(current);
      const cookieHeader = session ? cookiesForHost(session.jar, host) : "";
      const headers = new Headers(init.headers);
      headers.set("User-Agent", JOB_INTELLIGENCE_USER_AGENT);
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader);
      }
      // oxlint-disable-next-line no-await-in-loop -- OAM redirect hops are sequential by nature: each request needs the previous hop's cookies and Location.
      const response = await fetchImpl(current, {
        body: method === "GET" ? undefined : init.body,
        headers,
        method,
        redirect: "manual",
        signal,
      });
      if (session) {
        storeSetCookies(session.jar, response.headers.getSetCookie(), host);
      }
      if (
        !(followRedirects && REDIRECT_STATUSES.has(response.status)) ||
        !response.headers.get("location")
      ) {
        return response;
      }
      current = new URL(
        response.headers.get("location") ?? current,
        current
      ).toString();
      method = "GET";
    }
    throw new Error(`werk.nl request exceeded ${MAX_REDIRECT_HOPS} redirects`);
  };

  /** Anonymous OAM session: GET the app configuration endpoint, follow the
   * OAM authentication dance, and capture the XSRF-TOKEN cookie the ASP.NET
   * backend requires on every POST. Verified live 2026-09-18: session
   * cookies + `X-XSRF-TOKEN` header is the minimal set for /api/search. */
  const bootstrap = async (signal: AbortSignal): Promise<void> => {
    session = { jar: new Map(), xsrfToken: "" };
    const response = await request(
      `${apiBase}/configuration`,
      { method: "GET" },
      signal,
      true
    );
    if (!response.ok) {
      throw new Error(
        `werk.nl session bootstrap failed with status ${response.status}`
      );
    }
    session.xsrfToken = xsrfTokenOf(session.jar) ?? "";
    if (!session.xsrfToken) {
      throw new Error("werk.nl session bootstrap returned no XSRF-TOKEN");
    }
  };

  const ensureSession = async (signal: AbortSignal): Promise<WerkNlSession> => {
    if (!session?.xsrfToken) {
      await bootstrap(signal);
    }
    // SAFETY: bootstrap() either sets xsrfToken or throws.
    return session as WerkNlSession;
  };

  const authenticatedRequest = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal
  ): Promise<Response> => {
    const attempt = async (): Promise<Response> => {
      const active = await ensureSession(signal);
      const headers = new Headers(init.headers);
      headers.set(XSRF_HEADER, xsrfTokenOf(active.jar) ?? active.xsrfToken);
      return await request(url, { ...init, headers }, signal, false);
    };
    let response = await attempt();
    // A redirect or auth error means the anonymous session or XSRF token
    // went stale mid-run: re-bootstrap once and retry once. Other non-ok
    // statuses (404, 429, 5xx) are endpoint answers, not session problems —
    // bootstrapping for them would pay a full OAM dance per failed item.
    if (
      REDIRECT_STATUSES.has(response.status) ||
      response.status === 401 ||
      response.status === 403
    ) {
      await bootstrap(signal);
      response = await attempt();
    }
    return response;
  };

  return {
    fetchDetail: async (referenceNumber) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[referenceNumber];
        if (!relativePath) {
          throw new Error(
            `Missing werk.nl detail fixture for ${referenceNumber}`
          );
        }
        const fixture =
          await loadConnectorFixture<WerkNlVacatureDetail>(relativePath);
        return projectWerkNlVacature(fixture.payload);
      }
      return await withHttpTimeout(async (signal) => {
        const response = await authenticatedRequest(
          `${apiBase}/vacature/${referenceNumber}`,
          { method: "GET" },
          signal
        );
        return projectWerkNlVacature(
          await readJson<WerkNlVacatureDetail>(
            response,
            `${apiBase}/vacature/${referenceNumber}`
          )
        );
      }, timeoutMs);
    },
    fetchListing: async (page, shiftType) => {
      if (!liveEnabled) {
        const fixture =
          await loadConnectorFixture<WerkNlSearchResponse>(listingFixturePath);
        fixtureShard ??= shiftType;
        const items =
          page === 1 && shiftType === fixtureShard
            ? (fixture.payload.items ?? [])
            : [];
        return {
          ...fixture.payload,
          items: items.map(projectWerkNlSearchItem),
          totalResults: items.length,
        };
      }
      return await withHttpTimeout(async (signal) => {
        const response = await authenticatedRequest(
          `${apiBase}/search`,
          {
            body: buildSearchBody(page, shiftType),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            method: "POST",
          },
          signal
        );
        const parsed = await readJson<WerkNlSearchResponse>(
          response,
          `${apiBase}/search`
        );
        return {
          ...parsed,
          items: parsed.items?.map(projectWerkNlSearchItem) ?? null,
        };
      }, timeoutMs);
    },
  };
};
