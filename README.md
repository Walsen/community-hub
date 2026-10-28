# Community Hub

Community Hub stands up online community forums on [Amazon Lightsail](https://aws.amazon.com/lightsail/) from a single YAML file. You describe an environment and the forums it should host; the project provisions the infrastructure, installs the forum software, and then configures each forum's categories, users, groups, trust levels and settings.

## What it does

- **Infrastructure as code (AWS CDK, TypeScript).** One CloudFormation stack per environment: a Lightsail instance, static IP, firewall and daily snapshots per forum, plus Route 53 DNS, Amazon SES email and the IAM needed to keep each forum isolated.
- **Forum deployment.** Each forum runs on its own instance and subdomain:
  - [Discourse](https://www.discourse.org/) through the official `discourse_docker` launcher.
  - [Flarum](https://flarum.org/) through Docker Compose (PHP, MySQL, Caddy).
  - Engines are plugins behind a common interface, so others (for example XenForo, which is commercial and out of scope for now) can be added without touching the core.
- **Configuration from metadata.** A seeder CLI reads the same YAML and applies categories, users, groups, trust levels and settings through each forum's admin API. It is idempotent, supports dry runs, and never deletes anything it does not manage.

## How it fits together

```
metadata/*.yaml ──► loader (validate) ──► CDK app ──► Lightsail, Route 53, SES, IAM
                                     └──► seeder  ──► forum admin APIs
```

- **DNS:** Route 53, either a hosted zone the platform creates, an existing zone you own, or records you manage elsewhere.
- **TLS:** Let's Encrypt certificates issued and renewed on each instance, validated through Route 53 (DNS-01) or HTTP-01.
- **Email:** Amazon SES with DKIM, SPF and DMARC records, and per-forum credentials that can only send as that forum's address.
- **Secrets:** referenced from SSM Parameter Store or Secrets Manager, never stored in YAML, templates or logs. Instances get scoped AWS credentials by registering with SSM, without long-lived keys.

## Example metadata

```yaml
version: 1
environment:
  name: community-prod
  region: us-east-1
  availabilityZone: us-east-1a
  dnsMode: route53
  rootDomain: example.org
  adminEmail: ops@example.org
  sshAllowedCidrs: [203.0.113.0/24]

forums:
  - id: main
    engine: discourse
    subdomain: forum
    bundleId: medium_3_0
    senderAddress: noreply
    secrets:
      adminPassword: ssm:/community-hub/community-prod/main/admin-password
      apiKey: ssm:/community-hub/community-prod/main/api-key
    config:
      categories:
        - { slug: announcements, name: Announcements }
      users:
        - { username: alice, email: alice@example.org, trustLevel: 3 }
```

## Prerequisites

- **AWS account, CDK bootstrapped.** Bootstrap CDK once in the Environment's region with `just bootstrap` (it prints the account, region and metadata file, then asks to confirm). Access the account through IAM Identity Center rather than long-lived keys:

  ```bash
  aws sso login --profile "$AWS_PROFILE"
  ```

- **A registered root domain.** The operator registers `rootDomain` before deployment; domain registration is out of scope. In `route53` mode you also update the registrar's delegation (see [DNS modes](#dns-modes)).
- **SES in the Environment region.** SES must be available in `environment.region` (the deploy fails otherwise), and you need SES production access to email recipients outside the verified sandbox. Only one Mail_Domain identity may exist per account and region.
- **Devbox and direnv.** [Devbox](https://www.jetify.com/devbox) and [direnv](https://direnv.net/) are the only host prerequisites. Everything else comes from Devbox: Node 22, `just`, `jq`, `yq`, AWS CLI v2, the SSM Session Manager plugin, `shellcheck`, `shfmt` and `gitleaks`.

## Getting started

```bash
direnv allow                             # load the Devbox shell
just setup                               # npm ci + install git hooks
just check                               # build, lint, test, shellcheck, secret scan
just validate metadata/example.yaml      # validate a metadata file
just bootstrap metadata/my-env.yaml      # one-time CDK bootstrap (confirm)
just deploy metadata/my-env.yaml         # deploy the environment (confirm)
just outputs                             # pretty-print the last deploy's outputs
just seed-dry metadata/my-env.yaml       # plan the seeder, no changes
just seed metadata/my-env.yaml           # apply forum configuration
```

Every recipe takes `metadata` as its first argument and defaults to
`$COMMUNITY_HUB_METADATA` (itself defaulting to `metadata/example.yaml`), so
inside a configured shell you can usually drop the path.

## Dev environment

Every contributor and CI job uses the same toolchain through Devbox; nothing is
installed globally except Devbox and direnv. Run `direnv allow` once (and again
after any `.envrc` change) so direnv loads the Devbox shell.

direnv then loads an optional, gitignored `.env.local` for your own non-secret
settings. Never put secrets in it — secret values live only in SSM Parameter
Store or Secrets Manager.

```bash
# .env.local (example, not committed)
AWS_PROFILE=community-hub-dev
AWS_REGION=us-east-1
COMMUNITY_HUB_METADATA=metadata/dev.yaml
```

### Recipes

`just` with no arguments lists everything. The main recipes:

| Recipe                       | Does                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `setup`                      | `npm ci` and install git hooks                              |
| `build`                      | Type-check and compile                                      |
| `lint`                       | ESLint and Prettier check                                   |
| `fmt`                        | Prettier on everything, `shfmt` on tracked shell scripts    |
| `test`                       | Unit test suite (no AWS, no network)                        |
| `shellcheck`                 | Render engine user data and `shellcheck` it                 |
| `secrets-scan`               | `gitleaks detect --redact`                                  |
| `check`                      | The full gate: build, lint, test, shellcheck, secret scan   |
| `validate metadata`          | Validate a metadata file and print issues                   |
| `synth metadata`             | Synthesize CloudFormation templates                         |
| `diff metadata`              | Show the CDK diff                                           |
| `bootstrap metadata`         | CDK bootstrap for the account/region (`[confirm]`)          |
| `deploy metadata`            | Deploy, writing `cdk.out/outputs.json` (`[confirm]`)        |
| `destroy metadata`           | Destroy the environment (`[confirm]`)                       |
| `outputs`                    | Pretty-print `cdk.out/outputs.json`                         |
| `seed metadata forum=""`     | Run the seeder, optionally for one forum                    |
| `seed-dry metadata forum=""` | Dry-run the seeder: plan only, no mutations                 |
| `ssm forum`                  | Open an SSM session to a forum's managed node (interactive) |
| `install-log forum`          | Tail `/var/log/community-hub/install.log` on a node         |
| `test-integration`           | Opt-in live tests that create real resources (`[confirm]`)  |

Recipes that create, change or delete AWS resources (`bootstrap`, `deploy`,
`destroy`, `test-integration`) carry `[confirm]` and print the account, region
and metadata file before prompting.

### Git hooks and CI

Git hooks run through [lefthook](https://github.com/evilmartians/lefthook)
(installed by `just setup`): `pre-commit` runs a staged secret scan, Prettier
and ESLint on staged files, and `shfmt` on staged shell scripts; `pre-push`
runs `just check`. Do not bypass hooks with `--no-verify`.

CI installs Devbox and runs `devbox run -- just check`. CI never deploys;
deploys are operator-run with `just deploy`.

## Metadata reference

The Zod schema in `src/metadata/schema.ts` is the single definition of the
metadata format. There is no SMTP block: SES settings are derived by the
platform.

### Environment

| Field              | Required | Default      | Rules                                                                   |
| ------------------ | -------- | ------------ | ----------------------------------------------------------------------- |
| `name`             | yes      | —            | `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`; used in resource names             |
| `region`           | yes      | —            | SES must be available here                                              |
| `availabilityZone` | yes      | —            | e.g. `us-east-1a`                                                       |
| `dnsMode`          | yes      | —            | `route53` \| `route53-existing` \| `external`                           |
| `hostedZoneId`     | cond.    | —            | required if and only if `dnsMode` is `route53-existing`; `^Z[A-Z0-9]+$` |
| `rootDomain`       | yes      | —            | registered by the operator beforehand                                   |
| `adminEmail`       | yes      | —            | Let's Encrypt account, SNS bounce/complaint subscription, DMARC `rua`   |
| `sshAllowedCidrs`  | yes      | —            | IPv4 CIDRs; a `/0` prefix is rejected (no SSH open to the world)        |
| `snapshotTimeUtc`  | no       | `06:00`      | `HH:00`                                                                 |
| `mailDomain`       | no       | `rootDomain` | must equal `rootDomain` or be a subdomain of it                         |
| `dmarcPolicy`      | no       | `none`       | `none` \| `quarantine` \| `reject`                                      |
| `acmeStaging`      | no       | `false`      | `true` uses Let's Encrypt staging (tests only)                          |

### Forum

| Field                | Required | Default | Rules                                                                 |
| -------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `id`                 | yes      | —       | unique; `^[a-z][a-z0-9]{0,19}$` (no hyphens, keeps names injective)   |
| `engine`             | yes      | —       | must be registered in the Engine_Registry (`discourse`, `flarum`)     |
| `subdomain`          | yes      | —       | unique; the FQDN is `<subdomain>.<rootDomain>`                        |
| `bundleId`           | yes      | —       | in `src/metadata/bundles.ts`; RAM ≥ the engine minimum                |
| `senderAddress`      | yes      | —       | local part or full address on `mailDomain`; unique per environment    |
| `credentialRotation` | no       | `0`     | bump to rotate SES SMTP credentials                                   |
| `secrets`            | yes      | —       | Secret_References only (see below); `apiKey` is written at first boot |
| `config`             | no       | `{}`    | `settings`, `groups`, `categories`, `users` — all optional            |
| `engineOptions`      | no       | `{}`    | engine-specific, validated by the resolved adapter                    |

Minimum RAM: Discourse 2048 MB, Flarum 1024 MB. Flarum also requires a
`databasePassword` secret and uses `engineOptions.trustLevelGroups` to map
Discourse trust levels onto its groups.

The loader collects all issues (it is not fail-fast), sorts them by field path,
and throws one error whose messages name the field path, never a secret value.
Group members and trust-level mappings must reference declared users or groups.
Seeding settings that would break SES (Discourse `notification_email`, Flarum
`mail_*`) is rejected.

### Secret_References

Secret-bearing fields accept only references, never inline values:

```
ssm:<parameter-name>                 # SSM Parameter Store, SecureString
secretsmanager:<secret-name-or-arn>  # Secrets Manager
```

References must live under `/community-hub/<env>/<forumId>/`. The names
`ses-smtp-username` and `ses-smtp-password` under that prefix are reserved for
the platform and are rejected in metadata.

## Secret store setup

Create each referenced secret before deploying, following the
`/community-hub/<env>/<forumId>/<purpose>` convention:

- **SSM Parameter Store** parameters must be `SecureString`. The platform
  reads them with decryption on the instance.
- **Secrets Manager** secrets must already exist — create the API key secret
  with a placeholder value, because first-boot creation would require broader
  IAM than the per-forum node role has.

The platform writes `ses-smtp-username` and `ses-smtp-password` for each forum;
do not create or manage those yourself.

## DNS modes

- **`route53`** — the platform creates the public hosted zone. After the first
  deploy, copy the `HostedZoneNameServers` output into your registrar's name
  server settings. Certificates are issued once delegation propagates (within
  the ~2-hour retry window); after that, re-run the install script on the node
  if needed. Destroying in this mode fails with `HostedZoneNotEmpty` if records
  were added to the zone by hand — remove those records and re-run `just destroy`.
- **`route53-existing`** — you own the zone; set `hostedZoneId`. Synthesis needs
  AWS credentials because it looks the zone up, and the result is cached in
  `cdk.context.json` (commit it). After recreating a zone, clear the stale entry
  with `cdk context --reset <key>`. A wrong or private zone fails synthesis
  (naming the declared `hostedZoneId` and the root domain) before any record is
  created. The zone is never managed as a resource. Pre-existing records with
  the same name and type make the deploy fail; the platform never overwrites them.
- **`external`** — the platform only emits outputs; you create the records.

### External DNS steps

In `external` mode, read the deploy outputs and create, per forum:

- the A record pointing the forum's FQDN at its static IP;
- the six email records (DKIM, custom MAIL FROM, SPF and DMARC) surfaced as
  `Email<id>Name` / `Email<id>Type` / `Email<id>Value` output triples.

HTTP-01 certificate issuance waits up to 120 minutes for the A record to
resolve to the instance's public IP, so create the A record promptly.

## TLS

Certificates are issued and renewed on each instance by a pinned, checksum-
verified `lego`. Route 53 modes use the DNS-01 challenge (scoped to the forum's
own `_acme-challenge` TXT record) where the engine supports it; otherwise
HTTP-01. Certificate files and the install log live under
`/var/log/community-hub/` and the engine's cert paths; a systemd timer handles
renewal (`systemctl list-timers community-hub-tls-renew.timer`). Set
`acmeStaging: true` in tests to use Let's Encrypt staging and avoid production
rate limits.

## SES setup

- **Confirm the SNS subscription.** The bounce/complaint subscription to
  `adminEmail` stays `PendingConfirmation` until you click the confirmation link
  in that inbox; until then bounce and complaint notices are dropped.
- **Identity verification.** The domain identity uses Easy DKIM; check its
  verification status after deploy.
- **Production access.** New accounts start in the SES sandbox per region, so
  mail reaches only verified identities. Request production access to send to
  arbitrary recipients.
- **Suppression list.** SES maintains an account-level suppression list;
  addresses that bounced or complained are suppressed account-wide until removed.
- **DMARC reports.** If `adminEmail` (the DMARC `rua` destination) is outside the
  Mail_Domain, add the authorization record at the receiving domain (RFC 7489
  §7.1). The platform does not create it.
- **One Mail_Domain per account and region.** A second identity for the same
  Mail_Domain in the same account and region fails to create.

### Credential rotation

To rotate a forum's SES SMTP credentials, bump `credentialRotation` for that
forum and redeploy. Read each forum's `EmailRefreshStatus` output to see whether
the instance picked up the new credentials. If the status is `failed` (or
`node-offline` and the node is since back up), refresh manually over Session
Manager or Run Command by running `/opt/community-hub/bin/refresh-email.sh` on
the node.

## Operating instances

Instances register as SSM hybrid managed nodes, so no SSH key is needed for
day-to-day operations:

```bash
just ssm main                    # interactive shell on the "main" forum's node
just install-log main            # tail the install log over SSM
```

Lightsail instances cannot use instance profiles, so each one claims a
single-use, one-hour SSM activation from a per-Environment **bootstrap broker**
at first boot. The broker is a Lambda function URL that is unauthenticated at
the HTTP layer by design — an instance has no AWS credentials to sign with
before it is registered. Authorization is instead account ownership of the
claimed forum (the broker verifies its Lightsail instance exists and is running),
combined with a single registration per forum and a single-use, one-hour
activation; the broker returns generic statuses and never logs activation codes.
Because the caller is not authenticated, anyone who knows an environment and
forum id could request an activation while that forum has no registered node; the
bounds on that and why it is accepted are in the design doc ("Residual exposure").

If first-boot registration reports a 409, a stale managed node is already
registered for that forum; deregister it before the instance can re-register.

## Update limitations

- Lightsail runs launch scripts only at instance creation, so install-time user
  data changes affect only new instances. `BundleId`, `BlueprintId` and
  `AvailabilityZone` do not support updates and changing them fails the stack
  update. The supported path is snapshot → remove the forum → re-add it.
- Construct IDs and resource names derive from the forum `id`. Renaming a forum
  id (or a construct id) replaces the underlying resources rather than updating
  them in place; treat it as a breaking change.
- `just destroy` keeps a final manual snapshot per forum (taken by the lifecycle
  custom resource), so backups survive the destroy.

## Adding an engine

Engines are plugins behind the `EngineAdapter` contract. To add one, create a
new `src/engines/<engine>/` directory implementing the adapter (minimum RAM,
blueprint, install and email-refresh scripts, TLS capability, option validation
and seed operations) and add a single line registering it in
`src/engines/registry.ts`. Core modules (`infra/`, `seeder/`, `metadata/`) do
not import concrete adapters.

## Project docs

- Spec: [requirements](.kiro/specs/lightsail-forum-platform/requirements.md), [design](.kiro/specs/lightsail-forum-platform/design.md), [tasks](.kiro/specs/lightsail-forum-platform/tasks.md)
- Conventions: [architecture](.kiro/steering/architecture.md), [engineering practices](.kiro/steering/engineering-practices.md), [testing](.kiro/steering/testing.md), [data model](.kiro/steering/data-model.md), [dev environment](.kiro/steering/dev-environment.md)

## License

[GPL-3.0](LICENSE)
