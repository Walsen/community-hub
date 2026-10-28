import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';
import { EnvironmentStack } from '../../src/infra/environment-stack.js';
import { names } from '../../src/infra/naming.js';

/**
 * CDK assertion tests for the per-forum Lightsail resources an
 * {@link EnvironmentStack} creates (task 19.7). The fixture is the two-forum
 * example metadata (Discourse `main` + Flarum `dev`) in `route53` DNS mode.
 *
 * Lambda bundling is disabled for the whole app: the stack creates several
 * `NodejsFunction`s (the bootstrap broker plus three custom-resource providers)
 * which would invoke esbuild/Docker bundling at synth and fail in the
 * network-free test environment. Setting the `aws:cdk:bundling-stacks` context
 * to an empty list makes the toolkit skip bundling entirely, so `Template.fromStack`
 * synthesizes without touching the network.
 */

/** Context key the CDK toolkit reads to decide which stacks to bundle assets for. */
const BUNDLING_STACKS = 'aws:cdk:bundling-stacks';

const ENV = 'community-prod';
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const SSH_CIDR = '203.0.113.0/24';

/** The example metadata inline, so the test does not depend on reading a file. */
const METADATA_YAML = `
version: 1

environment:
  name: ${ENV}
  region: ${REGION}
  availabilityZone: us-east-1a
  dnsMode: route53
  rootDomain: example.org
  adminEmail: ops@example.org
  sshAllowedCidrs:
    - ${SSH_CIDR}
  snapshotTimeUtc: '06:00'
  mailDomain: example.org
  dmarcPolicy: none
  acmeStaging: false

forums:
  - id: main
    engine: discourse
    subdomain: forum
    bundleId: medium_3_0
    senderAddress: noreply
    credentialRotation: 0
    secrets:
      adminPassword: ssm:/community-hub/${ENV}/main/admin-password
      apiKey: ssm:/community-hub/${ENV}/main/api-key
    engineOptions: {}

  - id: dev
    engine: flarum
    subdomain: dev
    bundleId: small_3_0
    senderAddress: dev-forum@example.org
    credentialRotation: 0
    secrets:
      adminPassword: ssm:/community-hub/${ENV}/dev/admin-password
      apiKey: ssm:/community-hub/${ENV}/dev/api-key
      databasePassword: ssm:/community-hub/${ENV}/dev/database-password
    engineOptions:
      trustLevelGroups:
        '0': members
        '3': veterans
`;

/**
 * Synthesize an {@link EnvironmentStack} for the given YAML with asset bundling
 * disabled, and return its {@link Template}. A concrete `env` is passed so ARNs
 * resolve to literals (not `Ref`s) in the assertions.
 */
function synth(yaml: string): { template: Template; stack: Stack } {
  const registry = createDefaultRegistry();
  const model: ValidatedModel = loadMetadata(yaml, registry);
  const app = new App({ context: { [BUNDLING_STACKS]: [] } });
  const stack = new EnvironmentStack(app, names.stack(model.environment.name), {
    model,
    registry,
    env: { account: ACCOUNT, region: REGION },
  });
  return { template: Template.fromStack(stack), stack };
}

