---
inclusion: always
---

# Dev Environment

Every contributor and CI job uses the same toolchain through Devbox. Nothing is installed globally except Devbox and direnv. Project Node tooling (TypeScript, CDK CLI, ESLint, Vitest) comes from `package.json` and runs through `just` or `npx`, never from a global install.

## Files

| File | Committed | Purpose |
|---|---|---|
| `devbox.json` | yes | Pinned CLI packages, init hook, shell scripts |
| `devbox.lock` | yes | Exact Nix package resolutions |
| `.envrc` | yes | direnv entry: loads Devbox, then optional local overrides |
| `.env.local` | **no** (gitignored) | Per-developer non-secret settings (AWS profile, metadata path) |
| `justfile` | yes | The single command surface for humans, hooks and CI |
| `lefthook.yml` | yes | Git hooks |
| `.nvmrc` | yes | Node major for editors and tools outside Devbox |

## Devbox packages

Pin each package to an explicit version in `devbox.json` (no `@latest`) and commit `devbox.lock`. Bump versions in a dedicated `chore:` commit.

| Package | Why |
|---|---|
| `nodejs@22` | Runtime for CDK app, seeder and Lambda handlers (matches `nodejs22.x`) |
| `just` | Task runner |
| `jq` | Inspect CDK outputs and AWS CLI JSON |
| `yq-go` | Inspect and query metadata YAML |
| `awscli2` | AWS access, SSO login, SSM parameters, Lightsail checks |
| `ssm-session-manager-plugin` | Shell into forum instances through SSM (instances are hybrid managed nodes; no SSH needed) |
| `shellcheck`, `shfmt` | Lint and format generated user data and helper scripts |
| `gitleaks` | Secret scanning on commit and in CI |
| `lefthook` | Git hook manager |

direnv is a host prerequisite (it has to hook the shell before Devbox loads). Ask before adding packages; prefer Devbox packages over npm packages for CLI tools that are not imported by code.

## direnv

`.envrc`:

```bash
eval "$(devbox generate direnv --print-envrc)"
dotenv_if_exists .env.local
export COMMUNITY_HUB_METADATA="${COMMUNITY_HUB_METADATA:-metadata/example.yaml}"
```

`.env.local` (example, never committed):

```
AWS_PROFILE=community-hub-dev
AWS_REGION=us-east-1
COMMUNITY_HUB_METADATA=metadata/dev.yaml
```

- No secrets in `.envrc` or `.env.local`. Secret values live only in SSM Parameter Store or Secrets Manager.
- AWS auth uses IAM Identity Center: `aws sso login --profile "$AWS_PROFILE"`. No long-lived access keys on developer machines.
- Run `direnv allow` after any `.envrc` change.

## justfile

`just` with no arguments lists recipes. Recipes take `metadata` and `forum` parameters, defaulting to `$COMMUNITY_HUB_METADATA`. Recipe names:

| Recipe | Does |
|---|---|
| `setup` | `npm ci`, `lefthook install` |
| `build` / `lint` / `fmt` / `test` | `npm run build`, `npm run lint`, `prettier --write` + `shfmt -w`, `npm test` |
| `shellcheck` | Render all engine user data for the example metadata into `cdk.out/user-data/` and run `shellcheck` on it |
| `secrets-scan` | `gitleaks detect --redact` |
| `check` | `build`, `lint`, `test`, `shellcheck`, `secrets-scan`: the gate for pre-push and CI |
| `validate metadata` | Load and validate a metadata file, print issues |
| `synth metadata` / `diff metadata` | `npx cdk synth` / `npx cdk diff` with `-c metadata=<file>` |
| `bootstrap` | `npx cdk bootstrap` for the account and region (once) |
| `deploy metadata` | `npx cdk deploy --outputs-file cdk.out/outputs.json`; marked `[confirm]` |
| `destroy metadata` | `npx cdk destroy`; marked `[confirm]` |
| `outputs` | Pretty-print `cdk.out/outputs.json` with `jq` |
| `seed metadata forum=""` / `seed-dry ...` | Run the seeder, optionally for one forum, optionally `--dry-run` |
| `ssm forum` | `aws ssm start-session` to the forum's managed node (looked up by tag) |
| `install-log forum` | Tail `/var/log/community-hub/install.log` on the node through SSM |
| `test-integration` | `COMMUNITY_HUB_INTEGRATION=1 npm run test:integration`; marked `[confirm]` |

Rules:
- Use `set shell := ["bash", "-euo", "pipefail", "-c"]` and `set dotenv-load := false` (direnv owns the environment).
- Recipes that create, change or delete AWS resources carry `[confirm]` and print the account, region and metadata file first.
- Recipes call npm scripts rather than duplicating their logic, so `npm` and `just` never drift.
- Kiro and agents run the same recipes. Never start long-running or watch-mode commands from a recipe used by agents.

## Git hooks (lefthook)

- `pre-commit`: `gitleaks protect --staged --redact`, Prettier check and ESLint on staged files, `shfmt -d` on staged shell files.
- `pre-push`: `just check`.
- Do not bypass hooks with `--no-verify`.

## CI

CI installs Devbox (for example `jetify-com/devbox-install-action`, pinned by commit SHA) and runs `devbox run -- just check`. CI never deploys; deploys are operator-run with `just deploy`.
