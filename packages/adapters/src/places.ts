import { type ParseContext, type ParsedLine, parsePlaceLine } from '@openlinkos/origin-core';

/** `places.jsonl` on a source: parent lines (and the root and place lines p1 owns). */
export function isPlacesPath(relPath: string): boolean {
  return relPath === 'places.jsonl' || relPath.endsWith('/places.jsonl');
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
  if (isPlacesPath(ctx.relPath)) return parsePlaceLine(line);
  return parse(line, ctx);
}
