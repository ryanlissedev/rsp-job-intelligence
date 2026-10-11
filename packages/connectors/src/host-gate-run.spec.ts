import { describe, expect, it } from "bun:test";

import type { BronId, ScrapeRunId } from "@ji/domain";

import type { Connector, ConnectorFetchResult } from "./contract";
import { AuthFault, RateLimitFault } from "./effect-runtime/faults";
import { HostCircuitOpenError, HostGate } from "./host-gate";
import { cloudflareChallengeError } from "./json-ld/live-fetch";
import { CrawlDelayLimiter } from "./limiter";
import type { RequestLimiter } from "./limiter";
import { InMemoryObjectStore } from "./object-store";
import { InMemoryObservationRecorder } from "./observation-recorder";
import { runConnector } from "./run";
import { InMemoryRunLifecycleStore } from "./run-lifecycle";
import type { RunFailureInput } from "./run-lifecycle";

/**
 * Fault injection through the real runner: the connector answers like a host
 * that rate-limits (429 + Retry-After) or blocks (Cloudflare 403), and the
 * spec counts the requests that actually left.
 */

// SAFETY: a UUID-shaped literal is a valid BronId.
const bronId = "00000000-0000-4000-8000-0000000000bb" as BronId;

// Production retry policy (poll-bron-run), with jitter pinned to the cap.
const retryPolicy = {
  initialDelayMs: 250,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 3,
  maxDelayMs: 5000,
  multiplier: 2,
};

class RecordingRunStore extends InMemoryRunLifecycleStore {
  readonly failures: RunFailureInput[] = [];

  override fail(input: RunFailureInput): Promise<void> {
    this.failures.push(input);
    return super.fail(input);
  }
}

const fakeClock = () => {
  let nowMs = 5_000_000;
  const waits: number[] = [];
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    wait: (ms: number) => {
      waits.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    waits,
  };
};

const fetched = (bronReferentie: string): ConnectorFetchResult => ({
  body: new TextEncoder().encode(JSON.stringify({ id: bronReferentie })),
  bronReferentie,
  contentHash: `${bronReferentie.padEnd(64, "0")}`.slice(0, 64),
  contentType: "json",
  status: "fetched",
});

const rateLimited = (retryAfterMs: number | null) =>
  new RateLimitFault({ message: "HTTP 429", retryAfterMs, status: 429 });

const challenge = () => {
  const blocked = cloudflareChallengeError({
    slug: "gate",
    url: "https://gate.test/job",
  });
  return new AuthFault({
    cause: blocked,
    message: blocked.message,
    status: 403,
  });
};

/** Each item answers from its own queue of scripted responses. */
const scriptedHost = (script: Record<string, (() => Error | null)[]>) => {
  const requests: string[] = [];
  const connector: Connector = {
    bronId,
    discover: () =>
      Promise.resolve({
        checkpoint: { page: 1 },
        hasMore: false,
        items: Object.keys(script).map((bronReferentie) => ({
          bronReferentie,
          contentHash: `listing-${bronReferentie}`,
        })),
      }),
    fetch: (item) => {
      requests.push(item.bronReferentie);
      const queue = script[item.bronReferentie] ?? [];
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      const error = answer === undefined ? null : answer();
      return error
        ? Promise.reject(error)
        : Promise.resolve(fetched(item.bronReferentie));
    },
  };
  return { connector, requests };
};

const run = (
  connector: Connector,
  limiter: RequestLimiter,
  clock: ReturnType<typeof fakeClock>,
  store: RecordingRunStore,
  runNumber: number
) =>
  runConnector({
    bronId,
    bronSlug: "gate",
    connector,
    limiter,
    now: () => new Date(clock.now()),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "poll",
    runLifecycleStore: store,
    // SAFETY: a UUID-shaped literal is a valid ScrapeRunId.
    scrapeRunId:
      `00000000-0000-4000-8000-00000000000${runNumber}` as ScrapeRunId,
    wait: clock.wait,
  });

