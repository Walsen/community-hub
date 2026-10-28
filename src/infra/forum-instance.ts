/**
 * L3 construct for a single forum: its Lightsail instance, static IP, SSM node
 * role, first-boot user data, DNS A record, lifecycle resource and SES sender.
 *
 * Everything a forum needs at the infrastructure layer lives under the stable
 * construct id `Forum-<forumId>`, so adding or removing one forum touches only
 * that forum's resources (Req 3.6, 12.12). The construct wires the pure builders
 * and sibling constructs together in the order the dependencies require:
 *
 *  1. the {@link CfnStaticIp} is created first because the node role's policy and
 *     the user data are scoped to its address (`staticIp.attrIpAddress`). Static
 *     IPs are untaggable in Lightsail, so the resource is identified by its
 *     deterministic name only (Req 3.4);
 *  2. the {@link ForumNodeRole}, scoped to the forum's secret
 *     prefix and (for DNS-01) the forum's `_acme-challenge` record;
 *  3. the {@link CfnInstance} with the composed user data, firewall rules and a
 *     daily AutoSnapshot add-on at the Environment's snapshot hour;
 *  4. the static IP is attached to the instance with an explicit dependency;
 *  5. in the Route 53 modes, the forum's `A` record;
 *  6. the {@link CustomResource} lifecycle resource (shared provider) that takes
 *     a final manual snapshot before the instance is deleted (Req 3.7, 4.9);
 *  7. the {@link SesSender} sending identity, which the instance depends on so it
 *     never boots before its SMTP parameters exist (Req 11.x);
 *  8. the per-forum {@link CfnOutput}s.
 *
 * This construct makes no SDK calls at synth and no forum HTTP calls. No secret
 * value reaches user data, tags or outputs: the user data carries only
 * Secret_References, resolved on the instance (Req 13.6, 2.x).
 */

import { CfnOutput, CustomResource, Stack, Tags } from 'aws-cdk-lib';
import { CfnInstance, CfnStaticIp } from 'aws-cdk-lib/aws-lightsail';
import type { Provider } from 'aws-cdk-lib/custom-resources';
import type { ARecord } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import type {
  EngineAdapter,
  ForumSecretName,
  InstallScriptInput,
} from '../engines/engine-adapter.js';
import { sesSettings } from '../metadata/mail.js';
import type { EnvironmentModel, ForumModel } from '../metadata/schema.js';
import type { SecretReference } from '../metadata/secret-ref.js';

import type { EnvironmentDns } from './dns/environment-dns.js';
import { forumARecord } from './dns/records.js';
import type { EnvironmentEmail } from './email/environment-email.js';
import { SesSender } from './email/ses-sender.js';
import { buildPortRules } from './firewall.js';
import { names } from './naming.js';
import { ForumNodeRole } from './node-role.js';
import { selectChallenge } from './tls/challenge.js';
import { composeUserData } from './user-data/compose.js';

/** Tag key marking the Environment a resource belongs to. */
const TAG_ENVIRONMENT = 'community-hub:environment';
/** Tag key marking the forum a resource belongs to. */
const TAG_FORUM = 'community-hub:forum';

/** Props for {@link ForumInstance}. */
export interface ForumInstanceProps {
  /** The validated Environment block (name, region, availability zone, DNS/SSH/snapshot settings). */
  readonly environment: EnvironmentModel;
  /** The forum this instance hosts. */
  readonly forum: ForumModel;
  /** The resolved engine adapter (blueprint, TLS capability, install script). */
  readonly adapter: EngineAdapter;
  /** The Environment's DNS, used to select the challenge and place the A record. */
  readonly dns: EnvironmentDns;
  /** The Environment's shared SES identity and configuration set. */
  readonly email: EnvironmentEmail;
  /** The bootstrap broker's function URL; embedded verbatim in user data. Non-secret. */
  readonly brokerUrl: string;
  /** Shared per-Environment provider backing the forum lifecycle custom resource. */
  readonly lifecycleProvider: Provider;
  /** Shared per-Environment provider backing the SES credentials custom resource. */
  readonly credentialsProvider: Provider;
  /** Shared per-Environment provider backing the email-refresh custom resource. */
  readonly refreshProvider: Provider;
}

/**
 * The non-secret descriptor the {@link import('./bootstrap-broker.js').BootstrapBroker}
 * needs for this forum: its id, static IP, managed-node name and node role.
 */
