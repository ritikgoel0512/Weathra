## Purpose

The Next.js application people actually use: a dashboard that briefs them, an analyst they can question, historical and comparison screens that carry the argument, an evidence screen that shows the work, and saved locations and settings that make it theirs — a separately structured frontend that consumes the documented API and nothing else.

## ADDED Requirements

### Requirement: Separate frontend application

The frontend SHALL be a Next.js application written in React and TypeScript, developed, built, and deployed independently of the backend. It SHALL communicate with the backend exclusively through the documented versioned API and SSE streams, and the backend SHALL NOT serve the frontend's pages or assets.

The backend's base URL SHALL be frontend configuration, so the two may be deployed to different origins and later placed behind one domain without code changes. The only Supabase configuration exposed to the browser SHALL be the project URL and the public client key; no server-side secret, and in particular no service-role key, SHALL be present in the frontend's configuration or built bundle.

#### Scenario: Frontend builds independently

- **WHEN** the frontend is built
- **THEN** it builds without the backend running

#### Scenario: Backend does not serve the UI

- **WHEN** the backend's routes are inspected
- **THEN** none of them serves frontend pages or assets

#### Scenario: Backend URL is configuration

- **WHEN** the configured backend base URL is changed
- **THEN** the frontend targets the new origin with no code change

#### Scenario: Only documented endpoints used

- **WHEN** the frontend's network calls are inspected
- **THEN** every call targets a documented versioned API endpoint, an SSE stream, or Supabase Auth

### Requirement: Visily design artifacts precede implementation

Frontend implementation SHALL follow approved design artifacts produced in **Visily.ai**. A Visily design phase SHALL complete before substantial frontend implementation begins and SHALL cover both the authentication experience and the core product experience. Visily is the design tool for the remaining UI/UX work; the earlier UXPilot exploration is prior art whose approved decisions are carried forward under the requirement below rather than rediscovered.

The design phase SHALL establish a shared Weathra design system covering typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, loading states, empty states, error states, and authentication states. Every MVP screen — authentication and product alike — SHALL have an approved design artifact recorded in the repository documentation before its implementation is considered complete. Implemented screens SHALL follow the approved artifacts rather than generic generated styling, and any deliberate divergence SHALL be recorded with its reason.

The design gate SHALL be satisfiable with Visily's freely available capabilities. No paid Visily export capability, no design-to-code handoff, and no other design tool — Figma included — SHALL be required to satisfy it: an approved Visily screen is a visual reference, and implementing it manually in Next.js against the recorded design system SHALL be a conforming implementation path.

#### Scenario: Design phase precedes implementation

- **WHEN** substantial frontend implementation begins
- **THEN** the Visily artifacts covering the authentication screens, the product screens, and the shared design system are already approved and recorded

#### Scenario: No paid export or second tool required

- **WHEN** the design gate is satisfied for a screen
- **THEN** it was satisfied without a paid Visily export capability and without Figma or any other design tool

#### Scenario: Manual implementation conforms

- **WHEN** an approved Visily screen is implemented by hand in Next.js against the recorded design system
- **THEN** the implementation conforms to the gate, no generated-code export being required

#### Scenario: Design system established

- **WHEN** the recorded design system is inspected
- **THEN** it covers typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, loading, empty, error, and authentication states

#### Scenario: Screen implemented against a design artifact

- **WHEN** an MVP screen is implemented
- **THEN** its design artifact is referenced in the repository documentation
- **AND** the implementation follows it rather than generic generated styling

#### Scenario: Post-MVP screens represented in the design roadmap

- **WHEN** the design roadmap is inspected
- **THEN** Weather Intelligence Report, Forecast Explorer, Weather Scenario Lab, Weather Watch, Travel Intelligence, Admin Model & AI Usage, and Plan & Usage are represented as post-MVP

#### Scenario: Divergence recorded

- **WHEN** an implemented screen deliberately diverges from its design artifact
- **THEN** the divergence and its reason are recorded

### Requirement: Approved design direction carried into Visily

The design decisions already approved during the earlier UXPilot exploration SHALL be carried into Visily as design-direction inputs rather than rediscovered, and the Visily design system and screens SHALL conform to them. The carried-forward direction is:

