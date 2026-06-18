# Esusu — a trustless savings circle on Solana

**Live demo:** https://web-ten-liart-30.vercel.app


A savings circle (esusu / ajo / tanda / ROSCA) implemented as a Solana program. Everyone keeps
funding a shared vault over time; your **points** grow with how much and how often you contribute;
when the vault crosses a minimum, the front of the queue withdraws a **slice sized by their share of
points**. Because the pool is continuously replenished, you can take **more than you have put in so
far** — funded by the ongoing contribution stream, not minted from nowhere — while the vault is
**never drained** (any payout is only a capped share of it).

## The everyday friction (traditional systems)

Hundreds of millions of people run informal savings circles. They work socially but fail
structurally: you must **trust the organizer** not to abscond with the pot, **trust members** to
keep paying after they have collected, and there is **no enforcement** when someone stops. The
whole thing rests on personal trust and breaks at scale or across strangers.

## How this works on Solana

| Friction | On-chain guarantee |
|----------|--------------------|
| Organizer holds the pot | Funds live in a **PDA escrow**; no person ever has custody. |
| "Can I take more than I put in?" | Yes — your payout `points/Σpoints · vault` is drawn from a pool that keeps growing. **Size OR consistency** earns it: a large stake holds a large share of the growing vault, and a streak lifts your points per dollar. You only fall behind if you are **both small AND infrequent**. |
| "Won't that drain the vault?" | No — a payout is only a **share** of the pool (capped at 10–33.3%, the cap itself scaling with your streak), so `withdrawal ≤ your share ≤ vault`. **Un-drainable by arithmetic.** |
| Freeloaders / quitters | Points only come from real contributions; miss a period and your points decay and your streak resets. |

Permissionless (anyone opens or joins a circle), token-native (USDC), and trustless where it
counts: nobody trusts an organizer, and the vault cannot be over-drawn.

## The mechanism (and the psychology behind the numbers)

```
contribute:  points += amount × (1 + 0.10 · min(streak, 7))   // up to 1.7×
miss a period:  streak → 0,  points × 0.9                       // loss-aversion decay
payout (front of queue, when vault ≥ V_min):
             β(streak) = 10% → 33.3%, scaling linearly with streak (0 → 7)
             W = min( points / Σpoints · vault ,  β(streak) · vault )
             burn only the points cashed out (residual carries), rotate to the back
             (no consistency gate — size OR streak both qualify; streak only sizes the cap)
```

- **Streak +10%/period capped at 7 (1.7×).** Habit-formation research (and every streak app) shows
  consistency is driven by an unbroken, visible chain on a roughly weekly loop. 1.7× also reproduces
  the canonical example: ~$9 contributed → ~$15 collected.
- **10% decay on a miss.** Loss aversion (losses ≈ 2× gains) is the strongest motivator here —
  people show up to avoid *losing* standing. 10% stings but is recoverable, so a slip doesn't cause
  a rage-quit.
- **Streak-scaled payout cap (β: 10% → 33.3%).** The withdrawal ceiling itself rises with consistency, so a one-off contributor can take at most 10% of the vault while a fully consistent member can take up to a third — rewarding loyalty a second way, while keeping ≥ two-thirds of the pool for everyone else.
- **V_min + time backstop.** The goal-gradient effect: a visible target drives a contribution surge.

## Account model

- **`Circle`** (PDA, seeds `["circle", authority]`) — authority, mint, `v_min`, `period_secs`,
  `start_ts`, `p_total`, `round`.
- **`Member`** (PDA, seeds `["member", circle, owner]`) — points, streak, last_period, contributed.
- **`escrow`** — associated token account owned by the `Circle` PDA; holds the pooled USDC.
- Instructions: `open_circle`, `join`, `contribute` (points = amount × streak-multiplier),
  `claim` (points-share payout, capped; burns only the points cashed out). Event: `Payout`.

## Tradeoffs & constraints (honest scope)

- **A flow, not a fixed pot.** "More than you put in" is funded by the **ongoing stream** of
  contributions plus redistribution away from the small-and-infrequent — not minted from nowhere.
  Over a full cycle it conserves (total out ≤ total in).
- **Who wins, who loses.** You net positive by EITHER contributing **above-average size** OR
  **consistently** — each gives you a share of the growing vault that exceeds your outlay. You only
  net negative if you are **both small AND infrequent**: too few points to claim a meaningful slice,
  diluted as the pool grows.
- **The real ROSCA risk (stated plainly).** This is not a pure Ponzi — there are genuine net losers
  (the disengaged), and the upside is mostly a timing/liquidity benefit — but it shares ajo's
  fragility: **it stays solvent only while contributions keep flowing.** If the stream dries up, the
  last claimants bear the shortfall. The β cap and points-share math bound that exposure; they
  don't erase it.
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
