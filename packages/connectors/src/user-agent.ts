/**
 * The one User-Agent every live scraper/poller sends. It names the product
 * honestly instead of imitating a browser, so a source operator can see who
 * is fetching and allow-list or block us deliberately. There is no public
 * product/contact URL in this repository yet; add `(+<url>)` here once one
 * exists. Bump the version when crawl behaviour changes materially.
 */
export const JOB_INTELLIGENCE_USER_AGENT_VERSION = "1.0";

export const JOB_INTELLIGENCE_USER_AGENT =
  `NewonesJobIntelligence/${JOB_INTELLIGENCE_USER_AGENT_VERSION}` as const;
