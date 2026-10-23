---
inclusion: always
---

# Testing

## Framework

- Vitest (`vitest --run`) for all unit and construct tests.
- `fast-check` for property-based tests.
- `aws-cdk-lib/assertions` (`Template`) for CDK tests.
- Tests live in `test/`, mirroring `src/`, named `*.test.ts`. Property tests use `*.property.test.ts`.

## Ground rules

- The default suite runs with no AWS credentials and no network access. Fake the secret resolver, HTTP client, clock and sleep through dependency injection. Do not mock module internals.
- Tests are deterministic: fixed seeds for fast-check failures are reported and reproducible, no real timers (inject `sleep`), no reliance on test order.
- Never put realistic secrets in fixtures. Use obvious placeholders like `test-secret-value`.
- Every bug fix ships with a test that fails before the fix.

## What to test where

| Area | Test type | Focus |
|---|---|---|
| `metadata/` | unit + property | valid example parses; each invalid case reports the right field path; duplicate ids/subdomains rejected; inline secrets rejected without echoing the value; loader is deterministic |
| `engines/registry` | unit | resolve known engines; unknown engine error |
| `engines/*` provisioning | unit + snapshot | user data contains hostname, email, secret references and pinned image tags; contains no secret values; minimum RAM enforced |
| `engines/*` seed client | unit with fake HTTP | request shape per operation; response parsing; error mapping |
| `seeder/reconciler` | property | see properties below |
| `seeder/executor` | unit | dependency order; continue on failure; 429 retry with backoff up to 5 attempts; unreachable forum skipped; dry-run makes zero mutating calls |
| `infra/` | CDK assertions | one instance, static IP and firewall per forum; ports 80/443 open, 22 only to declared CIDRs; tags and deterministic names; snapshot settings; outputs |
| `infra/dns` | CDK assertions + unit | hosted zone only in `route53`; never in `route53-existing` (lookup context seeded via `ContextProvider.getKey`); A and email records only in Route 53 modes; no Route 53 resources in `external`; zone-check mismatch errors |
| `infra/email` | unit + CDK assertions | SMTP password derivation against a fixed vector; sender policy allows only the forum's address; identity, config set, SNS topic and policy; rotation counter change replaces only that forum's credential resource |
| `infra/tls`, `user-data/tls` | unit | challenge selection per DNS mode and adapter; DNS-01 statements scoped to `_acme-challenge.<host>` TXT; HTTP-01 forums get no Route 53 actions; rendered script uses pinned lego + checksum and the adapter's cert paths and reload command |
| `infra/handlers/*` | unit with fake SDK clients | broker IP check, single registration, generic errors; SES credentials create/rotate/delete and two-key limit; email refresh statuses; lifecycle final snapshot; no secret in logs, `Data` or errors |

## Core properties

Implement these with fast-check against an in-memory fake forum:

1. **Idempotency.** For any desired state D and actual state A: applying `plan(D, A)` to A gives A′, and `plan(D, A′)` contains only no-op actions.
2. **No collateral changes.** Entities in A that are not declared in D are identical in A′.
3. **Convergence.** Every declared entity in A′ matches its declaration by Natural_Key.
4. **Dry-run purity.** Dry-run on any (D, A) issues zero mutating calls and leaves A unchanged.
5. **Secret hygiene.** For any metadata with generated secret values, no resolved value (including SES secret access keys, SMTP passwords and activation codes) appears in synthesized templates, outputs, tags, user data, custom resource responses, or captured log output.
6. **Naming stability.** Adding or removing one forum leaves the construct IDs, resource names, DNS record sets and SES credentials of all other forums unchanged.

## Integration tests (opt-in)

- Live tests against real Lightsail or real forums live in `test/integration/`, are excluded from `npm test`, and run via `npm run test:integration` only when `COMMUNITY_HUB_INTEGRATION=1` is set.
- They must create resources under a unique throwaway environment name and destroy them on completion.
- They set `acmeStaging: true` to avoid Let's Encrypt production rate limits, and use a throwaway subdomain or zone. SES sandbox limits apply unless the account has production access.
