import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MixChartClient } from "@/components/MixChartClient";

export default async function MixPage({ params }: { params: { date: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  return <MixChartClient date={params.date} />;
}
