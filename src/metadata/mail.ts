/**
 * Pure mail and DNS cross-field rules for the metadata schema.
 *
 * These functions run inside {@link module:metadata/schema.MetadataSchema} as
 * `superRefine` checks and a `transform`, so their issues carry stable Zod
 * paths and expansion happens before {@link ValidatedModel} is produced. They
 * are pure: no I/O, no clock, no randomness. They operate on the raw document
 * shape (after per-field validation, before expansion) rather than importing
 * the schema, which keeps this module free of a circular dependency on
 * `schema.ts`.
 *
 * {@link sesSettings} derives the SES_Settings for a forum from the validated,
 * expanded model. Those settings are never declared in metadata.
 */

import type { RefinementCtx } from 'zod';

import type { EnvironmentModel, ForumModel } from './schema.js';

/**
 * A bare email local part (no domain), case-insensitive. Mirrors the sender
 * local-part rule in the design: starts and ends with an alphanumeric and may
 * contain `. _ + -` internally, up to 64 characters.
 */
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/i;

/** The subset of the raw environment block the mail/DNS rules read. */
interface RawEnvironment {
  readonly dnsMode: 'route53' | 'route53-existing' | 'external';
  readonly hostedZoneId?: string | undefined;
  readonly rootDomain: string;
  readonly mailDomain?: string | undefined;
}

/** The subset of a raw forum the mail rules read. */
interface RawForum {
  readonly senderAddress: string;
}

/** The subset of the raw document the mail/DNS rules read. */
interface RawMetadata {
  readonly environment: RawEnvironment;
  readonly forums: readonly RawForum[];
}

/** The effective mail domain: the declared `mailDomain`, else the root domain. */
function effectiveMailDomain(environment: RawEnvironment): string {
  return (environment.mailDomain ?? environment.rootDomain).toLowerCase();
}

/**
 * Expands a sender address against a mail domain. A bare local part becomes
 * `<local>@<mailDomain>`; a full address is returned unchanged. The result is
 * lowercased. Returns `undefined` when the value is neither a valid local part
 * nor a syntactically plausible `local@domain` address.
 */
function expandSender(senderAddress: string, mailDomain: string): string | undefined {
  const value = senderAddress.trim();
  if (LOCAL_PART_RE.test(value)) {
    return `${value.toLowerCase()}@${mailDomain}`;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return undefined;
  }
  const local = value.slice(0, at);
  if (!LOCAL_PART_RE.test(local)) {
    return undefined;
  }
  return value.toLowerCase();
}

/** The domain portion of a full, lowercased email address. */
function domainOf(fullAddress: string): string {
  return fullAddress.slice(fullAddress.lastIndexOf('@') + 1);
}

/**
 * `superRefine` enforcing the mail rules (Req 1.9–1.11):
 *
 *  - the effective mail domain equals the root domain or is a subdomain of it;
 *  - each forum's `senderAddress` is a local part on the mail domain, or a full
 *    address whose domain is the mail domain;
 *  - expanded sender addresses are unique across forums.
 *
 * Issues are reported at `environment.mailDomain` and `forums[i].senderAddress`.
 */
export function checkMail(data: RawMetadata, ctx: RefinementCtx): void {
  const rootDomain = data.environment.rootDomain.toLowerCase();
  const mailDomain = effectiveMailDomain(data.environment);

  const mailDomainValid = mailDomain === rootDomain || mailDomain.endsWith(`.${rootDomain}`);
  if (!mailDomainValid) {
    ctx.addIssue({
      code: 'custom',
      path: ['environment', 'mailDomain'],
      message: `mail domain ${mailDomain} must equal or be a subdomain of root domain ${rootDomain}`,
    });
  }

  const seen = new Map<string, number>();
  data.forums.forEach((forum, index) => {
    const expanded = expandSender(forum.senderAddress, mailDomain);
    if (expanded === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['forums', index, 'senderAddress'],
        message: 'sender address is not a valid local part or email address',
      });
      return;
    }

    // Only the sender-domain match is meaningful when the mail domain itself is
    // invalid; skip it to avoid a confusing second issue on the same cause.
    if (mailDomainValid) {
      const senderDomain = domainOf(expanded);
      if (senderDomain !== mailDomain) {
        ctx.addIssue({
          code: 'custom',
          path: ['forums', index, 'senderAddress'],
          message: `sender domain ${senderDomain} does not match mail domain ${mailDomain}`,
        });
        return;
      }
    }

    const previous = seen.get(expanded);
    if (previous !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['forums', index, 'senderAddress'],
        message: `duplicate sender address ${expanded} (also used by forums[${String(previous)}])`,
      });
      return;
    }
    seen.set(expanded, index);
  });
}

