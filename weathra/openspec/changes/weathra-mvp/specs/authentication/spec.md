## Purpose

Weathra's identity and access boundary: Supabase Auth issues and verifies identity, the FastAPI backend derives every user identity from a validated token rather than anything the client asserts, and every user-owned record — saved locations, preferences, conversation memory — is reachable only by the user who owns it.

## ADDED Requirements

### Requirement: Supabase Auth is the identity system

The system SHALL use Supabase Auth as its sole identity and authentication provider for the MVP. Weathra SHALL NOT implement its own password storage, session issuance, or token signing, and SHALL NOT accept a client-asserted user or profile identifier as proof of identity.

Email and password SHALL be the supported credential type. Additional identity providers, enterprise single sign-on, and organization-level role hierarchies are outside this capability.

#### Scenario: Identity provided by Supabase Auth

- **WHEN** a person authenticates successfully
- **THEN** the session and access token were issued by Supabase Auth

#### Scenario: Client-asserted identity rejected

- **WHEN** a request presents a user or profile identifier as a header, query parameter, or body field without a valid access token
- **THEN** the request is rejected as unauthenticated
- **AND** the asserted identifier is not used to select or scope any data

#### Scenario: No local credential storage

- **WHEN** the application's persisted data is inspected
- **THEN** it contains no password, password hash, or session secret

### Requirement: Account creation with email and password

The system SHALL allow a person to create an account with an email address and a password. Password rules SHALL be stated to the person before submission, and a rejected password SHALL be reported with the rule it failed. An attempt to register an email that already has an account SHALL NOT reveal whether that account exists beyond what is needed to guide the person to sign in or reset their password.

#### Scenario: Account created

- **WHEN** a person submits a valid email and a password meeting the stated rules
- **THEN** an account is created in Supabase Auth
- **AND** the person is directed to verify their email

#### Scenario: Password fails the rules

- **WHEN** a person submits a password that does not meet the stated rules
- **THEN** the failure names the rule that was not met
- **AND** no account is created

#### Scenario: Email already registered

- **WHEN** a person submits an email that already has an account
- **THEN** the response does not confirm or deny the account's existence
- **AND** the person is offered sign-in and password-reset paths

### Requirement: Mandatory email verification

An account SHALL NOT be considered verified until its email address has been confirmed. Supabase Auth SHALL send the verification email, and Weathra SHALL NOT send verification mail itself. An unverified account SHALL NOT receive an authenticated session usable against protected Weathra features.

#### Scenario: Verification email sent by Supabase Auth

- **WHEN** an account is created
- **THEN** Supabase Auth sends the verification message to the submitted address

#### Scenario: Unverified account cannot reach protected features

- **WHEN** an account has been created but not verified
- **THEN** protected Weathra features remain inaccessible to it
- **AND** the person is shown the verification step rather than a generic failure

#### Scenario: Verified account admitted

- **WHEN** an account's email is confirmed
- **THEN** the person receives an authenticated session
- **AND** protected features become accessible

### Requirement: Verification code entry, resend, and states

Where the configured Supabase email verification flow delivers a code, the system SHALL provide a code-entry interface in Weathra that submits the code for verification. Where verification arrives as a link, the system SHALL handle the returning link and complete verification without requiring the person to re-enter anything.

The system SHALL provide a resend action, SHALL rate-limit resends and state the wait when one is refused, and SHALL present distinct, unambiguous states for verification success, an incorrect code, an expired code, a resend in progress, and a resend confirmed.

#### Scenario: Code entered and accepted

- **WHEN** a person enters the verification code they received
- **THEN** the account is verified
- **AND** a success state is shown before they continue

#### Scenario: Incorrect code

- **WHEN** a person enters a code that does not match
- **THEN** an incorrect-code state is shown
- **AND** they may retry or request a new code

#### Scenario: Expired code

- **WHEN** a person enters a code that has expired
- **THEN** an expired-code state is shown that is distinguishable from an incorrect code
- **AND** they are offered a resend

#### Scenario: Verification link followed

- **WHEN** a person follows the verification link from their email
- **THEN** verification completes without further entry
- **AND** a success state is shown

#### Scenario: Resend requested

- **WHEN** a person requests a new verification message
- **THEN** a resend-in-progress state is shown, followed by confirmation that it was sent

#### Scenario: Resend rate-limited

- **WHEN** a person requests a resend sooner than the rate limit allows
- **THEN** the refusal states how long they must wait
- **AND** no message is sent

### Requirement: Sign in and sign out