| Decision | What it fixes |
|---|---|
| **Midnight Intelligence** palette | The dark-first color direction and its token set, with the light appearance derived from it |
| **Plus Jakarta Sans** for display and heading type, **Inter** for body and UI type | The typographic pairing and its role assignment |
| **Intelligent Command Center** shell with persistent left navigation | The application frame: a persistent left navigation identifying the signed-in person and reaching every screen |
| Location-focused **Dashboard** | The Dashboard is organized around a chosen or default location rather than a generic feed |
| Premium modern SaaS visual direction | The overall level of visual finish: density, elevation, restraint, and chart treatment |
| **Weathra Intelligence** | The named synthesized briefing surface on the Dashboard |
| **What Changed?** | The named surface for forecast movement since the last captured snapshot |
| **Why?** | The named surface explaining what drove a stated conclusion |
| **Agent Evidence** | The named surface showing the run record behind an answer |
| Visible distinction between **Observed**, **Forecast**, **Historical**, **Deterministic Analytics**, and **AI Interpretation** | Data class is a presentational primitive, not prose |
| Source attribution | Provider, location, and period shown on every weather-bearing surface |
| Timestamps | Retrieval and validity times shown rather than implied |
| Uncertainty and confidence presentation | Confidence and its stated basis are presented, not omitted or overstated |
| No implication that the language model predicts numerical weather values | Nothing in the visual or copy direction may suggest the model produces measurements |

These decisions SHALL be recorded as approved design-direction inputs with their UXPilot origin noted, and any later departure from one SHALL be recorded with its reason in the same way a screen-level divergence is.

#### Scenario: Direction carried forward rather than rediscovered

- **WHEN** the Visily design system is inspected
- **THEN** every carried-forward decision above is present in it
- **AND** each is recorded as an approved design-direction input rather than reopened

#### Scenario: Palette and typography conform

- **WHEN** the recorded design tokens are inspected
- **THEN** the color tokens are the Midnight Intelligence palette and the type roles are Plus Jakarta Sans for display and heading and Inter for body and UI

#### Scenario: Shell and Dashboard conform

- **WHEN** the Visily screens are inspected
- **THEN** they share the Intelligent Command Center shell with persistent left navigation
- **AND** the Dashboard is organized around a chosen or default location

#### Scenario: Data-class distinction preserved in the design

- **WHEN** any screen presenting weather data is inspected
- **THEN** observed, forecast, historical, deterministic-analytics, and AI-interpretation content are visibly distinguished, attributed, timestamped, and carry their uncertainty
- **AND** nothing in the design implies the language model produced a numerical weather value

#### Scenario: Departure from the direction recorded

- **WHEN** a Visily design deliberately departs from a carried-forward decision
- **THEN** the departure and its reason are recorded

### Requirement: MVP authentication screens

The frontend SHALL implement these authentication screens and states in the MVP, each following its approved design artifact:

| Screen / state | Purpose |
|---|---|
| Sign In | Email and password sign-in with a non-disclosing failure state |
| Create Account | Sign-up with the password rules stated before submission |
| Verify Email / Enter Verification Code | Code entry for the configured Supabase verification flow, and handling of a returning verification link |
| Verification Successful | Confirmation before continuing into the product |
| Verification Failed / Expired Code | Distinct incorrect-code and expired-code states |
| Resend Verification Code | Resend action with in-progress, confirmed, and rate-limited states |
| Forgot Password | Reset request with an identical response for known and unknown addresses |
| Reset Password | New-password entry with the rules stated and an expired-reset state |

Authentication screens SHALL be reachable without an authenticated session, and SHALL redirect an already-authenticated person into the product rather than showing a sign-in form.

#### Scenario: Sign-up through verification to the product

- **WHEN** a person creates an account, enters the verification code they received, and continues
- **THEN** the success state is shown and they reach the protected product area

#### Scenario: Incorrect and expired codes distinguished

- **WHEN** a person enters an incorrect code, and separately an expired code
- **THEN** the two states are visibly distinct and each offers the appropriate next step

#### Scenario: Resend states shown

- **WHEN** a person requests a new verification code
- **THEN** an in-progress state is shown followed by confirmation
- **AND** a request made too soon shows how long they must wait

#### Scenario: Verification link handled

- **WHEN** a person follows the verification link from their email
- **THEN** verification completes without further entry and the success state is shown

#### Scenario: Sign-in failure non-disclosing

