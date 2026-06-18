import { NextResponse } from "next/server";
import { subscription } from "@/lib/mandate/mockClient";
import { runPeriod } from "@/lib/agent/run";

export async function POST() {
  try {
    return NextResponse.json(await runPeriod(subscription));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
