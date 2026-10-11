/* oxlint-disable eslint/complexity, eslint/require-await, eslint/no-nested-ternary, unicorn/no-nested-ternary, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These stateful protocol fixtures intentionally centralize REST and GraphQL response branches to exercise fail-closed release behavior. */
import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertCleanReview,
  assertMainCandidate,
  assertStrictReleaseAncestry,
  assertTrustedCheck,
  blockedReleasePath,
  gitEnvWithoutRepoOverrides,
  gitReleaseDiffSource,
  isReleaseLedgerEntry,
  parseReviewMode,
  runReleaseGate,
  selectLatestExactWorkflowRun,
} from "./release-gate";
import type {
  FetchInput,
  FetchLike,
  ReleaseDiffSource,
  ReleaseGateReviewMode,
} from "./release-gate";

const sha = "a".repeat(40);

interface ReviewModeProbe {
  readonly mode?: string;
}

describe("production release gate rejection paths", () => {
  it("rejects a stale main SHA before release work", () => {
    expect(() => assertMainCandidate(sha, "b".repeat(40))).toThrow(
      "main_moved"
    );
  });

  it("rejects unresolved review threads and active change requests", () => {
    expect(() => assertCleanReview(null, 1)).toThrow(
      "unresolved_review_threads"
    );
    expect(() => assertCleanReview("CHANGES_REQUESTED", 0)).toThrow(
      "changes_requested"
    );
  });

  it("rejects an untrusted or unsuccessful CI check", () => {
    expect(() =>
      assertTrustedCheck(
        {
          app: { id: 1_210_556, slug: "cursor" },
          conclusion: "success",
          head_sha: sha,
          name: "verify",
          status: "completed",
          workflow_name: "CI",
        },
        sha,
        "CI",
        "verify"
      )
    ).toThrow("untrusted_check");
  });

  it("rejects a bad or stale release ancestry comparison", () => {
    expect(() => assertStrictReleaseAncestry("behind", 0, 1)).toThrow(
      "invalid_release_ancestry"
    );
    expect(() => assertStrictReleaseAncestry("ahead", 0, 0)).toThrow(
      "invalid_release_ancestry"
    );
  });

  it("counts only deployments this workflow wrote as ledger entries", () => {
    const candidate = "b".repeat(40);
    expect(
      isReleaseLedgerEntry({
        description: `Automatic production release ${candidate}`,
        payload: { candidate_sha: candidate, workflow: "Deploy production" },
      })
    ).toBe(true);
    expect(
      isReleaseLedgerEntry({
        payload: JSON.stringify({
          candidate_sha: candidate,
          workflow: "Deploy production",
        }),
      })
    ).toBe(true);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: candidate, workflow: "Deploy production" },
        sha: candidate,
      })
    ).toBe(true);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: candidate, workflow: "Deploy production" },
        sha: "c".repeat(40),
      })
    ).toBe(false);
    expect(isReleaseLedgerEntry({ description: null, payload: {} })).toBe(
      false
    );
    expect(isReleaseLedgerEntry({ payload: "not json" })).toBe(false);
    expect(isReleaseLedgerEntry({})).toBe(false);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: "B".repeat(40), workflow: "Deploy" },
      })
    ).toBe(false);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: candidate, workflow: "" },
      })
    ).toBe(false);
  });

  it("counts operator-lane releases whose payload carries source instead of workflow", () => {
    const candidate = "d".repeat(40);
    expect(
      isReleaseLedgerEntry({
        description: "Manual production release (operator lane)",
        payload: {
          candidate_sha: candidate,
          release_sha: candidate,
          roles: ["server", "web", "projector"],
          source: "manual-operator-deploy",
        },
        sha: candidate,
      })
    ).toBe(true);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: candidate },
      })
    ).toBe(false);
    expect(
      isReleaseLedgerEntry({
        payload: { candidate_sha: candidate, source: "" },
      })
    ).toBe(false);
  });

  it("rejects an unknown review mode and defaults to trusted-approver", () => {
    const unset: ReviewModeProbe = {};
    expect(parseReviewMode(unset.mode)).toBe("trusted-approver");
    expect(parseReviewMode("")).toBe("trusted-approver");
    expect(parseReviewMode("solo")).toBe("solo");
    expect(() => parseReviewMode("anything")).toThrow("invalid_review_mode");
  });

  it("routes migrations, index schema, backfills, and worker changes away from the automatic lane", () => {
    expect(blockedReleasePath("packages/db/src/migrations/0001.sql")).toBe(
      true
    );
    expect(blockedReleasePath("packages/search/src/schema/index.ts")).toBe(
      true
    );
    expect(blockedReleasePath("scripts/backfill-neon-v1.ts")).toBe(true);
    expect(blockedReleasePath("packages/application/src/backfill/run.ts")).toBe(
      true
    );
    expect(blockedReleasePath("packages/connectors/src/source.ts")).toBe(true);
    expect(blockedReleasePath("apps/worker/src/tasks/poll.ts")).toBe(true);
  });
});

