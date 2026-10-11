import { afterEach, describe, expect, it } from "bun:test";

import { JOB_INTELLIGENCE_USER_AGENT } from "../user-agent";
import {
  buildLiveFetchHeaders,
  cloudflareChallengeError,
  isCloudflareChallenge,
  LIVE_FETCH_HEADERS,
  readLiveHtmlOrThrow,
  toLiveFetchHeadersInit,
} from "./live-fetch";

afterEach(() => {
  delete process.env.WERKZOEKEN_COOKIE;
  delete process.env.WERKZOEKEN_LIVE;
});

describe("buildLiveFetchHeaders", () => {
  it("sends the honest product User-Agent, never a browser one", () => {
    const headers = buildLiveFetchHeaders();
    expect(headers).toEqual({ ...LIVE_FETCH_HEADERS });
    expect(headers["User-Agent"]).toBe(JOB_INTELLIGENCE_USER_AGENT);
    expect(headers["User-Agent"]).toMatch(/^NewonesJobIntelligence\/\d/u);
    expect(headers["User-Agent"]).not.toMatch(
      /Mozilla|Chrome|Safari|AppleWebKit|Gecko/u
    );
  });

  it("never carries a Cookie, even when a legacy *_COOKIE env is set", () => {
    process.env.WERKZOEKEN_LIVE = "1";
    process.env.WERKZOEKEN_COOKIE = "cf_clearance=abc; __cf_bm=def";
    const headers = buildLiveFetchHeaders();
    expect(headers.Cookie).toBeUndefined();
    expect(
      toLiveFetchHeadersInit(headers).map(([name]) => name.toLowerCase())
    ).not.toContain("cookie");
  });
});

describe("isCloudflareChallenge", () => {
  it("detects the cf-mitigated challenge header", () => {
    const response = new Response("blocked", {
      headers: { "cf-mitigated": "challenge" },
      status: 403,
    });
    expect(isCloudflareChallenge(response)).toBe(true);
  });

  it("detects a managed-challenge body on 403", () => {
    const response = new Response(
      "<html><title>Just a moment...</title></html>",
      { status: 403 }
    );
    expect(
      isCloudflareChallenge(response, "<html><title>Just a moment...</title>")
    ).toBe(true);
  });

  it("does not treat an ordinary 403 as a challenge", () => {
    const response = new Response("Forbidden", { status: 403 });
    expect(isCloudflareChallenge(response, "Forbidden")).toBe(false);
  });
});

describe("readLiveHtmlOrThrow", () => {
  it("returns the body for a successful response", async () => {
    const response = new Response("<html>ok</html>", { status: 200 });
    await expect(
      readLiveHtmlOrThrow({
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).resolves.toBe("<html>ok</html>");
  });

  it("fails closed on a Cloudflare challenge without a cookie hint", async () => {
    const response = new Response("<title>Just a moment...</title>", {
      headers: { "cf-mitigated": "challenge" },
      status: 403,
    });
    await expect(
      readLiveHtmlOrThrow({
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/Cloudflare managed challenge/u);
    await expect(
      readLiveHtmlOrThrow({
        response: new Response("<title>Just a moment...</title>", {
          headers: { "cf-mitigated": "challenge" },
          status: 403,
        }),
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/carry no clearance cookies/u);
  });

  it("still fails closed on non-challenge HTTP errors", async () => {
    const response = new Response("nope", { status: 500 });
    await expect(
      readLiveHtmlOrThrow({
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/status 500/u);
  });
});

describe("cloudflareChallengeError", () => {
  it("points at the runbook and forbids CAPTCHA solvers", () => {
    const error = cloudflareChallengeError({
      slug: "werkzoeken",
      url: "https://www.werkzoeken.nl/",
    });
    expect(error.message).toContain("docs/sources/werkzoeken.md");
    expect(error.message).toContain("Do not use CAPTCHA solvers");
  });
});
