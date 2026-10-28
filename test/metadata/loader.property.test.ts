import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { rawMetadataDocument, toYaml } from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 1: Metadata load round trip and determinism.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.7, 1.8
 *
 * For any valid raw document D produced by {@link rawMetadataDocument},
 * `loadMetadata(toYaml(D), registry)`:
 *  - succeeds (the loader parses and validates it against the schema — Req 1.3);
 *  - is deterministic: loading the same text twice yields deep-equal models
 *    (Req 1.7);
 *  - round-trips the declared environment and forums (Req 1.1, 1.2), applying
 *    the documented expansion and defaults (mailDomain defaulted to rootDomain,
 *    sender expanded and lowercased, dmarcPolicy/acmeStaging/snapshotTimeUtc
 *    defaults);
 *  - returns a deep-frozen model (Req 1.8 — same stable, immutable model).
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x10adec0;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

describe('Property 1: Metadata load round trip and determinism', () => {
  it('loads any generated valid document without error (Req 1.3)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        expect(() => loadMetadata(toYaml(doc), registry)).not.toThrow();
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('is deterministic: loading the same text twice yields deep-equal models (Req 1.7)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const text = toYaml(doc);
        const first = loadMetadata(text, registry);
        const second = loadMetadata(text, registry);
        expect(second).toEqual(first);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('round-trips declared environment and forums with expansion applied (Req 1.1, 1.2)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const model = loadMetadata(toYaml(doc), registry);

        // Environment round trip.
        expect(model.environment.name).toBe(doc.environment.name);
        expect(model.environment.region).toBe(doc.environment.region);
        expect(model.environment.availabilityZone).toBe(doc.environment.availabilityZone);
        expect(model.environment.dnsMode).toBe(doc.environment.dnsMode);
        expect(model.environment.rootDomain).toBe(doc.environment.rootDomain);
        expect(model.environment.adminEmail).toBe(doc.environment.adminEmail);
        expect(model.environment.sshAllowedCidrs).toEqual(doc.environment.sshAllowedCidrs);

        // hostedZoneId is present iff route53-existing.
        if (doc.environment.dnsMode === 'route53-existing') {
          expect(model.environment.hostedZoneId).toBe(doc.environment.hostedZoneId);
        } else {
          expect(model.environment.hostedZoneId).toBeUndefined();
        }

        // Defaults.
        expect(model.environment.snapshotTimeUtc).toBe(doc.environment.snapshotTimeUtc ?? '06:00');
        expect(model.environment.dmarcPolicy).toBe(doc.environment.dmarcPolicy ?? 'none');
        expect(model.environment.acmeStaging).toBe(doc.environment.acmeStaging ?? false);

        // mailDomain defaults to the (lowercased) root domain when omitted.
        const expectedMailDomain = (
          doc.environment.mailDomain ?? doc.environment.rootDomain
        ).toLowerCase();
        expect(model.environment.mailDomain).toBe(expectedMailDomain);

        // Forums round trip, in declaration order.
        expect(model.forums).toHaveLength(doc.forums.length);
        doc.forums.forEach((rawForum, i) => {
          const forum = model.forums[i]!;
          expect(forum.id).toBe(rawForum.id);
          expect(forum.engine).toBe(rawForum.engine);
          expect(forum.subdomain).toBe(rawForum.subdomain);
          expect(forum.bundleId).toBe(rawForum.bundleId);
          expect(forum.credentialRotation).toBe(rawForum.credentialRotation);

          // Sender address: bare local part expanded against the mail domain and
          // lowercased.
          expect(forum.senderAddress).toBe(
            `${rawForum.senderAddress.toLowerCase()}@${expectedMailDomain}`,
          );

          // Secret references are parsed into { store, id } under the forum prefix.
          expect(forum.secrets.adminPassword).toEqual({
            store: 'ssm',
            id: `/community-hub/${doc.environment.name}/${rawForum.id}/admin-password`,
          });
          expect(forum.secrets.apiKey).toEqual({
            store: 'ssm',
            id: `/community-hub/${doc.environment.name}/${rawForum.id}/api-key`,
          });
        });
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('returns a deep-frozen model (Req 1.8)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const model = loadMetadata(toYaml(doc), registry);
        expect(Object.isFrozen(model)).toBe(true);
        expect(Object.isFrozen(model.environment)).toBe(true);
        expect(Object.isFrozen(model.forums)).toBe(true);
        for (const forum of model.forums) {
          expect(Object.isFrozen(forum)).toBe(true);
          expect(Object.isFrozen(forum.secrets)).toBe(true);
          expect(Object.isFrozen(forum.config)).toBe(true);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
