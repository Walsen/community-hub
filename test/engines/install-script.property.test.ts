import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { discourseAdapter } from '../../src/engines/discourse/adapter.js';
import {
  DISCOURSE_DOCKER_COMMIT,
  DISCOURSE_VERSION_TAG,
} from '../../src/engines/discourse/versions.js';
import type { EngineAdapter, InstallScriptInput } from '../../src/engines/engine-adapter.js';
import { flarumAdapter } from '../../src/engines/flarum/adapter.js';
import {
  CADDY_IMAGE_TAG,
  COMPOSER_IMAGE_TAG,
  FLARUM_VERSION,
  MYSQL_IMAGE_TAG,
  PHP_IMAGE_TAG,
} from '../../src/engines/flarum/versions.js';
import type { SesSettings } from '../../src/metadata/mail.js';
import type { SecretReference } from '../../src/metadata/secret-ref.js';
import { environmentName, forumId, rootDomain } from '../support/arbitraries.js';

/**
 * Property 9: Install scripts carry configuration and only references.
 *
 * Validates: Requirements 5.2, 6.6, 11.10; secret hygiene in user data.
 *
 * For BOTH engine adapters (`discourseAdapter`, `flarumAdapter`) and any valid
 * {@link InstallScriptInput}, the rendered install and email-refresh scripts:
 *
 *  - are non-empty and contain the hostname and admin email;
 *  - reference the adapter's pinned versions / image tags (a known pin appears);
 *  - wire the ACME HTTP-01 webroot (`/.well-known/acme-challenge/`) and call
 *    `issue_certificate` before the engine starts serving traffic (Discourse:
 *    before `./launcher rebuild app`; Flarum: before `up -d proxy`);
 *  - carry the SES host, STARTTLS marker, sender address and the two
 *    `ses-smtp-*` parameter names, fetched via `fetch_secret`;
 *  - carry the Secret_Reference ids for every required secret and use
 *    `fetch_secret` / `write_secret` to move them on the instance;
 *  - contain NO secret VALUE and no CDK token (`${Token[`). The input only ever
 *    carries references, so a freshly generated "secret value" marker — never
 *    passed into the input — must not appear anywhere in the rendered scripts.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x1_9c_a2e;

/**
 * A distinct "secret value" marker that is NEVER passed into the renderers.
 * Every candidate shares the `CH_LEAKED_SECRET_` prefix, so the assertion stays
 * meaningful: if any such string surfaced in a rendered script, a value (not a
 * reference) would have leaked. The suffix varies so the generator explores a
 * family of markers rather than a single constant.
 */
const secretValueMarker: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9]{8,24}$/)
  .map((s) => `CH_LEAKED_SECRET_${s}`);

/**
 * Build an SSM {@link SecretReference} under a forum's reserved prefix for a
 * given purpose. References never carry a value — only placeholder path parts.
 */
function ssmRef(prefix: string, purpose: string): SecretReference {
  return { store: 'ssm', id: `${prefix}${purpose}` };
}

/** Derive the forum's SES settings directly (host, port 587, parameter names). */
function sesFor(environment: string, forum: string, region: string, sender: string): SesSettings {
  const prefix = `/community-hub/${environment}/${forum}`;
  return {
    host: `email-smtp.${region}.amazonaws.com`,
    port: 587,
    senderAddress: sender,
    usernameParameter: `${prefix}/ses-smtp-username`,
    passwordParameter: `${prefix}/ses-smtp-password`,
  };
}

/** The set of required-secret references for a forum prefix, per engine. */
function secretsFor(
  prefix: string,
  includeDatabase: boolean,
): Readonly<Partial<Record<'adminPassword' | 'apiKey' | 'databasePassword', SecretReference>>> {
  const base = {
    adminPassword: ssmRef(prefix, 'admin-password'),
    apiKey: ssmRef(prefix, 'api-key'),
  } satisfies Partial<Record<string, SecretReference>>;
  return includeDatabase
    ? { ...base, databasePassword: ssmRef(prefix, 'database-password') }
    : base;
}

/**
 * A valid {@link InstallScriptInput} for the given adapter, paired with a
 * secret-value marker that is deliberately NOT part of the input. The adapter's
 * `engineOptionsSchema.parse({})` supplies fully-defaulted options.
 */
function inputArb(adapter: EngineAdapter): fc.Arbitrary<{
  readonly input: InstallScriptInput;
  readonly marker: string;
}> {
  const includeDatabase = adapter.requiredSecrets.includes('databasePassword');
  return fc
    .record({
      environment: environmentName,
      forum: forumId,
      region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
      root: rootDomain,
      subdomain: fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
      senderLocal: fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
      adminLocal: fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
      marker: secretValueMarker,
    })
    .map(({ environment, forum, region, root, subdomain, senderLocal, adminLocal, marker }) => {
      const hostname = `${subdomain}.${root}`;
      const sender = `${senderLocal}@${root}`;
      const prefix = `/community-hub/${environment}/${forum}/`;
      const input: InstallScriptInput = {
        environmentName: environment,
        region,
        forumId: forum,
        hostname,
        adminEmail: `${adminLocal}@${root}`,
        email: sesFor(environment, forum, region, sender),
        secrets: secretsFor(prefix, includeDatabase),
        engineOptions: adapter.engineOptionsSchema.parse({}),
      };
      return { input, marker };
    });
}