const releaseCandidateSha = "c".repeat(40);
const releasePreviousSha = "d".repeat(40);
const secondCommitSha = "e".repeat(40);
const firstHeadSha = "f".repeat(40);
const secondHeadSha = "a".repeat(40);

interface ProductionDeploymentRecord {
  readonly id: number;
  readonly sha: string;
  readonly environment: string;
  readonly description?: string | null;
  readonly payload?: unknown;
}

const PR_SMOKES: readonly string[] = [
  "application-image-smoke",
  "mcp-edge-smoke",
  "postgres-restore-drill",
];

interface GateHarnessOptions {
  readonly mainSmokesSkipped?: boolean;
  readonly missingPrSmokes?: boolean;
  readonly prSmokeConclusion?: string;
  readonly prSmokeRerun?: boolean;
  readonly prSmokeWrongWorkflow?: boolean;
  readonly blockedFile?: string;
  readonly truncatedComparison?: boolean;
  readonly changesRequested?: boolean;
  readonly claudeReviewWrongWorkflow?: boolean;
  readonly productionDeployments?: readonly ProductionDeploymentRecord[];
  readonly deploymentStatuses?: Readonly<Record<string, string>>;
  readonly latestCiFailed?: boolean;
  readonly unresolvedPullRequest?: number;
  readonly missingFormalReview?: boolean;
  readonly truncatedReviews?: boolean;
  readonly untrustedReviewer?: boolean;
  readonly trustedReviewerAfterUntrusted?: boolean;
  readonly reviewerRevokedApproval?: boolean;
  readonly unreviewedCommit?: boolean;
}

interface GraphqlReviewPayload {
  readonly nodes: readonly {
    readonly author: { readonly login: string };
    readonly commit: { readonly oid: string };
    readonly state: string;
    readonly submittedAt: string;
  }[];
  pageInfo?: {
    readonly endCursor: string | null;
    readonly hasNextPage: boolean;
  };
}

const gateJson = (body: unknown, init?: ResponseInit): Response =>
  Response.json(body, init);

