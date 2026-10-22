import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { CoachClient } from "@/components/CoachClient";

export default async function CoachPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <CoachClient />;
}