describe('ForumInstance CDK resources (Discourse + Flarum, route53)', () => {
  let template: Template;

  beforeAll(() => {
    template = synth(METADATA_YAML).template;
  });

  describe('resource counts', () => {
    it('creates exactly one Lightsail instance per forum', () => {
      template.resourceCountIs('AWS::Lightsail::Instance', 2);
    });

    it('creates exactly one static IP per forum', () => {
      template.resourceCountIs('AWS::Lightsail::StaticIp', 2);
    });

    it('creates exactly one node IAM role per forum', () => {
      // Two forum node roles, each carrying the forum tag. The custom-resource
      // provider Lambdas also create roles, so count only the tagged node roles.
      const roles = template.findResources('AWS::IAM::Role', {
        Properties: {
          Tags: Match.arrayWith([{ Key: 'community-hub:forum', Value: Match.anyValue() }]),
        },
      });
      expect(Object.keys(roles)).toHaveLength(2);
    });
  });

  describe('deterministic names', () => {
    it('names each instance ${env}-${forumId}-instance', () => {
      template.hasResourceProperties('AWS::Lightsail::Instance', {
        InstanceName: names.instance(ENV, 'main'),
      });
      template.hasResourceProperties('AWS::Lightsail::Instance', {
        InstanceName: names.instance(ENV, 'dev'),
      });
    });

    it('names each static IP ${env}-${forumId}-ip and carries env + forum id in the name', () => {
      for (const forumId of ['main', 'dev']) {
        const expected = names.staticIp(ENV, forumId);
        template.hasResourceProperties('AWS::Lightsail::StaticIp', { StaticIpName: expected });
        // Static IPs are untaggable, so the Environment name and forum id must be
        // recoverable from the deterministic name itself.
        expect(expected).toContain(ENV);
        expect(expected).toContain(forumId);
      }
    });

    it('names each node role ${env}-${forumId}-node', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: names.nodeRole(ENV, 'main'),
      });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: names.nodeRole(ENV, 'dev'),
      });
    });
  });

  describe('firewall port rules', () => {
    it('opens HTTP 80 and HTTPS 443 to the world over IPv4 and IPv6 on every instance', () => {
      for (const port of [80, 443]) {
        template.hasResourceProperties('AWS::Lightsail::Instance', {
          Networking: {
            Ports: Match.arrayWith([
              Match.objectLike({
                FromPort: port,
                ToPort: port,
                Protocol: 'tcp',
                Cidrs: ['0.0.0.0/0'],
                Ipv6Cidrs: ['::/0'],
              }),
            ]),
          },
        });
      }
    });

    it('opens SSH 22 only to the declared CIDRs', () => {
      const instances = template.findResources('AWS::Lightsail::Instance');
      const instanceList = Object.values(instances);
      expect(instanceList).toHaveLength(2);
      for (const instance of instanceList) {
        const ports = (
          instance.Properties as {
            Networking: { Ports: Array<Record<string, unknown>> };
          }
        ).Networking.Ports;
        const sshRules = ports.filter((p) => p.FromPort === 22);
        expect(sshRules).toHaveLength(1);
        const [ssh] = sshRules;
        expect(ssh?.Protocol).toBe('tcp');
        expect(ssh?.ToPort).toBe(22);
        expect(ssh?.Cidrs).toEqual([SSH_CIDR]);
        // SSH never opens to the world.
        expect(JSON.stringify(ssh)).not.toContain('0.0.0.0/0');
      }
    });
  });

  describe('AutoSnapshot add-on', () => {
    it('enables the daily AutoSnapshot add-on at the declared snapshot time on every instance', () => {
      const instances = template.findResources('AWS::Lightsail::Instance');
      for (const instance of Object.values(instances)) {
        template.hasResourceProperties('AWS::Lightsail::Instance', {
          InstanceName: (instance.Properties as { InstanceName: string }).InstanceName,
          AddOns: Match.arrayWith([
            Match.objectLike({
              AddOnType: 'AutoSnapshot',
              Status: 'Enabled',
              AutoSnapshotAddOnRequest: { SnapshotTimeOfDay: '06:00' },
            }),
          ]),
        });
      }
    });
  });

  describe('lifecycle custom resource', () => {
    it('makes each forum lifecycle resource depend on its instance', () => {
      const instances = template.findResources('AWS::Lightsail::Instance');
      const instanceLogicalIds = Object.keys(instances);
      expect(instanceLogicalIds).toHaveLength(2);

      // The lifecycle custom resources are AWS::CloudFormation::CustomResource
      // whose serviceToken points at the shared lifecycle provider. Each must
      // DependsOn a Lightsail instance.
      const customResources = template.findResources('AWS::CloudFormation::CustomResource');
      const lifecycleResources = Object.entries(customResources).filter(([, cr]) => {
        const props = cr.Properties as Record<string, unknown>;
        return 'instanceName' in props;
      });
      expect(lifecycleResources).toHaveLength(2);

      for (const [, cr] of lifecycleResources) {
        const dependsOn = (cr as { DependsOn?: string[] }).DependsOn ?? [];
        const dependsOnInstance = dependsOn.some((d) => instanceLogicalIds.includes(d));
        expect(dependsOnInstance, 'lifecycle CR should DependsOn its instance').toBe(true);
      }
    });

    it('grants the lifecycle provider lightsail:TagResource for the tagged final snapshot', () => {
      // Regression: the handler creates the final snapshot WITH env/forum tags,
      // and Lightsail requires lightsail:TagResource for tag-on-create. Omitting
      // it made a live `cdk destroy` fail with AccessDeniedException.
      const policies = template.findResources('AWS::IAM::Policy');
      const lifecyclePolicies = Object.values(policies).filter((pol) => {
        const doc = (pol.Properties as { PolicyDocument: { Statement: { Sid?: string }[] } })
          .PolicyDocument;
        return doc.Statement.some((st) => st.Sid === 'ForumLifecycle');
      });
      expect(lifecyclePolicies.length).toBeGreaterThanOrEqual(1);
      for (const pol of lifecyclePolicies) {
        const doc = (
          pol.Properties as {
            PolicyDocument: { Statement: { Sid?: string; Action: string[] }[] };
          }
        ).PolicyDocument;
        const stmt = doc.Statement.find((st) => st.Sid === 'ForumLifecycle');
        expect(stmt?.Action).toContain('lightsail:CreateInstanceSnapshot');
        expect(stmt?.Action).toContain('lightsail:TagResource');
      }
    });
  });

  describe('node role policy scoping', () => {
    it('scopes reads to the forum prefix with an explicit deny and no SourceIp condition', () => {
      const prefixArnFragment = (forumId: string): string =>
        `:parameter/community-hub/${ENV}/${forumId}/*`;

      for (const forumId of ['main', 'dev']) {
        const roles = template.findResources('AWS::IAM::Role', {
          Properties: { RoleName: names.nodeRole(ENV, forumId) },
        });
        const roleList = Object.values(roles);
        expect(roleList, `node role for ${forumId}`).toHaveLength(1);
        const [role] = roleList;

        const policyDoc = (
          role?.Properties as {
            Policies: Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }>;
          }
        ).Policies[0]?.PolicyDocument;
        const statements = policyDoc?.Statement ?? [];
        const serialized = JSON.stringify(statements);

        // Scoped to the forum's own prefix.
        expect(serialized).toContain(prefixArnFragment(forumId));

        // No aws:SourceIp condition on the read statements: a Lightsail instance
        // egresses from a NAT address that is not its static IP, so an IP
        // condition would deny every legitimate call. Least privilege is the
        // exact prefix ARN plus the explicit deny below.
        const readStatement = statements.find((s) => s.Sid === 'ReadForumParameters');
        expect(readStatement?.Condition).toBeUndefined();
        expect(serialized).not.toContain('aws:SourceIp');

        // An explicit Deny with NotResource guards reads outside the prefix.
        const denyStatement = statements.find((s) => s.Sid === 'DenyReadOutsidePrefix');
        expect(denyStatement?.Effect).toBe('Deny');
        expect(denyStatement).toHaveProperty('NotResource');

        // No AmazonSSMManagedInstanceCore managed policy on the node role.
        const managedArns = (role?.Properties as { ManagedPolicyArns?: unknown }).ManagedPolicyArns;
        expect(JSON.stringify(managedArns ?? [])).not.toContain('AmazonSSMManagedInstanceCore');
      }
    });
  });

  describe('tags on taggable resources', () => {
    it('tags each instance with the environment and forum', () => {
      for (const forumId of ['main', 'dev']) {
        template.hasResourceProperties('AWS::Lightsail::Instance', {
          InstanceName: names.instance(ENV, forumId),
          Tags: Match.arrayWith([
            { Key: 'community-hub:environment', Value: ENV },
            { Key: 'community-hub:forum', Value: forumId },
          ]),
        });
      }
    });

    it('tags each node role with the environment and forum', () => {
      for (const forumId of ['main', 'dev']) {
        template.hasResourceProperties('AWS::IAM::Role', {
          RoleName: names.nodeRole(ENV, forumId),
          Tags: Match.arrayWith([
            { Key: 'community-hub:environment', Value: ENV },
            { Key: 'community-hub:forum', Value: forumId },
          ]),
        });
      }
    });

    it('does not attempt to tag the untaggable static IPs', () => {
      const staticIps = template.findResources('AWS::Lightsail::StaticIp');
      for (const ip of Object.values(staticIps)) {
        expect(ip.Properties).not.toHaveProperty('Tags');
      }
    });
  });

  describe('per-forum outputs', () => {
    it('emits the core per-forum outputs for both forums', () => {
      const outputs = template.findOutputs('*');
      const outputValues = JSON.stringify(outputs);

      // Each forum emits ForumId, Engine, Url, StaticIp, InstanceName,
      // SenderAddress, TlsChallenge and EmailRefreshStatus under Forum-<id>.
      for (const forumId of ['main', 'dev']) {
        const forumOutputs = Object.keys(outputs).filter((k) => k.includes(`Forum${forumId}`));
        // ForumId, Engine, Url, StaticIp, InstanceName, SenderAddress,
        // TlsChallenge, EmailRefreshStatus = 8 outputs per forum.
        expect(forumOutputs.length, `outputs for ${forumId}`).toBeGreaterThanOrEqual(8);
      }

      // The instance names appear in the outputs (InstanceName output).
      expect(outputValues).toContain(names.instance(ENV, 'main'));
      expect(outputValues).toContain(names.instance(ENV, 'dev'));
    });
  });
});

describe('ForumInstance AutoSnapshot default time', () => {
  it('uses the default 06:00 snapshot time when snapshotTimeUtc is omitted', () => {
    const yamlWithoutSnapshotTime = METADATA_YAML.replace(/\n {2}snapshotTimeUtc: '06:00'/, '');
    const { template } = synth(yamlWithoutSnapshotTime);
    const instances = template.findResources('AWS::Lightsail::Instance');
    expect(Object.keys(instances)).toHaveLength(2);
    for (const instance of Object.values(instances)) {
      const addOns = (
        instance.Properties as {
          AddOns: Array<{
            AddOnType: string;
            AutoSnapshotAddOnRequest?: { SnapshotTimeOfDay?: string };
          }>;
        }
      ).AddOns;
      const autoSnapshot = addOns.find((a) => a.AddOnType === 'AutoSnapshot');
      expect(autoSnapshot?.AutoSnapshotAddOnRequest?.SnapshotTimeOfDay).toBe('06:00');
    }
  });
});
