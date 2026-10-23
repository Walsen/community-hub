# Implementation Plan: Lightsail Forum Platform

## Overview

TypeScript (AWS CDK) implementation, built bottom-up: pure foundations first (shared errors, logger redaction, HTTP, Secret_References, bundles, schema, loader, engine contract), then the Seeder, then the Discourse and Flarum adapters, then pure infra builders (naming, firewall, IAM, TLS, SES, DNS, user data), then Lambda handlers with injected fake SDK clients, then CDK constructs and the `EnvironmentStack`, and finally the entry points, README and opt-in integration scaffolding. Task 1 also sets up the Devbox/direnv/just/lefthook/CI toolchain, so from then on every checkpoint runs `just check` (build, lint, test, shellcheck, secrets scan), the same gate the pre-push hook and CI use. Every module is wired into a caller by the end of its section.

Conventions for every task: follow the steering docs (`architecture`, `engineering-practices`, `testing`, `data-model`, `dev-environment`). Run commands through `just` recipes (or the npm scripts they call), never global installs. That means strict TypeScript, no `any`, Zod at boundaries, injected dependencies, typed errors, TSDoc on exports, no secret values in logs, templates, outputs, tags or user data, and tests under `test/` mirroring `src/` with placeholder secrets only.

## Tasks

- [ ] 1. Scaffold the project
  - [ ] 1.1 Create the greenfield TypeScript CDK project skeleton
    - `package.json` with `"engines": { "node": ">=22 <23" }`, `.nvmrc` (`22`), `.npmrc` with `save-exact=true`; scripts `build` (`tsc --noEmit -p tsconfig.json && tsc -p tsconfig.build.json`), `lint` (`eslint . && prettier --check .`), `format`, `test` (`vitest --run`), `test:integration` (`vitest --run --config vitest.integration.config.ts`), `seed` (`node dist/bin/seed.js`); `bin` entry for the seed CLI
    - Install with exact pinned versions only (no `^`/`~`), commit `package-lock.json`: runtime `aws-cdk-lib`, `constructs`, `zod`, `yaml`, `commander`, `@aws-sdk/client-ssm`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-lightsail`, `@aws-sdk/client-iam`; dev `typescript`, `@types/node` (exact pinned `22.x.y` version, on the Node 22 line matching `engines`), `eslint`, `typescript-eslint`, `prettier`, `vitest`, `fast-check`, `esbuild`, `aws-cdk`. Add nothing else
    - `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `target`/`lib` ES2023, `module`/`moduleResolution` `NodeNext`, includes `bin`, `src`, `test`; `tsconfig.build.json` emitting `bin` and `src` to `dist/`
    - `eslint.config.mjs` (flat config) with `typescript-eslint` `recommendedTypeChecked` and `parserOptions.projectService`, `@typescript-eslint/no-explicit-any: error`; `.prettierrc`, `.prettierignore` (`dist`, `cdk.out`, `node_modules`, `package-lock.json`)
    - `vitest.config.ts` (`test/**/*.test.ts`, excludes `test/integration/**`); `vitest.integration.config.ts` (`test/integration/**/*.test.ts`)
    - `cdk.json` with `"app": "npx tsc -p tsconfig.build.json && node dist/bin/app.js"` (no ts-node), documenting `npx cdk synth -c metadata=metadata/example.yaml`; `.gitignore` (`node_modules`, `dist`, `cdk.out`)
    - Create the directory skeleton from the design layout (`bin/`, `src/{metadata,engines,infra,seeder,shared}`, `test/support`, `test/integration`, `metadata/`) and one smoke test so `npm run build`, `npm run lint` and `npm test` pass
    - _Requirements: 10.4_

  - [ ] 1.2 Set up the Devbox dev environment, justfile, git hooks and CI
    - `devbox.json`: packages `nodejs`, `just`, `jq`, `yq-go`, `awscli2`, `ssm-session-manager-plugin`, `shellcheck`, `shfmt`, `gitleaks`, `lefthook`, each pinned to an explicit full version (no `@latest`; Node on the 22 line consistent with `.nvmrc` and `engines`); a minimal `shell.init_hook`; generate and commit `devbox.lock` with `devbox install`. If Devbox is not available in the agent environment, stop and ask the user to generate the lock file. Adding any package beyond this list needs user approval
    - `.envrc` exactly as in the dev-environment steering (`devbox generate direnv --print-envrc`, `dotenv_if_exists .env.local`, `COMMUNITY_HUB_METADATA` default `metadata/example.yaml`); no secrets. Append `.env.local`, `.devbox` and `.direnv` to `.gitignore` (and `.devbox` to `.prettierignore`). No committed `.env.local.example`: add a short "Local settings" subsection to the existing `README.md` with the non-secret `.env.local` example and `aws sso login --profile "$AWS_PROFILE"`
    - `justfile` with `set shell := ["bash", "-euo", "pipefail", "-c"]`, `set dotenv-load := false`, a default recipe that runs `just --list`, `metadata` parameters defaulting to `env_var_or_default("COMMUNITY_HUB_METADATA", "metadata/example.yaml")`, and recipes that call npm scripts instead of duplicating their logic:
      - Functional now: `setup` (`npm ci`, `lefthook install`), `build`, `lint`, `fmt` (`npm run format` + `shfmt -w` on `git ls-files '*.sh'`, skipping when empty), `test`, `secrets-scan` (`gitleaks detect --redact`), `check` (`build`, `lint`, `test`, `shellcheck`, `secrets-scan` in that order)
      - `shellcheck`: `npm run render:user-data`, then `shellcheck` on `cdk.out/user-data/*.sh`, printing a message and succeeding when no files were rendered. Add `render:user-data` to `package.json` now as a placeholder that prints `user data renderer not implemented yet (task 16.7)` and exits 0, so `just check` passes from this task on; task 16.7 replaces it
      - Functional later: `validate metadata` (`npm run validate`, task 21.10); `synth`/`diff metadata` (`npx cdk synth`/`diff -c metadata=<file>`), `bootstrap`, `deploy metadata` (`--outputs-file cdk.out/outputs.json`), `destroy metadata` and `outputs` (`jq` on `cdk.out/outputs.json`) after `bin/app.ts` (task 21.1); `seed metadata forum=""` and `seed-dry` (`npm run seed -- --metadata … [--forum …] [--dry-run]`) after task 21.2; `ssm forum` and `install-log forum` (look up the managed node by `community-hub:environment` from `yq '.environment.name'` and `community-hub:forum` tags; `install-log` runs `tail -n 200` without `-f` unless a `follow` parameter is set) once an Environment is deployed; `test-integration` (`COMMUNITY_HUB_INTEGRATION=1 npm run test:integration`) after task 21.8. Recipes that need compiled output depend on `build`
      - `bootstrap`, `deploy`, `destroy` and `test-integration` carry `[confirm]` and print the AWS account (`aws sts get-caller-identity`), region and metadata file before the prompt (verify the ordering with the pinned `just` version, for example via a private `_target` dependency). `ssm` and a `follow`ed `install-log` are interactive and for humans only; no recipe used by `check` starts a long-running or watch-mode command
    - `lefthook.yml`: `pre-commit` runs `gitleaks protect --staged --redact`, `prettier --check` and `eslint` on staged files, and `shfmt -d` on staged `*.sh`; `pre-push` runs `just check`
    - `.github/workflows/ci.yml`: on `push` and `pull_request`, `permissions: contents: read`, no AWS credentials, never deploys; `actions/checkout` and `jetify-com/devbox-install-action` pinned by full commit SHA (release tag in a trailing comment), checkout with `fetch-depth: 0` for gitleaks; steps `devbox run -- npm ci` then `devbox run -- just check`
    - Verify `just check` passes locally
    - _Requirements: 10.3, 10.4_

