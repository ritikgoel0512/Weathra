/**
 * `/` — Dashboard.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is task group 21.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Dashboard" status="in-progress">
      The Weathra Intelligence briefing for a chosen or default location.
    </RouteStatus>
  );
}
