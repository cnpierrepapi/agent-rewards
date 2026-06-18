import { NextResponse } from "next/server";
import { circle } from "@/lib/circle/mockClient";

export async function GET() {
  return NextResponse.json(await circle.getState());
}
