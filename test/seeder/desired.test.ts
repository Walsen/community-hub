/**
 * Unit tests for {@link buildDesired} and the shared normalizers, complementing
 * the Seeder property tests with concrete worked examples.
 *
 * These cover:
 * - each normalizer's canonicalization (trim, lowercase slugs/usernames/emails,
 *   colour uppercased without `#`, membership lists sorted and de-duplicated);
 * - that a user's write-only `initialPassword` reference appears only when a
 *   password is declared and is listed in {@link WRITE_ONLY_FIELDS};
 * - that a forum config with settings, groups, categories and users produces
 *   the expected {@link SeedResource} list (types, natural keys, desired
 *   shapes), with one membership per (group, member) pair.
 *
 * Forum models are built by loading a small metadata document through
 * {@link loadMetadata} with a `testengine` registry, so the inputs are realistic
 * validated/expanded models rather than hand-cast objects. Secret-bearing fields
 * use obvious placeholders only.
 */

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ForumModel } from '../../src/metadata/schema.js';
import { buildDesired, WRITE_ONLY_FIELDS } from '../../src/seeder/desired.js';
import {
  normalizeColor,
  normalizeEmail,
  normalizeSlug,
  normalizeUsername,
  sortMembers,
  trimString,
} from '../../src/seeder/normalize.js';
import type { SeedResource } from '../../src/seeder/types.js';
import { createTestEngine } from '../support/testengine.js';

/** Registry with a single `testengine` adapter (minRam 512, so small bundles pass). */
const registry = new EngineRegistry([createTestEngine()]);

/** A `ssm:` password reference placeholder (never a realistic secret). */
const ALICE_PASSWORD_REF = 'ssm:/community-hub/community-test/main/users/alice';

/** Build a one-forum metadata document whose single forum carries `config`. */
function forumWithConfig(config: Record<string, unknown>): ForumModel {
  const doc = {
    version: 1,
    environment: {
      name: 'community-test',
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
      dnsMode: 'route53',
      rootDomain: 'example.org',
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
    },
    forums: [
      {
        id: 'main',
        engine: 'testengine',
        subdomain: 'forum',
        bundleId: 'small_3_0',
        senderAddress: 'noreply',
        secrets: {
          adminPassword: 'ssm:/community-hub/community-test/main/admin-password',
          apiKey: 'ssm:/community-hub/community-test/main/api-key',
        },
        config,
      },
    ],
  };
  const model = loadMetadata(stringify(doc), registry);
  const forum = model.forums[0];
  if (forum === undefined) {
    throw new Error('expected one forum');
  }
  return forum;
}

/** Index desired resources by `"<type>:<naturalKey>"` for easy assertions. */
function byKey(resources: readonly SeedResource[]): Map<string, SeedResource> {
  const map = new Map<string, SeedResource>();
  for (const resource of resources) {
    map.set(`${resource.type}:${resource.naturalKey}`, resource);
  }
  return map;
}

describe('normalizers', () => {
  it('trims strings without changing case', () => {
    expect(trimString('  Announcements ')).toBe('Announcements');
    expect(trimString('plain')).toBe('plain');
  });

  it('lowercases and trims slugs', () => {
    expect(normalizeSlug('  Announcements ')).toBe('announcements');
    expect(normalizeSlug('General-News')).toBe('general-news');
  });

  it('lowercases and trims usernames', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(normalizeUsername('BOB')).toBe('bob');
  });

  it('lowercases and trims emails including the local part', () => {
    expect(normalizeEmail('  Alice@Example.ORG ')).toBe('alice@example.org');
  });

  it('uppercases colours and strips a single leading hash', () => {
    expect(normalizeColor('#0088cc')).toBe('0088CC');
    expect(normalizeColor('0088cc')).toBe('0088CC');
    expect(normalizeColor('  #abcdef ')).toBe('ABCDEF');
  });

  it('sorts and de-duplicates membership lists after normalizing usernames', () => {
    expect(sortMembers(['  Bob ', 'alice', 'BOB', 'alice'])).toEqual(['alice', 'bob']);
    expect(sortMembers([])).toEqual([]);
  });
});

