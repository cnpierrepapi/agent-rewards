import { SubscriptionClient, SubscriptionState, Charge } from "./types";
import { SUB } from "./schedule";

// In-memory mirror of the on-chain standing_order program:
//   fund   -> add periods to the escrow
//   charge -> provider collects one period's price (fails if escrow can't cover it)
//   cancel -> refund every funded-but-uncharged period
// Each charge() here represents one billing period passing.
class MockSubscriptionClient implements SubscriptionClient {
  private active = true;
  private escrow = 0;
  private periodsCharged = 0;
  private providerReceived = 0;
  private charges: Charge[] = [];
  private price = SUB.price;

  private snapshot(): SubscriptionState {
    return {
      active: this.active,
      price: this.price,
      escrowBalance: this.escrow,
      monthsRemaining: Math.floor(this.escrow / this.price),
      periodsCharged: this.periodsCharged,
      providerReceived: this.providerReceived,
      atRisk: this.active && this.escrow < this.price * 2,
      charges: [...this.charges].reverse(),
    };
  }

  async getState() {
    return this.snapshot();
  }

  async fund(amount: number) {
    if (amount <= 0) throw new Error("InvalidAmount");
    this.escrow += amount;
    return this.snapshot();
  }

  async charge(): Promise<Charge> {
    if (!this.active) throw new Error("Inactive");
    if (this.escrow < this.price) throw new Error("InsufficientFunds");
    this.escrow -= this.price;
    this.periodsCharged += 1;
    this.providerReceived += this.price;
    const c: Charge = {
      period: this.periodsCharged,
      amount: this.price,
      remaining: this.escrow,
      at: new Date().toISOString(),
    };
    this.charges.push(c);
    return c;
  }

  async cancel() {
    const refunded = this.escrow;
    const monthsRefunded = Math.floor(this.escrow / this.price);
    this.escrow = 0;
    this.active = false;
    return { refunded, monthsRefunded };
  }

  async reset() {
    this.active = true;
    this.escrow = 0;
    this.periodsCharged = 0;
    this.providerReceived = 0;
    this.charges = [];
  }
}

const g = globalThis as unknown as { __sub?: SubscriptionClient };
export const subscription: SubscriptionClient =
  g.__sub ?? (g.__sub = new MockSubscriptionClient());
