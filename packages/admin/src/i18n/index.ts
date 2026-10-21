import { en, type MessageKey, type Messages } from './en.js';
import { zh } from './zh.js';

export type { MessageKey, Messages };
export type Lang = 'en' | 'zh';
export const LANGS: readonly Lang[] = ['en', 'zh'];

/** The value of `<html lang>`. */
export const HTML_LANG: Record<Lang, string> = { en: 'en', zh: 'zh-CN' };

export const MESSAGES: Record<Lang, Messages> = { en, zh };

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(lang: Lang): Translate {
  const messages = MESSAGES[lang];
  return (key, params) => {
    const text = messages[key] ?? en[key];
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}

/**
 * The interface language: an explicit choice (cookie) first, then the browser's Accept-Language
 * preferences, then English.
 */
export function negotiateLang(
  cookie: string | undefined,
  acceptLanguage: string | undefined,
): Lang {
  if (cookie === 'en' || cookie === 'zh') return cookie;
  if (!acceptLanguage) return 'en';
  const prefs = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p)?.[1])
        .find((v) => v !== undefined);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((p) => p.tag.length > 0 && Number.isFinite(p.q) && p.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of prefs) {
    const base = tag.split('-')[0];
    if (base === 'zh') return 'zh';
    if (base === 'en' || tag === '*') return 'en';
  }
  return 'en';
}
