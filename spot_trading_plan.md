# Spot Trading - Structured Plan

# 1. Product Scope

## Goal

Allow a user to create a crypto **spot trading strategy without writing code**.

Example:

> Buy BTC/USDT when RSI(14) on 15m crosses below 30 AND price crosses above EMA(20), use 20% of capital, take profit at 5%, stop loss at 2%, and stop trading after a daily loss of $100.
> 

The user creates this visually:

```
WHEN

RSI(14) [15m] < 30

AND

Close [15m] Crosses Above EMA(20) [15m]

THEN

BUY

Position Size:
20% of Capital

EXIT:
Take Profit = 5%
Stop Loss = 2%
```

The system converts this into an internal strategy representation.

---

# 2. High-Level Architecture

```
                    USER
                     │
                     ▼
             ┌─────────────────┐
             │  Strategy Builder│
             │       UI        │
             └────────┬────────┘
                      │
                      ▼
             Strategy JSON / DSL
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
   Validation Engine        Strategy Storage
          │
          ▼
   Strategy Execution Engine
          │
     ┌────┼────────┐
     │    │        │
     ▼    ▼        ▼
 Backtest Paper    Live
 Engine   Trading  Trading
                   │
                   ▼
                Exchange
```

---

# 3. Strategy Builder UI Structure

The builder should have these major sections:

```
1. Basic Configuration
2. Entry Conditions
3. Position Sizing
4. Exit Conditions
5. Stop Loss / Take Profit
6. Trailing Stop
7. Risk Management
8. Trading Schedule
9. Execution Settings
10. Review & Validation
11. Save / Backtest / Deploy
```

---

# 4. Basic Configuration

## 4.1 Strategy Name

```
Strategy Name

[ RSI EMA Momentum ]
```

Required.

---

## 4.2 Markets

Allow multiple trading pairs:

```
Markets

☑ BTC/USDT
☑ ETH/USDT
☐ SOL/USDT
☐ BNB/USDT
```

Backend should treat each market independently.

```
Strategy
 ├── BTC/USDT state
 ├── ETH/USDT state
 └── SOL/USDT state
```

But global risk limits can still apply across all markets.

---

## 4.3 Timeframes

Available:

```
1m
5m
15m
30m
1h
4h
1D
```

However, **timeframe should primarily belong to each condition/operand**, not only to the strategy.

Example:

```
RSI(14) [15m] < 30

AND

EMA(20) [1h] > EMA(50) [1h]
```

This gives you multi-timeframe capability later.

---

## 4.4 Chart Type

V1:

```
Candlestick
```

Future:

```
Heikin Ashi
Renko
Line Break
```

Don't implement these initially.

Important:

> Chart type should not determine your core indicator engine.
> 

The indicator engine should consume OHLCV data.

---

## 4.5 Timezone

Example:

```
Timezone

[ UTC ▼ ]
```

Use IANA timezone identifiers internally.

Example:

```
Asia/Kolkata
UTC
America/New_York
Europe/London
```

---

# 5. Trading Schedule

## Trading Days

```
Monday
Tuesday
Wednesday
Thursday
Friday
Saturday
Sunday
```

Crypto trades 24/7, so unlike stock markets, **days and sessions should be optional restrictions**, not assumptions.

Example:

```
☑ Monday
☑ Tuesday
☑ Wednesday
☑ Thursday
☑ Friday
☐ Saturday
☐ Sunday
```

---

# 6. Trading Sessions

Allow multiple non-overlapping sessions.

```
Session 1

Start: 09:00
End:   12:00
```

```
Session 2

Start: 14:00
End:   18:00
```

Validation:

```
Session 1 End <= Session 2 Start
```

No overlapping sessions.

---

# 7. Force Exit

Instead of calling this "Square Off":

```
Force Exit
```

Example:

```
Force Exit:
18:00
```

At that time:

```
Open positions
      ↓
SELL
      ↓
Position closed
```

This should be optional.

---

# 8. Entry Condition Builder

This is the **core component of the entire product**.

The basic structure:

```
LEFT OPERAND
      │
      ▼
COMPARATOR
      │
      ▼
RIGHT OPERAND
```

Example:

```
RSI(14) [15m]

      <

30
```

---

# 9. Operand System

Do not call everything an indicator.

Use:

```
Operand
├── Price
├── Indicator
└── Constant
```

---

## 9.1 Price

