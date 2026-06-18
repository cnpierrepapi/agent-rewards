export interface Member {
  id: string;
  name: string;
  you: boolean;
  order: number; // join sequence (0 = not yet joined)
  deposited: number; // cumulative deposit = share basis
  balance: number; // claimable dividends received
  withdrawn: number; // already withdrawn
}

export interface DepositEvent {
  actor: string;
  amount: number;
  sig: string; // simulated now; real Solana signature once wired to the deployed program
}

export interface CircleState {
  poolTotal: number; // sum of all deposits (share denominator)
  floor: number; // first member's down-half, locked forever
  upReserve: number; // the up-gift waiting for the next depositor
  members: Member[]; // in join order (joined only), newest last
  you: Member | null;
  events: DepositEvent[]; // newest first
}

export interface CircleClient {
  getState(): Promise<CircleState>;
  deposit(amount: number): Promise<CircleState>; // you
  advance(): Promise<CircleState>; // another member deposits
  withdraw(): Promise<CircleState>; // you claim your balance
  reset(): Promise<void>;
}
