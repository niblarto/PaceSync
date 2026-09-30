import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RaceDetailClient } from "@/components/RaceDetailClient";

export default async function RaceDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <RaceDetailClient id={params.id} />;
}
