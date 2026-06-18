import { CircleClient, CircleState, Member, Payout } from "./types";
import { PARAMS, multiplierBps, betaBps } from "./schedule";

const NAMES = ["Ada", "Bola", "Chidi", "Dapo", "Emeka", "Funke"];
// reliability of each simulated member (skip a period when (period+i+1) % mod === 0; 99 = never skip)
const SKIP_MOD = [99, 99, 3, 2, 4, 99];
const SIM_AMT = [3, 2, 4, 5, 2, 6].map((d) => d * PARAMS.minContribution); // their per-period $

// Mirrors the on-chain math; simulates a small circle so the redistribution is visible.
class MockCircleClient implements CircleClient {
  private period = 0;
  private round = 0;
  private vault = 0;
  private pTotal = 0;
  private members: Member[] = [];
  private payouts: Payout[] = [];
  private youMissedLast = false;

  constructor() {
    this.seed();
  }
  private seed() {
    this.period = 0;
    this.round = 0;
    this.vault = 0;
    this.pTotal = 0;
    this.payouts = [];
    this.youMissedLast = false;
    this.members = [
      { id: "you", name: "You", you: true, points: 0, streak: 0, contributed: 0, lastPeriod: -1 },
      ...NAMES.map((name, i) => ({
        id: `m${i}`,
        name,
        you: false,
        points: 0,
        streak: 0,
        contributed: 0,
        lastPeriod: -1,
      })),
    ];
  }

  private apply(m: Member, amount: number) {
    if (m.lastPeriod >= 0) {
      const gap = this.period - m.lastPeriod;
      if (gap === 1) m.streak += 1;
      else if (gap >= 2) m.streak = 0;
    } else {
      m.streak = 0;
    }
    m.lastPeriod = this.period;
    const gained = Math.floor((amount * multiplierBps(m.streak)) / 10_000);
    m.points += gained;
    m.contributed += amount;
    this.pTotal += gained;
    this.vault += amount;
  }

  private decay(m: Member) {
    const after = Math.floor((m.points * PARAMS.decayBps) / 10_000);
    this.pTotal -= m.points - after;
    m.points = after;
    m.streak = 0;
  }

  private eligible(): Member[] {
    return this.members
      .filter((m) => m.points > 0 && m.streak >= 1)
      .sort((a, b) => b.points - a.points);
  }

  private snapshot(): CircleState {
    const you = this.members.find((m) => m.you)!;
    const front = this.eligible()[0] ?? null;
    return {
      period: this.period,
      round: this.round,
      vault: this.vault,
      pTotal: this.pTotal,
      vMin: PARAMS.vMin,
      canPayout: this.vault >= PARAMS.vMin && front !== null,
      frontId: front?.id ?? null,
      youMissedLast: this.youMissedLast,
      members: [...this.members].sort((a, b) => b.points - a.points),
      payouts: [...this.payouts].reverse(),
      // `you` extras are read off the members list client-side
    } as CircleState;
  }

  async getState() {
    return this.snapshot();
  }

  async contribute(amount: number) {
    const a = Math.max(PARAMS.minContribution, Math.min(PARAMS.maxContribution, amount));
    const you = this.members.find((m) => m.you)!;
    this.apply(you, a);
    this.youMissedLast = false;
    return this.snapshot();
  }

  async advance() {
    // 1. simulated members contribute for the current period (by their reliability)
    this.members.forEach((m, idx) => {
      if (m.you) return;
      const i = idx - 1;
      if ((this.period + i + 1) % SKIP_MOD[i] !== 0) this.apply(m, SIM_AMT[i]);
    });
    // 2. decay anyone (including you) who missed THIS period
    const you = this.members.find((m) => m.you)!;
    this.youMissedLast = you.lastPeriod < this.period && you.points > 0;
    this.members.forEach((m) => {
      if (m.lastPeriod < this.period && m.points > 0) this.decay(m);
    });
    // 3. time passes
    this.period += 1;
    return this.snapshot();
  }

  async payout() {
    const front = this.eligible()[0];
    if (!front || this.vault < PARAMS.vMin) return this.snapshot();
    const share = Math.floor((front.points * this.vault) / this.pTotal);
    const cap = Math.floor((betaBps(front.streak) * this.vault) / 10_000);
    const w = Math.min(share, cap);
    // burn only the points actually paid out; residual carries forward (no forfeiture)
    const burned = Math.min(Math.floor((w * this.pTotal) / this.vault), front.points);
    const p: Payout = {
      round: this.round + 1,
      name: front.name,
      contributed: front.contributed,
      paidOut: w,
      remaining: this.vault - w,
    };
    this.payouts.push(p);
    this.vault -= w;
    this.pTotal -= burned;
    front.points -= burned;
    front.streak = 0;
    if (front.points === 0) {
      front.contributed = 0;
      front.lastPeriod = -1;
    }
    this.round += 1;
    return this.snapshot();
  }

  async reset() {
    this.seed();
  }
}

const g = globalThis as unknown as { __circle?: CircleClient };
export const circle: CircleClient = g.__circle ?? (g.__circle = new MockCircleClient());
