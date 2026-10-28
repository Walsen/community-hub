/**
 * Strict Zod schema for Flarum `engineOptions`.
 *
 * `engineOptions` for Flarum carries an optional admin username (default
 * `'admin'`), an optional release tag (default the pinned {@link FLARUM_VERSION}),
 * and an optional `trustLevelGroups` map. Flarum has no native trust levels, so
 * the map translates the Discourse-style `trustLevel` a user may declare into a
 * declared Flarum group (resolved by {@link resolveTrustLevelGroup} in the seed
 * client). The object is strict, so unknown keys are rejected at the metadata
 * boundary like every other block.
 *
 * The schema is consumed in two shapes. The adapter's
 * {@link EngineAdapter.engineOptionsSchema} field is typed `z.ZodType<unknown>`,
 * so {@link flarumOptionsSchema} is exported for that slot; the install script
 * and the adapter read the parsed values through the inferred
 * {@link FlarumEngineOptions} type.
 */

import { z } from 'zod';

import { FLARUM_DEFAULT_ADMIN_USERNAME, FLARUM_VERSION } from './versions.js';

/** The trust-level keys the mapping may assign (0..4 as strings). */
const TRUST_LEVEL_KEYS = ['0', '1', '2', '3', '4'] as const;

/**
 * Concrete strict schema for Flarum `engineOptions`.
 *
 * `adminUsername` defaults to {@link FLARUM_DEFAULT_ADMIN_USERNAME} and
 * `version` to the pinned {@link FLARUM_VERSION}. `trustLevelGroups` is optional
 * and, when present, maps each declared trust-level key (`'0'`..`'4'`) to a
 * group name; the adapter's `validate` checks that the mapped groups are
 * declared (or the implicit Member group). Unknown keys are rejected. Kept as
 * its own binding so the inferred {@link FlarumEngineOptions} type stays precise;
 * {@link flarumOptionsSchema} re-exports it typed for the adapter contract slot.
 */
const flarumOptionsObjectSchema = z.strictObject({
  adminUsername: z.string().min(1).default(FLARUM_DEFAULT_ADMIN_USERNAME),
  trustLevelGroups: z.partialRecord(z.enum(TRUST_LEVEL_KEYS), z.string().min(1)).optional(),
  version: z.string().min(1).default(FLARUM_VERSION),
});

/**
 * The Flarum options schema, typed as `z.ZodType<unknown>` so it slots directly
 * into the {@link EngineAdapter.engineOptionsSchema} field.
 */
export const flarumOptionsSchema: z.ZodType<unknown> = flarumOptionsObjectSchema;

/**
 * The inferred, defaulted Flarum options for internal use. Parsing with
 * {@link flarumOptionsSchema} yields a value of this shape with `adminUsername`
 * and `version` present and `trustLevelGroups` present only when declared.
 */
export type FlarumEngineOptions = z.output<typeof flarumOptionsObjectSchema>;
