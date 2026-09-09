/**
 * The primitive layer's behaviour — task 20.3.
 *
 * These assert *semantics*, never a class name: a CSS-module class is generated, and a test that
 * pinned one would fail on a rename and pass on an unlabelled input. What is asserted is what a
 * person using a keyboard or a screen reader actually gets — the label association, the accessible
 * name, the tab order, the live region, and the exact word a data class announces itself with.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DATA_CLASS_NAMES } from "@/lib/design/tokens";

import { Badge, DATA_CLASS_LABELS, DataClassBadge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import { Metric } from "./metric";
import { Select } from "./select";
import { Skeleton } from "./skeleton";
import { EmptyState, ErrorState, LoadingState, QuotaState } from "./states";
import { Card, CardBody, CardFooter, CardHeader, Surface } from "./surface";
import { TabPanel, Tabs } from "./tabs";

describe("Button", () => {
  it("is a button that does not submit a form it happens to be inside", () => {
    render(<Button>Add location</Button>);
    expect(screen.getByRole("button", { name: "Add location" })).toHaveAttribute("type", "button");
  });

  it("submits when a screen asks it to", () => {
    render(<Button type="submit">Sign in</Button>);
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("type", "submit");
  });

  it("carries its variant and size as data rather than as a class name", () => {
    render(
      <Button variant="primary" size="sm" fullWidth>
        Ask
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toHaveAttribute("data-variant", "primary");
    expect(button).toHaveAttribute("data-size", "sm");
    expect(button).toHaveAttribute("data-full-width", "true");
  });

  it("calls its handler", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Retry</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("cannot be pressed twice while its request is in flight", async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Ask
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Compare
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Surface and Card", () => {
  it("renders a surface at the level it was given", () => {
    render(
      <Surface level="overlay" role="region" aria-label="Evidence">
        content
      </Surface>,
    );
    expect(screen.getByRole("region", { name: "Evidence" })).toHaveAttribute(
      "data-level",
      "overlay",
    );
  });

  it("renders a card as a labelled region with its title, badge, body and footer", () => {
    render(
      <Card aria-labelledby="card-title">
        <CardHeader
          title="Current conditions"
          titleId="card-title"
          subtitle="Berlin, Germany"
          badge={<DataClassBadge dataClass="observed" />}
          actions={<Button size="sm">Refresh</Button>}
        />
        <CardBody>
          <Metric label="Temperature" value="18.4" unit="°C" dataClass="observed" />
        </CardBody>
        <CardFooter>Retrieved 14:03 · valid 14:00</CardFooter>
      </Card>,
    );

    const card = screen.getByRole("region", { name: "Current conditions" });
    expect(within(card).getByRole("heading", { name: "Current conditions" })).toBeInTheDocument();
    expect(within(card).getByText("Berlin, Germany")).toBeInTheDocument();
    expect(within(card).getAllByText("OBSERVED")).toHaveLength(2);
    expect(within(card).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(card).getByText("Retrieved 14:03 · valid 14:00")).toBeInTheDocument();
  });

  it("omits the header aside when a card has neither badge nor actions", () => {
    render(<CardHeader title="Saved locations" />);
    expect(screen.getByRole("heading", { name: "Saved locations" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("DataClassBadge", () => {
  it.each(DATA_CLASS_NAMES)("announces %s in words as well as in colour", (dataClass) => {
    render(<DataClassBadge dataClass={dataClass} />);
    const badge = screen.getByText(DATA_CLASS_LABELS[dataClass]);
    expect(badge).toHaveAttribute("data-class", dataClass);
  });

  it("spells the interpretation class one way", () => {
    render(<DataClassBadge dataClass="interpretation" />);
    expect(screen.getByText("AI INTERPRETATION")).toBeInTheDocument();
    expect(screen.queryByText("AGENT INTERPRETATION")).not.toBeInTheDocument();
  });

  it("says that analytics were computed and that interpretation was written", () => {
    render(
      <>
        <DataClassBadge dataClass="analytics" />
        <DataClassBadge dataClass="interpretation" />
      </>,
    );
    expect(screen.getByText("ANALYTICS")).toHaveAttribute("title", expect.stringContaining("deterministic"));
    expect(screen.getByText("AI INTERPRETATION")).toHaveAttribute(
      "title",
      expect.stringContaining("did not produce"),
    );
  });

  it("gives every class a distinct label", () => {
    const labels = DATA_CLASS_NAMES.map((name) => DATA_CLASS_LABELS[name]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("Badge", () => {
  it("carries its tone as data", () => {
    render(<Badge tone="quota">Limit reached</Badge>);
    expect(screen.getByText("Limit reached")).toHaveAttribute("data-tone", "quota");
  });

  it("is neutral by default", () => {
    render(<Badge>Post-MVP</Badge>);
    expect(screen.getByText("Post-MVP")).toHaveAttribute("data-tone", "neutral");
  });
});

describe("Input", () => {
  it("associates its label with the control", () => {
    render(<Input label="Email" type="email" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  it("states its rules before submission, wired to the control", () => {
    render(
      <Input
        label="Password"
        type="password"
        description="At least 12 characters, including a number."
      />,
    );
    const control = screen.getByLabelText("Password");
    expect(control).toHaveAccessibleDescription("At least 12 characters, including a number.");
    expect(control).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and names the failure", () => {
    render(<Input label="Email" error="Enter an email address." />);
    const control = screen.getByLabelText("Email");
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription("Enter an email address.");
  });

  it("describes the control with both its rules and its failure", () => {
    render(<Input label="Password" description="At least 12 characters." error="Too short." />);
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "At least 12 characters. Too short.",
    );
  });

  it("takes typing", async () => {
    render(<Input label="Location" />);
    await userEvent.type(screen.getByLabelText("Location"), "Berlin");
    expect(screen.getByLabelText("Location")).toHaveValue("Berlin");
  });
});

describe("Select", () => {
  it("associates its label and renders its options", () => {
    render(
      <Select
        label="Temperature unit"
        defaultValue="celsius"
        options={[
          { value: "celsius", label: "Celsius" },
          { value: "fahrenheit", label: "Fahrenheit" },
        ]}
      />,
    );
    const control = screen.getByLabelText("Temperature unit");
    expect(control).toHaveValue("celsius");
    expect(within(control).getAllByRole("option")).toHaveLength(2);
  });

  it("reports a change", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Forecast range"
        defaultValue="7"
        onChange={onChange}
        options={[
          { value: "3", label: "3 days" },
          { value: "7", label: "7 days" },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Forecast range"), "3");
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByLabelText("Forecast range")).toHaveValue("3");
  });

  it("accepts options as children", () => {
    render(
      <Select label="Unit system">
        <option value="metric">Metric</option>
      </Select>,
    );
    expect(within(screen.getByLabelText("Unit system")).getByRole("option")).toHaveTextContent(
      "Metric",
    );
  });
});

describe("Tabs", () => {
  const TABS = [
    { id: "general", label: "General" },
    { id: "units", label: "Units" },
    { id: "data", label: "Your data" },
  ] as const;

  function renderTabs(activeId: string, onChange = vi.fn()) {
    render(
      <>
        <Tabs
          tabs={TABS}
          activeId={activeId}
          onChange={onChange}
          label="Settings sections"
          idPrefix="settings"
        />
        {TABS.map((tab) => (
          <TabPanel key={tab.id} id={tab.id} activeId={activeId} idPrefix="settings">
            {tab.label} panel
          </TabPanel>
        ))}
      </>,
    );
    return onChange;
  }

  it("is a named tablist", () => {
    renderTabs("general");
    expect(screen.getByRole("tablist", { name: "Settings sections" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("puts only the selected tab in the tab order", () => {
    renderTabs("units");
    const [general, units, data] = screen.getAllByRole("tab");
    expect(units).toHaveAttribute("aria-selected", "true");
    expect(units).toHaveAttribute("tabindex", "0");
    expect(general).toHaveAttribute("tabindex", "-1");
    expect(data).toHaveAttribute("tabindex", "-1");
  });

  it("shows only the selected panel, labelled by its tab", () => {
    renderTabs("units");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Units panel");
    expect(panel).toHaveAccessibleName("Units");
    expect(screen.queryByText("General panel")).not.toBeInTheDocument();
  });

  it("moves the selection with the arrow keys", async () => {
    const onChange = renderTabs("general");
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "General" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("units");

    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("data");

    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("data");

    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("general");
  });

  it("selects a tab on click", async () => {
    const onChange = renderTabs("general");
    await userEvent.click(screen.getByRole("tab", { name: "Your data" }));
    expect(onChange).toHaveBeenCalledWith("data");
  });
});

describe("Metric", () => {
  it("shows the label, the figure, its unit and what qualifies it", () => {
    render(
      <Metric
        label="Mean temperature"
        value="15.6"
        unit="°C"
        note="October 2023 · 31 days"
        dataClass="analytics"
      />,
    );
    expect(screen.getByText("Mean temperature")).toBeInTheDocument();
    expect(screen.getByText("15.6")).toBeInTheDocument();
    expect(screen.getByText("°C")).toBeInTheDocument();
    expect(screen.getByText("October 2023 · 31 days")).toBeInTheDocument();
    expect(screen.getByText("ANALYTICS")).toBeInTheDocument();
  });

  it("shows the figure exactly as it was given, adding no precision of its own", () => {
    render(<Metric label="Anomaly" value="+3.20" unit="°C" />);
    expect(screen.getByText("+3.20")).toBeInTheDocument();
  });

  it("carries no badge where a figure has no data class", () => {
    render(<Metric label="Saved locations" value="4" />);
    for (const label of Object.values(DATA_CLASS_LABELS)) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
});

describe("Skeleton", () => {
  it("is hidden from assistive technology", () => {
    render(<Skeleton />);
    expect(document.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });
});

describe("LoadingState", () => {
  it("announces itself once through a live region", () => {
    render(<LoadingState label="Loading the briefing" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading the briefing");
  });

  it("shows as many placeholders as it was asked for", () => {
    render(<LoadingState lines={5} />);
    expect(screen.getByRole("status").querySelectorAll("[aria-hidden='true']")).toHaveLength(5);
  });
});

describe("EmptyState", () => {
  it("says what is not there and what to do about it", () => {
    render(
      <EmptyState title="No saved locations" action={<Button>Add a location</Button>}>
        Add a location to see its briefing here.
      </EmptyState>,
    );
    expect(screen.getByText("No saved locations")).toBeInTheDocument();
    expect(screen.getByText("Add a location to see its briefing here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a location" })).toBeInTheDocument();
  });

  it("is not a status region — nothing is loading and nothing failed", () => {
    render(<EmptyState title="Nothing entered yet" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  const failure = {
    message: "Historical coverage starts in 1979 for this location.",
    requestId: "req-8821",
  };

  it("shows the backend's own message, unchanged", () => {
    render(<ErrorState failure={failure} />);
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
  });

  it("offers a retry that runs the request again in place", async () => {
    const onRetry = vi.fn();
    render(<ErrorState failure={failure} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no retry where a retry cannot help", () => {
    render(<ErrorState failure={failure} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the request id when the backend sent one, and nothing when it did not", () => {
    const { unmount } = render(<ErrorState failure={failure} />);
    expect(screen.getByText("Request req-8821")).toBeInTheDocument();
    unmount();

    render(<ErrorState failure={{ message: "Network request failed.", requestId: null }} />);
    expect(screen.queryByText(/^Request /)).not.toBeInTheDocument();
  });
});

describe("QuotaState", () => {
  /** The refusal `weathra/entitlements/quotas.py` builds, as the parser hands it over. */
  const refusal = {
    dimension: "requests_per_day" as const,
    window: "day" as const,
    allowance: 20,
    consumed: 20,
    resetsAt: "2026-09-10T00:00:00Z",
    retryAfterSeconds: 16_200,
    message: "You have used today's allowance of agent questions.",
    requestId: "req-9",
  };

  it("announces itself as a status rather than as an alert", () => {
    // The one semantic difference from `ErrorState` that a screen-reader user actually hears: an
    // exhausted allowance is the outcome of what they asked for, not something going wrong.
    render(<QuotaState refusal={refusal} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the limit, the reset, and the backend's own sentence", () => {
    render(<QuotaState refusal={refusal} />);

    expect(screen.getByText("20 of 20 questions today")).toBeInTheDocument();
    expect(screen.getByText("2026-09-10 00:00 UTC")).toBeInTheDocument();
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
    // Machine-readable as well as legible, like every other instant on a Weathra surface.
    expect(screen.getByText("2026-09-10 00:00 UTC")).toHaveAttribute("datetime", refusal.resetsAt);
  });

  it("says what is unaffected, so the state is not read as a failure", () => {
    render(<QuotaState refusal={refusal} />);
    expect(screen.getByText(/not a failure/i)).toBeInTheDocument();
    expect(screen.getByText(/saved locations and preferences are unchanged/i)).toBeInTheDocument();
  });

  it("says the figures are missing rather than showing zeroes", () => {
    render(
      <QuotaState
        refusal={{ ...refusal, allowance: null, consumed: null, resetsAt: null, retryAfterSeconds: null }}
      />,
    );

    expect(screen.getByText("The backend did not report the figures.")).toBeInTheDocument();
    expect(screen.getByText("The backend did not report a reset time.")).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });

  it("offers a retry only for the limit that a wait can lift", () => {
    const onRetry = vi.fn();
    const { unmount } = render(<QuotaState refusal={refusal} onRetry={onRetry} />);
    // A day's allowance does not lift by pressing a button.
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    render(
      <QuotaState
        refusal={{ ...refusal, dimension: "concurrent_runs", window: "concurrent", resetsAt: null }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
  });

  it("carries the bound dimension as data, for a screen that needs to branch on it", () => {
    render(<QuotaState refusal={refusal} />);
    expect(screen.getByRole("status")).toHaveAttribute("data-quota-dimension", "requests_per_day");
  });
});
