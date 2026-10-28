import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { rawMetadataDocument, toYaml, type RawMetadataDocument } from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 5: Inline secrets are rejected without echoing the value.
 *
 * Validates: Requirements 2.2
 *
 * Secret-bearing fields (`forums[i].secrets.<key>` and
 * `forums[i].config.users[j].password`) accept only well-formed
 * Secret_References. If a document inlines a raw secret value into such a field,
 * the Metadata_Loader must:
 *  - reject the document with a {@link MetadataValidationError};
 *  - report an issue located at the mutated field's path; and, critically,
 *  - never echo the injected value — not in `error.message`, nor in any
 *    `issue.message`, nor in any `issue.path`. An inlined secret must not leak
 *    into logs or CLI output through the validation error.
 *
 * The test starts from a VALID raw document, overwrites exactly one secret
 * field with an arbitrary inline value that is NOT a valid reference (it does
 * not start with `ssm:` or `secretsmanager:` and does not match either
 * reference regex), serializes to YAML and loads it.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x5ec2e7;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

/** The two reference-prefix regexes the loader treats as valid references. */
const SSM_RE = /^ssm:(\/[A-Za-z0-9_.\-/]{1,1010})$/;
const SM_RE = /^secretsmanager:([A-Za-z0-9/_+=.@\-:]{1,2048})$/;

/**
 * An arbitrary inline "secret" value that is a placeholder string (never a
 * realistic credential) and is guaranteed NOT to be a valid Secret_Reference.
 *
 * The value carries a fixed, distinctive marker prefix so the "not echoed"
 * assertion is meaningful: a non-empty, unusual token that would stand out if
 * it leaked into any path or message. Values that happen to parse as a
 * reference are filtered out.
 */
const inlineSecretValue: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 24 })
  .map((suffix) => `INLINE-SECRET-${suffix}`)
  .filter((value) => !SSM_RE.test(value) && !SM_RE.test(value));

/** A single place a secret-bearing value lives in a raw document. */
type Site =
  | { readonly kind: 'secret'; readonly forumIndex: number; readonly key: string }
  | { readonly kind: 'password'; readonly forumIndex: number; readonly userIndex: number };

/** Enumerate every secret-bearing field in a document. */
function secretSites(doc: RawMetadataDocument): Site[] {
  const sites: Site[] = [];
  doc.forums.forEach((forum, forumIndex) => {
    for (const key of Object.keys(forum.secrets)) {
      sites.push({ kind: 'secret', forumIndex, key });
    }
    forum.config?.users?.forEach((_user, userIndex) => {
      sites.push({ kind: 'password', forumIndex, userIndex });
    });
  });
  return sites;
}

/**
 * Return a copy of `doc` with the chosen secret-bearing field overwritten by
 * `value`, plus the document-absolute path the loader is expected to report.
 */
function withInlineSecret(
  doc: RawMetadataDocument,
  site: Site,
  value: string,
): { mutated: RawMetadataDocument; path: string } {
  const forums = doc.forums.map((forum, forumIndex) => {
    if (forumIndex !== site.forumIndex) {
      return forum;
    }
    if (site.kind === 'secret') {
      return { ...forum, secrets: { ...forum.secrets, [site.key]: value } };
    }
    const users = (forum.config?.users ?? []).map((user, userIndex) =>
      userIndex === site.userIndex ? { ...user, password: value } : user,
    );
    return { ...forum, config: { ...forum.config, users } };
  });

  const path =
    site.kind === 'secret'
      ? `forums[${String(site.forumIndex)}].secrets.${site.key}`
      : `forums[${String(site.forumIndex)}].config.users[${String(site.userIndex)}].password`;

  return { mutated: { ...doc, forums }, path };
}

/**
 * A valid document paired with one inline-secret mutation of a randomly chosen
 * secret-bearing field, and the path the loader should report.
 */
const documentWithInlineSecret: fc.Arbitrary<{
  mutated: RawMetadataDocument;
  path: string;
  value: string;
}> = fc
  .tuple(rawMetadataDocument, inlineSecretValue)
  .chain(([doc, value]) =>
    fc
      .constantFrom(...secretSites(doc))
      .map((site) => ({ ...withInlineSecret(doc, site, value), value })),
  );

describe('Property 5: Inline secrets are rejected without echoing the value', () => {
  it('rejects an inline secret, reports its path, and never echoes the value (Req 2.2)', () => {
    fc.assert(
      fc.property(documentWithInlineSecret, ({ mutated, path, value }) => {
        let thrown: unknown;
        try {
          loadMetadata(toYaml(mutated), registry);
        } catch (error) {
          thrown = error;
        }

        // The document must be rejected as a metadata validation error.
        expect(thrown).toBeInstanceOf(MetadataValidationError);
        const err = thrown as MetadataValidationError;

        // An issue must exist at the mutated field's path.
        const atPath = err.issues.filter((issue) => issue.path === path);
        expect(atPath.length).toBeGreaterThan(0);

        // CRITICAL: the injected value must never be echoed anywhere.
        expect(err.message).not.toContain(value);
        for (const issue of err.issues) {
          expect(issue.path).not.toContain(value);
          expect(issue.message).not.toContain(value);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
