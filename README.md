# btc-race-24h-20261118-1444 — Layered Dip Buyer

Bot for the make.fun competition "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261118-1444`). Trades cbBTC/USDC on 1-minute bars, long only,
$1,000 starting capital. Node 22, stdlib only plus the vendored kit SDK
(`vendor/makefun-bars.ts`, byte-identical copy of the kit shim).

## Strategy — layered, not a single indicator

An entry needs all four layers to agree:

1. **Regime (SMA-120).** Dip threshold adapts to the SMA-120 slope over the
   last 60 bars: 80 bps below the SMA when the SMA is flat/rising, 130 bps
   when it is falling — counter-trend entries demand a bigger dislocation.
   A second trigger, a sharp 60-bar drop of ≥ 170 bps, catches a plunge
   before the SMA has moved.
2. **Momentum confirmation (RSI-14, Wilder).** Entry only while RSI ≤ 55:
   never buy a dip while momentum is still hot; the dip plus a cooled RSI
   means the fall has paused.
3. **Volatility filter + sizing (ATR-14).** No entry while ATR < 2 bps of
   price (dead chop cannot pay the ~26 bps round-trip cost). Full size when
   ATR ≥ 4 bps, half size below it — smaller positions when the market is
   quiet, and lower price impact (impact scales with size / pool depth).
4. **Risk management.** Exit on the first of: +110 bps from entry close,
   close back above SMA-120 + 120 bps, −120 bps trailing from the highest
   close since entry, or −200 bps hard stop. After any exit a 30-bar
   cooldown blocks re-entry. One position, long only, deterministic
   (float64 closes in fixed order, no clock, no randomness, no network).

## Parameters (final)

| Parameter | Value |
|---|---|
| SMA span / slope span | 120 / 60 bars |
| Dip below SMA (uptrend / downtrend) | 80 / 130 bps |
| Sharp-drop trigger (60-bar return) | −170 bps |
| RSI-14 max at entry | 55 |
| ATR-14 min / full-size threshold | 2 / 4 bps of price |
| Exit target / SMA recovery | +110 / +120 bps |
| Trailing stop / hard stop | −120 / −200 bps |
| Cooldown after exit | 30 bars |
| Max slippage per order | 300 bps |

## Dev-window result (grade-local, kit's official grader)

```
net PnL   +$14.24  (return +1.42%)
max drawdown  0.65%
trades    5 (win rate 66.7%), 0 rejected
fees      $2.42; at 2x fees net PnL +$11.82
guardrails met
```

Command (from the kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Context: the dev window is a falling range (buy-and-hold ≈ −$28, EMA-cross
baseline ≈ −$130 in offline simulation, RSI/Bollinger bounce ≈ −$55). The
profit comes from 2–3 deep-dip bounces; the bot is deliberately
conservative — it would rather sit in cash than chase a falling market.

## Robustness (grade-local, real grader — not just offline sim)

Each row changes one parameter from the final bot; everything else fixed.
The final choice sits in the middle of a flat plateau, not on a peak.

| Variant | Net PnL | Max DD | Trades |
|---|---|---|---|
| **Final (target 110, cooldown 30)** | **+$14.24** | **0.65%** | **5** |
| v1 (target 100, no cooldown) | +$13.66 | 0.97% | 5 |
| Target 100 (with cooldown) | +$14.24 | 0.65% | 5 — byte-identical action log to final |
| Target 120 (with cooldown) | +$17.15 | 0.65% | 5 |
| Target 130 (with cooldown, dip 70/140) | −$4.62 | 1.44% | 2 |
| Target 140 | +$4.86 | 1.72% | 5 |
| Cooldown 15 (target 120, dip 70/140) | +$16.37 | 1.12% | 4 |
| Cooldown 60 (target 120, dip 70/140) | +$7.62 | 0.62% | 2 |
| Dip 70/140 + target 120 + cooldown 30 | +$18.04 | 0.65% | 4 |
| RSI cap 45 (instead of 55) | +$18.04 | 0.65% | 4 — identical to dip 70/140 variant |
| Trail 100 / ATR-full 6 bps | +$13.66 | 0.97% | 5 — no change vs v1 |

Why target 110, not 120, even though 120 scores higher: at 120 the extra
+$2.91 rests on a single bounce clearing 120 bps, and at 130 the same bot
goes negative — a knife-edge, not a plateau. Target 100 and 110 produce
byte-identical action logs, so 110 is the robust middle. Likewise the
+$18.04 dip-70/140 variant was rejected: its gain also hinges on one trade
(4 trades, win rate 100% looks good only because the losing trade never
happened on this window). Honest caveat: with only 2–3 round trips in the
window, every variant's PnL is driven by a handful of trades; the second
half of the dev window alone is ≈ −$0.84 for this family. The bot is built
to survive the race window (small drawdown, no forced trades), not to
maximise the dev number.

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — kit SDK shim, unmodified
- `LICENSE` — MIT
