---
inclusion: always
---

# Data Model

The Zod schema in `src/metadata/schema.ts` is the single definition of the metadata format. TypeScript types are inferred from it (`z.infer`). Do not hand-write duplicate interfaces. Update this document when the schema changes.

## Metadata file (YAML)

```yaml
version: 1
environment:
  name: community-prod          # ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$; used in resource names
  region: us-east-1             # SES must be available here
  availabilityZone: us-east-1a
  dnsMode: route53              # route53 | route53-existing | external
  # hostedZoneId: Z0123456789ABCDEFGHIJ   # required iff dnsMode is route53-existing; ^Z[A-Z0-9]+$
  rootDomain: example.org       # registered by the operator beforehand
  adminEmail: ops@example.org   # Let's Encrypt account, SNS bounce/complaint subscription, DMARC rua
  sshAllowedCidrs: [203.0.113.0/24]
  snapshotTimeUtc: "06:00"      # optional, default 06:00; must be HH:00
  mailDomain: example.org       # optional, default rootDomain; rootDomain or a subdomain of it
  dmarcPolicy: none             # optional; none | quarantine | reject
  acmeStaging: false            # optional; true = Let's Encrypt staging (tests only)

forums:
  - id: main                    # unique; ^[a-z][a-z0-9]{0,19}$ (no hyphens: keeps names injective)
    engine: discourse           # must be registered in EngineRegistry
    subdomain: forum            # unique; FQDN = forum.example.org
    bundleId: medium_3_0        # must be in the bundle table and meet the adapter's minimum RAM
    senderAddress: noreply      # local part or full address on mailDomain; unique per Environment
    credentialRotation: 0       # optional; bump to rotate SES SMTP credentials
    secrets:
      adminPassword: ssm:/community-hub/community-prod/main/admin-password
      apiKey: ssm:/community-hub/community-prod/main/api-key   # written at first boot
      # databasePassword: required when the adapter lists it (Flarum)
    config:
      settings:
        title: "Example Community"
      groups:
        - name: moderators
          members: [alice]
      categories:
        - slug: announcements
          name: Announcements
          color: "0088CC"
      users:
        - username: alice
          email: alice@example.org
          trustLevel: 3
          password: ssm:/community-hub/community-prod/main/users/alice   # optional
    engineOptions: {}           # engine-specific, validated by the adapter

  - id: dev
    engine: flarum
    subdomain: dev
    bundleId: small_3_0
    senderAddress: dev-forum@example.org
    secrets:
      adminPassword: ssm:/community-hub/community-prod/dev/admin-password
      apiKey: ssm:/community-hub/community-prod/dev/api-key
      databasePassword: ssm:/community-hub/community-prod/dev/database-password
    engineOptions:
      trustLevelGroups:         # Flarum has no trust levels; map them to groups
        "0": members            # implicit Member group = no extra group
        "3": veterans           # must be a declared group
```

There is no SMTP block. The Platform derives SES settings: host `email-smtp.<region>.amazonaws.com`, port 587 STARTTLS, and SMTP credentials stored at `/community-hub/<env>/<forumId>/ses-smtp-username` and `ses-smtp-password`. Those two names are reserved for the Platform.

## Rules the loader enforces

- `version` is required; unknown keys are rejected at every level (`strictObject`).
- `forums[].id`, `forums[].subdomain` and expanded `senderAddress` values are unique.
- `engine` resolves in the EngineRegistry; `engineOptions` is validated by that adapter; secrets listed in the adapter's `requiredSecrets` are present.
- `bundleId` is in `src/metadata/bundles.ts` and its RAM is at least the adapter's minimum (Discourse 2048 MB, Flarum 1024 MB).
- `hostedZoneId` is present if and only if `dnsMode` is `route53-existing`.
- `mailDomain` equals `rootDomain` or is a subdomain of it; the sender domain equals `mailDomain`. A bare local part expands to `<local>@<mailDomain>`.
- Secret-bearing fields accept only Secret_References under `/community-hub/<env>/<forumId>/`, excluding the reserved `ses-smtp-*` names. Errors show the field path, never the value. YAML parse errors are reported by line and column without quoting source lines.
- Group members and trust-level mappings reference declared users or groups.
- Seeding settings that would break SES (Discourse `notification_email`, Flarum `mail_*`) is rejected.
- Issues are collected (not fail-fast), sorted by path, and thrown as one `MetadataValidationError`. The returned model is deep-frozen and depends only on `(text, registry)`.

## Secret_Reference format

```
ssm:<parameter-name>                 # SSM Parameter Store, SecureString
secretsmanager:<secret-name-or-arn>  # Secrets Manager
```

Parsed into `{ store: 'ssm' | 'secretsmanager', id: string }`. Names follow `/community-hub/<env>/<forumId>/<purpose>`, which lets each forum's IAM scope be a single path prefix.

## Seeder domain types

```ts
type ResourceType = 'setting' | 'group' | 'category' | 'user' | 'membership' | 'trustLevel';

interface SeedResource<T = unknown> {
  type: ResourceType;
  naturalKey: string;   // setting key, group name, category slug, username, "group:user", username
  desired: T;           // normalized declared attributes only
}

type PlanAction =
  | { kind: 'create'; resource: SeedResource }
  | { kind: 'update'; resource: SeedResource; diff: FieldDiff[] }
  | { kind: 'noop'; resource: SeedResource }
  | { kind: 'skip'; resource: SeedResource; reason: string };   // e.g. unsupported by engine

interface ForumPlan { forumId: string; actions: PlanAction[] }   // ordered by ResourceType order above

type ActionResult = PlanAction & { outcome: 'applied' | 'failed' | 'skipped'; error?: string };

interface RunSummary {
  forumId: string;
  created: number; updated: number; unchanged: number; skipped: number; failed: number;
  unreachable: boolean;
}
```

Membership removal from a declared group is an `update` (`member: true -> false`); there is no delete action. On Flarum, `trustLevel` resources are rewritten by the adapter into `membership` resources for the mapped group.

## Comparison semantics

- Match by Natural_Key only. Normalize before comparing (trim strings, lowercase slugs, usernames and emails, sort membership lists).
- Compare only declared attributes. Attributes the YAML omits are not managed and never cause an update.
- Group membership is authoritative for declared groups (declared members = actual members). Undeclared groups are not touched.
- Never delete entities. Removal from YAML means "stop managing", not "delete".
