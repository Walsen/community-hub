/**
 * Zod schema for the metadata document.
 *
 * This schema is the single definition of the metadata format: the TypeScript
 * models the rest of the codebase consumes ({@link ValidatedModel},
 * {@link EnvironmentModel}, {@link ForumModel}) are inferred from it with
 * `z.output`/`z.infer`, never hand-written. See the data-model steering for the
 * authoritative YAML shape.
 *
 * Objects are strict at every level so unknown keys are rejected (Req 1.3). The
 * schema covers single-field validation and the shape; cross-field rules that
 * need the whole document split into two groups:
 *
 *  - mail and DNS rules live in {@link module:metadata/mail} and are attached to
 *    {@link MetadataSchema} here (they must run inside the schema so their
 *    issues carry stable Zod paths and expansion can run as a transform);
 *  - duplicate ids/subdomains, secret prefixes, reference integrity and SSH
 *    CIDR rules are the Metadata_Loader's `validateCrossField` (task 5.1).
 */

import { z } from 'zod';

import { checkDns, checkMail, expandMail } from './mail.js';
import { secretRefSchema } from './secret-ref.js';

/** Environment name: lowercase alphanumeric with internal hyphens, 3–32 chars. */
const ENVIRONMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Route 53 hosted zone id, e.g. `Z0123456789ABCDEFGHIJ`. */
const HOSTED_ZONE_ID_RE = /^Z[A-Z0-9]+$/;

/** Forum id: starts with a letter, lowercase alphanumeric, no hyphens, 1–20 chars. */
const FORUM_ID_RE = /^[a-z][a-z0-9]{0,19}$/;

/** `HH:00` on the 24-hour clock; snapshots run on the hour. */
const SNAPSHOT_TIME_RE = /^([01][0-9]|2[0-3]):00$/;

/** Category colour: a six-digit hex RGB value without a leading `#`. */
const COLOR_RE = /^[0-9A-Fa-f]{6}$/;

/**
 * An IPv4 CIDR block such as `203.0.113.0/24`. The loader additionally rejects
 * a `/0` prefix (task 5.1); the schema only checks well-formedness here.
 */
const IPV4_CIDR_RE =
  /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\/(3[0-2]|[12][0-9]|[0-9])$/;

/** DNS provisioning mode (discriminates the DNS and email record strategy). */
export const DNS_MODES = ['route53', 'route53-existing', 'external'] as const;

/** DMARC policy published in the `_dmarc` TXT record. */
export const DMARC_POLICIES = ['none', 'quarantine', 'reject'] as const;

/**
 * Environment block: one Lightsail/Route 53/SES environment per metadata file.
 *
 * `hostedZoneId` is optional in the schema; its presence-iff-`route53-existing`
 * rule is enforced by {@link checkDns} on {@link MetadataSchema}. `mailDomain`
 * is optional here and defaulted to `rootDomain` by {@link expandMail}, so the
 * validated model always carries a concrete mail domain.
 */
export const EnvironmentSchema = z.strictObject({
  name: z.string().regex(ENVIRONMENT_NAME_RE),
  region: z.string().min(1),
  availabilityZone: z.string().min(1),
  dnsMode: z.enum(DNS_MODES),
  hostedZoneId: z.string().regex(HOSTED_ZONE_ID_RE).optional(),
  rootDomain: z.string().min(1),
  adminEmail: z.email(),
  sshAllowedCidrs: z.array(z.string().regex(IPV4_CIDR_RE)),
  snapshotTimeUtc: z.string().regex(SNAPSHOT_TIME_RE).default('06:00'),
  mailDomain: z.string().min(1).optional(),
  dmarcPolicy: z.enum(DMARC_POLICIES).default('none'),
  acmeStaging: z.boolean().default(false),
});

/** A declared group: a name and the usernames that should belong to it. */
export const GroupSchema = z.strictObject({
  name: z.string().min(1),
  members: z.array(z.string().min(1)),
});

/** A declared category: slug, display name and a hex colour. */
export const CategorySchema = z.strictObject({
  slug: z.string().min(1),
  name: z.string().min(1),
  color: z.string().regex(COLOR_RE),
});

/**
 * A declared user. `trustLevel` is a Discourse concept the Flarum adapter maps
 * to groups; `password` is an optional write-only Secret_Reference used for the
 * initial password when present.
 */
export const UserSchema = z.strictObject({
  username: z.string().min(1),
  email: z.email(),
  trustLevel: z.int().min(0).max(4),
  password: secretRefSchema.optional(),
});

