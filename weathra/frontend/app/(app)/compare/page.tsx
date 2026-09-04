/**
 * `/compare` — Compare Cities, task 21.4.
 *
 * A client screen: the places, the criterion and the window are all chosen on the page, and each
 * comparison is a fresh POST through the shared query layer with its own loading, error and retry.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { CompareCities } from "@/components/compare/compare";

export const metadata: Metadata = { title: "Compare Cities" };

export default function Page(): ReactNode {
  return <CompareCities />;
}
