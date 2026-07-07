export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const RESET = '\x1b[0m';
const LEVEL_COLOR: Record<Exclude<LogLevel, 'silent'>, string> = {
  trace: '\x1b[35m',
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/** A logger that discards every event. */
export const NOOP_LOGGER: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rendered =
      value instanceof Error ? value.message : typeof value === 'string' ? value : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/**
 * A console logger gated at `level`. warn/error go to stderr, the rest to
 * stdout. `silent` yields the no-op logger. Output shape mirrors tracing:
 * `<ISO> <LEVEL> <message> key=value ...`.
 */
export function createConsoleLogger(level: LogLevel): Logger {
  if (level === 'silent') return NOOP_LOGGER;
  const threshold = LEVEL_ORDER[level];
  const colorEnabled = process.env.NO_COLOR === undefined;

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    sink: (line: string) => void,
    isTty: boolean,
    message: string,
    fields?: LogFields,
  ) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const label = lvl.toUpperCase();
    const rendered = colorEnabled && isTty ? `${LEVEL_COLOR[lvl]}${label}${RESET}` : label;
    sink(`${new Date().toISOString()} ${rendered} ${message}${formatFields(fields)}`);
  };

  const out = (line: string) => console.log(line);
  const err = (line: string) => console.error(line);
  const outTty = process.stdout.isTTY === true;
  const errTty = process.stderr.isTTY === true;

  return {
    trace: (m, f) => emit('trace', out, outTty, m, f),
    debug: (m, f) => emit('debug', out, outTty, m, f),
    info: (m, f) => emit('info', out, outTty, m, f),
    warn: (m, f) => emit('warn', err, errTty, m, f),
    error: (m, f) => emit('error', err, errTty, m, f),
  };
}

function envLogLevel(): LogLevel {
  const raw = process.env.ORBITFLARE_LOG?.trim().toLowerCase();
  switch (raw) {
    case 'trace':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'silent':
      return raw;
    default:
      return 'silent';
  }
}

/**
 * Resolve the logger a client should use from builder inputs, falling back to
 * the `ORBITFLARE_LOG` env level (default `silent`).
 */
export function resolveLogger(explicit?: Logger, level?: LogLevel): Logger {
  if (explicit) return explicit;
  return createConsoleLogger(level ?? envLogLevel());
}
