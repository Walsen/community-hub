import { describe, expect, it } from 'vitest';

import {
  buildEmailDnsRecords,
  displayValue,
  type DkimToken,
  type EmailDnsRecord,
} from '../../../src/infra/email/email-dns-records.js';

const DKIM: readonly [DkimToken, DkimToken, DkimToken] = [
  { name: 'token1._domainkey.example.org', value: 'token1.dkim.amazonses.com' },
  { name: 'token2._domainkey.example.org', value: 'token2.dkim.amazonses.com' },
  { name: 'token3._domainkey.example.org', value: 'token3.dkim.amazonses.com' },
];

const BASE_INPUT = {
  mailDomain: 'example.org',
  mailFromDomain: 'mail.example.org',
  region: 'us-east-1',
  adminEmail: 'ops@example.org',
  dmarcPolicy: 'none' as const,
  dkim: DKIM,
};

describe('buildEmailDnsRecords', () => {
  it('returns records in the fixed order Dkim1, Dkim2, Dkim3, MailFromMx, MailFromSpf, Dmarc', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);

    expect(records.map((r) => r.id)).toEqual([
      'Dkim1',
      'Dkim2',
      'Dkim3',
      'MailFromMx',
      'MailFromSpf',
      'Dmarc',
    ]);
  });

  it('builds each DKIM CNAME with absolute name and target', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);
    const dkimRecords = records.filter(
      (r): r is Extract<EmailDnsRecord, { type: 'CNAME' }> => r.type === 'CNAME',
    );

    expect(dkimRecords).toEqual([
      {
        id: 'Dkim1',
        type: 'CNAME',
        name: 'token1._domainkey.example.org.',
        target: 'token1.dkim.amazonses.com.',
      },
      {
        id: 'Dkim2',
        type: 'CNAME',
        name: 'token2._domainkey.example.org.',
        target: 'token2.dkim.amazonses.com.',
      },
      {
        id: 'Dkim3',
        type: 'CNAME',
        name: 'token3._domainkey.example.org.',
        target: 'token3.dkim.amazonses.com.',
      },
    ]);
  });

  it('builds the MAIL FROM MX record with priority 10 and the SES feedback host', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);
    const mx = records.find((r) => r.id === 'MailFromMx');

    expect(mx).toEqual({
      id: 'MailFromMx',
      type: 'MX',
      name: 'mail.example.org.',
      priority: 10,
      host: 'feedback-smtp.us-east-1.amazonses.com',
    });
  });

  it('derives the MX host from the region', () => {
    const records = buildEmailDnsRecords({ ...BASE_INPUT, region: 'eu-west-1' });
    const mx = records.find((r) => r.id === 'MailFromMx');

    expect(mx).toMatchObject({ host: 'feedback-smtp.eu-west-1.amazonses.com' });
  });

  it('builds the SPF TXT record at the MAIL FROM domain', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);
    const spf = records.find((r) => r.id === 'MailFromSpf');

    expect(spf).toEqual({
      id: 'MailFromSpf',
      type: 'TXT',
      name: 'mail.example.org.',
      text: 'v=spf1 include:amazonses.com ~all',
    });
  });

  it('builds the DMARC TXT record at _dmarc.<mailDomain> with the admin email', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);
    const dmarc = records.find((r) => r.id === 'Dmarc');

    expect(dmarc).toEqual({
      id: 'Dmarc',
      type: 'TXT',
      name: '_dmarc.example.org.',
      text: 'v=DMARC1; p=none; rua=mailto:ops@example.org',
    });
  });

  it.each([
    ['none', 'v=DMARC1; p=none; rua=mailto:ops@example.org'],
    ['quarantine', 'v=DMARC1; p=quarantine; rua=mailto:ops@example.org'],
    ['reject', 'v=DMARC1; p=reject; rua=mailto:ops@example.org'],
  ] as const)('encodes the %s DMARC policy in the record text', (dmarcPolicy, expected) => {
    const records = buildEmailDnsRecords({ ...BASE_INPUT, dmarcPolicy });
    const dmarc = records.find((r) => r.id === 'Dmarc');

    expect(dmarc).toMatchObject({ type: 'TXT', text: expected });
  });

  it('produces an absolute name (single trailing dot) for every record', () => {
    const records = buildEmailDnsRecords(BASE_INPUT);

    for (const record of records) {
      expect(record.name.endsWith('.')).toBe(true);
      expect(record.name.endsWith('..')).toBe(false);
    }
  });

  it('does not double the trailing dot when a DKIM token is already absolute', () => {
    const records = buildEmailDnsRecords({
      ...BASE_INPUT,
      dkim: [
        { name: 'token1._domainkey.example.org.', value: 'token1.dkim.amazonses.com.' },
        DKIM[1],
        DKIM[2],
      ],
    });
    const dkim1 = records.find((r) => r.id === 'Dkim1');

    expect(dkim1).toEqual({
      id: 'Dkim1',
      type: 'CNAME',
      name: 'token1._domainkey.example.org.',
      target: 'token1.dkim.amazonses.com.',
    });
  });
});

describe('displayValue', () => {
  it('renders a CNAME record as its target', () => {
    const record: EmailDnsRecord = {
      id: 'Dkim1',
      type: 'CNAME',
      name: 'token1._domainkey.example.org.',
      target: 'token1.dkim.amazonses.com.',
    };

    expect(displayValue(record)).toBe('token1.dkim.amazonses.com.');
  });

  it('renders an MX record as "<priority> <host>"', () => {
    const record: EmailDnsRecord = {
      id: 'MailFromMx',
      type: 'MX',
      name: 'mail.example.org.',
      priority: 10,
      host: 'feedback-smtp.us-east-1.amazonses.com',
    };

    expect(displayValue(record)).toBe('10 feedback-smtp.us-east-1.amazonses.com');
  });

  it('renders a TXT record as its text', () => {
    const record: EmailDnsRecord = {
      id: 'Dmarc',
      type: 'TXT',
      name: '_dmarc.example.org.',
      text: 'v=DMARC1; p=none; rua=mailto:ops@example.org',
    };

    expect(displayValue(record)).toBe('v=DMARC1; p=none; rua=mailto:ops@example.org');
  });
});