- [ ] 2. Shared foundations: errors, logger redaction, HTTP client
  - [ ] 2.1 Implement typed errors in `src/shared/errors.ts`
    - `SecretResolutionError` (`reference`, `reason`), `ForumApiError` (`forumId`, `method`, `path`, `status`, `apiMessage` truncated to 500 chars, `attempts`), `ForumUnreachableError` (`forumId`, `url`, `cause` code), `UnknownEngineError` (`engineId`, `known`), `UnknownForumError`, `SesCredentialError` (`forumId`, `operation`, AWS error `name` only), `HostedZoneMismatchError` (`declaredId`, `lookedUpId`, `rootDomain`)
    - Messages contain identifiers only, never secret values or response bodies beyond `apiMessage`
    - _Requirements: 2.4, 9.5, 12.6_

  - [ ] 2.2 Implement `src/shared/logger.ts` with `Redactor`
    - JSON-lines logger writing to an injected sink; `Redactor` replaces values of keys matching `/password|secret|token|api[-_]?key|authorization|activation[-_]?code/i` and any registered secret value appearing as a substring of any string field with `[REDACTED]`
    - _Requirements: 2.5, 11.9_

  - [ ] 2.3 Write unit tests for logger redaction
    - Key-based redaction at any depth, registered-value substring redaction, non-secret fields untouched
    - _Requirements: 2.5_

  - [ ] 2.4 Implement the HTTPS-only client in `src/shared/http.ts`
    - `createHttpClient({ fetch, sleep, timeoutMs, maxAttempts, baseDelayMs, maxDelayMs })`: reject non-`https:` URLs before any call, `AbortSignal.timeout`, `redirect: 'error'`, JSON parsing, 429 retry with delay `min(maxDelayMs, max(retryAfterMs, baseDelayMs * 2^(attempt-1)))` up to 5 attempts, network/DNS/TLS/timeout errors to `ForumUnreachableError`, other non-2xx to `ForumApiError` without retry; never logs request bodies or headers
    - _Requirements: 9.7, 9.8_

  - [ ]* 2.5 Write property test for 429 retry with exponential backoff
    - **Property 21: 429 retry with exponential backoff**
    - **Validates: Requirements 9.7**

  - [ ]* 2.6 Write unit tests for the HTTP client
    - Non-https rejected with zero fetch calls; timeout maps to `ForumUnreachableError`; 5xx not retried; redirects rejected
    - _Requirements: 9.7, 9.8_

- [ ] 3. Metadata primitives: Secret_Reference, bundles, schema, mail rules, secret resolver
  - [ ] 3.1 Implement `src/metadata/secret-ref.ts`
    - `SecretReference` type, `parseSecretReference` (SSM and Secrets Manager regexes, returns `undefined`, never echoes input), `formatSecretReference`, `secretName`, and `secretRefSchema` with a static error message
    - _Requirements: 2.1, 2.2_

  - [ ]* 3.2 Write property test for Secret_Reference round trip
    - **Property 4: Secret_Reference round trip**
    - **Validates: Requirements 2.1**

  - [ ] 3.3 Implement the Lightsail bundle table in `src/metadata/bundles.ts`
    - `LIGHTSAIL_BUNDLES` (`nano_3_0` … `2xlarge_3_0` with RAM in MB) and `bundleRamMb()`
    - _Requirements: 4.5_

  - [ ] 3.4 Implement `src/metadata/errors.ts`
    - `ValidationIssue { path, message }`, `formatPath()` (`forums[1].secrets.adminPassword`), and `MetadataValidationError` carrying issues sorted by path, with a message that lists paths and reasons only
    - _Requirements: 1.4, 2.2_

  - [ ] 3.5 Implement `src/metadata/schema.ts` and `src/metadata/mail.ts`
    - Zod `EnvironmentSchema`, `ForumConfigSchema`, `ForumSchema`, `RawMetadataSchema` exactly as in the design (strict objects everywhere, `dnsMode` enum, `hostedZoneId` regex, `acmeStaging`, `snapshotTimeUtc` `HH:00` default `06:00`, `dmarcPolicy` default `none`, `credentialRotation` default 0, forum id `^[a-z][a-z0-9]{0,19}$`, env name regex, IPv4 CIDR refinement)
    - `mail.ts` (pure): `checkMail` (mail domain equals or is under root domain, sender local part or full address on Mail_Domain, unique expanded senders), `checkDns` (`hostedZoneId` present iff `route53-existing`, issues at `environment.hostedZoneId`), `expandMail` transform (`mailDomain ??= rootDomain`, lowercase full sender address), and `sesSettings(environment, forum)` returning host `email-smtp.<region>.amazonaws.com`, port 587, sender and the two `ses-smtp-*` parameter names
    - Compose `MetadataSchema` with `.superRefine(checkMail).superRefine(checkDns).transform(expandMail)`; export `ValidatedModel`, `EnvironmentModel`, `ForumModel` via `z.output` (no hand-written duplicates)
    - _Requirements: 1.1, 1.2, 1.9, 1.10, 1.11, 2.1, 4.7, 11.5, 11.6, 12.1, 12.2, 12.3, 12.4_

  - [ ] 3.6 Implement `src/shared/secrets.ts`
    - `createAwsSecretResolver({ ssm, secretsManager, redactor })`: `GetParameter` with decryption or `GetSecretValue` (`SecretString` required), per-run cache, registers each value with the redactor before returning, maps not-found, access-denied, empty and other errors to `SecretResolutionError` naming the reference
    - _Requirements: 2.3, 2.4, 2.5_

  - [ ]* 3.7 Write unit tests for the secret resolver with fake SDK clients
    - Store dispatch, `WithDecryption: true`, error mapping includes the reference name and never the value, caching, redactor registration
    - _Requirements: 2.3, 2.4_

- [ ] 4. Engine contract and registry
  - [ ] 4.1 Define seeder domain types and the engine plugin contract
    - `src/seeder/types.ts`: `ResourceType`, `RESOURCE_TYPE_ORDER`, `SeedResource`, `FieldDiff`, `PlanAction`, `CreateAction`, `UpdateAction`, `ForumPlan`, `ActionResult`, `RunSummary`, `ResourceKey`, `ActualState` per the data-model steering and design
    - `src/engines/engine-adapter.ts`: `ForumSecretName`, `InstallScriptInput`, `TlsSupport`, `EngineAdapter`, `SeedSupport`, `SeedClientDeps`, `ApplyContext`, `SeedClient`, `ResourceHandler`, `MembershipHandler`, `SeedHandlers`
    - _Requirements: 7.1, 13.2_

  - [ ] 4.2 Implement `src/engines/registry.ts` and `src/engines/seed-client.ts`
    - `EngineRegistry` (constructor throws on duplicate id, `resolve` throws `UnknownEngineError`, `has`, `ids`); `createDefaultRegistry()` is added in task 12.1
    - `composeSeedClient(probe, handlers)`: `supportedTypes` = handler keys, `readActual` builds `ActualState` with `GET`-only handler reads, `apply` dispatches by resource type (membership `member: false` maps to `remove`)
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ] 4.3 Create the fake `testengine` adapter in `test/support/testengine.ts`
    - Implements the full `EngineAdapter` contract with `tls.dns01: false`, a reduced `supportedTypes` set, trivial install and email-refresh scripts, and a seed client backed by the in-memory fake forum (added in 7.3, accepted here as an injected `SeedClient` factory)
    - _Requirements: 7.3, 7.4, 13.4_

  - [ ] 4.4 Write unit tests for the Engine_Registry and `composeSeedClient`
    - Resolve known engines; unknown engine throws `UnknownEngineError` listing known ids; duplicate registration throws; `supportedTypes` reflects handlers; dispatch per type; membership add/remove
    - _Requirements: 7.2, 10.4_

