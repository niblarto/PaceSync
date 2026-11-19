import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { HealthClient } from "@/components/HealthClient";

export default async function HealthPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <HealthClient />;
}
