/**
 * Unit tests for the Metadata_Loader ({@link loadMetadata},
 * {@link loadMetadataFile}).
 *
 * These exercise the loader end to end against a `testengine`-only
 * {@link EngineRegistry}: a minimal valid document parses and expands; each
 * schema, cross-field, mail, DNS, bundle and secret rule reports an issue at the
 * right path without echoing any secret value; YAML parse errors are reported by
 * code and position without quoting source; and the returned model is frozen and
 * deterministic.
 *
 * Secret-bearing fields use only obvious placeholders (never realistic secrets).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError, type ValidationIssue } from '../../src/metadata/errors.js';
import { loadMetadata, loadMetadataFile } from '../../src/metadata/loader.js';
import { createTestEngine } from '../support/testengine.js';

/** The registry the loader validates against: one `testengine` adapter (minRam 512). */
const registry = new EngineRegistry([createTestEngine()]);

/** A registry whose engine demands 4096 MB, used for the "bundle too small" case. */
const bigRamRegistry = new EngineRegistry([createTestEngine({ minRamMb: 4096 })]);

/** An obvious placeholder secret value that must never leak into an issue message. */
const INLINE_SECRET = 'test-secret-value';

/** Path to the on-disk minimal valid fixture, relative to this test file. */
const VALID_FIXTURE = join(__dirname, '..', 'fixtures', 'metadata', 'valid-minimal.yaml');

/** A deep-mutable raw environment block used to build test documents. */
interface RawEnv {
  name: string;
  region: string;
  availabilityZone: string;
  dnsMode: string;
  hostedZoneId?: string;
  rootDomain: string;
  adminEmail: string;
  sshAllowedCidrs: string[];
  snapshotTimeUtc?: string;
  mailDomain?: string;
  dmarcPolicy?: string;
  acmeStaging?: boolean;
}

/** A deep-mutable raw forum block used to build test documents. */
interface RawForum {
  id: string;
  engine: string;
  subdomain: string;
  bundleId: string;
  senderAddress: string;
  credentialRotation?: number;
  secrets: Record<string, string>;
  config?: Record<string, unknown>;
  engineOptions?: unknown;
}

/** A deep-mutable raw document used to build test documents. */
interface RawDoc {
  version: number;
  environment: RawEnv;
  forums: RawForum[];
}

/** A fresh, minimal valid environment for `community-test`. */
function baseEnv(): RawEnv {
  return {
    name: 'community-test',
    region: 'us-east-1',
    availabilityZone: 'us-east-1a',
    dnsMode: 'route53',
    rootDomain: 'example.org',
    adminEmail: 'ops@example.org',
    sshAllowedCidrs: ['203.0.113.0/24'],
  };
}

/** A fresh, minimal valid forum with the given id and secret prefix. */
function baseForum(id = 'main'): RawForum {
  const prefix = `/community-hub/community-test/${id}/`;
  return {
    id,
    engine: 'testengine',
    subdomain: id === 'main' ? 'forum' : id,
    bundleId: 'small_3_0',
    senderAddress: 'noreply',
    secrets: {
      adminPassword: `ssm:${prefix}admin-password`,
      apiKey: `ssm:${prefix}api-key`,
    },
  };
}

/** A fresh, minimal valid raw document. */
function baseDoc(): RawDoc {
  return {
    version: 1,
    environment: baseEnv(),
    forums: [baseForum()],
  };
}

/** Load a raw document (serialized to YAML) against the default registry. */
function load(doc: RawDoc, reg: EngineRegistry = registry): ReturnType<typeof loadMetadata> {
  return loadMetadata(stringify(doc), reg);
}

/**
 * Load a document expected to fail and return the collected issues. Fails the
 * test if the loader did not throw a {@link MetadataValidationError}.
 */
function loadIssues(doc: RawDoc, reg: EngineRegistry = registry): readonly ValidationIssue[] {
  try {
    load(doc, reg);
  } catch (err) {
    expect(err).toBeInstanceOf(MetadataValidationError);
    return (err as MetadataValidationError).issues;
  }
  throw new Error('expected loadMetadata to throw MetadataValidationError');
}

/** Whether any issue targets the given exact path. */
function hasIssueAt(issues: readonly ValidationIssue[], path: string): boolean {
  return issues.some((issue) => issue.path === path);
}

