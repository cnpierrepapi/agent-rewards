# Esusu — a trustless savings circle on Solana

A savings circle (esusu / ajo / tanda / ROSCA) implemented as a Solana program. Everyone funds a
shared vault; your **points** grow with how much and how often you contribute; when the vault
crosses a minimum, the front of the queue withdraws a **slice sized by their share of points** —
**more than they put in, but never enough to drain the pool.** Solvent by construction.

## The everyday friction (traditional systems)

Hundreds of millions of people run informal savings circles. They work socially but fail
structurally: you must **trust the organizer** not to abscond with the pot, **trust members** to
keep paying after they have collected, and there is **no enforcement** when someone stops. The
whole thing rests on personal trust and breaks at scale or across strangers.

## How this works on Solana

| Friction | On-chain guarantee |
|----------|--------------------|
| Organizer holds the pot | Funds live in a **PDA escrow**; no person ever has custody. |
| "Can I take more than I put in?" | Yes — your payout is `points/Σpoints · vault`, and points are lifted by your streak, so a consistent member withdraws more than they contributed. |
| "Won't that drain the vault?" | No — a payout is only a **share** of the pool (capped at 50%), so `withdrawal ≤ your share ≤ vault`. **Un-drainable by arithmetic.** |
| Freeloaders / quitters | Points only come from real contributions; miss a period and your points decay and your streak resets. |

Permissionless (anyone opens or joins a circle), token-native (USDC), and trustless where it
counts: nobody trusts an organizer, and the vault cannot be over-drawn.

## The mechanism (and the psychology behind the numbers)

```
contribute:  points += amount × (1 + 0.10 · min(streak, 7))   // up to 1.7×
miss a period:  streak → 0,  points × 0.9                       // loss-aversion decay
payout (front of queue, when vault ≥ V_min):
             W = min( points / Σpoints · vault ,  0.5 · vault )
             then points → 0, rotate to the back
```

- **Streak +10%/period capped at 7 (1.7×).** Habit-formation research (and every streak app) shows
  consistency is driven by an unbroken, visible chain on a roughly weekly loop. 1.7× also reproduces
  the canonical example: ~$9 contributed → ~$15 collected.
- **10% decay on a miss.** Loss aversion (losses ≈ 2× gains) is the strongest motivator here —
  people show up to avoid *losing* standing. 10% stings but is recoverable, so a slip doesn't cause
  a rage-quit.
- **50% payout cap (β).** Keeps the vault visibly solvent, which itself increases contribution.
- **V_min + time backstop.** The goal-gradient effect: a visible target drives a contribution surge.

## Account model

- **`Circle`** (PDA, seeds `["circle", authority]`) — authority, mint, `v_min`, `period_secs`,
  `start_ts`, `p_total`, `round`.
- **`Member`** (PDA, seeds `["member", circle, owner]`) — points, streak, last_period, contributed.
- **`escrow`** — associated token account owned by the `Circle` PDA; holds the pooled USDC.
- Instructions: `open_circle`, `join`, `contribute` (points = amount × streak-multiplier),
  `claim` (points-share payout, capped, resets the member). Event: `Payout`.

## Tradeoffs & constraints (honest scope)

- **It redistributes; it is not a money machine.** The "more than you put in" for a frequent member
  is funded by the infrequent members' contributions — a deliberate consistency reward, conserved
  within the pool. It is explicitly **not** paid by newcomers (that would be a Ponzi and would die in
  a contribution downturn). Total out ≤ total in, always.
- **Queue ordering is client-computed; the *amount* is trustless.** The program guarantees nobody can
  take more than their capped share; which eligible member collects next is chosen off-chain (and can
  be made fully on-chain later). No oracle is involved in the money.
- **Decay lives in the client today.** On-chain `contribute`/`claim` enforce the streak multiplier and
  the share cap; the inactivity decay is applied in the UX layer and is a documented v2 on-chain step
  (lazy per-member decay keeps `p_total` exact).
- **No scheduler.** Payouts are triggered by a transaction (any member), not a timer.

## Devnet

- Program ID: `<filled after deploy>`
- Example transactions: open + join `<tx>` · contribute (streak) `<tx>` · claim (more than contributed) `<tx>` · claim rejected below V_min `<tx>`

## Run it

**Program (Codespace or Linux):**
```bash
npm install
anchor build && anchor keys sync && anchor build
anchor test          # join, streak-weighted points, share payout > contribution, rejections
anchor deploy --provider.cluster devnet
```

**Client demo:**
```bash
cd web && npm install && npm run dev    # http://localhost:3000
```

Devnet only. Unaudited. Built for the "Everyday Real-World Systems as On-Chain Rust Programs" challenge.
