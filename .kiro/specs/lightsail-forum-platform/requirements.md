# Requirements Document

## Introduction

The Lightsail Forum Platform is an infrastructure-as-code project, written in TypeScript with AWS CDK, that provisions an AWS Lightsail environment, deploys one or more open-source forum instances into that environment, and configures each forum from declarative YAML metadata.

The scope covers three concerns:

1. Environment provisioning: a shared Lightsail environment with static IPs, firewall rules, and automatic snapshots, plus DNS records in Amazon Route 53 (a Platform-created hosted zone or an existing operator-owned hosted zone) or, in external mode, DNS records managed outside the Platform.
2. Forum deployment: one Lightsail instance per declared forum, running Discourse (via discourse_docker) or Flarum (via Docker Compose with PHP and MySQL), installed through Lightsail user data and served over Let's Encrypt TLS on its own subdomain.
3. Forum configuration: a post-deploy TypeScript seeder CLI that reads the YAML metadata and idempotently applies categories, users, groups, trust levels, and settings through each forum's admin REST API.

Domain registration is out of scope. The operator registers the root domain (for example through Route 53 Domains or any other registrar) before deploying, and the operator updates the registrar name server delegation when the Platform creates the hosted zone. Route 53 is a global service, so all DNS resources are managed from the single Environment stack without a companion stack in another region.

TLS certificates are Let's Encrypt certificates obtained and renewed on each Forum_Instance. Lightsail certificates and non-exportable ACM certificates cannot be installed on Lightsail instances, and exportable ACM certificates are paid and out of scope. In Route 53 modes, certificate validation uses the ACME DNS-01 challenge through Route 53 where the Engine_Adapter supports it, and the ACME HTTP-01 challenge otherwise.

All forum outbound email is sent through Amazon SES, using a per-Environment domain identity and per-forum sending credentials created by the CDK app. Operator-supplied SMTP servers are not supported. Requesting SES production access (leaving the SES sandbox) and confirming SES availability in the chosen region remain operator responsibilities.

XenForo is out of scope because it is commercial software. The forum engine abstraction is pluggable so that XenForo or other engines can be added later without changes to the core platform. Secrets are stored in AWS Systems Manager Parameter Store or AWS Secrets Manager and are never stored in YAML metadata.

## Glossary

