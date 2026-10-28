/**
 * Pure builder for the inline IAM send policy a single forum's SES user needs.
 *
 * The policy grants exactly the two SES send actions, scoped to this
 * Environment's Email_Identity and Configuration_Set, and conditioned on the
 * forum's own Sender_Address. Because sender addresses are unique per
 * Environment (a loader rule), no forum can send mail as another (Req 11.7).
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
 * `ses:SendEmail` and `ses:SendRawEmail` only on this Environment's identity
 * and configuration-set ARNs, and only when the From address equals the
 * forum's Sender_Address. No wildcards appear in actions or resources
 * (Req 11.7).
 *
 * The configuration-set ARN is included because SES authorizes the default
 * configuration set as a second resource of the send; it grants no other
 * capability.
 *
 * @param input partition, region, account, mail domain, configuration set
 *   name and the forum's sender address.
 * @returns a single-element array holding the send statement, as plain JSON.
 */
export function buildSesSenderPolicy(input: SesSenderPolicyInput): PolicyStatementJson[] {
  const { partition, region, account, mailDomain, configurationSetName, senderAddress } = input;
  const arnPrefix = `arn:${partition}:ses:${region}:${account}:`;

  return [
    {
      Sid: 'SesSendAsForumSender',
      Effect: 'Allow',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: [
        `${arnPrefix}identity/${mailDomain}`,
        `${arnPrefix}configuration-set/${configurationSetName}`,
      ],
      Condition: {
        StringEquals: {
          'ses:FromAddress': senderAddress,
        },
      },
    },
  ];
}
