/**
 * Deterministic resource names and construct IDs for the infrastructure layer.
 *
 * Every name derives purely from the Environment name and forum id, so adding
 * or removing one forum never renames another forum's resources (Req 12.12).
 * Environment names match `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` and forum ids are
 * narrowed to `^[a-z][a-z0-9]{0,19}$` (hyphen-free). A hyphen-free forum id and
 * a fixed resource suffix make `${env}-${forumId}-<resource>` decode uniquely,
 * so two Environments never collide (Req 3.6). These are pure functions with no
 * I/O.
 */

/**
 * Resource names for AWS resources created per Environment and per forum. Each
 * entry is a pure function of its inputs.
 */
export const names = {
  /** CloudFormation stack name for an Environment. */
  stack: (env: string): string => `community-hub-${env}`,
  /** Lightsail instance name for a forum. */
  instance: (env: string, forumId: string): string => `${env}-${forumId}-instance`,
  /** Lightsail static IP name for a forum. */
  staticIp: (env: string, forumId: string): string => `${env}-${forumId}-ip`,
  /** IAM node role name for a forum's SSM hybrid managed node. Stays ≤ 59 chars. */
  nodeRole: (env: string, forumId: string): string => `${env}-${forumId}-node`,
  /** SSM hybrid activation name for a forum. */
  activationName: (env: string, forumId: string): string => `${env}-${forumId}`,
  /** Final manual snapshot name for a forum, taken before the instance is deleted. */
  finalSnapshot: (env: string, forumId: string, utc: string): string =>
    `${env}-${forumId}-final-${utc}`,
  /** Per-Environment bootstrap broker name. */
  broker: (env: string): string => `${env}-bootstrap-broker`,
  /** IAM user name for a forum's SES sender. Stays ≤ 57 chars (IAM limit 64). */
  sesUser: (env: string, forumId: string): string => `${env}-${forumId}-ses`,
  /** IAM path prefix for an Environment's SES users. */
  sesUserPath: (env: string): string => `/community-hub/${env}/`,
  /** SES default configuration set name for an Environment. */
  configurationSet: (env: string): string => `${env}-email`,
  /** SNS topic name for an Environment's SES bounce/complaint events. */
  emailTopic: (env: string): string => `${env}-email-events`,
  /**
   * SSM SecureString parameter name holding a forum's SES SMTP username or
   * password. These two names are reserved for the Platform.
   */
  sesParameter: (env: string, forumId: string, kind: 'password' | 'username'): string =>
    `/community-hub/${env}/${forumId}/ses-smtp-${kind}`,
  /**
   * Physical id for a forum's SES credentials custom resource. Encodes the
   * rotation counter and access key id so a rotation replaces the resource.
   */
  sesCredentialsPhysicalId: (
    env: string,
    forumId: string,
    counter: number,
    accessKeyId: string,
  ): string => `${env}-${forumId}-ses-r${counter}-${accessKeyId}`,
} as const;

/**
 * Stable construct IDs. Record construct IDs depend only on the forum id or the
 * fixed email record id, so adding or removing a forum never renames another
 * forum's record (Req 12.12).
 */
export const constructIds = {
  /** Construct id for a forum, relative to the stack. */
  forum: (forumId: string): string => `Forum-${forumId}`,
  /** Construct id for a forum's A record, relative to `Forum-<forumId>`. */
  forumARecord: 'Dns/A',
  /**
   * Construct id for an email DNS record, relative to `Email`.
   * @param id an `EmailDnsRecord` id (typed as `string` until email-dns-records.ts exists).
   */
  emailRecord: (id: string): string => `Dns/${id}`,
  /** Construct id for the hosted zone, relative to the stack. */
  zone: 'Dns/Zone',
} as const;