/** Known pins that must appear in the rendered script, per engine id. */
const KNOWN_PINS: Readonly<Record<string, readonly string[]>> = {
  discourse: [DISCOURSE_DOCKER_COMMIT, DISCOURSE_VERSION_TAG],
  flarum: [COMPOSER_IMAGE_TAG, FLARUM_VERSION, PHP_IMAGE_TAG, MYSQL_IMAGE_TAG, CADDY_IMAGE_TAG],
};

/**
 * The engine-specific "serves traffic" anchor that `issue_certificate` must
 * precede in the install script.
 */
const SERVE_ANCHOR: Readonly<Record<string, string>> = {
  discourse: './launcher rebuild app',
  flarum: 'up -d proxy',
};

const adapters: readonly EngineAdapter[] = [discourseAdapter, flarumAdapter];

describe('Property 9: Install scripts carry configuration and only references', () => {
  for (const adapter of adapters) {
    describe(adapter.id, () => {
      it('carries hostname, admin email and a pinned version (Req 5.2, 6.6)', () => {
        fc.assert(
          fc.property(inputArb(adapter), ({ input }) => {
            const script =
              adapter.renderInstallScript(input) + '\n' + adapter.renderEmailRefreshScript(input);

            expect(script.length).toBeGreaterThan(0);
            expect(script).toContain(input.hostname);
            expect(script).toContain(input.adminEmail);

            // At least one of the engine's known pins is present, and no
            // floating `latest` tag is used.
            const pins = KNOWN_PINS[adapter.id]!;
            expect(pins.some((pin) => script.includes(pin))).toBe(true);
            expect(script).not.toMatch(/:latest\b/);
          }),
          { seed: SEED, numRuns: 200 },
        );
      });

      it('wires the ACME challenge and issues the certificate before serving (Req 11.10)', () => {
        fc.assert(
          fc.property(inputArb(adapter), ({ input }) => {
            const script = adapter.renderInstallScript(input);

            expect(script).toContain('/.well-known/acme-challenge/');
            expect(script).toContain('issue_certificate');

            // The certificate is issued before the engine binds port 80/443.
            const issueAt = script.indexOf('issue_certificate');
            const serveAt = script.indexOf(SERVE_ANCHOR[adapter.id]!);
            expect(issueAt).toBeGreaterThanOrEqual(0);
            expect(serveAt).toBeGreaterThanOrEqual(0);
            expect(issueAt).toBeLessThan(serveAt);
          }),
          { seed: SEED, numRuns: 200 },
        );
      });

      it('carries the derived SES settings and STARTTLS marker (Req 5.2, 6.6)', () => {
        fc.assert(
          fc.property(inputArb(adapter), ({ input }) => {
            const script =
              adapter.renderInstallScript(input) + '\n' + adapter.renderEmailRefreshScript(input);
            const { email } = input;

            expect(script).toContain(email.host);
            expect(script).toContain(email.senderAddress);
            expect(script).toContain(email.usernameParameter);
            expect(script).toContain(email.passwordParameter);
            // Both SES parameter names are fetched on the instance.
            expect(script).toContain(`fetch_secret ssm '${email.usernameParameter}'`);
            expect(script).toContain(`fetch_secret ssm '${email.passwordParameter}'`);

            // STARTTLS is expressed per engine.
            if (adapter.id === 'discourse') {
              expect(script).toContain('DISCOURSE_SMTP_ENABLE_START_TLS: "true"');
              expect(script).toContain(`DISCOURSE_SMTP_PORT: ${String(email.port)}`);
            } else {
              expect(script).toContain('mail_encryption');
              expect(script).toContain(`"mail_encryption": "tls"`);
              expect(script).toContain(`CH_MAIL_PORT='${String(email.port)}'`);
            }
          }),
          { seed: SEED, numRuns: 200 },
        );
      });

      it('carries every required secret reference id via fetch/write (Req 11.10)', () => {
        fc.assert(
          fc.property(inputArb(adapter), ({ input }) => {
            const script =
              adapter.renderInstallScript(input) + '\n' + adapter.renderEmailRefreshScript(input);

            // Every declared required-secret reference id appears.
            for (const name of adapter.requiredSecrets) {
              const ref = input.secrets[name];
              expect(ref).toBeDefined();
              expect(script).toContain(ref!.id);
            }

            // The script moves secrets with the prelude helpers, never inlining.
            expect(script).toContain('fetch_secret');
            expect(script).toContain('write_secret');
          }),
          { seed: SEED, numRuns: 200 },
        );
      });

      it('leaks no secret value and no CDK token (secret hygiene in user data)', () => {
        fc.assert(
          fc.property(inputArb(adapter), ({ input, marker }) => {
            const script =
              adapter.renderInstallScript(input) + '\n' + adapter.renderEmailRefreshScript(input);

            // The marker is a value that is never part of the input, so it must
            // never surface in a rendered script.
            expect(script).not.toContain(marker);
            expect(script).not.toContain('CH_LEAKED_SECRET_');

            // No CloudFormation/CDK token may reach user data.
            expect(script).not.toContain('${Token[');
          }),
          { seed: SEED, numRuns: 200 },
        );
      });
    });
  }
});
