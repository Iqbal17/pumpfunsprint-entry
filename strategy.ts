// Patient-burst sniper for the Pump.fun Bot Sprint (agent-fun/replay/v2).
//
// Design record — what was weighed and why this shape won:
//
// 1. Buy-everything-early (equal-weight baseline): buys each coin once it has
//    any real reserve and holds to the end. It always clears the 20-coin bar,
//    but most pump.fun coins bleed out, so holding every launch is a slow loss
//    on the median coin. Rejected as the main engine; its shape survives only
//    in the guardrail probes (buy a liquid coin, sell as soon as the buy lands).
//
// 2. Momentum with pyramiding (the house pilot and the two sibling entries I
//    read before writing this): buy on accelerating buy pressure, add into
//    strength behind a trailing stop. This is the engine I start from — a small
//    first buy, adds only into strength, a mature entry age, and a rolling
//    window signal instead of a cumulative tape. The two siblings graded
//    -0.006 SOL (68 round trips) and +0.0239 SOL on their dev window, but a
//    20-copy stress test of the first showed a median of -0.179 SOL: the dev
//    numbers are mostly luck, so I inherit the SHAPE, not the tuned cells, and
//    spend the design budget on robustness instead of squeezing a dev number.
//
// 3. Dip-buying / mean reversion: buys 30-45% drawdowns on strong curves.
//    It needs a run-up first and a dip second, so it trades late in a coin's
//    life and fights the dominant pump.fun direction, which is down after the
//    first minutes. Rejected: the edge is in the first minutes of a launch,
//    not in catching its falling knife.
//
// 4. This bot — patient-burst sniper. Three deliberate deltas from the
//    sibling shape, each a structural bet rather than a tuned threshold:
//    (a) TWO-BATCH CONFIRMATION: the entry signal must pass on two separate
//    batches (no more than 120 slots apart) before the first buy. A single
//    passing batch is often one whale's market buy, not a crowd; making the
//    crowd prove itself twice cuts the false starts that dominate the loss
//    column of every momentum bot on this tape. The cost is missing the
//    fastest verticals — accepted, because verticals are where the stop gets
//    run over anyway.
//    (b) SMALLER FIRST BUY, TWO ADDS: 0.04 SOL probe, then up to two 0.08 SOL
//    adds into strength (cap 0.20 SOL/coin). The siblings commit 0.05 + one
//    0.20 add; splitting the add means size follows a position that has
//    proven itself twice instead of once, and a false start that somehow
//    passes confirmation costs ~0.005 SOL all-in instead of ~0.0075.
//    (c) BANK EARLIER, CUT EARLIER: take-profit +20% (siblings +25%),
//    stop 10% (siblings 12%), trail 12% armed at +8% (siblings 15% at
//    +10%). On a tape where most +10% moves round-trip to zero, banking at
//    +20% instead of hoping for +25% keeps more winners, and the tighter
//    stop keeps the losers small enough that the two-batch filter's misses
//    still pay for themselves.
//    Everything else is kept conservative on purpose: one entry per coin ever,
//    max 5 positions, 45-slot rolling window (a little longer than the
//    siblings' 30, because confirmation already costs a batch — the window
//    should not also be thin), entry age 400-2400 slots (a touch earlier
//    than 500, since confirmation eats the first minutes), reserve band
//    3-40 SOL, hold cap 1200 slots, stale exit 450 slots, and a narrow fade
//    exit (underwater + net selling over the last 20 slots) that can only
//    fire on a losing position during active selling.
//
// Fee arithmetic (why the sizes are what they are): a round trip pays ~1.25%
// of size on the buy and ~1.25% on the sell, plus 105,000 lamports of
// transaction fees per order, so about 2.5% + 0.00021 SOL per round trip.
// The 0.04 SOL probe pays ~0.0012 SOL of fees — a false start stopped at
// -10% costs ~0.005 SOL all-in. At the full 0.20 SOL stake a round trip
// costs ~0.005 SOL, a fifth of the 10% stop — the stop still means
// something. At the 0.01 SOL minimum buy the fixed fees alone are ~2% of
// size, which is why 0.01 SOL is the floor and never the target. The
// per-reply buy cap (1% of a curve's real SOL reserve) binds before the
// target on young curves, so small buys on small curves are the norm and the
// size grows with the curve's own traction.
//
// Drawdown: at most 5 positions, each at most 0.20 SOL, so at most 1.0 SOL
// (10% of capital) is ever at risk at once, and in practice most of it sits
// in 0.04 SOL probes until a position proves itself twice. The 10% stop caps
// the loss per full position near 0.02 SOL plus fees. Even five straight
// stopped-out full positions cost ~12% of capital. The 50% drawdown
// guardrail is nowhere near binding.
//
// Determinism: every decision is a pure function of the batches the harness
// sends. Iteration is over insertion-ordered maps fed by the batch stream,
// with held mints visited in sorted order. No clock, no randomness, no
// environment, no I/O. The pacer reads block_time, which is part of the
// replay data itself, not the wall clock.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Rolling entry window in slots: the signal reads only trades inside it. */
  window: number;
  /** Buy trades inside the window before entry. */
  minBuys: number;
  /** Distinct non-creator buyers inside the window. */
  minBuyers: number;
  /** Creator's own buys since creation, at most (SOL): a dev-heavy launch is skipped. */
  maxDevBuySol: number;
  /** Net SOL bought (buys minus sells) inside the window, at least. */
  minNetSol: number;
  /** Price now over the price at the window start, minus 1: entry band (skip dead launches and verticals). */
  minPriceUp: number;
  maxPriceUp: number;
  /** Net inflow in the newer half of the window must be at least this multiple of the older half's (acceleration). */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single non-creator buyer's share of the window's buy SOL, at most. */
  maxBuyerShare: number;
  /** Real SOL reserve at decision time: entry band. */
  minRqSol: number;
  maxRqSol: number;
  /** First buy of a position (SOL): a probe — false starts must cost little. */
  initialSol: number;
  /** Each add-on buy (SOL), into strength only. */
  addSol: number;
  /** Most add-on buys after the first buy. */
  maxAdds: number;
  /** Total SOL to put into one position at most (initial + adds). */
  stakeSol: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open so exits execute. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Exit when the position's liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit the whole position once it is worth cost * (1 + takeProfit): bank winners. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...and exits on a fall of trailDrop from the best value seen. */
  trailDrop: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Fade exit: look back this many slots for net selling (0 disables it). */
  fadeWindow: number;
  /** ...and exit an underwater position when net SOL over that lookback is below this (negative = selling). */
  fadeNetSol: number;
  /** Confirmation: the two passing signal reads must be at most this many slots apart. */
  confirmGap: number;
  /** Most new entries per batch (keeps one wild batch from filling every slot). */
  maxEntriesPerBatch: number;
  /** Guardrail pacing: target distinct coins and fills by the end of the window. */
  targetCoins: number;
  targetFills: number;
  /** Window length in block-time seconds the pace is measured against (6 h). */
  paceSecs: number;
  /** Size of a guardrail probe round trip (SOL): above the 0.01 SOL bar, small enough to be cheap. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
  /** Real SOL reserve a probe candidate needs (so the 1% cap admits the probe size). */
  probeMinRqSol: number;
}