const makeGateHarness = (options: GateHarnessOptions = {}) => {
  const calls: string[] = [];
  const workflowPath = ".github/workflows/ci.yml";
  const fetchImpl = async (
    input: FetchInput,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/git/ref/heads/main")) {
      return gateJson({ object: { sha: releaseCandidateSha } });
    }
    if (url.includes("/deployments?environment=production")) {
      return gateJson(options.productionDeployments ?? []);
    }
    const statusMatch = /\/deployments\/(?<id>\d+)\/statuses/u.exec(url);
    if (statusMatch?.groups?.id) {
      return gateJson([
        {
          id: 1,
          state:
            options.deploymentStatuses?.[statusMatch.groups.id] ?? "success",
        },
      ]);
    }
    if (
      url.includes(`/compare/${releasePreviousSha}...${releaseCandidateSha}`)
    ) {
      return gateJson({
        ahead_by: 2,
        behind_by: 0,
        commits: [{ sha: releaseCandidateSha }, { sha: secondCommitSha }],
        files: (options.truncatedComparison
          ? Array.from({ length: 300 }, (_, index) => `docs/file-${index}.md`)
          : [options.blockedFile ?? "packages/domain/src/value.ts"]
        ).map((filename) => ({ filename })),
        status: "ahead",
      });
    }
    if (url.includes(`/commits/${releaseCandidateSha}/pulls`)) {
      return gateJson([
        {
          head: { sha: firstHeadSha },
          merge_commit_sha: releaseCandidateSha,
          merged_at: "2026-09-11T10:00:00Z",
          number: 1,
          user: { login: "author-one" },
        },
      ]);
    }
    if (url.includes(`/commits/${secondCommitSha}/pulls`)) {
      if (options.unreviewedCommit) {
        return gateJson([]);
      }
      return gateJson([
        {
          head: { sha: secondHeadSha },
          merge_commit_sha: secondCommitSha,
          merged_at: "2026-09-11T11:00:00Z",
          number: 2,
          user: { login: "author-two" },
        },
      ]);
    }
    if (url.includes("/pulls/1/files")) {
      return gateJson([{ filename: "packages/domain/src/value.ts" }]);
    }
    if (url.includes("/pulls/2/files")) {
      return gateJson([{ filename: "packages/application/src/use-case.ts" }]);
    }
    if (url.includes("/collaborators/reviewer/permission")) {
      return gateJson({
        permission: options.untrustedReviewer ? "pull" : "push",
      });
    }
    if (url.includes("/collaborators/trusted-reviewer/permission")) {
      return gateJson({ permission: "push" });
    }
    if (url.includes("/commits/") && url.includes("/check-runs")) {
      const isFirst = url.includes(firstHeadSha);
      const headSha = isFirst ? firstHeadSha : secondHeadSha;
      const smokes = options.missingPrSmokes
        ? []
        : PR_SMOKES.flatMap((name, index) => [
            ...(options.prSmokeRerun
              ? [
                  {
                    app: { id: 15_368, slug: "github-actions" },
                    conclusion: "failure",
                    details_url: `https://github.com/test/repo/actions/runs/${isFirst ? 97 : 96}/job/${100 + index}`,
                    head_sha: headSha,
                    id: 100 + index,
                    name,
                    status: "completed",
                  },
                ]
              : []),
            {
              app: { id: 15_368, slug: "github-actions" },
              conclusion: options.prSmokeConclusion ?? "success",
              details_url: `https://github.com/test/repo/actions/runs/${isFirst ? 97 : 96}/job/${200 + index}`,
              head_sha: headSha,
              id: 200 + index,
              name,
              status: "completed",
            },
          ]);
      if (options.missingFormalReview) {
        return gateJson([
          ...smokes,
          {
            app: { id: 15_368, slug: "github-actions" },
            conclusion: "success",
            details_url: `https://github.com/test/repo/actions/runs/${
              isFirst ? 99 : 98
            }`,
            head_sha: isFirst ? firstHeadSha : secondHeadSha,
            name: "claude-review",
            status: "completed",
          },
        ]);
      }
      return gateJson(smokes);
    }
    if (url.includes("/actions/workflows/") && url.includes("/runs")) {
      const { latestCiFailed } = options;
      return gateJson(
        latestCiFailed
          ? [
              {
                check_suite_id: 122,
                conclusion: "success",
                event: "push",
                head_branch: "main",
                head_sha: releaseCandidateSha,
                id: 11,
                path: workflowPath,
                status: "completed",
              },
              {
                check_suite_id: 122,
                conclusion: "failure",
                event: "push",
                head_branch: "main",
                head_sha: releaseCandidateSha,
                id: 22,
                path: workflowPath,
                status: "completed",
              },
            ]
          : [
              {
                check_suite_id: 122,
                conclusion: "success",
                event: "push",
                head_branch: "main",
                head_sha: releaseCandidateSha,
                id: 22,
                path: workflowPath,
                status: "completed",
              },
            ]
      );
    }
    if (url.includes("/actions/runs/22/jobs")) {
      return gateJson(
        [
          "changes",
          "verify",
          "build",
          "application-image-smoke",
          "mcp-edge-smoke",
          "postgres-restore-drill",
        ].map((name) => ({
          // Since #433 a main push skips the heavy smokes.
          conclusion:
            options.mainSmokesSkipped && PR_SMOKES.includes(name)
              ? "skipped"
              : "success",
          head_sha: releaseCandidateSha,
          name,
          status: "completed",
        }))
      );
    }
    if (url.includes("/check-suites/122/check-runs")) {
      return gateJson(
        [
          "changes",
          "verify",
          "build",
          "application-image-smoke",
          "mcp-edge-smoke",
          "postgres-restore-drill",
        ].map((name) => ({
          app: { id: 15_368, slug: "github-actions" },
          conclusion: "success",
          head_sha: releaseCandidateSha,
          name,
          status: "completed",
          workflow_name: "CI",
        }))
      );
    }
    const smokeRun = /\/actions\/runs\/(?<id>9[67])$/u.exec(url);
    if (smokeRun?.groups?.id) {
      return gateJson({
        conclusion: "success",
        head_sha: smokeRun.groups.id === "97" ? firstHeadSha : secondHeadSha,
        path: options.prSmokeWrongWorkflow
          ? ".github/workflows/react-doctor.yml"
          : workflowPath,
        status: "completed",
      });
    }
    if (url.includes("/actions/runs/99")) {
      return gateJson({
        conclusion: "success",
        head_sha: firstHeadSha,
        path: options.claudeReviewWrongWorkflow
          ? ".github/workflows/ci.yml"
          : ".github/workflows/claude-code-review.yml",
        status: "completed",
      });
    }
    if (url.includes("/actions/runs/98")) {
      return gateJson({
        conclusion: "success",
        head_sha: secondHeadSha,
        path: ".github/workflows/claude-code-review.yml",
        status: "completed",
      });
    }
    if (url.includes("/issues?state=open&labels=release-blocker")) {
      return gateJson([]);
    }
    throw new Error(`unhandled gate route ${init?.method ?? "GET"} ${url}`);
  };

  const graphqlFetchImpl = async (
    _input: FetchInput,
    init?: RequestInit
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    const pullRequestNumber = body.variables.number as number;
    const threadCursor = body.variables.threadCursor as string | null;
    const unresolved =
      options.unresolvedPullRequest === pullRequestNumber &&
      threadCursor === "page-2";
    const hasNextThreadPage =
      options.unresolvedPullRequest === pullRequestNumber &&
      threadCursor === null;
    const reviewNodes = options.missingFormalReview
      ? []
      : options.trustedReviewerAfterUntrusted
        ? [
            {
              author: { login: "reviewer" },
              commit: {
                oid: pullRequestNumber === 1 ? firstHeadSha : secondHeadSha,
              },
              state: "APPROVED",
              submittedAt: "2026-09-11T12:00:00Z",
            },
            {
              author: { login: "trusted-reviewer" },
              commit: {
                oid: pullRequestNumber === 1 ? firstHeadSha : secondHeadSha,
              },
              state: "APPROVED",
              submittedAt: "2026-09-11T13:00:00Z",
            },
          ]
        : options.reviewerRevokedApproval
          ? [
              {
                author: { login: "reviewer" },
                commit: {
                  oid: pullRequestNumber === 1 ? firstHeadSha : secondHeadSha,
                },
                state: "APPROVED",
                submittedAt: "2026-09-11T12:00:00Z",
              },
              {
                author: { login: "reviewer" },
                commit: {
                  oid: pullRequestNumber === 1 ? firstHeadSha : secondHeadSha,
                },
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-09-11T13:00:00Z",
              },
            ]
          : [
              {
                author: { login: "reviewer" },
                commit: {
                  oid: pullRequestNumber === 1 ? firstHeadSha : secondHeadSha,
                },
                state: "APPROVED",
                submittedAt: "2026-09-11T12:00:00Z",
              },
            ];
    const reviews: GraphqlReviewPayload = {
      nodes: reviewNodes,
    };
    if (!options.truncatedReviews) {
      reviews.pageInfo = { endCursor: null, hasNextPage: false };
    }
    return gateJson({
      data: {
        repository: {
          pullRequest: {
            reviewDecision: options.changesRequested
              ? "CHANGES_REQUESTED"
              : options.missingFormalReview
                ? null
                : "APPROVED",
            reviewThreads: {
              nodes: unresolved ? [{ isResolved: false }] : [],
              pageInfo: {
                endCursor: hasNextThreadPage ? "page-2" : null,
                hasNextPage: hasNextThreadPage,
              },
            },
            reviews,
          },
        },
      },
    });
  };

  return {
    calls,
    fetchImpl: async (input: FetchInput, init?: RequestInit) =>
      String(input) === "https://api.github.com/graphql"
        ? graphqlFetchImpl(input, init)
        : fetchImpl(input, init),
  };
};

