/**
 * `/locations` — Saved Locations, task 21.6.
 *
 * A client screen: listing, adding and removing are three authenticated calls made from the
 * browser through the shared query layer, each with its own state and its own retry.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SavedLocations } from "@/components/locations/locations";

export const metadata: Metadata = { title: "Saved Locations" };

export default function Page(): ReactNode {
  return <SavedLocations />;
}
