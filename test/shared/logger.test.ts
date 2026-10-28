import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED, Redactor, type LogSink } from '../../src/shared/logger.js';

/** In-memory {@link LogSink} that captures every written line. */
class FakeSink implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  /** Parse the single captured line as JSON, asserting exactly one was written. */
  only(): Record<string, unknown> {
    expect(this.lines).toHaveLength(1);
    return JSON.parse(this.lines[0]!) as Record<string, unknown>;
  }
}

describe('Redactor key-based redaction', () => {
  it('redacts values of secret-named keys case-insensitively', () => {
    const redactor = new Redactor();
    const input = {
      password: 'test-secret-value',
      Secret: 'test-secret-value',
      TOKEN: 'test-secret-value',
      authorization: 'Bearer test-secret-value',
      apiKey: 'test-secret-value',
      api_key: 'test-secret-value',
      'api-key': 'test-secret-value',
      activationCode: 'test-secret-value',
      activation_code: 'test-secret-value',
      'activation-code': 'test-secret-value',
    };

    const result = redactor.redact(input) as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      expect(result[key]).toBe(REDACTED);
    }
  });

  it('redacts secret keys nested in objects and arrays at any depth', () => {
    const redactor = new Redactor();
    const input = {
      outer: {
        inner: {
          password: 'test-secret-value',
          keep: 'visible',
        },
      },
      list: [{ apiKey: 'test-secret-value' }, { normal: 'ok' }],
    };

    const result = redactor.redact(input) as {
      outer: { inner: { password: unknown; keep: unknown } };
      list: Array<Record<string, unknown>>;
    };

    expect(result.outer.inner.password).toBe(REDACTED);
    expect(result.outer.inner.keep).toBe('visible');
    expect(result.list[0]!.apiKey).toBe(REDACTED);
    expect(result.list[1]!.normal).toBe('ok');
  });

  it('redacts an entire nested value, not just string leaves, when the key is secret', () => {
    const redactor = new Redactor();
    const input = { secret: { nested: ['a', 'b'], n: 1 } };

    const result = redactor.redact(input) as Record<string, unknown>;

    expect(result.secret).toBe(REDACTED);
  });
});

describe('Redactor registered-value substring redaction', () => {
  it('replaces a registered value anywhere it appears as a substring', () => {
    const redactor = new Redactor();
    redactor.register('test-secret-value');

    const result = redactor.redact({
      note: 'connecting with test-secret-value now',
      nested: { url: 'https://host/?t=test-secret-value&x=1' },
      list: ['prefix-test-secret-value-suffix'],
    }) as {
      note: string;
      nested: { url: string };
      list: string[];
    };

    expect(result.note).toBe(`connecting with ${REDACTED} now`);
    expect(result.nested.url).toBe(`https://host/?t=${REDACTED}&x=1`);
    expect(result.list[0]).toBe(`prefix-${REDACTED}-suffix`);
  });

  it('replaces every occurrence within a single string', () => {
    const redactor = new Redactor();
    redactor.register('test-secret-value');

    const result = redactor.redact('test-secret-value / test-secret-value');

    expect(result).toBe(`${REDACTED} / ${REDACTED}`);
  });

  it('ignores empty registered values so they do not match everything', () => {
    const redactor = new Redactor();
    redactor.register('');

    expect(redactor.redact('nothing to redact here')).toBe('nothing to redact here');
  });

  it('prefers the longest registered value on overlap', () => {
    const redactor = new Redactor();
    redactor.register('secretABCDEF');
    redactor.register('secret');

    const result = redactor.redact('value=secretABCDEF');

    expect(result).toBe(`value=${REDACTED}`);
  });
});

describe('Redactor non-secret handling', () => {
  it('leaves non-secret fields untouched and does not mutate the input', () => {
    const redactor = new Redactor();
    const input = {
      username: 'alice',
      count: 3,
      enabled: true,
      missing: null,
      tags: ['a', 'b'],
    };

    const result = redactor.redact(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    // Original is unchanged.
    expect(input.username).toBe('alice');
  });

  it('passes through non-object primitives unchanged', () => {
    const redactor = new Redactor();
    expect(redactor.redact(42)).toBe(42);
    expect(redactor.redact(true)).toBe(true);
    expect(redactor.redact(null)).toBeNull();
    expect(redactor.redact(undefined)).toBeUndefined();
  });
});

describe('createLogger', () => {
  it('writes exactly one JSON line per call with level and message set', () => {
    const sink = new FakeSink();
    const logger = createLogger({ sink, redactor: new Redactor() });

    logger.info('hello', { forumId: 'main' });

    const record = sink.only();
    expect(record.level).toBe('info');
    expect(record.message).toBe('hello');
    expect(record.forumId).toBe('main');
  });

  it('emits the correct level for each method', () => {
    const sink = new FakeSink();
    const logger = createLogger({ sink, redactor: new Redactor() });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(sink.lines).toHaveLength(4);
    const levels = sink.lines.map((line) => {
      const parsed: { level: string } = JSON.parse(line) as { level: string };
      return parsed.level;
    });
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('reserves level and message, overwriting matching fields', () => {
    const sink = new FakeSink();
    const logger = createLogger({ sink, redactor: new Redactor() });

    logger.warn('actual message', { level: 'debug', message: 'spoofed' });

    const record = sink.only();
    expect(record.level).toBe('warn');
    expect(record.message).toBe('actual message');
  });

  it('applies key-based redaction to the full record', () => {
    const sink = new FakeSink();
    const logger = createLogger({ sink, redactor: new Redactor() });

    logger.info('resolved', { password: 'test-secret-value', forumId: 'main' });

    const record = sink.only();
    expect(record.password).toBe(REDACTED);
    expect(record.forumId).toBe('main');
    expect(sink.lines[0]).not.toContain('test-secret-value');
  });

  it('applies registered-value redaction to the full record', () => {
    const sink = new FakeSink();
    const redactor = new Redactor();
    redactor.register('test-secret-value');
    const logger = createLogger({ sink, redactor });

    logger.error('failed', { detail: 'token was test-secret-value' });

    const record = sink.only();
    expect(record.detail).toBe(`token was ${REDACTED}`);
    expect(sink.lines[0]).not.toContain('test-secret-value');
  });

  it('produces a single parseable JSON line without a trailing newline', () => {
    const sink = new FakeSink();
    const logger = createLogger({ sink, redactor: new Redactor() });

    logger.info('line');

    expect(sink.lines[0]).not.toContain('\n');
    expect(() => {
      JSON.parse(sink.lines[0]!);
    }).not.toThrow();
  });
});
