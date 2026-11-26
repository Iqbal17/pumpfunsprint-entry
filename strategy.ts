// Steady-surge sniper for the Pump.fun Bot Sprint (agent-fun/replay/v2).
//
// Why this bot trades the way it does — the reasoning, in my own words:
//
// The tape is mostly noise with a few short-lived crowds. A coin that is
// genuinely catching on shows the same shape over and over: several different
// wallets buying within a few dozen slots, the buys getting bigger toward the
// end of the window, and the price drifting up toward the top of its recent
// range without going vertical. A single whale buying once can fake every one
// of those readings for one batch, so I never buy on one reading alone — I
// wait for the same coin to look good twice, on two different batches close
// together. That is the whole idea: two independent sightings of the same
// crowd before any money goes in.
//
// What I ruled out before settling on this:
// - Buying every launch that has any liquidity and holding it. It clears the
//   coin-count bar trivially, but the median pump.fun coin only goes down, so
//   the portfolio bleeds slowly on every coin at once. I keep that shape only
//   as the guardrail filler: tiny probe buys that round-trip immediately.
// - Buying the dip. A 30-45% pullback on a strong curve looks tempting, but
//   by the time the dip exists the coin is usually hours into its life and
//   the dominant direction from there is down. The edge, such as it is, lives
//   in the first minutes after launch, not in catching a falling knife.
// - Pyramiding hard into strength behind a wide trailing stop. Adding big
//   into a run feels right until the run reverses through the stop, and on
//   this tape runs reverse more often than they extend. I add, but only
//   twice, only small, and only while the position is already in profit.
//
// Sizing, from the fee arithmetic up: one round trip costs about 1.25% of
// size on each leg plus 105,000 lamports of fixed fees per order, so roughly
// 2.5% + 0.00021 SOL. The opening probe is 0.04 SOL: a false start stopped
// at -10% costs about 0.005 SOL all-in, cheap enough to be wrong often. The
// two adds are 0.08 SOL each, capped at 0.20 SOL per coin, so a full position
// stopped out costs near 0.02 SOL plus fees. With at most five positions open
// the most capital ever at risk is 1.0 SOL, a tenth of the stack, and the
// 50% drawdown guardrail is nowhere near binding. The 0.01 SOL floor is the
// smallest buy worth paying the fixed fees for — at that size the fixed fees
// alone are ~2% — so it is a floor, never a target. The per-reply buy cap
// (1% of a curve's real SOL reserve) binds first on young curves, which is
// why small buys on small curves are the norm.
//
// Exits, in the order they are checked: probe round-trips sell at once; the
// hard stop at -10% and the take-profit at +20% bracket the position; a
// trailing stop arms at +8% and fires on a 12% fall from the best value seen;
// then a 1200-slot hold cap, a 450-slot silence rule, a creator-sell rule,
// and finally a narrow fade rule that can only fire on a losing position
// while the tape is actively selling over the last 20 slots. Banking at
// +20% instead of hoping for more keeps winners that would otherwise
// round-trip to zero, and the tight stop keeps the losers small enough that
// the misses from the two-sighting filter still pay for themselves.
//
// Entry window: 45 slots, because confirmation already costs a batch — the
// window should not also be thin. Entry age 400-2400 slots, reserve band
// 3-40 SOL, at least 4 buys from at least 6 distinct non-creator buyers, at
// least 1.5 SOL net inflow, price up 4-45% over the window and within 4% of
// the window high, inflow accelerating into the newer half, no single buyer
// above 55% of window buy volume, dev buys at most 2 SOL, dev never sold,
// and the last trade a buy. One entry per coin ever; at most two fresh entries
// per batch so one wild batch cannot fill every slot.
//
// Determinism: every decision is a pure function of the batches the harness
// sends. Maps are iterated in insertion order, held positions are visited in
// sorted order, and the pacer reads block_time, which is part of the replay
// data itself. No clock, no randomness, no environment, no I/O.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum coin age, in slots since its CreateEvent, before a buy is allowed. */
  minAge: number;
  /** Maximum coin age for deciding a first buy. */
  maxAge: number;
  /** Length of the rolling entry window, in slots; only trades inside it feed the signal. */
  window: number;
  /** How many buy trades the window must hold before entry. */
  minBuys: number;
  /** How many distinct non-creator buyers the window must hold. */
  minBuyers: number;
  /** Ceiling on the creator's own buys since creation, in SOL — a dev-heavy launch is skipped. */
  maxDevBuySol: number;
  /** Floor on net SOL bought inside the window (buys minus sells). */
  minNetSol: number;
  /** Entry band on the run-up: current price over the window-open price, minus 1. Too flat or too vertical both skip. */
  minPriceUp: number;
  maxPriceUp: number;
  /** Acceleration: net inflow in the newer half of the window must be at least this many times the older half's. */
  accel: number;
  /** Current price must be at least this fraction of the window's peak. */
  nearHigh: number;
  /** Ceiling on one non-creator buyer's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Entry band on real SOL reserve at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Size of the first buy of a position, in SOL — a probe, so a false start stays cheap. */
  initialSol: number;
  /** Size of each add-on buy, in SOL, placed only into strength. */
  addSol: number;
  /** Cap on add-on buys after the first buy. */
  maxAdds: number;
  /** Cap on total SOL in one position (first buy + adds). */
  stakeSol: number;
  /** Floor on a single buy: below this the transaction fee is not worth paying. */
  minBuySol: number;
  /** Buy slippage allowance, in bps; sells always go out with the widest slippage so exits execute. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Hard stop: exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Take-profit: exit the whole position once it is worth cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...and fires on a fall of trailDrop from the best value seen. */
  trailDrop: number;
  /** Maximum hold, in slots — exit after this long regardless. */
  maxHoldSlots: number;
  /** Silence rule: exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Fade exit lookback, in slots (0 turns it off). */
  fadeWindow: number;
  /** ...exit an underwater position when net SOL over that lookback drops below this (negative means selling). */
  fadeNetSol: number;
  /** Confirmation: the two passing signal reads must sit at most this many slots apart. */
  confirmGap: number;
  /** Cap on fresh entries per batch, so one wild batch cannot fill every slot. */
  maxEntriesPerBatch: number;
  /** Guardrail pacing targets: distinct coins and fills to reach by the end of the window. */
  targetCoins: number;
  targetFills: number;
  /** Length of the window, in block-time seconds, that the pace is measured against (6 h). */
  paceSecs: number;
  /** Size of one guardrail probe round trip, in SOL — above the 0.01 SOL bar, small enough to be cheap. */
  probeSol: number;
  /** Cap on probe round trips open at once. */
  maxProbes: number;
  /** Minimum real SOL reserve a probe candidate needs, so the 1% cap admits the probe size. */
  probeMinRqSol: number;
}

