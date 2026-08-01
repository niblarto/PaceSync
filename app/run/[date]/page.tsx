import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RunDetailClient } from "@/components/RunDetailClient";

export default async function RunDetailPage({
  params, searchParams,
}: {
  params: { date: string };
  searchParams: { title?: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  // date alone isn't a unique workout key (Runna reuses titles across weeks —
  // see lib/workout-key.ts) — title is required, matching run-pacing's own
  // query-param convention rather than trying to path-encode it.
  if (!searchParams.title) redirect("/dashboard");

  return <RunDetailClient date={params.date} title={searchParams.title} />;
}
