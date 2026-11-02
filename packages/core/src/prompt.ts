/**
 * Prompts: which user messages read as a prompt someone typed, and the start of one as a name. Pure,
 * with no imports, so that the database can call it from SQL too (`origin_prompt`, see db.ts).
 */

/** At most this many characters of a prompt stand in for the name of a session without a title. */
export const PROMPT_TITLE_MAX = 80;

/** Text this long is no lone bracketed notice, and only its start can become a name. */
const PROMPT_HEAD = 1000;

/**
 * A user message as a provisional name for a session without a title, or null if it does not read
 * as a prompt. Agents add context and echo commands as user messages made of XML-style elements
 * (`<tag …>…</tag>`), such as Claude Code's `<command-name>`, `<local-command-stdout>`, and
 * `<local-command-caveat>`, or Codex's `<environment_context>`: the elements a message starts with
 * are skipped, and what follows them is the prompt. Nothing left, or only a bracketed notice such as
 * `[Request interrupted by user]`, is no prompt. Whitespace is collapsed, and the prompt cut to `max`
 * characters, PROMPT_TITLE_MAX by default. Whether it is the owner's prompt is for its author to say
 * (see isOwnerPrompt in authors.ts).
 */
export function promptTitle(text: string, max = PROMPT_TITLE_MAX): string | null {
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    const open = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?\/?>/.exec(rest);
    if (!open) break;
    const [tag, name = ''] = open;
    if (tag.endsWith('/>')) {
      rest = rest.slice(tag.length);
      continue;
    }
    const close = rest.indexOf(`</${name}>`, tag.length);
    if (close < 0) break; // not an element: a prompt that starts with `<`
    rest = rest.slice(close + name.length + 3);
  }
  const long = rest.length > PROMPT_HEAD;
  const prompt = (long ? rest.slice(0, PROMPT_HEAD) : rest).replace(/\s+/g, ' ').trim();
  if (prompt.length === 0 || (!long && /^\[[^\]]*\]$/.test(prompt))) return null;
  const chars = [...prompt];
  if (chars.length <= max) return prompt;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}