const gateConfig = (
  fetchImpl: FetchLike,
  reviewMode: ReleaseGateReviewMode = "trusted-approver"
) => ({
  candidateSha: releaseCandidateSha,
  fetchImpl,
  lastDeployedSha: releasePreviousSha,
  repository: "test/repo",
  reviewMode,
  token: "github-token",
});

const ledgerGateConfig = (
  fetchImpl: FetchLike,
  reviewMode: ReleaseGateReviewMode = "trusted-approver"
) => ({
  candidateSha: releaseCandidateSha,
  fetchImpl,
  repository: "test/repo",
  reviewMode,
  token: "github-token",
});

const autoCreatedDeployment = {
  description: null,
  environment: "production",
  id: 900,
  payload: {},
  sha: releaseCandidateSha,
} as const;

const ledgerPayload = {
  candidate_sha: releasePreviousSha,
  job: "deploy",
  run_attempt: "1",
  workflow: "Deploy production",
  workflow_run_id: "77",
} as const;

const ledgerDeployment = {
  description: `Automatic production release ${releasePreviousSha}`,
  environment: "production",
  id: 800,
  payload: ledgerPayload,
  sha: releasePreviousSha,
} as const;

describe("production release gate integrations", () => {
  it("rejects a stale green CI attempt when the latest exact-SHA attempt failed", async () => {
    const harness = makeGateHarness({ latestCiFailed: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "required_workflow_failed"
    );
  });

  it("walks every comparison PR and every review-thread page", async () => {
    const harness = makeGateHarness({ unresolvedPullRequest: 2 });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "unresolved_review_threads"
    );
    expect(harness.calls.some((url) => url.includes("/pulls/2/files"))).toBe(
      true
    );
  });

  it("rejects a PR without an exact-head formal approval", async () => {
    const harness = makeGateHarness({ missingFormalReview: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "review_evidence_missing"
    );
  });

  it("rejects an exact-head approval from an untrusted repository reviewer", async () => {
    const harness = makeGateHarness({ untrustedReviewer: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "review_evidence_untrusted"
    );
  });

  it("accepts a trusted exact-head approval after an untrusted approval", async () => {
    const harness = makeGateHarness({ trustedReviewerAfterUntrusted: true });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({
      pullRequestNumbers: [1, 2],
    });
  });

  it("ignores an approval revoked by the same reviewer later", async () => {
    const harness = makeGateHarness({ reviewerRevokedApproval: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "review_evidence_missing"
    );
  });

  it("fails closed when review pagination metadata is truncated", async () => {
    const harness = makeGateHarness({ truncatedReviews: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "malformed_response"
    );
  });

  it("blocks search schema changes in the full comparison before deployment evidence", async () => {
    const harness = makeGateHarness({
      blockedFile: "packages/search/src/schema/index.ts",
    });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "migration_or_backfill_required"
    );
  });

  it("rejects a comparison commit without merged pull request evidence", async () => {
    const harness = makeGateHarness({ unreviewedCommit: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "unreviewed_release_commit"
    );
  });

  it("ignores GitHub's own environment record and uses the ledger entry", async () => {
    const harness = makeGateHarness({
      deploymentStatuses: { "800": "success", "900": "in_progress" },
      productionDeployments: [autoCreatedDeployment, ledgerDeployment],
    });

    await expect(
      runReleaseGate(ledgerGateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({
      previousDeployedSha: releasePreviousSha,
      reviewMode: "trusted-approver",
      workflows: [".github/workflows/ci.yml"],
    });
    expect(
      harness.calls.some((url) => url.includes("/deployments/900/statuses"))
    ).toBe(false);
  });

  it("parses a ledger payload delivered as a JSON string", async () => {
    const harness = makeGateHarness({
      productionDeployments: [
        autoCreatedDeployment,
        { ...ledgerDeployment, payload: JSON.stringify(ledgerPayload) },
      ],
    });

    await expect(
      runReleaseGate(ledgerGateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({ previousDeployedSha: releasePreviousSha });
  });

  it("fails closed when only GitHub environment records exist", async () => {
    const harness = makeGateHarness({
      deploymentStatuses: { "900": "in_progress", "901": "failure" },
      productionDeployments: [
        autoCreatedDeployment,
        { ...autoCreatedDeployment, id: 901, payload: "not json" },
      ],
    });

    await expect(
      runReleaseGate(ledgerGateConfig(harness.fetchImpl))
    ).rejects.toThrow("missing_actual_deployed_sha");
  });

  it("accepts a solo release carried by a successful claude-review check", async () => {
    const harness = makeGateHarness({ missingFormalReview: true });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl, "solo"))
    ).resolves.toMatchObject({
      pullRequestNumbers: [1, 2],
      reviewMode: "solo",
      workflows: [".github/workflows/ci.yml"],
    });
  });

  it("blocks a solo release on an unresolved review thread", async () => {
    const harness = makeGateHarness({
      missingFormalReview: true,
      unresolvedPullRequest: 2,
    });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl, "solo"))
    ).rejects.toThrow("unresolved_review_threads");
  });

  it("blocks a solo release on a CHANGES_REQUESTED decision", async () => {
    const harness = makeGateHarness({
      changesRequested: true,
      missingFormalReview: true,
    });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl, "solo"))
    ).rejects.toThrow("changes_requested");
  });

  it("blocks a solo release without a claude-review check", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl, "solo"))
    ).rejects.toThrow("review_evidence_missing");
  });

  it("keeps trusted-approver mode requiring an exact-head approval", async () => {
    const harness = makeGateHarness({ missingFormalReview: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "review_evidence_missing"
    );
    const approved = makeGateHarness();
    await expect(
      runReleaseGate(gateConfig(approved.fetchImpl))
    ).resolves.toMatchObject({ reviewMode: "trusted-approver" });
  });

  it("blocks a solo release whose claude-review came from another workflow", async () => {
    const harness = makeGateHarness({
      claudeReviewWrongWorkflow: true,
      missingFormalReview: true,
    });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl, "solo"))
    ).rejects.toThrow("untrusted_check");
  });

  it("ignores a ledger entry whose payload SHA is not the deployment SHA", async () => {
    const harness = makeGateHarness({
      productionDeployments: [
        autoCreatedDeployment,
        { ...ledgerDeployment, sha: "e".repeat(40) },
      ],
    });

    await expect(
      runReleaseGate(ledgerGateConfig(harness.fetchImpl))
    ).rejects.toThrow("missing_actual_deployed_sha");
  });

  it("selects only the newest exact push attempt", () => {
    expect(
      selectLatestExactWorkflowRun(
        [
          {
            conclusion: "success",
            event: "push",
            head_branch: "main",
            head_sha: releaseCandidateSha,
            id: 1,
            path: ".github/workflows/ci.yml",
            status: "completed",
          },
          {
            conclusion: "failure",
            event: "push",
            head_branch: "main",
            head_sha: releaseCandidateSha,
            id: 2,
            path: ".github/workflows/ci.yml",
            status: "completed",
          },
        ],
        releaseCandidateSha,
        ".github/workflows/ci.yml"
      ).map((run) => run.id)
    ).toEqual([2]);
  });
});

