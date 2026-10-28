/**
 * fast-check arbitraries that generate VALID raw metadata documents.
 *
 * "Raw" means the pre-validation shape: plain JS objects (and their YAML
 * serialization) that the Metadata_Loader accepts without reporting any issue
 * against the `testengine` registry. Every generator constrains itself to the
 * input space the schema and the loader's cross-field rules allow, so a
 * document built by {@link rawMetadataDocument} is valid by construction:
 *
 *  - forum ids match `^[a-z][a-z0-9]{0,19}$` and are unique across the document;
 *  - subdomains are unique;
 *  - expanded sender addresses are unique (local parts are kept unique per forum);
 *  - secret references are well-formed SSM paths under
 *    `/community-hub/<env>/<forumId>/`, never a reserved `ses-smtp-*` name, and
 *    never contain a secret value — only placeholder path segments;
 *  - group members reference declared users and user passwords are references
 *    under the forum prefix;
 *  - the environment block respects the name, CIDR (no `/0`), snapshot-hour,
 *    hosted-zone-iff-`route53-existing` and mail-domain rules.
 *
 * The module is intentionally general. Later property tests (5.5, 5.6, 5.7,
 * 21.6) and the seeder arbitraries build on these generators, so the building
 * blocks (ids, references, environment, forum) are exported individually in
 * addition to the whole-document arbitrary and its YAML helper.
 *
 * Secret VALUES never appear in metadata: secret-bearing fields only ever carry
 * `ssm:/...` references whose segments are obvious placeholders.
 */

import fc from 'fast-check';
import { stringify } from 'yaml';

import { DMARC_POLICIES, DNS_MODES } from '../../src/metadata/schema.js';

/** A lowercase alphanumeric character. */
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A lowercase letter. */
const LOWER_ALPHA = 'abcdefghijklmnopqrstuvwxyz';

const charFrom = (chars: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: chars.length - 1 }).map((i) => chars[i]!);

const stringFrom = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(charFrom(chars), { minLength, maxLength }).map((cs) => cs.join(''));

/**
 * A valid forum id: `^[a-z][a-z0-9]{0,19}$`. Starts with a letter, lowercase
 * alphanumeric, no hyphens, 1–20 characters.
 */
export const forumId: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALPHA), stringFrom(LOWER_ALNUM, 0, 19))
  .map(([head, tail]) => `${head}${tail}`);

/**
 * A valid environment name: `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`. Lowercase
 * alphanumeric with internal hyphens, 3–32 characters.
 */
export const environmentName: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALNUM), stringFrom(`${LOWER_ALNUM}-`, 1, 10), charFrom(LOWER_ALNUM))
  .map(([head, mid, tail]) => `${head}${mid}${tail}`);

/** A DNS label: `^[a-z][a-z0-9]{0,14}$`, used for subdomains and domain parts. */
const dnsLabel: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALPHA), stringFrom(LOWER_ALNUM, 0, 14))
  .map(([head, tail]) => `${head}${tail}`);

/** A plausible registered root domain like `examplexyz.org`. */
export const rootDomain: fc.Arbitrary<string> = fc
  .tuple(dnsLabel, fc.constantFrom('org', 'com', 'net', 'io'))
  .map(([label, tld]) => `${label}.${tld}`);

/** A single IPv4 octet, 0–255. */
const octet: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

/**
 * A valid IPv4 CIDR with a non-zero prefix (never `/0`: SSH must not be open to
 * the world). Prefix length is 1–32.
 */
export const ipv4Cidr: fc.Arbitrary<string> = fc
  .tuple(octet, octet, octet, octet, fc.integer({ min: 1, max: 32 }))
  .map(([a, b, c, d, prefix]) => `${a}.${b}.${c}.${d}/${prefix}`);

/** An `HH:00` snapshot time on the 24-hour clock. */
const snapshotTimeUtc: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 23 })
  .map((h) => `${String(h).padStart(2, '0')}:00`);

/** A Route 53 hosted zone id: `^Z[A-Z0-9]+$`. */
const hostedZoneId: fc.Arbitrary<string> = stringFrom(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  10,
  20,
).map((rest) => `Z${rest}`);

/**
 * Build an SSM Secret_Reference string under a forum's path prefix. The purpose
 * segments are obvious placeholders and never a reserved `ses-smtp-*` name.
 */
function secretRefUnder(prefix: string, purpose: string): string {
  return `ssm:${prefix}${purpose}`;
}

/** A raw, unexpanded forum as it appears in the metadata YAML. */
export interface RawForum {
  readonly id: string;
  readonly engine: string;
  readonly subdomain: string;
  readonly bundleId: string;
  readonly senderAddress: string;
  readonly credentialRotation: number;
  readonly secrets: Record<string, string>;
  readonly config?: RawForumConfig;
}

/** The optional raw `config` section of a forum. */
export interface RawForumConfig {
  readonly settings?: Record<string, unknown>;
  readonly groups?: { readonly name: string; readonly members: string[] }[];
  readonly categories?: { readonly slug: string; readonly name: string; readonly color: string }[];
  readonly users?: {
    readonly username: string;
    readonly email: string;
    readonly trustLevel: number;
    readonly password?: string;
  }[];
}

