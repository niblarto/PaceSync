import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { NutritionClient } from "@/components/NutritionClient";

export default async function NutritionPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <NutritionClient />;
}
