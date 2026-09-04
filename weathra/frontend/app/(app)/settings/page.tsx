/**
 * `/settings` — Settings, task 21.6.
 *
 * A server page around a client screen, for one reason: the sign-out control is a server action
 * (task 20.9) and an action must not be reached through a client boundary. It is rendered here and
 * passed in as output, exactly as the protected layout passes it to the shell — so Settings offers
 * Weathra's one sign-out rather than implementing a second.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Settings } from "@/components/settings/settings";
import { SignOutForm } from "@/components/shell/sign-out-form";

export const metadata: Metadata = { title: "Settings" };

export default function Page(): ReactNode {
  return <Settings signOutControl={<SignOutForm />} />;
}