```
Price
├── Open
├── High
├── Low
└── Close
```

Later:

```
HL2
HLC3
OHLC4
```

---

# 10. Indicator System

### V1 indicators

Keep this small.

```
EMA
SMA
VWAP
RSI
MACD
MACD Signal
SuperTrend
```

Potentially:

```
Candle
```

but Candle should ideally be treated as price/candle data rather than a conventional indicator.

---

# 11. Constants

```
Constant

Number
```

Example:

```
RSI(14) < 30
```

Here:

```
RSI(14) = Indicator
30 = Constant
```

---

# 12. Indicator Configuration

Each indicator should have its own parameter schema.

---

## EMA

```
Indicator: EMA

Period: 20

Timeframe: 15m
```

---

## SMA

```
Indicator: SMA

Period: 50

Timeframe: 1h
```

---

## RSI

```
Indicator: RSI

Period: 14

Timeframe: 15m
```

---

## VWAP

```
Indicator: VWAP

Timeframe: 15m
```

Later:

```
VWAP
Upper Band
Lower Band
```

---

## MACD

```
Fast Period: 12
Slow Period: 26
Signal Period: 9

Timeframe: 15m
```

Expose:

```
MACD Line
Signal Line
Histogram
```

This means you don't need a completely separate MACD Signal indicator internally.

---

## SuperTrend

```
ATR Period: 10
Multiplier: 3

Timeframe: 15m
```

---

# 13. Comparators

V1:

```
Higher Than
>

Less Than
<

Greater Than or Equal
>=

Less Than or Equal
<=

Equal
=

Crosses Above

Crosses Below
```

Internally use enum values:

```
GREATER_THAN
LESS_THAN
GREATER_THAN_OR_EQUAL
LESS_THAN_OR_EQUAL
EQUAL
CROSSES_ABOVE
CROSSES_BELOW
```

---

# 14. Example Conditions

### RSI condition

```
RSI(14, 15m)
<
30
```

### Moving average condition

```
EMA(20, 15m)
>
EMA(50, 15m)
```

### Crossover

```
EMA(20, 15m)

CROSSES ABOVE

EMA(50, 15m)
```

### Price condition

```
Close(15m)
>
EMA(200, 15m)
```

# 15. Condition Groups

Don't implement AND/OR as a simple flat list.

Use a tree.

Example:

```
RSI < 30

AND

(
    EMA20 crosses above EMA50

    OR

    Close > EMA200
)
```

Structure:

```
GROUP
│
├── Condition A
│
└── AND
    │
    └── GROUP
        ├── Condition B
        ├── OR
        └── Condition C
```

This allows:

```
A AND B

A OR B

A AND (B OR C)

(A OR B) AND (C OR D)
```

This is critical for the architecture.

---

# 16. Long Entry

Spot V1 should primarily have:

```
LONG ENTRY
```

Because standard spot doesn't support native short positions.

Example:

```
ENTRY CONDITIONS

RSI(14) < 30

AND

Close crosses above EMA(20)

THEN

BUY
```

---

# 17. Entry Trigger Behavior

You need to define whether conditions trigger continuously.

For V1:

> **Trigger when the complete entry condition transitions from false → true.**
> 

Example:

```
Previous candle:

RSI < 30 = false

Current candle:

RSI < 30 = true

→ Entry signal
```

Don't repeatedly buy every candle while the condition remains true.

---

# 18. Position Sizing

V1:

```
Position Size
```

Options:

```
Fixed Quantity
Fixed USDT
Percentage of Capital
```

---

## Fixed Quantity

```
BTC Quantity = 0.01
```

---

## Fixed USDT

```
Investment = $500
```

---

## Percentage of Capital

```
Capital = $10,000

Position Size = 20%

→ $2,000
```

---

# 19. Future Position Sizing

V2:

```
Risk-Based Position Sizing
```

Example:

```
Risk per trade = 1%

Stop loss = 2%

Position size calculated automatically
```

Don't need this for V1.

---

# 20. Exit System

Exit should consist of:

```
Exit
├── Indicator Exit
├── Stop Loss
├── Take Profit
├── Trailing Stop
└── Force Exit
```

# 21. Indicator-Based Exit

Same condition builder as entry.

Example:

```
RSI(14)
>
70

→ SELL
```

Or:

```
EMA20

CROSSES BELOW

EMA50

→ SELL
```

---

# 22. Stop Loss

V1:

```
Stop Loss

Type:
    Percentage
    Points
```