- **WHEN** a person submits an unknown email, and separately a wrong password
- **THEN** the same failure message is shown in both cases

#### Scenario: Unverified sign-in routed to verification

- **WHEN** an unverified person signs in with correct credentials
- **THEN** they are shown the verification step rather than the product or a generic error

#### Scenario: Forgot password through reset

- **WHEN** a person requests a reset, verifies, and sets a new password meeting the stated rules
- **THEN** the new password takes effect and they can sign in with it

#### Scenario: Expired reset

- **WHEN** a person attempts to complete an expired reset
- **THEN** an expired state is shown with the option to request another

#### Scenario: Authenticated person redirected away from auth screens

- **WHEN** an authenticated person opens the sign-in or create-account screen
- **THEN** they are redirected into the product

### Requirement: Protected areas and authentication states

The frontend SHALL treat the product screens as protected. An unauthenticated visitor SHALL be routed to sign-in rather than shown an empty or broken product screen, and after signing in SHALL be returned to where they were going. Route protection SHALL be applied before a protected screen renders, and SHALL NOT be the only place authorization is enforced — the backend remains authoritative.

The frontend SHALL show a distinct state while authentication status is still being determined, and SHALL NOT flash protected content before that resolves. An authenticated session SHALL persist across reloads and browser restarts, and SHALL be refreshed transparently while valid. When a session expires, the frontend SHALL show an expired-session state, return the person to sign-in, and preserve their destination — never presenting an authentication failure as a data or server error. A sign-out action SHALL be available wherever a person is signed in, and SHALL clear all client-side authenticated state.

#### Scenario: Unauthenticated visitor routed to sign-in

- **WHEN** an unauthenticated visitor opens a protected product screen
- **THEN** they are routed to sign-in
- **AND** no protected content is rendered

#### Scenario: Destination preserved through sign-in

- **WHEN** an unauthenticated visitor is routed to sign-in from a protected screen and then signs in
- **THEN** they arrive at the screen they originally requested

#### Scenario: Authentication status pending

- **WHEN** authentication status has not yet resolved
- **THEN** a distinct pending state is shown
- **AND** protected content does not flash before it resolves

#### Scenario: Session persists across a reload

- **WHEN** an authenticated person reloads the application
- **THEN** they remain signed in without re-entering credentials

#### Scenario: Expired session handled gracefully

- **WHEN** an API request fails because the session expired
- **THEN** an expired-session state is shown and the person is returned to sign-in
- **AND** the failure is not presented as a data or server error

#### Scenario: Sign out clears state

- **WHEN** a signed-in person signs out
- **THEN** all client-side authenticated state is cleared and protected screens are no longer reachable

#### Scenario: Backend remains authoritative

- **WHEN** a protected API request is made without a valid session
- **THEN** the backend rejects it regardless of what the frontend rendered

### Requirement: MVP product screens

The frontend SHALL implement these protected product screens in the MVP:

| Screen | Purpose |
|---|---|
| Dashboard | The Weathra Intelligence briefing for a chosen or default location: current conditions, forecast movement, anomalies, historical context, and What Changed? |
| AI Weather Analyst | Free-text questioning with streamed progress and a data-class-labelled answer |
| Historical Analytics | Historical retrieval, period comparison, and baseline comparison with charts |
| Compare Cities | Multi-location comparison with criterion selection and per-candidate evidence |
| Agent Evidence / Activity | The full record of a run: agents, tool calls, results, analytics methods, cited knowledge, timings |
| Saved Locations | List, add, and remove saved locations |
| Settings | Unit system, default forecast horizon, default location, sign-out, session-memory deletion, and deletion of the person's Weathra data |

Every MVP product screen SHALL be reachable from a persistent navigation surface visible to an authenticated person, and that surface SHALL identify who is signed in.

#### Scenario: MVP screens present and reachable

- **WHEN** an authenticated person opens the application
- **THEN** every MVP product screen is reachable from the persistent navigation
- **AND** the navigation identifies who is signed in

#### Scenario: Dashboard briefing rendered

- **WHEN** a person opens the Dashboard with a default or chosen location
- **THEN** it renders current conditions, forecast movement, anomalies, historical context, and What Changed?
- **AND** labels each part with its data class

#### Scenario: Analyst streams progress

