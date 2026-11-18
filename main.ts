// btc-race-24h-20261118-1444 bot: layered mean-reversion dip buyer on 1-minute cbBTC bars.
//
// Layers (all four must agree before an entry; each was checked offline on the
// published dev window, then verified with the kit's grade-local):
//   1. Regime: SMA-120 trend. The dip threshold adapts to the SMA-120 slope
//      over the last 60 bars — shallower dip (80 bps) when the SMA is flat or
//      rising, deeper dip (130 bps) when it is falling, so counter-trend
//      entries demand a bigger dislocation. A sharp 60-bar drop (>=170 bps)
//      is a second, regime-independent entry trigger (it catches a plunge
//      before the SMA has moved).
//   2. Momentum confirmation: RSI-14 (Wilder) must be <= 55 at entry —
//      never buy a dip while momentum is still hot/overbought; the dip
//      itself plus a cooled RSI means the fall has paused, not accelerated.
//      The regime-independent sharp-drop trigger is stricter (RSI <= 45):
//      it fires mid-plunge, so it must show a cold RSI, not just "not hot".
//   3. Volatility filter + sizing: ATR-14 (true range, bps of price).
//      No entry when ATR < 2 bps (dead chop, no move to pay the ~26 bps
//      round-trip cost). Full size when ATR >= 4 bps, half size below it:
//      smaller positions when the market is quiet, so a false bounce
//      costs less, and impact (which scales with size / pool depth) stays low.
//   4. Risk management: exit on the first of — +110 bps from entry close,
//      close back above SMA-120 + 120 bps (mean reversion complete),
//      -120 bps trailing from the highest close since entry, or -200 bps
//      hard stop from entry close. After any exit, a 30-bar cooldown blocks
//      re-entry, so the bot cannot re-buy the same falling dip bar after bar.
//      One position, full size at most, long only.
//
// The dev window is a falling range (buy-and-hold about -$28, EMA-cross
// about -$130 in offline simulation): almost every naive rule loses, and
// the profit comes from 2-3 deep-dip bounces. Parameters were chosen on a
// plateau, not a peak — target 100 and 110 bps give byte-identical action
// logs on the dev window, dip 100-120 / drop 160-180 / RSI cap 50-65 all
// give roughly the same offline result, and a 120 bps target was REJECTED
// even though it scored higher (+$17.15): its gain rests on one bounce
// clearing 120 bps, and at 130 bps the same bot goes negative (-$4.62),
// so 110 bps is the robust middle of the plateau (see README).
//
// Deterministic: float64 closes in fixed order, no clock, no randomness,
// no network, no files outside this repository.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_SPAN = 120;
const SLOPE_SPAN = 60;
/** Dip below SMA-120 that triggers an entry, in bps of the SMA. Fallback
    while no 60-bar slope history exists yet; afterwards the regime-specific
    DIP_UPTREND_BPS / DIP_DOWNTREND_BPS take over. */
const DIP_BPS = 110;
/** Dip when the SMA-120 slope over SLOPE_SPAN bars is >= 0 (flat/rising). */
const DIP_UPTREND_BPS = 80;
/** Dip when the SMA-120 slope over SLOPE_SPAN bars is < 0 (falling). */
const DIP_DOWNTREND_BPS = 130;
/** Sharp-drop trigger: 60-bar return below this (bps) also triggers an entry. */
const DROP60_BPS = 170;
/** Entry only while RSI-14 is at or below this (dip-trigger entries). */
const RSI_MAX = 55;
/** Stricter RSI cap for drop-trigger-only entries: the sharp-drop trigger
    fires mid-plunge, so it must also show a cold RSI (the fall has paused),
    not just "not overbought". Dip-trigger entries keep RSI_MAX. */
const RSI_DROP_MAX = 45;
/** No entry while ATR-14 is below this (bps of price): dead chop. */
const ATR_MIN_BPS = 2;
/** Full size when ATR-14 is at or above this (bps); half size below it. */
const ATR_FULL_BPS = 4;
/** Exit: close at or above entry close by this (bps). */
const TARGET_BPS = 110;
/** Exit: close at or above SMA-120 by this (bps). */
const RECOVER_BPS = 120;
/** Exit: close below the highest close since entry by this (bps). */
const TRAIL_BPS = 120;
/** Exit: close below the entry close by this (bps). */
const HARD_STOP_BPS = 200;
/** Bars to wait after an exit before a new entry is allowed. */
const COOLDOWN_BARS = 30;
/** Slippage cap on every order, 3% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 300;
const RSI_SPAN = 14;
const ATR_SPAN = 14;

/** Closes, highs and lows seen so far (price_scale 5, exact in float64). */
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
/** RSI-14 (Wilder): first averages over the first RSI_SPAN changes. */
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
let rsiFirst: number[] = [];
let prevClose: number | null = null;
/** ATR-14: running sum of the last ATR_SPAN true ranges. */
const trs: number[] = [];
let trSum = 0;
/** Entry close and highest close since entry, while a position is held. */
let entry = 0;
let high = 0;
/** Bar index of the last exit; re-entry is blocked for COOLDOWN_BARS after it. */
let lastExitBar = -1000;

