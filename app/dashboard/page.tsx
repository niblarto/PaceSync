import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashboardClient } from "@/components/DashboardClient";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  return (
    <DashboardClient
      spotifyUser={{
        name: session.user?.name ?? "Runner",
        image: session.user?.image ?? null,
      }}
    />
  );
}
