import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RoutePlannerClient } from "@/components/RoutePlannerClient";

export default async function RoutesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <RoutePlannerClient />;
}
