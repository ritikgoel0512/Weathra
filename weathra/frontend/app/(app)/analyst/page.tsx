/**
 * `/analyst` — AI Weather Analyst.
 *
 * A route, not a screen. Task 20.12 needs every destination in the navigation to resolve to
 * something honest; the screen itself is task group 21.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "AI Weather Analyst" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="AI Weather Analyst" status="in-progress">
      Free-text questioning with streamed progress and a data-class-labelled answer.
    </RouteStatus>
  );
}
