// The client seam. The app talks to this, never to Solana directly. Today the
// in-memory MockSubscriptionClient; later a SolanaSubscriptionClient backed by the
// deployed standing_order program — same shape, nothing else changes.

export interface Charge {
  period: number;
  amount: number; // base units
  remaining: number; // escrow after this charge
  at: string;
}

export interface SubscriptionState {
  active: boolean;
  price: number;
  escrowBalance: number;
  monthsRemaining: number; // floor(escrow / price)
  periodsCharged: number;
  providerReceived: number;
  atRisk: boolean; // escrow cannot cover more than one more period
  charges: Charge[]; // newest first
}

export interface SubscriptionClient {
  getState(): Promise<SubscriptionState>;
  fund(amount: number): Promise<SubscriptionState>;
  charge(): Promise<Charge>; // throws "Inactive" | "InsufficientFunds"
  cancel(): Promise<{ refunded: number; monthsRefunded: number }>;
  reset(): Promise<void>;
}
