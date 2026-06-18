export interface Member {
  id: string;
  name: string;
  you: boolean;
  points: number;
  streak: number;
  contributed: number;
  lastPeriod: number;
}

export interface Payout {
  round: number;
  name: string;
  contributed: number;
  paidOut: number;
  remaining: number;
}

export interface CircleState {
  period: number;
  round: number;
  vault: number;
  pTotal: number;
  vMin: number;
  canPayout: boolean;
  frontId: string | null; // member at the front of the queue (highest points, eligible)
  youMissedLast: boolean;
  members: Member[]; // sorted by points desc
  payouts: Payout[]; // newest first
}

export interface CircleClient {
  getState(): Promise<CircleState>;
  contribute(amount: number): Promise<CircleState>; // you
  advance(): Promise<CircleState>; // a period passes: others contribute, missers decay
  payout(): Promise<CircleState>; // front of queue collects
  reset(): Promise<void>;
}
