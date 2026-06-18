import { NextResponse } from "next/server";
import { circle } from "@/lib/circle/mockClient";
import { PARAMS } from "@/lib/circle/schedule";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const amount = typeof body.amount === "number" ? body.amount : 3 * PARAMS.minContribution;
  return NextResponse.json(await circle.contribute(amount));
}