- **WHEN** a person asks a question in the AI Weather Analyst
- **THEN** routing, agent, and tool progress appear as they occur
- **AND** the final answer appears with its data-class labels and attribution

#### Scenario: Evidence screen shows the run

- **WHEN** a person opens Agent Evidence for a completed question
- **THEN** it shows the agents that ran, each tool call and result, the analytics methods, the cited knowledge, and the timings

#### Scenario: Historical analytics rendered

- **WHEN** a person requests a period comparison on Historical Analytics
- **THEN** both periods, their deltas, and their charts render with the historical data class labelled

#### Scenario: Comparison rendered with evidence

- **WHEN** a person compares three cities
- **THEN** the ranking renders with each candidate's score and the values behind it

#### Scenario: Saved locations and settings work end to end

- **WHEN** an authenticated person saves a location and sets imperial units in Settings
- **THEN** the location appears in Saved Locations and later screens render in imperial units

#### Scenario: Saved data follows the person across sessions and devices

- **WHEN** a person signs in from a different browser
- **THEN** their saved locations and preferences are present

#### Scenario: Another person's data not visible

- **WHEN** a different person signs in on the same browser
- **THEN** they see only their own saved locations and preferences

### Requirement: Post-MVP screens are designed, not built

The frontend SHALL reserve navigation and routing structure for the post-MVP screens — Weather Intelligence Report, Forecast Explorer, Weather Scenario Lab, Weather Watch, Travel Intelligence, Admin Model & AI Usage, and Plan & Usage — without implementing their functionality in this change. Any such route present SHALL state plainly that the screen is not yet available rather than rendering a broken or empty screen.

One panel of one of those screens is an exception, and it is named rather than left to inference: the administrative model policy confirmation surface required below is implemented in this change, because the audited candidate-list confirmation it carries is the only administrative write the MVP's own evidence trail depends on. Every other panel of the Admin Model & AI Usage screen remains unbuilt and SHALL continue to state so on the same route, and the Plan & Usage route remains unbuilt entirely.

#### Scenario: Post-MVP route states its status

- **WHEN** a person navigates to a post-MVP screen's route
- **THEN** the screen states that it is not yet available
- **AND** does not render a broken or empty interface

#### Scenario: Post-MVP screens not advertised as working

- **WHEN** the navigation surface is inspected
- **THEN** post-MVP screens are either absent or marked as not yet available

#### Scenario: Plan & Usage route states its status without fetching

- **WHEN** any person navigates to the Plan & Usage route in this change
- **THEN** the route states that the screen is not yet available
- **AND** no catalog, usage, cost, or lab request is issued

#### Scenario: The administrative route states which of its panels are unbuilt

- **WHEN** any person navigates to the Admin Model & AI Usage route in this change
- **THEN** the route states that model status, token usage, cost, latency, errors and plan usage are not yet available
- **AND** no token-usage, cost, or plan-consumption request is issued for any visitor
- **AND** the policy confirmation surface below is the only part of the screen that loads anything, and every read it issues is one the backend refuses to a caller without the administrative role

### Requirement: Data classes and attribution are visible

Every displayed weather value SHALL carry a visible indication of its data class — current conditions, forecast, historical observation, computed statistic, or AI interpretation — and every screen showing weather data SHALL display the source provider, the location, the period covered, and the retrieval time. AI interpretation SHALL be visually distinguishable from retrieved data.

A surface that bears no weather value — a language-model run's own record, and nothing else in this change — SHALL NOT display a weather provenance field that does not apply to it. A weather provider, a location, a covered period, a retrieval time or a unit system SHALL be displayed on such a surface only where that field genuinely describes the content shown, and SHALL NOT be displayed as unreported, empty, or with a stand-in value merely to complete a footer's shape. Such a surface SHALL still identify the model and gateway that produced it wherever the backend reported them. This narrowing SHALL NOT apply to any surface bearing a weather value, whose four fields remain required above and are stated as unreported when the backend reported none.

#### Scenario: Value shows its data class

- **WHEN** any weather value is displayed
- **THEN** its data class is visible

#### Scenario: Attribution visible on screen

- **WHEN** a screen shows weather data
- **THEN** the source provider, location, period, and retrieval time are visible

#### Scenario: A non-weather-bearing surface omits the fields that do not apply

- **WHEN** a surface shows a language-model run's own record and no weather value
- **THEN** no weather provenance field that does not describe that record is displayed, as a value or as unreported
- **AND** the model and gateway the backend reported are still identified

