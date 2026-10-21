/**
 * HTML built from tagged templates. Every interpolated value is escaped unless it is already
 * `SafeHtml` (the result of another `html` template, or of `raw()` for static, trusted markup), so
 * session text, entry text, and anything else from the store can never become markup.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape text for use in element content and in quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

/** Interpolation values: text is escaped, `SafeHtml` is kept, arrays are joined, nullish and false render nothing. */
export type HtmlValue =
  | SafeHtml
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<HtmlValue>;

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined || value === false || value === true) return '';
  if (Array.isArray(value)) return value.map((v: HtmlValue) => render(v)).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** Markup that is trusted as is. Only for static strings written in this package, never for data. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** A link target inside the admin UI: `/admin/<path>` plus encoded query parameters. */
export function href(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === false || v === '') continue;
    query.set(k, v === true ? '1' : String(v));
  }
  const qs = query.toString();
  const base = `/admin/${path.replace(/^\/+/, '')}`;
  return qs ? `${base}?${qs}` : base;
}