- [ ] 5. Metadata_Loader
  - [ ] 5.1 Implement cross-field and adapter validation in `src/metadata/validate.ts`
    - Duplicate forum ids and subdomains (message names the value); Secret_Reference prefix `/community-hub/<env>/<forumId>/` for both stores; reserved `ses-smtp-password`/`ses-smtp-username` rejected; group members and trust-level references must be declared users or groups; SSH CIDRs with `/0` rejected
    - Per forum: `registry.has/resolve` (unknown engine issue at `forums[i].engine` naming the id), `engineOptionsSchema` issues prefixed with `forums[i].engineOptions`, `requiredSecrets` presence, bundle check (unknown id lists known ids; too small states `<min> MB`), and `adapter.validate()`
    - _Requirements: 1.5, 1.6, 2.2, 4.5, 7.3_

  - [ ] 5.2 Implement `src/metadata/loader.ts`
    - `loadMetadata(text, registry)`: `yaml.parseDocument(text, { uniqueKeys: true })` with parse errors reported as `<code> at line L, column C` without source text; `MetadataSchema.safeParse` with Zod issues mapped to `ValidationIssue` and value-bearing fields dropped; `validateCrossField`; all issues collected, sorted and thrown as one `MetadataValidationError`; result deep-frozen; no clock, randomness or environment reads
    - `loadMetadataFile(path, registry)`: the only YAML file read in the codebase
    - _Requirements: 1.3, 1.4, 1.7, 2.2_

  - [ ] 5.3 Write unit tests for the Metadata_Loader
    - Fixtures under `test/fixtures/metadata/` using the `testengine` registry; valid document parses; one test per schema error path (unknown keys incl. a legacy `smtp` block, `dnsMode: lightsail`, bad snapshot hour, bad CIDR, bad `dmarcPolicy`); duplicate id and subdomain; unknown engine; inline secret rejected without echoing the value; prefix rule; reserved `ses-smtp-*` names; bundle unknown and too small; mail domain outside root domain; sender domain mismatch names both domains; local part expansion; duplicate expanded senders; `hostedZoneId` required, forbidden and malformed; defaults (`dmarcPolicy: none`, `acmeStaging: false`, `snapshotTimeUtc: 06:00`); YAML parse error omits source text; model is frozen and deterministic
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.9, 1.10, 1.11, 2.2, 4.5, 11.6, 12.2, 12.3, 12.4, 10.4_

  - [ ]* 5.4 Write property test for metadata load round trip and determinism
    - Create `test/support/arbitraries.ts` (valid raw documents with 1–4 forums, forum configs, placeholder secret values)
    - **Property 1: Metadata load round trip and determinism**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.7, 1.8**

  - [ ]* 5.5 Write property test for validation issue paths
    - **Property 2: Validation issues carry the mutated field path**
    - **Validates: Requirements 1.4, 1.6, 11.6**

  - [ ]* 5.6 Write property test for duplicate ids and subdomains
    - **Property 3: Duplicate forum ids and subdomains are rejected**
    - **Validates: Requirements 1.5**

  - [ ]* 5.7 Write property test for inline secret rejection
    - **Property 5: Inline secrets are rejected without echoing the value**
    - **Validates: Requirements 2.2**

  - [ ]* 5.8 Write property test for minimum RAM enforcement
    - **Property 6: Minimum RAM enforcement**
    - **Validates: Requirements 4.5**

  - [ ]* 5.9 Write property test for mail domain and sender validation
    - **Property 27: Mail domain and sender validation**
    - **Validates: Requirements 1.9, 1.10, 1.11**

  - [ ]* 5.10 Write property test for Hosted_Zone_ID metadata rules
    - **Property 29: Hosted_Zone_ID metadata rules**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

- [ ] 6. Checkpoint - foundations and loader
  - Run `just check` (build, lint, test, shellcheck, secrets scan). Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Seeder core: desired state and reconciler
  - [ ] 7.1 Implement `src/seeder/normalize.ts` and `src/seeder/desired.ts`
    - Normalizers (trim, lowercase slugs/usernames/emails, color uppercase without `#`, sorted membership lists) shared with adapters
    - `buildDesired(forum)`: settings, groups, categories, users (with write-only `initialPassword` reference), memberships `"<group>:<username>"`, trust levels; `WRITE_ONLY_FIELDS`
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.7, 9.2_

  - [ ] 7.2 Implement the pure reconciler in `src/seeder/reconciler.ts`
    - `plan({ forumId, engineId, supportedTypes, desired, actual })`: unsupported types become `skip` with reason naming type and engine; create/update/noop by Natural_Key comparing only declared, non-write-only fields; authoritative membership for declared groups (extra members become `update` with `member: true -> false`); never deletes; sorted by `RESOURCE_TYPE_ORDER` then natural key
    - _Requirements: 7.4, 8.2, 8.3, 8.4, 8.7, 8.8, 8.10, 9.1, 9.2_

  - [ ] 7.3 Create seeder test fakes
    - `test/support/fake-forum.ts`: in-memory forum implementing `SeedClient` with configurable `supportedTypes`, call log (method, type, key) and failure injection by natural key
    - `test/support/fake-http.ts`: scripted responses, recorded requests, fake `sleep` recording delays
    - `test/support/seed-arbitraries.ts`: desired states and actual states including undeclared entities and extra group members
    - _Requirements: 10.4_

  - [ ] 7.4 Write unit tests for `buildDesired` and the reconciler
    - Normalization examples; write-only fields never diffed; undeclared attributes never cause updates; membership removal shape; unsupported type skip reason; ordering
    - _Requirements: 7.4, 8.2, 8.3, 8.4, 8.8, 8.10, 9.2, 10.4_

  - [ ]* 7.5 Write property test for unsupported resource types
    - **Property 10: Unsupported resource types are skipped and reported**
    - **Validates: Requirements 7.4**

  - [ ]* 7.6 Write property test for dependency order
    - **Property 11: Plans are in dependency order**
    - **Validates: Requirements 8.8**

  - [ ]* 7.7 Write property test for idempotency
    - **Property 13: Idempotency (Core 1)**
    - **Validates: Requirements 9.1, 9.2**

  - [ ]* 7.8 Write property test for no collateral changes
    - **Property 14: No collateral changes (Core 2)**
    - **Validates: Requirements 8.10**

  - [ ]* 7.9 Write property test for convergence
    - **Property 15: Convergence (Core 3)**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.7**

- [ ] 8. Seeder execution, reporting and orchestration
  - [ ] 8.1 Implement `src/seeder/executor.ts`
    - `execute(plan, client, { secrets, randomPassword, logger })`: plan order; noop/skip make no call; continue on failure recording forum id, natural key and API message; dependents of failed groups/users fail with `dependency <type>:<key> failed` and no call; user creation resolves the password reference or uses `randomPassword()` (never logged) and the adapter triggers the password-reset email
    - _Requirements: 8.1, 8.8, 8.11, 9.5_

  - [ ] 8.2 Write unit tests for the executor
    - Dependency order; continue on failure; dependent failure without a call; password reference vs random password plus reset; noop issues no call
    - _Requirements: 8.8, 8.11, 9.5, 10.4_

  - [ ]* 8.3 Write property test for failure isolation
    - **Property 19: Failure isolation**
    - **Validates: Requirements 9.5**

  - [ ] 8.4 Implement `src/seeder/report.ts`
    - `summarize()`, `exitStatus()` (1 on any failure or unreachable forum, else 0), `formatReport()` listing created, updated, unchanged, skipped and failed per forum plus dry-run plan lines (type, natural key, diffed field names, no write-only values)
    - _Requirements: 9.3, 9.4, 9.6_

  - [ ]* 8.5 Write property test for summary counts and exit status
    - **Property 20: Summary counts and exit status**
    - **Validates: Requirements 9.4, 9.6**

  - [ ] 8.6 Implement `src/seeder/run.ts`
    - `runSeed({ model, registry, forumId?, dryRun, deps })`: forum selection (`UnknownForumError`); preflight resolution of every selected `apiKey` before any API call; per forum `createClient`, `probe` (unreachable recorded, continue), `transformDesired(buildDesired())`, `readActual`, `plan`; dry run stops after planning; otherwise resolve planned user password references and `execute`; returns summaries and report text
    - _Requirements: 2.3, 2.4, 7.3, 8.1, 8.9, 9.3, 9.4, 9.8_

  - [ ] 8.7 Write unit tests for `runSeed`
    - `--forum` filter; unknown forum; unreachable forum skipped while others continue; preflight secret failure before any HTTP call; dry-run report lines
    - _Requirements: 2.4, 8.9, 9.3, 9.8_

  - [ ]* 8.8 Write property test for dry-run purity
    - **Property 16: Dry-run purity (Core 4)**
    - **Validates: Requirements 9.3**