- **Platform**: The complete Lightsail Forum Platform codebase, including the CDK app, the Metadata_Loader, and the Seeder.
- **CDK_App**: The AWS CDK TypeScript application that synthesizes and deploys the CloudFormation stacks for the Environment and Forum_Instances.
- **Environment**: A named, isolated set of Lightsail resources (static IPs, instances, firewall rules) and associated DNS configuration that hosts one or more Forum_Instances.
- **Forum_Instance**: A single forum deployment consisting of one Lightsail instance, one static IP, one subdomain, and one Forum_Engine installation.
- **Forum_Engine**: A supported forum software package. Supported values in this release are `discourse` and `flarum`.
- **Engine_Adapter**: A pluggable TypeScript module that implements the provisioning (user data, sizing rules) and seeding (admin API calls) contract for one Forum_Engine.
- **Engine_Registry**: The component that maps a Forum_Engine identifier to its registered Engine_Adapter.
- **Metadata_File**: A YAML document that declares the Environment, its Forum_Instances, and the desired configuration (categories, users, groups, trust levels, settings) for each Forum_Instance.
- **Metadata_Loader**: The component that reads, parses, and validates a Metadata_File against the Metadata_Schema.
- **Metadata_Schema**: The formal schema that defines the valid structure, field types, and constraints of a Metadata_File.
- **Seeder**: The post-deploy TypeScript command-line tool that applies Forum_Instance configuration from a Metadata_File through each forum's admin REST API.
- **Secret_Reference**: A string in a Metadata_File that identifies a secret stored in SSM Parameter Store or Secrets Manager by name or ARN, in place of the secret value.
- **Secret_Store**: AWS Systems Manager Parameter Store or AWS Secrets Manager.
- **Bundle_Size**: The Lightsail instance plan identifier (for example `medium_3_0`) that determines RAM, vCPU, and disk.
- **DNS_Mode**: The DNS strategy for an Environment; one of `route53` (the CDK_App creates a public Hosted_Zone for the root domain), `route53-existing` (the CDK_App adds records to an operator-owned public Hosted_Zone declared by Hosted_Zone_ID), or `external` (DNS records managed outside the Platform).
- **Route53_Mode**: Either of the DNS_Mode values `route53` or `route53-existing`.
- **Hosted_Zone**: An Amazon Route 53 public hosted zone whose domain name equals the root domain of the Environment.
- **Hosted_Zone_ID**: The Route 53 identifier of an existing Hosted_Zone, declared in the Environment section of the Metadata_File when DNS_Mode is `route53-existing`; format `Z[A-Z0-9]+`.
- **Platform_Record**: A DNS record in a Hosted_Zone that the CDK_App created for the Environment.
- **Instance_Credentials**: The AWS credentials available on a Forum_Instance, scoped to the permissions of that Forum_Instance only.
- **TLS_Certificate**: The Let's Encrypt certificate for the Forum_Instance hostname, obtained and renewed on the Forum_Instance.
- **DNS01_Challenge**: The ACME DNS-01 challenge, validated by a TXT record at `_acme-challenge.<Forum_Instance hostname>`.
- **HTTP01_Challenge**: The ACME HTTP-01 challenge, validated by a file served over plain HTTP on TCP port 80 under the path `/.well-known/acme-challenge/`.
- **SES**: Amazon Simple Email Service, the only outbound email service used by Forum_Instances.
- **Mail_Domain**: The domain from which an Environment sends email; equal to the optional mail domain declared in the Environment section of the Metadata_File, or to the root domain when none is declared.
- **Email_Identity**: The SES domain identity for the Mail_Domain, created in the Environment region with Easy DKIM signing.
- **MAIL_FROM_Domain**: The custom SES MAIL FROM subdomain of the Mail_Domain (default `mail.<Mail_Domain>`) used for SPF alignment of bounce addresses.
- **Sender_Address**: The email address a Forum_Instance uses as the From address; declared as a local part or as a full address whose domain equals the Mail_Domain.
- **SES_SMTP_Endpoint**: The SES SMTP host `email-smtp.<region>.amazonaws.com` for the Environment region, on TCP port 587 with STARTTLS; derived by the Platform and not declared in the Metadata_File.
- **SES_SMTP_Credentials**: A per-Forum_Instance SMTP username and SMTP password derived from the access key of an IAM user whose permissions are limited to sending email from the Sender_Address of that Forum_Instance.
- **SES_Settings**: The outbound email settings a Forum_Engine needs to send through SES: SES_SMTP_Endpoint host and port, SES_SMTP_Credentials, and Sender_Address.
- **Configuration_Set**: The per-Environment SES configuration set that attaches event destinations to email sent by Forum_Instances.
- **Email_Event_Topic**: The per-Environment Amazon SNS topic that receives SES bounce and complaint events.
- **Credential_Rotation_Counter**: An optional non-negative integer declared per Forum_Instance in the Metadata_File; changing the value instructs the CDK_App to replace the SES_SMTP_Credentials of that Forum_Instance.
- **SES_Sandbox**: The default SES account state in a region, in which email can be sent only to verified identities and sending quotas are limited.
- **Seed_Resource**: A single configurable forum entity managed by the Seeder: a category, user, group, trust level assignment, or setting.
- **Natural_Key**: The identifier the Seeder uses to match a declared Seed_Resource to an existing forum entity (for example category slug, username, group name, setting key).
- **Dry_Run**: A Seeder execution mode that computes and reports intended changes without calling any mutating admin API endpoint.

## Requirements

### Requirement 1: Metadata File Definition and Validation

**User Story:** As a platform operator, I want to declare my environment and forums in a single validated YAML file, so that infrastructure and forum configuration come from one source of truth.

#### Acceptance Criteria

