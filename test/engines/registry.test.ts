import { describe, expect, it } from 'vitest';

import { discourseAdapter } from '../../src/engines/discourse/adapter.js';
import { flarumAdapter } from '../../src/engines/flarum/adapter.js';
import { createDefaultRegistry, EngineRegistry } from '../../src/engines/registry.js';
import { UnknownEngineError } from '../../src/shared/errors.js';
import { createTestEngine } from '../support/testengine.js';

describe('EngineRegistry', () => {
  it('resolves a known engine to its adapter', () => {
    const discourse = createTestEngine({ id: 'discourse' });
    const flarum = createTestEngine({ id: 'flarum' });
    const registry = new EngineRegistry([discourse, flarum]);

    expect(registry.resolve('discourse')).toBe(discourse);
    expect(registry.resolve('flarum')).toBe(flarum);
  });

  it('throws UnknownEngineError listing the known ids for an unknown engine', () => {
    const registry = new EngineRegistry([
      createTestEngine({ id: 'discourse' }),
      createTestEngine({ id: 'flarum' }),
    ]);

    let thrown: unknown;
    try {
      registry.resolve('xenforo');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnknownEngineError);
    const error = thrown as UnknownEngineError;
    expect(error.engineId).toBe('xenforo');
    expect(error.known).toEqual(['discourse', 'flarum']);
    expect(error.message).toContain('xenforo');
    expect(error.message).toContain('discourse');
    expect(error.message).toContain('flarum');
  });

  it('throws on construction when two adapters share an id', () => {
    expect(
      () => new EngineRegistry([createTestEngine({ id: 'dup' }), createTestEngine({ id: 'dup' })]),
    ).toThrow(/duplicate engine id 'dup'/);
  });

  describe('has', () => {
    it('reports registered and unregistered ids', () => {
      const registry = new EngineRegistry([createTestEngine({ id: 'discourse' })]);

      expect(registry.has('discourse')).toBe(true);
      expect(registry.has('flarum')).toBe(false);
    });
  });

  describe('ids', () => {
    it('returns the registered ids in insertion order', () => {
      const registry = new EngineRegistry([
        createTestEngine({ id: 'flarum' }),
        createTestEngine({ id: 'discourse' }),
      ]);

      expect(registry.ids()).toEqual(['flarum', 'discourse']);
    });

    it('returns an empty list for an empty registry', () => {
      expect(new EngineRegistry([]).ids()).toEqual([]);
    });
  });

  describe('createDefaultRegistry', () => {
    it('resolves the discourse and flarum engines to their adapters', () => {
      const registry = createDefaultRegistry();

      expect(registry.resolve('discourse')).toBe(discourseAdapter);
      expect(registry.resolve('flarum')).toBe(flarumAdapter);
    });

    it('registers exactly the discourse and flarum ids', () => {
      expect(createDefaultRegistry().ids()).toEqual(['discourse', 'flarum']);
    });
  });

  it('exposes the testengine reduced supportedTypes set (no trustLevel)', () => {
    const registry = new EngineRegistry([createTestEngine()]);
    const adapter = registry.resolve('testengine');

    expect(adapter.seed.supportedTypes.has('setting')).toBe(true);
    expect(adapter.seed.supportedTypes.has('membership')).toBe(true);
    expect(adapter.seed.supportedTypes.has('trustLevel')).toBe(false);
  });
});
