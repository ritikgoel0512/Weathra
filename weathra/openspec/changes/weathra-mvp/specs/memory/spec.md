## Purpose

The shared memory layer: short-term conversation state that lets a follow-up question mean something, and a durable preference store that lets Weathra know a person's saved locations, units, and horizon — held in PostgreSQL, owned by the authenticated user who created it, and deliberately narrow about what it keeps.

Identity here always comes from the validated authentication token, never from a client-asserted identifier; see `specs/authentication`.

## ADDED Requirements

### Requirement: Short-term memory scoped by user and thread

The system SHALL maintain short-term memory scoped to the pair of the authenticated user and a conversation thread, persisted so that it survives a backend restart and is shared across backend instances. Session memory SHALL hold the turn history and the resolved entities a follow-up may refer to — locations, units, window, criterion, and the last data class used.

Every thread SHALL have an owning user recorded at creation. A request naming a thread SHALL be served only when the acting authenticated user owns that thread; otherwise it SHALL fail without disclosing whether the thread exists.

#### Scenario: Session state persists across a restart

- **WHEN** a user establishes context in a thread, the backend restarts, and a follow-up arrives for the same thread from the same user
- **THEN** the follow-up resolves against the previously established context

#### Scenario: Resolved entities recorded

- **WHEN** a turn resolves a location, units, and window
- **THEN** those resolved entities are recorded in that user's thread memory

#### Scenario: Threads are isolated between users

- **WHEN** a user names a thread owned by a different user
- **THEN** the request fails without disclosing whether the thread exists
- **AND** no turns or entities from that thread are returned

#### Scenario: Threads are isolated within a user

- **WHEN** a user holds two separate threads
- **THEN** a follow-up in one resolves only against that thread's context

#### Scenario: Thread ownership recorded at creation

- **WHEN** a new conversation thread is created
- **THEN** the acting authenticated user is recorded as its owner

### Requirement: Follow-up reference resolution

Short-term memory SHALL support resolving a follow-up question against the immediately preceding turns, including references to locations established earlier, to the previously used window, and to the previously used units.

#### Scenario: Location carried into a follow-up

- **WHEN** a caller says "Compare Berlin and Munich" and then asks "Which one is warmer tomorrow?"
- **THEN** the second turn resolves to Berlin and Munich from session memory

#### Scenario: Window carried into a follow-up

- **WHEN** a caller asks about the next 3 days and then asks "What about precipitation?"
- **THEN** the second turn uses the same 3-day window

#### Scenario: Reference not present in memory

- **WHEN** a follow-up refers to something no earlier turn established
- **THEN** memory reports the reference unresolved rather than returning a guess

### Requirement: Conversation retention is bounded and non-sensitive by default

The system SHALL NOT persist arbitrary conversation content indefinitely. Session turn history SHALL be retained only for a bounded configured period and then removed, and the stored representation SHALL be limited to what follow-up resolution and evidence display require. The system SHALL provide an operation to delete a session's memory on request, and SHALL confirm the deletion.

#### Scenario: Expired session memory removed

- **WHEN** a session's retention period has elapsed
- **THEN** its turn history is removed by the retention process

#### Scenario: Session memory deleted on request

- **WHEN** a caller requests deletion of their session memory
- **THEN** the session's turns and resolved entities are removed
- **AND** the system confirms the deletion

#### Scenario: Only necessary content stored

- **WHEN** a session's stored representation is inspected
- **THEN** it contains the turn text, resolved entities, and evidence references required for follow-ups and evidence display, and nothing further

### Requirement: Durable preference store

The system SHALL persist, scoped to the authenticated user, only explicitly chosen non-sensitive preferences: preferred unit system, preferred forecast horizon, default location, and other preferences the person explicitly sets. Preferences SHALL survive session expiry and backend restarts, SHALL be readable, updatable, and deletable by their owner, and SHALL have documented defaults applied when unset.

The system SHALL NOT infer and persist preferences from behavior without an explicit choice.

#### Scenario: Preference set and applied

- **WHEN** a person sets imperial units as their preference
- **THEN** later requests for that profile default to imperial units

#### Scenario: Preferences outlive the session

- **WHEN** a person's session expires and they return in a new session
- **THEN** their saved preferences still apply

#### Scenario: Defaults when unset

- **WHEN** a profile has set no preferences
- **THEN** the documented defaults apply and are reported as defaults rather than as choices

#### Scenario: Preferences deleted on request

- **WHEN** a person deletes their preferences
- **THEN** they are removed and the documented defaults apply again

#### Scenario: No inferred preferences persisted

- **WHEN** a person repeatedly asks about one location without saving it
- **THEN** that location is not persisted as a preference

### Requirement: Saved locations

The system SHALL let a person save named locations to their profile, list them, and remove them. A saved location SHALL store the canonical resolved location rather than the raw query text, so it does not need re-resolving. Saving the same location twice SHALL NOT create a duplicate. A saved-location limit SHALL be enforced with the limit stated in the error.

#### Scenario: Location saved and listed

- **WHEN** a person saves a resolved location
- **THEN** it appears in their saved locations list with its canonical name, coordinates, and timezone

#### Scenario: Duplicate save is not duplicated

- **WHEN** a person saves a location already in their list
- **THEN** the list still contains one entry for it

#### Scenario: Saved location removed

- **WHEN** a person removes a saved location
- **THEN** it no longer appears in their list

#### Scenario: Saved-location limit reached

- **WHEN** a person saves more locations than the limit allows
- **THEN** the request fails with an error stating the limit

### Requirement: Ownership derived from the authenticated user

Every persisted preference, saved location, thread, and stored agent run SHALL be owned by the authenticated user identified by the request's validated token, and the owning identifier SHALL be that user's authentication subject. A caller SHALL never read or modify another user's data, and an identifier supplied by the caller SHALL NOT override the token's subject as the ownership scope.

A request to a memory-backed operation without a validated token SHALL fail as unauthenticated.

#### Scenario: Ownership taken from the token

- **WHEN** an authenticated user writes a preference or saved location
- **THEN** the record's owner is the token's subject

#### Scenario: Supplied identifier does not override the token

- **WHEN** a request presents a valid token for one user and a body or header field naming another user
- **THEN** the operation is scoped to the token's subject
- **AND** the supplied field is ignored

#### Scenario: Users isolated

- **WHEN** two authenticated users each save locations and each lists their own
- **THEN** each sees only their own saved locations

#### Scenario: Unauthenticated memory access refused

- **WHEN** a request with no validated token attempts to read or write preferences, saved locations, or thread memory
- **THEN** the request fails as unauthenticated
- **AND** no user-owned record is read or written

### Requirement: Memory unavailability degrades honestly

When the memory store is unavailable, the system SHALL continue to serve stateless capabilities — forecast, historical, analytics, comparison, and location resolution — and SHALL report that conversation context and preferences are unavailable rather than silently answering a follow-up without context.

#### Scenario: Stateless capabilities survive memory outage

- **WHEN** the memory store is unavailable
- **THEN** forecast, historical, analytics, and comparison requests still succeed

#### Scenario: Follow-up during memory outage

- **WHEN** a follow-up question arrives while the memory store is unavailable
- **THEN** the system states that conversation context is unavailable
- **AND** does not answer the follow-up as though context had been applied