1. THE Metadata_Schema SHALL define an Environment section containing environment name, AWS region, Lightsail availability zone, DNS_Mode, an optional Hosted_Zone_ID, root domain, an administrator contact email, an optional mail domain, and an optional DMARC policy.
2. THE Metadata_Schema SHALL define a list of Forum_Instance entries, each containing a unique forum identifier, Forum_Engine, subdomain, Bundle_Size, Sender_Address, an optional Credential_Rotation_Counter, and a configuration section.
3. WHEN the Metadata_Loader receives a Metadata_File, THE Metadata_Loader SHALL parse the YAML and validate the result against the Metadata_Schema.
4. IF a Metadata_File fails Metadata_Schema validation, THEN THE Metadata_Loader SHALL report each violation with its field path and reason, and THE Metadata_Loader SHALL exit with a non-zero status.
5. IF two Forum_Instance entries in a Metadata_File share the same forum identifier or the same subdomain, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the duplicated value.
6. IF a Forum_Instance entry declares a Forum_Engine that has no Engine_Adapter in the Engine_Registry, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the unsupported Forum_Engine identifier.
7. THE Metadata_Loader SHALL produce the same validated in-memory model for a given Metadata_File on every invocation.
8. THE Platform SHALL provide an example Metadata_File that declares one Discourse Forum_Instance and one Flarum Forum_Instance and passes Metadata_Schema validation.
9. IF a Forum_Instance entry declares a Sender_Address whose domain differs from the Mail_Domain, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the field path, the Sender_Address domain, and the expected Mail_Domain.
10. WHEN a Forum_Instance entry declares the Sender_Address as a local part only, THE Metadata_Loader SHALL expand the Sender_Address to `<local part>@<Mail_Domain>` in the validated model.
11. IF the declared mail domain is neither equal to the root domain nor a subdomain of the root domain, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the mail domain field path.

### Requirement 2: Secret Handling

**User Story:** As a security-conscious operator, I want all secrets referenced rather than embedded, so that credentials never appear in source control or YAML files.

#### Acceptance Criteria

1. THE Metadata_Schema SHALL accept Secret_References for every secret-bearing field, including forum administrator passwords, admin API keys, and database passwords.
2. IF a secret-bearing field in a Metadata_File contains a value that is not a Secret_Reference, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the field path without printing the field value.
3. WHEN the CDK_App or the Seeder requires a secret value, THE Platform SHALL resolve the Secret_Reference from the Secret_Store at runtime.
4. IF a Secret_Reference cannot be resolved from the Secret_Store, THEN THE Platform SHALL report the unresolved Secret_Reference name and exit with a non-zero status.
5. THE Platform SHALL exclude resolved secret values from log output, CLI output, synthesized CloudFormation templates, and Lightsail user data scripts.
6. WHEN a Forum_Instance boots, THE Forum_Instance SHALL retrieve required secret values from the Secret_Store using credentials scoped to read only the secrets of that Forum_Instance.

### Requirement 3: Lightsail Environment Provisioning

**User Story:** As a platform operator, I want a single command to stand up a Lightsail environment, so that I can host forums without manual console work.

#### Acceptance Criteria

1. WHEN the operator runs the CDK_App deploy command with a valid Metadata_File, THE CDK_App SHALL provision the Environment in the AWS region declared in the Metadata_File.
2. WHERE DNS_Mode is `route53`, THE CDK_App SHALL create a public Hosted_Zone for the root domain declared in the Metadata_File.
3. WHERE DNS_Mode is `external`, THE CDK_App SHALL output, for each Forum_Instance, the fully qualified subdomain and static IP address required to create the external DNS A record.
4. THE CDK_App SHALL tag every Lightsail resource it creates that supports tags with the Environment name and, where applicable, the forum identifier, and SHALL carry the Environment name and forum identifier in the deterministic resource name of each Lightsail resource that does not support tags, including Lightsail static IPs.
5. THE CDK_App SHALL name Lightsail resources using a deterministic pattern derived from the Environment name and forum identifier.
6. WHEN the operator deploys two Environments with different Environment names in the same AWS account, THE CDK_App SHALL create resources for each Environment without name collisions.
7. WHEN the operator runs the CDK_App destroy command for an Environment, THE CDK_App SHALL take a final manual snapshot of each Lightsail instance of that Environment before deleting that instance, remove the Lightsail resources of that Environment, and retain each final manual snapshot after the destroy completes, since Lightsail deletes automatic snapshots together with their instance.

### Requirement 4: Forum Instance Provisioning

**User Story:** As a platform operator, I want each declared forum to get its own Lightsail instance and subdomain, so that forums are isolated and independently sized.

#### Acceptance Criteria

1. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL create one Lightsail instance per Forum_Instance entry in the Metadata_File.
2. THE CDK_App SHALL attach one Lightsail static IP to each Forum_Instance.
3. WHERE DNS_Mode is a Route53_Mode, THE CDK_App SHALL create in the Hosted_Zone a DNS A record mapping the subdomain of each Forum_Instance to the static IP of that Forum_Instance.
4. THE CDK_App SHALL configure the Lightsail firewall of each Forum_Instance to allow inbound TCP ports 80 and 443 from any address and inbound TCP port 22 only from the CIDR ranges declared in the Metadata_File.
5. IF a Forum_Instance entry declares a Bundle_Size below the minimum RAM defined by the Engine_Adapter of its Forum_Engine, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the minimum required RAM.
6. THE Discourse Engine_Adapter SHALL define a minimum RAM of 2 GB.
7. THE CDK_App SHALL enable Lightsail automatic snapshots on each Forum_Instance at the daily snapshot time declared in the Metadata_File, defaulting to 06:00 UTC when no time is declared.
8. WHEN a Forum_Instance entry is added to the Metadata_File and the CDK_App is redeployed, THE CDK_App SHALL create the new Forum_Instance and leave existing Forum_Instances unchanged.
9. WHEN a Forum_Instance entry is removed from the Metadata_File and the CDK_App is redeployed, THE CDK_App SHALL remove the Lightsail instance and static IP of the removed Forum_Instance and leave other Forum_Instances unchanged.

### Requirement 5: Discourse Installation

**User Story:** As a forum owner, I want Discourse installed automatically on its instance, so that the forum is reachable over HTTPS after deployment.

#### Acceptance Criteria

1. WHEN a Lightsail instance for a Discourse Forum_Instance first boots, THE Discourse Engine_Adapter user data SHALL install Docker and the official discourse_docker launcher.
2. THE Discourse Engine_Adapter SHALL generate a discourse_docker container configuration containing the Forum_Instance hostname, administrator email, and SES_Settings of the Forum_Instance, with the SES SMTP password retrieved from the Secret_Store at boot.
3. THE Discourse Engine_Adapter SHALL enable a Let's Encrypt TLS_Certificate for the Forum_Instance hostname using the administrator contact email, validated through the DNS01_Challenge via Route 53 when Requirement 13 selects the DNS01_Challenge and through the HTTP01_Challenge otherwise.
4. WHEN Discourse installation completes, THE Discourse Forum_Instance SHALL serve the Discourse web application over HTTPS on the Forum_Instance hostname.
5. WHEN Discourse installation completes, THE Discourse Engine_Adapter user data SHALL create an initial administrator account and an admin API key and store the API key in the Secret_Store under the Secret_Reference declared for that Forum_Instance.
6. IF Discourse installation fails, THEN THE Discourse Engine_Adapter user data SHALL write the failure reason to a log file on the instance and exit with a non-zero status.

### Requirement 6: Flarum Installation

**User Story:** As a forum owner, I want Flarum installed automatically on its instance, so that the forum is reachable over HTTPS after deployment.

#### Acceptance Criteria

1. WHEN a Lightsail instance for a Flarum Forum_Instance first boots, THE Flarum Engine_Adapter user data SHALL install Docker and Docker Compose.
2. THE Flarum Engine_Adapter SHALL generate a Docker Compose definition containing a Flarum PHP application service, a MySQL database service with a persistent volume, and a reverse proxy service.
3. THE Flarum Engine_Adapter SHALL configure the reverse proxy service to serve the TLS_Certificate obtained and renewed according to Requirement 13 for the Forum_Instance hostname, and to reload that TLS_Certificate after each renewal.
4. WHEN Flarum installation completes, THE Flarum Forum_Instance SHALL serve the Flarum web application over HTTPS on the Forum_Instance hostname.
5. WHEN Flarum installation completes, THE Flarum Engine_Adapter user data SHALL create an initial administrator account and an admin API key and store the API key in the Secret_Store under the Secret_Reference declared for that Forum_Instance.
6. THE Flarum Engine_Adapter SHALL configure Flarum outbound email using the SES_Settings of the Forum_Instance, with the SES SMTP password retrieved from the Secret_Store at boot.
7. IF Flarum installation fails, THEN THE Flarum Engine_Adapter user data SHALL write the failure reason to a log file on the instance and exit with a non-zero status.

