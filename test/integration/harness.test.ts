/**
 * Harness smoke test for the opt-in integration scaffolding (task 21.8).
 *
 * This is deliberately NOT a real integration test — the actual Lightsail/forum
 * tests are optional task 21.9. Its only job is to prove the harness in
 * `support.ts` type-checks, imports cleanly and is wired to the opt-in guard,
 * so the default `npm test` never touches AWS.
 *
 * The suite is wrapped in {@link describeIntegration}, so:
 *  - under the default `npm test`, `vitest.config.ts` excludes `test/integration/**`
 *    entirely and this file never loads;
 *  - under `npm run test:integration` without `COMMUNITY_HUB_INTEGRATION=1`,
 *    the suite reports as skipped and issues no AWS calls;
 *  - with the env var set, the body runs and does pure, offline assertions on
 *    the model builder (it still makes no network calls).
 */

import { expect, it } from 'vitest';

import { buildThrowawayModel, describeIntegration } from './support.js';

describeIntegration('integration harness', () => {
  it('builds a validated throwaway Flarum model with acmeStaging enabled', () => {
    const { name, model } = buildThrowawayModel({ name: 'it-fixed01' });

    expect(name).toBe('it-fixed01');
    expect(model.environment.name).toBe('it-fixed01');
    expect(model.environment.acmeStaging).toBe(true);
    expect(model.forums).toHaveLength(1);
    expect(model.forums[0]?.engine).toBe('flarum');
  });

  it('falls back to external DNS mode when no hosted zone id is provided', () => {
    const { model } = buildThrowawayModel({ name: 'it-fixed02' });
    expect(model.environment.dnsMode).toBe('external');
  });

  it('uses route53-existing when a hosted zone id is supplied', () => {
    const { model } = buildThrowawayModel({
      name: 'it-fixed03',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    });
    expect(model.environment.dnsMode).toBe('route53-existing');
    expect(model.environment.hostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
  });
});