export interface ForumBrokerDescriptor {
  /** Forum id; the key under which this forum appears in the broker's `FORUMS` map. */
  readonly forumId: string;
  /**
   * The forum's Lightsail instance RESOURCE name (deterministic, token-free).
   * The broker authorizes a claim by verifying via `GetInstance` that this
   * instance exists and is running (account ownership). Deterministic so the
   * broker takes no GetAtt dependency on the instance (which would re-form the
   * broker -> instance -> broker cycle).
   */
  readonly instanceName: string;
  /** The `<env>-<forumId>` name the registered managed node is given. */
  readonly defaultInstanceName: string;
  /** The forum's SSM node role name (the broker builds the PassRole ARN from it). */
  readonly roleName: string;
}

/**
 * One forum's Lightsail instance and the resources it depends on.
 *
 * Exposes {@link staticIp}, {@link instance}, {@link nodeRole}, {@link hostname}
 * and {@link forumId} so the stack can reference them, plus
 * {@link brokerDescriptor}, the non-secret per-forum descriptor the bootstrap
 * broker needs.
 */
export class ForumInstance extends Construct {
  /** The forum's Lightsail static IP. */
  readonly staticIp: CfnStaticIp;

  /** The forum's Lightsail instance. */
  readonly instance: CfnInstance;

  /** The forum's SSM hybrid managed-node role. */
  readonly nodeRole: ForumNodeRole;

  /** The forum's fully qualified host name, `<subdomain>.<rootDomain>`. */
  readonly hostname: string;

  /** The forum's id. */
  readonly forumId: string;

  /** The forum's A record, in the Route 53 modes; `undefined` in `external` mode. */
  readonly aRecord: ARecord | undefined;

  /** The non-secret descriptor the bootstrap broker needs for this forum. */
  readonly brokerDescriptor: ForumBrokerDescriptor;

  constructor(scope: Construct, id: string, props: ForumInstanceProps) {
    super(scope, id);

    const {
      environment,
      forum,
      adapter,
      dns,
      email,
      brokerUrl,
      lifecycleProvider,
      credentialsProvider,
      refreshProvider,
    } = props;

    const stack = Stack.of(this);
    const env = environment.name;
    const hostname = `${forum.subdomain}.${environment.rootDomain}`;
    this.hostname = hostname;
    this.forumId = forum.id;

    const challenge = selectChallenge(dns.dnsMode, adapter.tls);
    const isDns01 = challenge === 'dns-01';

    // 1. Static IP. Created before the node role and instance because both scope
    //    to its address. Static IPs are untaggable: identified by name only.
    const staticIp = new CfnStaticIp(this, 'StaticIp', {
      staticIpName: names.staticIp(env, forum.id),
    });
    this.staticIp = staticIp;

    // 2. Node role, scoped to the static IP (and, for DNS-01, the zone/hostname).
    const nodeRole = new ForumNodeRole(this, 'NodeRole', {
      environment,
      forum,
      account: stack.account,
      region: environment.region,
      partition: stack.partition,
      challenge,
      ...(isDns01 && dns.zoneId !== undefined ? { zoneId: dns.zoneId } : {}),
      ...(isDns01 ? { hostname } : {}),
    });
    this.nodeRole = nodeRole;

    // 3. Instance. The composed user data carries only Secret_References.
    const installInput: InstallScriptInput = {
      environmentName: env,
      region: environment.region,
      forumId: forum.id,
      hostname,
      adminEmail: environment.adminEmail,
      email: sesSettings(environment, forum),
      secrets: pickSecrets(forum, adapter.requiredSecrets),
      engineOptions: adapter.engineOptionsSchema.parse(forum.engineOptions),
    };
    const userData = composeUserData({
      env,
      forumId: forum.id,
      region: environment.region,
      hostname,
      adminEmail: environment.adminEmail,
      brokerUrl,
      challenge,
      staging: environment.acmeStaging,
      tls: adapter.tls,
      adapterScript: adapter.renderInstallScript(installInput),
      ...(isDns01 && dns.zoneId !== undefined ? { hostedZoneId: dns.zoneId } : {}),
    });

    const instance = new CfnInstance(this, 'Instance', {
      instanceName: names.instance(env, forum.id),
      availabilityZone: environment.availabilityZone,
      blueprintId: adapter.blueprintId,
      bundleId: forum.bundleId,
      userData,
      networking: {
        ports: buildPortRules(environment.sshAllowedCidrs),
      },
      addOns: [
        {
          addOnType: 'AutoSnapshot',
          status: 'Enabled',
          autoSnapshotAddOnRequest: {
            snapshotTimeOfDay: environment.snapshotTimeUtc,
          },
        },
      ],
    });
    this.instance = instance;
    Tags.of(instance).add(TAG_ENVIRONMENT, env);
    Tags.of(instance).add(TAG_FORUM, forum.id);

    // 4. Attach the static IP to the instance, after the instance exists.
    staticIp.attachedTo = instance.instanceName;
    staticIp.addDependency(instance);

    // 5. A record, in the Route 53 modes only (dns.zone is defined there).
    if (dns.zone !== undefined) {
      this.aRecord = forumARecord(this, dns.zone, {
        recordName: `${hostname}.`,
        ipAddress: staticIp.attrIpAddress,
      });
    } else {
      this.aRecord = undefined;
    }

    // 6. Lifecycle resource: takes a final manual snapshot before the instance is
    //    deleted. It depends on the instance so CloudFormation runs it first.
    const lifecycle = new CustomResource(this, 'Lifecycle', {
      serviceToken: lifecycleProvider.serviceToken,
      properties: {
        environment: env,
        forumId: forum.id,
        instanceName: names.instance(env, forum.id),
      },
    });
    lifecycle.node.addDependency(instance);

    // 7. SES sender. The instance must not boot before its SMTP parameters exist.
    const sesSender = new SesSender(this, 'Ses', {
      environment,
      forum: {
        id: forum.id,
        senderAddress: forum.senderAddress,
        credentialRotation: forum.credentialRotation,
      },
      email,
      credentialsProvider,
      refreshProvider,
    });
    instance.node.addDependency(sesSender.credentials);

    // 8. Outputs. No output contains a secret, a reference value or a key.
    this.emitOutputs({ environment, forum, hostname, challenge, staticIp, sesSender, dns });

    this.brokerDescriptor = {
      forumId: forum.id,
      instanceName: names.instance(env, forum.id),
      defaultInstanceName: names.activationName(env, forum.id),
      roleName: nodeRole.roleName,
    };
  }

