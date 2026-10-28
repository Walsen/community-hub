/**
 * L3 construct for an Environment's Amazon SES email resources.
 *
 * SES sends all forum mail for the Environment, so one domain identity, one
 * default configuration set and one bounce/complaint pipeline are shared by
 * every forum. This construct owns them (Req 11.1, 11.2, 11.11, 11.12, 11.13):
 *
 *  - an {@link EmailIdentity} for the Environment's Mail_Domain with Easy DKIM
 *    and a custom MAIL FROM domain `mail.<mailDomain>` (behaviour on MX failure
 *    `USE_DEFAULT_VALUE`), associated with the Environment's default
 *    configuration set;
 *  - a {@link ConfigurationSet} with no suppression override, so the
 *    account-level suppression list governs bounced and complained addresses
 *    (Req 11.13);
 *  - an SNS {@link Topic} that receives bounce and complaint events, with a
 *    topic policy that lets only this account's SES configuration set publish,
 *    and an email subscription to the Environment's `adminEmail`.
 *
 * DNS authentication records (DKIM CNAMEs, MAIL FROM MX + SPF, DMARC) are
 * created in the Hosted_Zone in the Route 53 modes and emitted as outputs in
 * `external` mode (Req 11.3, 11.4). The DKIM record names and values come from
 * the identity's generated DKIM token attributes (GetAtts), so no literal
 * tokens are ever hard-coded.
 *
 * The per-forum {@link import('./ses-sender.js')} construct and the forum
 * instances read {@link identity}, {@link configurationSetName} and
 * {@link topic} from here. This construct makes no SDK calls at synth.
 */

import { CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import { ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import {
  ConfigurationSet,
  ConfigurationSetEventDestination,
  DkimIdentity,
  EmailIdentity,
  EmailSendingEvent,
  EventDestination,
  Identity,
  MailFromBehaviorOnMxFailure,
} from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import type { EnvironmentModel } from '../../metadata/schema.js';
import { names } from '../naming.js';

import { emailRecords } from '../dns/records.js';
import type { EnvironmentDns } from '../dns/environment-dns.js';
import { buildEmailDnsRecords, displayValue } from './email-dns-records.js';

/**
 * A static reminder printed as the {@link EnvironmentEmail} `SesSandboxReminder`
 * output. New SES accounts start in the sandbox, where mail reaches only
 * verified identities until production access is granted, and the SNS email
 * subscription must be confirmed from the operator's inbox.
 */
const SES_SANDBOX_REMINDER =
  'SES starts in the sandbox: until you request production access for this ' +
  'region, mail is delivered only to verified identities. Also confirm the SNS ' +
  'email subscription from the adminEmail inbox so bounce and complaint ' +
  'notifications are delivered.';

/** Props for {@link EnvironmentEmail}. */
export interface EnvironmentEmailProps {
  /** The validated Environment block (region, mail domain, admin email, DMARC policy). */
  readonly environment: EnvironmentModel;
  /** The Environment's DNS, used to place email records in the Route 53 modes. */
  readonly dns: EnvironmentDns;
}

/**
 * The Environment's SES identity, configuration set, bounce/complaint topic and
 * email authentication DNS records.
 *
 * Exposes {@link identity}, {@link configurationSetName} and {@link topic} so
 * the per-forum {@link import('./ses-sender.js')} construct and the forum
 * instances can scope send policies and reference the configuration set.
 */
export class EnvironmentEmail extends Construct {
  /** The Environment's SES domain identity (Easy DKIM, custom MAIL FROM). */
  readonly identity: EmailIdentity;

  /** The Environment's default SES configuration set name. */
  readonly configurationSetName: string;

  /** The SNS topic SES publishes bounce and complaint events to. */
  readonly topic: Topic;

  constructor(scope: Construct, id: string, props: EnvironmentEmailProps) {
    super(scope, id);

    const { environment, dns } = props;
    const stack = Stack.of(this);
    const mailDomain = environment.mailDomain;
    const mailFromDomain = `mail.${mailDomain}`;

    // Default configuration set: no SuppressionOptions, so the account-level
    // suppression list governs bounced and complained addresses (Req 11.13).
    const configurationSet = new ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: names.configurationSet(environment.name),
      reputationMetrics: true,
      sendingEnabled: true,
    });
    this.configurationSetName = configurationSet.configurationSetName;
    Tags.of(configurationSet).add('community-hub:environment', environment.name);

    // Domain identity with Easy DKIM, a custom MAIL FROM domain and the default
    // configuration set associated (Req 11.1, 11.2, 11.11, 11.12).
    const identity = new EmailIdentity(this, 'Identity', {
      identity: Identity.domain(mailDomain),
      dkimIdentity: DkimIdentity.easyDkim(),
      mailFromDomain,
      mailFromBehaviorOnMxFailure: MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
      configurationSet,
    });
    this.identity = identity;

    // SNS topic for bounce and complaint events, subscribed by the operator.
    const topic = new Topic(this, 'Topic', {
      topicName: names.emailTopic(environment.name),
    });
    this.topic = topic;
    Tags.of(topic).add('community-hub:environment', environment.name);

    topic.addSubscription(new EmailSubscription(environment.adminEmail));

    // Allow only this account's SES configuration set to publish to the topic,
    // scoped by AWS:SourceAccount and AWS:SourceArn (Req 11.12).
    const configurationSetArn = stack.formatArn({
      service: 'ses',
      resource: 'configuration-set',
      resourceName: this.configurationSetName,
    });
    const topicPolicyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('ses.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: {
        StringEquals: { 'AWS:SourceAccount': stack.account },
        ArnLike: { 'AWS:SourceArn': configurationSetArn },
      },
    });
    const topicPolicyResult = topic.addToResourcePolicy(topicPolicyStatement);

    // Bounce + complaint event destination publishing to the topic. It must be
    // created after the topic policy so SES can validate publish access when
    // the destination is created (Req 11.12).
    const eventDestination = new ConfigurationSetEventDestination(this, 'BounceComplaint', {
      configurationSet,
      configurationSetEventDestinationName: 'bounce-complaint',
      enabled: true,
      events: [EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT],
      destination: EventDestination.snsTopic(topic),
    });
    if (topicPolicyResult.policyDependable !== undefined) {
      eventDestination.node.addDependency(topicPolicyResult.policyDependable);
    }

    // Email authentication records. DKIM names/values are GetAtts of the
    // identity in this same stack (Req 11.3, 11.4, 11.5).
    const records = buildEmailDnsRecords({
      mailDomain,
      mailFromDomain,
      region: environment.region,
      adminEmail: environment.adminEmail,
      dmarcPolicy: environment.dmarcPolicy,
      dkim: [
        { name: identity.dkimDnsTokenName1, value: identity.dkimDnsTokenValue1 },
        { name: identity.dkimDnsTokenName2, value: identity.dkimDnsTokenValue2 },
        { name: identity.dkimDnsTokenName3, value: identity.dkimDnsTokenValue3 },
      ],
    });

    switch (dns.dnsMode) {
      case 'route53':
      case 'route53-existing': {
        // The zone is defined in both Route 53 modes; create one record set per
        // authentication record (Req 11.3).
        if (dns.zone === undefined) {
          throw new Error(`EnvironmentDns.zone must be defined in dnsMode '${dns.dnsMode}'`);
        }
        emailRecords(this, dns.zone, records);
        break;
      }

      case 'external': {
        // No zone: print each record as a Name/Type/Value output triple so the
        // operator can create them in their own DNS provider (Req 11.4).
        for (const record of records) {
          new CfnOutput(this, `Email${record.id}Name`, {
            value: record.name,
          });
          new CfnOutput(this, `Email${record.id}Type`, {
            value: record.type,
          });
          new CfnOutput(this, `Email${record.id}Value`, {
            value: displayValue(record),
          });
        }
        break;
      }

      default: {
        const unreachable: never = dns.dnsMode;
        throw new Error(`unsupported dnsMode: ${String(unreachable)}`);
      }
    }

    new CfnOutput(this, 'EmailIdentityDomain', { value: mailDomain });
    new CfnOutput(this, 'SmtpEndpoint', {
      value: `email-smtp.${environment.region}.amazonaws.com`,
    });
    new CfnOutput(this, 'EmailEventTopicArn', { value: topic.topicArn });
    new CfnOutput(this, 'SesSandboxReminder', { value: SES_SANDBOX_REMINDER });
  }
}
