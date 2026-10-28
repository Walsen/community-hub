/**
 * A single fake AWS SDK v3 client for unit tests.
 *
 * The Lambda handlers in `src/infra/handlers/*` take their SDK clients as
 * injected dependencies, typed as `Pick<SomeClient, 'send'>` so a test can
 * substitute a fake. {@link createFakeAwsClient} returns one such fake that
 * stands in for any of the SSM, IAM, Lightsail and Secrets Manager clients:
 * it exposes a `send(command)` method with the AWS SDK v3 overload shape,
 * routes by `command.constructor.name`, records every call, and returns
 * responses from an injected `behaviors` map.
 *
 * It is deliberately strict: a command with no configured behavior throws an
 * error that names the command, so an unexpected SDK call fails the test
 * loudly rather than silently returning `undefined`. Nothing here touches the
 * network, the clock, or real AWS; recorded command input stays typed as
 * `unknown` and the module uses no `any`.
 */

/**
 * The minimal structural shape of an AWS SDK v3 command accepted by the fake's
 * `send`. It carries an `input` and a `resolveMiddleware` method; the method's
 * parameters are `never[]`, which (parameters being contravariant) makes this
 * a supertype of every generated SDK command, so a real `GetParameterCommand`
 * and friends are assignable here and the fake stays assignable to
 * `Pick<SomeClient, 'send'>`.
 */
interface SdkCommandLike {
  readonly input: unknown;
  resolveMiddleware(...args: never[]): unknown;
}

/**
 * The structural shape the fake reads off a command at runtime: the routing
 * name comes from the command's constructor, and the input is recorded as-is.
 */
interface RoutableCommand {
  readonly input: unknown;
  readonly constructor: { readonly name: string };
}

/** The AWS SDK v3 `MetadataBearer` shape every command output extends. */
interface MetadataBearerLike {
  readonly $metadata?: unknown;
}

/**
 * A behavior for one command name: either a static response, or a function of
 * the command input and a zero-based per-command call index (so a test can
 * script a sequence, such as a snapshot that is `pending` then `available`).
 *
 * The response is typed as `unknown`; `send` narrows it to the caller's
 * expected output type at the call site, matching how the real SDK is used.
 *
 * A static response and the function form are both `unknown` to the type
 * system (`unknown` already subsumes the function type), so the type is a bare
 * `unknown`; the function form is detected at runtime with `typeof === 'function'`.
 */
export type FakeBehavior = unknown;

/** The scripted function form of a {@link FakeBehavior}, detected at runtime. */
export type FakeBehaviorFn = (input: unknown, callIndex: number) => unknown;

/**
 * A map from command class name (for example `CreateInstanceSnapshotCommand`)
 * to the {@link FakeBehavior} the fake should use when it receives that
 * command. Command names absent from the map throw when sent.
 */
export type FakeBehaviors = Readonly<Record<string, FakeBehavior>>;

/** One recorded `send` call: the command name and its (untyped) input. */
export interface FakeAwsCall {
  /** The command class name, from `command.constructor.name`. */
  readonly command: string;
  /** The command's `input`, recorded as-is and left typed as `unknown`. */
  readonly input: unknown;
}

/**
 * The AWS SDK v3 `send` overload shape, reproduced structurally so the fake is
 * assignable to `Pick<SomeClient, 'send'>` for every client without importing
 * the SDK. The generic output type lets a caller write
 * `await client.send(new GetParameterCommand(...))` and get the parameter
 * output type back.
 */
export interface FakeSend {
  <OutputType extends MetadataBearerLike>(
    command: SdkCommandLike,
    options?: unknown,
  ): Promise<OutputType>;
}

/**
 * A fake AWS SDK client: the `send` method handlers consume plus read-only
 * accessors onto its call log for assertions.
 */
export interface FakeAwsClient {
  /** The injected client dependency: an AWS SDK v3 `send`. */
  readonly send: FakeSend;
  /** Every `send` call recorded so far, in call order. */
  readonly calls: readonly FakeAwsCall[];
  /** Calls for one command name, in call order. */
  callsFor(command: string): readonly FakeAwsCall[];
  /** How many times a command name has been sent. */
  countFor(command: string): number;
}

/**
 * Build a fake AWS SDK v3 client.
 *
 * Route by `command.constructor.name`:
 * - if `behaviors[name]` is a function, it is called with `(input, callIndex)`
 *   where `callIndex` is the zero-based count of prior calls for that command,
 *   enabling scripted sequences (for example snapshot pending then available);
 * - if it is any other value, that value is returned as the response;
 * - if the name is absent from `behaviors`, `send` rejects with an error naming
 *   the command, so an unexpected SDK call fails the test loudly.
 *
 * A behavior value (or a function's return value) may be an `Error`, in which
 * case `send` rejects with it; this is how tests simulate AWS error responses
 * (for example a `LimitExceededException` on a second access key).
 *
 * @param behaviors - Per-command responses; omit to make every call throw.
 * @returns A {@link FakeAwsClient} exposing `send` and call-log accessors.
 */
export function createFakeAwsClient(behaviors: FakeBehaviors = {}): FakeAwsClient {
  const calls: FakeAwsCall[] = [];
  const perCommandCount = new Map<string, number>();

  const send = (<OutputType extends MetadataBearerLike>(
    command: SdkCommandLike,
  ): Promise<OutputType> => {
    const routable: RoutableCommand = command;
    const name = routable.constructor.name;
    const { input } = routable;
    calls.push({ command: name, input });

    const callIndex = perCommandCount.get(name) ?? 0;
    perCommandCount.set(name, callIndex + 1);

    if (!Object.prototype.hasOwnProperty.call(behaviors, name)) {
      return Promise.reject(
        new Error(
          `unexpected AWS SDK call: no behavior configured for ${name} ` +
            `(call #${String(callIndex + 1)}). Add it to createFakeAwsClient's behaviors.`,
        ),
      );
    }

    const behavior = behaviors[name];
    const response =
      typeof behavior === 'function' ? (behavior as FakeBehaviorFn)(input, callIndex) : behavior;

    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response as OutputType);
  }) as FakeSend;

  return {
    send,
    get calls() {
      return calls;
    },
    callsFor(command: string): readonly FakeAwsCall[] {
      return calls.filter((call) => call.command === command);
    },
    countFor(command: string): number {
      return calls.reduce((total, call) => (call.command === command ? total + 1 : total), 0);
    },
  };
}

/**
 * Build a behavior that returns each response in `responses` on successive
 * calls to the same command, then repeats the last one. This is a convenience
 * for polling scenarios (for example `GetInstanceSnapshotCommand` or
 * `GetCommandInvocationCommand` returning a pending state before a terminal
 * one); once the queue is exhausted the final response is returned for every
 * further call so a poll loop that runs one extra time still terminates.
 *
 * @param responses - Responses to return in order; must be non-empty.
 * @returns A {@link FakeBehavior} function suitable for a `behaviors` entry.
 */
export function queueResponses(responses: readonly unknown[]): FakeBehavior {
  if (responses.length === 0) {
    throw new Error('queueResponses requires at least one response');
  }
  const lastIndex = responses.length - 1;
  return (_input: unknown, callIndex: number): unknown => {
    const index = Math.min(callIndex, lastIndex);
    return responses[index];
  };
}
