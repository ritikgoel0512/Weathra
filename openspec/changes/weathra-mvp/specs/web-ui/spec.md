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

### Requirement: UXPilot design artifacts precede implementation

Frontend implementation SHALL follow approved UXPilot-produced design artifacts. A UXPilot design phase SHALL complete before substantial frontend implementation begins and SHALL cover both the authentication experience and the core product experience.

The design phase SHALL establish a shared Weathra design system covering typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, loading states, empty states, error states, and authentication states. Every MVP screen — authentication and product alike — SHALL have an approved design artifact recorded in the repository documentation before its implementation is considered complete. Implemented screens SHALL follow the approved artifacts rather than generic generated styling, and any deliberate divergence SHALL be recorded with its reason.

#### Scenario: Design phase precedes implementation

- **WHEN** substantial frontend implementation begins
- **THEN** the UXPilot artifacts covering the authentication screens, the product screens, and the shared design system are already approved and recorded

#### Scenario: Design system established

- **WHEN** the recorded design system is inspected
- **THEN** it covers typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, loading, empty, error, and authentication states

#### Scenario: Screen implemented against a design artifact

- **WHEN** an MVP screen is implemented
- **THEN** its design artifact is referenced in the repository documentation
- **AND** the implementation follows it rather than generic generated styling

#### Scenario: Post-MVP screens represented in the design roadmap

- **WHEN** the design roadmap is inspected
- **THEN** Weather Intelligence Report, Forecast Explorer, Weather Scenario Lab, Weather Watch, and Travel Intelligence are represented as post-MVP

#### Scenario: Divergence recorded

- **WHEN** an implemented screen deliberately diverges from its design artifact
- **THEN** the divergence and its reason are recorded

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

The frontend SHALL reserve navigation and routing structure for the post-MVP screens — Weather Intelligence Report, Forecast Explorer, Weather Scenario Lab, Weather Watch, and Travel Intelligence — without implementing their functionality in this change. Any such route present SHALL state plainly that the screen is not yet available rather than rendering a broken or empty screen.

#### Scenario: Post-MVP route states its status

- **WHEN** a person navigates to a post-MVP screen's route
- **THEN** the screen states that it is not yet available
- **AND** does not render a broken or empty interface

#### Scenario: Post-MVP screens not advertised as working

- **WHEN** the navigation surface is inspected
- **THEN** post-MVP screens are either absent or marked as not yet available

### Requirement: Data classes and attribution are visible

Every displayed weather value SHALL carry a visible indication of its data class — current conditions, forecast, historical observation, computed statistic, or AI interpretation — and every screen showing weather data SHALL display the source provider, the location, the period covered, and the retrieval time. AI interpretation SHALL be visually distinguishable from retrieved data.

#### Scenario: Value shows its data class

- **WHEN** any weather value is displayed
- **THEN** its data class is visible

#### Scenario: Attribution visible on screen

- **WHEN** a screen shows weather data
- **THEN** the source provider, location, period, and retrieval time are visible

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
