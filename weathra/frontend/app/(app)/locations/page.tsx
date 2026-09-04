/**
 * `/locations` — Saved Locations.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is task group 21.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Saved Locations" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Saved Locations" status="in-progress">
      The places you have saved, and adding or removing one.
    </RouteStatus>
  );
}