### Requirement 7: Pluggable Engine Abstraction

**User Story:** As a platform developer, I want forum engines implemented as plugins behind a common interface, so that XenForo or other engines can be added later without changing core code.

#### Acceptance Criteria

1. THE Platform SHALL define an Engine_Adapter interface covering engine identifier, minimum RAM, user data generation, engine-specific metadata validation, and Seed_Resource operations for categories, users, groups, trust levels, and settings.
2. THE Engine_Registry SHALL resolve an Engine_Adapter by Forum_Engine identifier.
3. WHEN a developer registers a new Engine_Adapter in the Engine_Registry, THE CDK_App and the Seeder SHALL support the new Forum_Engine without modification to CDK_App or Seeder core modules.
4. IF an Engine_Adapter does not support a Seed_Resource type declared for a Forum_Instance, THEN THE Seeder SHALL report the unsupported Seed_Resource type and the Forum_Engine, and THE Seeder SHALL skip that Seed_Resource type for that Forum_Instance.
5. THE Platform SHALL provide a Discourse Engine_Adapter and a Flarum Engine_Adapter registered in the Engine_Registry.

### Requirement 8: Forum Configuration Seeding

**User Story:** As a community manager, I want categories, users, groups, trust levels, and settings applied from YAML, so that forum configuration is version-controlled and reproducible.

#### Acceptance Criteria

1. WHEN the operator runs the Seeder with a valid Metadata_File, THE Seeder SHALL apply the declared Seed_Resources to each Forum_Instance through the admin REST API of that Forum_Instance.
2. THE Seeder SHALL create declared categories that do not exist and update existing categories whose declared attributes differ, matching by category slug.
3. THE Seeder SHALL create declared users that do not exist and update existing users whose declared attributes differ, matching by username.
4. THE Seeder SHALL create declared groups that do not exist, update existing groups whose declared attributes differ, and set group membership to the declared members, matching by group name.
5. WHERE a Forum_Instance uses the Discourse Forum_Engine, THE Seeder SHALL assign each declared user the declared Discourse trust level.
6. WHERE a Forum_Instance uses the Flarum Forum_Engine, THE Seeder SHALL map declared trust levels to Flarum groups according to the mapping declared in the Metadata_File.
7. THE Seeder SHALL set each declared forum setting to the declared value, matching by setting key.
8. THE Seeder SHALL apply Seed_Resources in dependency order: settings, groups, categories, users, then group memberships and trust level assignments.
9. WHERE the operator passes a forum identifier option, THE Seeder SHALL apply Seed_Resources only to the Forum_Instance with that forum identifier.
10. THE Seeder SHALL leave forum entities that are not declared in the Metadata_File unchanged.
11. WHEN a declared user is created, THE Seeder SHALL set the initial password from the Secret_Reference declared for that user or, when none is declared, trigger the forum's password-reset email for that user.

### Requirement 9: Seeder Idempotency and Safety

**User Story:** As a platform operator, I want the seeder to be safe to re-run, so that I can apply changes repeatedly without duplicates or data loss.

#### Acceptance Criteria

1. WHEN the Seeder runs twice in succession with an unchanged Metadata_File against an unchanged Forum_Instance, THE Seeder SHALL perform zero create or update API calls during the second run.
2. THE Seeder SHALL compare each declared Seed_Resource with the current forum state by Natural_Key before issuing a mutating API call.
3. WHERE the operator passes the Dry_Run option, THE Seeder SHALL report each planned create and update per Forum_Instance and Seed_Resource and SHALL issue zero mutating API calls.
4. WHEN the Seeder completes, THE Seeder SHALL print a summary listing, per Forum_Instance, the count of created, updated, unchanged, skipped, and failed Seed_Resources.
5. IF an admin API call fails for a Seed_Resource, THEN THE Seeder SHALL record the failure with the Forum_Instance, Seed_Resource Natural_Key, and API error message, and THE Seeder SHALL continue with the remaining Seed_Resources.
6. IF any Seed_Resource fails during a Seeder run, THEN THE Seeder SHALL exit with a non-zero status after printing the summary.
7. IF the admin REST API of a Forum_Instance returns HTTP 429, THEN THE Seeder SHALL retry the request with exponential backoff up to 5 attempts.
8. IF a Forum_Instance is unreachable over HTTPS, THEN THE Seeder SHALL report the Forum_Instance as unreachable, skip that Forum_Instance, and continue with the remaining Forum_Instances.

