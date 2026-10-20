/**
 * Origin MCP server (see docs/architecture.md): exposes the archive and entries to agents over
 * stdio. Tools: search · timeline · get · sources · remember · correct · forget.
 */
export {
  createOriginServer,
  type OriginServer,
  type OriginServerOptions,
  serveStdio,
} from './server.js';