// Wide entry bands, two-sighting confirmation, one buy per coin, exits that
// cut losers early and bank winners before they round-trip. Tuned for
// robustness on a fresh 6-hour window, not for a single dev cell.
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

const LAMPORTS_PER_SOL = 1e9;
const CURVE_FEE_BPS = 125n;
const BPS_DENOM = 10_000n;

/** One trade kept on a coin's rolling tape. */
interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  trader: Pubkey;
  price: number;
}

/** Everything remembered about one coin, from its CreateEvent onward. */
interface CoinBook {
  birthSlot: number;
  maker: Pubkey;
  /** Trades inside the entry window; older ones are trimmed as new ones arrive. */
  ticks: Tick[];
  makerBuySol: number;
  makerDumped: boolean;
  latestTradeSlot: number;
  /** The most recent trade was a buy: entry needs the dip bought, not sold into. */
  latestIsBuy: boolean;
  /** Settled for good: bought, aged out, or filtered out. One entry per coin, ever. */
  settled: boolean;
  /** The signal passed on an earlier batch and awaits its confirmation read. */
  sighted: boolean;
  /** Slot of the batch where the signal last passed (confirmation must follow soon). */
  sightedSlot: number;
}

interface OpenPos {
  entrySlot: number;
  /** Best liquidation value seen (lamports); the trailing stop measures from it. */
  bestLamports: bigint;
  /** True while the sell for this position is being decided (do not send a second). */
  selling: boolean;
  /** Guardrail probe: sell as soon as the buy has landed. */
  pacer: boolean;
  /** SOL sent in buys for this position (initial + adds, fees excluded). */
  committedSol: number;
  /** Add-on buys placed so far (at most maxAdds). */
  topUps: number;
  /** Price (vq/vt) when the last buy was decided: adds need the price at or above it. */
  lastBuyPrice: number;
}

