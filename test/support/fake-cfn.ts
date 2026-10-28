/**
 * Builder for CloudFormation custom-resource events used to drive the CDK
 * custom-resource handlers (`forum-lifecycle`, `ses-smtp-credentials`,
 * `email-refresh`) in unit tests.
 *
 * The CDK provider framework invokes a custom resource with a standard
 * CloudFormation event carrying `RequestType`, `ResourceProperties` and, for
 * Update/Delete, `PhysicalResourceId` and `OldResourceProperties`. The handlers
 * in this repo read only a subset of those fields, so {@link makeCfnEvent}
 * returns a complete, well-formed event with sensible placeholder defaults and
 * lets a test override any field. Nothing here touches AWS or the network.
 */

/** The three CloudFormation custom-resource request types. */
export type CfnRequestType = 'Create' | 'Update' | 'Delete';

/**
 * A CloudFormation custom-resource event. `Create` omits `PhysicalResourceId`
 * and `OldResourceProperties`; `Update` and `Delete` carry both. The field
 * names and casing match the real CloudFormation payload so events are
 * structurally compatible with the narrow event interfaces the handlers
 * declare.
 */
export interface CfnCustomResourceEvent {
  readonly RequestType: CfnRequestType;
  readonly ServiceToken: string;
  readonly ResponseURL: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly ResourceType: string;
  readonly ResourceProperties: Readonly<Record<string, unknown>>;
  readonly PhysicalResourceId?: string;
  readonly OldResourceProperties?: Readonly<Record<string, unknown>>;
  /**
   * The `Data` the provider framework merges from `onEvent` into the
   * `isComplete` event. CloudFormation itself does not send this; the CDK
   * Provider framework carries the previous phase's `Data` forward, which is
   * what a two-phase handler's `isComplete` reads.
   */
  readonly Data?: Readonly<Record<string, unknown>>;
}

/**
 * Fields a test may override. `RequestType` chooses the event variant;
 * everything else defaults to a stable placeholder. For an `Update` or
 * `Delete`, pass `PhysicalResourceId` (and optionally `OldResourceProperties`)
 * to model the existing resource.
 */
export interface CfnEventOverrides {
  readonly RequestType?: CfnRequestType;
  readonly ServiceToken?: string;
  readonly ResponseURL?: string;
  readonly StackId?: string;
  readonly RequestId?: string;
  readonly LogicalResourceId?: string;
  readonly ResourceType?: string;
  readonly ResourceProperties?: Readonly<Record<string, unknown>>;
  readonly PhysicalResourceId?: string;
  readonly OldResourceProperties?: Readonly<Record<string, unknown>>;
  readonly Data?: Readonly<Record<string, unknown>>;
}

/** Stable placeholder ARNs/URLs; none point at real infrastructure. */
const DEFAULTS = {
  ServiceToken: 'arn:aws:lambda:us-east-1:111122223333:function:test-provider',
  ResponseURL: 'https://cloudformation-custom-resource-response.example.invalid/',
  StackId:
    'arn:aws:cloudformation:us-east-1:111122223333:stack/test-stack/00000000-0000-0000-0000-000000000000',
  RequestId: '00000000-0000-0000-0000-000000000000',
  LogicalResourceId: 'TestCustomResource',
  ResourceType: 'Custom::Test',
} as const;

/**
 * Build a CloudFormation custom-resource event for a handler test.
 *
 * Defaults produce a `Create` with empty `ResourceProperties`. Override
 * `RequestType`, `ResourceProperties` and, for Update/Delete,
 * `PhysicalResourceId`/`OldResourceProperties`. Fields the caller does not set
 * take stable placeholder values, and `PhysicalResourceId`/
 * `OldResourceProperties` are included only when provided (so a `Create` event
 * does not carry them unless asked).
 *
 * @param overrides - Fields to override; all optional.
 * @returns A complete {@link CfnCustomResourceEvent}.
 */
export function makeCfnEvent(overrides: CfnEventOverrides = {}): CfnCustomResourceEvent {
  const base: CfnCustomResourceEvent = {
    RequestType: overrides.RequestType ?? 'Create',
    ServiceToken: overrides.ServiceToken ?? DEFAULTS.ServiceToken,
    ResponseURL: overrides.ResponseURL ?? DEFAULTS.ResponseURL,
    StackId: overrides.StackId ?? DEFAULTS.StackId,
    RequestId: overrides.RequestId ?? DEFAULTS.RequestId,
    LogicalResourceId: overrides.LogicalResourceId ?? DEFAULTS.LogicalResourceId,
    ResourceType: overrides.ResourceType ?? DEFAULTS.ResourceType,
    // CloudFormation injects the provider ServiceToken INTO ResourceProperties
    // (alongside the declared keys); replicate that so handler tests exercise
    // the real event shape.
    ResourceProperties: {
      ServiceToken: overrides.ServiceToken ?? DEFAULTS.ServiceToken,
      ...(overrides.ResourceProperties ?? {}),
    },
  };

  return {
    ...base,
    ...(overrides.PhysicalResourceId !== undefined
      ? { PhysicalResourceId: overrides.PhysicalResourceId }
      : {}),
    ...(overrides.OldResourceProperties !== undefined
      ? { OldResourceProperties: overrides.OldResourceProperties }
      : {}),
    ...(overrides.Data !== undefined ? { Data: overrides.Data } : {}),
  };
}
