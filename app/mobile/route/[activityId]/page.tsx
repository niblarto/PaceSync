import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MobileRouteClient } from "@/components/MobileRouteClient";

export default async function MobileRoutePage({ params }: { params: { activityId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  return <MobileRouteClient activityId={params.activityId} />;
}