/** Everything the entry signal needs, read in one pass over the window. */
interface WindowRead {
  buyCount: number;
  buyerCount: number;
  buysSol: number;
  sellsSol: number;
  flowOld: number;
  flowNew: number;
  openPrice: number;
  peak: number;
  biggestBuyerSol: number;
}

type MarkRow = { vq: bigint; vt: bigint; rq: bigint };

/**
 * What selling `tokens` against these reserves would pay after curve fees
 * (protocol + creator, 95 + 30 bps), capped at the curve's real SOL: you
 * cannot extract more SOL than the curve holds. The constant-product quote
 * itself is the market model the replay grades with, so this is the honest
 * liquidation value.
 */
function quoteSell(tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  let out = (tokens * vq) / (vt + tokens);
  if (out > rq) out = rq;
  const fee = (out * CURVE_FEE_BPS + BPS_DENOM - 1n) / BPS_DENOM;
  return out > fee ? out - fee : 0n;
}

/** The per-reply buy cap, with a margin: the harness checks it against
 *  reserves shifted by our own earlier flow on the coin, which can sit a
 *  little below the recorded ones the SDK keeps. */
function buyCeiling(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenPos>();
  /** Pacer mints with a buy in flight or a position waiting to be sold. */
  const pacers = new Set<Pubkey>();
  /** My own filled orders and the coins they were on (harness closes excluded). */
  let fillCount = 0;
  const filledCoins = new Set<Pubkey>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  /** Exit reasons counted, for the onDone summary (stderr only). */
  const exitTally = new Map<string, number>();
  /** Confirmed entries placed, for the onDone summary. */
  let confirmedBuys = 0;

  // Exit thresholds as integer basis points, derived once from the params.
  const stopBp = Math.round((1 - p.stopLoss) * 10_000);
  const takeBp = Math.round((1 + p.takeProfit) * 10_000);
  const armBp = Math.round((1 + p.trailArm) * 10_000);
  const trailBp = Math.round((1 - p.trailDrop) * 10_000);
  // The same four thresholds as bigints, so the per-position exit check does
  // not rebuild them on every batch (128k events in the dev window).
  const stopBpBig = BigInt(stopBp);
  const takeBpBig = BigInt(takeBp);
  const armBpBig = BigInt(armBp);
  const trailBpBig = BigInt(trailBp);
  // Fixed lamport sizes, floored once: the minimum buy, the probe, the first
  // buy and one add. Recomputing the floor on every order is identical
  // arithmetic, just wasted work.
  const minBuyLamports = BigInt(Math.floor(p.minBuySol * LAMPORTS_PER_SOL));
  const initialLamports = BigInt(Math.floor(p.initialSol * LAMPORTS_PER_SOL));
  const addLamports = BigInt(Math.floor(p.addSol * LAMPORTS_PER_SOL));
  const probeLamports = BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL));

  const bookFor = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        birthSlot: -1,
        maker: '',
        ticks: [],
        makerBuySol: 0,
        makerDumped: false,
        latestTradeSlot: -1,
        latestIsBuy: false,
        settled: false,
        sighted: false,
        sightedSlot: -1,
      };
      books.set(mint, b);
    }
    return b;
  };

  /** One pass over the book's ticks inside the entry window: flow, buyers,
   *  acceleration halves, window-open price, and window peak. */
  const readWindow = (b: CoinBook, now: number): WindowRead => {
    const edge = now - p.window;
    const half = now - p.window / 2;
    let openPrice = -1;
    let peak = 0;
    let buysSol = 0;
    let sellsSol = 0;
    let buyCount = 0;
    let flowOld = 0;
    let flowNew = 0;
    const perTrader = new Map<Pubkey, number>();
    for (const tick of b.ticks) {
      if (tick.slot <= edge) {
        // The last trade at or before the window edge anchors the run-up band.
        openPrice = tick.price;
        continue;
      }
      if (openPrice < 0) openPrice = tick.price;
      const signed = tick.isBuy ? tick.sol : -tick.sol;
      if (tick.slot <= half) flowOld += signed;
      else flowNew += signed;
      if (tick.isBuy) {
        buysSol += tick.sol;
        buyCount++;
        perTrader.set(tick.trader, (perTrader.get(tick.trader) ?? 0) + tick.sol);
      } else {
        sellsSol += tick.sol;
      }
      if (tick.price > peak) peak = tick.price;
    }
    let biggestBuyerSol = 0;
    for (const v of perTrader.values()) if (v > biggestBuyerSol) biggestBuyerSol = v;
    return { buyCount, buyerCount: perTrader.size, buysSol, sellsSol, flowOld, flowNew, openPrice, peak, biggestBuyerSol };
  };

  /** The entry signal on a coin's rolling window at slot `now`: every filter
   *  must pass. A coin is judged on whether it is buying NOW — net inflow,
   *  several distinct buyers, price up a little and sitting near its window
   *  peak, inflow accelerating into the newer half of the window — not on
   *  what its tape looked like at birth. This is only the SIGNAL: the caller
   *  also requires the two-sighting confirmation before any buy is placed. */
  const windowPasses = (b: CoinBook, now: number, rqSol: number, price: number): boolean => {
    if (b.birthSlot < 0) return false;
    const age = now - b.birthSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (b.makerBuySol > p.maxDevBuySol) return false;
    if (b.makerDumped) return false;
    if (!b.latestIsBuy) return false;
    const w = readWindow(b, now);
    if (w.buyCount < p.minBuys || w.buyerCount < p.minBuyers) return false;
    if (w.buysSol - w.sellsSol < p.minNetSol) return false;
    if (w.openPrice <= 0) return false;
    const rise = price / w.openPrice - 1;
    if (rise < p.minPriceUp || rise > p.maxPriceUp) return false;
    if (w.peak > 0 && price < w.peak * p.nearHigh) return false;
    if (w.flowNew <= 0 || w.flowNew < p.accel * w.flowOld) return false;
    if (w.buysSol > 0 && w.biggestBuyerSol > p.maxBuyerShare * w.buysSol) return false;
    return true;
  };

  /** Liquidation value of an open position in lamports: sell proceeds at the
   *  latest marked reserves, less one transaction fee. Zero when the curve
   *  is gone. */
  const liquidValue = (state: BotState, marks: Map<Pubkey, MarkRow>, mint: Pubkey, tokens: bigint): bigint => {
    const row = marks.get(mint);
    const curve = state.curves.get(mint);
    const vq = row !== undefined ? row.vq : (curve?.virtual_quote_reserves ?? 0n);
    const vt = row !== undefined ? row.vt : (curve?.virtual_token_reserves ?? 0n);
    const rq = row !== undefined ? row.rq : (curve?.real_quote_reserves ?? 0n);
    const gross = quoteSell(tokens, vq, vt, rq);
    const tx = state.txFeeLamports();
    return gross > tx ? gross - tx : 0n;
  };

  /** The exit decision for one open position: the reason to sell, or null to
   *  hold. Checked in order — pacer, hard stop, take-profit, trailing stop,
   *  hold cap, stale, creator sell, fade — so the counted reason is the first
   *  rule that fired. The fade exit is deliberately last and narrow: it can
   *  only fire on a losing position while the tape is actively selling. */
  const exitWhy = (
    state: BotState,
    marks: Map<Pubkey, MarkRow>,
    mint: Pubkey,
    pos: { token_amount: bigint; cost_lamports: bigint },
    o: OpenPos,
    now: number,
    dumpedNow: Set<Pubkey>,
  ): string | null => {
    if (o.pacer) return 'probe';
    const value = liquidValue(state, marks, mint, pos.token_amount);
    const cost = pos.cost_lamports;
    if (cost <= 0n) return null;
    if (value > o.bestLamports) o.bestLamports = value;
    // Basis points of net liquidation value vs cost (10_000 = exactly at
    // cost), integer math so the exits never drift on floats. The same net
    // value feeds the peak, the trail, and the add check — one definition
    // everywhere.
    const vb = (value * BPS_DENOM) / cost;
    if (vb <= stopBpBig) return 'stop';
    if (vb >= takeBpBig) return 'take-profit';
    if (o.bestLamports > 0n) {
      const peakBp = (o.bestLamports * BPS_DENOM) / cost;
      if (peakBp >= armBpBig && (value * BPS_DENOM) / o.bestLamports < trailBpBig) return 'trail';
    }
    if (now - o.entrySlot > p.maxHoldSlots) return 'hold-cap';
    const b = books.get(mint);
    if (b !== undefined && b.latestTradeSlot >= 0 && now - b.latestTradeSlot > p.staleSlots) return 'stale';
    if (dumpedNow.has(mint)) return 'creator-sold';
    if (p.fadeWindow > 0 && b !== undefined && value < cost) {
      const edge = now - p.fadeWindow;
      let fadeFlow = 0;
      for (const tick of b.ticks) {
        if (tick.slot <= edge) continue;
        fadeFlow += tick.isBuy ? tick.sol : -tick.sol;
      }
      if (fadeFlow < p.fadeNetSol) return 'fade';
    }
    return null;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const pendingMints = new Set<Pubkey>();

      // --- Fold the batch: fills first, then events into the books. ---
      const settleFills = (): void => {
        for (const f of batch.fills) {
          if (f.client_id.startsWith('_')) continue; // a harness close, not my order
          if (f.status === 'filled') {
            fillCount++;
            filledCoins.add(f.mint);
          } else if (f.side === 'buy' && !state.positions.has(f.mint)) {
            // The opening buy never filled: forget the position (the coin
            // stays settled — one entry per coin — so a rejected buy costs
            // nothing but the chance).
            let stillPending = false;
            for (const po of state.pending.values()) if (po.order.mint === f.mint) stillPending = true;
            if (!stillPending) {
              open.delete(f.mint);
              pacers.delete(f.mint);
            }
          }
        }
        // Positions the harness closed (curve completed / window flattened)
        // leave the open map.
        for (const mint of [...open.keys()]) {
          if (state.positions.has(mint)) continue;
          let stillPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint) stillPending = true;
          if (!stillPending) {
            open.delete(mint);
            pacers.delete(mint);
          }
        }
      };

      const dumpedNow = new Set<Pubkey>();
      const seen: Pubkey[] = [];
      const absorbEvents = (): void => {
        const seenSet = new Set<Pubkey>();
        for (const e of batch.events) {
          if (e.block_time !== null) {
            if (windowStart === null) windowStart = e.block_time;
            if (windowEnd === null || e.block_time > windowEnd) windowEnd = e.block_time;
          }
          if (e.event === 'CreateEvent') {
            const b = bookFor(e.mint);
            b.birthSlot = e.slot;
            b.maker = e.creator;
          } else if (e.event === 'TradeEvent') {
            const b = bookFor(e.mint);
            const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
            const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
            b.ticks.push({ slot: e.slot, isBuy: e.is_buy, sol, trader: e.user, price });
            b.latestTradeSlot = e.slot;
            b.latestIsBuy = e.is_buy;
            if (e.is_buy && e.user === b.maker) {
              b.makerBuySol += sol;
            } else if (!e.is_buy && e.user === b.maker) {
              b.makerDumped = true;
              if (open.has(e.mint)) dumpedNow.add(e.mint);
            }
          }
          if (!seenSet.has(e.mint)) {
            seenSet.add(e.mint);
            seen.push(e.mint);
          }
        }
        // Drop ticks older than the entry window (plus a margin) from the
        // touched books: the signal reads the window only, and the books must
        // not grow unbounded.
        for (const mint of seen) {
          const b = books.get(mint);
          if (b === undefined) continue;
          let cut = 0;
          while (cut < b.ticks.length && b.ticks[cut]!.slot <= now - (p.window + 60)) cut++;
          if (cut > 0) b.ticks.splice(0, cut);
        }
      };

      settleFills();
      absorbEvents();

      const marks = new Map<Pubkey, MarkRow>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
          rq: BigInt(m.real_quote_reserves),
        });
      }
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      // --- 1. Exits, open mints in sorted order (deterministic). ---
      const placeExits = (): void => {
        for (const mint of [...open.keys()].sort()) {
          if (orders.length >= cap) break;
          const o = open.get(mint)!;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue; // buy still in flight; the sweep above handles the rest
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue; // harness closes it
          if (o.selling || pendingMints.has(mint)) continue; // a sell is already in flight
          const reason = exitWhy(state, marks, mint, pos, o, now, dumpedNow);
          if (reason === null) continue;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          exitTally.set(reason, (exitTally.get(reason) ?? 0) + 1);
          o.selling = true;
          pendingMints.add(mint);
        }
      };

      // --- 2. Entries on coins that traded this batch, in event order. ---
      // A first buy needs TWO passing reads: the signal must have passed on
      // an earlier batch no more than confirmGap slots ago, and pass again
      // now. A single passing batch only sights the coin; a failing read
      // unsights it. An add follows only into strength (signal still holds,
      // price at or above the last buy's, position up, adds left) up to the
      // stake cap.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let entries = 0;
      const placeEntries = (): void => {
        for (const mint of seen) {
          if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
          if (pendingMints.has(mint) || pacers.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const b = books.get(mint);
          if (b === undefined) continue;
          if (b.birthSlot >= 0 && now - b.birthSlot > p.maxAge) b.settled = true;
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          const o = open.get(mint);
          if (o !== undefined) {
            // Add into strength only: not selling, adds left, room under the
            // stake, signal alive, price stepped up from the last buy,
            // position in profit.
            if (o.selling || o.pacer) continue;
            if (o.topUps >= p.maxAdds) continue;
            if (o.committedSol >= p.stakeSol - p.minBuySol) continue;
            const pos = state.positions.get(mint);
            if (pos === undefined) continue;
            if (price < o.lastBuyPrice) continue;
            if (!windowPasses(b, now, rqSol, price)) continue;
            const value = liquidValue(state, marks, mint, pos.token_amount);
            if (value < pos.cost_lamports) continue;
            const limit = buyCeiling(state, mint);
            let amount = addLamports;
            const room = BigInt(Math.floor((p.stakeSol - o.committedSol) * LAMPORTS_PER_SOL));
            if (amount > room) amount = room;
            if (amount > limit) amount = limit;
            if (amount < minBuyLamports) continue;
            if (free < amount + tx) continue;
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
            o.committedSol += Number(amount) / LAMPORTS_PER_SOL;
            o.topUps++;
            o.lastBuyPrice = price;
            free -= amount + tx;
            entries++;
            pendingMints.add(mint);
            continue;
          }
          if (slotsLeft <= 0) break;
          if (b.settled) continue;
          if (!windowPasses(b, now, rqSol, price)) {
            b.sighted = false; // a failing read unsights the coin: confirmation must be fresh
            continue;
          }
          if (!b.sighted || now - b.sightedSlot > p.confirmGap) {
            // First passing read: sight it and wait for the confirmation batch.
            b.sighted = true;
            b.sightedSlot = now;
            continue;
          }
          // Second passing read inside the gap: the crowd proved itself twice — buy.
          const limit = buyCeiling(state, mint);
          let amount = initialLamports;
          if (amount > limit) amount = limit;
          if (amount < minBuyLamports) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          open.set(mint, { entrySlot: now, bestLamports: 0n, selling: false, pacer: false, committedSol: Number(amount) / LAMPORTS_PER_SOL, topUps: 0, lastBuyPrice: price });
          b.settled = true;
          b.sighted = false;
          confirmedBuys++;
          free -= amount + tx;
          slotsLeft--;
          entries++;
          pendingMints.add(mint);
        }
      };

      // --- 3. Guardrail pacing: probes when fills or coins lag the pace. ---
      // The bar is 20 coins with >= 0.01 SOL round trips; pace toward 30
      // coins / 60 fills over the 6-hour window so a quiet stretch of
      // entries never strands the run.
      const placePacer = (): void => {
        if (pacers.size >= p.maxProbes || slotsLeft <= 0 || orders.length >= cap) return;
        if (windowStart === null || windowEnd === null) return;
        const pace = Math.min(1, (windowEnd - windowStart) / p.paceSecs);
        const needCoins = filledCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = fillCount < Math.ceil(p.targetFills * pace);
        if (!needCoins && !needFills) return;
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of seen) {
          if (open.has(mint) || pendingMints.has(mint) || pacers.has(mint)) continue;
          if (filledCoins.has(mint)) continue;
          const book = books.get(mint);
          if (book !== undefined && book.makerDumped) continue; // creator already dumped it
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          if (rqSol < p.probeMinRqSol) continue;
          if (rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null && free >= probeLamports + tx && buyCeiling(state, best) >= probeLamports) {
          orders.push({ side: 'buy', mint: best, quote_lamports: probeLamports, max_slippage_bps: p.buySlipBps });
          open.set(best, { entrySlot: now, bestLamports: 0n, selling: false, pacer: true, committedSol: p.probeSol, topUps: 0, lastBuyPrice: 0 });
          pacers.add(best);
          const bt = books.get(best);
          if (bt !== undefined) bt.settled = true;
          free -= probeLamports + tx;
        }
      };

      placeExits();
      placeEntries();
      placePacer();
      return orders;
    },

    onDone(state: BotState): void {
      const exits = [...exitTally.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ');
      console.error(
        `[steady-surge] done: batches=${state.seq + 1} fills=${fillCount} coins=${filledCoins.size} confirmed=${confirmedBuys} cash=${state.cash} open=${state.positions.size} exits: ${exits}`,
      );
    },
  };
}