The system SHALL allow a verified person to sign in with their email and password, and SHALL allow a signed-in person to sign out. Failed sign-in SHALL NOT disclose whether the email exists or the password was wrong. Signing out SHALL end the session on the client and revoke it with Supabase Auth, and SHALL leave no authenticated state behind.

#### Scenario: Successful sign in

- **WHEN** a verified person submits correct credentials
- **THEN** they receive an authenticated session and reach the protected product area

#### Scenario: Failed sign in is non-disclosing

- **WHEN** a person submits an unknown email or an incorrect password
- **THEN** the failure message is the same in both cases
- **AND** does not reveal which was wrong

#### Scenario: Unverified person signs in

- **WHEN** an unverified person submits correct credentials
- **THEN** they are directed to the verification step
- **AND** protected features remain inaccessible

#### Scenario: Sign out

- **WHEN** a signed-in person signs out
- **THEN** the session is revoked with Supabase Auth
- **AND** protected features are no longer accessible without signing in again

### Requirement: Forgot password and password reset

The system SHALL allow a person to request a password reset for their email address, SHALL rely on Supabase Auth to send the reset message, and SHALL provide an interface to set a new password once the reset is verified. A reset request for an unknown address SHALL behave identically to one for a known address. An expired or already-used reset SHALL be reported as such with a path to request another.

#### Scenario: Reset requested and completed

- **WHEN** a person requests a reset, verifies via the code or link they received, and submits a new password meeting the stated rules
- **THEN** the password is updated
- **AND** they can sign in with the new password

#### Scenario: Reset request for an unknown address

- **WHEN** a person requests a reset for an address with no account
- **THEN** the response is identical to that for a known address

#### Scenario: Expired reset

- **WHEN** a person attempts to complete a reset whose code or link has expired
- **THEN** an expired state is shown
- **AND** they are offered the ability to request a new reset

#### Scenario: New password fails the rules

- **WHEN** a person submits a new password that does not meet the stated rules
- **THEN** the failure names the rule
- **AND** the existing password remains in force

### Requirement: Session persistence and expiry

An authenticated session SHALL persist across page reloads and browser restarts until it expires or is signed out, and SHALL be refreshed transparently while valid. When a session expires or cannot be refreshed, the system SHALL present an expired-session state, SHALL preserve the person's place well enough to return them there after signing in again, and SHALL NOT present an authentication failure as a data or server error.

#### Scenario: Session survives a reload

- **WHEN** an authenticated person reloads the application
- **THEN** they remain signed in without re-entering credentials

#### Scenario: Session refreshed transparently

- **WHEN** an access token nears expiry during use
- **THEN** it is refreshed without interrupting the person

#### Scenario: Session expires

- **WHEN** a session expires and cannot be refreshed
- **THEN** an expired-session state is shown
- **AND** after signing in again the person returns to where they were

#### Scenario: Expiry not misreported

- **WHEN** a request fails because the session expired
- **THEN** the interface reports an authentication problem, not a data or server failure

### Requirement: Backend validates every token

The backend SHALL derive the acting user's identity solely from a validated Supabase access token presented with the request. Validation SHALL check the token's signature against Supabase's published signing keys, its issuer, its audience, and its expiry, and SHALL reject a token failing any check. The backend SHALL NOT accept an unvalidated identifier from any header, parameter, or body field as identity.

Validation SHALL NOT require a network call to Supabase on every request, and the signing-key material SHALL be cached with a bounded refresh so that key rotation is picked up without a redeploy.

#### Scenario: Valid token accepted

- **WHEN** a request presents a valid, unexpired Supabase access token
- **THEN** the request proceeds as that token's subject
- **AND** the acting user identity equals the token's subject

#### Scenario: Missing token on a protected endpoint

- **WHEN** a request to a protected endpoint presents no token
- **THEN** it fails as unauthenticated
- **AND** no user-owned data is read or written

#### Scenario: Expired token

- **WHEN** a request presents an expired token
- **THEN** it fails as unauthenticated with a reason distinguishable from a malformed token

#### Scenario: Invalid signature

- **WHEN** a request presents a token whose signature does not verify
- **THEN** it fails as unauthenticated
- **AND** the failure is recorded without logging the token

#### Scenario: Wrong issuer or audience

- **WHEN** a request presents a well-formed token from a different issuer or for a different audience
- **THEN** it fails as unauthenticated

#### Scenario: Header identity ignored

- **WHEN** a request presents a valid token for one user together with a header naming a different user
- **THEN** the request acts as the token's subject
- **AND** the header is ignored

