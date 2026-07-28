import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MobileDashboardClient } from "@/components/MobileDashboardClient";

export default async function MobilePage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  return (
    <MobileDashboardClient
      spotifyUser={{
        name: session.user?.name ?? "Runner",
        image: session.user?.image ?? null,
      }}
    />
  );
}