// Tuned for robustness on a fresh 6-hour window, not for a single dev cell:
// wide entry bands, two-batch confirmation, one buy per coin, exits that cut
// losers early and bank winners before they round-trip.
export const DEFAULT_PARAMS: Params = {
  minAge: 400,
  maxAge: 2400,
  window: 45,
  minBuys: 4,
  minBuyers: 6,
  maxDevBuySol: 2.0,
  minNetSol: 1.5,
  minPriceUp: 0.04,
  maxPriceUp: 0.45,
  accel: 1,
  nearHigh: 0.96,
  maxBuyerShare: 0.55,
  minRqSol: 3,
  maxRqSol: 40,
  initialSol: 0.04,
  addSol: 0.08,
  maxAdds: 2,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 1500,
  sellSlipBps: 10_000,
  stopLoss: 0.1,
  takeProfit: 0.2,
  trailArm: 0.08,
  trailDrop: 0.12,
  maxHoldSlots: 1200,
  staleSlots: 450,
  fadeWindow: 20,
  fadeNetSol: -1.5,
  confirmGap: 120,
  maxEntriesPerBatch: 2,
  targetCoins: 30,
  targetFills: 60,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 2,
  probeMinRqSol: 3,
};

const SOL = 1e9;
const FEE_BPS = 125n;
const BPS = 10_000n;