#### Scenario: Signing keys refreshed

- **WHEN** Supabase rotates its signing keys
- **THEN** validation picks up the new keys within the configured refresh window without a redeploy

### Requirement: Application profile linked to the auth user

The system SHALL maintain an application profile keyed by the Supabase Auth user identifier, holding only application-level fields Weathra needs and not duplicating credential or contact data held by Supabase Auth. A profile SHALL be created on first authenticated use if it does not exist, and profile creation SHALL be idempotent.

#### Scenario: Profile created on first use

- **WHEN** a newly verified user makes their first authenticated request
- **THEN** an application profile keyed by their auth user identifier exists afterwards

#### Scenario: Profile creation idempotent

- **WHEN** concurrent first requests arrive for the same new user
- **THEN** exactly one profile exists for that user afterwards

#### Scenario: No credential duplication

- **WHEN** the profile table is inspected
- **THEN** it holds no password material and no contact data beyond what Weathra's features require

### Requirement: User-owned data is scoped to its owner

Every user-owned record SHALL carry the owning auth user identifier and SHALL be readable and writable only by that user. This SHALL apply at minimum to saved locations, user preferences, conversation and session memory including agent checkpoints, stored agent runs and their evidence, and any record associating a user with a forecast snapshot.

Data classified as shared and non-user-owned — the weather provider cache, the knowledge corpus and its embeddings, and location-keyed forecast snapshots carrying no user reference — SHALL be documented as such and SHALL NOT carry a user identifier.

#### Scenario: Read scoped to owner

- **WHEN** an authenticated user reads their saved locations, preferences, memory, or agent runs
- **THEN** only records owned by that user are returned

#### Scenario: Write scoped to owner

- **WHEN** an authenticated user creates a user-owned record
- **THEN** the record is stored with that user as its owner

#### Scenario: Shared data carries no owner

- **WHEN** the provider cache, knowledge corpus, or location-keyed forecast snapshots are inspected
- **THEN** they carry no user identifier
- **AND** their non-user-owned classification is documented

#### Scenario: User-associated snapshot is scoped

- **WHEN** a forecast snapshot is recorded in association with a specific user
- **THEN** that association is stored as a user-owned record scoped to them

### Requirement: Cross-user access is denied

A user SHALL NOT be able to read or modify another user's saved locations, preferences, memory, conversation threads, agent runs, or any other private application record, by any means — including supplying another user's record identifier, thread identifier, profile identifier, or session identifier. Such an attempt SHALL fail without disclosing whether the target record exists.

#### Scenario: Cross-user read denied

- **WHEN** user A requests a record owned by user B by its identifier
- **THEN** the request fails
- **AND** the response does not reveal whether that record exists

#### Scenario: Cross-user mutation denied

- **WHEN** user A attempts to update or delete a record owned by user B
- **THEN** the request fails
- **AND** user B's record is unchanged

#### Scenario: Saved locations isolated

- **WHEN** user A and user B each save locations and each lists their own
- **THEN** each sees only their own saved locations

#### Scenario: Preferences isolated

- **WHEN** user A sets a unit preference
- **THEN** user B's preferences are unaffected and user B's requests do not use user A's preference

#### Scenario: Memory isolated

- **WHEN** user A holds a conversation and user B asks a follow-up in their own session
- **THEN** user B's follow-up resolves only against user B's context

#### Scenario: Foreign thread identifier rejected

- **WHEN** user A supplies a conversation thread identifier belonging to user B
- **THEN** the request fails as not found or forbidden
- **AND** no part of user B's conversation is returned

### Requirement: Endpoint protection classification

Every endpoint SHALL be explicitly classified public or protected, and the classification SHALL be documented. Protected endpoints SHALL require a validated token and SHALL reject unauthenticated requests. Public endpoints SHALL be limited to those serving no user-owned data — health and readiness, and the weather, location, history, analysis, and comparison endpoints that operate purely on supplied parameters.

A public endpoint SHALL NOT read or write user-owned data even when a token is present, other than applying the caller's preferences when they are authenticated.

#### Scenario: Protected endpoint rejects an unauthenticated request

- **WHEN** an unauthenticated request reaches a protected endpoint
- **THEN** it fails as unauthenticated
- **AND** no user-owned data is read or written

#### Scenario: Public weather endpoint serves without a token

- **WHEN** an unauthenticated request retrieves a forecast for a named location
- **THEN** the request succeeds

#### Scenario: Classification documented

- **WHEN** the API documentation is read
- **THEN** every endpoint is marked public or protected

