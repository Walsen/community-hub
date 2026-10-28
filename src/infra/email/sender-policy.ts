/**
 * Pure builder for the inline IAM send policy a single forum's SES user needs.
 *
 * The policy grants exactly the two SES send actions on `Resource: *`,
 * conditioned on the forum's own Sender_Address (`ses:FromAddress`). The
 * condition — not a resource ARN — is what scopes sending: `SendRawEmail`
 * authorization is evaluated against EVERY identity touched by a send,
 * including the recipient identity in the SES sandbox, so pinning `Resource`
 * to the sending identity makes SES deny sends to any recipient that is not
 * also listed (a real "554 Access denied ... identity/<recipient>" failure
 * observed in sandbox). AWS's own guidance is to use `Resource: *` with a
 * `ses:FromAddress`/`FromDomain` condition for exactly this reason. Because
 * sender addresses are unique per Environment (a loader rule), the condition
 * still guarantees no forum can send mail as another (Req 11.7).
 *
 * The result is plain JSON so `ses-sender.ts` can attach it to the user's
 * inline policy without this module touching CDK or the AWS SDK. This module
 * has no I/O, creates no CDK constructs and makes no SDK calls.
 */

import type { PolicyStatementJson } from '../tls/acme-policy.js';

/** Inputs for {@link buildSesSenderPolicy}. */
export interface SesSenderPolicyInput {
  /** AWS partition for ARNs, e.g. `aws` or `aws-us-gov`. */
  readonly partition: string;
  /** Environment region hosting the SES identity and configuration set. */
  readonly region: string;
  /** AWS account id that owns the SES identity and configuration set. */
  readonly account: string;
  /** The Environment's Mail_Domain, used as the SES identity name. */
  readonly mailDomain: string;
  /** Name of the Environment's default SES configuration set. */
  readonly configurationSetName: string;
  /**
   * The forum's fully expanded Sender_Address (`<local>@<mailDomain>`). The
   * policy's `ses:FromAddress` condition pins sending to exactly this address.
   */
  readonly senderAddress: string;
}

/**
 * Build the single least-privilege SES send statement for one forum: allow
 * `ses:SendEmail` and `ses:SendRawEmail` on `Resource: *`, scoped to the
 * forum's own From address by a `ses:FromAddress` condition. The actions are
 * exactly the two send actions (no action wildcard); `Resource` must be `*`
 * because SES evaluates `SendRawEmail` authorization against every identity in
 * a send (the recipient included, in sandbox), so a pinned identity ARN denies
 * legitimate sends to other recipients. The sender restriction is enforced by
 * the condition instead.
 *
 * @param input partition, region, account, mail domain, configuration set
 *   name and the forum's sender address. (`mailDomain`/`configurationSetName`
 *   are retained for signature stability and error context; the statement is
 *   scoped by the From-address condition, not by their ARNs.)
 * @returns a single-element array holding the send statement, as plain JSON.
 */
export function buildSesSenderPolicy(input: SesSenderPolicyInput): PolicyStatementJson[] {
  const { senderAddress } = input;

  return [
    {
      Sid: 'SesSendAsForumSender',
      Effect: 'Allow',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: '*',
      Condition: {
        StringEquals: {
          'ses:FromAddress': senderAddress,
        },
      },
    },
  ];
}
