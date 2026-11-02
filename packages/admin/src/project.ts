import type { Lang } from './i18n/index.js';

/**
 * Where the open-source project lives, for the links that credit it: on the hub's landing page,
 * at the foot of every page of the admin UI, and on its sign-in pages.
 */
export const SITE_URL = 'https://origin.openlinkos.com/';
export const SOURCE_URL = 'https://github.com/openlinkos/origin';
export const ISSUES_URL = 'https://github.com/openlinkos/origin/issues/new/choose';

/** A page of the documentation in a language; its home when `page` is empty. */
export function docsHref(lang: Lang, page = ''): string {
  return `${SITE_URL}${lang === 'zh' ? 'zh/' : ''}${page}`;
}
