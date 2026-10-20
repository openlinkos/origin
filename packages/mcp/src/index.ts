/**
 * Origin MCP (see docs/architecture.md): the seven tools (search · timeline · get · sources ·
 * remember · correct · forget) served over stdio, over stateless HTTP for a hub, or forwarded to a
 * hub by a device's stdio proxy.
 */
export { handleMcpHttp, type McpHttpOptions } from './http.js';
export {
  CLIENT_HEADER,
  createProxyServer,
  type ProxyOptions,
  type ProxyServer,
  serveStdioProxy,
} from './proxy.js';
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
