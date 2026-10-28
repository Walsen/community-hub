/**
 * Strict Zod schema for Discourse `engineOptions`.
 *
 * `engineOptions` for Discourse is intentionally small: an optional admin
 * username (default `'admin'`) and an optional Discourse release tag (default
 * the pinned {@link DISCOURSE_VERSION_TAG}). The object is strict, so unknown
 * keys are rejected at the metadata boundary like every other block.
 *
 * The schema is consumed in two shapes. The adapter's
 * {@link EngineAdapter.engineOptionsSchema} field is typed `z.ZodType<unknown>`,
 * so {@link discourseOptionsSchema} is exported for that slot; the install
 * script and the adapter read the parsed values through the inferred
 * {@link DiscourseEngineOptions} type.
 */

import { z } from 'zod';

import { DISCOURSE_DEFAULT_ADMIN_USERNAME, DISCOURSE_VERSION_TAG } from './versions.js';

/**
 * Concrete strict schema for Discourse `engineOptions`.
 *
 * Both fields default: `adminUsername` to {@link DISCOURSE_DEFAULT_ADMIN_USERNAME}
 * and `version` to the pinned {@link DISCOURSE_VERSION_TAG}. Unknown keys are
 * rejected. Kept as its own binding so the inferred {@link DiscourseEngineOptions}
 * type stays precise; {@link discourseOptionsSchema} re-exports it typed for the
 * adapter contract slot.
 */
const discourseOptionsObjectSchema = z.strictObject({
  adminUsername: z.string().min(1).default(DISCOURSE_DEFAULT_ADMIN_USERNAME),
  version: z.string().min(1).default(DISCOURSE_VERSION_TAG),
});

/**
 * The Discourse options schema, typed as `z.ZodType<unknown>` so it slots
 * directly into the {@link EngineAdapter.engineOptionsSchema} field.
 */
export const discourseOptionsSchema: z.ZodType<unknown> = discourseOptionsObjectSchema;

/**
 * The inferred, fully-defaulted Discourse options for internal use. Parsing
 * with {@link discourseOptionsSchema} yields a value of this shape with both
 * fields present.
 */
export type DiscourseEngineOptions = z.output<typeof discourseOptionsObjectSchema>;