Example:

```
Entry = $100

SL = 2%

Stop = $98
```

You should also validate minimum/maximum values based on exchange rules.

---

# 23. Take Profit

```
Take Profit

Type:
    Percentage
    Points
```

Example:

```
Entry = $100

TP = 5%

Exit = $105
```

---

# 24. Trailing Stop

Structure:

```
Trailing Stop

Activation:
    Immediately
    After X profit

Trail Type:
    Percentage
    Points

Trail Value:
    X
```

Example:

```
Entry = $100

Activation = $105

Trailing distance = 2%
```

Once activated, the stop follows the highest price.

---

# 25. Exit Priority

This needs to be explicitly defined in the engine.

A position could simultaneously satisfy:

```
Take Profit
Indicator Exit
Trailing Stop
```

You need deterministic behavior.

Recommended principle:

```
Every exit event is evaluated.

First executable exit event closes the position.

Once position is closed:
all other exit rules are cancelled.
```

This should be part of your engine specification.

---

# 26. Risk Management

Separate **position-level risk** from **strategy-level risk**.

---

## Strategy-Level Risk

### Maximum Open Positions

```
Maximum open positions = 3
```

---

### Maximum Capital Allocation

```
Maximum capital allocation = 50%
```

---

### Maximum Daily Loss

```
Maximum daily loss = $500
```

When reached:

```
Stop accepting new entries
```

You need to decide whether existing positions are closed immediately or only new entries are blocked. Make this explicit in the UI.

---

### Maximum Trades Per Day

```
Maximum trades/day = 10
```

---

### Cooldown

```
After trade closes:

Cooldown = 30 minutes
```

During cooldown:

```
No new entries
```

---

# 27. Overall Profit/Loss Controls

Optional:

```
Overall Profit Target
Overall Loss Limit
```

Example:

```
Strategy Profit Target = +$500

→ Stop strategy
```

```
Strategy Loss Limit = -$300

→ Stop strategy
```

Again, clearly distinguish:

```
Stop accepting new trades
```

from:

```
Close all existing positions
```

They are not the same operation.

---

# 28. Profit Protection

Keep this separate from normal trailing stop.

Options:

```
No Trailing

Lock Profit

Trail Profit

Lock + Trail
```

---

## Lock Profit

```
Activation:
+5%

Lock:
+2%
```

Meaning:

```
Profit reaches +5%
        ↓
minimum exit profit becomes +2%
```

---

## Trail Profit

```
Activation:
+5%

Trail distance:
2%
```

---

## Lock + Trail

```
Activation:
+5%

Initial locked profit:
+2%

Trailing distance:
2%
```

# 29. Execution Settings

You haven't included this enough in your original design.

You need:

```
Execution
├── Exchange
├── Order Type
├── Slippage
└── Fees
```

---

# 30. Exchange

Eventually:

```
Binance
Bybit
OKX
Coinbase
...
```

But don't hard-code exchange-specific behavior into the strategy engine.

Architecture:

```
Strategy Engine
      ↓
Broker/Exchange Adapter
      ↓
Binance / Bybit / OKX
```

This makes adding exchanges easier.

---

# 31. Order Type

For V1:

```
Market
Limit
```

You can initially launch with **Market orders only** if speed of development matters.

Limit orders introduce:

- unfilled orders
- partial fills
- cancellation
- timeout
- order state management

So they significantly increase execution complexity.

---

# 32. Slippage

Backtesting must support:

```
Slippage
```

Example:

```
Expected price = $100
Slippage = 0.1%

Actual simulated fill ≈ $100.10
```

Otherwise backtests can look artificially good.

---

# 33. Trading Fees

The strategy engine/backtester should account for:

```
Entry fee
Exit fee
```

Example:

```
Entry:
$1,000

Fee:
0.1%

Exit:
$1,100

Fee:
0.1%
```

The actual P&L should include those costs.

---

# 34. Strategy Validation

Before saving/deploying, run validation.

Examples:

```
❌ No entry condition

❌ No position sizing

❌ Take profit = 0

❌ Stop loss negative

❌ Trading sessions overlap

❌ Position size exceeds capital

❌ Market not supported by selected exchange

❌ Timeframe unsupported

❌ Indicator parameters invalid
```

Also warn about logical problems:

```
⚠ RSI < 30 AND RSI > 70
```

This is technically valid syntax but likely impossible.