function smaAt(end: number, span: number): number | null {
  if (end < span - 1) return null;
  let s = 0;
  for (let i = end - span + 1; i <= end; i++) s += closes[i];
  return s / span;
}

function rsi(): number | null {
  if (rsiGain === null || rsiLoss === null) return null;
  const moved = rsiGain + rsiLoss;
  return moved === 0 ? 50 : (100 * rsiGain) / moved;
}

function atrBps(close: number): number | null {
  if (trs.length < ATR_SPAN) return null;
  return ((trSum / ATR_SPAN) / close) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(bar.c);
      const h = Number(bar.h);
      const l = Number(bar.l);
      closes.push(c);
      highs.push(h);
      lows.push(l);
      if (prevClose !== null) {
        const change = c - prevClose;
        const up = change > 0 ? change : 0;
        const down = change < 0 ? -change : 0;
        if (rsiGain === null || rsiLoss === null) {
          rsiFirst.push(change);
          if (rsiFirst.length === RSI_SPAN) {
            rsiGain = rsiFirst.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_SPAN;
            rsiLoss = rsiFirst.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_SPAN;
          }
        } else {
          rsiGain = (rsiGain * (RSI_SPAN - 1) + up) / RSI_SPAN;
          rsiLoss = (rsiLoss * (RSI_SPAN - 1) + down) / RSI_SPAN;
        }
        const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
        trs.push(tr);
        trSum += tr;
        if (trs.length > ATR_SPAN) trSum -= trs[trs.length - ATR_SPAN - 1];
      }
      prevClose = c;
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);
    const held = state.positions.get(SYMBOL);
    const n = closes.length - 1; // index of this bar's close

    if (held !== undefined) {
      if (c > high) high = c;
      const s = smaAt(n, SMA_SPAN);
      const target = c >= (entry * (10000 + TARGET_BPS)) / 10000;
      const recover = s !== null && c >= (s * (10000 + RECOVER_BPS)) / 10000;
      const trail = c < (high * (10000 - TRAIL_BPS)) / 10000;
      const stop = c < (entry * (10000 - HARD_STOP_BPS)) / 10000;
      if (target || recover || trail || stop) {
        lastExitBar = n;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- entry: layer 1 (regime) + layer 2 (momentum) + layer 3 (volatility)
    const s = smaAt(n, SMA_SPAN);
    let dipTrigger = false;
    if (s !== null) {
      let dip = DIP_BPS;
      const sOld = smaAt(n - SLOPE_SPAN, SMA_SPAN);
      if (sOld !== null) dip = s >= sOld ? DIP_UPTREND_BPS : DIP_DOWNTREND_BPS;
      dipTrigger = c < (s * (10000 - dip)) / 10000;
    }
    let dropTrigger = false;
    if (n >= SLOPE_SPAN) dropTrigger = (c / closes[n - SLOPE_SPAN] - 1) * 10000 < -DROP60_BPS;
    if (!dipTrigger && !dropTrigger) return [];
    if (n - lastExitBar < COOLDOWN_BARS) return [];
    const r = rsi();
    // A drop-trigger-only entry fires mid-plunge, so it needs a colder RSI
    // than a dip-trigger entry (whose deep dislocation already filters).
    const rsiCap = dropTrigger && !dipTrigger ? RSI_DROP_MAX : RSI_MAX;
    if (r !== null && r > rsiCap) return [];
    const atr = atrBps(c);
    if (atr !== null && atr < ATR_MIN_BPS) return [];
    // Volatility sizing: half size in quiet markets, full size when ATR is ample.
    const frac = atr !== null && atr < ATR_FULL_BPS ? 0.5 : 1;
    const room = state.weightRoom(SYMBOL);
    let amount = (state.cash * BigInt(Math.round(frac * 100))) / 100n;
    if (amount > room) amount = room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entry = c;
    high = c;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
