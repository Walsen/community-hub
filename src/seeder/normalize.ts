/**
 * Shared, pure normalizers for the Seeder.
 *
 * The reconciler compares declared (desired) attributes against the actual
 * forum state by Natural_Key. For that comparison to be meaningful, both sides
 * must be normalized the same way: {@link module:seeder/desired} normalizes
 * declared config and the engine seed clients normalize the values they read
 * back from the forum. These functions are the single definition of that
 * normalization ("Comparison semantics" in the data-model steering), so the two
 * sides cannot drift.
 *
 * Every function here is pure: no I/O, no clock, no randomness.
 */

/** Trims leading and trailing whitespace from a string. */
export function trimString(value: string): string {
  return value.trim();
}

/**
 * Normalizes a slug (e.g. a category slug): trimmed and lowercased, so
 * `"  Announcements "` and `"announcements"` compare equal.
 */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * Normalizes a username: trimmed and lowercased. Forums treat usernames
 * case-insensitively for identity, so this keeps declared and actual users
 * matched by the same key.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Normalizes an email address: trimmed and lowercased. The local part is
 * lowercased too; forums do not distinguish users by local-part case.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalizes a category colour to a bare uppercase six-digit hex value: trims,
 * strips a single leading `#`, and uppercases, so `"#0088cc"` and `"0088CC"`
 * compare equal. Input shape is validated upstream by the metadata schema; this
 * only canonicalizes casing and the optional `#`.
 */
export function normalizeColor(color: string): string {
  return color.trim().replace(/^#/, '').toUpperCase();
}

/**
 * Normalizes a membership list: each member normalized as a username, then the
 * list sorted and de-duplicated. The result is a stable, order-independent set
 * so declared and actual membership compare equal regardless of input order or
 * duplicates.
 */
export function sortMembers(members: readonly string[]): string[] {
  const normalized = new Set(members.map(normalizeUsername));
  return [...normalized].sort();
}
