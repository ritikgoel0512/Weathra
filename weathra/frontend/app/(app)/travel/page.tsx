/**
 * `/travel` — Travel Intelligence.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is post-MVP and recorded in `docs/design/roadmap.md`.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Travel Intelligence" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Travel Intelligence" status="planned">
      Weather intelligence along a route or across the dates of a trip.
    </RouteStatus>
  );
}
