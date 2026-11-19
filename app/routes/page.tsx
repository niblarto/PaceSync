import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RoutePlannerClient } from "@/components/RoutePlannerClient";

// /routes?distance=3.5&auto=1&workout=<uid> — from a scheduled run's "Create route": opens at that distance,
// searches straight away and picks the workout to lay over the results.
export default async function RoutesPage({ searchParams }: { searchParams: { distance?: string; auto?: string; workout?: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  const mi = parseFloat(searchParams.distance ?? "");
  return (
    <RoutePlannerClient
      initialDistance={mi >= 1 && mi <= 30 ? String(mi) : undefined}
      autoSearch={searchParams.auto === "1" && mi >= 1 && mi <= 30}
      initialWorkout={searchParams.workout}
    />
  );
}
