---
inclusion: always
---

# Engineering Practices

## Toolchain

- Node.js 22 LTS, TypeScript with `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- npm with a committed `package-lock.json`. Pin exact dependency versions (no `^` or `~`).
- ESLint (typescript-eslint, recommended-type-checked) and Prettier. Lint and format must pass before a task is complete.
- Core libraries: `aws-cdk-lib`, `constructs`, `zod` (schema), `yaml` (parsing), `commander` (CLI), `esbuild` (Lambda bundling via `NodejsFunction`), AWS SDK v3 clients for SSM, Secrets Manager, Lightsail and IAM, and `@types/node` (dev, Node 22 line). Ask before adding anything else (for example `@aws-sdk/client-route-53` or `@aws-sdk/client-sesv2`).

## Commands

```
npm run build      # tsc --noEmit + compile
npm run lint
npm test           # vitest --run, no AWS or network access
npx cdk synth -c metadata=metadata/example.yaml
```

## Code style

- No `any`. Use `unknown` and narrow. Parse external input (YAML, HTTP responses) with Zod at the boundary.
- Prefer pure functions and plain data. Keep I/O at the edges (CLI entry points, clients, executors).
- Inject dependencies (secret resolver, HTTP client, clock, sleep) through constructor or function parameters so tests can fake them.
- Use discriminated unions for variants (`engine`, `dnsMode`, plan actions). Exhaustive `switch` with a `never` check.
- Errors: throw typed errors (`MetadataValidationError`, `SecretResolutionError`, `ForumApiError`) with structured context. Never swallow errors silently. CLI entry points map errors to messages and non-zero exit codes.
- Small modules with one responsibility. Exported functions get a short TSDoc comment.

## Security

- Never log, print, or interpolate secret values. The logger redacts known secret fields; still don't pass secrets to it.
- Secret values must never reach CDK tokens, CloudFormation outputs, tags, or user data. User data may only contain Secret_References and fetch values on the instance.
- Least privilege: per-forum node role limited to that forum's secret path, write only for the generated API key, and Route 53 changes only to its own `_acme-challenge` TXT record. Per-forum SES IAM users may only send as their own sender address. No `AmazonSSMManagedInstanceCore`, no wildcard resources where a resource can be scoped.
- SSH (port 22) opens only to CIDRs declared in metadata. No `0.0.0.0/0` for SSH.
- HTTP clients use HTTPS only, explicit timeouts, and do not disable TLS verification.

## CDK practices

- Deterministic names from `naming.ts`: `${env}-${forumId}-<resource>`. Never hard-code account IDs or regions; take them from metadata or the CDK environment.
- Tag every resource with `community-hub:environment` and, where applicable, `community-hub:forum`.
- Construct IDs are stable and derived from forum ids. Renaming a construct ID replaces the resource, so treat it as a breaking change.
- Snapshots survive destroy through the lifecycle custom resource's final manual snapshot.
- Lambda handlers take SDK clients, clock and `sleep` as injected dependencies. Error messages use operation name and error code only, never response bodies that could hold secrets. Custom resources that handle credentials return `NoEcho`.

## Shell and user data

- Bash scripts start with `set -euo pipefail`, log to `/var/log/community-hub/install.log`, and write the failure reason before exiting non-zero.
- Scripts are idempotent: check before installing or creating.
- Pin Docker image tags and git commits. No `latest`. Downloaded binaries (for example `lego`) are pinned and SHA-256 verified.
- Secrets on the instance live in `0600` files on tmpfs and are passed to tools via files or stdin, never argv. Remove them with `shred -u` when done.

## Git and changes

- Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- A change is complete only when build, lint and tests pass and the README is updated for any user-facing change (metadata fields, commands).
