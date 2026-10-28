import { describe, expect, it } from 'vitest';

import { checkLookedUpZone } from '../../../src/infra/dns/zone-check.js';
import { HostedZoneMismatchError } from '../../../src/shared/errors.js';

const ZONE_A = 'Z0123456789ABCDEFGHIJ';
const ZONE_B = 'Z9876543210KLMNOPQRST';
const ROOT_DOMAIN = 'example.org';

describe('checkLookedUpZone', () => {
  describe('matching ids', () => {
    it('does not throw when both ids are bare and equal', () => {
      expect(() =>
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: ZONE_A,
          rootDomain: ROOT_DOMAIN,
        }),
      ).not.toThrow();
    });

    it('returns void when the ids match', () => {
      expect(
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: ZONE_A,
          rootDomain: ROOT_DOMAIN,
        }),
      ).toBeUndefined();
    });

    it('does not throw when only the looked-up id is prefixed', () => {
      expect(() =>
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: `/hostedzone/${ZONE_A}`,
          rootDomain: ROOT_DOMAIN,
        }),
      ).not.toThrow();
    });

    it('does not throw when only the declared id is prefixed', () => {
      expect(() =>
        checkLookedUpZone({
          declaredId: `/hostedzone/${ZONE_A}`,
          lookedUpId: ZONE_A,
          rootDomain: ROOT_DOMAIN,
        }),
      ).not.toThrow();
    });

    it('does not throw when both ids are prefixed', () => {
      expect(() =>
        checkLookedUpZone({
          declaredId: `/hostedzone/${ZONE_A}`,
          lookedUpId: `/hostedzone/${ZONE_A}`,
          rootDomain: ROOT_DOMAIN,
        }),
      ).not.toThrow();
    });
  });

  describe('mismatch', () => {
    it('throws HostedZoneMismatchError when bare ids differ', () => {
      expect(() =>
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: ZONE_B,
          rootDomain: ROOT_DOMAIN,
        }),
      ).toThrow(HostedZoneMismatchError);
    });

    it('carries the normalized bare ids and root domain on the error', () => {
      let caught: unknown;
      try {
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: ZONE_B,
          rootDomain: ROOT_DOMAIN,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HostedZoneMismatchError);
      const mismatch = caught as HostedZoneMismatchError;
      expect(mismatch.declaredId).toBe(ZONE_A);
      expect(mismatch.lookedUpId).toBe(ZONE_B);
      expect(mismatch.rootDomain).toBe(ROOT_DOMAIN);
      expect(mismatch.message).toBe(
        `hosted zone ${ZONE_A} is not the public hosted zone for ${ROOT_DOMAIN} (found ${ZONE_B})`,
      );
    });

    it('normalizes prefixed ids to bare form in the error when they genuinely differ', () => {
      let caught: unknown;
      try {
        checkLookedUpZone({
          declaredId: ZONE_A,
          lookedUpId: `/hostedzone/${ZONE_B}`,
          rootDomain: ROOT_DOMAIN,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HostedZoneMismatchError);
      const mismatch = caught as HostedZoneMismatchError;
      expect(mismatch.declaredId).toBe(ZONE_A);
      expect(mismatch.lookedUpId).toBe(ZONE_B);
      expect(mismatch.message).toBe(
        `hosted zone ${ZONE_A} is not the public hosted zone for ${ROOT_DOMAIN} (found ${ZONE_B})`,
      );
    });

    it('normalizes a prefixed declared id to bare form in the error', () => {
      let caught: unknown;
      try {
        checkLookedUpZone({
          declaredId: `/hostedzone/${ZONE_A}`,
          lookedUpId: ZONE_B,
          rootDomain: ROOT_DOMAIN,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HostedZoneMismatchError);
      const mismatch = caught as HostedZoneMismatchError;
      expect(mismatch.declaredId).toBe(ZONE_A);
      expect(mismatch.lookedUpId).toBe(ZONE_B);
    });
  });
});
