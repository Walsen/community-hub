/**
 * Structured JSON-lines logger with a {@link Redactor} backstop.
 *
 * The logger writes one JSON object per line to an injected {@link LogSink}, so
 * tests capture output without any console coupling or hardcoded I/O. Every
 * record passes through a {@link Redactor} before it is written. Callers must
 * still never pass secret values to the logger; redaction is a safety net, not
 * a licence to log secrets.
 */

/** Severity levels emitted by the logger, in ascending order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Replacement text substituted for any redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are always redacted, matched case-insensitively at any
 * depth: `password`, `secret`, `token`, `apiKey`/`api_key`/`api-key`,
 * `authorization`, and `activationCode`/`activation_code`/`activation-code`.
 */
const SECRET_KEY_PATTERN = /password|secret|token|api[-_]?key|authorization|activation[-_]?code/i;

/**
 * Structured fields attached to a log record. Values may be arbitrarily nested;
 * the logger does not require them to be pre-serialized.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/** A single serialized log line (without the trailing newline). */
export interface LogSink {
  /** Write one already-serialized JSON record. */
  write(line: string): void;
}

/** Leveled structured logger. Each method emits exactly one JSON line. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Redacts secret material from values before they are logged. Redaction is
 * applied in two independent ways:
 *
 * 1. Key-based: the value of any object key whose name matches the secret key
 *    pattern is replaced with {@link REDACTED}, at any depth.
 * 2. Value-based: any secret value registered with {@link register} that occurs
 *    as a substring of any string field is replaced with {@link REDACTED}.
 *
 * Non-secret fields are left untouched. The redactor never mutates its input;
 * it returns a redacted copy.
 */
export class Redactor {
  /** Registered secret values, longest first so longer secrets win on overlap. */
  readonly #secrets: string[] = [];

  /**
   * Register a secret value. Any later-redacted string containing this value as
   * a substring has the value replaced with {@link REDACTED}. Empty strings are
   * ignored so they cannot match everything.
   */
  register(value: string): void {
    if (value.length === 0 || this.#secrets.includes(value)) {
      return;
    }
    this.#secrets.push(value);
    this.#secrets.sort((a, b) => b.length - a.length);
  }

  /**
   * Return a redacted copy of {@link value}. Objects and arrays are walked
   * recursively; strings have registered secret values stripped; keys matching
   * the secret key pattern have their entire value replaced.
   */
  redact(value: unknown): unknown {
    return this.#redactValue(value, false);
  }

  #redactValue(value: unknown, keyIsSecret: boolean): unknown {
    if (keyIsSecret) {
      return REDACTED;
    }
    if (typeof value === 'string') {
      return this.#redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.#redactValue(item, false));
    }
    if (value !== null && typeof value === 'object') {
      return this.#redactObject(value as Record<string, unknown>);
    }
    return value;
  }

  #redactObject(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      output[key] = this.#redactValue(child, SECRET_KEY_PATTERN.test(key));
    }
    return output;
  }

  #redactString(input: string): string {
    let result = input;
    for (const secret of this.#secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
      }
    }
    return result;
  }
}

/** The shape written to the sink for each record, before serialization. */
interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly [field: string]: unknown;
}

/**
 * Create a leveled JSON-lines {@link Logger}.
 *
 * Each log call builds a record of `{ level, message, ...fields }`, passes it
 * through the {@link Redactor}, serializes it to a single JSON line, and writes
 * it to the injected {@link LogSink}. The `level` and `message` keys are
 * reserved; fields of those names are overwritten by the call's level and
 * message.
 *
 * @param deps.sink - Destination for serialized records (stderr in the CLI).
 * @param deps.redactor - Applied to every record before it is written.
 */
export function createLogger(deps: { sink: LogSink; redactor: Redactor }): Logger {
  const { sink, redactor } = deps;

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const record: LogRecord = { ...fields, level, message };
    const redacted = redactor.redact(record);
    sink.write(JSON.stringify(redacted));
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
