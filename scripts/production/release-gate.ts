/* oxlint-disable eslint/max-classes-per-file, eslint/no-await-in-loop, eslint/complexity, unicorn/no-array-sort, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This read-only gate parses several external GitHub REST and GraphQL response shapes at its I/O boundary. Its awaits are deliberately serial for pagination, review evidence, and main-ref rechecks. */
import { execFile } from "node:child_process";
import { exit } from "node:process";
import { promisify } from "node:util";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_PAGES = 100;
const MAX_COMPARISON_FILES = 300;
// Each commit costs a PR lookup and each PR about six more REST calls (files,
// review check + its workflow run, CI smoke checks + their one workflow run,
// reviewer permission). 100 commits stays inside GITHUB_REST_REQUEST_BUDGET
// even when every commit is its own PR; the budget bounds what the cap cannot
// (paginated file lists of very large PRs).
const MAX_RELEASE_COMMITS = 100;
// Every REST request (each pagination page included) is counted against this,
// so a release that would exhaust the token blocks with an explicit
// `github_request_budget_exceeded` instead of a rate-limit response mid-gate.
// Kept under 1,000 to leave room for the deploy job's own calls.
const GITHUB_REST_REQUEST_BUDGET = 900;
// The review-thread and review GraphQL pages draw on a separate 1,000
// points-per-hour GITHUB_TOKEN limit; each query costs at least one point.
const GITHUB_GRAPHQL_REQUEST_BUDGET = 900;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_ACTIONS_APP_ID = 15_368;
const GITHUB_ACTIONS_APP_SLUG = "github-actions";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type FetchInput = Request | string | URL;

export type FetchLike = (
  input: FetchInput,
  init?: RequestInit
) => Promise<Response>;

export type ReleaseGateReviewMode = "trusted-approver" | "solo";

/**
 * Reads the release diff from a full local checkout instead of GitHub's
 * compare API, whose file list stops at 300 entries and whose commit list
 * stops at 250. Every method must reject (never guess) when git cannot answer.
 */
export interface ReleaseDiffSource {
  readonly isAncestor: (
    ancestor: string,
    descendant: string
  ) => Promise<boolean>;
  readonly commitShas: (from: string, to: string) => Promise<readonly string[]>;
  readonly changedFiles: (
    from: string,
    to: string
  ) => Promise<readonly string[]>;
}

export interface GateConfig {
  readonly candidateSha: string;
  readonly diffSource?: ReleaseDiffSource;
  readonly repository: string;
  readonly token: string;
  readonly lastDeployedSha?: string;
  readonly fetchImpl?: FetchLike;
  readonly apiBaseUrl?: string;
  readonly reviewMode?: ReleaseGateReviewMode;
  /** REST requests the gate may make; defaults to GITHUB_REST_REQUEST_BUDGET. */
  readonly restRequestBudget?: number;
  /** GraphQL queries the gate may make; defaults to GITHUB_GRAPHQL_REQUEST_BUDGET. */
  readonly graphqlRequestBudget?: number;
}

export interface GateResult {
  readonly candidateSha: string;
  readonly previousDeployedSha: string;
  readonly pullRequestNumbers: readonly number[];
  readonly changedFiles: readonly string[];
  readonly reasons: readonly string[];
  readonly reviewMode: ReleaseGateReviewMode;
  readonly workflows: readonly string[];
}

export interface ReleaseGateEvidence {
  readonly candidateSha?: unknown;
  readonly previousDeployedSha?: unknown;
  readonly pullRequests?: unknown;
  readonly result?: unknown;
  readonly reviewMode?: unknown;
  readonly workflows?: unknown;
}

export class GateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GateError";
    this.code = code;
  }
}

interface PullRequest {
  readonly number: number;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly head?: { readonly sha?: string };
  readonly user?: { readonly login?: string };
  readonly labels?: readonly { readonly name?: string }[];
  readonly files?: readonly { readonly filename?: string }[];
}

interface CheckRun {
  readonly id?: number;
  readonly name?: string;
  readonly workflow_name?: string | null;
  readonly head_sha?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly app?: { readonly id?: number; readonly slug?: string } | null;
  readonly details_url?: string | null;
  readonly output?: {
    readonly title?: string | null;
    readonly summary?: string | null;
    readonly text?: string | null;
  } | null;
}

export interface WorkflowRun {
  readonly check_suite_id?: number;
  readonly id?: number;
  readonly workflow_id?: number;
  readonly name?: string;
  readonly path?: string;
  readonly head_sha?: string;
  readonly event?: string;
  readonly head_branch?: string | null;
  readonly status?: string;
  readonly conclusion?: string | null;
}

export const selectLatestExactWorkflowRun = (
  runs: readonly WorkflowRun[],
  candidateSha: string,
  workflowPath: string
): readonly WorkflowRun[] =>
  runs
    .filter(
      (run) =>
        run.path === workflowPath &&
        run.head_sha === candidateSha &&
        run.event === "push" &&
        run.head_branch === "main"
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))
    .slice(0, 1);

interface Comparison {
  readonly status?: string;
  readonly ahead_by?: number;
  readonly behind_by?: number;
  readonly files?: readonly { readonly filename?: string }[];
  readonly commits?: readonly { readonly sha?: string }[];
}

interface Deployment {
  readonly id?: number;
  readonly sha?: string;
  readonly environment?: string;
  readonly payload?: unknown;
  readonly description?: unknown;
}

const asPayloadObject = (
  payload: unknown
): Record<string, unknown> | undefined => {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

export const isReleaseLedgerEntry = (deployment: {
  readonly payload?: unknown;
  readonly description?: unknown;
  readonly sha?: unknown;
}): boolean => {
  const payload = asPayloadObject(deployment.payload);
  if (!payload) {
    return false;
  }
  const candidateSha = payload.candidate_sha;
  const provenance = payload.workflow ?? payload.source;
  if (
    typeof candidateSha !== "string" ||
    !SHA_PATTERN.test(candidateSha) ||
    typeof provenance !== "string" ||
    provenance.length === 0
  ) {
    return false;
  }
  return typeof deployment.sha !== "string" || deployment.sha === candidateSha;
};

interface DeploymentStatus {
  readonly created_at?: string;
  readonly id?: number;
  readonly state?: string;
  readonly environment_url?: string | null;
}

const asObject = (
  value: JsonValue,
  context: string
): Record<string, JsonValue> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GateError("malformed_response", `${context} was not an object`);
  }
  return value;
};

