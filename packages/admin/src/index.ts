/**
 * Origin admin UI (see docs/architecture.md#admin-ui): server-rendered pages and a JSON API for the
 * owner of a self-hosted hub, mounted at /admin by `origin serve --admin` or served on a private
 * listener with `--admin-listen`, and for a device's own store with `origin ui`. It reads and writes
 * only through core operations.
 */
export { checkAdminExposure, isLoopbackListen, parseListen, parsePublicUrl } from './config.js';
export {
  ADMIN_ROUTES,
  type AdminHandler,
  type AdminOptions,
  createAdminHandler,
  createLocalAdmin,
  LOCAL_ROUTES,
  type LocalAdmin,
  type LocalAdminOptions,
  type RouteAuth,
} from './handler.js';
export type { HubLink } from './service.js';
export { LOCAL_ACTOR, SIGN_IN_LINK_MS } from './sessions.js';
