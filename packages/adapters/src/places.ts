import { type ParseContext, type ParsedLine, parsePlaceLine } from '@openlinkos/origin-core';

/**
 * Origin's generated `places.jsonl`, and not a file of that name a person wrote. `generated` is
 * set only for that file (see ParseContext).
 */
export function isPlacesPath(ctx: { relPath: string; generated?: boolean }): boolean {
  return ctx.generated === true && ctx.relPath === 'places.jsonl';
}

/**
 * Parse `places.jsonl` in core and leave every other path to the adapter. A root or place line
 * yields no events, so it is not a parse error.
 */
export function parseWithPlaces(
  line: string,
  ctx: ParseContext,
  parse: (line: string, ctx: ParseContext) => ParsedLine | null,
): ParsedLine | null {
  if (isPlacesPath(ctx)) return parsePlaceLine(line);
  return parse(line, ctx);
}
