import { CircleClient, CircleState, DepositEvent, Member } from "./types";
import { PARAMS, USDC } from "./schedule";

const SIM_NAMES = ["Ada", "Bola", "Chidi", "Dapo", "Emeka", "Funke"];
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mockSig = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join("");

// Deposit cascade: each deposit splits 50% DOWN to earlier members (by share) and 50% UP,
// gifted to the very next depositor. The first member's down-half goes to a locked floor.
class MockCascadeClient implements CircleClient {
  private poolTotal = 0;
  private floor = 0;
  private upReserve = 0;
  private nextOrder = 1;
  private simIdx = 0;
  private events: DepositEvent[] = [];
  private members: Member[] = [
    { id: "you", name: "You", you: true, order: 0, deposited: 0, balance: 0, withdrawn: 0 },
  ];

  private get(id: string) {
    return this.members.find((m) => m.id === id)!;
  }

  private depositBy(m: Member, amount: number) {
    if (m.deposited === 0) m.order = this.nextOrder++; // assign join order on first deposit

    // 1. the UP gift: this depositor receives the reserve left by the previous depositor
    m.balance += this.upReserve;
    this.upReserve = 0;

    // 2. the DOWN half: split among earlier members by share of their deposits
    const down = Math.floor(amount / 2);
    const up = amount - down;
    const earlier = this.members.filter((o) => o.deposited > 0 && o.id !== m.id);
    const totalEarlier = earlier.reduce((s, o) => s + o.deposited, 0);
    if (totalEarlier > 0) {
      for (const o of earlier) o.balance += Math.floor((down * o.deposited) / totalEarlier);
    } else {
      this.floor += down; // first ever depositor: down-half is locked
    }

    // 3. the UP half is held for the next depositor
    this.upReserve = up;

    m.deposited += amount;
    this.poolTotal += amount;
    this.events.unshift({ actor: m.name, amount, sig: mockSig() });
    if (this.events.length > 14) this.events.pop();
  }

  private snapshot(): CircleState {
    const joined = this.members.filter((m) => m.deposited > 0 || m.you);
    return {
      poolTotal: this.poolTotal,
      floor: this.floor,
      upReserve: this.upReserve,
      members: [...joined].sort((a, b) => (a.order || 99) - (b.order || 99)),
      you: this.members.find((m) => m.you) ?? null,
      events: this.events.slice(0, 14),
    };
  }

  async getState() {
    return this.snapshot();
  }

  async deposit(amount: number) {
    const a = Math.max(PARAMS.minDeposit, Math.min(PARAMS.maxDeposit, amount));
    this.depositBy(this.get("you"), a);
    return this.snapshot();
  }

  async advance() {
    const name = SIM_NAMES[this.simIdx % SIM_NAMES.length];
    let m = this.members.find((x) => x.name === name && !x.you);
    if (!m) {
      m = { id: "m" + this.simIdx, name, you: false, order: 0, deposited: 0, balance: 0, withdrawn: 0 };
      this.members.push(m);
    }
    const amt = (2 + (this.simIdx % 5)) * USDC; // $2 - $6
    this.simIdx++;
    this.depositBy(m, amt);
    return this.snapshot();
  }

  async withdraw() {
    const you = this.get("you");
    you.withdrawn += you.balance;
    you.balance = 0;
    return this.snapshot();
  }

  async reset() {
    this.poolTotal = 0;
    this.floor = 0;
    this.upReserve = 0;
    this.nextOrder = 1;
    this.simIdx = 0;
    this.events = [];
    this.members = [
      { id: "you", name: "You", you: true, order: 0, deposited: 0, balance: 0, withdrawn: 0 },
    ];
  }
}

const g = globalThis as unknown as { __cascade?: CircleClient };
export const circle: CircleClient = g.__cascade ?? (g.__cascade = new MockCascadeClient());
