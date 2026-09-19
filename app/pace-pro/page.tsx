import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { PaceProClient } from "@/components/PaceProClient";

export default async function PaceProPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <PaceProClient />;
}