- [ ] 9. Checkpoint - seeder
  - Run `just check` (build, lint, test, shellcheck, secrets scan). Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Discourse Engine_Adapter
  - [ ] 10.1 Implement Discourse versions and install scripts
    - `src/engines/discourse/versions.ts`: pinned Docker Engine apt version, AWS CLI, SSM agent, `discourse_docker` commit SHA, Discourse tag
    - `src/engines/discourse/install-script.ts` (pure): `renderInstallScript` (clone and checkout pinned SHA idempotently; `app.yml` `0600` with `postgres`, `redis`, `web`, `web.ratelimited`, `web.ssl` templates and no `web.letsencrypt.ssl`; acme webroot volume and `run: replace` port-80 challenge location; `DISCOURSE_HOSTNAME`, `DISCOURSE_DEVELOPER_EMAILS`, SES env block with placeholders; write `refresh-email.sh` and its systemd unit, run `--no-restart`; `issue_certificate` before `./launcher rebuild app`; idempotent admin + API key `bootstrap.rb`, `write_secret` for the API key, `shred -u`; every failure via `fail`)
    - `renderEmailRefreshScript`: fetch both `ses-smtp-*` parameters to tmpfs, hash short-circuit, `python3` JSON-encoded substitution without argv, `./launcher destroy app && ./launcher start app` unless `--no-restart`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 11.10, 13.1, 13.12, 13.13, 13.14_

  - [ ] 10.2 Implement the Discourse seed client in `src/engines/discourse/seed-client.ts`
    - Handler map per the design endpoint table (settings, groups, categories via `/site.json`, users, paged memberships, trust levels), headers `Api-Key` and `Api-Username: system`, Zod response schemas, `moderators` grant/revoke moderation, system users excluded, `forgot_password` when no password reference; composed with `composeSeedClient`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.11_

  - [ ] 10.3 Implement `src/engines/discourse/adapter.ts` and `options.ts`
    - `id: 'discourse'`, `minRamMb: 2048`, `blueprintId: 'ubuntu_22_04'`, `requiredSecrets: ['adminPassword', 'apiKey']`, strict options schema (`adminUsername`, `version`), `validate` (reserved automatic groups, trust levels 0..4, `notification_email` rejected), `tls` (`dns01: true`, `ssl.crt`/`ssl.key` cert paths, `docker exec app sv reload nginx`, acme webroot), `transformDesired` (Discourse string encoding), wiring 10.1 and 10.2
    - _Requirements: 4.6, 5.3, 7.1, 7.5, 13.2_

  - [ ] 10.4 Write unit tests for the Discourse adapter
    - `validate` cases; install script snapshot and content (`set -euo pipefail`, ERR trap, log path, pinned versions, `write_secret` for the API key, `issue_certificate` precedes `./launcher rebuild app`, challenge `replace` hook, no secret values); refresh script hash short-circuit and `--no-restart`; seed client request shape per operation, response parsing and error mapping with fake HTTP
    - _Requirements: 4.6, 5.1, 5.2, 5.3, 5.5, 5.6, 8.5, 10.4, 13.13, 13.14_

