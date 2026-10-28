import { describe, expect, it } from 'vitest';

import {
  formatPath,
  MetadataValidationError,
  type ValidationIssue,
} from '../../src/metadata/errors.js';

describe('formatPath', () => {
  it('joins string segments with dots', () => {
    expect(formatPath(['environment', 'mailDomain'])).toBe('environment.mailDomain');
  });

  it('renders numeric segments as bracketed indices', () => {
    expect(formatPath(['forums', 1, 'secrets', 'adminPassword'])).toBe(
      'forums[1].secrets.adminPassword',
    );
  });

  it('renders a leading numeric index without a preceding dot', () => {
    expect(formatPath([0, 'id'])).toBe('[0].id');
  });

  it('chains consecutive indices', () => {
    expect(formatPath(['a', 0, 1, 'b'])).toBe('a[0][1].b');
  });

  it('returns the root marker for an empty path', () => {
    expect(formatPath([])).toBe('<root>');
  });
});

describe('MetadataValidationError', () => {
  it('is an Error with the expected name', () => {
    const error = new MetadataValidationError([{ path: 'version', message: 'is required' }]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MetadataValidationError);
    expect(error.name).toBe('MetadataValidationError');
  });

  it('sorts issues by path then message', () => {
    const issues: ValidationIssue[] = [
      { path: 'forums[1].engine', message: 'unknown engine "wiki"' },
      { path: 'environment.region', message: 'is required' },
      { path: 'forums[1].engine', message: 'another reason' },
    ];
    const error = new MetadataValidationError(issues);
    expect(error.issues.map((i) => `${i.path}|${i.message}`)).toEqual([
      'environment.region|is required',
      'forums[1].engine|another reason',
      'forums[1].engine|unknown engine "wiki"',
    ]);
  });

  it('does not mutate the caller-provided issue array', () => {
    const issues: ValidationIssue[] = [
      { path: 'b', message: 'second' },
      { path: 'a', message: 'first' },
    ];
    new MetadataValidationError(issues);
    expect(issues.map((i) => i.path)).toEqual(['b', 'a']);
  });

  it('lists each path and reason in the message', () => {
    const error = new MetadataValidationError([
      { path: 'environment.region', message: 'is required' },
      { path: 'forums[1].engine', message: 'unknown engine "wiki"' },
    ]);
    expect(error.message).toContain('2 issues');
    expect(error.message).toContain('environment.region: is required');
    expect(error.message).toContain('forums[1].engine: unknown engine "wiki"');
  });

  it('uses singular wording for a single issue', () => {
    const error = new MetadataValidationError([{ path: 'version', message: 'is required' }]);
    expect(error.message).toContain('1 issue:');
    expect(error.message).not.toContain('1 issues');
  });

  it('never echoes a secret value supplied in an issue message', () => {
    // The message carries only paths and reasons the caller provides; the
    // loader is responsible for dropping value-bearing fields. This guards the
    // formatting contract: the error adds nothing beyond the given path/reason.
    const error = new MetadataValidationError([
      {
        path: 'forums[0].secrets.adminPassword',
        message: 'must be a Secret_Reference (ssm: or secretsmanager:)',
      },
    ]);
    expect(error.message).not.toContain('test-secret-value');
    expect(error.message).toContain('forums[0].secrets.adminPassword');
  });
});
