// Base units: 1 USDC = 1_000_000. Mirrors the on-chain `circle` program constants.
export const USDC = 1_000_000;

export const PARAMS = {
  alphaBps: 1000, // +10% points per consecutive-period streak step
  streakMax: 7, // multiplier caps at 1.7x
  betaBps: 5000, // a single payout is capped at 50% of the vault
  decayBps: 9000, // miss a period -> keep 90% of points (loss-aversion nudge)
  vMin: 15 * USDC, // payout unlocks once the vault reaches $15
  minContribution: 1 * USDC,
  maxContribution: 10 * USDC,
};

export const usdc = (base: number) => (base / USDC).toFixed(2);
export const multiplierBps = (streak: number) =>
  10_000 + PARAMS.alphaBps * Math.min(streak, PARAMS.streakMax);