#### Scenario: Interpretation visually distinct

- **WHEN** a screen shows AI interpretation alongside retrieved data
- **THEN** the interpretation is visually distinguishable from the data

#### Scenario: Uncertainty shown with forecasts

- **WHEN** a forecast figure is displayed
- **THEN** its uncertainty indication is displayed with it

### Requirement: Loading, empty, and error states

Every view SHALL show a distinct state while a request is in flight, when there is nothing yet to display, and when a request fails. A failure SHALL show the backend's error message and leave the person able to retry without reloading the page. An in-flight request SHALL disable its submit control so the same request is not issued twice. An empty result SHALL NOT be displayed as though it were a successful answer.

#### Scenario: Request in flight

- **WHEN** a view has issued a request that has not returned
- **THEN** it shows a loading state distinct from its empty state
- **AND** its submit control is disabled

#### Scenario: Request fails

- **WHEN** an API request fails
- **THEN** the view shows the backend's error message
- **AND** the person can retry without reloading the page

#### Scenario: Nothing entered yet

- **WHEN** a view has been opened with no input submitted
- **THEN** it shows an empty state explaining what to enter

#### Scenario: Stream interrupted

- **WHEN** an SSE stream fails partway through a question
- **THEN** the view shows what was received, states that the run did not complete, and offers a retry

### Requirement: Agent unavailability handled gracefully

When the backend reports the agent surface unavailable, the AI Weather Analyst SHALL state that it is unavailable and name the missing configuration, and every non-agent screen SHALL remain fully usable.

#### Scenario: Analyst unavailable

- **WHEN** the backend reports no inference provider configured
- **THEN** the AI Weather Analyst states that it is unavailable and names the missing configuration
- **AND** the Dashboard, Historical Analytics, Compare Cities, and Saved Locations screens remain usable

### Requirement: Ambiguous location handling in the UI

When a location entry resolves ambiguously, the affected screen SHALL present the candidate locations for the person to choose and SHALL show data only once a candidate is chosen.

#### Scenario: Ambiguous entry offers candidates

- **WHEN** a person enters a location name matching several places
- **THEN** the screen presents the candidates
- **AND** shows no weather data until one is chosen

### Requirement: Accessibility and responsive layout

The frontend SHALL be operable by keyboard alone for every action across authentication and product screens alike, SHALL label every input, SHALL apply accessible names to interactive controls, and SHALL meet a contrast ratio of at least 4.5 to 1 for body text in both light and dark appearance. Layout SHALL remain usable down to a 360-pixel-wide viewport without horizontal page scrolling, with wide content such as tables and charts scrolling within their own containers.

#### Scenario: Keyboard-only use

- **WHEN** a person navigates and submits using only the keyboard
- **THEN** every action on every MVP screen, authentication and product alike, can be reached and performed

#### Scenario: Narrow viewport

- **WHEN** the application is displayed in a 360-pixel-wide viewport
- **THEN** the layout remains usable and the page does not scroll horizontally

#### Scenario: Dark appearance

- **WHEN** the person's system requests a dark appearance
- **THEN** the interface renders legibly with body text meeting the required contrast ratio

#### Scenario: Wide content contained

- **WHEN** a table or chart is wider than the viewport
- **THEN** it scrolls within its own container rather than scrolling the page

### Requirement: Admin Model & AI Usage screen

The frontend SHALL provide an administrative Model & AI Usage screen, reachable only by a principal the backend confirms holds the administrative role, presenting at minimum:

- **Model status** — every catalog entry with its display name, capability roles, tier, structured-output support, free-or-paid classification, pricing, and enabled or disabled status, with the enable and disable controls.
- **Token usage** — prompt, completion, and total tokens over a selected period, broken down by model, policy, plan, and call role.
- **Cost** — estimated cost over the period by model, policy, and plan, labelled an estimate and never presented as a billed amount.
- **Latency** — median and 95th-percentile latency by model and call role.
- **Errors** — failure counts and rates by model and failure classification, including timeouts, gateway rate limits, and schema-validation failures.
- **Plan usage** — consumption against allowance per plan, with internal and evaluation usage shown separately from product usage.
- **Internal model selector** — selection of one or more enabled catalog models for a controlled comparison run, with the recorded results of past runs.

