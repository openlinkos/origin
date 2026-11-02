import type { PluginLogger } from './types.js';

export interface Log {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const PREFIX = 'origin: ';

/** The plugin's log: OpenClaw's plugin logger where it has the method, else standard error. */
export function pluginLog(logger: PluginLogger | undefined): Log {
  const to = (level: keyof PluginLogger, fallback: ((m: string) => void) | null) => {
    const fn = logger?.[level];
    return (message: string) => {
      try {
        if (typeof fn === 'function') fn.call(logger, `${PREFIX}${message}`);
        else fallback?.(`[origin] ${message}`);
      } catch {
        // Logging never breaks a hook.
      }
    };
  };
  return {
    debug: to('debug', null),
    info: to('info', (m) => console.error(m)),
    warn: to('warn', (m) => console.error(m)),
    error: to('error', (m) => console.error(m)),
  };
}