const asArray = <T>(value: JsonValue, context: string): readonly T[] => {
  if (!Array.isArray(value)) {
    throw new GateError("malformed_response", `${context} was not an array`);
  }
  return value as unknown as readonly T[];
};

const readJson = async (
  response: Response,
  context: string
): Promise<JsonValue> => {
  if (!response.ok) {
    throw new GateError(
      "github_api_error",
      `${context} returned HTTP ${response.status}`
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GateError(
      "malformed_response",
      `${context} returned invalid JSON`
    );
  }
  return body as JsonValue;
};

const parseNextLink = (response: Response): string | undefined => {
  const link = response.headers.get("link");
  if (!link) {
    return undefined;
  }
  const match = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /;\s*rel="next"/u.test(part));
  if (!match) {
    return undefined;
  }
  const url = /^<(?<url>[^>]+)>/u.exec(match)?.groups?.url;
  if (!url) {
    throw new GateError(
      "malformed_pagination",
      "GitHub returned an invalid next link"
    );
  }
  return url;
};

const apiUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/u, "")}${path}`;

class GitHubApi {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly requestBudget: number;
  private requests = 0;
  private readonly graphqlRequestBudget: number;
  private graphqlRequests = 0;
  /** The fetch for GraphQL queries, counted against their own budget. */
  readonly graphqlFetch: FetchLike;

  constructor(config: GateConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestBudget = config.restRequestBudget ?? GITHUB_REST_REQUEST_BUDGET;
    this.graphqlRequestBudget =
      config.graphqlRequestBudget ?? GITHUB_GRAPHQL_REQUEST_BUDGET;
    this.graphqlFetch = async (input, init) => {
      if (this.graphqlRequests >= this.graphqlRequestBudget) {
        throw new GateError(
          "github_request_budget_exceeded",
          `review queries would exceed the gate's ${this.graphqlRequestBudget} GitHub GraphQL request budget; release in smaller batches`
        );
      }
      this.graphqlRequests += 1;
      return await this.fetchImpl(input, init);
    };
    this.baseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(
      /\/$/u,
      ""
    );
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private spendRequest(context: string): void {
    if (this.requests >= this.requestBudget) {
      throw new GateError(
        "github_request_budget_exceeded",
        `${context} would exceed the gate's ${this.requestBudget} GitHub REST request budget; release in smaller batches`
      );
    }
    this.requests += 1;
  }

  async get(
    path: string,
    context = path
  ): Promise<{ readonly body: JsonValue; readonly response: Response }> {
    this.spendRequest(context);
    const response = await this.fetchImpl(apiUrl(this.baseUrl, path), {
      headers: this.headers,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    return { body: await readJson(response, context), response };
  }

  async all<T>(path: string, context = path): Promise<readonly T[]> {
    const values: T[] = [];
    let next: string | undefined = apiUrl(this.baseUrl, path);
    for (let page = 0; next; page += 1) {
      if (page >= MAX_PAGES) {
        throw new GateError(
          "malformed_pagination",
          `${context} exceeded the pagination limit`
        );
      }
      this.spendRequest(context);
      const response = await this.fetchImpl(next, {
        headers: this.headers,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      const body = await readJson(response, context);
      const pageValues = Array.isArray(body)
        ? (body as unknown as readonly T[])
        : (() => {
            const object = asObject(body, context);
            const arrays = Object.values(object).filter(
              (value): value is JsonValue[] => Array.isArray(value)
            );
            if (arrays.length !== 1) {
              throw new GateError(
                "malformed_response",
                `${context} did not expose one paginated array`
              );
            }
            return arrays[0] as unknown as readonly T[];
          })();
      values.push(...pageValues);
      const linkedNext = parseNextLink(response);
      if (linkedNext) {
        next = linkedNext;
      } else if (pageValues.length >= 100) {
        const pageUrl: string = next;
        const pageUrlObject = new URL(pageUrl);
        pageUrlObject.searchParams.set("page", String(page + 2));
        next = pageUrlObject.toString();
      } else {
        next = undefined;
      }
    }
    return values;
  }
}

const requireSha = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new GateError(
      "invalid_sha",
      `${name} must be a full lowercase 40-character SHA`
    );
  }
  return value;
};

export const assertMainCandidate = (
  candidateSha: string,
  observedSha: string
): void => {
  if (candidateSha !== observedSha) {
    throw new GateError(
      "main_moved",
      "main does not point at the candidate SHA"
    );
  }
};

export const assertStrictReleaseAncestry = (
  status: string | undefined,
  aheadBy: number | undefined,
  behindBy: number | undefined
): void => {
  if (status !== "ahead" || behindBy !== 0 || (aheadBy ?? 0) < 1) {
    throw new GateError(
      "invalid_release_ancestry",
      "candidate is not a strict descendant of the actual deployed SHA"
    );
  }
};

export const assertCleanReview = (
  decision: string | null,
  unresolvedThreads: number
): void => {
  if (decision === "CHANGES_REQUESTED") {
    throw new GateError("changes_requested", "PR has an active change request");
  }
  if (!Number.isSafeInteger(unresolvedThreads) || unresolvedThreads < 0) {
    throw new GateError(
      "malformed_response",
      "review thread count was malformed"
    );
  }
  if (unresolvedThreads > 0) {
    throw new GateError(
      "unresolved_review_threads",
      `PR has ${unresolvedThreads} unresolved review thread(s)`
    );
  }
};

const checkAppIdentity = (check: CheckRun, context: string): void => {
  if (
    check.app?.id !== GITHUB_ACTIONS_APP_ID ||
    check.app.slug !== GITHUB_ACTIONS_APP_SLUG
  ) {
    throw new GateError(
      "untrusted_check",
      `${context} was not produced by GitHub Actions`
    );
  }
};

const checkSucceeded = (check: CheckRun, context: string): void => {
  checkAppIdentity(check, context);
  if (check.status !== "completed" || check.conclusion !== "success") {
    throw new GateError(
      "required_check_failed",
      `${context} is not a successful completed check`
    );
  }
};

// Per-job details URLs (`/actions/runs/42/job/201`) share their run ID.
const workflowRunIdOf = (check: CheckRun): string | undefined =>
  check.details_url?.match(/\/actions\/runs\/(?<runId>\d+)(?:\/|$)/u)?.groups
    ?.runId;

const assertCheckWorkflowIdentity = async (
  github: GitHubApi,
  repository: string,
  check: CheckRun,
  expectedPath: string,
  expectedSha: string,
  context: string
): Promise<void> => {
  const runIdText = workflowRunIdOf(check);
  if (!runIdText) {
    throw new GateError(
      "untrusted_check",
      `${context} did not expose a workflow run identity`
    );
  }
  const { body } = await github.get(
    `/repos/${repository}/actions/runs/${runIdText}`,
    `${context} workflow run`
  );
  const run = asObject(body, `${context} workflow run`);
  if (
    run.path !== expectedPath ||
    run.head_sha !== expectedSha ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new GateError(
      "untrusted_check",
      `${context} was not produced by the expected workflow run`
    );
  }
};

export const assertTrustedCheck = (
  check: CheckRun,
  expectedSha: string,
  expectedWorkflow: string,
  expectedName: string
): void => {
  if (
    check.name !== expectedName ||
    check.workflow_name !== expectedWorkflow ||
    check.head_sha !== expectedSha
  ) {
    throw new GateError(
      "untrusted_check",
      `${expectedWorkflow}/${expectedName} has the wrong identity or SHA`
    );
  }
  checkSucceeded(check, `${expectedWorkflow}/${expectedName}`);
};

const getWorkflowRuns = async (
  github: GitHubApi,
  repository: string,
  candidateSha: string,
  workflowPath: string
): Promise<readonly WorkflowRun[]> => {
  const path = `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowPath)}/runs?branch=main&event=push&head_sha=${candidateSha}&per_page=100`;
  const runs = await github.all<WorkflowRun>(
    path,
    `${workflowPath} workflow runs`
  );
  const exact = runs.filter(
    (run) =>
      run.path === workflowPath &&
      run.head_sha === candidateSha &&
      run.event === "push" &&
      run.head_branch === "main"
  );
  exact.sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
  return exact.slice(0, 1);
};

const getWorkflowCheckRuns = (
  github: GitHubApi,
  repository: string,
  workflowPath: string,
  run: WorkflowRun
): Promise<readonly CheckRun[]> => {
  if (typeof run.check_suite_id !== "number") {
    throw new GateError(
      "malformed_response",
      `${workflowPath} run did not expose a check suite id`
    );
  }
  return github.all<CheckRun>(
    `/repos/${repository}/check-suites/${run.check_suite_id}/check-runs?per_page=100`,
    `${workflowPath} check runs`
  );
};

const requireWorkflowJobs = async (
  github: GitHubApi,
  repository: string,
  workflowPath: string,
  candidateSha: string,
  requiredJobs: readonly string[]
): Promise<void> => {
  const runs = await getWorkflowRuns(
    github,
    repository,
    candidateSha,
    workflowPath
  );
  if (runs.length === 0) {
    throw new GateError(
      "required_workflow_missing",
      `${workflowPath} has no trusted successful run for the candidate SHA`
    );
  }
  const found = new Set<string>();
  for (const run of runs) {
    if (typeof run.id !== "number") {
      throw new GateError(
        "malformed_response",
        `${workflowPath} returned a run without an id`
      );
    }
    const jobs = await github.all<CheckRun>(
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      `${workflowPath} jobs`
    );
    const checkRuns = await getWorkflowCheckRuns(
      github,
      repository,
      workflowPath,
      run
    );
    if (run.status !== "completed" || run.conclusion !== "success") {
      throw new GateError(
        "required_workflow_failed",
        `${workflowPath} latest exact-SHA run was not successful`
      );
    }
    for (const job of jobs) {
      if (!requiredJobs.includes(job.name ?? "")) {
        continue;
      }
      if (
        job.head_sha !== candidateSha ||
        job.status !== "completed" ||
        job.conclusion !== "success"
      ) {
        throw new GateError(
          "required_check_failed",
          `${workflowPath}/${job.name} is not successful for the candidate SHA`
        );
      }
      const check = checkRuns.find(
        (runCheck) =>
          runCheck.name === job.name && runCheck.head_sha === candidateSha
      );
      if (!check) {
        throw new GateError(
          "required_check_missing",
          `${workflowPath}/${job.name} has no matching check run`
        );
      }
      checkSucceeded(check, `${workflowPath}/${job.name}`);
      found.add(job.name ?? "");
    }
  }
  const missing = requiredJobs.filter((job) => !found.has(job));
  if (missing.length > 0) {
    throw new GateError(
      "required_check_missing",
      `missing successful CI jobs: ${missing.join(", ")}`
    );
  }
};

const requireReactDoctor = async (
  github: GitHubApi,
  repository: string,
  candidateSha: string
): Promise<void> => {
  const runs = await getWorkflowRuns(
    github,
    repository,
    candidateSha,
    ".github/workflows/react-doctor.yml"
  );
  if (runs.length === 0) {
    throw new GateError(
      "required_workflow_missing",
      "React Doctor has no trusted successful run for the candidate SHA"
    );
  }
  let found = false;
  for (const run of runs) {
    if (typeof run.id !== "number") {
      throw new GateError("malformed_response", "React Doctor run has no id");
    }
    const jobs = await github.all<CheckRun>(
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      "React Doctor jobs"
    );
    const checkRuns = await getWorkflowCheckRuns(
      github,
      repository,
      "React Doctor",
      run
    );
    if (run.status !== "completed" || run.conclusion !== "success") {
      throw new GateError(
        "required_workflow_failed",
        "React Doctor latest exact-SHA run was not successful"
      );
    }
    for (const job of jobs) {
      if (job.name !== "react-doctor") {
        continue;
      }
      if (
        job.head_sha !== candidateSha ||
        job.status !== "completed" ||
        job.conclusion !== "success"
      ) {
        throw new GateError(
          "required_check_failed",
          "React Doctor job is not successful for the candidate SHA"
        );
      }
      const check = checkRuns.find(
        (runCheck) =>
          runCheck.name === job.name && runCheck.head_sha === candidateSha
      );
      if (!check) {
        throw new GateError(
          "required_check_missing",
          "React Doctor has no matching check run"
        );
      }
      checkSucceeded(check, "React Doctor");
      found = true;
    }
  }
  if (!found) {
    throw new GateError(
      "required_check_missing",
      "React Doctor job is missing"
    );
  }
};

const requireBrowserEvidence = async (
  github: GitHubApi,
  repository: string,
  pullRequest: PullRequest
): Promise<void> => {
  const headSha = requireSha(
    pullRequest.head?.sha,
    `PR #${pullRequest.number} head SHA`
  );
  const checks = await github.all<CheckRun>(
    `/repos/${repository}/commits/${headSha}/check-runs?per_page=100`,
    `PR #${pullRequest.number} check runs`
  );
  const matches = checks.filter(
    (check) => check.name === "Browser evidence" && check.head_sha === headSha
  );
  const [evidence, ...extraEvidence] = matches;
  if (evidence === undefined || extraEvidence.length > 0) {
    throw new GateError(
      "browser_evidence_missing",
      `PR #${pullRequest.number} lacks exactly one Browser evidence check on its head`
    );
  }
  checkSucceeded(evidence, `PR #${pullRequest.number} Browser evidence`);
  await assertCheckWorkflowIdentity(
    github,
    repository,
    evidence,
    ".github/workflows/search-audit-evidence.yml",
    headSha,
    `PR #${pullRequest.number} Browser evidence`
  );
};

/**
 * Since #433 the heavy CI smokes run on pull requests only; a main push skips
 * them by design. Their evidence therefore comes from each released PR's
 * head: the latest run of each must be a completed `success`, or `skipped`
 * (CI skips them when the PR changed no code), from `ci.yml` at that head.
 */
const PULL_REQUEST_SMOKE_JOBS = [
  "application-image-smoke",
  "mcp-edge-smoke",
  "postgres-restore-drill",
] as const;

const requirePullRequestSmokes = async (
  github: GitHubApi,
  repository: string,
  pullRequestNumber: number,
  headSha: string
): Promise<void> => {
  const checks = await github.all<CheckRun>(
    `/repos/${repository}/commits/${headSha}/check-runs?per_page=100`,
    `PR #${pullRequestNumber} check runs`
  );
  // The three smokes are jobs of one CI run; verify each run ID once.
  const verifiedRuns = new Set<string>();
  for (const name of PULL_REQUEST_SMOKE_JOBS) {
    const context = `PR #${pullRequestNumber} ${name}`;
    // A re-run adds a newer check run with the same name; the newest decides.
    const [latest] = checks
      .filter((check) => check.name === name && check.head_sha === headSha)
      .toSorted((left, right) => (right.id ?? 0) - (left.id ?? 0));
    if (latest === undefined) {
      throw new GateError(
        "required_check_missing",
        `${context} has no check run on the PR head`
      );
    }
    checkAppIdentity(latest, context);
    if (
      latest.status !== "completed" ||
      (latest.conclusion !== "success" && latest.conclusion !== "skipped")
    ) {
      throw new GateError(
        "required_check_failed",
        `${context} is not a successful or skipped completed check`
      );
    }
    const runKey = workflowRunIdOf(latest);
    if (runKey !== undefined && verifiedRuns.has(runKey)) {
      continue;
    }
    await assertCheckWorkflowIdentity(
      github,
      repository,
      latest,
      ".github/workflows/ci.yml",
      headSha,
      context
    );
    if (runKey !== undefined) {
      verifiedRuns.add(runKey);
    }
  }
};

const requireClaudeReviewCheck = async (
  github: GitHubApi,
  repository: string,
  pullRequestNumber: number,
  headSha: string
): Promise<void> => {
  const checks = await github.all<CheckRun>(
    `/repos/${repository}/commits/${headSha}/check-runs?per_page=100`,
    `PR #${pullRequestNumber} check runs`
  );
  const matches = checks.filter(
    (check) => check.name === "claude-review" && check.head_sha === headSha
  );
  const [claudeReview, ...extraClaudeReviews] = matches;
  if (claudeReview === undefined || extraClaudeReviews.length > 0) {
    throw new GateError(
      "review_evidence_missing",
      `PR #${pullRequestNumber} lacks exactly one claude-review check on its head`
    );
  }
  checkSucceeded(claudeReview, `PR #${pullRequestNumber} claude-review`);
  await assertCheckWorkflowIdentity(
    github,
    repository,
    claudeReview,
    ".github/workflows/claude-code-review.yml",
    headSha,
    `PR #${pullRequestNumber} claude-review`
  );
};

export const requiresBrowserEvidence = (files: readonly string[]): boolean =>
  files.some(
    (file) =>
      file.startsWith("apps/web/") ||
      file.startsWith("packages/ui/") ||
      file.startsWith("e2e/")
  );

const normalizeFiles = (
  files: readonly { readonly filename?: string }[],
  context: string
): readonly string[] => {
  const result = files.map((file) => file.filename);
  if (result.some((file) => typeof file !== "string" || file.length === 0)) {
    throw new GateError(
      "malformed_response",
      `${context} contains a file without a filename`
    );
  }
  return result as string[];
};

interface ReleaseDiff {
  readonly commitShas: readonly string[];
  readonly files: readonly string[];
}

const releaseDiffFromComparison = (comparison: Comparison): ReleaseDiff => {
  const files = normalizeFiles(
    comparison.files ?? [],
    "release comparison files"
  );
  if (
    !comparison.commits ||
    comparison.commits.length === 0 ||
    comparison.commits.length >= 250
  ) {
    throw new GateError(
      "comparison_truncated",
      "release comparison did not expose a complete commit list"
    );
  }
  const commitShas = comparison.commits.map((commit) =>
    requireSha(commit.sha, "release comparison commit SHA")
  );
  if (files.length >= MAX_COMPARISON_FILES) {
    throw new GateError(
      "comparison_truncated",
      "release comparison reached GitHub's file limit"
    );
  }
  assertStrictReleaseAncestry(
    comparison.status,
    comparison.ahead_by,
    comparison.behind_by
  );
  return { commitShas, files };
};

const releaseDiffFromGit = async (
  source: ReleaseDiffSource,
  previousSha: string,
  candidateSha: string,
  comparison: Comparison
): Promise<ReleaseDiff> => {
  // GitHub's ancestry verdict and the local checkout must agree; either
  // side alone is not trusted to widen the release.
  assertStrictReleaseAncestry(
    comparison.status,
    comparison.ahead_by,
    comparison.behind_by
  );
  let ancestor: boolean;
  let commitShas: readonly string[];
  let files: readonly string[];
  try {
    ancestor = await source.isAncestor(previousSha, candidateSha);
    commitShas = await source.commitShas(previousSha, candidateSha);
    files = await source.changedFiles(previousSha, candidateSha);
  } catch {
    throw new GateError(
      "comparison_unavailable",
      "the local git checkout could not compute the release diff"
    );
  }
  if (!ancestor) {
    throw new GateError(
      "invalid_release_ancestry",
      "candidate is not a strict descendant of the actual deployed SHA"
    );
  }
  if (commitShas.length === 0 || commitShas.length > MAX_RELEASE_COMMITS) {
    throw new GateError(
      "comparison_truncated",
      `release diff must contain between 1 and ${MAX_RELEASE_COMMITS} commits`
    );
  }
  for (const commitSha of commitShas) {
    requireSha(commitSha, "release diff commit SHA");
  }
  if (comparison.ahead_by !== commitShas.length) {
    throw new GateError(
      "comparison_mismatch",
      "GitHub and the local checkout disagree on the release commit count"
    );
  }
  if (!commitShas.includes(candidateSha)) {
    throw new GateError(
      "comparison_mismatch",
      "the local release diff does not contain the candidate commit"
    );
  }
  if (files.some((file) => file.length === 0)) {
    throw new GateError(
      "malformed_response",
      "release diff contains an empty path"
    );
  }
  return { commitShas, files };
};

const execFileAsync = promisify(execFile);

/** A child-process environment with no `GIT_*` repository overrides. */
export type GitChildEnv = NodeJS.ProcessEnv;

/**
 * Copies `env` without any `GIT_*` variable. A pre-push hook exports
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (and a linked worktree can add
 * GIT_COMMON_DIR); a child git process that inherits them ignores its `cwd`
 * and reads or writes the surrounding repository instead. Every git call
 * here passes an explicit `cwd` and `-C`, so repository discovery must come
 * from that directory alone.
 */
export const gitEnvWithoutRepoOverrides = (
  env: Readonly<NodeJS.ProcessEnv>
): GitChildEnv => {
  const isolated: GitChildEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      isolated[key] = value;
    }
  }
  return isolated;
};