The screen SHALL present no conversation content, since usage records hold none, and SHALL show no other user's questions, threads, or saved data. This screen is post-MVP; it is designed in the design phase and implemented after the MVP screens, save for the model policy confirmation surface required next, which this change implements on the same route.

#### Scenario: Administrative screen reachable by an administrator

- **WHEN** a principal the backend confirms is administrative opens the Model & AI Usage screen
- **THEN** model status, token usage, cost, latency, errors, plan usage, and the internal model selector are all present

#### Scenario: Non-administrative visitor cannot reach it

- **WHEN** an ordinary authenticated person navigates to the administrative route
- **THEN** they are shown a not-available state
- **AND** no catalog, usage, cost, or lab content is fetched or rendered

#### Scenario: Cost labelled as an estimate

- **WHEN** cost is displayed
- **THEN** it is labelled an estimate and is not presented as an amount owed

#### Scenario: Model enabled and disabled from the screen

- **WHEN** an administrator disables a model from the screen and the backend confirms the change
- **THEN** the screen reflects the disabled status

#### Scenario: Comparison initiated from the internal selector

- **WHEN** an administrator selects several enabled models and a question and starts a comparison
- **THEN** the run's per-model latency, tokens, estimated cost, status, and evaluation result are shown side by side when it completes

#### Scenario: No conversation content shown

- **WHEN** the usage, cost, latency, and error views are inspected
- **THEN** they contain no prompt text, completion text, or other person's question

### Requirement: Administrative model policy confirmation

The frontend SHALL provide, on the administrative route and reachable only by a principal the backend confirms holds the administrative role, a surface presenting each model policy's ordered candidate list, the evaluation outcome the backend has recorded for each candidate, and the comparison runs available as evidence — and SHALL submit a candidate-list confirmation to the backend citing the comparison runs relied upon, as an ordinary authenticated request carrying the signed-in person's own session.

A candidate for which the backend recorded no evaluation SHALL be presented as unevidenced, and SHALL NOT be presented as having failed a criterion. The surface SHALL NOT compute, infer, or display an evaluation outcome the backend did not record, SHALL NOT describe an ordering as evidenced by a comparison run that scored no result for the candidate in question, and SHALL state a candidate ordering it submits unchanged as a confirmation rather than as a reordering.

The administrative route SHALL be offered in the navigation to a principal the backend confirms holds the role, and SHALL NOT be offered to any other visitor. The offer SHALL be decided from the capability the backend reports for the acting principal and from nothing a client could assert about itself — not an address, not a list of identifiers, not a configuration value, not a stored flag — and SHALL default to offering nothing where the capability is unknown. Only administrative surfaces that are implemented SHALL appear. The offer is a presentation convenience: the route SHALL refuse a principal without the role whether or not the navigation linked to it.

The surface SHALL display no access token, no service-role credential, and no configuration value. Its refusals SHALL be distinguishable by a reader: an expired session, an authenticated principal without the role, a validation failure, a refusal by the backend's promotion gate, and a backend or network failure SHALL each be stated as itself, and none SHALL be retried automatically. The surface SHALL show the recorded result of a confirmation it made — the resulting candidate order, the comparison runs cited, and that the change was audited — read back from the backend rather than assumed from the request having succeeded.

#### Scenario: The administrative route is offered to an administrator

- **WHEN** a principal the backend confirms is administrative views the navigation
- **THEN** an administrative section is offered, naming only the administrative surfaces that are implemented
- **AND** following it reaches the administrative route without knowing an unlinked address

#### Scenario: It is not offered to anybody else

- **WHEN** an ordinary authenticated person views the navigation
- **THEN** no administrative section appears
- **AND** none appears when the capability cannot be read

#### Scenario: Administrator sees the recorded evidence

- **WHEN** a principal the backend confirms is administrative opens the policy confirmation surface
- **THEN** each policy's ordered candidate list is shown
- **AND** each candidate carries the evaluation outcome the backend recorded for it, or is marked unevidenced

#### Scenario: An unevidenced candidate is not reported as failing

- **WHEN** a candidate has no recorded evaluation
- **THEN** it is marked unevidenced
- **AND** it is not described as having failed any criterion

#### Scenario: A confirmation cites the runs it rests on

