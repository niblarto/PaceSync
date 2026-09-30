import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RacesClient } from "@/components/RacesClient";

export default async function RacesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <RacesClient />;
}