const runGit = async (
  cwd: string,
  args: readonly string[]
): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    encoding: "utf-8",
    env: gitEnvWithoutRepoOverrides(process.env),
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
};

/** rev-list prints one bare SHA per line; SHAs are never quoted. */
const splitShaLines = (output: string): readonly string[] =>
  output.split("\n").filter((entry) => entry.length > 0);

/** Splits `-z` output: raw paths, never quoted or escaped by git. */
const splitNul = (output: string): readonly string[] =>
  output.split("\0").filter((entry) => entry.length > 0);

/**
 * A diff source over a full clone (`actions/checkout` with `fetch-depth: 0`).
 * Renames are disabled so a moved file reports both its old and new path to
 * the manual-lane path filter.
 */
export const gitReleaseDiffSource = (cwd: string): ReleaseDiffSource => {
  const requireCommit = async (sha: string): Promise<string> => {
    const valid = requireSha(sha, "git release diff SHA");
    await runGit(cwd, ["cat-file", "-e", `${valid}^{commit}`]);
    return valid;
  };
  return {
    changedFiles: async (from, to) =>
      splitNul(
        await runGit(cwd, [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          await requireCommit(from),
          await requireCommit(to),
        ])
      ),
    commitShas: async (from, to) =>
      splitShaLines(
        await runGit(cwd, [
          "rev-list",
          `${await requireCommit(from)}..${await requireCommit(to)}`,
        ])
      ),
    isAncestor: async (ancestor, descendant) => {
      const older = await requireCommit(ancestor);
      const newer = await requireCommit(descendant);
      if (older === newer) {
        return false;
      }
      try {
        await runGit(cwd, ["merge-base", "--is-ancestor", older, newer]);
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) {
          return false;
        }
        throw error;
      }
    },
  };
};

