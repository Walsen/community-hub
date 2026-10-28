/**
 * Pure builder for an Environment's email authentication DNS records.
 *
 * SES requires three kinds of records to authorize sending from the Environment's
 * mail domain: Easy DKIM CNAMEs (so receivers can verify the DKIM signature), a
 * custom MAIL FROM MX plus SPF TXT (so bounces reach SES and SPF aligns) and a
 * DMARC TXT (the Environment's reporting and enforcement policy). This module
 * returns them in a fixed order as a discriminated union so the Route 53 factory
 * (`dns/records.ts`) can switch exhaustively and `external` mode can print each
 * record's value with {@link displayValue} (Req 11.3, 11.4, 11.5).
 *
 * Names are absolute (trailing dot). The Route 53 L2 records append the zone name
 * to any `recordName` that is not already absolute, and a DKIM token name never
 * matches that test, so the absolute form is the only safe one.
 *
 * This module has no I/O, creates no CDK constructs and makes no SDK calls.
 */

/** One Easy DKIM token from the SES identity: the CNAME record name and its target. */
export type DkimToken = { readonly name: string; readonly value: string };

/**
 * A single email authentication record, discriminated by `type` so the Route 53
 * factory can switch exhaustively. All `name` values are absolute (trailing dot).
 */
export type EmailDnsRecord =
  | {
      readonly id: 'Dkim1' | 'Dkim2' | 'Dkim3';
      readonly type: 'CNAME';
      readonly name: string;
      readonly target: string;
    }
  | {
      readonly id: 'MailFromMx';
      readonly type: 'MX';
      readonly name: string;
      readonly priority: 10;
      readonly host: string;
    }
  | {
      readonly id: 'MailFromSpf' | 'Dmarc';
      readonly type: 'TXT';
      readonly name: string;
      readonly text: string;
    };

/**
 * Append a single trailing dot to a DNS name, making it absolute. Idempotent: a
 * name that already ends in a dot is returned unchanged.
 *
 * @param name a DNS name, with or without a trailing dot.
 * @returns the absolute form of `name` (exactly one trailing dot).
 */
function absolute(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

/**
 * The single-line value shown for a record in `external` mode outputs: `"<priority> <host>"`
 * for MX, the unquoted text for TXT and the target for CNAME. Pure.
 *
 * @param record the email DNS record to render.
 * @returns the record's display value.
 */
export function displayValue(record: EmailDnsRecord): string {
  switch (record.type) {
    case 'CNAME':
      return record.target;
    case 'MX':
      return `${record.priority} ${record.host}`;
    case 'TXT':
      return record.text;
    default: {
      const unreachable: never = record;
      return unreachable;
    }
  }
}

/**
 * Build the email authentication records for one Environment in a fixed order:
 * `Dkim1`, `Dkim2`, `Dkim3` (CNAMEs from the identity's DKIM tokens), `MailFromMx`,
 * `MailFromSpf` (both at the custom MAIL FROM domain) and `Dmarc` (at
 * `_dmarc.<mailDomain>`). All names are absolute. Pure (Req 11.3, 11.4, 11.5).
 *
 * @param input the mail domain, custom MAIL FROM domain, region, admin email,
 *   DMARC policy and the three DKIM tokens from the SES identity.
 * @returns the records in their fixed order.
 */
export function buildEmailDnsRecords(input: {
  mailDomain: string;
  mailFromDomain: string;
  region: string;
  adminEmail: string;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  dkim: readonly [DkimToken, DkimToken, DkimToken];
}): readonly EmailDnsRecord[] {
  const { mailDomain, mailFromDomain, region, adminEmail, dmarcPolicy, dkim } = input;
  const [dkim1, dkim2, dkim3] = dkim;

  return [
    { id: 'Dkim1', type: 'CNAME', name: absolute(dkim1.name), target: absolute(dkim1.value) },
    { id: 'Dkim2', type: 'CNAME', name: absolute(dkim2.name), target: absolute(dkim2.value) },
    { id: 'Dkim3', type: 'CNAME', name: absolute(dkim3.name), target: absolute(dkim3.value) },
    {
      id: 'MailFromMx',
      type: 'MX',
      name: absolute(mailFromDomain),
      priority: 10,
      host: `feedback-smtp.${region}.amazonses.com`,
    },
    {
      id: 'MailFromSpf',
      type: 'TXT',
      name: absolute(mailFromDomain),
      text: 'v=spf1 include:amazonses.com ~all',
    },
    {
      id: 'Dmarc',
      type: 'TXT',
      name: absolute(`_dmarc.${mailDomain}`),
      text: `v=DMARC1; p=${dmarcPolicy}; rua=mailto:${adminEmail}`,
    },
  ];
}
