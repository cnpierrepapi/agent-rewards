"use client";

import { useEffect, useRef, useState } from "react";

const USDC = 1_000_000;
const usd = (b: number) => "$" + (b / USDC).toFixed(2);

interface Member {
  id: string;
  name: string;
  you: boolean;
  order: number;
  deposited: number;
  balance: number;
  withdrawn: number;
}
interface DepositEvent {
  actor: string;
  amount: number;
  sig: string;
}
interface CircleState {
  poolTotal: number;
  floor: number;
  upReserve: number;
  members: Member[];
  you: Member | null;
  events: DepositEvent[];
}

export default function Home() {
  const [s, setS] = useState<CircleState | null>(null);
  const [amount, setAmount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);

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

  // the live stream: other members keep depositing every ~2s; your balance ticks up on its own
  useEffect(() => {
    liveRef.current = live;
    if (!live) return;
    const id = setInterval(async () => {
      if (!liveRef.current) return;
      const next = await post("/api/advance");
      if (liveRef.current) setS(next);
    }, 2100);
    return () => clearInterval(id);
  }, [live]);

  const deposit = async () => {
    setBusy(true);
    setS(await post("/api/deposit", { amount: amount * USDC }));
    setBusy(false);
    setLive(true); // once you're in, the circle comes alive
  };
  const withdraw = async () => {
    setBusy(true);
    setS(await post("/api/withdraw"));
    setBusy(false);
  };
  const reset = async () => {
    setLive(false);
    setBusy(true);
    setS(await post("/api/reset"));
    setBusy(false);
  };

  const net = (m: Member) => m.balance + m.withdrawn - m.deposited;
  const you = s?.you;
  const joined = (you?.deposited ?? 0) > 0;

  return (
    <main className="wrap">
      <h1>
        KZP — an on-chain contribution circle{" "}
        {live && <span className="livedot">● LIVE</span>}
      </h1>
      <p className="sub">
        A Polish-flavored savings circle (esusu/ajo, in the spirit of the Kasa
        Zapomogowo-Pożyczkowa). Each deposit splits in two: <strong>50% flows down</strong> to
        everyone who joined earlier, by their share of the pool, and <strong>50% is gifted up</strong>{" "}
        to the very next depositor. Deposit once, then watch the circle keep contributing and your
        claimable balance climb on its own. The Solana program settles every split.
      </p>

      <div className="grid">
        <div className="card">
          <div className="k">Pool</div>
          <div className="v">{s ? usd(s.poolTotal) : "$0.00"}</div>
        </div>
        <div className="card">
          <div className="k">Your claimable</div>
          <div className="v green">{you ? usd(you.balance) : "$0.00"}</div>
          <div className="k" style={{ marginTop: 6 }}>
            deposited {you ? usd(you.deposited) : "$0.00"} · net{" "}
            {you ? (net(you) >= 0 ? "+" : "") + usd(net(you)) : "$0.00"}
          </div>
        </div>
        <div className="card">
          <div className="k">Up-gift for next depositor</div>
          <div className="v blue">{s ? usd(s.upReserve) : "$0.00"}</div>
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
        <button onClick={deposit} disabled={busy}>
          {joined ? `Top up $${amount}` : `Join — deposit $${amount}`}
        </button>
        <button
          onClick={() => setLive((v) => !v)}
          disabled={!joined}
          className="secondary"
        >
          {live ? "Pause stream" : "Resume stream"}
        </button>
        <button onClick={withdraw} disabled={busy || !you || you.balance === 0} className="ghost">
          Withdraw {you ? usd(you.balance) : "$0.00"}
        </button>
        <button onClick={reset} disabled={busy} className="ghost">
          Reset
        </button>
      </div>
      <p className="note">
        {joined
          ? "Others are depositing live. Each new deposit sends 50% down to earlier members (you included) — watch your claimable rise, then withdraw whenever you like."
          : "Join first so you're early in the circle, then the live stream of contributions begins and your balance accumulates automatically."}
      </p>

      <div className="section">
        <h2>Live activity {live && <span className="livedot">●</span>}</h2>
        {!s || s.events.length === 0 ? (
          <div className="empty">No deposits yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Depositor</th>
                <th>Amount</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {s.events.map((e, i) => (
                <tr key={e.sig + i}>
                  <td>{e.actor}</td>
                  <td className="reward">{usd(e.amount)}</td>
                  <td className="mono">
                    {e.sig.slice(0, 8)}…{e.sig.slice(-6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note">
          Signatures shown are <strong>simulated</strong> in this in-memory demo. Wired to the
          deployed <span className="mono">circle</span> program, each row is a real Solana
          transaction signature linking to the explorer.
        </p>
      </div>

      <div className="section">
        <h2>The circle (in join order)</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Member</th>
              <th>Deposited</th>
              <th>Claimable</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {s?.members
              .filter((m) => m.deposited > 0)
              .map((m) => (
                <tr key={m.id} className={m.you ? "self" : ""}>
                  <td className="mono">{m.order}</td>
                  <td>{m.name}</td>
                  <td className="mono">{usd(m.deposited)}</td>
                  <td className="reward">{usd(m.balance)}</td>
                  <td className="mono" style={net(m) < 0 ? { color: "var(--warn)" } : { color: "var(--accent)" }}>
                    {net(m) >= 0 ? "+" : ""}
                    {usd(net(m))}
                  </td>
                </tr>
              ))}
            {(!s || s.members.filter((m) => m.deposited > 0).length === 0) && (
              <tr>
                <td colSpan={5} className="empty">
                  No deposits yet. Be the first — your down-half seeds the locked floor.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="note">
        On-chain (program <span className="mono">circle</span>): the vault is a PDA escrow; each{" "}
        <span className="mono">deposit</span> credits earlier members&apos; balances by share (a
        constant-time reward-per-share index, no iteration), gifts the up-half to the next depositor,
        and locks the first down-half as the floor. Honest constraint: this is a contribution-funded
        circle — early and ongoing depositors are favored, and it unwinds if deposits stop.
      </p>
    </main>
  );
}