describe('buildDesired theme', () => {
  it('emits a colorScheme resource from the palette with normalized colors', () => {
    const forum = forumWithConfig({
      theme: {
        palette: {
          name: 'K Builders',
          primary: '222222',
          secondary: 'ffffff',
          tertiary: '0088cc',
          highlight: 'ffff4d',
        },
        mode: 'auto',
      },
    });
    const scheme = byKey(buildDesired(forum)).get('colorScheme:K Builders');
    expect(scheme).toBeDefined();
    const desired = scheme?.desired as Record<string, unknown>;
    expect(desired.name).toBe('K Builders');
    expect(desired.mode).toBe('auto');
    // Colours are flat color_<slot> fields, normalized (uppercase, no leading
    // hash); only declared slots are present so derived slots never diff.
    expect(desired.color_primary).toBe('222222');
    expect(desired.color_secondary).toBe('FFFFFF');
    expect(desired.color_tertiary).toBe('0088CC');
    expect(desired.color_highlight).toBe('FFFF4D');
    expect('color_danger' in desired).toBe(false);
  });

  it('defaults the color-scheme name when none is given', () => {
    const forum = forumWithConfig({
      theme: { palette: { primary: '111111', secondary: 'eeeeee', tertiary: '0088cc' } },
    });
    const schemes = buildDesired(forum).filter((r) => r.type === 'colorScheme');
    expect(schemes).toHaveLength(1);
    expect(schemes[0]?.naturalKey).toBe('community-hub');
  });

  it('lowers branding into canonical setting resources', () => {
    const forum = forumWithConfig({
      theme: {
        branding: {
          title: 'K Builders Community',
          logo: 'https://cdn.example.org/logo.png',
          favicon: 'https://cdn.example.org/favicon.ico',
        },
      },
    });
    const byk = byKey(buildDesired(forum));
    expect((byk.get('setting:title')?.desired as { value: unknown }).value).toBe(
      'K Builders Community',
    );
    expect((byk.get('setting:logo')?.desired as { value: unknown }).value).toBe(
      'https://cdn.example.org/logo.png',
    );
    expect((byk.get('setting:favicon')?.desired as { value: unknown }).value).toBe(
      'https://cdn.example.org/favicon.ico',
    );
  });

  it('emits nothing for an absent theme', () => {
    const forum = forumWithConfig({ settings: { title: 'Plain' } });
    const resources = buildDesired(forum);
    expect(resources.some((r) => r.type === 'colorScheme')).toBe(false);
  });
});

describe('buildDesired write-only password reference', () => {
  it('lists initialPassword in WRITE_ONLY_FIELDS', () => {
    expect(WRITE_ONLY_FIELDS.has('initialPassword')).toBe(true);
  });

  it('omits initialPassword when no password is declared', () => {
    const forum = forumWithConfig({
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 3 }],
    });
    const user = byKey(buildDesired(forum)).get('user:alice');
    expect(user).toBeDefined();
    const desired = user?.desired as Record<string, unknown>;
    expect('initialPassword' in desired).toBe(false);
    expect(desired).toEqual({ email: 'alice@example.org', trustLevel: 3 });
  });

  it('includes a parsed initialPassword reference when a password is declared', () => {
    const forum = forumWithConfig({
      users: [
        {
          username: 'alice',
          email: 'alice@example.org',
          trustLevel: 3,
          password: ALICE_PASSWORD_REF,
        },
      ],
    });
    const user = byKey(buildDesired(forum)).get('user:alice');
    const desired = user?.desired as Record<string, unknown>;
    expect(desired.initialPassword).toEqual({
      store: 'ssm',
      id: '/community-hub/community-test/main/users/alice',
    });
  });
});

describe('buildDesired resource list', () => {
  const forum = forumWithConfig({
    settings: { title: 'Example Community', enabled: true },
    groups: [
      { name: 'moderators', members: ['Alice', 'bob'] },
      { name: 'veterans', members: ['Alice'] },
    ],
    categories: [{ slug: 'Announcements', name: 'Announcements', color: '0088cc' }],
    users: [
      { username: 'Alice', email: 'Alice@Example.org', trustLevel: 3 },
      { username: 'bob', email: 'bob@example.org', trustLevel: 1 },
    ],
  });
  const resources = buildDesired(forum);
  const keyed = byKey(resources);

  it('emits one setting per key with the raw value', () => {
    expect(keyed.get('setting:title')?.desired).toEqual({ value: 'Example Community' });
    expect(keyed.get('setting:enabled')?.desired).toEqual({ value: true });
  });

  it('emits one group per group, excluding members', () => {
    expect(keyed.get('group:moderators')?.desired).toEqual({ name: 'moderators' });
    expect(keyed.get('group:veterans')?.desired).toEqual({ name: 'veterans' });
  });

  it('emits categories keyed by normalized slug with normalized colour', () => {
    const category = keyed.get('category:announcements');
    expect(category).toBeDefined();
    expect(category?.desired).toEqual({ name: 'Announcements', color: '0088CC' });
  });

  it('emits users keyed by normalized username with normalized email', () => {
    expect(keyed.get('user:alice')?.desired).toEqual({
      email: 'alice@example.org',
      trustLevel: 3,
    });
    expect(keyed.get('user:bob')?.desired).toEqual({
      email: 'bob@example.org',
      trustLevel: 1,
    });
  });

  it('emits one membership per (group, member) pair with normalized keys', () => {
    const memberships = resources
      .filter((resource) => resource.type === 'membership')
      .map((resource) => resource.naturalKey)
      .sort();
    expect(memberships).toEqual(['moderators:alice', 'moderators:bob', 'veterans:alice']);
    for (const resource of resources) {
      if (resource.type === 'membership') {
        expect(resource.desired).toEqual({ member: true });
      }
    }
  });

  it('emits one trustLevel per user keyed by normalized username', () => {
    expect(keyed.get('trustLevel:alice')?.desired).toEqual({ trustLevel: 3 });
    expect(keyed.get('trustLevel:bob')?.desired).toEqual({ trustLevel: 1 });
  });

  it('produces exactly the expected set of resource keys', () => {
    expect([...keyed.keys()].sort()).toEqual(
      [
        'setting:title',
        'setting:enabled',
        'group:moderators',
        'group:veterans',
        'category:announcements',
        'user:alice',
        'user:bob',
        'membership:moderators:alice',
        'membership:moderators:bob',
        'membership:veterans:alice',
        'trustLevel:alice',
        'trustLevel:bob',
      ].sort(),
    );
  });
});
