/**
 * Route 53 record factories for a forum's A record and an Environment's email
 * authentication records.
 *
 * These helpers only create CDK L2 record constructs; they are called in the
 * Route 53 modes (`route53`, `route53-existing`), where a concrete
 * {@link IHostedZone} exists. In `external` mode the callers print values with
 * {@link displayValue} instead and never invoke these factories.
 *
 * Every record uses a 300-second TTL and `deleteExisting: false` (the L2
 * default, set explicitly) so CloudFormation never adds a custom resource that
 * deletes a pre-existing operator record (Req 12.9). All record names are
 * absolute (trailing dot); the L2 only appends the zone name to names that are
 * not already absolute, and our inputs always end in '.', so they pass through
 * unchanged. This module makes no SDK calls.
 */

import { Duration } from 'aws-cdk-lib';
import {
  ARecord,
  CnameRecord,
  type IHostedZone,
  MxRecord,
  RecordTarget,
  TxtRecord,
} from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

import type { EmailDnsRecord } from '../email/email-dns-records.js';
import { constructIds } from '../naming.js';

/** TTL applied to every Platform-owned record set. */
const RECORD_TTL = Duration.seconds(300);

/** Inputs for {@link forumARecord}. */
export interface ForumARecordInput {
  /** The forum's fully qualified host name, absolute (trailing dot). */
  readonly recordName: string;
  /** The forum's Lightsail static IP address (an `A` target). */
  readonly ipAddress: string;
}

/**
 * Create the forum's `A` record pointing its host name at its static IP. The
 * construct id is {@link constructIds.forumARecord}, relative to the forum
 * construct, so adding or removing a forum adds or removes exactly that record
 * set and never renames another forum's record (Req 4.3, 12.12).
 *
 * @param scope the forum construct the record is attached to.
 * @param zone the hosted zone the record is created in.
 * @param input the absolute record name and the static IP target.
 * @returns the created `ARecord`.
 */
export function forumARecord(
  scope: Construct,
  zone: IHostedZone,
  input: ForumARecordInput,
): ARecord {
  return new ARecord(scope, constructIds.forumARecord, {
    zone,
    recordName: input.recordName,
    target: RecordTarget.fromIpAddresses(input.ipAddress),
    ttl: RECORD_TTL,
    deleteExisting: false,
  });
}

/**
 * Create one record construct per email authentication record, switching
 * exhaustively on the discriminated union: CNAME tokens become
 * {@link CnameRecord}, the MAIL FROM MX becomes an {@link MxRecord} and the SPF
 * and DMARC entries become {@link TxtRecord}s (the L2 quotes the TXT value
 * exactly once). Each construct id is {@link constructIds.emailRecord} of the
 * record's fixed id, so the set is stable as forums come and go (Req 11, 12.12).
 *
 * @param scope the email construct the records are attached to.
 * @param zone the hosted zone the records are created in.
 * @param records the email records in their fixed order (see `email-dns-records.ts`).
 * @returns the created record constructs, in the same order.
 */
export function emailRecords(
  scope: Construct,
  zone: IHostedZone,
  records: readonly EmailDnsRecord[],
): Construct[] {
  return records.map((record) => {
    const id = constructIds.emailRecord(record.id);
    switch (record.type) {
      case 'CNAME':
        return new CnameRecord(scope, id, {
          zone,
          recordName: record.name,
          domainName: record.target,
          ttl: RECORD_TTL,
          deleteExisting: false,
        });
      case 'MX':
        return new MxRecord(scope, id, {
          zone,
          recordName: record.name,
          values: [{ priority: record.priority, hostName: record.host }],
          ttl: RECORD_TTL,
          deleteExisting: false,
        });
      case 'TXT':
        return new TxtRecord(scope, id, {
          zone,
          recordName: record.name,
          values: [record.text],
          ttl: RECORD_TTL,
          deleteExisting: false,
        });
      default: {
        const unreachable: never = record;
        return unreachable;
      }
    }
  });
}
