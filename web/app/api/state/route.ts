import { NextResponse } from "next/server";
import { subscription } from "@/lib/mandate/mockClient";

export async function GET() {
  return NextResponse.json(await subscription.getState());
}
