/**
 * Bootstrap broker Lambda handler.
 *
 * One broker runs per Environment behind a Lambda function URL with
 * `authType: NONE`. The endpoint is unauthenticated at the HTTP layer;
 * authorization is ACCOUNT OWNERSHIP of the claimed forum: `GetInstance` must
 * show the forum's own Lightsail instance exists and is running. (The request
 * source IP is not used: Lightsail NATs outbound traffic away from the attached
 * static IP.) The residual exposure, that the caller is not authenticated, and
 * why it is accepted are recorded in the design doc under "Residual exposure".
 * A forum's instance claims a single-use, one-hour SSM hybrid
 * activation at first boot so it can register as a managed node without the
 * activation code ever appearing in any CloudFormation-visible location
 * (templates, user data, stack events) or in logs.
 *
 * The claim is deliberately opaque: unknown forum, instance not running and
 * already-registered node all return generic status codes (404/403/409) that do
 * not reveal which check failed. The activation code is registered with the
 * injected {@link Redactor} before any log call and is returned exactly once in
 * the success body.
 *
 * All SDK clients, the clock and the logger are injected so the handler can be
 * unit-tested with fakes. The thin {@link handler} entry point builds the real
 * dependencies from the Lambda environment.
 */

import {
  CreateActivationCommand,
  DeleteActivationCommand,
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  SSMClient,
  type Activation,
} from '@aws-sdk/client-ssm';
import { GetInstanceCommand, LightsailClient } from '@aws-sdk/client-lightsail';
import { z } from 'zod';

import { Redactor, createLogger, type Logger } from '../../shared/logger.js';

/** Tag key marking the Environment a resource belongs to. */
const TAG_ENVIRONMENT = 'community-hub:environment';
/** Tag key marking the forum a resource belongs to. */
const TAG_FORUM = 'community-hub:forum';
/** Activation lifetime: one hour from creation. */
const ACTIVATION_TTL_MS = 3_600_000;

/**
 * Per-forum configuration carried in the non-secret `FORUMS` environment
 * variable. `instanceName` is the forum's Lightsail instance RESOURCE name
 * (deterministic, token-free); the broker authorizes a claim by verifying via
 * `GetInstance` that this instance exists and is running in the account
 * (ownership check). A Lightsail instance's outbound traffic is NAT'd through a
 * Lightsail-managed address that is NOT its attached static IP, so the request
 * source IP can never equal the static IP and cannot be used for authorization;
 * ownership plus single-registration-per-forum and the 1-hour expiry are the
 * controls instead. `roleName` is the forum's SSM node role; `defaultInstanceName`
 * is the `<env>-<forumId>` name the registered managed node is given.
 */
const forumConfigSchema = z
  .object({
    instanceName: z.string().min(1),
    roleName: z.string().min(1),
    defaultInstanceName: z.string().min(1),
  })
  .strict();

/** The `FORUMS` environment variable: a map from forum id to its config. */
const forumsSchema = z.record(z.string(), forumConfigSchema);

/** Validated `FORUMS` configuration, keyed by forum id. */
export type ForumsConfig = z.infer<typeof forumsSchema>;

/** Request body a forum instance posts to claim an activation. */
const claimBodySchema = z
  .object({
    environment: z.string().min(1),
    forumId: z.string().min(1),
  })
  .strict();

/**
 * Minimal Lambda function URL event shape the broker depends on. Only the
 * request body and the HTTP method are read (the source IP is present on the
 * event but deliberately unused, see the header); the full AWS event
 * type is intentionally not imported.
 */
export interface BrokerEvent {
  readonly body?: string | null;
  readonly requestContext: {
    readonly http: {
      readonly method: string;
      readonly sourceIp: string;
    };
  };
}

/** HTTP response returned to the Lambda function URL integration. */
export interface BrokerResponse {
  readonly statusCode: number;
  readonly headers: { readonly 'content-type': 'application/json' };
  readonly body: string;
}

