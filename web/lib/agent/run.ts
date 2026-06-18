import { SubscriptionClient, SubscriptionState } from "@/lib/mandate/types";
import { findLeads, industries, Lead } from "./leads";
import { draftTemplate, Draft } from "./draft";

export interface PeriodResult {
  charged: boolean;
  reason?: string; // when charged === false
  period?: number;
  amount?: number;
  city?: string;
  leads?: Lead[];
  drafts?: Draft[];
  state: SubscriptionState;
}

// One billing period. The provider only delivers work for a period it was paid for.
export async function runPeriod(client: SubscriptionClient): Promise<PeriodResult> {
  let charge;
  try {
    charge = await client.charge();
  } catch (e) {
    return { charged: false, reason: (e as Error).message, state: await client.getState() };
  }

  // Paid -> the agent does this period's work (find Warsaw leads, draft Sonnet pitches).
  const leads = findLeads();
  const inds = industries();
  const drafts = await Promise.all(inds.map((i) => draftTemplate(i, findLeads(i))));

  return {
    charged: true,
    period: charge.period,
    amount: charge.amount,
    city: leads[0]?.city ?? "Warsaw",
    leads,
    drafts,
    state: await client.getState(),
  };
}