describe("HostGate through runConnector (fault injection)", () => {
  it("waits out a 429's Retry-After before asking the host again", async () => {
    const clock = fakeClock();
    const gate = new HostGate({
      crawlDelayMs: 2000,
      now: clock.now,
      wait: clock.wait,
    });
    const { connector, requests } = scriptedHost({
      a: [() => null],
      b: [() => rateLimited(7000), () => null],
      c: [() => null],
    });
    const result = await run(
      connector,
      gate,
      clock,
      new RecordingRunStore(),
      1
    );

    expect(result.metrics.new).toBe(3);
    expect(requests).toEqual(["a", "b", "b", "c"]);
    // Discover, then 2 s pacing to a and to b; b's 429 asks for 7 s: the
    // 250 ms retry backoff plus 6.75 s more at the gate, then 2 s to c.
    expect(clock.waits).toEqual([2000, 2000, 250, 6750, 2000]);
  });

  it("a limiter that takes no feedback keeps its fixed pacing and ignores Retry-After", async () => {
    const clock = fakeClock();
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 2000,
      now: clock.now,
      wait: clock.wait,
    });
    const { connector } = scriptedHost({
      a: [() => null],
      b: [() => rateLimited(7000), () => null],
    });
    await run(connector, limiter, clock, new RecordingRunStore(), 1);
    // The retry goes out 2 s after the 429, not 7 s.
    expect(clock.waits).toEqual([2000, 2000, 250, 1750]);
  });

  it("never retries a Cloudflare 403 and opens the circuit on the second run", async () => {
    const clock = fakeClock();
    const gate = new HostGate({
      crawlDelayMs: 2000,
      now: clock.now,
      wait: clock.wait,
    });
    const { connector, requests } = scriptedHost({ a: [challenge] });

    const store = new RecordingRunStore();
    await expect(run(connector, gate, clock, store, 1)).rejects.toThrow();
    expect(requests).toEqual(["a"]);
    expect(gate.snapshot(bronId).circuit).toBe("closed");

    clock.advance(15 * 60_000);
    await expect(run(connector, gate, clock, store, 2)).rejects.toThrow();
    expect(requests).toEqual(["a", "a"]);
    expect(gate.snapshot(bronId).circuit).toBe("open");

    // Third run inside the 1 h cool-down: not a single request leaves, and
    // the run is classified blocked.
    clock.advance(15 * 60_000);
    await expect(run(connector, gate, clock, store, 3)).rejects.toThrow();
    expect(requests).toEqual(["a", "a"]);
    expect(store.failures.map((failure) => failure.failureKind)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    // The open circuit refuses the run's first request: discovery.
    expect(store.failures.at(-1)?.failure.code).toBe("DISCOVER_FAILED");
  });

  it("a block is never retried per URL, even behind a limiter without a circuit", async () => {
    const clock = fakeClock();
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 2000,
      now: clock.now,
      wait: clock.wait,
    });
    const { connector, requests } = scriptedHost({ a: [challenge, challenge] });
    const store = new RecordingRunStore();
    for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- runs are sequential like the poller's
      await expect(
        run(connector, limiter, clock, store, runNumber)
      ).rejects.toThrow();
    }
    // One request per run (the runner used to send three: maxAttempts), but
    // without a circuit every run still asks.
    expect(requests).toHaveLength(3);
  });

  it("a probe that fails without an answer (404) lets the next run probe again", async () => {
    const clock = fakeClock();
    const gate = new HostGate({
      crawlDelayMs: 0,
      now: clock.now,
      wait: clock.wait,
    });
    gate.report(bronId, { kind: "blocked" });
    gate.report(bronId, { kind: "blocked" });
    clock.advance(60 * 60_000);
    // The probe is the listing read, and it answers 404.
    let listingReads = 0;
    const notFound: Connector = {
      bronId,
      discover: () => {
        listingReads += 1;
        return Promise.reject(new Error("HTTP 404"));
      },
      fetch: () => Promise.reject(new Error("unreachable")),
    };
    await expect(
      run(notFound, gate, clock, new RecordingRunStore(), 5)
    ).rejects.toThrow();
    // The probe said nothing about the host: still half-open, not wedged.
    expect(listingReads).toBeGreaterThan(0);
    expect(gate.snapshot(bronId).circuit).toBe("half_open");
    const healthy = scriptedHost({ b: [() => null] });
    const result = await run(
      healthy.connector,
      gate,
      clock,
      new RecordingRunStore(),
      6
    );
    expect(result.metrics.new).toBe(1);
    expect(gate.snapshot(bronId).circuit).toBe("closed");
  });

  it("a probe after the cool-down that succeeds closes the circuit again", async () => {
    const clock = fakeClock();
    const gate = new HostGate({
      crawlDelayMs: 0,
      now: clock.now,
      wait: clock.wait,
    });
    gate.report(bronId, { kind: "blocked" });
    gate.report(bronId, { kind: "blocked" });
    await expect(gate.acquire(bronId)).rejects.toBeInstanceOf(
      HostCircuitOpenError
    );
    clock.advance(60 * 60_000);
    const { connector, requests } = scriptedHost({
      a: [() => null],
      b: [() => null],
    });
    const result = await run(
      connector,
      gate,
      clock,
      new RecordingRunStore(),
      4
    );
    expect(result.metrics.new).toBe(2);
    expect(requests).toEqual(["a", "b"]);
    expect(gate.snapshot(bronId).circuit).toBe("closed");
  });
});
