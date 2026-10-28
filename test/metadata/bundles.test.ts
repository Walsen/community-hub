import { describe, expect, it } from 'vitest';

import { LIGHTSAIL_BUNDLES, bundleRamMb, isKnownBundleId } from '../../src/metadata/bundles.js';

describe('LIGHTSAIL_BUNDLES', () => {
  it('maps the standard _3_0 bundle ids to their RAM in MB', () => {
    expect(LIGHTSAIL_BUNDLES).toEqual({
      nano_3_0: { ramMb: 512 },
      micro_3_0: { ramMb: 1024 },
      small_3_0: { ramMb: 2048 },
      medium_3_0: { ramMb: 4096 },
      large_3_0: { ramMb: 8192 },
      xlarge_3_0: { ramMb: 16384 },
      '2xlarge_3_0': { ramMb: 32768 },
    });
  });

  it('satisfies the example-metadata minimums: Flarum small_3_0 >= 1024, Discourse medium_3_0 >= 2048', () => {
    expect(bundleRamMb('small_3_0')).toBeGreaterThanOrEqual(1024);
    expect(bundleRamMb('medium_3_0')).toBeGreaterThanOrEqual(2048);
  });

  it('is monotonically non-decreasing from nano to 2xlarge', () => {
    const ramInOrder = [
      'nano_3_0',
      'micro_3_0',
      'small_3_0',
      'medium_3_0',
      'large_3_0',
      'xlarge_3_0',
      '2xlarge_3_0',
    ].map((id) => bundleRamMb(id));
    for (let i = 1; i < ramInOrder.length; i++) {
      expect(ramInOrder[i]!).toBeGreaterThan(ramInOrder[i - 1]!);
    }
  });
});

describe('bundleRamMb', () => {
  it('returns the RAM for a known bundle id', () => {
    expect(bundleRamMb('nano_3_0')).toBe(512);
    expect(bundleRamMb('2xlarge_3_0')).toBe(32768);
  });

  it('returns undefined for an unknown bundle id', () => {
    expect(bundleRamMb('medium_2_0')).toBeUndefined();
    expect(bundleRamMb('')).toBeUndefined();
    expect(bundleRamMb('nano')).toBeUndefined();
  });

  it('does not treat inherited Object properties as bundle ids', () => {
    expect(bundleRamMb('toString')).toBeUndefined();
    expect(bundleRamMb('constructor')).toBeUndefined();
    expect(bundleRamMb('hasOwnProperty')).toBeUndefined();
  });
});

describe('isKnownBundleId', () => {
  it('narrows known bundle ids', () => {
    expect(isKnownBundleId('medium_3_0')).toBe(true);
  });

  it('rejects unknown ids and inherited property names', () => {
    expect(isKnownBundleId('huge_3_0')).toBe(false);
    expect(isKnownBundleId('toString')).toBe(false);
  });
});
