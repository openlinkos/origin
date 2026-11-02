import path from 'node:path';
import {
  allAdapters,
  createLinesAdapter,
  isLinesSourceId,
  LINES_SOURCE_RULE,
  linesSources,
} from '@openlinkos/origin-adapters';
import { type SourceAdapter, sourcesDir } from '@openlinkos/origin-core';

/**
 * The sources a store reads (see docs/sources.md): the built-in ones, one per agent, and a person's
 * own, one per directory under `$ORIGIN_HOME/sources/` whose name can name a source, each read by
 * the lines adapter. The directory is the registration: there is nothing else to set up.
 */

/** The directories already warned about in this process, so that a long-running one warns once. */
const warned = new Set<string>();

/**
 * The adapters of the store at `home`: the built-in ones, then one for each source of one's own, by
 * name. A directory under `sources/` whose name names no source is ignored, with one warning, the
 * first time this process lists it, through `warn` when given.
 */
export function sourceAdapters(home: string, warn?: (message: string) => void): SourceAdapter[] {
  const dir = sourcesDir(home);
  const own = linesSources(dir);
  if (warn) {
    for (const name of own.ignored) {
      const ignored = path.join(dir, name);
      if (warned.has(ignored)) continue;
      warned.add(ignored);
      warn(`Ignored ${ignored}, which names no source: ${LINES_SOURCE_RULE}.`);
    }
  }
  return [...allAdapters(), ...own.adapters];
}

/**
 * The adapters of the store at `home` by source id, as a migration asks for them: the store's own,
 * and a lines adapter for any other name that can name a source, such as those a hub's devices push.
 */
export function storeAdapters(home: string): (source: string) => SourceAdapter | null {
  return hubAdapters(sourceAdapters(home), home);
}

/**
 * How a hub finds the adapter for a file of `source`: one of `adapters` (the built-in ones and its
 * own sources), or for any other name that can name a source, a lines adapter, so that it parses
 * the sources its devices push and the lines appended to it (see server.ts) alike. Null for a name
 * that names no source.
 */
export function hubAdapters(
  adapters: SourceAdapter[],
  home: string,
): (source: string) => SourceAdapter | null {
  const own = new Map<string, SourceAdapter>();
  return (source) => {
    const listed = adapters.find((a) => a.id === source);
    if (listed) return listed;
    if (!isLinesSourceId(source)) return null;
    let adapter = own.get(source);
    if (!adapter) {
      // Parsing reads only the line, so where its own directory would be does not matter here.
      adapter = createLinesAdapter({ id: source, dir: path.join(sourcesDir(home), source) });
      own.set(source, adapter);
    }
    return adapter;
  };
}
