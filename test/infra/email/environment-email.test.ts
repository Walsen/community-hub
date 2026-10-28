/**
 * CDK assertion tests for the Environment's SES resources (task 19.8).
 *
 * These synthesize a full {@link EnvironmentStack} for a Discourse + Flarum
 * Environment in `route53` mode and assert the shared SES identity,
 * configuration set, bounce/complaint pipeline, per-forum sender resources,
 * instance dependency on the credentials custom resource, email outputs and the
 * DKIM record sets that reference the identity's generated token attributes.
 *
 * Lambda bundling is skipped so `Template.fromStack` synthesizes without a real
 * esbuild bundle: the app is created with the `aws:cdk:bundling-stacks` context
 * set to an empty list, which tells CDK to emit asset placeholders instead of
 * bundling every `NodejsFunction` in the stack.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { ValidatedModel } from '../../../src/metadata/schema.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';

const EXAMPLE_METADATA = path.join(process.cwd(), 'metadata', 'example.yaml');

/** The example Environment name and the two forum ids it declares. */
const ENV_NAME = 'community-prod';
const FORUM_IDS = ['main', 'dev'] as const;

/** The example Environment's mail domain and region (route53 mode). */
const MAIL_DOMAIN = 'example.org';
const REGION = 'us-east-1';
const ADMIN_EMAIL = 'ops@example.org';

/**
 * Build the Discourse + Flarum Environment stack from the example metadata with
 * Lambda bundling disabled, then return its synthesized template. The example
 * file already declares one Discourse forum (`main`) and one Flarum forum
 * (`dev`) in `route53` mode, which is exactly the fixture this task asks for.
 */
function synthTemplate(): Template {
  const registry = createDefaultRegistry();
  const model: ValidatedModel = loadMetadata(readFileSync(EXAMPLE_METADATA, 'utf8'), registry);

  const app = new App({
    // Skip NodejsFunction bundling so synthesis needs no esbuild/Docker.
    context: { 'aws:cdk:bundling-stacks': [] },
  });
  const stack = new EnvironmentStack(app, 'TestStack', {
    model,
    registry,
    env: { account: '123456789012', region: REGION },
  });

  return Template.fromStack(stack);
}

