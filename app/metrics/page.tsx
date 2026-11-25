import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MetricsClient } from "@/components/MetricsClient";

export default async function MetricsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <MetricsClient />;
}