/** A raw environment block. */
export interface RawEnvironment {
  readonly name: string;
  readonly region: string;
  readonly availabilityZone: string;
  readonly dnsMode: (typeof DNS_MODES)[number];
  readonly hostedZoneId?: string;
  readonly rootDomain: string;
  readonly adminEmail: string;
  readonly sshAllowedCidrs: string[];
  readonly snapshotTimeUtc?: string;
  readonly mailDomain?: string;
  readonly dmarcPolicy?: (typeof DMARC_POLICIES)[number];
  readonly acmeStaging?: boolean;
}

/** A raw metadata document. */
export interface RawMetadataDocument {
  readonly version: 1;
  readonly environment: RawEnvironment;
  readonly forums: RawForum[];
}

/** Bundle ids whose RAM is at least the testengine minimum (512 MB) — all of them. */
const TESTENGINE_BUNDLE_IDS = ['nano_3_0', 'micro_3_0', 'small_3_0', 'medium_3_0'] as const;

/**
 * Generate the config section for one forum given its path prefix. Group
 * members reference declared users; user passwords (when present) are
 * references under the forum prefix. Unique usernames, slugs and group names
 * are enforced by de-duplication after generation.
 */
function forumConfigArb(prefix: string): fc.Arbitrary<RawForumConfig> {
  const user = fc.record(
    {
      username: dnsLabel,
      email: fc.tuple(dnsLabel, rootDomain).map(([local, domain]) => `${local}@${domain}`),
      trustLevel: fc.integer({ min: 0, max: 4 }),
      includePassword: fc.boolean(),
    },
    { requiredKeys: ['username', 'email', 'trustLevel', 'includePassword'] },
  );

  const category = fc.record({
    slug: dnsLabel,
    name: fc.string({ minLength: 1, maxLength: 20 }).map((s) => (s.trim() === '' ? 'Category' : s)),
    color: stringFrom('0123456789ABCDEF', 6, 6),
  });

  return fc
    .record({
      settings: fc.dictionary(dnsLabel, fc.oneof(fc.string(), fc.integer(), fc.boolean()), {
        maxKeys: 3,
      }),
      users: fc.array(user, { maxLength: 4 }),
      categories: fc.array(category, { maxLength: 3 }),
      groupNames: fc.array(dnsLabel, { maxLength: 3 }),
    })
    .map(({ settings, users, categories, groupNames }) => {
      // De-duplicate usernames so group membership references stay unambiguous
      // and the loader's declared-user set is well defined.
      const seenUsers = new Set<string>();
      const uniqueUsers = users.filter((u) => {
        if (seenUsers.has(u.username)) {
          return false;
        }
        seenUsers.add(u.username);
        return true;
      });
      const usernames = [...seenUsers];

      const seenSlugs = new Set<string>();
      const uniqueCategories = categories.filter((c) => {
        if (seenSlugs.has(c.slug)) {
          return false;
        }
        seenSlugs.add(c.slug);
        return true;
      });

      const seenGroups = new Set<string>();
      const uniqueGroupNames = groupNames.filter((g) => {
        if (seenGroups.has(g)) {
          return false;
        }
        seenGroups.add(g);
        return true;
      });

      return {
        settings,
        users: uniqueUsers.map((u) => ({
          username: u.username,
          email: u.email,
          trustLevel: u.trustLevel,
          ...(u.includePassword ? { password: secretRefUnder(prefix, `users/${u.username}`) } : {}),
        })),
        categories: uniqueCategories,
        // Each group's members are a subset of declared usernames (here: all of
        // them, which is still a valid subset and keeps references satisfied).
        groups: uniqueGroupNames.map((name) => ({
          name,
          members: usernames,
        })),
      } satisfies RawForumConfig;
    });
}

/**
 * Generate a single raw forum for a given environment name. The sender address
 * is a bare local part; the loader expands it to `<local>@<mailDomain>` and
 * requires expanded addresses to be unique, which {@link rawMetadataDocument}
 * guarantees by assigning distinct local parts per forum.
 */
function forumArb(environmentNameValue: string): fc.Arbitrary<RawForum> {
  return forumId.chain((id) => {
    const prefix = `/community-hub/${environmentNameValue}/${id}/`;
    return fc.record({
      id: fc.constant(id),
      engine: fc.constant('testengine'),
      subdomain: dnsLabel,
      bundleId: fc.constantFrom(...TESTENGINE_BUNDLE_IDS),
      senderAddress: dnsLabel,
      credentialRotation: fc.integer({ min: 0, max: 5 }),
      secrets: fc.constant({
        adminPassword: secretRefUnder(prefix, 'admin-password'),
        apiKey: secretRefUnder(prefix, 'api-key'),
      }),
      config: forumConfigArb(prefix),
    });
  });
}

