import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildSesSenderPolicy,
  type SesSenderPolicyInput,
} from '../../../src/infra/email/sender-policy.js';
import type { PolicyStatementJson } from '../../../src/infra/tls/acme-policy.js';

/**
 * Property: the SES sender policy is least-privilege and scoped.
 *
 * Validates: Requirements 11.7
 *
 * For arbitrary (partition, region, account, mailDomain, configurationSetName,
 * senderAddress), {@link buildSesSenderPolicy} returns exactly one Allow
 * statement that names only `ses:SendEmail` and `ses:SendRawEmail` on
 * exactly the Environment's Email_Identity and Configuration_Set ARNs, and
 * `Resource: *`, conditioned with `StringEquals { 'ses:FromAddress': <senderAddress> }`.
 * No wildcard appears in an ACTION; the resource is `*` by design (SES authorizes
 * SendRawEmail against every identity in a send, so the From-address condition,
 * not a resource ARN, is what ensures a forum can only send
 * mail as its own Sender_Address. The builder is pure and deterministic: the
 * same input produces a deep-equal result.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x5e5de4;

/** Collect every action string a statement names, as a flat array. */
function actionsOf(statement: PolicyStatementJson): string[] {
  return typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action];
}

/** Collect every resource string a statement names, as a flat array. */
function resourcesOf(statement: PolicyStatementJson): string[] {
  return typeof statement.Resource === 'string' ? [statement.Resource] : [...statement.Resource];
}

// --- Arbitraries: valid-ish shapes for each input field. -------------------

/** AWS partition. */
const partitionArb = fc.constantFrom('aws', 'aws-us-gov', 'aws-cn');

/** A plausible AWS region token. */
const regionArb = fc.constantFrom(
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'ap-southeast-2',
  'eu-central-1',
);

/** 12-digit AWS account id. */
const accountArb = fc.stringMatching(/^[0-9]{12}$/);

/** A DNS label used to build domains and names. */
const dnsLabelArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/);

/** A mail domain `<label>.<label>.<tld>`, lowercase, no trailing dot. */
const mailDomainArb = fc
  .tuple(dnsLabelArb, fc.constantFrom('com', 'org', 'net', 'io', 'dev'))
  .map(([label, tld]) => `${label}.${tld}`);

/** A per-Environment configuration set name. */
const configurationSetNameArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/);

/** A fully expanded sender address `<local>@<mailDomain>`. */
const senderAddressArb = fc
  .tuple(dnsLabelArb, mailDomainArb)
  .map(([local, domain]) => `${local}@${domain}`);

/** The full set of inputs to {@link buildSesSenderPolicy}. */
const inputArb: fc.Arbitrary<SesSenderPolicyInput> = fc.record({
  partition: partitionArb,
  region: regionArb,
  account: accountArb,
  mailDomain: mailDomainArb,
  configurationSetName: configurationSetNameArb,
  senderAddress: senderAddressArb,
});

describe('Property: SES sender policy is least-privilege and scoped (Req 11.7)', () => {
  it('returns exactly one Allow statement with only the two SES send actions', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const policy = buildSesSenderPolicy(input);

        expect(policy).toHaveLength(1);
        const statement = policy[0]!;
        expect(statement.Effect).toBe('Allow');
        // Actions are exactly the two send actions, in order, with no others.
        expect(actionsOf(statement)).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('uses Resource: * (SendRawEmail is authorized against every identity, incl. the recipient)', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const statement = buildSesSenderPolicy(input)[0]!;
        // SES evaluates SendRawEmail authorization against every identity a send
        // touches, including the recipient identity in the sandbox. Pinning
        // Resource to the sending identity therefore denies legitimate sends to
        // other recipients (a real 554 Access denied seen in sandbox). AWS's
        // guidance is Resource: * scoped by a ses:FromAddress condition.
        expect(resourcesOf(statement)).toEqual(['*']);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('pins the From address condition to exactly the forum sender address', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const statement = buildSesSenderPolicy(input)[0]!;

        expect(statement.Condition).toEqual({
          StringEquals: {
            'ses:FromAddress': input.senderAddress,
          },
        });
        // Scoping: the condition pins the exact input sender address, so a forum
        // can only send as its own address.
        const fromAddress = statement.Condition?.StringEquals?.['ses:FromAddress'];
        expect(fromAddress).toBe(input.senderAddress);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('never uses a wildcard in any action (the resource is intentionally *)', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const statement = buildSesSenderPolicy(input)[0]!;

        // Actions are exact — no action wildcard. The resource is * by design
        // (the ses:FromAddress condition is the scoping mechanism).
        for (const action of actionsOf(statement)) {
          expect(action).not.toContain('*');
        }
        expect(resourcesOf(statement)).toEqual(['*']);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('is deterministic: the same input yields a deep-equal policy', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(buildSesSenderPolicy(input)).toEqual(buildSesSenderPolicy(input));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
