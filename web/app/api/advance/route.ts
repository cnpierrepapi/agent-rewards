import { NextResponse } from "next/server";
import { circle } from "@/lib/circle/mockClient";

export async function POST() {
  return NextResponse.json(await circle.advance());
}