#### Scenario: Public endpoint touches no user data

- **WHEN** a public endpoint is called
- **THEN** it reads and writes no user-owned record beyond applying an authenticated caller's own preferences

### Requirement: Authorization enforced in the backend, not the client

Authorization SHALL be enforced by the backend on every request. The system SHALL NOT rely on the frontend hiding a control, omitting a route, or filtering a list as the means of preventing access. Every ownership check SHALL be applied in the data access path so that a direct API call cannot bypass it.

#### Scenario: Direct API call cannot bypass the UI

- **WHEN** a request is made directly to the API for another user's record, bypassing the frontend entirely
- **THEN** the backend denies it

#### Scenario: Ownership enforced in the data path

- **WHEN** a query for user-owned data is executed
- **THEN** it is constrained to the acting user's ownership regardless of any identifier supplied by the caller

### Requirement: Row Level Security on user-owned tables

Row Level Security SHALL be enabled on every user-owned table, with policies restricting access to rows owned by the acting authenticated user. This SHALL hold for tables reachable through any Supabase access pattern, and SHALL act as a second gate behind the backend's own ownership checks rather than as a substitute for them.

Privileged database access used for migrations and administrative work SHALL be separate from the connection used to serve requests.

#### Scenario: Policies present on user-owned tables

- **WHEN** the database schema is inspected
- **THEN** Row Level Security is enabled on every user-owned table with an owner-restricting policy

#### Scenario: Policy blocks a foreign row

- **WHEN** a query runs under one user's identity against another user's row
- **THEN** the row is not returned

#### Scenario: Shared tables not restricted by owner

- **WHEN** the knowledge corpus and location-keyed snapshot tables are inspected
- **THEN** they are not subject to owner-restricting policies, consistent with their documented shared classification

#### Scenario: Administrative access separated

- **WHEN** the connection configuration is inspected
- **THEN** the privileged connection used for migrations is distinct from the connection serving requests

### Requirement: Secret handling

The Supabase service-role key and every other server-side secret SHALL exist only in server-side configuration and SHALL never be sent to, embedded in, or reachable from the browser. Only the Supabase project URL and its public client key SHALL be exposed to the frontend. Tokens and secrets SHALL NOT appear in logs, error responses, or evidence records.

#### Scenario: Service-role key absent from the browser bundle

- **WHEN** the built frontend bundle and its environment are inspected
- **THEN** the service-role key is not present in either

#### Scenario: Only public configuration exposed to the frontend

- **WHEN** the frontend's exposed configuration is inspected
- **THEN** it contains only the Supabase project URL and public client key

#### Scenario: No token material in logs or errors

- **WHEN** an authentication failure is logged and returned
- **THEN** neither the log record nor the response contains token or secret material

### Requirement: Authentication in streaming requests

Server-sent-event streams for agent requests SHALL require and validate a token exactly as request/response endpoints do, SHALL act as the token's subject for the whole stream, and SHALL terminate the stream with an authentication error event when the session becomes invalid mid-stream.

#### Scenario: Authenticated stream succeeds

- **WHEN** an authenticated user opens an agent stream
- **THEN** the stream runs as that user and their memory and preferences apply

#### Scenario: Unauthenticated stream refused

- **WHEN** an unauthenticated request opens an agent stream
- **THEN** the stream is refused as unauthenticated and no run begins

#### Scenario: Session invalidated mid-stream

- **WHEN** a session becomes invalid while a stream is open
- **THEN** the stream emits an authentication error event and closes

### Requirement: Account and data deletion

An authenticated user SHALL be able to delete their Weathra application data — saved locations, preferences, sessions, memory, and stored agent runs — and the system SHALL confirm the deletion. Deletion SHALL remove only that user's records and SHALL leave shared, non-user-owned data intact.

#### Scenario: User data deleted on request

- **WHEN** an authenticated user requests deletion of their Weathra data
- **THEN** their saved locations, preferences, sessions, memory, and agent runs are removed
- **AND** the system confirms the deletion

#### Scenario: Other users unaffected by a deletion

- **WHEN** one user deletes their data
- **THEN** every other user's records remain intact

#### Scenario: Shared data survives a user deletion

- **WHEN** a user deletes their data
- **THEN** the knowledge corpus, provider cache, and location-keyed snapshots are unaffected

### Requirement: Administrative and internal roles are server-held

The system SHALL support an administrative/internal role distinct from an ordinary authenticated user, held as backend state keyed by the validated token subject. The role SHALL be readable only by the backend and SHALL NOT be granted by any client-supplied field: a body field, query parameter, header, cookie, or unverified token claim asserting the role SHALL be ignored.

