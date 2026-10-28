/**
 * The engine plugin contract.
 *
 * Every engine-specific behaviour (minimum RAM, blueprint, install and
 * email-refresh scripts, TLS capability, option validation, seed operations)
 * lives behind {@link EngineAdapter} and is reached only through the
 * EngineRegistry. Core modules (`infra/`, `seeder/`, `metadata/`) depend on
 * these interfaces, never on a concrete adapter, so adding an engine is adding
 * a new adapter plus one registry line.
 *
 * The seeder domain types ({@link ResourceType}, {@link SeedResource},
 * {@link FieldDiff}, {@link CreateAction}, {@link UpdateAction},
 * {@link ActualState}) are defined in `src/seeder/types.ts` and re-used here.
 */

import type { z } from 'zod';

import type { ValidationIssue } from '../metadata/errors.js';
import type { SesSettings } from '../metadata/mail.js';
import type { EnvironmentModel, ForumModel } from '../metadata/schema.js';
import type { SecretReference } from '../metadata/secret-ref.js';
import type {
  ActualState,
  CreateAction,
  FieldDiff,
  ResourceType,
  SeedResource,
  UpdateAction,
} from '../seeder/types.js';
import type { HttpClient } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';

/** The secret-bearing fields an engine may require, by logical name. */
export type ForumSecretName = 'adminPassword' | 'apiKey' | 'databasePassword';

/**
 * Inputs for an engine install or email-refresh script. Carries references and
 * derived settings only; never secret values. User data fetches secret values
 * on the instance from the referenced Secret_Stores.
 */
export interface InstallScriptInput {
  readonly environmentName: string;
  readonly region: string;
  readonly forumId: string;
  /** Fully qualified host name, `<subdomain>.<rootDomain>`. */
  readonly hostname: string;
  /** ACME account email and operational contact. */
  readonly adminEmail: string;
  /** Derived SES settings: host, port and parameter names, never values. */
  readonly email: SesSettings;
  /** Secret_References for the engine's required secrets; no values. */
  readonly secrets: Readonly<Partial<Record<ForumSecretName, SecretReference>>>;
  /** Engine-specific options, already validated by {@link EngineAdapter.engineOptionsSchema}. */
  readonly engineOptions: unknown;
}

/**
 * How an engine consumes certificates from the shared certificate manager
 * (Req 13.2). The manager issues and renews certificates on the host; the
 * engine reads them from {@link TlsSupport.certPaths} and is reloaded with
 * {@link TlsSupport.reloadCommand}.
 */
export interface TlsSupport {
  /**
   * True when the engine serves certificates from {@link TlsSupport.certPaths},
   * which enables the ACME DNS-01 challenge in the Route 53 DNS modes. An
   * engine that cannot read external certificates sets this to `false` and is
   * served through HTTP-01.
   */
  readonly dns01: boolean;
  /**
   * Host paths the engine reads. The deploy hook installs the full chain
   * (`0644`) and private key (`0600`) at these paths.
   */
  readonly certPaths: {
    readonly fullchain: string;
    readonly privkey: string;
  };
  /**
   * Command run after a renewed certificate is installed. Must be idempotent
   * and safe to run while the engine is serving traffic.
   */
  readonly reloadCommand: string;
  /**
   * Host directory the engine's port-80 server exposes only under
   * `/.well-known/acme-challenge/`, used for the HTTP-01 challenge.
   */
  readonly http01Webroot: string;
}

/**
 * Dependencies injected into an engine's {@link SeedClient}. The `apiKey` is
 * resolved at the edge by the seeder run; the client makes HTTPS calls through
 * the injected {@link HttpClient} and logs through the redacting {@link Logger}.
 */
export interface SeedClientDeps {
  /** Base URL of the forum, `https://<hostname>`. */
  readonly baseUrl: string;
  /** Resolved admin API key (resolved at the edge, never stored in metadata). */
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly logger: Logger;
}

/**
 * Side-effecting context passed to {@link SeedClient.apply}. Lets a handler
 * resolve a declared secret reference or generate a random password at apply
 * time, so secret values never live in the plan.
 */
export interface ApplyContext {
  /** Resolve a Secret_Reference to its value, at the edge, just in time. */
  resolveSecret(ref: SecretReference): Promise<string>;
  /** Generate a fresh random password, e.g. for a user with no declared one. */
  randomPassword(): string;
}

/**
 * An engine seed client: reads actual state and applies create/update actions
 * against one forum's admin API. `probe` and `readActual` issue only GET
 * requests.
 */