- [ ] 11. Flarum Engine_Adapter
  - [ ] 11.1 Implement Flarum versions and install scripts
    - `src/engines/flarum/versions.ts`: pinned `composer`, `php`, `mysql`, `caddy` image tags and Flarum version
    - `src/engines/flarum/install-script.ts` (pure): `renderInstallScript` writes `Dockerfile`, `docker-compose.yml` (`app`, `db` with named `db-data` volume and healthcheck, `proxy` with read-only `/certs` and `/acme` mounts), `Caddyfile` (`auto_https off`, challenge handler, 308 redirect, static `tls` directive serving the host-issued certificate files from `/certs` per Req 13, reloaded after each renewal by the adapter's `caddy reload --force` command), `.env` `0600`; `docker compose up -d --build db app`; `php flarum install --file` from tmpfs; `refresh-email.sh` + unit; API key via `openssl rand`, stdin SQL, `write_secret`, `shred -u`; `issue_certificate` before `docker compose up -d proxy`
    - `renderEmailRefreshScript`: `mail_*` settings upsert via stdin SQL with `python3` escaping, `php flarum cache:clear`
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 11.10, 13.1, 13.12, 13.13, 13.14_

  - [ ] 11.2 Implement the Flarum seed client in `src/engines/flarum/seed-client.ts`
    - Handler map per the design table (allowlisted settings, groups, tags as categories, users with random password and `/api/forgot` when no reference, memberships via user group relationships), `Authorization: Token <key>`, Zod response schemas; no `trustLevel` handler
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7, 8.11_

  - [ ] 11.3 Implement `src/engines/flarum/adapter.ts` and `options.ts`
    - `id: 'flarum'`, `minRamMb: 1024`, `requiredSecrets` incl. `databasePassword`, strict options (`adminUsername`, `trustLevelGroups`, `version`), `validate` (mapping coverage with greatest key ≤ level, mapped groups declared or implicit Member, built-in groups rejected, settings allowlist excluding `mail_*`), `tls` (`dns01: true`, canonical cert paths mounted read-only into the Caddy proxy, `caddy reload --force` reload command so Caddy re-reads the renewed certificate, acme webroot), `transformDesired` rewriting `trustLevel` into `membership`, wiring 11.1 and 11.2
    - _Requirements: 6.3, 6.6, 7.1, 7.5, 8.6, 13.2_

  - [ ] 11.4 Write unit tests for the Flarum adapter
    - `validate` cases; install script snapshot; compose parsed with `yaml` (services, named volume, mounts, pinned tags); Caddyfile redirect, challenge handler and `tls` directive pointing at the host-issued cert paths; reload command matches `tls.reloadCommand`; `issue_certificate` precedes `docker compose up -d proxy`; refresh script SQL via stdin and `cache:clear`; seed client request shapes, parsing and errors with fake HTTP; trust-level transform examples
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 8.6, 10.4, 13.13, 13.14_

- [ ] 12. Default registry and engine properties
  - [ ] 12.1 Add `createDefaultRegistry()` to `src/engines/registry.ts`
    - The only importer of `engines/discourse` and `engines/flarum`; add a unit test asserting both ids resolve
    - _Requirements: 7.2, 7.5_

  - [ ]* 12.2 Write property test for install script content
    - **Property 9: Install scripts carry configuration and only references**
    - **Validates: Requirements 5.2, 6.6, 11.10**

  - [ ]* 12.3 Write property test for Flarum trust-level mapping
    - **Property 12: Flarum trust levels map to declared groups**
    - **Validates: Requirements 8.6**

  - [ ] 12.4 Create `metadata/example.yaml`
    - One Discourse (`main`, `medium_3_0`) and one Flarum (`dev`, `small_3_0`) forum, placeholder `ssm:` references, sender addresses, trust-level mapping with implicit Member and declared `veterans`; add a unit test that it loads with `createDefaultRegistry()`. Created here (rather than in 21.3) because `render:user-data` (16.7) and the `just validate`/`synth` defaults use it
    - _Requirements: 1.8_

- [ ] 13. Checkpoint - engine adapters
  - Run `just check` (build, lint, test, shellcheck, secrets scan). Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Infra pure builders: naming, firewall, TLS challenge and node policy
  - [ ] 14.1 Implement `src/infra/naming.ts`
    - `names` and `constructIds` exactly as in the design; length guards for IAM role and user names
    - _Requirements: 3.5, 3.6, 12.12_

  - [ ]* 14.2 Write property test for naming
    - **Property 8: Names are deterministic and injective across Environments**
    - **Validates: Requirements 3.5, 3.6**

  - [ ] 14.3 Implement `buildPortRules(cidrs)` in `src/infra/firewall.ts`
    - TCP 80/443 to `0.0.0.0/0` and `::/0`; TCP 22 only to declared CIDRs, omitted when empty
    - _Requirements: 4.4_

  - [ ]* 14.4 Write property test for firewall rules
    - **Property 7: Firewall rules**
    - **Validates: Requirements 4.4**

  - [ ] 14.5 Implement `src/infra/tls/challenge.ts` and `src/infra/tls/acme-policy.ts`
    - `selectChallenge(dnsMode, tls)`; `buildAcmeDnsStatements({ partition, zoneId, hostname, staticIp })` with exactly three statements: `route53:ChangeResourceRecordSets` on the zone scoped to `_acme-challenge.<hostname>` `TXT` (`ForAllValues:StringEquals` with `Null` guards), read-only `route53:ListResourceRecordSets` on the zone and `route53:GetChange` on `change/*`, all with `aws:SourceIp`; no `route53:ListHostedZones`/`ListHostedZonesByName` (lego gets the zone id via `AWS_HOSTED_ZONE_ID`)
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [ ] 14.6 Implement pure `buildNodePolicy()` in `src/infra/node-role.ts`
    - Trust policy for `ssm.amazonaws.com` with source account/ARN; agent core actions (no `AmazonSSMManagedInstanceCore`); read on the forum prefix; write only on the `apiKey` parameter or secret; `aws:SourceIp` on read/write; explicit `Deny` with `NotResource` the forum prefix; ACME statements merged only for `dns-01`
    - _Requirements: 2.6, 13.6, 13.7, 13.8_

  - [ ]* 14.7 Write unit tests for challenge selection and node policy
    - `selectChallenge` table; policy JSON snapshots for a DNS-01 and an HTTP-01 forum; DNS-01 Route 53 actions are exactly the scoped `ChangeResourceRecordSets`, `GetChange` and `ListResourceRecordSets`, with no `ListHostedZones*`; no `route53:` action for HTTP-01
    - _Requirements: 2.6, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [ ]* 14.8 Write property test for DNS-01 Route 53 permissions
    - **Property 33: DNS-01 Route 53 permissions cover only the forum's own challenge record**
    - **Validates: Requirements 13.6, 13.7, 10.5**

- [ ] 15. Infra pure builders: SES and DNS
  - [ ] 15.1 Implement `buildSesSenderPolicy()` in `src/infra/email/sender-policy.ts`
    - One allow statement for `ses:SendEmail`/`ses:SendRawEmail` on the identity and configuration-set ARNs, `StringEquals ses:FromAddress`, no wildcards
    - _Requirements: 11.7_

  - [ ]* 15.2 Write property test for the sender policy
    - **Property 23: Sender policy permits only the forum's own sender**
    - **Validates: Requirements 11.7**

  - [ ] 15.3 Implement `deriveSesSmtpPassword()` in `src/infra/email/smtp-password.ts`
    - HMAC-SHA256 chain with `node:crypto` only, `base64(0x04 || k5)`
    - _Requirements: 11.8_

  - [ ] 15.4 Write the fixed-vector unit test for SMTP password derivation
    - Pin the output for a placeholder key and region (an AWS-published vector if available, otherwise one produced with AWS's documented reference algorithm)
    - _Requirements: 11.8_

  - [ ]* 15.5 Write property test for SMTP password derivation
    - **Property 22: SES SMTP password derivation**
    - **Validates: Requirements 11.8**

  - [ ] 15.6 Implement `src/infra/email/email-dns-records.ts`
    - `EmailDnsRecord` union, `buildEmailDnsRecords()` (3 DKIM CNAMEs, MAIL FROM MX and SPF TXT, DMARC TXT with policy and `rua`, absolute names, fixed order) and `displayValue()`
    - _Requirements: 11.3, 11.4, 11.5_

  - [ ]* 15.7 Write unit tests for email DNS records
    - Record table per DMARC policy; `displayValue()` per type
    - _Requirements: 11.3, 11.4, 11.5_

  - [ ] 15.8 Implement `checkLookedUpZone()` in `src/infra/dns/zone-check.ts`
    - Strip `/hostedzone/`, accept `DUMMY`, otherwise throw `HostedZoneMismatchError` naming the declared id, the found id and the root domain, so synthesis stops before any DNS record is created
    - _Requirements: 12.5, 12.6_

  - [ ]* 15.9 Write unit tests for zone check
    - Equal ids with and without prefix; `DUMMY` accepted; mismatch message content
    - _Requirements: 12.6_

- [ ] 16. User data composition and TLS certificate manager
  - [ ] 16.1 Implement `src/infra/user-data/versions.ts` and `src/infra/user-data/prelude.ts`
    - lego version and `linux_amd64` SHA-256 pins; prelude bash: logging to `/var/log/community-hub/install.log`, `set +x`, ERR trap, `fail`, `umask 077`, swap, pinned Docker/Compose/AWS CLI/jq/SSM agent installs, `claim_and_register` against the broker, `fetch_secret`, `write_secret` (`file://`), `wait_for_dns`, step markers, self-copy to `/usr/local/sbin/community-hub-install`
    - _Requirements: 2.4, 2.6, 5.1, 5.6, 6.1, 6.7_

  - [ ] 16.2 Implement `renderTlsScript()` in `src/infra/user-data/tls.ts`
    - Pinned lego install with `sha256sum -c`; `/etc/community-hub/tls.env` (for DNS-01, `AWS_HOSTED_ZONE_ID=$CH_HOSTED_ZONE_ID` so lego never lists hosted zones); common and per-challenge flags; staging directory iff `acmeStaging`; `issue_certificate` with retry budgets per challenge and `fail` on exhaustion; `tls-deploy.sh` atomic installs to `certPaths` (`privkey` `0600`) and `reloadCommand` unless `--no-reload`; `tls-renew.sh` with `renew --days ${CH_TLS_RENEW_DAYS:-30}` and failure line in `install.log`; renew timer `00,12:00` with `RandomizedDelaySec=1h` and `Persistent=true`
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 13.7, 13.9, 13.10, 13.11, 13.12_

  - [ ] 16.3 Implement `src/infra/user-data/compose.ts`
    - `Fn.join` header (`CH_ENV`, `CH_FORUM`, `CH_REGION`, `CH_HOST`, broker URL token, `CH_HOSTED_ZONE_ID` only for DNS-01) + prelude + TLS section + adapter install script; builds `InstallScriptInput` with `sesSettings()` and references only; plain-string variant for tests
    - _Requirements: 2.5, 5.2, 6.6, 11.10, 13.3_

  - [ ] 16.4 Write unit tests for user data
    - TLS section snapshot per challenge and staging flag; renew failure path and hook-only file replacement; issuance failure calls `fail`; prelude contents; composed script under 16 KB for both engines; no `latest` tag, no unpinned image, no lego download without checksum; no secret values
    - _Requirements: 13.9, 13.10, 13.11, 13.12, 2.5_

  - [ ]* 16.5 Write property test for TLS rendering
    - **Property 32: TLS configuration rendering matches the adapter's declaration**
    - **Validates: Requirements 5.3, 6.3, 13.1, 13.3, 13.9, 13.10, 13.12**

  - [ ]* 16.6 Write property test for challenge selection and HTTP-01 isolation
    - **Property 34: Challenge selection, and no Route 53 access for HTTP-01 forums**
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5, 13.8**

  - [ ] 16.7 Implement the `render:user-data` script backing `just shellcheck`
    - Pure `renderAllUserData(model, registry)` in `src/infra/user-data/render.ts`: for each forum, the plain-string composed user data from 16.3 and the adapter's `renderEmailRefreshScript` output, with fixed placeholder tokens for deploy-time values (for example `https://broker.example.invalid/`, `Z0000000000PLACEHOLDER`); returns `{ fileName, script }[]` (`<forumId>.sh`, `<forumId>-refresh-email.sh`) in forum order; no I/O, no secret values
    - `bin/render-user-data.ts`: loads `$COMMUNITY_HUB_METADATA` or `metadata/example.yaml` with `loadMetadataFile` and `createDefaultRegistry()`, recreates `cdk.out/user-data/`, writes each script, prints the file list; validation errors go to stderr with exit 2
    - Replace the placeholder `render:user-data` npm script from 1.2 with `tsc -p tsconfig.build.json && node dist/bin/render-user-data.js`; `just shellcheck` (already part of `just check`) now lints real scripts. Fix any shellcheck findings in the prelude, TLS section and adapter scripts rather than disabling checks; any `# shellcheck disable=` needs a code and a reason comment
    - _Requirements: 5.6, 6.7, 10.4_

  - [ ] 16.8 Write the shellcheck test for rendered scripts
    - `test/infra/user-data/shellcheck.test.ts`: renders with `renderAllUserData` for `metadata/example.yaml` and pipes each script to `shellcheck -s bash -` via `spawnSync` stdin (no temp files); asserts exit 0 and reports findings per file
    - When `shellcheck` is not on `PATH`, skip with the message `shellcheck not found; run inside Devbox or use just shellcheck`, so `npm test` stays runnable without Devbox; when `CI=true`, fail instead of skipping
    - _Requirements: 5.6, 6.7, 10.4_

- [ ] 17. Checkpoint - infra pure builders
  - Run `just check` (build, lint, test, shellcheck, secrets scan). Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Lambda handlers with injected SDK clients
  - [ ] 18.1 Create fake SDK clients in `test/support/`
    - `fake-ssm.ts` (parameters with versions and labels, activations, managed nodes, command invocations), `fake-iam.ts` (two-key limit), `fake-lightsail.ts` (instance snapshots); all implement `Pick<Client, 'send'>`
    - _Requirements: 10.4_

  - [ ] 18.2 Implement `src/infra/handlers/bootstrap-broker.ts`
    - Factory taking SSM client, clock and logger; Zod body; generic 403/404/409; source IP check against `FORUMS`; single registration; delete prior unused activations; `CreateActivation` (limit 1, 1 h, tags); activation code registered with the redactor and never logged; exported `handler` built with real clients
    - _Requirements: 2.5, 2.6_

  - [ ] 18.3 Write unit tests for the bootstrap broker
    - IP mismatch 403, unknown forum 404, registered node 409, success shape, prior activations deleted, code absent from captured logs
    - _Requirements: 2.5, 2.6_

  - [ ] 18.4 Implement `src/infra/handlers/forum-lifecycle.ts`
    - `onEvent`/`isComplete`; on destroy or forum removal, delete takes a tagged final manual snapshot named by `names.finalSnapshot` before the instance is deleted, polls until available, deregisters nodes and deletes activations; the manual snapshot is never deleted and outlives the stack (Lightsail removes automatic snapshots with the instance); missing instance tolerated
    - _Requirements: 3.7, 4.9_

  - [ ]* 18.5 Write unit tests for the lifecycle handler
    - Snapshot name and tags, wait loop with injected sleep, missing instance succeeds, create/update no-op
    - _Requirements: 3.7, 4.9_

  - [ ] 18.6 Implement `src/infra/handlers/ses-smtp-credentials.ts`
    - Create/rotate/delete per the design: orphan cleanup and two-key failure, `CreateAccessKey`, `deriveSesSmtpPassword`, `PutParameter` SecureString without `KeyId` + `LabelParameterVersion`, username parameter; same-counter update makes no calls; delete keeps parameters owned by a newer key; physical id from `names.sesCredentialsPhysicalId`; `Data: { AccessKeyId }`, `NoEcho: true`; errors as `SesCredentialError` with operation and error name only
    - _Requirements: 11.8, 11.9, 11.15, 11.16, 11.17_

  - [ ] 18.7 Write unit tests for the SES credentials handler
    - Create, rotate, same-counter update, delete on removal vs after rotation, orphan cleanup, two-key failure message, SecureString without `KeyId`, label written, secret key and password absent from response, errors and logs
    - _Requirements: 11.8, 11.9, 11.15, 11.16, 11.17_

  - [ ] 18.8 Implement `src/infra/handlers/email-refresh.ts`
    - Create returns `initial`; update restores from label if needed, waits 10 s, finds the node, sends `refresh-email.sh` via `AWS-RunShellScript`, `isComplete` maps to `applied`/`failed`; `node-offline` when absent or not online; delete no-op; never fails the deploy because of the instance
    - _Requirements: 11.10, 11.15_

  - [ ]* 18.9 Write unit tests for the email refresh handler
    - `initial`, `node-offline`, `applied`, `failed` mapping; command line contains no secret; restore-from-label on rollback
    - _Requirements: 11.15_

  - [ ]* 18.10 Write property test for credential lifecycle invariants
    - **Property 25: Credential lifecycle invariants**
    - **Validates: Requirements 11.8, 11.15, 11.16, 11.17**

- [ ] 19. CDK constructs and EnvironmentStack
  - [ ] 19.1 Implement `src/infra/dns/environment-dns.ts` and `src/infra/dns/records.ts`
    - `EnvironmentDns`: `route53` creates `PublicHostedZone` (`DESTROY`, tagged) with `HostedZoneId` and comma-joined `HostedZoneNameServers` outputs; `route53-existing` uses `HostedZone.fromLookup` (public only) validated by `checkLookedUpZone` before any record is created, so an ID mismatch, or no public zone for the root domain (including private-only), stops synthesis with the root domain and lookup failure reported; no zone resource, `HostedZoneId` output; `external` none
    - `forumARecord()` and `emailRecords()` (exhaustive switch, TTL 300, `deleteExisting: false`, absolute names)
    - _Requirements: 3.2, 4.3, 10.2, 11.3, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.13_

  - [ ] 19.2 Implement the `BootstrapBroker` construct in `src/infra/bootstrap-broker.ts`
    - `NodejsFunction` (`nodejs22.x`) with function URL `authType: NONE` (flagged as unauthenticated at the HTTP layer in code comments and README), `FORUMS` env JSON, synth error beyond the env-var budget (~25 forums), least-privilege SSM and `iam:PassRole` with `iam:PassedToService`
    - _Requirements: 2.6_

  - [ ] 19.3 Implement `EnvironmentEmail` in `src/infra/email/environment-email.ts`
    - Email identity (Easy DKIM, MAIL FROM `mail.<Mail_Domain>` with `USE_DEFAULT_VALUE`, default configuration set), configuration set without `SuppressionOptions`, SNS topic, topic policy with `AWS:SourceAccount`/`AWS:SourceArn`, email subscription to `adminEmail`, bounce/complaint event destination depending on the topic policy; email records in Route53_Modes or the 18 `Email<id>Name/Type/Value` outputs in `external`; `EmailIdentityDomain`, `SmtpEndpoint`, `EmailEventTopicArn`, `SesSandboxReminder` outputs
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.11, 11.12, 11.13, 11.14_

  - [ ] 19.4 Implement `SesSender` in `src/infra/email/ses-sender.ts`
    - IAM user (`names.sesUser`, path), inline policy from `buildSesSenderPolicy`, `Credentials` custom resource (`UserName`, `Region`, `ParameterPrefix`, `RotationCounter`) and `Refresh` custom resource (`AccessKeyId` GetAtt) using shared providers
    - _Requirements: 11.7, 11.8, 11.15, 11.16, 11.17_

  - [ ] 19.5 Implement the node role construct and `ForumInstance` in `src/infra/forum-instance.ts`
    - Role construct in `node-role.ts` wrapping `buildNodePolicy`; `CfnInstance` (blueprint, bundle, composed user data, `buildPortRules`, AutoSnapshot add-on at `snapshotTimeUtc`), `CfnStaticIp` (untaggable, identified by its deterministic `${env}-${forumId}-ip` name rather than tags) attached with explicit dependency, `Dns/A` in Route53_Modes, `Lifecycle` custom resource depending on the instance, `Ses` sender with `Instance` depending on `Ses/Credentials`, `community-hub:forum` tag, outputs (`ForumId`, `Engine`, `Url`, `StaticIp`, `InstanceName`, `SenderAddress`, `TlsChallenge`, `EmailRefreshStatus`, and external-mode `DnsRecordName`/`DnsRecordValue`)
    - _Requirements: 2.6, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.7, 10.1, 11.14, 13.6, 13.8_

  - [ ] 19.6 Implement `EnvironmentStack` in `src/infra/environment-stack.ts`
    - Creates `Dns`, `BootstrapBroker`, `Email`, shared lifecycle, SES credentials and email refresh providers, then one `ForumInstance` per forum (`Forum-<id>`), resolving adapters only via the injected registry; `community-hub:environment` tag; no `crossRegionReferences`
    - _Requirements: 3.1, 3.4, 4.1, 7.3, 12.13_

  - [ ] 19.7 Write CDK assertion tests for forum resources
    - Discourse + Flarum fixture with bundling skipped in tests: one instance, static IP, node role per forum; port rules; deterministic names; AutoSnapshot with declared and default time; lifecycle depends on instance; node policy scoped to prefix with SourceIp and explicit deny, no `AmazonSSMManagedInstanceCore`; tags on all taggable resources; static IPs (untaggable) carry the Environment name and forum id in their deterministic names; record sets exempt; per-forum outputs
    - _Requirements: 3.4, 3.5, 4.1, 4.2, 4.4, 4.7, 10.1, 10.5_

  - [ ] 19.8 Write CDK assertion tests for SES resources
    - Email identity with DKIM and MAIL FROM, default configuration set; configuration set without `SuppressionOptions`; event destination bounce + complaint to topic; topic policy; admin subscription; one IAM user + inline policy + credentials custom resource per forum; `Instance` depends on `Ses/Credentials`; email outputs incl. sandbox reminder; DKIM records reference identity GetAtts
    - _Requirements: 10.5, 11.1, 11.2, 11.7, 11.11, 11.12, 11.14_

  - [ ] 19.9 Write CDK assertion and snapshot tests per DNS_Mode
    - `route53`: zone name, `DeletionPolicy: Delete`, `HostedZoneNameServers` `Fn::Join`; `route53-existing` with lookup context seeded via `ContextProvider.getKey`: no zone resource, records use the declared id, mismatch throws naming declared id, found id and root domain, `DUMMY` does not throw, `$providerError` (no public zone) fails synthesis naming the root domain; `external`: no `AWS::Route53::*`, A record and email outputs; TXT quoted once, DKIM names end with `.`; DNS-01 node statements present only for DNS-01 forums; template snapshot for a Discourse + Flarum Environment in each mode
    - _Requirements: 3.2, 3.3, 4.3, 10.2, 10.5, 11.3, 11.4, 12.5, 12.6, 12.7, 12.8, 12.13, 13.6, 13.7, 13.8_

  - [ ]* 19.10 Write property test for naming stability
    - **Property 18: Naming stability (Core 6)**
    - **Validates: Requirements 4.8, 4.9, 11.17**

  - [ ]* 19.11 Write property test for the email DNS record set by mode
    - **Property 24: Email DNS record set is complete and placed in Route 53 by DNS mode**
    - **Validates: Requirements 11.3, 11.4, 11.5**

  - [ ]* 19.12 Write property test for rotation counter isolation
    - **Property 26: Rotation counter isolation in the template**
    - **Validates: Requirements 11.15, 11.16**

  - [ ]* 19.13 Write property test for Route 53 placement by DNS mode
    - **Property 28: Route 53 resources are placed by DNS mode, and `route53-existing` never declares a hosted zone**
    - **Validates: Requirements 3.2, 3.3, 4.3, 10.2, 10.5, 12.8, 12.9, 12.10, 12.11, 12.13**

  - [ ]* 19.14 Write property test for hosted zone lookup validation
    - **Property 30: Hosted zone lookup validation precedes every record**
    - **Validates: Requirements 12.5, 12.6**

  - [ ]* 19.15 Write property test for per-forum record set isolation
    - **Property 31: Adding or removing a forum changes only that forum's record sets**
    - **Validates: Requirements 4.8, 4.9, 12.12**

- [ ] 20. Checkpoint - handlers and CDK stack
  - Run `just check` (build, lint, test, shellcheck, secrets scan). Ensure all tests pass, ask the user if questions arise.

- [ ] 21. Entry points, example metadata, README and integration scaffolding
  - [ ] 21.1 Implement `bin/app.ts`
    - Read `-c metadata=<path>`, `loadMetadataFile` with `createDefaultRegistry()`, one `EnvironmentStack` named `names.stack(env)` with `env: { account: CDK_DEFAULT_ACCOUNT, region }`; clear error when the account is unset in `route53-existing`; print issues to stderr and exit 2 on `MetadataValidationError` or `HostedZoneMismatchError`, exit 1 otherwise (including a failed hosted zone lookup at synth); stack traces only with `DEBUG=community-hub`
    - _Requirements: 1.4, 3.1, 12.6, 12.7_

  - [ ] 21.2 Implement the Seeder CLI in `bin/seed.ts`
    - `commander` with `--metadata`, `--forum`, `--dry-run`; real SSM/Secrets Manager clients, `createHttpClient` with global `fetch`, stderr logger with redactor, `crypto.randomBytes(24).toString('base64url')` passwords; print report to stdout; exit codes 0/1/2 per the design
    - _Requirements: 2.4, 8.1, 8.9, 9.3, 9.4, 9.6_

  - [ ] 21.3 Test `metadata/example.yaml` end to end
    - The example from 12.4 synthesizes an `EnvironmentStack` through the same path as `bin/app.ts`; update the example if later tasks added fields it should demonstrate
    - _Requirements: 1.8, 10.4_

  - [ ]* 21.4 Write unit tests for entry-point exit codes
    - `bin/app.ts` exits 2 on invalid metadata and zone mismatch; `bin/seed.ts` exits 2 on usage, unknown forum and secret failure, 1 on failed resources
    - _Requirements: 1.4, 2.4, 9.6, 12.6_

  - [ ] 21.5 Write the pluggability test with the `testengine` adapter
    - Register `testengine` alongside the defaults and run load, stack synthesis and a seed run against the fake forum without changes to core modules; HTTP-01 is selected for it in a Route53_Mode
    - _Requirements: 7.3, 7.4, 13.4, 10.4_

  - [ ]* 21.6 Write property test for secret hygiene
    - Cover synthesized templates (incl. resolved user data), outputs, tags, captured logs, dry-run and real seed CLI output, SES handler responses, errors and logs, and bootstrap broker logs and errors (activation code only in the 200 body)
    - **Property 17: Secret hygiene (Core 5)**
    - **Validates: Requirements 2.5, 11.9**

  - [ ] 21.7 Extend the existing `README.md` with operational sections
    - Edit in place; keep the existing overview, "What it does", "How it fits together", example metadata, prerequisites, project docs and GPL-3.0 license sections (update them only where they no longer match the implementation). Remove the "Status: design phase" note and rename "Getting started (planned)" to "Getting started", with commands verified against the justfile
    - Add the operational sections required by Req 10.3 and the design README section: prerequisites detail (Devbox + direnv, IAM Identity Center login, CDK bootstrap via `just bootstrap`, operator-registered root domain, SES region availability), dev environment (`direnv allow`, the `.env.local` example from 1.2, the recipe table from the justfile, git hooks, CI gate), DNS modes and registrar delegation, `route53-existing` with `hostedZoneId`, lookup and context cache, destroy recovery, TLS issuance/renewal and `acmeStaging`, Secret_Store setup and reserved `ses-smtp-*` names, metadata reference, `just validate`/`deploy`/`seed`/`seed-dry`/`destroy`/`outputs` with exit codes, external DNS steps, SES setup (SNS confirmation, production access, suppression list, DMARC `rua` authorization, one Mail_Domain per account and region), credential rotation and manual refresh, operating instances with `just ssm` and `just install-log`, broker endpoint security note (unauthenticated function URL guarded by source IP and single use), update limitations, adding an Engine_Adapter
    - _Requirements: 10.3, 11.13_

  - [ ] 21.8 Create opt-in integration test scaffolding in `test/integration/`
    - Guard that skips unless `COMMUNITY_HUB_INTEGRATION=1`; helpers to generate a throwaway `it-<random>` environment (one small Flarum forum, `acmeStaging: true`, `route53-existing` via `COMMUNITY_HUB_IT_ZONE_ID` else `external`), deploy and always destroy in `afterAll`, and delete the final snapshot; confirm `npm test` excludes it
    - _Requirements: 10.4_

  - [ ]* 21.9 Write opt-in integration tests
    - Broker claim and node scoping, API key written, HTTPS and HTTP redirect, DNS-01 issuance and conflicting-record failure in `route53-existing`, forced renewal, seed twice with zero mutations, SMTP auth, rotation `applied` with one key, post-destroy cleanup and retained snapshot
    - _Requirements: 3.7, 5.4, 6.4, 9.1, 11.15, 12.9, 13.10_

  - [ ] 21.10 Implement the metadata validation CLI backing `just validate`
    - `bin/validate.ts`: exports `main(argv, { stdout, stderr })` and runs it when invoked directly; takes the metadata path as a positional argument (default `$COMMUNITY_HUB_METADATA`, then `metadata/example.yaml`), calls `loadMetadataFile` with `createDefaultRegistry()`, prints `OK <path>: <n> forums` to stdout and exits 0, or prints each issue as `<field path>: <reason>` to stderr and exits 2 on `MetadataValidationError`, exit 1 on other errors; no AWS calls, no secret resolution, never prints field values
    - `package.json` script `validate` (`tsc -p tsconfig.build.json && node dist/bin/validate.js`); the `just validate metadata` recipe from 1.2 passes the path through
    - _Requirements: 1.3, 1.4_

  - [ ] 21.11 Write unit tests for the validation CLI
    - Call `main` with captured streams: the example file exits 0; an invalid fixture exits 2 and prints every field path sorted; an inline secret fixture never echoes its placeholder value; a YAML syntax error reports line and column without source text
    - _Requirements: 1.3, 1.4, 2.2_

- [ ] 22. Final checkpoint
  - Run `just check` (build, lint, test, shellcheck, secrets scan), `just validate metadata/example.yaml` and `just synth metadata/example.yaml`. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. All 34 design properties have their own optional sub-task.
- Required test tasks are the unit tests that Req 10.4 demands (loader, registry, each adapter, seeder reconciliation and execution, including the `runSeed` orchestration tests in 8.7) and the CDK assertion tests Req 10.5 demands (19.7–19.9). Also required are tests that guard security or correctness-critical code without other coverage: logger redaction (2.3), SMTP password fixed vector (15.4), user data pinning and size budget (16.4), broker (18.3) and SES credentials (18.7).
- `src/seeder/types.ts` holds the seeder domain types from the data-model steering. Typed errors other than `MetadataValidationError` live in `src/shared/errors.ts`.
- `@types/node` is approved as a dev dependency, pinned to an exact version on the Node 22 line (task 1.1).
- Requirements 5.4 and 6.4 (HTTPS served after install) and the runtime behaviour of 3.7 (final manual snapshot retained after destroy) and 12.9 can only be checked end to end. They are covered by the opt-in integration tests and by script and template assertions.
- Each task references specific requirements for traceability. From task 1.2 on, checkpoints run `just check`, the same gate as the pre-push hook and CI.
- Justfile recipes are all declared in 1.2 but become functional as their backing code lands: `shellcheck` lints real scripts after 16.7, `validate` after 21.10, `synth`/`diff`/`bootstrap`/`deploy`/`destroy`/`outputs` after 21.1, `seed`/`seed-dry` after 21.2, `test-integration` after 21.8, and `ssm`/`install-log` once an Environment is deployed.
- `metadata/example.yaml` is created in 12.4 (not 21.3) so `render:user-data` and the `just` defaults can use it. There is no committed `.env.local` example; the README documents it.
- The shellcheck test (16.8) skips with a clear message when `shellcheck` is not on `PATH`, so `npm test` runs without Devbox, and fails instead of skipping in CI.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "3.3", "3.4"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.2", "3.5"] },
    { "id": 3, "tasks": ["2.3", "2.5", "2.6", "3.6", "4.1"] },
    { "id": 4, "tasks": ["3.7", "4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "5.1"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["5.3", "5.4", "7.1"] },
    { "id": 8, "tasks": ["5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "7.2", "7.3"] },
    { "id": 9, "tasks": ["7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "8.1"] },
    { "id": 10, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 11, "tasks": ["8.5", "8.6"] },
    { "id": 12, "tasks": ["8.7", "8.8", "10.1", "10.2", "11.1", "11.2"] },
    { "id": 13, "tasks": ["10.3", "11.3"] },
    { "id": 14, "tasks": ["10.4", "11.4", "12.1"] },
    { "id": 15, "tasks": ["12.2", "12.3", "12.4", "14.1", "14.3", "14.5", "15.1", "15.3", "15.6", "15.8", "16.1"] },
    { "id": 16, "tasks": ["14.2", "14.4", "14.6", "15.2", "15.4", "15.5", "15.7", "15.9", "16.2"] },
    { "id": 17, "tasks": ["14.7", "14.8", "16.3"] },
    { "id": 18, "tasks": ["16.4", "16.5", "16.6", "16.7", "18.1"] },
    { "id": 19, "tasks": ["16.8", "18.2", "18.4", "18.6", "18.8"] },
    { "id": 20, "tasks": ["18.3", "18.5", "18.7", "18.9", "18.10", "19.1"] },
    { "id": 21, "tasks": ["19.2", "19.3"] },
    { "id": 22, "tasks": ["19.4"] },
    { "id": 23, "tasks": ["19.5"] },
    { "id": 24, "tasks": ["19.6"] },
    { "id": 25, "tasks": ["19.7", "19.8", "19.9", "19.10", "19.11", "19.12", "19.13", "19.14", "19.15"] },
    { "id": 26, "tasks": ["21.1", "21.2", "21.3", "21.8", "21.10"] },
    { "id": 27, "tasks": ["21.4", "21.5", "21.6", "21.7", "21.9", "21.11"] }
  ]
}
```
