/**
 * Pure builder for the Route 53 IAM statements a DNS-01 forum's node role needs.
 *
 * These statements let `lego`'s route53 provider solve the ACME DNS-01 challenge
 * for exactly one hostname: write only the `_acme-challenge.<hostname>` TXT
 * record in the forum's zone, list that zone's records (lego merges existing TXT
 * values so parallel challenges do not overwrite each other) and poll change
 * status. Least privilege is carried by the exact record name, type and action
 * scoping below; the statements carry no `aws:SourceIp` condition because a
 * Lightsail instance's outbound traffic egresses from a NAT address that is not
 * its static IP, so such a condition would deny every legitimate call.
 *
 * The result is plain JSON so `node-role.ts` can merge it into the node policy
 * without this module touching CDK or the AWS SDK. This module has no I/O,
 * creates no CDK constructs and makes no SDK calls.
 */

/**
 * A structural IAM policy statement as plain JSON, matching the shape
 * CloudFormation and `iam.PolicyStatement.fromJson` accept. Kept intentionally
 * permissive so callers can merge these with statements built elsewhere.
 */
export interface PolicyStatementJson {
  readonly Sid: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action: string | readonly string[];
  readonly Resource: string | readonly string[];
  readonly Condition?: Readonly<
    Record<string, Readonly<Record<string, string | readonly string[]>>>
  >;
}

/** Inputs for {@link buildAcmeDnsStatements}. */
export interface AcmeDnsStatementsInput {
  /** AWS partition for ARNs, e.g. `aws` or `aws-us-gov`. */
  readonly partition: string;
  /**
   * Hosted zone id the challenge records live in: the `Dns/Zone` token in
   * `route53` mode or the declared literal in `route53-existing`.
   */
  readonly zoneId: string;
  /**
   * Fully qualified forum host, `<subdomain>.<rootDomain>`, lowercase without a
   * trailing dot. The managed record is `_acme-challenge.<hostname>`, matching
   * the normalized record name Route 53 compares against.
   */
  readonly hostname: string;
}

/**
 * Build the three IAM statements (AcmeDns01Change, AcmeDns01ReadZone,
 * AcmeDns01GetChange) that scope a DNS-01 forum's Route 53 access to its own
 * `_acme-challenge` TXT record, its own zone and change polling (Req 13.6–13.8).
 *
 * @param input partition, zone id and fully qualified hostname.
 * @returns the three statements, in Sid order, as plain JSON.
 */
export function buildAcmeDnsStatements(input: AcmeDnsStatementsInput): PolicyStatementJson[] {
  const { partition, zoneId, hostname } = input;
  const zoneArn = `arn:${partition}:route53:::hostedzone/${zoneId}`;

  return [
    {
      Sid: 'AcmeDns01Change',
      Effect: 'Allow',
      Action: 'route53:ChangeResourceRecordSets',
      Resource: zoneArn,
      Condition: {
        'ForAllValues:StringEquals': {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [`_acme-challenge.${hostname}`],
          'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
          'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
        },
        Null: {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': 'false',
          'route53:ChangeResourceRecordSetsRecordTypes': 'false',
          'route53:ChangeResourceRecordSetsActions': 'false',
        },
      },
    },
    {
      Sid: 'AcmeDns01ReadZone',
      Effect: 'Allow',
      Action: 'route53:ListResourceRecordSets',
      Resource: zoneArn,
    },
    {
      Sid: 'AcmeDns01GetChange',
      Effect: 'Allow',
      Action: 'route53:GetChange',
      Resource: `arn:${partition}:route53:::change/*`,
    },
  ];
}