/** Injected dependencies for {@link createBrokerHandler}. */
export interface BrokerDeps {
  /** SSM client used for activation lifecycle calls. */
  readonly ssm: Pick<SSMClient, 'send'>;
  /** Lightsail client used to resolve the forum's static IP address at claim time. */
  readonly lightsail: Pick<LightsailClient, 'send'>;
  /** Clock, injected so the one-hour expiry is deterministic in tests. */
  readonly now: () => Date;
  /** Structured logger; the activation code is registered with the redactor first. */
  readonly logger: Logger;
  /** Redactor the activation code is registered with before any log call. */
  readonly redactor: Redactor;
  /** AWS region, echoed in the success body so the agent can register. */
  readonly region: string;
  /** Validated per-forum configuration. */
  readonly forums: ForumsConfig;
}

/** Build a JSON response with the fixed content type. */
function json(statusCode: number, body: unknown): BrokerResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Extract an AWS SDK error `name` without echoing any message body. */
function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string') {
      return name;
    }
  }
  return 'UnknownError';
}

/**
 * List every activation for a forum by its default instance name, following
 * pagination. The filter is scoped so one forum never sees another's
 * activations.
 */
async function listActivations(
  ssm: Pick<SSMClient, 'send'>,
  defaultInstanceName: string,
): Promise<Activation[]> {
  const activations: Activation[] = [];
  let nextToken: string | undefined;
  do {
    const output = await ssm.send(
      new DescribeActivationsCommand({
        Filters: [{ FilterKey: 'DefaultInstanceName', FilterValues: [defaultInstanceName] }],
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
    );
    for (const activation of output.ActivationList ?? []) {
      activations.push(activation);
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined && nextToken.length > 0);
  return activations;
}

/**
 * Return true when any managed node has already registered against one of the
 * given activation ids, enforcing the single-registration-per-forum rule.
 */
async function hasRegisteredNode(
  ssm: Pick<SSMClient, 'send'>,
  activationIds: string[],
): Promise<boolean> {
  if (activationIds.length === 0) {
    return false;
  }
  const output = await ssm.send(
    new DescribeInstanceInformationCommand({
      Filters: [{ Key: 'ActivationIds', Values: activationIds }],
      MaxResults: 5,
    }),
  );
  return (output.InstanceInformationList ?? []).length > 0;
}

/**
 * Create the broker handler from injected dependencies.
 *
 * The returned function implements the claim algorithm from the design:
 * validate the body and resolve the forum (404 unknown), verify the forum's
 * instance exists and is running via GetInstance (403), reject if a node is already registered
 * (409), delete any prior unused activations, create a fresh single-use
 * activation that expires in one hour, and return its id and code once.
 *
 * Non-`POST` requests get 405. Malformed bodies get 400. Any SDK failure is
 * logged with the operation name and error name only (never a response body
 * that could hold a secret) and surfaces as a generic 500.
 *
 * @param deps - Injected SDK client, clock, logger, redactor, region and forums.
 * @returns An async function mapping a {@link BrokerEvent} to a {@link BrokerResponse}.
 */
export function createBrokerHandler(
  deps: BrokerDeps,
): (event: BrokerEvent) => Promise<BrokerResponse> {
  const { ssm, lightsail, now, logger, redactor, region, forums } = deps;

  return async (event: BrokerEvent): Promise<BrokerResponse> => {
    const { method } = event.requestContext.http;
    if (method !== 'POST') {
      return json(405, { error: 'method not allowed' });
    }

    const parsedBody = parseBody(event.body);
    if (parsedBody === undefined) {
      return json(400, { error: 'invalid request' });
    }

    const { environment, forumId } = parsedBody;
    const forum = forums[forumId];
    if (forum === undefined) {
      logger.info('claim rejected: unknown forum', { environment, forumId });
      return json(404, { error: 'not found' });
    }

    // Authorize by ACCOUNT OWNERSHIP of the claimed forum's instance: verify via
    // GetInstance that the forum's own Lightsail instance exists and is running
    // in this account. The request source IP cannot be used: a Lightsail
    // instance's outbound traffic is NAT'd through an address that is not its
    // attached static IP, so sourceIp never equals the static IP. Single
    // registration per forum (below) and the 1-hour expiry bound replay.
    let instanceState: string | undefined;
    try {
      const out = await lightsail.send(
        new GetInstanceCommand({ instanceName: forum.instanceName }),
      );
      instanceState = out.instance?.state?.name;
    } catch (error) {
      // NotFoundException is an expected "not yet / not ours" case: treat it as a
      // 403 rather than a 500 so a claim before the instance exists just retries.
      if (errorName(error) === 'NotFoundException') {
        logger.info('claim rejected: instance not found', { environment, forumId });
        return json(403, { error: 'forbidden' });
      }
      logger.error('claim failed: instance lookup', {
        environment,
        forumId,
        errorName: errorName(error),
      });
      return json(500, { error: 'internal error' });
    }
    if (instanceState !== 'running') {
      logger.info('claim rejected: instance not running', { environment, forumId });
      return json(403, { error: 'forbidden' });
    }

    const defaultInstanceName = forum.defaultInstanceName;

    try {
      const existing = await listActivations(ssm, defaultInstanceName);
      const activationIds = existing
        .map((activation) => activation.ActivationId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      if (await hasRegisteredNode(ssm, activationIds)) {
        logger.info('claim rejected: node already registered', {
          environment,
          forumId,
          defaultInstanceName,
        });
        return json(409, { error: 'conflict' });
      }

      for (const id of activationIds) {
        await ssm.send(new DeleteActivationCommand({ ActivationId: id }));
      }

      const expirationDate = new Date(now().getTime() + ACTIVATION_TTL_MS);
      const created = await ssm.send(
        new CreateActivationCommand({
          IamRole: forum.roleName,
          RegistrationLimit: 1,
          ExpirationDate: expirationDate,
          DefaultInstanceName: defaultInstanceName,
          Tags: [
            { Key: TAG_ENVIRONMENT, Value: environment },
            { Key: TAG_FORUM, Value: forumId },
          ],
        }),
      );

      const activationId = created.ActivationId;
      const activationCode = created.ActivationCode;
      if (activationId === undefined || activationCode === undefined) {
        logger.error('activation created without id or code', {
          environment,
          forumId,
          defaultInstanceName,
        });
        return json(500, { error: 'internal error' });
      }

      // Register the code with the redactor before any further log call so it
      // can never leak, then return it once in the response body.
      redactor.register(activationCode);
      logger.info('activation issued', {
        environment,
        forumId,
        activationId,
      });

      return json(200, { activationId, activationCode, region });
    } catch (error) {
      logger.error('claim failed', {
        environment,
        forumId,
        defaultInstanceName,
        errorName: errorName(error),
      });
      return json(500, { error: 'internal error' });
    }
  };
}

/** Parse and validate the request body, returning `undefined` on any problem. */
function parseBody(body: string | null | undefined): z.infer<typeof claimBodySchema> | undefined {
  if (typeof body !== 'string' || body.length === 0) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = claimBodySchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Parse and validate the `FORUMS` environment variable.
 *
 * @throws Error when the variable is missing or not valid JSON matching the schema.
 */
function loadForums(value: string | undefined): ForumsConfig {
  if (value === undefined || value.length === 0) {
    throw new Error('FORUMS environment variable is missing');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('FORUMS environment variable is not valid JSON');
  }
  const result = forumsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('FORUMS environment variable failed validation');
  }
  return result.data;
}

/**
 * Lambda entry point. Builds the real dependencies from the environment
 * (`FORUMS`, `AWS_REGION`) and delegates to {@link createBrokerHandler}. A
 * missing or malformed `FORUMS` value surfaces as a generic 500 without
 * revealing configuration details.
 */
export async function handler(event: BrokerEvent): Promise<BrokerResponse> {
  const redactor = new Redactor();
  const logger = createLogger({
    sink: {
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    },
    redactor,
  });

  let forums: ForumsConfig;
  try {
    forums = loadForums(process.env.FORUMS);
  } catch (error) {
    logger.error('broker misconfigured', { errorName: errorName(error) });
    return json(500, { error: 'internal error' });
  }

  const region = process.env.AWS_REGION ?? '';
  const handle = createBrokerHandler({
    ssm: new SSMClient({}),
    lightsail: new LightsailClient({}),
    now: () => new Date(),
    logger,
    redactor,
    region,
    forums,
  });
  return handle(event);
}
