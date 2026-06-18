"use client";

import { useEffect, useState } from "react";

const USDC = 1_000_000;
const usd = (b: number) => "$" + (b / USDC).toFixed(2);
const mult = (streak: number) => (1 + 0.1 * Math.min(streak, 7)).toFixed(1) + "x";

interface Member {
  id: string;
  name: string;
  you: boolean;
  points: number;
  streak: number;
  contributed: number;
}
interface Payout {
  round: number;
  name: string;
  contributed: number;
  paidOut: number;
  remaining: number;
}
interface CircleState {
  period: number;
  round: number;
  vault: number;
  pTotal: number;
  vMin: number;
  canPayout: boolean;
  frontId: string | null;
  youMissedLast: boolean;
  members: Member[];
  payouts: Payout[];
}

export default function Home() {
  const [s, setS] = useState<CircleState | null>(null);
  const [amount, setAmount] = useState(3);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setS(await (await fetch("/api/state")).json());
  useEffect(() => {
    refresh();
  }, []);

  const post = (url: string, body?: object) =>
    fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json());

  const act = async (fn: () => Promise<CircleState>) => {
    setBusy(true);
    setS(await fn());
    setBusy(false);
  };

  const you = s?.members.find((m) => m.you);
  const sharePct = s && s.pTotal > 0 && you ? (you.points / s.pTotal) * 100 : 0;
  const progress = s ? Math.min(100, (s.vault / s.vMin) * 100) : 0;

  return (
    <main className="wrap">
      <h1>Esusu — a trustless savings circle</h1>
      <p className="sub">
        Everyone funds a shared vault. Your points grow with how much and how often you contribute.
        When the vault crosses {s ? usd(s.vMin) : "$15"}, the front of the queue withdraws a slice
        sized by their share of points, more than they put in, but never enough to drain the pool.
        Consistency pays: a 7-day streak lifts your points up to 1.7x, and missing a day costs you
        10%. The Solana program enforces all of it.
      </p>

      {s?.youMissedLast && (
        <p className="note warn">
          ⚠ You missed a period, so your points decayed 10% and your streak reset. Loss aversion is
          the point: show up to keep your edge.
        </p>
      )}

      <div className="grid">
        <div className="card">
          <div className="k">Vault</div>
          <div className="v">{s ? usd(s.vault) : "$0.00"}</div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="k" style={{ marginTop: 6 }}>
            {progress >= 100 ? "payout unlocked" : `${usd(s ? s.vMin : 0)} to unlock`}
          </div>
        </div>
        <div className="card">
          <div className="k">Your points</div>
          <div className="v green">{you ? Math.round(you.points / 10000) / 100 : 0}</div>
          <div className="k" style={{ marginTop: 6 }}>
            streak {you?.streak ?? 0} ({mult(you?.streak ?? 0)}) · {sharePct.toFixed(1)}% of pool
          </div>
        </div>
        <div className="card">
          <div className="k">You put in</div>
          <div className="v blue">{you ? usd(you.contributed) : "$0.00"}</div>
          <div className="k" style={{ marginTop: 6 }}>
            if you claimed now: {you && s && s.pTotal > 0
              ? usd(Math.min(Math.floor((you.points * s.vault) / s.pTotal), Math.floor(0.5 * s.vault)))
              : "$0.00"}
          </div>
        </div>
      </div>

      <div className="row">
        <input
          type="range"
          min={1}
          max={10}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          disabled={busy}
        />
        <button onClick={() => act(() => post("/api/contribute", { amount: amount * USDC }))} disabled={busy}>
          Contribute ${amount}
        </button>
        <button onClick={() => act(() => post("/api/advance"))} disabled={busy} className="secondary">
          Advance a day
        </button>
        <button
          onClick={() => act(() => post("/api/payout"))}
          disabled={busy || !s?.canPayout}
          className="secondary"
        >
          Trigger payout
        </button>
        <button onClick={() => act(() => post("/api/reset"))} disabled={busy} className="ghost">
          Reset
        </button>
      </div>
      <p className="note">
        Day {s?.period ?? 0} · {s?.payouts.length ?? 0} payouts so far. Contribute, then advance the
        day to let the others contribute (some skip and lose points). Trigger a payout once the vault
        is full.
      </p>

      <div className="section">
        <h2>The circle</h2>
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Points</th>
              <th>Streak</th>
              <th>Put in</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {s?.members.map((m) => (
              <tr key={m.id} className={m.id === s.frontId ? "front" : m.you ? "self" : ""}>
                <td>
                  {m.name}
                  {m.id === s.frontId && <span className="badge ok">next</span>}
                </td>
                <td className="reward">{Math.round(m.points / 10000) / 100}</td>
                <td className="mono">
                  {m.streak} ({mult(m.streak)})
                </td>
                <td className="mono">{usd(m.contributed)}</td>
                <td className="mono">
                  {s.pTotal > 0 ? ((m.points / s.pTotal) * 100).toFixed(1) : "0.0"}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Payouts</h2>
        {!s || s.payouts.length === 0 ? (
          <div className="empty">No payouts yet. Fill the vault to {s ? usd(s.vMin) : "$15"}.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Member</th>
                <th>Put in</th>
                <th>Took out</th>
                <th>Vault left</th>
              </tr>
            </thead>
            <tbody>
              {s.payouts.map((p) => (
                <tr key={p.round}>
                  <td className="mono">{p.round}</td>
                  <td>{p.name}</td>
                  <td className="mono">{usd(p.contributed)}</td>
                  <td className="reward">{usd(p.paidOut)}</td>
                  <td className="mono">{usd(p.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        On-chain (program <span className="mono">circle</span>): the vault is a PDA escrow; points
        accrue from amount × streak; <span className="mono">claim</span> pays{" "}
        <span className="mono">min(points/Σpoints · vault, 50% · vault)</span> then resets you to the
        back. You can take more than you contributed because consistency redistributes from the
        infrequent, and the pool can never be drained because any payout is only a share of it.
      </p>
    </main>
  );
}
