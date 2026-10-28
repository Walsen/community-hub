import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import {
  rawMetadataDocument,
  toYaml,
  type RawEnvironment,
  type RawForum,
  type RawMetadataDocument,
} from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 27: Mail domain and sender validation.
 *
 * Validates: Requirements 1.9, 1.10, 1.11
 *
 * Starting from VALID raw documents produced by {@link rawMetadataDocument},
 * this property covers the three mail rules enforced by `checkMail`/`expandMail`
 * (see `src/metadata/mail.ts`):
 *
 *  - Req 1.10 (expansion): a bare local-part `senderAddress` expands to
 *    `<local>@<mailDomain>` in the validated model, lowercased, where the mail
 *    domain is the declared `mailDomain` (lowercased) or the root domain when
 *    none is declared. The base arbitrary always emits bare local parts, so the
 *    unmutated document is the fixture for this case.
 *  - Req 1.9 (sender domain match): a full `senderAddress` whose domain differs
 *    from the effective mail domain is rejected with an issue at
 *    `forums[i].senderAddress` whose message names both the sender domain and
 *    the expected mail domain.
 *  - Req 1.11 (mail domain scope): a declared `mailDomain` that is neither equal
 *    to nor a subdomain of the root domain is rejected with an issue at
 *    `environment.mailDomain`.
 *
 * The rejection cases assert the relevant issue is PRESENT rather than asserting
 * the whole issue set: a single mutation can legitimately produce other issues,
 * which do not concern this property.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x11a1d0;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

/** The effective mail domain for a document: declared `mailDomain`, else root. */
function effectiveMailDomain(environment: RawEnvironment): string {
  return (environment.mailDomain ?? environment.rootDomain).toLowerCase();
}

/** A mail domain is in scope iff it equals the root domain or is a subdomain. */
function mailDomainInScope(mailDomain: string, rootDomain: string): boolean {
  const root = rootDomain.toLowerCase();
  const mail = mailDomain.toLowerCase();
  return mail === root || mail.endsWith(`.${root}`);
}

/** Replace the environment with a copy carrying overridden fields. */
function withEnvironmentOverride(
  doc: RawMetadataDocument,
  override: Partial<RawEnvironment>,
): RawMetadataDocument {
  return { ...doc, environment: { ...doc.environment, ...override } };
}

/** Replace forum at `index` with a copy carrying overridden fields. */
function withForumOverride(
  doc: RawMetadataDocument,
  index: number,
  override: Partial<RawForum>,
): RawMetadataDocument {
  const forums = doc.forums.map((forum, i) =>
    i === index ? ({ ...forum, ...override } satisfies RawForum) : forum,
  );
  return { ...doc, forums };
}

/**
 * Load `doc`, expecting a {@link MetadataValidationError}, and return its
 * issues. Fails the property if the loader does not throw that error.
 */
function loadExpectingError(doc: RawMetadataDocument): MetadataValidationError['issues'] {
  try {
    loadMetadata(toYaml(doc), registry);
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataValidationError);
    return (error as MetadataValidationError).issues;
  }
  throw new Error('expected loadMetadata to throw MetadataValidationError');
}

/** A short lowercase DNS label, used to build distinct domains. */
const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), fc.stringMatching(/^[a-z0-9]{0,8}$/))
  .map(([head, tail]) => `${head}${tail}`);

describe('Property 27: Mail domain and sender validation', () => {
  it('expands a bare local-part sender to <local>@<mailDomain>, lowercased (Req 1.10)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const mailDomain = effectiveMailDomain(doc.environment);
        const model = loadMetadata(toYaml(doc), registry);

        expect(model.environment.mailDomain).toBe(mailDomain);
        doc.forums.forEach((rawForum, i) => {
          // The base arbitrary only ever emits bare local parts for senders.
          expect(rawForum.senderAddress.includes('@')).toBe(false);
          const forum = model.forums[i]!;
          expect(forum.senderAddress).toBe(`${rawForum.senderAddress.toLowerCase()}@${mailDomain}`);
        });
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('rejects a full sender whose domain differs from the mail domain, naming both (Req 1.9)', () => {
    const scenario = rawMetadataDocument.chain((doc) =>
      fc
        .tuple(fc.integer({ min: 0, max: doc.forums.length - 1 }), dnsLabelArb)
        .map(([index, prefixLabel]) => ({ doc, index, prefixLabel })),
    );

    fc.assert(
      fc.property(scenario, ({ doc, index, prefixLabel }) => {
        const mailDomain = effectiveMailDomain(doc.environment);
        // Prepending a label yields a valid domain that is a strict subdomain of
        // the mail domain, so it is well-formed yet never equal to it.
        const wrongDomain = `${prefixLabel}.${mailDomain}`;
        const fullSender = `noreply@${wrongDomain}`;
        const mutated = withForumOverride(doc, index, { senderAddress: fullSender });

        const issues = loadExpectingError(mutated);

        expect(
          issues.some(
            (issue) =>
              issue.path === `forums[${index}].senderAddress` &&
              issue.message.includes(wrongDomain) &&
              issue.message.includes(mailDomain),
          ),
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('rejects a mail domain that is neither the root domain nor a subdomain of it (Req 1.11)', () => {
    const scenario = rawMetadataDocument.chain((doc) =>
      fc
        .tuple(dnsLabelArb, fc.constantFrom('example', 'invalid', 'test', 'localdomain'))
        .map(([label, base]) => `${label}.${base}`)
        // Keep only domains the rule actually considers out of scope, so the
        // mutation is guaranteed to be invalid for every generated root domain.
        .filter((unrelated) => !mailDomainInScope(unrelated, doc.environment.rootDomain))
        .map((unrelated) => ({ doc, unrelated })),
    );

    fc.assert(
      fc.property(scenario, ({ doc, unrelated }) => {
        const mutated = withEnvironmentOverride(doc, { mailDomain: unrelated });

        const issues = loadExpectingError(mutated);

        expect(issues.some((issue) => issue.path === 'environment.mailDomain')).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