/** Interface color mode a theme requests. */
export const THEME_MODES = ['light', 'dark', 'auto'] as const;

/**
 * A named color palette. Every slot is a six-hex RGB value without a leading
 * `#` (same form as a category colour). `primary`, `secondary` and `tertiary`
 * are required (text, background and accent); the remaining slots map to
 * Discourse color-scheme slots and are optional. Engines without a color-scheme
 * entity (Flarum) map what they can and skip the rest.
 */
export const PaletteSchema = z.strictObject({
  name: z.string().min(1).optional(),
  primary: z.string().regex(COLOR_RE),
  secondary: z.string().regex(COLOR_RE),
  tertiary: z.string().regex(COLOR_RE),
  quaternary: z.string().regex(COLOR_RE).optional(),
  headerBackground: z.string().regex(COLOR_RE).optional(),
  headerPrimary: z.string().regex(COLOR_RE).optional(),
  highlight: z.string().regex(COLOR_RE).optional(),
  danger: z.string().regex(COLOR_RE).optional(),
  success: z.string().regex(COLOR_RE).optional(),
  love: z.string().regex(COLOR_RE).optional(),
});

/**
 * Branding strings. These are ordinary site settings on every engine, so the
 * desired-state builder lowers them into `setting` resources rather than a new
 * resource type. `logo`/`logoSmall`/`favicon` are public URLs, never secrets.
 */
export const BrandingSchema = z.strictObject({
  title: z.string().min(1).optional(),
  logo: z.url().optional(),
  logoSmall: z.url().optional(),
  favicon: z.url().optional(),
});

/**
 * The optional per-forum theme. `palette` becomes a `colorScheme` resource;
 * `mode` and `branding` are lowered into `setting` resources by the desired
 * builder so they reconcile through the existing settings path.
 */
export const ThemeSchema = z.strictObject({
  palette: PaletteSchema.optional(),
  mode: z.enum(THEME_MODES).optional(),
  branding: BrandingSchema.optional(),
});

/**
 * The per-forum `config` section the Seeder reconciles. All subsections are
 * optional; an omitted subsection means "nothing declared" (and therefore
 * nothing managed), not "empty".
 */
export const ForumConfigSchema = z.strictObject({
  settings: z.record(z.string(), z.unknown()).default({}),
  theme: ThemeSchema.optional(),
  groups: z.array(GroupSchema).default([]),
  categories: z.array(CategorySchema).default([]),
  users: z.array(UserSchema).default([]),
});

/**
 * Secret-bearing fields for a forum. Every value is a Secret_Reference parsed
 * by {@link secretRefSchema}; inline secret values are rejected without echoing
 * the value. The reserved `ses-smtp-*` parameter names and the per-forum path
 * prefix rule are enforced by the loader (task 5.1).
 */
export const ForumSecretsSchema = z.record(z.string(), secretRefSchema);

/**
 * A single forum: its instance sizing, engine, sender identity, secret
 * references and declared configuration. `engine` is validated against the
 * Engine_Registry and `engineOptions` by the resolved adapter in the loader.
 */
export const ForumSchema = z.strictObject({
  id: z.string().regex(FORUM_ID_RE),
  engine: z.string().min(1),
  subdomain: z.string().min(1),
  bundleId: z.string().min(1),
  senderAddress: z.string().min(1),
  credentialRotation: z.int().min(0).default(0),
  secrets: ForumSecretsSchema,
  config: ForumConfigSchema.prefault({}),
  engineOptions: z.unknown().default({}),
});

/**
 * The raw metadata document before cross-field checks and expansion. `version`
 * is a required literal `1` so a future format bump is an explicit change.
 */
export const RawMetadataSchema = z.strictObject({
  version: z.literal(1),
  environment: EnvironmentSchema,
  forums: z.array(ForumSchema),
});

/**
 * The full metadata schema: raw shape, then the pure mail and DNS cross-field
 * checks, then the expansion transform. After the transform, `mailDomain` is
 * always present and `senderAddress` is a full, lowercased address, so the
 * output models carry no optional-defaulting ambiguity.
 */
export const MetadataSchema = RawMetadataSchema.superRefine(checkMail)
  .superRefine(checkDns)
  .transform(expandMail);

/** The validated, expanded metadata model consumed by the CDK app and Seeder. */
export type ValidatedModel = z.output<typeof MetadataSchema>;

/** The validated environment block. */
export type EnvironmentModel = ValidatedModel['environment'];

/** A validated, expanded forum. */
export type ForumModel = ValidatedModel['forums'][number];

/** A validated forum `config` section. */
export type ForumConfigModel = ForumModel['config'];
