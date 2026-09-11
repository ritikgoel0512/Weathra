/**
 * `/choose-plan` — the second step of creating an account.
 *
 * The same authentication shell as every other screen in this group (`design-system.md` §12), with
 * the plan cards inside it. Reached from Create Account and continuing to verification, so somebody
 * signing up sees what Weathra offers before they are sent to their inbox rather than discovering
 * their tier afterwards.
 *
 * **Nothing on this page is a purchase.** Weathra bills nobody: Free is what a new account is
 * already on, and Pro and Premium are assigned administratively. The screen states that from the
 * backend's own `self_service` field rather than assuming it here, and every allowance it shows is
 * a row in `usage_limits`.
 *
 * Static; the cards inside are the client component, and the tiers they draw are public.
 *
 * **`PublicDataBoundary` is not optional furniture.** It is the query layer and the API client, and
 * `(auth)` has no other source of either — `SessionBoundary` provides them for `(app)` and stops at
 * that group's edge. Without it `PlanChoice` threw during hydration and a person who had just
 * created an account met "Application error: a client-side exception has occurred" instead of the
 * tiers. The client it mounts is anonymous by design: `GET /plans` is public, and whoever is
 * reading this screen has not confirmed their address yet.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { PlanChoice } from "@/components/auth/plan-choice";
import { LoadingState } from "@/components/ui";
import { PublicDataBoundary } from "@/lib/query/public-boundary";
import { SIGN_IN_PATH } from "@/lib/routes";

export const metadata: Metadata = { title: "Choose Your Plan" };

export default function Page(): ReactNode {
  return (
    <AuthShell
      title="Choose your plan"
      subtitle="What each tier allows. You can carry on and decide later."
      footer={
        <>
          Already have an account? <Link href={SIGN_IN_PATH}>Sign in</Link>
        </>
      }
    >
      <Suspense fallback={<LoadingState label="Reading the plans" lines={4} />}>
        <PublicDataBoundary>
          <PlanChoice />
        </PublicDataBoundary>
      </Suspense>
    </AuthShell>
  );
}
