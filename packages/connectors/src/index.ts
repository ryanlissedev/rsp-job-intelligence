export {
  CONNECTOR_FIXTURE_CONTRACT_VERSION,
  CONNECTOR_OBSERVATION_CONTRACT_VERSION,
  emptyRunMetrics,
  mergeRunMetrics,
  type Connector,
  type ConnectorCheckpoint,
  type ConnectorDiscoverResult,
  type ConnectorFetchResult,
  type ConnectorFetchedResult,
  type ConnectorRejectedResult,
  type ConnectorRunMetrics,
  type ConnectorFixture,
  type ConnectorObservation,
  type DiscoverItem,
  type SourceContact,
} from "./contract";
export {
  loadConnectorFixture,
  fixturePath,
  createFixtureEnvelope,
} from "./fixtures/load";
export { boundBronReferentie } from "./bron-referentie";
export {
  describeEgressConfig,
  EGRESS_PROXY_SOURCES_ENV,
  EGRESS_PROXY_URL_ENV,
  EgressConfigError,
  resolveEgressFetch,
  resolveEgressRoute,
  type EgressRoute,
  type EgressSummary,
} from "./egress";
export { InMemoryKnownHashStore, type KnownHashStore } from "./known-hash";
export {
  type CheckpointKey,
  type ConnectorRunProgress,
  type RunProgressStore,
} from "./checkpoint";
export {
  CrawlDelayLimiter,
  type GateSignal,
  type RequestLimiter,
} from "./limiter";
export {
  DEFAULT_HOST_GATE_POLICY,
  gateSignalOf,
  HostCircuitOpenError,
  HostGate,
  isHostBlockedError,
  type HostCircuitState,
  type HostGateOptions,
  type HostGatePolicy,
  type HostGateSnapshot,
} from "./host-gate";
export { FetchRateCap, withFetchRateCap } from "./fetch-rate-cap";
export type { FetchRateCapOptions } from "./fetch-rate-cap";
export {
  classifyRunFailure,
  PARTIAL_RUN_COMPLETIONS,
  RUN_COMPLETIONS,
  RUN_FAILURE_KINDS,
  RUN_OUTCOMES,
  type RejectKind,
  type RunCompletion,
  type RunFailureKind,
  type RunOutcome,
  type RunOutcomeCounts,
} from "./run-outcomes";
export { SourceBlockedError } from "./source-blocked";
export {
  JOB_INTELLIGENCE_USER_AGENT,
  JOB_INTELLIGENCE_USER_AGENT_VERSION,
} from "./user-agent";
export {
  InMemoryObservationRecorder,
  type ObservationRecorder,
  type ObservationRecordInput,
} from "./observation-recorder";
export { FilesystemObjectStore } from "./filesystem-object-store";
export {
  buildRawObjectPath,
  buildContentAddressedRawObjectPath,
  hashContent,
  parseContentAddressedRawObjectPath,
  DurableObjectStore,
  InMemoryObjectStore,
  RawObjectDigestMismatchError,
  RawObjectMetadataMissingError,
  type ContentAddressedRawObjectPathInput,
  type ObjectStore,
  type DurableObjectClient,
  type RawContentType,
  type RawObjectPathInput,
  type SourceRecordPointer,
  type SourceRecordWriteOutcome,
  type SourceRecordWriteResult,
  type StoredObject,
} from "./object-store";
// S3ObjectClient / createRawObjectStore are deliberately NOT re-exported from
// this barrel: it uses Bun.S3Client, which needs Bun's ambient types. Any
// consumer whose TS program lacks bun-types (e.g. apps/web, transitively
// reached through @ji/api's AppRouter type) would fail to type-check the
// instant this barrel's static import graph touched that file. Import
// directly from "@ji/connectors/s3-object-client" in Bun runtimes instead.
export {
  runConnector,
  type ConnectorRunInput,
  type ConnectorRunResult,
  type RunCompleteness,
  type RunIncompleteReason,
} from "./run";
export { orderForResume } from "./resume-order";
export type { ResumeOrderLookup } from "./resume-order";
export {
  awaitWithSignal,
  fullJitter,
  sleep,
  withRetry,
  type RetryJitter,
  type RetryPolicy,
  type Sleep,
} from "./retry";
export {
  ConnectorRunFailure,
  InMemoryRunLifecycleStore,
  RunAlreadyInProgressError,
  RunOwnershipLostError,
  type ConnectorRunKind,
  type RunCompletionInput,
  type RunFailureInput,
  type RunFailureEnvelope,
  type RunLifecycleStore,
  type RunStartInput,
  type RunStartResult,
} from "./run-lifecycle";
export {
  buildTenderNedListingUrl,
  createTenderNedClient,
  createTenderNedConnector,
  buildTenderNedPollFilters,
  requestedListingSize,
  TENDER_NED_MAX_PAGE_SIZE,
  TENDER_NED_PARSER_VERSION,
  type TenderNedConnectorOptions,
} from "./tenderned";
export {
  createInhuurdeskClient,
  createInhuurdeskConnector,
  INHUURDESK_PARSER_VERSION,
  type InhuurdeskConnectorOptions,
} from "./inhuurdesk";
export {
  createCtmClient,
  createCtmConnector,
  CTM_PARSER_VERSION,
  type CtmConnectorOptions,
} from "./ctm";
export { decodeHtmlEntities } from "./html-entities";
