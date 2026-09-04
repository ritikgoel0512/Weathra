/**
 * `/report` — Weather Intelligence Report.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is post-MVP and recorded in `docs/design/roadmap.md`.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Weather Intelligence Report" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Weather Intelligence Report" status="planned">
      A composed, exportable report across Weathra's capabilities.
    </RouteStatus>
  );
}