Don't necessarily block it; provide a warning.

---

# 35. Strategy JSON / DSL

The UI should generate a canonical representation.

Example:

```
{
  "type":"spot_strategy",
  "version":1,
  "name":"RSI EMA Strategy",

  "markets": ["BTC/USDT","ETH/USDT"
  ],

  "entry": {
    "action":"BUY",

    "conditions": {
      "type":"group",
      "operator":"AND",
      "children": [
        {
          "type":"condition",
          "left": {
            "type":"indicator",
            "name":"RSI",
            "parameters": {
              "period":14
            },
            "timeframe":"15m"
          },
          "operator":"LESS_THAN",
          "right": {
            "type":"constant",
            "value":30
          }
        }
      ]
    }
  },

  "positionSizing": {
    "type":"PERCENT_CAPITAL",
    "value":20
  },

  "exit": {
    "takeProfit": {
      "type":"PERCENTAGE",
      "value":5
    },

    "stopLoss": {
      "type":"PERCENTAGE",
      "value":2
    }
  }
}
```

This JSON is **not the UI**.

It's the contract between:

```
Builder
Engine
Backtester
Paper Trader
Live Trader
```

---

# 36. Backend Architecture

I'd split the backend into these services/modules:

```
Backend
│
├── Strategy Service
│
├── Strategy Validation
│
├── Indicator Engine
│
├── Condition Engine
│
├── Signal Engine
│
├── Risk Engine
│
├── Position Manager
│
├── Order Manager
│
├── Market Data Service
│
├── Exchange Adapter
│
├── Backtesting Engine
│
├── Paper Trading Engine
│
└── Live Trading Engine
```

---

# 37. Market Data Engine

```
Exchange
   ↓
WebSocket
   ↓
Tick Data
   ↓
Candle Aggregator
   ↓
OHLCV
```

For example:

```
1m candles
 ↓
5m candles
 ↓
15m candles
 ↓
1h candles
```

You need reliable candle generation and synchronization.

---

# 38. Indicator Engine

```
OHLCV
 ↓
Indicator Engine
 ↓
EMA
SMA
RSI
VWAP
MACD
SuperTrend
```

Example:

```
BTC/USDT
15m candles

       ↓

RSI(14) = 27.3
EMA(20) = 106,200
EMA(50) = 105,800
```

The condition engine consumes these values.

---

# 39. Condition Engine

Input:

```
RSI(14) < 30
```

Indicator engine:

```
RSI = 27.3
```

Condition engine:

```
27.3 < 30
```

Result:

```
TRUE
```

For crossover:

```
Previous:
EMA20 = 100
EMA50 = 101

Current:
EMA20 = 102
EMA50 = 101

→ Crosses Above = TRUE
```

This means your engine must retain **previous indicator values**, not only current values.

# 40. Signal Engine

```
Condition Engine
       ↓
Entry Condition = TRUE
       ↓
Signal Engine
       ↓
BUY BTC/USDT
```

But before actually placing an order:

```
BUY signal
    ↓
Risk Engine
    ↓
Position Sizing
    ↓
Order Manager
```

---

# 41. Risk Engine

The risk engine should have final authority.

Example:

```
BUY BTC

        ↓

Max positions?
        ↓
YES

Capital available?
        ↓
YES

Daily loss limit?
        ↓
Not reached

Cooldown?
        ↓
No

        ↓

ALLOW TRADE
```

If any restriction fails:

```
REJECT TRADE
```

---

# 42. Position Manager

Track:

```
Position ID
Symbol
Side
Entry price
Quantity
Current price
Unrealized P&L
Realized P&L
Stop loss
Take profit
Trailing stop
Entry timestamp
Exit timestamp
```

For spot:

```
BTC position
ETH position
SOL position
```

---

# 43. Order Manager

Handle:

```
Create order
Track order
Filled
Partially filled
Cancelled
Rejected
Failed
```

This becomes especially important when you add limit orders.

---

# 44. Exchange Adapter

Never make strategy logic depend directly on Binance/Bybit APIs.

Use:

```
Exchange Interface
       │
 ┌─────┼─────┐
 ↓     ↓     ↓
Binance Bybit OKX
```

Example interface:

```
placeOrder()
cancelOrder()
getOrder()
getBalance()
getPosition()
getTicker()
subscribeMarketData()
```

---

# 45. Backtesting Engine

The same strategy JSON should be passed into:

```
Historical OHLCV
        ↓
Backtest Engine
        ↓
Strategy Engine
        ↓
Simulated Orders
        ↓
Portfolio
        ↓
Results
```

Don't create a separate "backtesting strategy language."

Use the same strategy.

---

# 46. Backtesting Results

Show:

```
Total Return
Net P&L
Win Rate
Loss Rate
Profit Factor
Maximum Drawdown
Sharpe Ratio
Number of Trades
Average Trade
Average Win
Average Loss
Largest Win
Largest Loss
Fees
Slippage
```

Also show:

```
Equity Curve
Drawdown Curve
Trade List
```

---

# 47. Paper Trading

Same strategy:

```
Strategy JSON
     ↓
Live Market Data
     ↓
Strategy Engine
     ↓
Paper Order
     ↓
Simulated Position
```

No real funds.

This is critical before live deployment.

---

# 48. Live Trading

```
Strategy
   ↓
Strategy Engine
   ↓
Risk Engine
   ↓
Order Manager
   ↓
Exchange Adapter
   ↓
Exchange
```

You should also implement **reconciliation**.

Example:

```
Your database:
BTC position = 0.1

Exchange:
BTC position = 0.08
```

System needs to detect that mismatch.

---

# 49. Strategy Lifecycle

A strategy should have states:

```
DRAFT
   ↓
VALIDATED
   ↓
BACKTESTED
   ↓
PAPER_TRADING
   ↓
ACTIVE
   ↓
PAUSED
   ↓
STOPPED
```

Don't allow arbitrary transitions.

---

# 50. Strategy Versioning

This will become important very quickly.

Example:

```
RSI Strategy v1
RSI Strategy v2
RSI Strategy v3
```

When a live strategy is modified:

```
Don't mutate the currently running strategy.

Create new version.
```

This allows you to reproduce exactly what happened during a trade.

---

# 51. Logging / Audit

Every decision should be explainable.

For example:

```
14:15:00

BTC/USDT

RSI = 28.3
EMA20 = 105,200
EMA50 = 104,900

Condition:
RSI < 30 → TRUE

Condition:
EMA20 > EMA50 → TRUE

Entry group:
AND → TRUE

Risk:
Allowed

Position:
20% capital

Signal:
BUY
```

This will be extremely valuable for debugging.

---

# 52. User Interface

I'd make the builder visually similar to a flow/block system.

Example:

```
┌──────────────────────────────────────┐
│ Entry Conditions                     │
│                                      │
│ [ RSI ] [14] [15m] [ < ] [30]       │
│                                      │
│              AND                     │
│                                      │
│ [ Close ] [15m] [Crosses Above]      │
│ [ EMA ] [20] [15m]                   │
│                                      │
│             [+ Add Condition]        │
└──────────────────────────────────────┘
```

Then:

```
┌──────────────────────────────────────┐
│ Position Sizing                      │
│                                      │
│ [ % of Capital ▼ ]                   │
│ [ 20 ] %                             │
└──────────────────────────────────────┘
```

Then:

```
┌──────────────────────────────────────┐
│ Exit                                 │
│                                      │
│ ☑ Stop Loss       2%                 │
│ ☑ Take Profit     5%                 │
│ ☐ Trailing Stop                      │
│ ☑ Indicator Exit                     │
└──────────────────────────────────────┘
```

# 53. Strategy Summary

Before deployment, show:

```
┌──────────────────────────────────────────┐
│ Strategy Summary                         │
├──────────────────────────────────────────┤
│ Markets                                  │
│ BTC/USDT, ETH/USDT                       │
│                                          │
│ ENTRY                                    │
│ RSI(14,15m) < 30                         │
│ AND                                      │
│ Close crosses above EMA(20,15m)          │
│                                          │
│ POSITION SIZE                             │
│ 20% Capital                              │
│                                          │
│ STOP LOSS                                │
│ 2%                                       │
│                                          │
│ TAKE PROFIT                              │
│ 5%                                       │
│                                          │
│ MAX POSITIONS                            │
│ 2                                        │
└──────────────────────────────────────────┘
```

Then:

```
[Validate]

[Backtest]

[Save Draft]

[Paper Trade]

[Deploy]
```

---

# 54. Recommended Database Model

At minimum:

```
users
strategies
strategy_versions
strategy_markets
strategy_runs
strategy_conditions
positions
orders
trades
risk_configs
backtest_runs
backtest_trades
exchange_accounts
```