export const blockedReleasePath = (file: string): boolean =>
  file.startsWith("packages/db/src/migrations/") ||
  file.startsWith("packages/db/src/schema/") ||
  file.startsWith("packages/search/src/schema/") ||
  file.startsWith("packages/search/src/schema.") ||
  file.startsWith("scripts/backfill/") ||
  file === "scripts/backfill-neon-v1.ts" ||
  file.startsWith("packages/application/src/backfill/") ||
  file.startsWith("packages/connectors/") ||
  file.startsWith("apps/worker/") ||
  file.startsWith("tools/backfill/") ||
  file.startsWith("tools/migration/") ||
  file.startsWith("scripts/migration/") ||
  file === "tools/manticore/start-search-generation.ts" ||
  file.startsWith("tools/search/") ||
  file === "apps/server/src/http/release.ts" ||
  file === "apps/server/src/index.ts" ||
  file === "apps/server/src/readiness.ts" ||
  file.startsWith("packages/env/src/");

const requireNoReleaseBlockers = async (
  github: GitHubApi,
  repository: string
): Promise<void> => {
  const issues = await github.all<{
    readonly number?: number;
    readonly pull_request?: unknown;
  }>(
    `/repos/${repository}/issues?state=open&labels=release-blocker&per_page=100`,
    "release-blocker issues"
  );
  if (issues.length > 0) {
    const numbers = issues
      .map((issue) => issue.number)
      .filter((number): number is number => typeof number === "number");
    throw new GateError(
      "release_blocker_issue",
      `open release-blocker issue(s): ${numbers.join(", ") || "unknown"}`
    );
  }
};