Administrative capabilities — model policy administration, model catalog administration, plan and allowance administration, aggregate usage reading, and the internal model lab — SHALL be refused for every principal without the role, and the refusal SHALL disclose nothing about the capability's existence or contents. Holding the role SHALL NOT grant access to another user's own data.

#### Scenario: Role established server-side

- **WHEN** the backend determines whether a request is administrative
- **THEN** it consults backend-held role state keyed by the token subject
- **AND** no client-supplied field contributes to the determination

#### Scenario: Asserted role ignored

- **WHEN** a request from an ordinary user carries a field, header, or unverified claim asserting the administrative role
- **THEN** the request is treated as non-administrative
- **AND** every administrative capability remains refused

#### Scenario: Administrative capability refused without the role

- **WHEN** an ordinary authenticated caller invokes a model policy, catalog, plan, aggregate usage, or model lab operation
- **THEN** the request is refused
- **AND** no policy, catalog, plan, usage, or lab content is disclosed

#### Scenario: Administrative role grants no access to user data

- **WHEN** an administrative principal requests another user's threads, memory, preferences, saved locations, or evidence records
- **THEN** the request is refused exactly as it would be for any other caller

#### Scenario: Administrative action attributed

- **WHEN** an administrative principal performs a privileged write
- **THEN** the acting principal and the time are recorded with the change

### Requirement: Plan and model entitlement are derived, never asserted

The system SHALL derive a principal's subscription plan and their entitlement to a model policy from backend-held state keyed by the validated token subject. A plan, policy identifier, model identifier, allowance, or entitlement presented by a client SHALL NOT grant access, raise an allowance, or change which model serves a request.

The frontend hiding or disabling a control SHALL NOT be the mechanism that prevents access to a premium model or a raised allowance, and a caller bypassing the frontend SHALL receive the same outcome as one using it.

#### Scenario: Plan derived from backend state

- **WHEN** an authenticated request is served
- **THEN** the effective plan comes from backend-held state keyed by the token subject

#### Scenario: Asserted plan or model ignored

- **WHEN** a request claims a higher plan, a policy identifier, or a model identifier above the principal's entitlement
- **THEN** the claim is ignored for both model resolution and allowance accounting

#### Scenario: Bypassing the UI changes nothing

- **WHEN** a caller calls the API directly requesting a premium model or a raised allowance
- **THEN** the outcome is identical to the same attempt through the frontend

### Requirement: Row Level Security on the SaaS-ready tables

The system SHALL classify every table introduced for subscription plans, model policies, the model catalog, language model usage events, usage limits and consumption, and model evaluations, and SHALL enforce that classification in the database as well as in the data path:

| Table class | Tables | Enforcement |
|---|---|---|
| user-owned | usage events carrying a user identifier, per-principal plan assignment, per-principal consumption counters | Row Level Security enabled with an owner-restricting policy; the request-serving restricted role may read and write only the owner's rows |
| operational, read-only to users | subscription plans, model policies, model catalog | readable as needed to serve a request; writable only through the administrative path, never by the request-serving restricted role acting for an ordinary user |
| operational, not user-owned | model evaluations, comparison runs and their results, internal consumption counters, administrative audit records | not exposed to an ordinary authenticated caller at all |

Existing Row Level Security policies SHALL NOT be weakened, removed, or bypassed to accommodate these tables, and no new table SHALL be served to a request path through the privileged connection to reach user-owned rows. Policies SHALL be established by migration so they are versioned with the schema.

#### Scenario: Policies present on the new user-owned tables

- **WHEN** the database is inspected after migration
- **THEN** Row Level Security is enabled with an owner-restricting policy on every new user-owned table

#### Scenario: Foreign usage row blocked by policy

- **WHEN** a query under the request-serving restricted role omits an owner predicate while reading usage events
- **THEN** it returns only the acting principal's rows

#### Scenario: Ordinary caller cannot write operational tables

- **WHEN** an ordinary authenticated caller attempts to write a plan, policy, or catalog row
- **THEN** the write is refused in the data path and by policy

#### Scenario: Existing policies unchanged

- **WHEN** the policies on profiles, preferences, saved locations, threads, checkpoints, and agent runs are compared before and after this change
- **THEN** none has been weakened, removed, or bypassed

#### Scenario: Request path does not use the privileged connection

- **WHEN** a request path reads or writes any new user-owned table
- **THEN** it does so under the request-serving restricted role
