import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/engines/registry.js';
import { loadMetadataFile } from '../../src/metadata/loader.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';
import { EnvironmentStack } from '../../src/infra/environment-stack.js';
import { names } from '../../src/infra/naming.js';

/**
 * End-to-end synthesis test for the committed `metadata/example.yaml` (task
 * 21.3). It loads the real example file through {@link loadMetadataFile} with
 * the default registry and builds one {@link EnvironmentStack} the same way
 * `bin/app.ts` does, then asserts the template synthesizes and carries the
 * expected top-level resources. The point is a guard that the committed example
 * keeps synthesizing end to end through the production path, not an exhaustive
 * resource assertion (that is covered by the construct tests).
 *
 * Asset bundling is disabled for the whole app via the `aws:cdk:bundling-stacks`
 * context (an empty list). The stack creates several `NodejsFunction`s (the
 * bootstrap broker plus three custom-resource providers); bundling them would
 * invoke esbuild at synth, which this test does not exercise. The entry paths
 * themselves are exercised by `cdk synth`, not here.
 */

/** Context key the CDK toolkit reads to decide which stacks to bundle assets for. */
const BUNDLING_STACKS = 'aws:cdk:bundling-stacks';

/** A concrete placeholder account so ARNs resolve to literals, never `Ref`s. */
const ACCOUNT = '123456789012';

/** Absolute path to the committed example metadata, resolved from this module. */
const EXAMPLE_PATH = path.resolve(__dirname, '..', '..', 'metadata', 'example.yaml');

/**
 * Load the example metadata and synthesize an {@link EnvironmentStack} for it
 * the same way `bin/app.ts` does, with asset bundling disabled.
 *
 * @returns the synthesized {@link Template} and the loaded model.
 */
function synthExample(): { template: Template; model: ValidatedModel } {
  const registry = createDefaultRegistry();
  const model = loadMetadataFile(EXAMPLE_PATH, registry);
  const app = new App({ context: { [BUNDLING_STACKS]: [] } });
  const stack = new EnvironmentStack(app, names.stack(model.environment.name), {
    model,
    registry,
    env: { account: ACCOUNT, region: model.environment.region },
  });
  return { template: Template.fromStack(stack), model };
}

describe('metadata/example.yaml end-to-end synthesis', () => {
  let template: Template;
  let model: ValidatedModel;

  beforeAll(() => {
    ({ template, model } = synthExample());
  });

  it('loads the committed example with two forums in route53 mode', () => {
    expect(model.forums).toHaveLength(2);
    expect(model.environment.dnsMode).toBe('route53');
  });

  it('synthesizes a template without throwing', () => {
    // beforeAll already synthesized; this asserts the template is usable.
    expect(template.toJSON()).toBeTypeOf('object');
  });

  it('creates one Lightsail instance and static IP per forum', () => {
    template.resourceCountIs('AWS::Lightsail::Instance', 2);
    template.resourceCountIs('AWS::Lightsail::StaticIp', 2);
  });

  it('creates the shared SES email identity', () => {
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
  });

  it('creates the public hosted zone for route53 mode', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
  });

  it('emits per-forum url and static-ip outputs for each forum', () => {
    const outputs = template.findOutputs('*');
    const outputText = JSON.stringify(outputs);
    for (const forum of model.forums) {
      expect(outputText).toContain(forum.id);
    }
    // The design emits a Url and a StaticIp output per forum; at least both ids
    // must appear among the stack outputs.
    expect(outputText).toContain('Url');
    expect(outputText).toContain('StaticIp');
  });
});