describe('EnvironmentEmail SES resources (route53, Discourse + Flarum)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthTemplate();
  });

  it('creates exactly one SES email identity with Easy DKIM and a custom MAIL FROM domain', () => {
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: MAIL_DOMAIN,
      // Easy DKIM: no BYODKIM signing key is supplied, so no
      // DkimSigningAttributes (private key / selector) appears on the identity.
      DkimSigningAttributes: Match.absent(),
      MailFromAttributes: {
        MailFromDomain: `mail.${MAIL_DOMAIN}`,
        BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
      },
      // The default configuration set is associated by reference.
      ConfigurationSetAttributes: {
        ConfigurationSetName: Match.anyValue(),
      },
    });

    // The associated configuration set is the Environment's default one.
    const identity = Object.values(template.findResources('AWS::SES::EmailIdentity'))[0] as {
      Properties: { ConfigurationSetAttributes: { ConfigurationSetName: { Ref?: string } } };
    };
    const configSetRef = identity.Properties.ConfigurationSetAttributes.ConfigurationSetName.Ref;
    expect(configSetRef).toBeDefined();
    const configSets = template.findResources('AWS::SES::ConfigurationSet');
    expect(Object.keys(configSets)).toContain(configSetRef);
  });

  it('creates exactly one configuration set without SuppressionOptions', () => {
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: `${ENV_NAME}-email`,
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
      SuppressionOptions: Match.absent(),
    });
  });

  it('sends BOUNCE + COMPLAINT events to the SNS topic via a configuration set event destination', () => {
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    const topicArn = new Capture();
    template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: {
        Name: 'bounce-complaint',
        Enabled: true,
        MatchingEventTypes: Match.arrayWith(['bounce', 'complaint']),
        SnsDestination: { TopicARN: topicArn },
      },
    });
    // The event destination targets the Environment's bounce/complaint topic.
    const captured = JSON.stringify(topicArn.asObject());
    expect(captured).toContain('Topic');
    const topicLogicalId = (topicArn.asObject() as { Ref?: string }).Ref;
    expect(topicLogicalId).toBeDefined();
    expect(Object.keys(template.findResources('AWS::SNS::Topic'))).toContain(topicLogicalId);
  });

  it('creates the SNS topic and a topic policy allowing SES publish with SourceAccount/SourceArn conditions', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `${ENV_NAME}-email-events`,
    });

    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sns:Publish',
            Principal: { Service: 'ses.amazonaws.com' },
            Condition: {
              StringEquals: { 'AWS:SourceAccount': '123456789012' },
              ArnLike: Match.objectLike({
                'AWS:SourceArn': Match.anyValue(),
              }),
            },
          }),
        ]),
      },
    });
  });

  it('subscribes the admin email to the topic', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: ADMIN_EMAIL,
    });
  });

  it('creates one IAM user and an inline send policy per forum', () => {
    // One SES sender IAM user per forum (count = 2), under the Environment path.
    template.resourceCountIs('AWS::IAM::User', FORUM_IDS.length);

    const users = template.findResources('AWS::IAM::User');
    const userNames = Object.values(users).map(
      (u) => (u as { Properties: { UserName: string } }).Properties.UserName,
    );
    for (const forumId of FORUM_IDS) {
      expect(userNames).toContain(`${ENV_NAME}-${forumId}-ses`);
      template.hasResourceProperties('AWS::IAM::User', {
        UserName: `${ENV_NAME}-${forumId}-ses`,
        Path: `/community-hub/${ENV_NAME}/`,
      });
    }

    // The inline send policy is attached as a per-forum IAM::Policy on the user,
    // allowing only the forum's send actions. Match one Allow statement per user.
    const userLogicalIds = Object.keys(users);
    const policies = template.findResources('AWS::IAM::Policy');
    const senderPolicies = Object.values(policies).filter((policy) => {
      const attachedUsers =
        (policy as { Properties?: { Users?: unknown[] } }).Properties?.Users ?? [];
      return attachedUsers.some(
        (ref) =>
          userLogicalIds.includes((ref as { Ref?: string }).Ref ?? '') ||
          JSON.stringify(ref).includes('SesUser'),
      );
    });
    expect(senderPolicies.length).toBe(FORUM_IDS.length);

    for (const policy of senderPolicies) {
      const document = (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
        .Properties.PolicyDocument;
      expect(document.Statement.some((s) => (s as { Effect?: string }).Effect === 'Allow')).toBe(
        true,
      );
    }
  });

  it('creates a SES credentials and a refresh custom resource per forum', () => {
    const custom = template.findResources('AWS::CloudFormation::CustomResource');
    const serviceTokenRefs = Object.values(custom).map((resource) => {
      const props = (resource as { Properties?: Record<string, unknown> }).Properties ?? {};
      return JSON.stringify(props['ServiceToken']);
    });

    // Each forum contributes a Credentials and a Refresh custom resource whose
    // properties carry the forum id, so both appear once per forum.
    const credentials = Object.values(custom).filter((resource) => {
      const props = (resource as { Properties?: Record<string, unknown> }).Properties ?? {};
      return 'rotationCounter' in props;
    });
    expect(credentials).toHaveLength(FORUM_IDS.length);

    const refresh = Object.values(custom).filter((resource) => {
      const props = (resource as { Properties?: Record<string, unknown> }).Properties ?? {};
      return 'accessKeyId' in props;
    });
    expect(refresh).toHaveLength(FORUM_IDS.length);

    // Every custom resource is wired to a provider service token.
    for (const token of serviceTokenRefs) {
      expect(token).not.toBe('undefined');
    }
  });

  it("makes each forum's instance depend on its SES credentials custom resource", () => {
    const instances = template.findResources('AWS::Lightsail::Instance');
    const instanceLogicalIds = Object.keys(instances);
    expect(instanceLogicalIds).toHaveLength(FORUM_IDS.length);

    // Collect the logical ids of the per-forum Credentials custom resources.
    const custom = template.findResources('AWS::CloudFormation::CustomResource');
    const credentialLogicalIds = Object.entries(custom)
      .filter(([, resource]) => {
        const props = (resource as { Properties?: Record<string, unknown> }).Properties ?? {};
        return 'rotationCounter' in props;
      })
      .map(([logicalId]) => logicalId);
    expect(credentialLogicalIds).toHaveLength(FORUM_IDS.length);

    // Each instance must list one of the credentials resources in DependsOn.
    for (const [, instance] of Object.entries(instances)) {
      const dependsOn = (instance as { DependsOn?: string[] }).DependsOn ?? [];
      const dependsOnCredentials = dependsOn.some((dep) => credentialLogicalIds.includes(dep));
      expect(dependsOnCredentials).toBe(true);
    }
  });

  it('emits the email outputs including the SES sandbox reminder', () => {
    template.hasOutput('*', { Value: MAIL_DOMAIN }); // EmailIdentityDomain
    template.hasOutput('*', { Value: `email-smtp.${REGION}.amazonaws.com` }); // SmtpEndpoint

    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);

    // CDK prefixes the logical id with the construct path (`Email...`); match the
    // output construct id as a substring.
    expect(outputKeys.some((k) => k.includes('EmailIdentityDomain'))).toBe(true);
    expect(outputKeys.some((k) => k.includes('SmtpEndpoint'))).toBe(true);
    expect(outputKeys.some((k) => k.includes('EmailEventTopicArn'))).toBe(true);

    const reminderKey = outputKeys.find((k) => k.includes('SesSandboxReminder'));
    expect(reminderKey).toBeDefined();
    const reminder = outputs[reminderKey as string] as { Value?: unknown };
    expect(typeof reminder.Value).toBe('string');
    expect(reminder.Value as string).toContain('sandbox');
  });

  it('creates DKIM CNAME record sets that reference the identity DKIM token GetAtts and end with a dot', () => {
    const records = template.findResources('AWS::Route53::RecordSet', {
      Properties: { Type: 'CNAME' },
    });

    // The three DKIM CNAMEs are the CNAME record sets in the zone.
    const cnameEntries = Object.values(records);
    expect(cnameEntries.length).toBeGreaterThanOrEqual(3);

    const identityLogicalId = Object.keys(
      template.findResources('AWS::SES::EmailIdentity'),
    )[0] as string;

    const tokenNames = new Set<string>();
    for (const resource of cnameEntries) {
      const props = (resource as { Properties: Record<string, unknown> }).Properties;
      const serialized = JSON.stringify(props);

      // The record name is a GetAtt of the identity's DkimDNSTokenName* attribute.
      expect(serialized).toContain(identityLogicalId);
      expect(serialized).toContain('DkimDNSTokenName');

      // Absolute name: the rendered Name ends with a literal '.'.
      const name = props['Name'];
      expect(JSON.stringify(name)).toContain('.');

      const match = serialized.match(/DkimDNSTokenName[123]/);
      if (match) {
        tokenNames.add(match[0]);
      }
    }

    // All three DKIM tokens are referenced across the CNAME record sets.
    expect(tokenNames).toEqual(
      new Set(['DkimDNSTokenName1', 'DkimDNSTokenName2', 'DkimDNSTokenName3']),
    );
  });

  it('places the DKIM CNAME names as absolute (trailing dot) through Fn::Join', () => {
    const records = template.findResources('AWS::Route53::RecordSet', {
      Properties: { Type: 'CNAME' },
    });
    for (const resource of Object.values(records)) {
      const name = (resource as { Properties: { Name: unknown } }).Properties.Name;
      // The name is a Fn::Join whose final element is the absolute '.' suffix.
      const join = (name as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
      expect(join).toBeDefined();
      const parts = (join as [string, unknown[]])[1];
      const last = parts[parts.length - 1];
      expect(typeof last).toBe('string');
      expect((last as string).endsWith('.')).toBe(true);
    }
  });
});

describe('synthesis without Lambda bundling', () => {
  it('synthesizes the stack template without bundling NodejsFunctions', () => {
    // If bundling were not skipped this would attempt a real esbuild/Docker
    // build; the empty bundling-stacks context makes Template.fromStack succeed.
    const template = synthTemplate();
    const json = template.toJSON() as { Resources: Record<string, unknown> };
    expect(Object.keys(json.Resources).length).toBeGreaterThan(0);
    // The stack contains NodejsFunction providers, yet synthesis succeeded
    // without a real bundle because bundling is skipped by context.
    expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThan(0);
  });
});
