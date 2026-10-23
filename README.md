# Community Hub

Community Hub stands up online community forums on [Amazon Lightsail](https://aws.amazon.com/lightsail/) from a single YAML file. You describe an environment and the forums it should host; the project provisions the infrastructure, installs the forum software, and then configures each forum's categories, users, groups, trust levels and settings.

> Status: design phase. The specification is complete and implementation has not started. Commands below describe the planned interface.

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

- An AWS account with CDK bootstrapped in the target region, and access through IAM Identity Center.
- A domain you have already registered (registration is out of scope).
- SES available in your region, and SES production access if you want to email unverified recipients.
- [Devbox](https://www.jetify.com/devbox) and [direnv](https://direnv.net/). Everything else (Node 22, just, AWS CLI v2, jq, yq, shellcheck, gitleaks, the SSM plugin) is provided by Devbox.

## Getting started (planned)

```bash
direnv allow          # loads the Devbox shell
just setup            # install dependencies and git hooks
just check            # build, lint, test, shellcheck, secret scan
just validate metadata/example.yaml
just deploy metadata/my-env.yaml
just seed-dry metadata/my-env.yaml
just seed metadata/my-env.yaml
```

## Project docs

- Spec: [requirements](.kiro/specs/lightsail-forum-platform/requirements.md), [design](.kiro/specs/lightsail-forum-platform/design.md), [tasks](.kiro/specs/lightsail-forum-platform/tasks.md)
- Conventions: [architecture](.kiro/steering/architecture.md), [engineering practices](.kiro/steering/engineering-practices.md), [testing](.kiro/steering/testing.md), [data model](.kiro/steering/data-model.md), [dev environment](.kiro/steering/dev-environment.md)

## License

[GPL-3.0](LICENSE)