export interface SeedClient {
  /** Verify the forum is reachable; throws `ForumUnreachableError` otherwise. */
  probe(): Promise<void>;
  /** Read the actual state for the given desired resources (GET only). */
  readActual(desired: readonly SeedResource[]): Promise<ActualState>;
  /** Apply a single create or update action. */
  apply(action: CreateAction | UpdateAction, ctx: ApplyContext): Promise<void>;
}

/**
 * Handles one non-membership {@link ResourceType}: reads the current
 * attributes of the requested keys and applies creates and updates.
 */
export interface ResourceHandler {
  /** Read current attributes for the given natural keys. */
  read(keys: readonly string[]): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>>;
  /** Create a declared resource. */
  create(resource: SeedResource, ctx: ApplyContext): Promise<void>;
  /** Update a resource's changed fields. */
  update(resource: SeedResource, diff: readonly FieldDiff[], ctx: ApplyContext): Promise<void>;
}

/**
 * Handles group membership: reads the current members of declared groups and
 * adds or removes a single membership. There is no bulk delete; the reconciler
 * expresses a removal as an update.
 */
export interface MembershipHandler {
  /** Read the current member set of each declared group. */
  readMembers(groups: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** Add a user to a group. */
  add(group: string, username: string): Promise<void>;
  /** Remove a user from a group. */
  remove(group: string, username: string): Promise<void>;
}

/**
 * The typed handler map an adapter supplies to build its {@link SeedClient}.
 * Each non-membership resource type maps to a {@link ResourceHandler};
 * membership has its own {@link MembershipHandler}. The present keys define the
 * engine's supported types.
 */
export type SeedHandlers = Partial<Record<Exclude<ResourceType, 'membership'>, ResourceHandler>> & {
  readonly membership?: MembershipHandler;
};

/**
 * The seed capability of an engine: which resource types it supports, how it
 * rewrites desired resources, and how to construct its {@link SeedClient}.
 */
export interface SeedSupport {
  /** Resource types this engine can reconcile. */
  readonly supportedTypes: ReadonlySet<ResourceType>;
  /**
   * Pure engine-specific rewrite of desired resources (value encoding,
   * trust-level-to-group mapping, and similar) before planning.
   */
  transformDesired(resources: readonly SeedResource[], forum: ForumModel): readonly SeedResource[];
  /** Build a {@link SeedClient} bound to the given dependencies. */
  createClient(deps: SeedClientDeps): SeedClient;
}

/**
 * Plugin contract for a forum engine. Implemented once per engine under
 * `src/engines/<engine>/` and registered in the EngineRegistry. All members are
 * pure except {@link SeedSupport.createClient}'s client, whose methods perform
 * the forum HTTP I/O.
 */
export interface EngineAdapter {
  /** Stable engine id, matched against `forums[].engine` in metadata. */
  readonly id: string;
  /** Minimum instance RAM in MB the engine needs; enforced against the bundle. */
  readonly minRamMb: number;
  /** Lightsail blueprint id to launch, e.g. `'ubuntu_22_04'`. */
  readonly blueprintId: string;
  /** Secret names the engine requires to be present in `forums[].secrets`. */
  readonly requiredSecrets: readonly ForumSecretName[];
  /** Schema validating `forums[].engineOptions` for this engine. */
  readonly engineOptionsSchema: z.ZodType<unknown>;
  /**
   * Engine-specific cross-field validation (reserved setting names, trust-level
   * mapping, and similar). Pure; returns issues rather than throwing.
   */
  validate(forum: ForumModel, environment: EnvironmentModel): readonly ValidationIssue[];
  /** TLS capability consumed by the shared certificate manager (Req 13.2). */
  readonly tls: TlsSupport;
  /**
   * Pure bash fragment appended after the shared prelude and TLS section. No
   * CDK tokens, no secret values. May call prelude functions `fetch_secret`,
   * `write_secret`, `wait_for_dns` and `issue_certificate`; must call
   * `issue_certificate` before starting any listener on port 80 or 443.
   */
  renderInstallScript(input: InstallScriptInput): string;
  /**
   * Pure bash body of `refresh-email.sh`: applies the SES settings from fetched
   * files and supports a `--no-restart` flag for the initial configuration.
   */
  renderEmailRefreshScript(input: InstallScriptInput): string;
  /** The engine's seed capability. */
  readonly seed: SeedSupport;
}
