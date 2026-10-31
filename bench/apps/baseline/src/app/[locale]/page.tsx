import { connection } from "next/server";
import { Texts } from "@/texts";

export default async function Page() {
  await connection();
  return <Texts />;
}
