/**
 * L3 construct for an Environment's Route 53 hosted zone.
 *
 * The zone is global, so it lives in the single Environment stack alongside
 * every other resource (Req 12.13). Behaviour depends on the DNS_Mode:
 *
 *  - `route53`: create a {@link PublicHostedZone} for `rootDomain` with a
 *    `DESTROY` removal policy and emit the zone id and name servers as outputs
 *    so the operator can delegate the domain (Req 12.2, 10.2).
 *  - `route53-existing`: look the zone up at synth with
 *    {@link HostedZone.fromLookup} and validate it against the declared
 *    `hostedZoneId` before any record is created. No `AWS::Route53::HostedZone`
 *    resource is added (Req 12.6, 12.7, 12.8).
 *  - `external`: create no zone and do no lookup; the record factories are
 *    never called and callers print values as outputs instead.
 *
 * The forum-instance and email constructs receive {@link zone} as a prop and
 * create records only when it is defined. This construct makes no SDK calls;
 * the only synth-time AWS read is CDK's built-in hosted-zone lookup.
 */

import { CfnOutput, Fn, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { HostedZone, type IHostedZone, PublicHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import type { EnvironmentModel } from '../../metadata/schema.js';
import { constructIds } from '../naming.js';

import { checkLookedUpZone } from './zone-check.js';

/**
 * The id {@link HostedZone.fromLookup} returns while the context value is still
 * missing (the first synthesis pass, before the toolkit runs the lookup and
 * synthesizes again). The zone validation is skipped for this sentinel.
 */
const DUMMY_ZONE_ID = 'DUMMY';

/** Props for {@link EnvironmentDns}. */
export interface EnvironmentDnsProps {
  /** The validated Environment block (DNS mode, root domain, optional zone id). */
  readonly environment: EnvironmentModel;
}

/**
 * Route 53 zone for the Environment: created (`route53`), looked up and
 * validated (`route53-existing`), or none (`external`).
 *
 * Exposes {@link zone} and {@link zoneId} so record factories and the forum and
 * email constructs can branch: both are `undefined` in `external` mode, `zone`
 * is a real resource in `route53` and a looked-up import in `route53-existing`,
 * and `zoneId` is a token in `route53` and the declared literal in
 * `route53-existing`.
 */
export class EnvironmentDns extends Construct {
  /** The hosted zone, or `undefined` in `external` mode. */
  readonly zone: IHostedZone | undefined;

  /**
   * The hosted zone id, or `undefined` in `external` mode. A CloudFormation
   * token in `route53` mode; the declared literal in `route53-existing` mode.
   */
  readonly zoneId: string | undefined;

  /** The Environment's DNS mode, so callers can branch on record emission. */
  readonly dnsMode: EnvironmentModel['dnsMode'];

  constructor(scope: Construct, id: string, props: EnvironmentDnsProps) {
    super(scope, id);

    const { environment } = props;
    this.dnsMode = environment.dnsMode;

    switch (environment.dnsMode) {
      case 'route53': {
        const zone = new PublicHostedZone(this, constructIds.zone, {
          zoneName: environment.rootDomain,
        });
        zone.applyRemovalPolicy(RemovalPolicy.DESTROY);
        Tags.of(zone).add('community-hub:environment', environment.name);

        this.zone = zone;
        this.zoneId = zone.hostedZoneId;

        new CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId });
        new CfnOutput(this, 'HostedZoneNameServers', {
          // Name servers are tokens, so join them with Fn.join rather than Array.join.
          value: Fn.join(',', zone.hostedZoneNameServers ?? []),
        });
        break;
      }

      case 'route53-existing': {
        const zone = HostedZone.fromLookup(this, constructIds.zone, {
          domainName: environment.rootDomain,
          privateZone: false,
        });

        // On the first synthesis pass the lookup is unresolved and returns the
        // DUMMY sentinel; skip validation then, because the toolkit runs the
        // lookup and synthesizes again with the real id.
        if (zone.hostedZoneId !== DUMMY_ZONE_ID) {
          // hostedZoneId is present whenever dnsMode is route53-existing (loader rule).
          const declaredId = environment.hostedZoneId;
          if (declaredId === undefined) {
            throw new Error(
              'route53-existing requires hostedZoneId; it must be validated by the metadata loader',
            );
          }
          checkLookedUpZone({
            declaredId,
            lookedUpId: zone.hostedZoneId,
            rootDomain: environment.rootDomain,
          });
        }

        this.zone = zone;
        this.zoneId = environment.hostedZoneId;

        new CfnOutput(this, 'HostedZoneId', { value: environment.hostedZoneId ?? '' });
        break;
      }

      case 'external': {
        this.zone = undefined;
        this.zoneId = undefined;
        break;
      }

      default: {
        const unreachable: never = environment.dnsMode;
        throw new Error(`unsupported dnsMode: ${String(unreachable)}`);
      }
    }
  }
}
