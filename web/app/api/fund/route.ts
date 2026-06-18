import { NextResponse } from "next/server";
import { subscription } from "@/lib/mandate/mockClient";
import { SUB } from "@/lib/mandate/schedule";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const amount = typeof body.amount === "number" ? body.amount : SUB.price * SUB.fundMonths;
    return NextResponse.json(await subscription.fund(amount));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