/** One recorded trade, kept on the coin's rolling tape. */
interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

/** The rolling tape of one coin, kept from its CreateEvent onward. */
interface Tape {
  createdSlot: number;
  creator: Pubkey;
  /** Trades inside the entry window (older ones are dropped as new ones come). */
  trades: Trade[];
  devBuySol: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** The most recent trade was a buy: entry requires the dip to be bought, not sold into. */
  lastIsBuy: boolean;
  /** Decided for good: bought, aged out, or filtered out. One entry per coin, ever. */
  done: boolean;
  /** The signal passed on an earlier batch and is waiting for its confirmation read. */
  armed: boolean;
  /** Slot of the batch where the signal last passed (confirmation must follow soon). */
  armedSlot: number;
}

interface Held {
  openedSlot: number;
  /** Best liquidation value seen (lamports); the trailing stop is measured from it. */
  peakLamports: bigint;
  /** True while the sell for this position is being decided (do not send a second). */
  exiting: boolean;
  /** Guardrail probe: sell as soon as the buy has landed. */
  probe: boolean;
  /** SOL sent in buys for this position (initial + adds, fees excluded). */
  investedSol: number;
  /** Add-on buys placed so far (at most maxAdds). */
  adds: number;
  /** Price (vq/vt) when the last buy was decided: adds need the price at or above it. */
  lastAddPrice: number;
}

/** Everything the entry signal needs, computed in one pass over the window. */
interface WindowStats {
  buys: number;
  buyers: number;
  buySol: number;
  sellSol: number;
  netOld: number;
  netNew: number;
  startPrice: number;
  high: number;
  topBuyerSol: number;
}

/**
 * What selling `tokens` against these reserves would pay after curve fees
 * (protocol + creator, 95 + 30 bps), capped at the curve's real SOL: you cannot
 * extract more SOL than the curve holds. The constant-product quote itself is the
 * market model the replay grades with, so this is the honest liquidation value.
 */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  return q > fee ? q - fee : 0n;
}

