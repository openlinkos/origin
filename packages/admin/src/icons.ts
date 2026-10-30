import type { Ctx } from './context.js';
import { html, raw, type SafeHtml } from './html.js';

/**
 * The Lucide icons the admin UI uses, all from the design system's set (`@openlinkos/ui`, see
 * `icons.json`); a test checks that each exists there.
 */
export const ICON_NAMES = [
  'activity',
  'ban',
  'book-marked',
  'book-open',
  'bookmark',
  'bot',
  'calendar',
  'check',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevrons-up-down',
  'circle-alert',
  'circle-check',
  'circle-x',
  'clock',
  'copy',
  'database',
  'eraser',
  'file-text',
  'filter',
  'folder',
  'gauge',
  'hard-drive',
  'history',
  'info',
  'key-round',
  'languages',
  'laptop',
  'layout-dashboard',
  'lightbulb',
  'link',
  'list',
  'list-filter',
  'loader-circle',
  'log-in',
  'log-out',
  'menu',
  'message-square',
  'monitor-check',
  'moon',
  'pencil',
  'plug',
  'plus',
  'refresh-cw',
  'scroll-text',
  'search',
  'server',
  'settings',
  'shield-check',
  'sun',
  'sun-moon',
  'terminal',
  'timer',
  'triangle-alert',
  'user',
  'wrench',
  'x',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Symbol ids carry a prefix, so they cannot collide with the ids of a page. */
const PREFIX = 'i-';

/**
 * An icon, drawn from the page's own symbols: `<svg class="ol-icon"><use href="#i-search"/></svg>`.
 * The name is recorded on the request, and the layout inlines only the symbols a page uses.
 */
export function icon(ctx: Ctx, name: IconName, size?: 'sm' | 'lg'): SafeHtml {
  ctx.icons.add(name);
  const cls = size ? `ol-icon ol-icon-${size}` : 'ol-icon';
  return html`<svg class="${cls}" aria-hidden="true"><use href="#${PREFIX}${name}"/></svg>`;
}

/**
 * One hidden `<svg>` with a `<symbol>` for each icon the page used. The shapes come from the design
 * system and were checked to be plain markup when they were loaded (see `Assets`).
 */
export function iconSprite(ctx: Ctx): SafeHtml {
  const names = [...ctx.icons].sort();
  if (names.length === 0) return html``;
  const viewBox = ctx.assets.iconViewBox;
  return html`<svg xmlns="http://www.w3.org/2000/svg" hidden aria-hidden="true">${names.map(
    (name) =>
      html`<symbol id="${PREFIX}${name}" viewBox="${viewBox}">${raw(ctx.assets.icon(name) ?? '')}</symbol>`,
  )}</svg>`;
}
