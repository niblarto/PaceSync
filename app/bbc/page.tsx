import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { BbcRadioClient } from "@/components/BbcRadioClient";

export default async function BbcRadioPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <BbcRadioClient />;
}
