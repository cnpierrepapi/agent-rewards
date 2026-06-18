import { NextResponse } from "next/server";
import { subscription } from "@/lib/mandate/mockClient";

export async function POST() {
  await subscription.reset();
  return NextResponse.json(await subscription.getState());
}
