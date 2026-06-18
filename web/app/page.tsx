"use client";

import { useEffect, useState } from "react";

const USDC_DECIMALS = 6;
const usdc = (base: number) => (base / 10 ** USDC_DECIMALS).toFixed(4);

interface Charge {
  period: number;
  amount: number;
  remaining: number;
}
interface SubscriptionState {
  active: boolean;
  price: number;
  escrowBalance: number;
  monthsRemaining: number;
  periodsCharged: number;
  providerReceived: number;
  atRisk: boolean;
  charges: Charge[];
}
interface Draft {
  industry: string;
  city: string;
  subject: string;
  body: string;
  model: string;
  hasEmDash: boolean;
}
interface Lead {
  name: string;
  industry: string;
  category: string;
  area: string;
  rating: number;
  reviews: number;
}
interface PeriodResult {
  charged: boolean;
  reason?: string;
  period?: number;
  amount?: number;
  leads?: Lead[];
  drafts?: Draft[];
}

export default function Home() {
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [lastRun, setLastRun] = useState<PeriodResult | null>(null);
  const [refund, setRefund] = useState<{ refunded: number; monthsRefunded: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setState(await (await fetch("/api/state")).json());
  useEffect(() => {
    refresh();
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const fund = () =>
    act(async () => {
      setRefund(null);
      await fetch("/api/fund", { method: "POST" });
      await refresh();
    });

  const run = () =>
    act(async () => {
      const res: PeriodResult & { state: SubscriptionState } = await (
        await fetch("/api/run", { method: "POST" })
      ).json();
      setLastRun(res);
      setState(res.state);
    });

  const cancel = () =>
    act(async () => {
      const res = await (await fetch("/api/cancel", { method: "POST" })).json();
      setRefund({ refunded: res.refunded, monthsRefunded: res.monthsRefunded });
      setState(res.state);
    });

  const reset = () =>
    act(async () => {
      setLastRun(null);
      setRefund(null);
      setState(await (await fetch("/api/reset", { method: "POST" })).json());
    });

  const active = state?.active ?? false;

  return (
    <main className="wrap">
      <h1>Standing Order</h1>
      <p className="sub">
        The subscription you forgot to cancel, except you get your unused months back. Fund a few
        months into an escrow you still own. The provider charges one fixed period at a time and
        only delivers when paid. Forget about it and it can never take more than you funded, and the
        moment you cancel, every month you prepaid but did not use is refunded. Demo provider: an AI
        agent that finds Warsaw leads and writes Sonnet pitches for each paid period.
      </p>

      {refund && (
        <p className="note ok-note">
          ✓ Cancelled. Refunded {usdc(refund.refunded)} USDC = {refund.monthsRefunded} unused
          month(s) straight back to you.
        </p>
      )}
      {active && state?.atRisk && (
        <p className="note warn">
          ⚠ RenewalAtRisk: escrow ({usdc(state.escrowBalance)} USDC) can&apos;t cover two more
          periods. Fund more or the subscription lapses. On-chain this is an emitted event.
        </p>
      )}
      {lastRun && !lastRun.charged && (
        <p className="note warn">
          Period not billed ({lastRun.reason}).{" "}
          {lastRun.reason === "InsufficientFunds"
            ? "Escrow is empty, so service lapsed. Fund to resume."
            : "Subscription is cancelled."}
        </p>
      )}

      <div className="grid">
        <div className="card">
          <div className="k">Months remaining</div>
          <div className="v green">{state ? state.monthsRemaining : 0}</div>
        </div>
        <div className="card">
          <div className="k">Periods billed</div>
          <div className="v">{state ? state.periodsCharged : 0}</div>
        </div>
        <div className="card">
          <div className="k">Your escrow</div>
          <div className="v blue">{state ? usdc(state.escrowBalance) : "0.0000"}</div>
        </div>
      </div>

      <div className="row">
        <button onClick={fund} disabled={busy || !active}>
          Fund 3 months (0.3 USDC)
        </button>
        <button onClick={run} disabled={busy || !active} className="secondary">
          {busy ? "Working..." : "Run billing period"}
        </button>
        <button onClick={cancel} disabled={busy || !active} className="ghost">
          Cancel &amp; refund
        </button>
        <button onClick={reset} disabled={busy} className="ghost">
          Reset
        </button>
      </div>

      <p className="note">
        Price {state ? usdc(state.price) : "0.10"} USDC per period. The provider can charge at most
        once per period and never more than the price, no matter how many times it asks.
      </p>

      {lastRun?.charged && lastRun.drafts && (
        <div className="section">
          <h2>
            Period {lastRun.period} delivered ({usdc(lastRun.amount ?? 0)} USDC) —{" "}
            {lastRun.leads?.length ?? 0} Warsaw leads, {lastRun.drafts.length} pitches
          </h2>
          {lastRun.drafts.map((d) => (
            <div className="draft" key={d.industry}>
              <span className="ind">{d.industry}</span>
              <span className="badge">{d.model}</span>
              {!d.hasEmDash && <span className="badge ok">no em dash</span>}
              <div className="body">
                <strong>{d.subject}</strong>
                <br />
                {d.body}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <h2>Billing history</h2>
        {!state || state.charges.length === 0 ? (
          <div className="empty">No periods billed yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Charged (USDC)</th>
                <th>Escrow after</th>
              </tr>
            </thead>
            <tbody>
              {state.charges.map((c) => (
                <tr key={c.period}>
                  <td className="mono">{c.period}</td>
                  <td className="reward">{usdc(c.amount)}</td>
                  <td className="mono">{usdc(c.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        On-chain (program <span className="mono">standing_order</span>): escrow lives in a PDA you
        control; <span className="mono">charge</span> fires at most once per period and only up to
        the price; <span className="mono">cancel</span> refunds the unused months; events{" "}
        <span className="mono">Charged</span> / <span className="mono">RenewalAtRisk</span> /{" "}
        <span className="mono">SubscriptionCancelled</span> are emitted. This page runs that logic in
        memory; set <span className="mono">ANTHROPIC_API_KEY</span> for real Sonnet pitches.
      </p>
    </main>
  );
}