/**
 * Generate a raw environment block. `dnsMode` is biased toward `route53` and
 * `external`; when `route53-existing` is chosen a valid `hostedZoneId` is
 * supplied (and never otherwise). `mailDomain` is either omitted (defaults to
 * the root domain) or a subdomain of the root domain.
 */
export function environmentArb(nameValue: string): fc.Arbitrary<RawEnvironment> {
  return rootDomain.chain((root) =>
    fc
      .record({
        name: fc.constant(nameValue),
        region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
        availabilityZone: fc.constantFrom('us-east-1a', 'us-west-2b', 'eu-west-1a'),
        dnsModeChoice: fc.constantFrom<(typeof DNS_MODES)[number]>(
          'route53',
          'route53',
          'external',
          'external',
          'route53-existing',
        ),
        rootDomain: fc.constant(root),
        adminEmail: fc.tuple(dnsLabel, fc.constant(root)).map(([l, d]) => `ops-${l}@${d}`),
        sshAllowedCidrs: fc.array(ipv4Cidr, { minLength: 1, maxLength: 3 }),
        snapshotTimeUtc: fc.option(snapshotTimeUtc, { nil: undefined }),
        mailSubLabel: fc.option(dnsLabel, { nil: undefined }),
        dmarcPolicy: fc.option(fc.constantFrom(...DMARC_POLICIES), { nil: undefined }),
        acmeStaging: fc.option(fc.boolean(), { nil: undefined }),
      })
      .map((r) => {
        const env: Record<string, unknown> = {
          name: r.name,
          region: r.region,
          availabilityZone: r.availabilityZone,
          dnsMode: r.dnsModeChoice,
          rootDomain: r.rootDomain,
          adminEmail: r.adminEmail,
          sshAllowedCidrs: r.sshAllowedCidrs,
        };
        // hostedZoneId is attached by rawMetadataDocument only when dnsMode is
        // route53-existing, so the presence-iff rule always holds.
        if (r.snapshotTimeUtc !== undefined) {
          env.snapshotTimeUtc = r.snapshotTimeUtc;
        }
        if (r.mailSubLabel !== undefined) {
          env.mailDomain = `${r.mailSubLabel}.${r.rootDomain}`;
        }
        if (r.dmarcPolicy !== undefined) {
          env.dmarcPolicy = r.dmarcPolicy;
        }
        if (r.acmeStaging !== undefined) {
          env.acmeStaging = r.acmeStaging;
        }
        return env as unknown as RawEnvironment;
      }),
  );
}

/**
 * The whole-document arbitrary: a valid raw metadata document with 1–4 forums.
 *
 * Forum ids and subdomains are made unique, and each forum gets a distinct
 * sender local part so expanded sender addresses never collide. When the
 * environment uses `route53-existing`, a valid `hostedZoneId` is attached.
 */
export const rawMetadataDocument: fc.Arbitrary<RawMetadataDocument> = environmentName.chain(
  (nameValue) =>
    fc
      .tuple(
        environmentArb(nameValue),
        fc.array(forumArb(nameValue), { minLength: 1, maxLength: 4 }),
        hostedZoneId,
      )
      .map(([environment, forums, zoneId]) => {
        // Enforce cross-forum uniqueness of ids, subdomains and sender local
        // parts by rewriting each forum with an index-derived unique suffix.
        const uniqueForums = forums.map((forum, index) => {
          const suffix = String(index);
          const id = `${forum.id}${suffix}`.slice(0, 20);
          const prefix = `/community-hub/${nameValue}/${id}/`;
          const config = rewriteConfigPrefix(forum.config, prefix);
          const rewritten: RawForum = {
            ...forum,
            id,
            subdomain: `${forum.subdomain}${suffix}`,
            senderAddress: `${forum.senderAddress}${suffix}`,
            // Re-point secret references at the (possibly rewritten) forum id so
            // they stay under this forum's prefix.
            secrets: {
              adminPassword: secretRefUnder(prefix, 'admin-password'),
              apiKey: secretRefUnder(prefix, 'api-key'),
            },
            // Only attach config when present (exactOptionalPropertyTypes).
            ...(config === undefined ? {} : { config }),
          };
          return rewritten;
        });

        const env: RawEnvironment =
          environment.dnsMode === 'route53-existing'
            ? { ...environment, hostedZoneId: zoneId }
            : environment;

        return {
          version: 1,
          environment: env,
          forums: uniqueForums,
        } satisfies RawMetadataDocument;
      }),
);

/** Re-point any user-password references in a config at a new forum prefix. */
function rewriteConfigPrefix(
  config: RawForumConfig | undefined,
  prefix: string,
): RawForumConfig | undefined {
  if (config === undefined) {
    return undefined;
  }
  const users = config.users?.map((u) =>
    u.password === undefined
      ? u
      : { ...u, password: secretRefUnder(prefix, `users/${u.username}`) },
  );
  return users === undefined ? config : { ...config, users };
}

/** Serialize a raw metadata document to YAML text using the `yaml` package. */
export function toYaml(document: RawMetadataDocument): string {
  return stringify(document);
}