describe('loadMetadata', () => {
  describe('valid document', () => {
    it('parses a minimal valid document against the testengine registry', () => {
      const model = load(baseDoc());

      expect(model.environment.name).toBe('community-test');
      expect(model.environment.dnsMode).toBe('route53');
      expect(model.forums).toHaveLength(1);
      const forum = model.forums[0]!;
      expect(forum.id).toBe('main');
      expect(forum.engine).toBe('testengine');
      // Secret references are parsed into { store, id }.
      expect(forum.secrets.adminPassword).toEqual({
        store: 'ssm',
        id: '/community-hub/community-test/main/admin-password',
      });
      // Bare local part sender expanded against the default mail domain.
      expect(forum.senderAddress).toBe('noreply@example.org');
    });
  });

  describe('schema error paths', () => {
    it('rejects an unknown top-level key (strictObject)', () => {
      const doc = baseDoc() as RawDoc & { bogusTopLevel?: unknown };
      doc.bogusTopLevel = true;

      expect(() => load(doc)).toThrow(MetadataValidationError);
    });

    it('rejects a legacy top-level smtp block as an unknown key', () => {
      const doc = baseDoc() as RawDoc & { smtp?: unknown };
      doc.smtp = { host: 'smtp.example.org', port: 587 };

      expect(() => load(doc)).toThrow(MetadataValidationError);
    });

    it('rejects an invalid dnsMode enum value (lightsail)', () => {
      const doc = baseDoc();
      doc.environment.dnsMode = 'lightsail';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.dnsMode')).toBe(true);
    });

    it('rejects a snapshot hour that is not on the hour (06:30)', () => {
      const doc = baseDoc();
      doc.environment.snapshotTimeUtc = '06:30';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.snapshotTimeUtc')).toBe(true);
    });

    it('rejects a malformed CIDR', () => {
      const doc = baseDoc();
      doc.environment.sshAllowedCidrs = ['not-a-cidr'];

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.sshAllowedCidrs[0]')).toBe(true);
    });

    it('rejects an invalid dmarcPolicy', () => {
      const doc = baseDoc();
      doc.environment.dmarcPolicy = 'block';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.dmarcPolicy')).toBe(true);
    });
  });

  describe('cross-field: duplicates', () => {
    it('rejects a duplicate forum id and names the value', () => {
      const doc = baseDoc();
      const second = baseForum('main');
      second.subdomain = 'other';
      second.senderAddress = 'noreply2';
      doc.forums.push(second);

      const issues = loadIssues(doc);
      const dup = issues.find((issue) => issue.path === 'forums[1].id');
      expect(dup).toBeDefined();
      expect(dup!.message).toContain('main');
    });

    it('rejects a duplicate subdomain and names the value', () => {
      const doc = baseDoc();
      const second = baseForum('secondary');
      second.subdomain = 'forum'; // collides with main
      second.senderAddress = 'noreply2';
      doc.forums.push(second);

      const issues = loadIssues(doc);
      const dup = issues.find((issue) => issue.path === 'forums[1].subdomain');
      expect(dup).toBeDefined();
      expect(dup!.message).toContain('forum');
    });
  });

  describe('engine resolution', () => {
    it('rejects an unknown engine at forums[i].engine naming the id', () => {
      const doc = baseDoc();
      doc.forums[0]!.engine = 'xenforo';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].engine');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('xenforo');
    });
  });

  describe('secret hygiene', () => {
    it('rejects an inline secret without echoing the value', () => {
      const doc = baseDoc();
      doc.forums[0]!.secrets.adminPassword = INLINE_SECRET;

      const issues = loadIssues(doc);
      // Reported at the secret field path by the schema's secretRefSchema.
      expect(hasIssueAt(issues, 'forums[0].secrets.adminPassword')).toBe(true);
      // The placeholder value must never appear in any issue message.
      for (const issue of issues) {
        expect(issue.message).not.toContain(INLINE_SECRET);
        expect(issue.path).not.toContain(INLINE_SECRET);
      }
    });

    it('rejects a reference outside the forum prefix', () => {
      const doc = baseDoc();
      doc.forums[0]!.secrets.adminPassword =
        'ssm:/community-hub/community-test/other/admin-password';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].secrets.adminPassword');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('/community-hub/community-test/main/');
    });

    it('rejects a reserved ses-smtp-password name', () => {
      const doc = baseDoc();
      doc.forums[0]!.secrets.smtpPass = 'ssm:/community-hub/community-test/main/ses-smtp-password';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].secrets.smtpPass');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('ses-smtp-password');
    });

    it('rejects a reserved ses-smtp-username name', () => {
      const doc = baseDoc();
      doc.forums[0]!.secrets.smtpUser = 'ssm:/community-hub/community-test/main/ses-smtp-username';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].secrets.smtpUser');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('ses-smtp-username');
    });
  });

  describe('bundle sizing', () => {
    it('rejects an unknown bundle id and lists the known ids', () => {
      const doc = baseDoc();
      doc.forums[0]!.bundleId = 'jumbo_9_9';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].bundleId');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('jumbo_9_9');
      expect(issue!.message).toContain('small_3_0');
    });

    it('rejects a bundle below the engine minimum RAM and states the required MB', () => {
      // micro_3_0 is 1024 MB; the big-RAM engine requires 4096 MB.
      const doc = baseDoc();
      doc.forums[0]!.bundleId = 'micro_3_0';

      const issues = loadIssues(doc, bigRamRegistry);
      const issue = issues.find((i) => i.path === 'forums[0].bundleId');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('4096 MB');
    });
  });

  describe('mail rules', () => {
    it('rejects a mail domain outside the root domain', () => {
      const doc = baseDoc();
      doc.environment.mailDomain = 'mail.other.org';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.mailDomain')).toBe(true);
    });

    it('rejects a sender domain mismatch naming both domains', () => {
      const doc = baseDoc();
      // Full address on a different domain than the mail domain (example.org).
      doc.forums[0]!.senderAddress = 'noreply@elsewhere.org';

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[0].senderAddress');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('elsewhere.org');
      expect(issue!.message).toContain('example.org');
    });

    it('expands a bare local-part sender against the mail domain', () => {
      const doc = baseDoc();
      doc.environment.mailDomain = 'mail.example.org';
      doc.forums[0]!.senderAddress = 'Hello';

      const model = load(doc);
      expect(model.forums[0]!.senderAddress).toBe('hello@mail.example.org');
    });

    it('rejects duplicate expanded sender addresses', () => {
      const doc = baseDoc();
      const second = baseForum('secondary');
      second.subdomain = 'two';
      second.senderAddress = 'noreply'; // expands to the same address as main
      doc.forums.push(second);

      const issues = loadIssues(doc);
      const issue = issues.find((i) => i.path === 'forums[1].senderAddress');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('noreply@example.org');
    });
  });

  describe('hostedZoneId rules', () => {
    it('requires hostedZoneId when dnsMode is route53-existing', () => {
      const doc = baseDoc();
      doc.environment.dnsMode = 'route53-existing';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.hostedZoneId')).toBe(true);
    });

    it('forbids hostedZoneId when dnsMode is route53', () => {
      const doc = baseDoc();
      doc.environment.hostedZoneId = 'Z0123456789ABCDEFGHIJ';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.hostedZoneId')).toBe(true);
    });

    it('forbids hostedZoneId when dnsMode is external', () => {
      const doc = baseDoc();
      doc.environment.dnsMode = 'external';
      doc.environment.hostedZoneId = 'Z0123456789ABCDEFGHIJ';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.hostedZoneId')).toBe(true);
    });

    it('rejects a malformed hostedZoneId (bad regex)', () => {
      const doc = baseDoc();
      doc.environment.dnsMode = 'route53-existing';
      doc.environment.hostedZoneId = 'not-a-zone-id';

      const issues = loadIssues(doc);
      expect(hasIssueAt(issues, 'environment.hostedZoneId')).toBe(true);
    });
  });

  describe('defaults', () => {
    it('applies dmarcPolicy none, acmeStaging false and snapshotTimeUtc 06:00', () => {
      const model = load(baseDoc());

      expect(model.environment.dmarcPolicy).toBe('none');
      expect(model.environment.acmeStaging).toBe(false);
      expect(model.environment.snapshotTimeUtc).toBe('06:00');
    });
  });

  describe('YAML parse errors', () => {
    it('reports a parse error with code and line/column and omits source text', () => {
      // Unterminated flow mapping is a syntax error, not a schema error.
      const brokenSource = 'version: 1\nenvironment: { name: community-test';

      let issues: readonly ValidationIssue[] | undefined;
      try {
        loadMetadata(brokenSource, registry);
      } catch (err) {
        expect(err).toBeInstanceOf(MetadataValidationError);
        issues = (err as MetadataValidationError).issues;
      }
      expect(issues).toBeDefined();
      expect(issues!.length).toBeGreaterThan(0);

      const message = issues![0]!.message;
      // Position info present.
      expect(message).toMatch(/line \d+, column \d+/);
      // No source text quoted.
      expect(message).not.toContain('community-test');
      expect(message).not.toContain('environment');
    });
  });

  describe('frozen and deterministic', () => {
    it('returns a deep-frozen model', () => {
      const model = load(baseDoc());

      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.environment)).toBe(true);
      expect(Object.isFrozen(model.forums)).toBe(true);
      expect(Object.isFrozen(model.forums[0]!)).toBe(true);
      expect(Object.isFrozen(model.forums[0]!.secrets)).toBe(true);
    });

    it('is deterministic: same input yields deep-equal models', () => {
      const text = stringify(baseDoc());
      const first = loadMetadata(text, registry);
      const second = loadMetadata(text, registry);
      expect(second).toEqual(first);
    });
  });
});

describe('loadMetadataFile', () => {
  it('loads and validates a metadata file from disk', () => {
    const model = loadMetadataFile(VALID_FIXTURE, registry);

    expect(model.environment.name).toBe('community-test');
    expect(model.forums[0]!.id).toBe('main');
    expect(Object.isFrozen(model)).toBe(true);
  });

  it('produces the same model as loadMetadata on the same text', () => {
    const text = readFileSync(VALID_FIXTURE, 'utf8');

    expect(loadMetadataFile(VALID_FIXTURE, registry)).toEqual(loadMetadata(text, registry));
  });
});