### Requirement 10: Outputs and Operability

**User Story:** As a platform operator, I want clear deployment outputs and documentation, so that I can verify and operate the environment.

#### Acceptance Criteria

1. WHEN the CDK_App deploy completes, THE CDK_App SHALL output, for each Forum_Instance, the forum identifier, Forum_Engine, HTTPS URL, static IP address, and Lightsail instance name.
2. WHERE DNS_Mode is `route53`, THE CDK_App SHALL output the name servers of the Hosted_Zone.
3. THE Platform SHALL provide a README describing prerequisites (including registration of the root domain by the operator before deployment and SES availability in the Environment region), registrar name server delegation to the Hosted_Zone when DNS_Mode is `route53`, use of DNS_Mode `route53-existing` with a Hosted_Zone_ID, TLS_Certificate issuance and renewal, Secret_Store setup, SES setup and the procedure for requesting SES production access, Metadata_File structure, deploy, seed, and destroy commands, SES_SMTP_Credentials rotation, and the procedure for adding a new Engine_Adapter.
4. THE Platform SHALL provide automated unit tests for the Metadata_Loader, the Engine_Registry, each Engine_Adapter, and the Seeder reconciliation logic that run without AWS credentials or network access.
5. THE Platform SHALL provide CDK snapshot or assertion tests that verify the synthesized templates for an Environment containing one Discourse Forum_Instance and one Flarum Forum_Instance, including the Email_Identity, per-Forum_Instance SES sending IAM policies, Configuration_Set, and Email_Event_Topic, and verify for each DNS_Mode the Route 53 resources: the Hosted_Zone created only when DNS_Mode is `route53`, the per-Forum_Instance A records and email DNS records created only when DNS_Mode is a Route53_Mode, no Route 53 resources when DNS_Mode is `external`, and the DNS01_Challenge Route 53 permissions of each Forum_Instance.

### Requirement 11: Amazon SES Email

**User Story:** As a platform operator, I want every forum to send email through Amazon SES with authenticated DNS records and least-privilege credentials, so that forum email is deliverable and no forum can send as another.

#### Acceptance Criteria

1. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL create one Email_Identity for the Mail_Domain in the Environment region with Easy DKIM enabled.
2. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL configure the MAIL_FROM_Domain on the Email_Identity.
3. WHERE DNS_Mode is a Route53_Mode, THE CDK_App SHALL create in the Hosted_Zone the three Easy DKIM CNAME records of the Email_Identity, an MX record and an SPF TXT record for the MAIL_FROM_Domain, and a DMARC TXT record at `_dmarc.<Mail_Domain>`.
4. WHERE DNS_Mode is `external`, THE CDK_App SHALL output the name, type, and value of each Easy DKIM CNAME record, the MAIL_FROM_Domain MX and SPF TXT records, and the DMARC TXT record.
5. THE CDK_App SHALL set the DMARC policy to the DMARC policy declared in the Environment section of the Metadata_File, defaulting to `p=none` when no policy is declared.
6. IF the declared DMARC policy is not one of `none`, `quarantine`, or `reject`, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the DMARC policy field path.
7. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL create one IAM user per Forum_Instance whose permissions allow only the `ses:SendEmail` and `ses:SendRawEmail` actions on the Email_Identity, conditioned on `ses:FromAddress` equal to the Sender_Address of that Forum_Instance.
8. WHEN the CDK_App creates the IAM user of a Forum_Instance, THE CDK_App SHALL derive the SES_SMTP_Credentials of that Forum_Instance for the Environment region and store the SES SMTP password in the Secret_Store under the secret path of that Forum_Instance.
9. THE CDK_App SHALL exclude the IAM secret access key and the SES SMTP password from synthesized CloudFormation templates, CloudFormation outputs, resource tags, Lightsail user data scripts, and log output.
10. WHEN a Forum_Instance boots, THE Engine_Adapter user data of that Forum_Instance SHALL retrieve the SES SMTP password from the Secret_Store using the scoped credentials of that Forum_Instance and configure the Forum_Engine to send email through the SES_SMTP_Endpoint on port 587 with STARTTLS, using the SES_SMTP_Credentials and the Sender_Address of that Forum_Instance.
11. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL create one Configuration_Set for the Environment and set the Configuration_Set as the default configuration set of the Email_Identity.
12. WHEN the CDK_App deploys an Environment, THE CDK_App SHALL create one Email_Event_Topic, subscribe the administrator contact email to the Email_Event_Topic, and attach an event destination to the Configuration_Set that publishes bounce and complaint events to the Email_Event_Topic.
13. THE Platform SHALL rely on the SES account-level suppression list for bounced and complained recipient addresses and SHALL document this behaviour in the README.
14. WHEN the CDK_App deploy completes, THE CDK_App SHALL output the Email_Identity domain, the SES_SMTP_Endpoint, the Sender_Address of each Forum_Instance, and a reminder that SES production access is required to send to unverified recipients while the account is in the SES_Sandbox.
15. WHEN the operator changes the Credential_Rotation_Counter of a Forum_Instance and redeploys the CDK_App, THE CDK_App SHALL create a new access key for the IAM user of that Forum_Instance, store the newly derived SES SMTP password in the Secret_Store, and delete the previous access key.
16. WHILE the Credential_Rotation_Counter of a Forum_Instance is unchanged, THE CDK_App SHALL leave the access key and stored SES SMTP password of that Forum_Instance unchanged on redeploy.
17. WHEN a Forum_Instance entry is removed from the Metadata_File and the CDK_App is redeployed, THE CDK_App SHALL remove the IAM user and SES SMTP password of the removed Forum_Instance and leave the SES_SMTP_Credentials of other Forum_Instances unchanged.

### Requirement 12: Route 53 DNS

**User Story:** As a platform operator, I want forum and email DNS records managed in Amazon Route 53, either in a hosted zone the Platform creates or in one I already own, so that DNS is provisioned with the Environment without touching records I manage myself.

#### Acceptance Criteria

1. THE Metadata_Schema SHALL accept exactly the DNS_Mode values `route53`, `route53-existing`, and `external`.
2. IF DNS_Mode is `route53-existing` and the Metadata_File declares no Hosted_Zone_ID, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the Hosted_Zone_ID field path.
3. IF the Metadata_File declares a Hosted_Zone_ID and DNS_Mode is not `route53-existing`, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the Hosted_Zone_ID field path.
4. IF a declared Hosted_Zone_ID does not match the pattern `Z[A-Z0-9]+`, THEN THE Metadata_Loader SHALL reject the Metadata_File and report the Hosted_Zone_ID field path.
5. WHERE DNS_Mode is `route53-existing`, WHEN the operator runs the CDK_App deploy command, THE CDK_App SHALL look up the Hosted_Zone identified by the Hosted_Zone_ID before creating any DNS record.
6. WHERE DNS_Mode is `route53-existing`, IF the public Route 53 hosted zone found for the root domain has an ID different from the declared Hosted_Zone_ID, THEN THE CDK_App SHALL stop synthesis before creating any DNS record, report the declared Hosted_Zone_ID, the found hosted zone ID, and the root domain, and exit with a non-zero status.
7. WHERE DNS_Mode is `route53-existing`, IF no public Hosted_Zone exists for the root domain, including when only a private hosted zone exists for the root domain, THEN THE CDK_App SHALL stop before creating any DNS record, report the root domain and the lookup failure, and exit with a non-zero status.
8. WHERE DNS_Mode is `route53-existing`, THE CDK_App SHALL limit Route 53 changes to creating, updating, and deleting Platform_Records, leaving the Hosted_Zone and all other records in the Hosted_Zone unchanged.
9. WHERE DNS_Mode is `route53-existing`, IF a record that the CDK_App would create already exists in the Hosted_Zone and is not a Platform_Record, THEN THE CDK_App SHALL report the record name and type and fail the deployment without modifying the existing record.
10. WHERE DNS_Mode is `route53`, WHEN the operator runs the CDK_App destroy command, THE CDK_App SHALL remove all Platform_Records before removing the Hosted_Zone.
11. WHERE DNS_Mode is `route53-existing`, WHEN the operator runs the CDK_App destroy command, THE CDK_App SHALL remove the Platform_Records and retain the Hosted_Zone.
12. WHEN a Forum_Instance entry is removed from the Metadata_File and the CDK_App is redeployed, THE CDK_App SHALL remove the Platform_Records of the removed Forum_Instance and leave the Platform_Records of other Forum_Instances unchanged.
13. THE CDK_App SHALL manage all Route 53 resources of an Environment within the single stack of that Environment in the Environment region.

