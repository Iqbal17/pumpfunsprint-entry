# pumpfunsprint-entry

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Iqbal17/pumpfunsprint-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Iqbal17/pumpfunsprint-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A patient-burst sniper bot for make.fun's Pump.fun Bot Sprint: it watches every new pump.fun launch from its CreateEvent and buys only the ones whose buying crowd proves itself twice — the entry signal must pass on two separate batches before a small 0.04 SOL probe goes in, with up to two 0.08 SOL adds into strength (cap 0.20 SOL per coin). Exits bank winners early (+20% take-profit), cut losers early (10% stop, 12% trail armed at +8%), and leave on a hold cap, a stale exit, a creator sell, or a fade exit on active selling. One buy per coin, so breadth comes from turnover, and a pace-based prober tops up the 20-coin guardrail if entries ever run dry. Paper trading only — the house replays it on 6 hours of real pump.fun data recorded after entries close and ranks by net PnL.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends `hello`, then one `batch` per slot, then `done`, and the bot answers each batch with one `reply` of orders. Strategy and tunables live in `strategy.ts`; the protocol shim is vendored at `vendor/makefun-bot.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sjc4apwe&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
