/**
 * Pure renderer for every forum's user-data scripts, used by the
 * `render:user-data` entry point that backs `just shellcheck`.
 *
 * {@link renderAllUserData} walks a {@link ValidatedModel}, and for each forum
 * produces the plain-string install script ({@link composeInnerScript}) and the
 * adapter's email-refresh script. It renders the INNER install script, not the
 * gzip+base64 launch wrapper from `composeUserData`, so shellcheck lints the
 * real bash rather than an encoded payload.
 *
 * Deploy-time values that are CDK tokens at synth (the bootstrap broker URL and
 * the Route 53 hosted zone id) are substituted with fixed, obviously-fake
 * placeholders here. They are embedded verbatim and never validated, so a
 * placeholder renders a syntactically identical script for linting.
 *
 * This module is pure: it performs no I/O, reads no clock, randomness or
 * environment, and emits no secret values (the scripts carry Secret_References
 * only). The output is deterministic and ordered by `model.forums`.
 */

import { composeInnerScript } from './compose.js';
import { selectChallenge } from '../tls/challenge.js';
import { sesSettings } from '../../metadata/mail.js';
import type {
  EngineAdapter,
  ForumSecretName,
  InstallScriptInput,
} from '../../engines/engine-adapter.js';
import type { EngineRegistry } from '../../engines/registry.js';
import type { ForumModel, ValidatedModel } from '../../metadata/schema.js';
import type { SecretReference } from '../../metadata/secret-ref.js';

/**
 * Standalone header prepended to an email-refresh fragment when it is rendered
 * as its own file for linting.
 *
 * On the instance the fragment is embedded inside the install script, after the
 * shared prelude, so it inherits the prelude's shebang, `set -euo pipefail` and
 * helper functions (`fetch_secret`, `fail`). Written on its own it has none of
 * that, so shellcheck cannot know the target shell (SC2148). This minimal
 * header makes the standalone file valid bash without altering the fragment the
 * adapter embeds in the install script.
 */
const REFRESH_SCRIPT_HEADER = '#!/bin/bash\nset -euo pipefail\n';

/** Placeholder for the bootstrap broker URL, a CDK token at synth time. */
export const PLACEHOLDER_BROKER_URL = 'https://broker.example.invalid/';

/** Placeholder for the Route 53 hosted zone id, a CDK token at synth time. */
export const PLACEHOLDER_HOSTED_ZONE_ID = 'Z0000000000PLACEHOLDER';

/** A rendered user-data script and the file name it should be written to. */
export interface RenderedScript {
  /** Target file name, e.g. `main.sh` or `main-refresh-email.sh`. */
  readonly fileName: string;
  /** The plain-string bash script content. */
  readonly script: string;
}

/**
 * Narrow a forum's secret map to the engine's required Secret_References.
 *
 * `forum.secrets` is a validated `Record<string, SecretReference>`; the install
 * script input wants the known {@link ForumSecretName} keys. Only the engine's
 * required secrets are forwarded, which the loader has already guaranteed are
 * present.
 */
function pickSecrets(
  forum: ForumModel,
  required: readonly ForumSecretName[],
): Readonly<Partial<Record<ForumSecretName, SecretReference>>> {
  const picked: Partial<Record<ForumSecretName, SecretReference>> = {};
  for (const name of required) {
    const ref = forum.secrets[name];
    if (ref !== undefined) {
      picked[name] = ref;
    }
  }
  return picked;
}

/**
 * Build the {@link InstallScriptInput} an engine adapter consumes for a forum.
 * The hostname is `<subdomain>.<rootDomain>`; SES settings are derived; engine
 * options are validated by the adapter's schema; secrets are references only.
 */
function buildInstallInput(
  model: ValidatedModel,
  forum: ForumModel,
  adapter: EngineAdapter,
): InstallScriptInput {
  const { environment } = model;
  return {
    environmentName: environment.name,
    region: environment.region,
    forumId: forum.id,
    hostname: `${forum.subdomain}.${environment.rootDomain}`,
    adminEmail: environment.adminEmail,
    email: sesSettings(environment, forum),
    secrets: pickSecrets(forum, adapter.requiredSecrets),
    engineOptions: adapter.engineOptionsSchema.parse(forum.engineOptions),
  };
}

/**
 * Render the install and email-refresh scripts for every forum in the model.
 *
 * For each forum, in `model.forums` order, two scripts are produced: the
 * composed inner install script (`<forumId>.sh`) and the adapter's
 * email-refresh script (`<forumId>-refresh-email.sh`). The install script uses
 * {@link composeInnerScript} so the real, decoded bash is linted; CDK-token
 * deploy values are replaced with fixed placeholders.
 *
 * @param model - The validated, expanded metadata model.
 * @param registry - The Engine_Registry used to resolve each forum's adapter.
 * @returns The rendered scripts in forum order, install script before refresh
 *   script for each forum. Pure; no I/O and no secret values.
 */
export function renderAllUserData(
  model: ValidatedModel,
  registry: EngineRegistry,
): readonly RenderedScript[] {
  const scripts: RenderedScript[] = [];

  for (const forum of model.forums) {
    const adapter = registry.resolve(forum.engine);
    const input = buildInstallInput(model, forum, adapter);
    const challenge = selectChallenge(model.environment.dnsMode, adapter.tls);

    const installScript = composeInnerScript({
      env: model.environment.name,
      forumId: forum.id,
      region: model.environment.region,
      hostname: input.hostname,
      adminEmail: model.environment.adminEmail,
      brokerUrl: PLACEHOLDER_BROKER_URL,
      hostedZoneId: PLACEHOLDER_HOSTED_ZONE_ID,
      challenge,
      staging: model.environment.acmeStaging,
      tls: adapter.tls,
      adapterScript: adapter.renderInstallScript(input),
    });

    scripts.push({ fileName: `${forum.id}.sh`, script: installScript });
    scripts.push({
      fileName: `${forum.id}-refresh-email.sh`,
      script: REFRESH_SCRIPT_HEADER + adapter.renderEmailRefreshScript(input),
    });
  }

  return scripts;
}
