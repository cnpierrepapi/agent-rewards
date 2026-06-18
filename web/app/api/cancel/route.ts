import { NextResponse } from "next/server";
import { subscription } from "@/lib/mandate/mockClient";

export async function POST() {
  const res = await subscription.cancel();
  return NextResponse.json({ ...res, state: await subscription.getState() });
}