/**
 * `superRefine` enforcing the Hosted_Zone_ID presence rule (Req 12.2, 12.3):
 * `hostedZoneId` must be present when `dnsMode` is `route53-existing` and absent
 * otherwise. The malformed-id case is handled by the schema regex. Issues are
 * reported at `environment.hostedZoneId`; the id is not secret, so messages may
 * name the mode.
 */
export function checkDns(data: RawMetadata, ctx: RefinementCtx): void {
  const { dnsMode, hostedZoneId } = data.environment;
  if (dnsMode === 'route53-existing' && hostedZoneId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['environment', 'hostedZoneId'],
      message: "hostedZoneId is required when dnsMode is 'route53-existing'",
    });
  } else if (dnsMode !== 'route53-existing' && hostedZoneId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['environment', 'hostedZoneId'],
      message: `hostedZoneId is only allowed when dnsMode is 'route53-existing', not '${dnsMode}'`,
    });
  }
}

/** The raw document shape the expansion transform operates on. */
interface ExpandableMetadata {
  readonly environment: RawEnvironment & Record<string, unknown>;
  readonly forums: readonly (RawForum & Record<string, unknown>)[];
}

/**
 * `transform` that fills in the effective mail domain and expands every sender
 * address to a full, lowercased address (Req 1.10). Runs after the mail check,
 * so every sender is known to expand cleanly; an unexpandable address falls
 * back to its trimmed lowercased form, which the earlier check already flagged.
 *
 * The returned object carries a required `environment.mailDomain` and full
 * `senderAddress` strings, which is what {@link ValidatedModel} reflects.
 */
export function expandMail<T extends ExpandableMetadata>(
  data: T,
): T & {
  environment: T['environment'] & { mailDomain: string };
  forums: (T['forums'][number] & { senderAddress: string })[];
} {
  const mailDomain = effectiveMailDomain(data.environment);
  return {
    ...data,
    environment: { ...data.environment, mailDomain },
    forums: data.forums.map((forum) => ({
      ...forum,
      senderAddress:
        expandSender(forum.senderAddress, mailDomain) ?? forum.senderAddress.trim().toLowerCase(),
    })),
  };
}

/** The reserved SSM parameter prefix for a forum's Platform-managed secrets. */
function forumParameterPrefix(environmentName: string, forumId: string): string {
  return `/community-hub/${environmentName}/${forumId}`;
}

/**
 * SES_Settings derived for a forum. Nothing here is declared in metadata: the
 * Platform fixes the host and port and reserves the two `ses-smtp-*` parameter
 * names.
 */
export interface SesSettings {
  /** SMTP endpoint host for the environment's region. */
  readonly host: string;
  /** STARTTLS submission port. */
  readonly port: 587;
  /** The forum's expanded, lowercased sender address. */
  readonly senderAddress: string;
  /** SSM parameter (`String`) holding the SMTP username (SES access key id). */
  readonly usernameParameter: string;
  /** SSM parameter (`SecureString`) holding the derived SMTP password. */
  readonly passwordParameter: string;
}

/**
 * Derives the {@link SesSettings} for a forum from the validated, expanded
 * model. The host is `email-smtp.<region>.amazonaws.com`, the port is 587
 * (STARTTLS), and the username/password live in the two reserved
 * `/community-hub/<env>/<forumId>/ses-smtp-*` parameters.
 *
 * @param environment - The validated environment block.
 * @param forum - The validated, expanded forum.
 * @returns The derived SES settings; parameter names only, never values.
 */
export function sesSettings(environment: EnvironmentModel, forum: ForumModel): SesSettings {
  const prefix = forumParameterPrefix(environment.name, forum.id);
  return {
    host: `email-smtp.${environment.region}.amazonaws.com`,
    port: 587,
    senderAddress: forum.senderAddress,
    usernameParameter: `${prefix}/ses-smtp-username`,
    passwordParameter: `${prefix}/ses-smtp-password`,
  };
}
