set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := false

# direnv owns the environment; this is the fallback when a recipe runs outside it.
metadata := env_var_or_default("COMMUNITY_HUB_METADATA", "metadata/example.yaml")

# Default recipe: list everything.
_default:
    @just --list

# --- Setup ---------------------------------------------------------------

# Install Node dependencies and git hooks.
setup:
    npm ci
    lefthook install

# --- Build, lint, format, test ------------------------------------------

# Type-check and compile.
build:
    npm run build

# ESLint and Prettier check.
lint:
    npm run lint

# Format: Prettier on everything, shfmt on tracked shell scripts.
fmt:
    npm run format
    files=$(git ls-files '*.sh'); if [ -n "$files" ]; then echo "$files" | xargs shfmt -w; else echo "fmt: no shell scripts to format"; fi

# Run the unit test suite (no AWS, no network).
test:
    npm test

# Render engine user data and shellcheck it. Succeeds when nothing is rendered yet.
shellcheck:
    #!/usr/bin/env bash
    set -euo pipefail
    npm run render:user-data
    shopt -s nullglob
    files=(cdk.out/user-data/*.sh)
    if [ ${#files[@]} -eq 0 ]; then
      echo "shellcheck: no rendered user-data scripts yet"
    else
      shellcheck "${files[@]}"
    fi

# Secret scan of the working tree.
secrets-scan:
    gitleaks detect --redact

# The full gate: what pre-push and CI run.
check: build lint test shellcheck secrets-scan

# --- Metadata ------------------------------------------------------------

# Validate a metadata file and print any issues.
validate metadata=metadata:
    npm run validate -- {{ metadata }}

# --- CDK -----------------------------------------------------------------

# Synthesize the CloudFormation templates for a metadata file.
synth metadata=metadata: build
    npx cdk synth -c metadata={{ metadata }}

# Show the CDK diff for a metadata file.
diff metadata=metadata: build
    npx cdk diff -c metadata={{ metadata }}

# Bootstrap CDK in the target account and region (run once).
bootstrap metadata=metadata: build (_show-target metadata) (_bootstrap metadata)

[confirm("Bootstrap CDK in the account/region shown above?")]
_bootstrap metadata=metadata:
    npx cdk bootstrap -c metadata={{ metadata }}

# Deploy an environment. Writes outputs to cdk.out/outputs.json.
deploy metadata=metadata: build (_show-target metadata) (_deploy metadata)

[confirm("Deploy to the account/region shown above?")]
_deploy metadata=metadata:
    npx cdk deploy -c metadata={{ metadata }} --outputs-file cdk.out/outputs.json

# Destroy an environment (a final manual snapshot is kept by the lifecycle resource).
destroy metadata=metadata: build (_show-target metadata) (_destroy metadata)

[confirm("Destroy the environment in the account/region shown above?")]
_destroy metadata=metadata:
    npx cdk destroy -c metadata={{ metadata }}

# Pretty-print the last deploy's outputs.
outputs:
    jq . cdk.out/outputs.json

# --- Seeder --------------------------------------------------------------

# Seed forum configuration. Pass forum="id" to limit to one forum.
seed metadata=metadata forum="": build
    npm run seed -- --metadata {{ metadata }} {{ if forum != "" { "--forum " + forum } else { "" } }}

# Dry-run the seeder: plan only, no mutations.
seed-dry metadata=metadata forum="": build
    npm run seed -- --metadata {{ metadata }} {{ if forum != "" { "--forum " + forum } else { "" } }} --dry-run

# --- Operations (interactive, human-only) --------------------------------

# Open an SSM session to a forum's managed node.
ssm forum metadata=metadata:
    aws ssm start-session --target "$(just _node-id {{ metadata }} {{ forum }})"

# Tail the install log on a forum's node. Pass follow=1 for a live tail (interactive).
install-log forum metadata=metadata follow="":
    #!/usr/bin/env bash
    set -euo pipefail
    node="$(just _node-id {{ metadata }} {{ forum }})"
    if [ -n "{{ follow }}" ]; then
      cmd="tail -n 200 -f /var/log/community-hub/install.log"
    else
      cmd="tail -n 200 /var/log/community-hub/install.log"
    fi
    aws ssm start-session \
      --target "$node" \
      --document-name AWS-StartInteractiveCommand \
      --parameters "command=[\"$cmd\"]"

# --- Integration tests (opt-in, create real resources) -------------------

test-integration metadata=metadata: (_show-target metadata) (_test-integration)

[confirm("Run integration tests that create real AWS resources?")]
_test-integration:
    COMMUNITY_HUB_INTEGRATION=1 npm run test:integration

# --- Private helpers -----------------------------------------------------

# Print the AWS account, region and metadata file before a confirm prompt.
_show-target metadata=metadata:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "AWS account: $(aws sts get-caller-identity --query Account --output text)"
    echo "Region:      ${AWS_REGION:-${AWS_DEFAULT_REGION:-unset}}"
    echo "Metadata:    {{ metadata }}"

# Resolve a forum's managed node id by environment and forum tags.
_node-id metadata forum:
    #!/usr/bin/env bash
    set -euo pipefail
    env_name="$(yq -r '.environment.name' "{{ metadata }}")"
    aws ssm describe-instance-information \
      --filters "Key=tag:community-hub:environment,Values=${env_name}" "Key=tag:community-hub:forum,Values={{ forum }}" \
      --query 'InstanceInformationList[0].InstanceId' \
      --output text
