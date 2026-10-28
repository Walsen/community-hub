/**
 * The Engine_Registry: the lookup table from a Forum_Engine id to its
 * {@link EngineAdapter}.
 *
 * Core modules (`infra/`, `seeder/`, `metadata/`) receive an
 * {@link EngineRegistry} by injection and reach engine behaviour only through
 * it, never through a concrete adapter. {@link createDefaultRegistry} is the
 * single place that imports the concrete `engines/discourse` and
 * `engines/flarum` adapters; core modules import that factory, not the
 * adapters, so the architecture boundary stays intact.
 */

import { discourseAdapter } from './discourse/adapter.js';
import { flarumAdapter } from './flarum/adapter.js';
import type { EngineAdapter } from './engine-adapter.js';
import { UnknownEngineError } from '../shared/errors.js';

/**
 * An immutable registry of {@link EngineAdapter}s keyed by their stable
 * {@link EngineAdapter.id | id}. Built once from a fixed set of adapters; it
 * performs no I/O and holds no mutable state.
 */
export class EngineRegistry {
  private readonly adapters: ReadonlyMap<string, EngineAdapter>;

  /**
   * Build a registry from the given adapters.
   *
   * @param adapters - The adapters to register; their ids must be unique.
   * @throws Error if two adapters share the same {@link EngineAdapter.id}.
   */
  constructor(adapters: readonly EngineAdapter[]) {
    const byId = new Map<string, EngineAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.id)) {
        throw new Error(`duplicate engine id '${adapter.id}' in EngineRegistry`);
      }
      byId.set(adapter.id, adapter);
    }
    this.adapters = byId;
  }

  /**
   * Resolve an engine id to its adapter.
   *
   * @param id - The engine id to look up.
   * @throws UnknownEngineError naming the unknown id and the known ids.
   */
  resolve(id: string): EngineAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new UnknownEngineError({ engineId: id, known: this.ids() });
    }
    return adapter;
  }

  /** Whether an adapter is registered for the given engine id. */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /** The registered engine ids, in insertion order. */
  ids(): readonly string[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Build the default {@link EngineRegistry} with every engine Community Hub
 * ships: Discourse and Flarum.
 *
 * This is the ONLY code that imports the concrete `engines/discourse` and
 * `engines/flarum` adapters. Core modules (`infra/`, `seeder/`, `metadata/`)
 * depend on this factory, never on an adapter directly, which keeps the engine
 * plugin boundary intact. Adding a new engine is a one-line change here: import
 * its adapter and add it to the array below.
 *
 * @returns A registry containing the Discourse and Flarum adapters.
 */
export function createDefaultRegistry(): EngineRegistry {
  return new EngineRegistry([discourseAdapter, flarumAdapter]);
}
