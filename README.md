# Standing Order — the subscription that can't overcharge you

A trustless standing order (recurring payment mandate) implemented as a Solana program.
You fund an escrow once and authorise a provider to pull payment over time. The **program**,
not the merchant, enforces a per-period spend cap, keeps custody of your funds, emits a
low-balance notification, and lets you cancel and reclaim the remainder at any instant.

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

## How this works on Solana

| Friction | On-chain guarantee |
|----------|--------------------|
| Custody  | Funds sit in a **PDA escrow** the payer controls; the provider never holds them. |
| Overcharging | `pull` reverts if it exceeds `max_per_period` — the cap is **enforced by the program**, not the merchant. |
| Cancelling | `cancel` deactivates the mandate and **refunds the full remainder in one transaction**, permissionlessly. |
| Visibility | Every `pull` emits `Charged`; crossing the threshold emits **`LowBalance`** (the on-chain notification). |

Permissionless: anyone can open a mandate; a provider is just a pubkey. Token-native: settlement
is in USDC. Trustless where it counts: the payer never has to trust the merchant on price, cap,
custody, or cancellation.

## Account model

- **`Mandate`** (PDA, seeds `["mandate", owner, provider]`) — owner, provider, mint, `max_per_period`,
  `period_secs`, `spent_this_period`, `period_start`, `low_balance_threshold`, `total_pulled`, `active`.
- **`escrow`** — an associated token account owned by the `Mandate` PDA; holds the USDC.
- Instructions: `open_mandate`, `fund`, `pull` (provider-signed, capped, emits events), `cancel`
  (owner-signed, refunds + deactivates).
- Events: `Charged`, `LowBalance`, `MandateCancelled`.

The rate window is a simple `period_start + period_secs` roll, reset lazily on the first `pull`
after a period elapses — no cranks, no clock keeper.

## Tradeoffs & constraints (honest scope)

- **The program guarantees price, cap, custody, and cancellation — not the truth of the work.**
  The provider still reports *what* was delivered (a metered unit, a task). The chain bounds how
  much they can take; it does not verify the off-chain service. Fully removing that trust would
  require the service itself to be on-chain-verifiable.
- **Per-period cap, not per-pull pricing.** Minimal by design: the cap is the safety rail; unit
  pricing is the provider's concern. (Zero feature-creep — see the challenge brief.)
- **Lazy window reset.** The period only rolls when a `pull` happens after it elapses; there is no
  background process. Correct for this use case, and cheaper than a crank.
- **One mandate per (owner, provider) pair.** Deterministic PDA; a second provider is a second mandate.

## Devnet

- Program ID: `<filled after deploy>`
- Example transactions:
  - open + fund: `<tx link>`
  - pull (within cap): `<tx link>`
  - pull rejected (over cap): `<tx link>`
  - cancel + refund: `<tx link>`

## Run it

**Program (in a Codespace or Linux):**
```bash
npm install
anchor build
anchor keys sync     # set the real program id
anchor test          # opens, funds, pulls within/over the cap, rejects intruder, cancels+refunds
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
