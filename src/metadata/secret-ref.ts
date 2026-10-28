import { z } from 'zod';

/**
 * A parsed Secret_Reference. Carries the location of a secret in a
 * Secret_Store, never the secret value itself.
 */
export type SecretReference = {
  readonly store: 'ssm' | 'secretsmanager';
  readonly id: string;
};

/** `ssm:<parameter-name>` where the parameter name is an absolute SSM path. */
const SSM_RE = /^ssm:(\/[A-Za-z0-9_.\-/]{1,1010})$/;

/** `secretsmanager:<secret-name-or-arn>`. */
const SM_RE = /^secretsmanager:([A-Za-z0-9/_+=.@\-:]{1,2048})$/;

/**
 * Static validation message for {@link secretRefSchema}. It never contains the
 * offending value, so Zod issues produced from it cannot leak a secret.
 */
export const SECRET_REF_MESSAGE =
  'must be a Secret_Reference ("ssm:/path" or "secretsmanager:name-or-arn")';

/**
 * Parses a Secret_Reference string into its store and id. Returns `undefined`
 * for any string that is not a well-formed reference. Never echoes the input,
 * so a malformed value (which may be an inlined secret) cannot leak through the
 * return value.
 */
export function parseSecretReference(raw: string): SecretReference | undefined {
  const ssm = SSM_RE.exec(raw);
  if (ssm?.[1] !== undefined) {
    return { store: 'ssm', id: ssm[1] };
  }
  const sm = SM_RE.exec(raw);
  if (sm?.[1] !== undefined) {
    return { store: 'secretsmanager', id: sm[1] };
  }
  return undefined;
}

/** Inverse of {@link parseSecretReference}. */
export function formatSecretReference(ref: SecretReference): string {
  return `${ref.store}:${ref.id}`;
}

/**
 * The name portion of a Secret_Reference, used for secret-path prefix checks.
 * For SSM this is the parameter name. For Secrets Manager it is the secret
 * name, with any ARN prefix and the six-character random suffix stripped.
 */
export function secretName(ref: SecretReference): string {
  if (ref.store === 'ssm') {
    return ref.id;
  }
  // Secrets Manager id may be a bare name or a full ARN
  // (arn:aws:secretsmanager:<region>:<account>:secret:<name>-<suffix>).
  const arnMatch = /^arn:[^:]*:secretsmanager:[^:]*:[^:]*:secret:(.+)$/.exec(ref.id);
  const name = arnMatch?.[1] ?? ref.id;
  // Drop the trailing "-XXXXXX" random suffix AWS appends to ARNs.
  return name.replace(/-[A-Za-z0-9]{6}$/, '');
}

/**
 * Zod schema for a secret-bearing field. Accepts only well-formed
 * Secret_References and fails with a static message that never includes the
 * value, so validation issues cannot leak an inlined secret.
 */
export const secretRefSchema = z.string().transform((value, ctx): SecretReference => {
  const ref = parseSecretReference(value);
  if (ref === undefined) {
    ctx.addIssue({ code: 'custom', message: SECRET_REF_MESSAGE });
    return z.NEVER;
  }
  return ref;
});
