/**
 * Origin MCP (see docs/architecture.md): the eleven tools (brief · search · timeline · changes · get ·
 * sources · follow · remember · propose · correct · forget) served over stdio, over stateless HTTP for a hub,
 * over stdio on a device connected to a hub, from its own store merged with the hub's answers, or
 * over stdio on a relay, forwarded to its hub.
 */

export { handleMcpHttp, type McpHttpOptions } from './http.js';
export {
  CLIENT_HEADER,
  createHubLink,
  DEVICE_HEADER,
  type HubAnswer,
  type HubLink,
  type HubLinkOptions,
} from './hub-link.js';
export {
  type ChangesResult,
  type EntryResult,
  type EntryStub,
  type EntryView,
  type EventResult,
  type EventStub,
  type EventView,
  type FollowResult,
  type GetResult,
  isEntryResult,
  isProposalResult,
  isRecallResult,
  isSessionResult,
  isThreadResult,
  type PromptStub,
  type ProposalResult,
  type ProposalStub,
  proposalResult,
  type RecallItemView,
  type RecallResult,
  type RecallStub,
  type SearchHitView,
  type SearchResult,
  type SessionEvents,
  type SessionResult,
  type SessionView,
  type SourceOfEntry,
  type SourceView,
  sessionResult,
  type ThreadResult,
  type TimelineResult,
  threadResult,
  type VersionView,
} from './local.js';
export {
  createRelayServer,
  type RelayServer,
  type RelayServerOptions,
  serveRelay,
} from './relay.js';
export {
  createReplicaServer,
  type ReplicaOptions,
  type ReplicaServer,
  serveReplica,
} from './replica.js';
export {
  createOriginServer,
  type OriginServer,
  type OriginServerOptions,
  serveStdio,
} from './server.js';
export {
  CLOSE_TIMEOUT_MS,
  INSTRUCTIONS,
  registerOriginTools,
  TOOL_NAMES,
  type ToolArgs,
  type ToolHandlers,
  type ToolName,
  WATCH_INTERVAL_MS,
} from './tools.js';