const fakeDiffSource = (
  overrides: Partial<{
    readonly ancestor: boolean;
    readonly commits: readonly string[];
    readonly files: readonly string[];
    readonly fail: boolean;
  }> = {}
): ReleaseDiffSource => {
  const answer = <T>(value: T): Promise<T> =>
    overrides.fail === true
      ? Promise.reject(new Error("fatal: bad object"))
      : Promise.resolve(value);
  return {
    changedFiles: () =>
      answer(overrides.files ?? ["packages/domain/src/value.ts"]),
    commitShas: () =>
      answer(overrides.commits ?? [releaseCandidateSha, secondCommitSha]),
    isAncestor: () => answer(overrides.ancestor ?? true),
  };
};

describe("production release gate PR-head smokes (#433)", () => {
  it("passes when main skipped the heavy smokes and every PR head ran them", async () => {
    const harness = makeGateHarness({ mainSmokesSkipped: true });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({ reasons: [] });
  });

  it("accepts smokes CI skipped on a PR that changed no code", async () => {
    const harness = makeGateHarness({
      mainSmokesSkipped: true,
      prSmokeConclusion: "skipped",
    });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({ reasons: [] });
  });

  it("takes the newest re-run of a PR smoke", async () => {
    const harness = makeGateHarness({ prSmokeRerun: true });

    await expect(
      runReleaseGate(gateConfig(harness.fetchImpl))
    ).resolves.toMatchObject({ reasons: [] });
  });

  it("checks the shared CI run identity once per PR across per-job URLs", async () => {
    const harness = makeGateHarness({ mainSmokesSkipped: true });

    await runReleaseGate(gateConfig(harness.fetchImpl));
    const smokeRunLookups = harness.calls.filter((url) =>
      /\/actions\/runs\/9[67]$/u.test(url)
    );
    expect(smokeRunLookups).toHaveLength(2);
  });

  it("blocks a PR whose smoke failed", async () => {
    const harness = makeGateHarness({ prSmokeConclusion: "failure" });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "required_check_failed"
    );
  });

  it("blocks a PR head without smoke check runs", async () => {
    const harness = makeGateHarness({ missingPrSmokes: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "required_check_missing"
    );
  });

  it("blocks a PR smoke that another workflow produced", async () => {
    const harness = makeGateHarness({ prSmokeWrongWorkflow: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "untrusted_check"
    );
  });
});

describe("production release gate git diff source", () => {
  it("passes a release whose GitHub comparison hit the 300-file limit", async () => {
    const harness = makeGateHarness({ truncatedComparison: true });

    await expect(runReleaseGate(gateConfig(harness.fetchImpl))).rejects.toThrow(
      "comparison_truncated"
    );
    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource(),
      })
    ).resolves.toMatchObject({ pullRequestNumbers: [1, 2] });
  });

  it("still routes manual-lane paths found by git away from the automatic lane", async () => {
    const harness = makeGateHarness({ truncatedComparison: true });

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({
          files: ["docs/readme.md", "packages/connectors/src/unica.ts"],
        }),
      })
    ).rejects.toThrow("migration_or_backfill_required");
  });

  it("fails closed when git cannot compute the diff", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({ fail: true }),
      })
    ).rejects.toThrow("comparison_unavailable");
  });

  it("fails closed when git says the baseline is not an ancestor", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({ ancestor: false }),
      })
    ).rejects.toThrow("invalid_release_ancestry");
  });

  it("fails closed when git and GitHub disagree on the commit count", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({ commits: [releaseCandidateSha] }),
      })
    ).rejects.toThrow("comparison_mismatch");
  });

  it("fails closed when the git diff omits the candidate commit", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({
          commits: [secondCommitSha, firstHeadSha],
        }),
      })
    ).rejects.toThrow("comparison_mismatch");
  });

  it("fails closed above the REST-budget commit cap", async () => {
    const harness = makeGateHarness();
    const commits = Array.from({ length: 101 }, (_, index) =>
      index.toString(16).padStart(40, "0")
    );

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({ commits }),
      })
    ).rejects.toThrow("comparison_truncated");
  });

  it("blocks explicitly before exceeding the GitHub REST request budget", async () => {
    const harness = makeGateHarness({ truncatedComparison: true });

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource(),
        restRequestBudget: 3,
      })
    ).rejects.toThrow("github_request_budget_exceeded");
  });

  it("blocks explicitly before exceeding the GitHub GraphQL request budget", async () => {
    const harness = makeGateHarness({ truncatedComparison: true });

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource(),
        graphqlRequestBudget: 0,
      })
    ).rejects.toThrow("github_request_budget_exceeded");
  });

  it("passes a normal release well inside the default REST budget", async () => {
    const harness = makeGateHarness({ truncatedComparison: true });

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource(),
      })
    ).resolves.toMatchObject({ reasons: [] });
    expect(harness.calls.length).toBeLessThan(900);
  });

  it("fails closed on an empty git commit list", async () => {
    const harness = makeGateHarness();

    await expect(
      runReleaseGate({
        ...gateConfig(harness.fetchImpl),
        diffSource: fakeDiffSource({ commits: [] }),
      })
    ).rejects.toThrow("comparison_truncated");
  });
});

