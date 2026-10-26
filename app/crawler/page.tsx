import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SongCrawlerClient } from "@/components/SongCrawlerClient";

export default async function CrawlerPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  return <SongCrawlerClient />;
}