const reviewThreadsFor = async (
  githubToken: string,
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha: string,
  expectedAuthorLogin: string | undefined,
  fetchImpl: FetchLike
): Promise<{
  readonly decision: string | null;
  readonly unresolved: number;
  readonly approvedReviewerLogins: readonly string[];
}> => {
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new GateError(
      "invalid_repository",
      "GITHUB_REPOSITORY must be owner/name"
    );
  }
  const query = `query($owner:String!,$name:String!,$number:Int!,$threadCursor:String,$reviewCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviews(first:100,after:$reviewCursor){nodes{state commit{oid} author{login} submittedAt} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$threadCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`;
  const fetchPage = async (
    threadCursor: string | null,
    reviewCursor: string | null
  ): Promise<{
    readonly decision: string | null;
    readonly reviewNodes: readonly Record<string, JsonValue>[];
    readonly reviewPageInfo: Record<string, JsonValue>;
    readonly threadNodes: readonly Record<string, JsonValue>[];
    readonly threadPageInfo: Record<string, JsonValue>;
  }> => {
    const response = await fetchImpl("https://api.github.com/graphql", {
      body: JSON.stringify({
        query,
        variables: {
          name,
          number: pullRequestNumber,
          owner,
          reviewCursor,
          threadCursor,
        },
      }),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "POST",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new GateError(
        "github_api_error",
        `GraphQL review query returned HTTP ${response.status}`
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GateError(
        "malformed_response",
        "GraphQL review query returned invalid JSON"
      );
    }
    const root = asObject(body as JsonValue, "GraphQL review response");
    const { errors } = root;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new GateError(
        "github_api_error",
        "GraphQL review query returned errors"
      );
    }
    const data = asObject(root.data as JsonValue, "GraphQL review data");
    const repo = asObject(data.repository as JsonValue, "GraphQL repository");
    const pr = asObject(repo.pullRequest as JsonValue, "GraphQL pull request");
    const reviewThreads = asObject(
      pr.reviewThreads as JsonValue,
      "GraphQL review threads"
    );
    const threadPageInfo = asObject(
      reviewThreads.pageInfo as JsonValue,
      "GraphQL review thread page info"
    );
    const threadNodes = asArray<Record<string, JsonValue>>(
      reviewThreads.nodes as JsonValue,
      "GraphQL review threads"
    );
    if (typeof pr.reviewDecision !== "string" && pr.reviewDecision !== null) {
      throw new GateError(
        "malformed_response",
        "GraphQL reviewDecision was malformed"
      );
    }
    const decision = pr.reviewDecision as string | null;
    const reviews = asObject(pr.reviews as JsonValue, "GraphQL reviews");
    const reviewPageInfo = asObject(
      reviews.pageInfo as JsonValue,
      "GraphQL review page info"
    );
    const reviewNodes = asArray<Record<string, JsonValue>>(
      reviews.nodes as JsonValue,
      "GraphQL review nodes"
    );
    return {
      decision,
      reviewNodes,
      reviewPageInfo,
      threadNodes,
      threadPageInfo,
    };
  };
  let decision: string | null = null;
  const latestReviews = new Map<
    string,
    {
      readonly commitSha: string | undefined;
      readonly sequence: number;
      readonly state: string;
      readonly submittedAt: string | null;
    }
  >();
  let reviewSequence = 0;
  let reviewCursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(null, reviewCursor);
    ({ decision } = result);
    for (const review of result.reviewNodes) {
      const { author, commit } = review;
      const reviewerLogin =
        author !== null &&
        typeof author === "object" &&
        !Array.isArray(author) &&
        typeof (author as Record<string, JsonValue>).login === "string"
          ? (author as Record<string, JsonValue>).login
          : undefined;
      if (typeof reviewerLogin === "string") {
        const { submittedAt } = review;
        if (submittedAt !== null && typeof submittedAt !== "string") {
          throw new GateError(
            "malformed_response",
            "GraphQL review submittedAt was malformed"
          );
        }
        if (
          typeof submittedAt === "string" &&
          Number.isNaN(Date.parse(submittedAt))
        ) {
          throw new GateError(
            "malformed_response",
            "GraphQL review submittedAt was invalid"
          );
        }
        if (typeof review.state !== "string") {
          throw new GateError(
            "malformed_response",
            "GraphQL review state was malformed"
          );
        }
        const commitObject =
          commit !== null &&
          typeof commit === "object" &&
          !Array.isArray(commit)
            ? (commit as Record<string, JsonValue>)
            : undefined;
        const commitOid = commitObject?.oid;
        const commitSha = typeof commitOid === "string" ? commitOid : undefined;
        const previous = latestReviews.get(reviewerLogin);
        const currentTimestamp =
          typeof submittedAt === "string"
            ? Date.parse(submittedAt)
            : Number.NEGATIVE_INFINITY;
        const previousTimestamp =
          previous?.submittedAt === null || previous?.submittedAt === undefined
            ? Number.NEGATIVE_INFINITY
            : Date.parse(previous.submittedAt);
        if (
          !previous ||
          currentTimestamp > previousTimestamp ||
          (currentTimestamp === previousTimestamp &&
            reviewSequence > previous.sequence)
        ) {
          latestReviews.set(reviewerLogin, {
            commitSha,
            sequence: reviewSequence,
            state: review.state,
            submittedAt,
          });
        }
      }
      reviewSequence += 1;
    }
    const { hasNextPage, endCursor } = result.reviewPageInfo;
    if (hasNextPage === false) {
      reviewCursor = null;
      break;
    }
    if (
      hasNextPage !== true ||
      typeof endCursor !== "string" ||
      endCursor.length === 0
    ) {
      throw new GateError(
        "malformed_pagination",
        "GraphQL reviews reported malformed pagination"
      );
    }
    reviewCursor = endCursor;
  }
  if (reviewCursor !== null) {
    throw new GateError(
      "malformed_pagination",
      "GraphQL reviews exceeded the pagination limit"
    );
  }
  let unresolved = 0;
  let threadCursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(threadCursor, null);
    ({ decision } = result);
    unresolved += result.threadNodes.filter(
      (node) => node.isResolved !== true
    ).length;
    const { hasNextPage, endCursor } = result.threadPageInfo;
    if (hasNextPage === false) {
      const approvedReviewerLogins = [...latestReviews.entries()]
        .filter(
          ([login, review]) =>
            review.state === "APPROVED" &&
            review.commitSha === expectedHeadSha &&
            login !== expectedAuthorLogin
        )
        .map(([login]) => login);
      return { approvedReviewerLogins, decision, unresolved };
    }
    if (
      hasNextPage !== true ||
      typeof endCursor !== "string" ||
      endCursor.length === 0
    ) {
      throw new GateError(
        "malformed_pagination",
        "GraphQL review threads reported malformed pagination"
      );
    }
    threadCursor = endCursor;
  }
  throw new GateError(
    "malformed_pagination",
    "GraphQL review threads exceeded the pagination limit"
  );
};

