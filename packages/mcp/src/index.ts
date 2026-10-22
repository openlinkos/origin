/**
 * Origin MCP (see docs/architecture.md): the seven tools (search · timeline · get · sources ·
 * remember · correct · forget) served over stdio, over stateless HTTP for a hub, or over stdio on a
 * device connected to a hub, from its own store merged with the hub's answers.
 */
export { handleMcpHttp, type McpHttpOptions } from './http.js';
export {
  CLIENT_HEADER,
  createReplicaServer,
  DEVICE_HEADER,
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
  INSTRUCTIONS,
  registerOriginTools,
  TOOL_NAMES,
  type ToolArgs,
  type ToolHandlers,
  type ToolName,
} from './tools.js';
