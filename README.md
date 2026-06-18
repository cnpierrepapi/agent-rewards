# Standing Order — the subscription that can't overcharge you

A trustless recurring subscription implemented as a Solana program: the one you forgot to cancel,
except you get your unused months back. You fund an escrow with one or more periods up front and
authorise a provider to collect a fixed `price` per period. The **program**, not the merchant,
enforces the cadence and amount, keeps custody of your prepaid funds, and lets you cancel and reclaim
every period you funded but never used.

> **Demo client:** an autonomous outreach agent acts as the "merchant". It fetches real Warsaw
> businesses, drafts per-industry pitches with Claude Sonnet, and meters its work by pulling tiny
> payments from the mandate — but it can never pull more than the cap you set.

---

## The everyday friction (traditional systems)

Subscriptions, direct debits, and standing orders all share the same three problems:

1. **You give up custody.** The merchant holds a payment instrument and pulls when they like.
2. **You trust them not to overcharge.** Caps, if any, live in the merchant's billing system.
3. **Cancelling is hard.** You chase support, and refunds of prepaid balances are slow or never.

The control sits with the party taking your money. That is backwards.

**Concrete case:** Grammarly charges the full ~$30 up front. Stop using it the next day and that
$30 is gone, there is no refund of the unused portion, and any "credit" expires on their terms. You
prepaid for a year of value and they captured all of it on day one. What you actually want: pay once
into an account you still own, let them draw only as they serve you, keep the unused balance (it
should roll over, not expire), and reclaim every cent you did not use the moment you cancel.

## How this works on Solana

| Friction | On-chain guarantee |
|----------|--------------------|
| Custody  | Funds sit in a **PDA escrow** the payer controls; the provider never holds them. |
| Overcharging | `charge` collects the fixed `price` **at most once per `period_secs`** — the cadence and amount are enforced by the program, not the merchant. |
| Forgotten subscription | It can never take more than you funded; charges simply stop when the escrow runs dry. |
| Cancelling | `cancel` deactivates the subscription and **refunds every funded-but-uncharged period in one transaction**. The Grammarly months you never used come straight back. |
| Visibility | Every `charge` emits `Charged`; when the escrow can't cover the next period it emits **`RenewalAtRisk`**, and `cancel` emits `SubscriptionCancelled`. |

Permissionless: anyone can open a mandate; a provider is just a pubkey. Token-native: settlement
is in USDC. Trustless where it counts: the payer never has to trust the merchant on price, cap,
custody, or cancellation.

## Account model

- **`Subscription`** (PDA, seeds `["sub", owner, provider]`) — owner, provider, mint, `price`,
  `period_secs`, `next_charge_ts`, `periods_charged`, `active`.
- **`escrow`** — an associated token account owned by the `Subscription` PDA; holds the prepaid USDC.
- Instructions: `open_subscription`, `fund` (deposit periods ahead), `charge` (provider-signed, one
  period per `period_secs`, emits events), `cancel` (owner-signed, refunds unused periods + deactivates).
- Events: `Charged`, `RenewalAtRisk`, `SubscriptionCancelled`.

The cadence is a `next_charge_ts` gate advanced by `period_secs` on each charge — no cranks, no clock
keeper.

## Tradeoffs & constraints (honest scope)

- **The program guarantees price, cap, custody, and cancellation — not the truth of the work.**
  The provider still reports *what* was delivered (a metered unit, a task). The chain bounds how
  much they can take; it does not verify the off-chain service. Fully removing that trust would
  require the service itself to be on-chain-verifiable.
- **No on-chain scheduler.** Solana programs can't self-trigger; the provider (or a keeper) sends the
  `charge` transaction each period. The program guarantees it can't be early, double-charged, or over
  the price — not that it fires on its own. This is honest and standard for Solana.
- **Fixed price per period from prepaid escrow.** Minimal by design (zero feature-creep). The only
  capital at risk is what the payer funded, and `cancel` returns the unused part.
- **One subscription per (owner, provider) pair.** Deterministic PDA; a second provider is a second subscription.

## Devnet

- Program ID: `<filled after deploy>`
- Example transactions:
  - open + fund: `<tx link>`
  - charge (period 1): `<tx link>`
  - charge rejected (not due yet): `<tx link>`
  - cancel + refund unused months: `<tx link>`

## Run it

**Program (in a Codespace or Linux):**
```bash
npm install
anchor build
anchor keys sync     # set the real program id
anchor test          # opens, funds, charges per period, rejects early/empty/unauthorised, cancels+refunds
anchor deploy --provider.cluster devnet
```

**Client (the demo merchant):**
```bash
cd web
npm install
npm run dev          # http://localhost:3000
```
Set `ANTHROPIC_API_KEY` for real Sonnet pitches; without it the agent uses a built-in template.

Devnet only. Unaudited. Built for the "Everyday Real-World Systems as On-Chain Rust Programs" challenge.
