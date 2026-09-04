/**
 * `/scenarios` — Weather Scenario Lab.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is post-MVP and recorded in `docs/design/roadmap.md`.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Weather Scenario Lab" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Weather Scenario Lab" status="planned">
      Hypothetical and alternative conditions, and what they would imply.
    </RouteStatus>
  );
}