- **WHEN** an administrator confirms a policy's candidate list
- **THEN** the request carries the ordered candidate list and the comparison run identifiers selected as its basis
- **AND** the resulting audit record, read back from the backend, names the cited runs

#### Scenario: An unchanged order is stated as a confirmation

- **WHEN** the submitted candidate order is the order already stored
- **THEN** the surface states that the order was confirmed rather than reordered

#### Scenario: Non-administrative visitor is refused

- **WHEN** an ordinary authenticated person opens the administrative route
- **THEN** they are shown a not-permitted state
- **AND** no policy, catalog, comparison, or audit content is rendered

#### Scenario: The promotion gate's refusal is shown as itself

- **WHEN** the backend refuses a confirmation because a candidate failed a gating criterion
- **THEN** the refusal names the criteria the backend reported
- **AND** it is not presented as a validation error, a session failure, or a server fault

#### Scenario: No credential is displayed

- **WHEN** the surface is inspected in any state
- **THEN** no access token, service-role credential, or configuration value appears

### Requirement: The UI never authorizes model access or an allowance

The frontend SHALL treat the backend as the sole authority on plan, entitlement, model resolution, and allowance. It SHALL NOT decide which model serves a request, SHALL NOT gate a premium capability by a client-held value alone, and SHALL NOT present a raised allowance the backend has not granted. Hiding or disabling a control SHALL be a presentation convenience only; the backend SHALL refuse the underlying request regardless.

Where the backend refuses a request for an exhausted allowance, the frontend SHALL present that as a distinct, honest state naming the limit and when it resets — not as a weather error, an authentication error, or a generic failure — and SHALL leave the person's thread, saved locations, and preferences intact.

#### Scenario: Hidden control is not the gate

- **WHEN** a premium control is hidden for a Free-plan person and the underlying request is issued anyway
- **THEN** the backend refuses or downgrades it
- **AND** the UI reflects what the backend actually did

#### Scenario: Quota state presented honestly

- **WHEN** the backend refuses an agent request for an exhausted allowance
- **THEN** the screen states the limit reached and when it resets
- **AND** it is visually and textually distinct from a weather error and from an expired session

#### Scenario: Person's data intact after a quota refusal

- **WHEN** a person hits their allowance
- **THEN** their thread, saved locations, and preferences remain available

#### Scenario: Displayed model is the one that ran

- **WHEN** an answer reports the provider, model, and policy that served it
- **THEN** the UI shows those values rather than a client-side assumption

### Requirement: Plan and usage visible to the signed-in person

The frontend SHALL show the signed-in person their own plan and usage — the plan name, consumption against allowance per applicable dimension, and each window's reset time — and SHALL show no other person's usage, no internal usage, and no aggregate cost across users. This view is post-MVP and is designed in the design phase alongside the administrative screen.

#### Scenario: Own plan and usage shown

- **WHEN** a signed-in person opens their plan and usage view
- **THEN** their plan name, per-dimension consumption and remaining allowance, and reset times are shown

#### Scenario: Only their own usage shown

- **WHEN** the view is inspected
- **THEN** it contains no other person's usage, no internal usage, and no cross-user cost total

### Requirement: Administrative and plan screens remain subject to the Visily design gate

The Admin Model & AI Usage screen and the plan-and-usage view SHALL be designed in Visily before substantial implementation, following the same gate as every other screen: an artifact per screen covering its populated, loading, empty, error, and not-permitted states; conformance to the established Weathra design system and its carried-forward design direction rather than generic generated styling; a recorded approval before implementation begins; and a recorded reason for any deliberate divergence.

Until they are implemented, they SHALL be represented in the design roadmap as post-MVP entries rather than advertised as working.

#### Scenario: Design precedes implementation

- **WHEN** implementation of the administrative screen or the plan-and-usage view is started
- **THEN** an approved Visily artifact for it already exists and is recorded

#### Scenario: States covered by the artifact

- **WHEN** the artifact for the administrative screen is inspected
- **THEN** it covers the populated, loading, empty, error, and not-permitted states

#### Scenario: Design system followed

- **WHEN** the artifact is inspected
- **THEN** its typography, spacing, components, charts, and states come from the established Weathra design system

#### Scenario: Represented in the roadmap while unbuilt

- **WHEN** the design roadmap is read before these screens are implemented
- **THEN** they appear as post-MVP entries
- **AND** no route advertises them as working