### Requirement 13: TLS Certificates

**User Story:** As a forum owner, I want each forum to obtain and renew its Let's Encrypt certificate automatically, using DNS validation through Route 53 where possible, so that the forum stays reachable over HTTPS without operator action.

#### Acceptance Criteria

1. WHEN a Forum_Instance first boots, THE Engine_Adapter user data of that Forum_Instance SHALL obtain a TLS_Certificate from Let's Encrypt for the Forum_Instance hostname on the Forum_Instance.
2. THE Engine_Adapter interface SHALL declare whether the Engine_Adapter supports the DNS01_Challenge through Route 53.
3. WHERE DNS_Mode is a Route53_Mode and the Engine_Adapter supports the DNS01_Challenge, THE Engine_Adapter user data SHALL validate the TLS_Certificate through the DNS01_Challenge by writing the challenge TXT record to the Hosted_Zone with the Instance_Credentials.
4. WHERE DNS_Mode is a Route53_Mode and the Engine_Adapter does not support the DNS01_Challenge, THE Engine_Adapter user data SHALL validate the TLS_Certificate through the HTTP01_Challenge.
5. WHERE DNS_Mode is `external`, THE Engine_Adapter user data SHALL validate the TLS_Certificate through the HTTP01_Challenge.
6. WHERE a Forum_Instance validates the TLS_Certificate through the DNS01_Challenge, THE CDK_App SHALL grant the Instance_Credentials of that Forum_Instance the `route53:ChangeResourceRecordSets` action on the Hosted_Zone only, conditioned on `route53:ChangeResourceRecordSetsNormalizedRecordNames` equal to `_acme-challenge.<Forum_Instance hostname>` and `route53:ChangeResourceRecordSetsRecordTypes` equal to `TXT`.
7. WHERE a Forum_Instance validates the TLS_Certificate through the DNS01_Challenge, THE CDK_App SHALL grant the Instance_Credentials of that Forum_Instance, in addition to the scoped action in criterion 6, only the read-only Route 53 actions `route53:GetChange` and `route53:ListResourceRecordSets` on the Hosted_Zone, excluding `route53:ListHostedZones` and `route53:ListHostedZonesByName`, and THE Engine_Adapter user data SHALL supply the Hosted_Zone ID to the ACME client directly.
8. WHERE a Forum_Instance validates the TLS_Certificate through the HTTP01_Challenge, THE CDK_App SHALL grant the Instance_Credentials of that Forum_Instance zero Route 53 permissions.
9. THE Forum_Instance SHALL check the TLS_Certificate for renewal at least once every 24 hours.
10. WHEN the TLS_Certificate of a Forum_Instance has fewer than 30 days remaining before expiry, THE Forum_Instance SHALL renew the TLS_Certificate using the same challenge type that issued the TLS_Certificate, without operator action.
11. IF a TLS_Certificate renewal attempt fails, THEN THE Forum_Instance SHALL write the failure reason to `/var/log/community-hub/install.log`, continue serving the current TLS_Certificate, and retry at the next scheduled renewal check.
12. IF TLS_Certificate issuance fails during installation, THEN THE Engine_Adapter user data SHALL write the failure reason to `/var/log/community-hub/install.log` and exit with a non-zero status, consistent with Requirement 5.6 and Requirement 6.7.
13. IF TLS_Certificate issuance fails during installation, THEN THE Forum_Instance SHALL limit plain HTTP responses on TCP port 80 to HTTP01_Challenge paths and serve no forum application content over plain HTTP.
14. WHILE a valid TLS_Certificate is installed, THE Forum_Instance SHALL answer plain HTTP requests outside HTTP01_Challenge paths with a redirect to the HTTPS URL of the same path.