/** The per-reply buy cap, with a margin: the harness checks it against reserves
 *  shifted by our own earlier flow on the coin, which can sit a little below the
 *  recorded ones the SDK keeps. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe mints with a buy in flight or a position waiting to be sold. */
  const probes = new Set<Pubkey>();
  /** My own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Exit reasons counted, for the onDone summary (stderr only). */
  const exitCounts = new Map<string, number>();
  /** Confirmed entries placed, for the onDone summary. */
  let confirmedEntries = 0;

  // Exit thresholds as integer basis points, derived once from the params.
  const stopBps = Math.round((1 - p.stopLoss) * 10_000);
  const takeBps = Math.round((1 + p.takeProfit) * 10_000);
  const armBps = Math.round((1 + p.trailArm) * 10_000);
  const trailBps = Math.round((1 - p.trailDrop) * 10_000);

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: -1,
        creator: '',
        trades: [],
        devBuySol: 0,
        devSold: false,
        lastTradeSlot: -1,
        lastIsBuy: false,
        done: false,
        armed: false,
        armedSlot: -1,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** One pass over the tape's trades inside the entry window: flow, buyers,
   *  acceleration halves, window-start price, and window high. */
  const windowStats = (t: Tape, now: number): WindowStats => {
    const from = now - p.window;
    const mid = now - p.window / 2;
    let startPrice = -1;
    let high = 0;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    const byUser = new Map<Pubkey, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        // The last trade at or before the window start anchors the run-up band.
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
    }
    let topBuyerSol = 0;
    for (const v of byUser.values()) if (v > topBuyerSol) topBuyerSol = v;
    return { buys, buyers: byUser.size, buySol, sellSol, netOld, netNew, startPrice, high, topBuyerSol };
  };

  /** The entry signal on a coin's rolling window at slot `now`: every filter must
   *  pass. A coin is judged on whether it is buying NOW — net inflow, several
   *  distinct buyers, price up a little and sitting near its window high,
   *  inflow accelerating into the newer half of the window — not on what its
   *  tape looked like at birth. This is only the SIGNAL: the caller also
   *  requires the two-batch confirmation before any buy is placed. */
  const signalOk = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.createdSlot < 0) return false;
    const age = now - t.createdSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.devBuySol > p.maxDevBuySol) return false;
    if (t.devSold) return false;
    if (!t.lastIsBuy) return false;
    const s = windowStats(t, now);
    if (s.buys < p.minBuys || s.buyers < p.minBuyers) return false;
    if (s.buySol - s.sellSol < p.minNetSol) return false;
    if (s.startPrice <= 0) return false;
    const up = price / s.startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (s.high > 0 && price < s.high * p.nearHigh) return false;
    if (s.netNew <= 0 || s.netNew < p.accel * s.netOld) return false;
    if (s.buySol > 0 && s.topBuyerSol > p.maxBuyerShare * s.buySol) return false;
    return true;
  };

  /** Liquidation value of a held position in lamports: sell proceeds at the latest
   *  marked reserves, less one transaction fee. Zero when the curve is gone. */
  const positionValue = (state: BotState, marks: Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>, mint: Pubkey, tokens: bigint): bigint => {
    const m = marks.get(mint);
    const curve = state.curves.get(mint);
    const vq = m !== undefined ? m.vq : (curve?.virtual_quote_reserves ?? 0n);
    const vt = m !== undefined ? m.vt : (curve?.virtual_token_reserves ?? 0n);
    const rq = m !== undefined ? m.rq : (curve?.real_quote_reserves ?? 0n);
    const gross = sellProceeds(tokens, vq, vt, rq);
    const tx = state.txFeeLamports();
    return gross > tx ? gross - tx : 0n;
  };

  /** The exit decision for one held position: the reason to sell, or null to
   *  hold. Checked in order — probe, hard stop, take-profit, trailing stop,
   *  hold cap, stale, creator sell, fade — so the counted reason is the first
   *  rule that fired. The fade exit is deliberately last and narrow: it can
   *  only fire on a losing position while the tape is actively selling. */
  const exitReason = (
    state: BotState,
    marks: Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>,
    mint: Pubkey,
    pos: { token_amount: bigint; cost_lamports: bigint },
    h: Held,
    now: number,
    devSoldNow: Set<Pubkey>,
  ): string | null => {
    if (h.probe) return 'probe';
    const value = positionValue(state, marks, mint, pos.token_amount);
    const cost = pos.cost_lamports;
    if (cost <= 0n) return null;
    if (value > h.peakLamports) h.peakLamports = value;
    // Basis points of net liquidation value vs cost (10_000 = exactly at cost),
    // integer math so the exits never drift on floats. The same net value feeds
    // the peak, the trail, and the add check — one definition everywhere.
    const vb = (value * BPS) / cost;
    if (vb <= BigInt(stopBps)) return 'stop';
    if (vb >= BigInt(takeBps)) return 'take-profit';
    if (h.peakLamports > 0n) {
      const peakBps = (h.peakLamports * BPS) / cost;
      if (peakBps >= BigInt(armBps) && (value * BPS) / h.peakLamports < BigInt(trailBps)) return 'trail';
    }
    if (now - h.openedSlot > p.maxHoldSlots) return 'hold-cap';
    const t = tapes.get(mint);
    if (t !== undefined && t.lastTradeSlot >= 0 && now - t.lastTradeSlot > p.staleSlots) return 'stale';
    if (devSoldNow.has(mint)) return 'creator-sold';
    if (p.fadeWindow > 0 && t !== undefined && value < cost) {
      const from = now - p.fadeWindow;
      let netFade = 0;
      for (const tr of t.trades) {
        if (tr.slot <= from) continue;
        netFade += tr.buy ? tr.sol : -tr.sol;
      }
      if (netFade < p.fadeNetSol) return 'fade';
    }
    return null;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // --- Fold the batch: fills first, then events into the tapes. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) continue; // a harness close, not my order
        if (f.status === 'filled') {
          myFills++;
          myCoins.add(f.mint);
        } else if (f.side === 'buy' && !state.positions.has(f.mint)) {
          // The opening buy never filled: forget the position (the coin stays done —
          // one entry per coin — so a rejected buy costs nothing but the chance).
          let stillPending = false;
          for (const po of state.pending.values()) if (po.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            held.delete(f.mint);
            probes.delete(f.mint);
          }
        }
      }
      // Positions the harness closed (curve completed / window flattened) leave held.
      for (const mint of [...held.keys()]) {
        if (state.positions.has(mint)) continue;
        let stillPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint) stillPending = true;
        if (!stillPending) {
          held.delete(mint);
          probes.delete(mint);
        }
      }

      const touched: Pubkey[] = [];
      const touchedSet = new Set<Pubkey>();
      const devSoldNow = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / SOL;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          t.lastTradeSlot = e.slot;
          t.lastIsBuy = e.is_buy;
          if (e.is_buy && e.user === t.creator) {
            t.devBuySol += sol;
          } else if (!e.is_buy && e.user === t.creator) {
            t.devSold = true;
            if (held.has(e.mint)) devSoldNow.add(e.mint);
          }
        }
        if (!touchedSet.has(e.mint)) {
          touchedSet.add(e.mint);
          touched.push(e.mint);
        }
      }
      // Drop trades older than the entry window (plus a margin) from the touched
      // tapes: the signal reads the window only, and the tapes must not grow unbounded.
      for (const mint of touched) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - (p.window + 60)) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
          rq: BigInt(m.real_quote_reserves),
        });
      }
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);
      const orders: OrderInput[] = [];

      // --- 1. Exits, held mints in sorted order (deterministic). ---
      for (const mint of [...held.keys()].sort()) {
        if (orders.length >= cap) break;
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue; // buy still in flight; the sweep above handles the rest
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue; // harness closes it
        if (h.exiting || pendingMints.has(mint)) continue; // a sell is already in flight
        const reason = exitReason(state, marks, mint, pos, h, now, devSoldNow);
        if (reason === null) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        exitCounts.set(reason, (exitCounts.get(reason) ?? 0) + 1);
        h.exiting = true;
        pendingMints.add(mint);
      }

      // --- 2. Entries on coins that traded this batch, in event order. ---
      // A first buy needs TWO passing reads: the signal must have passed on an
      // earlier batch no more than confirmGap slots ago, and pass again now.
      // A single passing batch only arms the coin; a failing read disarms it.
      // An add follows only into strength (signal still holds, price at or above
      // the last buy's, position up, adds left) up to the stake cap.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let entries = 0;
      for (const mint of touched) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (pendingMints.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.createdSlot >= 0 && now - t.createdSlot > p.maxAge) t.done = true;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / SOL;
        const h = held.get(mint);
        if (h !== undefined) {
          // Add into strength only: not exiting, adds left, room under the stake,
          // signal alive, price stepped up from the last buy, position in profit.
          if (h.exiting || h.probe) continue;
          if (h.adds >= p.maxAdds) continue;
          if (h.investedSol >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (!signalOk(t, now, rqSol, price)) continue;
          const value = positionValue(state, marks, mint, pos.token_amount);
          if (value < pos.cost_lamports) continue;
          const limit = buyCap(state, mint);
          let amount = BigInt(Math.floor(p.addSol * SOL));
          const room = BigInt(Math.floor((p.stakeSol - h.investedSol) * SOL));
          if (amount > room) amount = room;
          if (amount > limit) amount = limit;
          if (amount < BigInt(Math.floor(p.minBuySol * SOL))) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          h.investedSol += Number(amount) / SOL;
          h.adds++;
          h.lastAddPrice = price;
          free -= amount + tx;
          entries++;
          pendingMints.add(mint);
          continue;
        }
        if (slotsLeft <= 0) break;
        if (t.done) continue;
        if (!signalOk(t, now, rqSol, price)) {
          t.armed = false; // a failing read disarms the coin: confirmation must be fresh
          continue;
        }
        if (!t.armed || now - t.armedSlot > p.confirmGap) {
          // First passing read: arm and wait for the confirmation batch.
          t.armed = true;
          t.armedSlot = now;
          continue;
        }
        // Second passing read inside the gap: the crowd proved itself twice — buy.
        const limit = buyCap(state, mint);
        let amount = BigInt(Math.floor(p.initialSol * SOL));
        if (amount > limit) amount = limit;
        if (amount < BigInt(Math.floor(p.minBuySol * SOL))) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        held.set(mint, { openedSlot: now, peakLamports: 0n, exiting: false, probe: false, investedSol: Number(amount) / SOL, adds: 0, lastAddPrice: price });
        t.done = true;
        t.armed = false;
        confirmedEntries++;
        free -= amount + tx;
        slotsLeft--;
        entries++;
        pendingMints.add(mint);
      }

      // --- 3. Guardrail pacing: probes when fills or coins lag the pace. ---
      // The bar is 20 coins with >= 0.01 SOL round trips; pace toward 30 coins /
      // 60 fills over the 6-hour window so a quiet stretch of entries never
      // strands the run.
      if (probes.size < p.maxProbes && slotsLeft > 0 && orders.length < cap && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const probeLamports = BigInt(Math.floor(p.probeSol * SOL));
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of touched) {
            if (held.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const tape = tapes.get(mint);
            if (tape !== undefined && tape.devSold) continue; // creator already dumped it
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rqSol = Number(curve.real_quote_reserves) / SOL;
            if (rqSol < p.probeMinRqSol) continue;
            if (rqSol > bestRq) {
              bestRq = rqSol;
              best = mint;
            }
          }
          if (best !== null && free >= probeLamports + tx && buyCap(state, best) >= probeLamports) {
            orders.push({ side: 'buy', mint: best, quote_lamports: probeLamports, max_slippage_bps: p.buySlipBps });
            held.set(best, { openedSlot: now, peakLamports: 0n, exiting: false, probe: true, investedSol: p.probeSol, adds: 0, lastAddPrice: 0 });
            probes.add(best);
            const bt = tapes.get(best);
            if (bt !== undefined) bt.done = true;
            free -= probeLamports + tx;
          }
        }
      }
      return orders;
    },

    onDone(state: BotState): void {
      const exits = [...exitCounts.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ');
      console.error(
        `[patient-burst] done: batches=${state.seq + 1} fills=${myFills} coins=${myCoins.size} confirmed=${confirmedEntries} cash=${state.cash} open=${state.positions.size} exits: ${exits}`,
      );
    },
  };
}
