// Patient-burst sniper for the Pump.fun Bot Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`: the SDK shim speaks the NDJSON protocol
// on stdin/stdout and hands each batch to the strategy in strategy.ts, which
// decides the orders. The strategy is a pure function of the batches the
// harness sends — no clock, no randomness, no environment — so the two graded
// executions must produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
