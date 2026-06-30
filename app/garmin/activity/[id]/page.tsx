import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loadGarminConfig } from "@/lib/garmin-config";
import { GarminActivityClient } from "@/components/GarminActivityClient";
import Link from "next/link";

export default async function ActivityPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const config = loadGarminConfig();
  if (!config) redirect("/garmin");

  return <GarminActivityClient id={params.id} />;
}