const previousDeployedSha = async (
  github: GitHubApi,
  repository: string,
  explicit: string | undefined
): Promise<string> => {
  if (explicit !== undefined && explicit !== "") {
    return requireSha(explicit, "PRODUCTION_LAST_DEPLOYED_SHA");
  }
  const deployments = await github.all<Deployment>(
    `/repos/${repository}/deployments?environment=production&per_page=100`,
    "production deployments"
  );
  const candidates = deployments
    .filter(
      (deployment) =>
        deployment.environment === "production" &&
        typeof deployment.id === "number" &&
        isReleaseLedgerEntry(deployment)
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
  const [latest] = candidates;
  if (!latest?.id) {
    throw new GateError(
      "missing_actual_deployed_sha",
      "no production deployment record was found"
    );
  }
  const statuses = await github.all<DeploymentStatus>(
    `/repos/${repository}/deployments/${latest.id}/statuses?per_page=100`,
    "production deployment statuses"
  );
  const sortedStatuses = [...statuses].sort((left, right) => {
    if (typeof left.id === "number" && typeof right.id === "number") {
      return right.id - left.id;
    }
    return (right.created_at ?? "").localeCompare(left.created_at ?? "");
  });
  const [latestStatus] = sortedStatuses;
  if (latestStatus?.state !== "success") {
    throw new GateError(
      "latest_production_deployment_not_successful",
      "the latest production deployment does not have a successful terminal status"
    );
  }
  if (latest.sha) {
    return requireSha(latest.sha, "production deployment SHA");
  }
  throw new GateError(
    "missing_actual_deployed_sha",
    "no successful production deployment or protected deployed SHA was found"
  );
};

const requireTrustedReviewer = async (
  github: GitHubApi,
  repository: string,
  pullRequestNumber: number,
  reviewerLogin: string
): Promise<void> => {
  const body = await github.get(
    `/repos/${repository}/collaborators/${encodeURIComponent(reviewerLogin)}/permission`,
    `PR #${pullRequestNumber} reviewer permission`
  );
  const value = asObject(
    body.body,
    `PR #${pullRequestNumber} reviewer permission`
  );
  const { permission } = value;
  if (
    typeof permission !== "string" ||
    !new Set(["admin", "maintain", "push", "write"]).has(permission)
  ) {
    throw new GateError(
      "review_evidence_untrusted",
      `PR #${pullRequestNumber} exact-head approval is not from a trusted repository reviewer`
    );
  }
};

export const runReleaseGate = async (
  config: GateConfig
): Promise<GateResult> => {
  const candidateSha = requireSha(config.candidateSha, "candidate SHA");
  if (!config.token) {
    throw new GateError("missing_github_token", "GITHUB_TOKEN is required");
  }
  if (!/^\S+\/\S+$/u.test(config.repository)) {
    throw new GateError(
      "invalid_repository",
      "GITHUB_REPOSITORY must be owner/name"
    );
  }
  const reviewMode: ReleaseGateReviewMode =
    config.reviewMode ?? "trusted-approver";
  const verifiedWorkflows = new Set<string>();
  const github = new GitHubApi(config);

  const readMain = async (): Promise<string> => {
    const { body } = await github.get(
      `/repos/${config.repository}/git/ref/heads/main`,
      "main ref"
    );
    const object = asObject(
      (body as Record<string, JsonValue>).object as JsonValue,
      "main ref object"
    );
    return requireSha(object.sha, "main ref SHA");
  };
  assertMainCandidate(candidateSha, await readMain());

  const previousSha = await previousDeployedSha(
    github,
    config.repository,
    config.lastDeployedSha
  );
  const comparisonResponse = await github.get(
    `/repos/${config.repository}/compare/${previousSha}...${candidateSha}`,
    "release comparison"
  );
  const comparison = asObject(
    comparisonResponse.body,
    "release comparison"
  ) as unknown as Comparison;
  const { commitShas: comparisonCommitShas, files: comparisonFiles } =
    config.diffSource
      ? await releaseDiffFromGit(
          config.diffSource,
          previousSha,
          candidateSha,
          comparison
        )
      : releaseDiffFromComparison(comparison);
  const blockedFiles = comparisonFiles.filter(blockedReleasePath);
  if (blockedFiles.length > 0) {
    throw new GateError(
      "migration_or_backfill_required",
      `release contains manual-lane paths: ${blockedFiles.join(", ")}`
    );
  }

  const pullRequests = new Map<number, PullRequest>();
  for (const commitSha of comparisonCommitShas) {
    const associated = await github.all<PullRequest>(
      `/repos/${config.repository}/commits/${commitSha}/pulls?per_page=100`,
      `pull requests for ${commitSha}`
    );
    const mergedForCommit = associated.filter(
      (pullRequest) =>
        pullRequest.merged_at !== null && typeof pullRequest.number === "number"
    );
    if (mergedForCommit.length === 0) {
      throw new GateError(
        "unreviewed_release_commit",
        `${commitSha} has no merged pull request evidence`
      );
    }
    for (const pullRequest of associated) {
      if (
        pullRequest.merged_at !== null &&
        typeof pullRequest.number === "number"
      ) {
        pullRequests.set(pullRequest.number, pullRequest);
      }
    }
  }
  const merged = [...pullRequests.values()];
  if (
    !merged.some((pullRequest) => pullRequest.merge_commit_sha === candidateSha)
  ) {
    throw new GateError(
      "merged_pr_missing",
      "candidate has no merged pull request evidence"
    );
  }

  const associatedFiles = new Set<string>(comparisonFiles);
  let browserEvidenceRequired = requiresBrowserEvidence(comparisonFiles);
  let browserEvidenceChecked = false;
  for (const pullRequest of merged) {
    const files = await github.all<{ readonly filename?: string }>(
      `/repos/${config.repository}/pulls/${pullRequest.number}/files?per_page=100`,
      `PR #${pullRequest.number} files`
    );
    const pullRequestFiles = normalizeFiles(
      files,
      `PR #${pullRequest.number} files`
    );
    for (const file of pullRequestFiles) {
      associatedFiles.add(file);
    }
    const headSha = requireSha(
      pullRequest.head?.sha,
      `PR #${pullRequest.number} head SHA`
    );
    const review = await reviewThreadsFor(
      config.token,
      config.repository,
      pullRequest.number,
      headSha,
      pullRequest.user?.login,
      github.graphqlFetch
    );
    assertCleanReview(review.decision, review.unresolved);
    await requirePullRequestSmokes(
      github,
      config.repository,
      pullRequest.number,
      headSha
    );
    if (reviewMode === "solo") {
      await requireClaudeReviewCheck(
        github,
        config.repository,
        pullRequest.number,
        headSha
      );
    } else {
      if (review.approvedReviewerLogins.length === 0) {
        throw new GateError(
          "review_evidence_missing",
          `PR #${pullRequest.number} lacks an exact-head approval from a non-author reviewer`
        );
      }
      let trustedReviewer = false;
      for (const reviewerLogin of review.approvedReviewerLogins) {
        try {
          await requireTrustedReviewer(
            github,
            config.repository,
            pullRequest.number,
            reviewerLogin
          );
          trustedReviewer = true;
          break;
        } catch (error) {
          if (
            !(error instanceof GateError) ||
            error.code !== "review_evidence_untrusted"
          ) {
            throw error;
          }
        }
      }
      if (!trustedReviewer) {
        throw new GateError(
          "review_evidence_untrusted",
          `PR #${pullRequest.number} exact-head approval is not from a trusted repository reviewer`
        );
      }
    }
    if (requiresBrowserEvidence(pullRequestFiles)) {
      browserEvidenceRequired = true;
      browserEvidenceChecked = true;
      await requireBrowserEvidence(github, config.repository, pullRequest);
      verifiedWorkflows.add(".github/workflows/search-audit-evidence.yml");
    }
  }

  await requireWorkflowJobs(
    github,
    config.repository,
    ".github/workflows/ci.yml",
    candidateSha,
    // The heavy smokes are skipped on main pushes (#433); see
    // requirePullRequestSmokes for where their evidence comes from.
    ["changes", "verify", "build"]
  );
  verifiedWorkflows.add(".github/workflows/ci.yml");
  if (browserEvidenceRequired && !browserEvidenceChecked) {
    const [firstMerged] = merged;
    if (firstMerged === undefined) {
      throw new GateError(
        "merged_pr_missing",
        "candidate has no merged pull request evidence"
      );
    }
    await requireBrowserEvidence(github, config.repository, firstMerged);
    verifiedWorkflows.add(".github/workflows/search-audit-evidence.yml");
  }
  if (requiresBrowserEvidence(comparisonFiles)) {
    await requireReactDoctor(github, config.repository, candidateSha);
    verifiedWorkflows.add(".github/workflows/react-doctor.yml");
  }
  await requireNoReleaseBlockers(github, config.repository);
  assertMainCandidate(candidateSha, await readMain());
  return {
    candidateSha,
    changedFiles: [...associatedFiles].sort(),
    previousDeployedSha: previousSha,
    pullRequestNumbers: merged.map((pullRequest) => pullRequest.number),
    reasons: [],
    reviewMode,
    workflows: [...verifiedWorkflows].sort(),
  };
};

const isReviewMode = (value: unknown): boolean =>
  value === "trusted-approver" || value === "solo";

export const revalidateReleaseEvidence = (
  gateConfig: {
    readonly candidateSha: string;
    readonly repository: string;
    readonly token: string;
    readonly lastDeployedRelease?: { readonly releaseSha?: string };
  },
  expected: ReleaseGateEvidence
): Promise<ReleaseGateEvidence> => {
  const reject = (detail: string): never => {
    throw new GateError("release_evidence_invalid", detail);
  };
  if (expected.result !== "pass") {
    reject("release-gate evidence did not record a passing result");
  }
  if (
    typeof expected.candidateSha !== "string" ||
    expected.candidateSha !== gateConfig.candidateSha
  ) {
    reject("release-gate evidence was written for a different candidate");
  }
  if (!isReviewMode(expected.reviewMode)) {
    reject("release-gate evidence did not record a known review mode");
  }
  const { workflows, pullRequests } = expected;
  if (
    !Array.isArray(workflows) ||
    workflows.length === 0 ||
    workflows.some(
      (workflow) => typeof workflow !== "string" || workflow.length === 0
    )
  ) {
    reject("release-gate evidence did not list the verified workflows");
  }
  if (
    !Array.isArray(pullRequests) ||
    pullRequests.length === 0 ||
    pullRequests.some((number) => !Number.isSafeInteger(number))
  ) {
    reject("release-gate evidence did not list the reviewed pull requests");
  }
  const baselineSha = gateConfig.lastDeployedRelease?.releaseSha;
  if (
    baselineSha !== undefined &&
    expected.previousDeployedSha !== baselineSha
  ) {
    reject("release-gate evidence did not match the complete-release baseline");
  }
  return Promise.resolve(expected);
};

export const parseReviewMode = (
  value: string | undefined
): ReleaseGateReviewMode => {
  if (value === undefined || value === "" || value === "trusted-approver") {
    return "trusted-approver";
  }
  if (value === "solo") {
    return "solo";
  }
  throw new GateError(
    "invalid_review_mode",
    "RELEASE_GATE_REVIEW_MODE must be trusted-approver or solo"
  );
};

const main = async (): Promise<void> => {
  try {
    const result = await runReleaseGate({
      candidateSha: process.env.CANDIDATE_SHA ?? process.env.GITHUB_SHA ?? "",
      diffSource: gitReleaseDiffSource(
        process.env.RELEASE_GATE_GIT_DIR ?? process.cwd()
      ),
      lastDeployedSha: process.env.PRODUCTION_LAST_DEPLOYED_SHA,
      repository: process.env.GITHUB_REPOSITORY ?? "",
      reviewMode: parseReviewMode(process.env.RELEASE_GATE_REVIEW_MODE),
      token: process.env.GITHUB_TOKEN ?? "",
    });
    console.log(
      JSON.stringify({
        candidateSha: result.candidateSha,
        changedFileCount: result.changedFiles.length,
        previousDeployedSha: result.previousDeployedSha,
        pullRequests: result.pullRequestNumbers,
        result: "pass",
        reviewMode: result.reviewMode,
        workflows: result.workflows,
      })
    );
  } catch (error) {
    const message =
      error instanceof GateError
        ? error.message
        : "release_gate_failed: unexpected error";
    console.error(JSON.stringify({ reason: message, result: "block" }));
    exit(1);
  }
};

if (import.meta.main) {
  await main();
}