However, don't over-normalize the strategy itself.

A good approach is:

```
strategies
    ↓
strategy_versions
    ↓
strategy_json
```

Store the canonical strategy definition as JSON while keeping operational entities such as orders and positions relational.

---

# 55. V1 Development Roadmap

## Phase 0 — Architecture

Build:

```
Strategy JSON schema
Condition AST
Indicator interface
Comparator interface
Risk interface
```

This is the foundation.

---

## Phase 1 — Builder UI

Build:

```
Strategy Name
Markets
Timeframes
Timezone
Days
Sessions
Entry Builder
Exit Builder
Position Sizing
Risk Management
```

No live trading yet.

---

## Phase 2 — Indicator Engine

Implement:

```
EMA
SMA
VWAP
RSI
MACD
SuperTrend
```

Plus:

```
Open
High
Low
Close
Number
```

---

## Phase 3 — Condition Engine

Implement:

```
>
<
>=
<=
=
Crosses Above
Crosses Below
```

and:

```
AND
OR
Nested Groups
```

---

## Phase 4 — Backtesting

Build:

```
Historical data
 ↓
Candle engine
 ↓
Indicator engine
 ↓
Condition engine
 ↓
Signal
 ↓
Risk engine
 ↓
Simulated order
 ↓
Portfolio
```

Then produce performance metrics.

---

## Phase 5 — Paper Trading

Connect real-time market data.

No real orders.

---

## Phase 6 — Exchange Integration

Start with **one exchange**, not five.

Build:

```
Authentication
Market data
Balances
Orders
Order status
Trade history
```

Then create an exchange adapter abstraction.

---

## Phase 7 — Live Spot Trading

Implement:

```
Order execution
Position management
Risk enforcement
Stop loss
Take profit
Trailing stop
Reconciliation
Error handling
Logs
Alerts
```

---

# 56. What NOT to build in Spot V1

Don't overload the first version with:

```
❌ Futures
❌ Options
❌ Arbitrage
❌ Short selling
❌ 30+ indicators
❌ Renko
❌ Heikin Ashi
❌ Complex options-style Greeks
❌ Advanced portfolio optimization
❌ AI-generated strategies
❌ Genetic optimization
❌ Strategy marketplace
❌ Copy trading
```

Those can come later.

Your first objective should be:

> **Can a user visually construct a strategy, backtest it accurately, paper trade it, and eventually execute that exact same strategy live?**
> 

If yes, you have the core product.

---

# 57. Final Product Architecture

The whole Spot Strategy Builder should ultimately look like this:

```
                         ┌─────────────────┐
                         │      USER       │
                         └────────┬────────┘
                                  │
                                  ▼
                    ┌────────────────────────┐
                    │   NO-CODE STRATEGY     │
                    │       BUILDER          │
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │     STRATEGY DSL       │
                    │       / JSON            │
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │       VALIDATOR         │
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    STRATEGY ENGINE      │
                    │                         │
                    │ Condition Engine        │
                    │ Indicator Engine        │
                    │ Signal Engine           │
                    │ Risk Engine              │
                    │ Position Sizing          │
                    └────────────┬───────────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                 │
               ▼                 ▼                 ▼
        ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
        │ BACKTESTING │   │   PAPER     │   │    LIVE     │
        │   ENGINE    │   │  TRADING    │   │   TRADING   │
        └─────────────┘   └─────────────┘   └──────┬──────┘
                                                   │
                                                   ▼
                                          ┌─────────────────┐
                                          │ EXCHANGE ADAPTER│
                                          └────────┬────────┘
                                                   │
                                                   ▼
                                          ┌─────────────────┐
                                          │     EXCHANGE    │
                                          └─────────────────┘
```

## The V1 feature boundary I recommend

```
                 SPOT V1
                    │
     ┌──────────────┼──────────────┐
     │              │              │
  ENTRY           EXIT          RISK
     │              │              │
 RSI              SL             Max positions
 EMA              TP             Max capital
 SMA              Trailing       Daily loss
 VWAP             Indicator      Cooldown
 MACD             Force exit     Max trades
 SuperTrend
     │
     └──────────────┬──────────────┘
                    │
             POSITION SIZING
                    │
          Fixed USDT / % Capital
                    │
                    ▼
              STRATEGY JSON
                    │
             ┌──────┼──────┐
             ▼      ▼      ▼
          Backtest Paper  Live
```




