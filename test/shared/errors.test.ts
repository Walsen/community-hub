import { describe, expect, it } from 'vitest';

import {
  ForumApiError,
  ForumUnreachableError,
  HostedZoneMismatchError,
  MAX_API_MESSAGE_LENGTH,
  PlatformError,
  SecretResolutionError,
  SesCredentialError,
  UnknownEngineError,
  UnknownForumError,
} from '../../src/shared/errors.js';

describe('SecretResolutionError', () => {
  it('names the reference and reason without the value', () => {
    const err = new SecretResolutionError({
      reference: 'ssm:/community-hub/prod/main/admin-password',
      reason: 'not_found',
    });
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.name).toBe('SecretResolutionError');
    expect(err.reference).toBe('ssm:/community-hub/prod/main/admin-password');
    expect(err.reason).toBe('not_found');
    expect(err.message).toContain('ssm:/community-hub/prod/main/admin-password');
    expect(err.message).toContain('not_found');
  });
});

describe('ForumApiError', () => {
  it('captures request and response context', () => {
    const err = new ForumApiError({
      forumId: 'main',
      method: 'POST',
      path: '/categories.json',
      status: 422,
      apiMessage: 'slug has already been taken',
      attempts: 1,
    });
    expect(err.name).toBe('ForumApiError');
    expect(err.forumId).toBe('main');
    expect(err.method).toBe('POST');
    expect(err.path).toBe('/categories.json');
    expect(err.status).toBe(422);
    expect(err.apiMessage).toBe('slug has already been taken');
    expect(err.attempts).toBe(1);
    expect(err.message).toContain('main');
    expect(err.message).toContain('POST /categories.json');
    expect(err.message).toContain('422');
    expect(err.message).toContain('slug has already been taken');
  });

  it('truncates the API message to 500 characters', () => {
    const long = 'x'.repeat(1000);
    const err = new ForumApiError({
      forumId: 'main',
      method: 'GET',
      path: '/x',
      status: 500,
      apiMessage: long,
      attempts: 5,
    });
    expect(err.apiMessage).toHaveLength(MAX_API_MESSAGE_LENGTH);
    expect(err.apiMessage).toBe('x'.repeat(MAX_API_MESSAGE_LENGTH));
  });
});

describe('ForumUnreachableError', () => {
  it('names the forum, url and cause code', () => {
    const err = new ForumUnreachableError({
      forumId: 'dev',
      url: 'https://dev.example.org/',
      cause: 'ETIMEDOUT',
    });
    expect(err.name).toBe('ForumUnreachableError');
    expect(err.forumId).toBe('dev');
    expect(err.url).toBe('https://dev.example.org/');
    expect(err.cause).toBe('ETIMEDOUT');
    expect(err.message).toContain('dev');
    expect(err.message).toContain('https://dev.example.org/');
    expect(err.message).toContain('ETIMEDOUT');
  });
});

describe('UnknownEngineError', () => {
  it('lists the unknown and known engine ids', () => {
    const err = new UnknownEngineError({ engineId: 'xenforo', known: ['discourse', 'flarum'] });
    expect(err.name).toBe('UnknownEngineError');
    expect(err.engineId).toBe('xenforo');
    expect(err.known).toEqual(['discourse', 'flarum']);
    expect(err.message).toContain('xenforo');
    expect(err.message).toContain('discourse');
    expect(err.message).toContain('flarum');
  });
});

describe('UnknownForumError', () => {
  it('lists the unknown and known forum ids', () => {
    const err = new UnknownForumError({ forumId: 'ghost', known: ['main', 'dev'] });
    expect(err.name).toBe('UnknownForumError');
    expect(err.forumId).toBe('ghost');
    expect(err.known).toEqual(['main', 'dev']);
    expect(err.message).toContain('ghost');
    expect(err.message).toContain('main');
    expect(err.message).toContain('dev');
  });
});

describe('SesCredentialError', () => {
  it('names the operation and AWS error name only', () => {
    const err = new SesCredentialError({
      forumId: 'main',
      operation: 'CreateAccessKey',
      awsErrorName: 'LimitExceededException',
    });
    expect(err.name).toBe('SesCredentialError');
    expect(err.forumId).toBe('main');
    expect(err.operation).toBe('CreateAccessKey');
    expect(err.awsErrorName).toBe('LimitExceededException');
    expect(err.message).toContain('CreateAccessKey');
    expect(err.message).toContain('main');
    expect(err.message).toContain('LimitExceededException');
  });
});

describe('HostedZoneMismatchError', () => {
  it('uses the message format from the design and reports all three ids', () => {
    const err = new HostedZoneMismatchError({
      declaredId: 'Z0123456789ABCDEFGHIJ',
      lookedUpId: 'ZAAAAAAAAAAAAAAAAAAAA',
      rootDomain: 'example.org',
    });
    expect(err.name).toBe('HostedZoneMismatchError');
    expect(err.declaredId).toBe('Z0123456789ABCDEFGHIJ');
    expect(err.lookedUpId).toBe('ZAAAAAAAAAAAAAAAAAAAA');
    expect(err.rootDomain).toBe('example.org');
    expect(err.message).toBe(
      'hosted zone Z0123456789ABCDEFGHIJ is not the public hosted zone for example.org (found ZAAAAAAAAAAAAAAAAAAAA)',
    );
  });
});

describe('PlatformError base', () => {
  it('is thrown and caught as a standard Error subtype', () => {
    const run = (): void => {
      throw new UnknownForumError({ forumId: 'x', known: [] });
    };
    expect(run).toThrow(Error);
    expect(run).toThrow(PlatformError);
    expect(run).toThrow(UnknownForumError);
  });
});