// Fixture repositories live in a fresh temp dir and every git call strips the
// inherited GIT_* variables: a pre-push hook (or a linked worktree) exports
// GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE, and git honours those over `cwd`, so
// without this the fixture commits below land in the surrounding real repo
// and `git init` can flip its core.bare.
const gitAs =
  (author: string) =>
  (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], {
      cwd,
      encoding: "utf-8",
      env: {
        ...gitEnvWithoutRepoOverrides(process.env),
        GIT_AUTHOR_EMAIL: `${author}@test.invalid`,
        GIT_AUTHOR_NAME: author,
        GIT_COMMITTER_EMAIL: `${author}@test.invalid`,
        GIT_COMMITTER_NAME: author,
      },
    }).trim();

const git = gitAs("gate");

const REAL_REPOSITORY_TEST = "lists more than 300 files";

const commitFile = (
  cwd: string,
  relativePath: string,
  body: string
): string => {
  mkdirSync(path.join(cwd, relativePath, ".."), { recursive: true });
  writeFileSync(path.join(cwd, relativePath), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", relativePath);
  return git(cwd, "rev-parse", "HEAD");
};

describe("gitReleaseDiffSource over a real repository", () => {
  it(`${REAL_REPOSITORY_TEST}, every commit, and both sides of a rename`, async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "release-gate-git-"));
    try {
      git(cwd, "init", "-q", "-b", "main");
      commitFile(cwd, "packages/connectors/src/old.ts", "export {};\n");
      const base = git(cwd, "rev-parse", "HEAD");
      for (let index = 0; index < 320; index += 1) {
        writeFileSync(path.join(cwd, `bulk-${index}.md`), `${index}\n`);
      }
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", "bulk");
      mkdirSync(path.join(cwd, "src"), { recursive: true });
      git(cwd, "mv", "packages/connectors/src/old.ts", "src/new.ts");
      git(cwd, "commit", "-q", "-m", "move");
      // A quote and a tab make plain `--name-only` output quote the path.
      const tricky = 'packages/connectors/src/we"ird\tname.ts';
      commitFile(cwd, tricky, "export {};\n");
      const head = git(cwd, "rev-parse", "HEAD");

      const source = gitReleaseDiffSource(cwd);
      const files = await source.changedFiles(base, head);
      expect(files.length).toBe(323);
      expect(files).toContain("packages/connectors/src/old.ts");
      expect(files).toContain("src/new.ts");
      expect(files).toContain(tricky);
      expect(files.filter(blockedReleasePath)).toContain(tricky);
      const commits = await source.commitShas(base, head);
      expect(commits.length).toBe(3);
      expect(await source.isAncestor(base, head)).toBe(true);
      expect(await source.isAncestor(head, base)).toBe(false);
      expect(await source.isAncestor(head, head)).toBe(false);
      await expect(
        source.changedFiles(base, "0".repeat(40))
      ).rejects.toBeDefined();
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

interface RepoSnapshot {
  readonly authors: string;
  readonly bare: string;
  readonly head: string;
  readonly refs: string;
  readonly status: string;
}

const snapshotRepo = (cwd: string): RepoSnapshot => {
  const sentinelGit = gitAs("sentinel");
  return {
    authors: sentinelGit(cwd, "log", "--all", "--format=%ae"),
    bare: sentinelGit(cwd, "config", "--get", "core.bare"),
    head: sentinelGit(cwd, "rev-parse", "HEAD"),
    refs: sentinelGit(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: sentinelGit(cwd, "status", "--porcelain"),
  };
};

describe("release-gate spec git isolation", () => {
  it("strips every GIT_* variable and keeps the rest", () => {
    expect(
      gitEnvWithoutRepoOverrides({
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/x",
        GIT_COMMON_DIR: "/x",
        GIT_DIR: "/x",
        GIT_INDEX_FILE: "/x",
        GIT_OBJECT_DIRECTORY: "/x",
        GIT_WORK_TREE: "/x",
        HOME: "/home/test",
        PATH: "/usr/bin",
        UNSET: undefined,
      })
    ).toEqual({ HOME: "/home/test", PATH: "/usr/bin" });
  });

  it(
    "leaves a hook's GIT_DIR repository untouched while building its fixtures",
    () => {
      const sentinel = mkdtempSync(
        path.join(tmpdir(), "release-gate-sentinel-")
      );
      try {
        const sentinelGit = gitAs("sentinel");
        sentinelGit(sentinel, "init", "-q", "-b", "main");
        writeFileSync(path.join(sentinel, "README.md"), "sentinel\n");
        sentinelGit(sentinel, "add", "-A");
        sentinelGit(sentinel, "commit", "-q", "-m", "sentinel");
        const before = snapshotRepo(sentinel);
        const gitDir = path.join(sentinel, ".git");

        // Re-run the real-repository fixture test the way a pre-push hook
        // (or a linked worktree) would: with git's repository variables
        // aimed at a real repo instead of the fixture's temp dir.
        const run = spawnSync(
          process.execPath,
          [
            "test",
            path.join(import.meta.dir, "release-gate.spec.ts"),
            "--test-name-pattern",
            REAL_REPOSITORY_TEST,
          ],
          {
            cwd: sentinel,
            encoding: "utf-8",
            env: {
              ...process.env,
              GIT_COMMON_DIR: gitDir,
              GIT_DIR: gitDir,
              GIT_INDEX_FILE: path.join(gitDir, "index"),
              GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects"),
              GIT_WORK_TREE: sentinel,
            },
            timeout: 120_000,
          }
        );
        expect(`${run.stdout}${run.stderr}`).toContain("1 pass");
        expect(run.status).toBe(0);

        const after = snapshotRepo(sentinel);
        expect(after).toEqual(before);
        expect(after.bare).toBe("false");
        expect(after.authors).not.toContain("gate@test.invalid");
      } finally {
        rmSync(sentinel, { force: true, recursive: true });
      }
    },
    { timeout: 150_000 }
  );
});
