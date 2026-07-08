import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { StravaClient } from "@/components/StravaClient";

export default async function StravaPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return (
    <Suspense>
      <StravaClient />
    </Suspense>
  );
}