  /**
   * Emit the per-forum stack outputs under `Forum-<id>`. In `external` mode it
   * additionally emits the A record name and value so the operator can create
   * the record in their own DNS provider (Req 3.3, 10.1).
   */
  private emitOutputs(input: {
    environment: EnvironmentModel;
    forum: ForumModel;
    hostname: string;
    challenge: 'dns-01' | 'http-01';
    staticIp: CfnStaticIp;
    sesSender: SesSender;
    dns: EnvironmentDns;
  }): void {
    const { environment, forum, hostname, challenge, staticIp, sesSender, dns } = input;

    new CfnOutput(this, 'ForumId', { value: forum.id });
    new CfnOutput(this, 'Engine', { value: forum.engine });
    new CfnOutput(this, 'Url', { value: `https://${hostname}` });
    // The static IP construct already owns the id `StaticIp` in this scope, so
    // the output uses a distinct id to avoid a construct-id collision.
    new CfnOutput(this, 'StaticIpAddress', { value: staticIp.attrIpAddress });
    new CfnOutput(this, 'InstanceName', {
      value: names.instance(environment.name, forum.id),
    });
    new CfnOutput(this, 'SenderAddress', { value: forum.senderAddress });
    new CfnOutput(this, 'TlsChallenge', { value: challenge });
    new CfnOutput(this, 'EmailRefreshStatus', { value: sesSender.refreshStatus });

    if (dns.dnsMode === 'external') {
      new CfnOutput(this, 'DnsRecordName', { value: `${hostname}.` });
      new CfnOutput(this, 'DnsRecordValue', { value: staticIp.attrIpAddress });
    }
  }
}

/**
 * Narrow a forum's secret map to the engine's required Secret_References.
 *
 * `forum.secrets` is a validated `Record<string, SecretReference>`; the install
 * script input wants the known {@link ForumSecretName} keys. Only the engine's
 * required secrets are forwarded, which the loader has already guaranteed are
 * present.
 */
function pickSecrets(
  forum: ForumModel,
  required: readonly ForumSecretName[],
): Readonly<Partial<Record<ForumSecretName, SecretReference>>> {
  const picked: Partial<Record<ForumSecretName, SecretReference>> = {};
  for (const name of required) {
    const ref = forum.secrets[name];
    if (ref !== undefined) {
      picked[name] = ref;
    }
  }
  return picked;
}
