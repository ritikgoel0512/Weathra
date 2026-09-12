# The MCP weather server

Every route from an agent to weather data goes through this server. It is the tool boundary, and it
exists so that a figure in an answer has a recorded tool call, with recorded arguments and a
recorded result, behind it.

**One boundary, two callers.** The MCP tools and the REST routers sit on the same service layer, so
a capability behaves identically whether an agent reached it or a person called the endpoint. What
the tool boundary adds is the record.

**It runs in the same container, over its own transport.** `MCP_TRANSPORT=in-process` by default.
An extra network hop and an extra cold start on every tool call was not worth its cost for the MVP,
but the boundary is clean enough that promoting the server to its own deployed service is a
deployment change rather than a rewrite — nothing in `agents/` knows which transport it is using.

**Nothing below `agents/` may import a provider client, and nothing in `agents/nodes/` may either.**
`backend/tests/test_architecture.py` enforces that, which is what makes this boundary real rather
than conventional: a node that called a provider directly would produce a figure with no tool call
behind it, and the evidence record would be incomplete without anything saying so.

## The catalogue

Seven tools. `MCP_ENABLED_TOOLS` is an allow-list at registration: a tool left out of it is not
registered at all, so a plan naming it gets a `tool_not_found` error rather than a silent no-op.

| Tool | Purpose | Required | Optional |
|---|---|---|---|
| `geocode_location` | Resolve a place name, or describe a coordinate pair | — | `location`, `latitude`, `longitude` |
| `weather_current` | Current conditions | — | `location`, `latitude`, `longitude`, `units`, `provider` |
| `weather_forecast` | A forecast window, hourly and daily | — | `location`, `latitude`, `longitude`, `days`, `units`, `provider` |
| `weather_history` | Archive observations for a date range | `start`, `end` | `location`, `latitude`, `longitude`, `units`, `provider` |
| `weather_compare` | Rank candidate locations on a criterion | `criterion` | `candidates`, `location`, `day_level`, `mode`, `days`, `start`, `end`, `units`, `provider` |
| `weather_statistics` | Descriptive statistics, percentiles, rolling windows, trend | `measure`, `unit`, `points` | `statistics`, `percentile`, `rolling_window`, `location`, `timezone`, `provider` |
| `weather_anomaly` | Anomaly detection over a series | `measure`, `unit`, `points` | `threshold`, `location`, `timezone`, `provider` |
| `weather_satellite` | Latest satellite imagery over a place, as observational evidence | — | `location`, `latitude`, `longitude` |

A location may be given as a name **or** as coordinates; supplying neither is a validation error,
and supplying a name that matches several places returns the candidates rather than a guess.

### The analytics tools take a series, not a place

`weather_statistics` and `weather_anomaly` require `points` — the series itself. They have no
provider and no way to fetch one. This is the load-bearing consequence: the analytics capability
runs over data a retrieval step already recorded, so the figures in an answer are computed over
exactly the numbers in the evidence record, and there is no path by which an agent could obtain a
number nobody retrieved.

## What a result looks like

Every successful result is structured content — not prose — and says what kind of value it holds:

```json
{
  "ok": true,
  "data_class": "forecast",
  "provider": "open-meteo",
  "location": {"identifier": "…", "display_name": "Berlin, Germany", "latitude": 52.52, …},
  "period": {"start_utc": "…", "end_utc": "…", "start_local": "…", "end_local": "…"},
  "units": {"temperature_2m": "°C", …},
  "…": "the measures themselves"
}
```

A computed result adds the things that make it checkable: the `method`, the `points_used`, and the
`points_excluded`. A statistic the tools cannot compute comes back with **no value and a reason** —
never a zero, and never an imputed figure. An absent value in a series stays absent: it is excluded
from the computation and counted in the exclusions.

## Error semantics

A failing tool returns a `CallToolResult` with `is_error=True` **and** structured content. Both
matter: the flag makes it unmistakably a failure rather than a success carrying zeros, and the
structure makes it machine-distinguishable.

| Class | Means |
|---|---|
| `invalid_input` | The arguments are malformed, out of range, or internally inconsistent |
| `location_not_resolvable` | No place matched, or the reference could not be resolved |
| `no_data` | The provider has no data for that range or measure |
| `provider_unavailable` | The upstream provider could not be reached after the permitted retries |
| `provider_timeout` | The upstream provider did not answer in time |
| `provider_rate_limited` | The upstream provider refused for rate reasons |
| `tool_not_found` | No such tool is registered |
| `internal` | Anything else, logged with the request id |

The mapping from Weathra's own error hierarchy to these classes is **one table**, so a new provider
error cannot quietly become `internal`.

**No upstream payload and no credential is ever forwarded.** The message is Weathra's own wording,
the details are Weathra's own fields, and a redaction pass is the belt to that braces. A tool error
that echoed a provider's response body would be a way for a URL — with a key in it — to reach a
client.

## Why tools rather than functions

The graph could call the service layer directly. It does not, for three reasons:

1. **The record.** A tool call is a recorded event with arguments and a result. A function call is
   not, and an evidence record assembled from function calls would depend on each node remembering
   to record itself.
2. **The schema.** Tool inputs are validated pydantic models, so a plan that asks for something
   impossible fails at the boundary with `invalid_input` rather than deeper in a service.
3. **The seam.** The tools are the same whether an agent, a test, or a future external client calls
   them, and promoting the server out of the process is a configuration change.

## Testing it

The default suite runs the server over the in-process transport with recorded provider payloads, so
every tool is exercised without a network. The tests assert the properties the spec asks for
directly: that a failure carries `is_error` *and* structure, that the six distinguishable error
classes are actually distinguishable, that no credential appears in any error payload, and that a
tool disabled in configuration is absent from the catalogue rather than merely unreachable.
