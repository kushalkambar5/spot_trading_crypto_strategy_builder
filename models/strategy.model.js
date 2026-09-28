import mongoose from "mongoose";

const { Schema } = mongoose;

const TIMEFRAMES = [
    "1m",
    "5m",
    "15m",
    "30m",
    "1h",
    "4h",
    "1D"
];

const MARKETS = [
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "BNB/USDT"
];

const TRADING_DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday"
];

/*
--------------------------------------------------------------------------
| Operand Schema
|--------------------------------------------------------------------------
|
| Operand can be:
|
| 1. price
| 2. indicator
| 3. constant
|
| Examples:
|
| {
|   type: "price",
|   field: "close",
|   timeframe: "15m"
| }
|
| {
|   type: "indicator",
|   name: "RSI",
|   timeframe: "15m",
|   output: "value",
|   settings: {
|      period: 14,
|      source: "close"
|   }
| }
|
| {
|   type: "constant",
|   value: 30
| }
|
|--------------------------------------------------------------------------
*/

const operandSchema = new Schema(
    {
        type: {
            type: String,
            enum: [
                "price",
                "indicator",
                "constant"
            ],
            required: true
        },

        // Used when type === "price"
        field: {
            type: String,
            enum: [
                "open",
                "high",
                "low",
                "close"
            ]
        },

        // Used when type === "indicator"
        name: {
            type: String,
            enum: [
                "EMA",
                "SMA",
                "VWAP",
                "RSI",
                "MACD",
                "SUPERTREND"
            ]
        },

        // Used by price and indicator operands
        timeframe: {
            type: String,
            enum: TIMEFRAMES
        },

        // Used by indicator operands
        //
        // Examples:
        // EMA       -> "value"
        // RSI       -> "value"
        // MACD      -> "line"
        // MACD      -> "signal"
        // MACD      -> "histogram"
        // SUPERTREND -> "value"
        output: {
            type: String
        },

        // Indicator-specific configuration
        //
        // Examples:
        //
        // EMA:
        // {
        //   period: 20,
        //   source: "close"
        // }
        //
        // RSI:
        // {
        //   period: 14,
        //   source: "close"
        // }
        //
        // MACD:
        // {
        //   fastPeriod: 12,
        //   slowPeriod: 26,
        //   signalPeriod: 9
        // }
        settings: {
            type: Schema.Types.Mixed
        },

        // Used when type === "constant"
        value: {
            type: Number
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Condition Schema
|--------------------------------------------------------------------------
|
| Example:
|
| RSI(14, 15m) < 30
|
| {
|   type: "condition",
|   left: {
|      type: "indicator",
|      name: "RSI",
|      timeframe: "15m",
|      output: "value",
|      settings: {
|         period: 14,
|         source: "close"
|      }
|   },
|   operator: "LESS_THAN",
|   right: {
|      type: "constant",
|      value: 30
|   }
| }
|
|--------------------------------------------------------------------------
*/

const conditionSchema = new Schema(
    {
        type: {
            type: String,
            enum: ["condition"],
            required: true
        },

        left: {
            type: operandSchema,
            required: true
        },

        operator: {
            type: String,
            enum: [
                "GREATER_THAN",
                "LESS_THAN",
                "GREATER_THAN_OR_EQUAL",
                "LESS_THAN_OR_EQUAL",
                "EQUAL",
                "CROSSES_ABOVE",
                "CROSSES_BELOW"
            ],
            required: true
        },

        right: {
            type: operandSchema,
            required: true
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Condition Tree
|--------------------------------------------------------------------------
|
| Supports:
|
| A AND B
|
| A OR B
|
| A AND (B OR C)
|
| (A OR B) AND (C OR D)
|
| Example:
|
| {
|   type: "group",
|   logic: "AND",
|   children: [
|      conditionA,
|      {
|         type: "group",
|         logic: "OR",
|         children: [
|            conditionB,
|            conditionC
|         ]
|      }
|   ]
| }
|
|--------------------------------------------------------------------------
*/

const conditionTreeSchema = new Schema(
    {
        type: {
            type: String,
            enum: ["group"],
            required: true
        },

        logic: {
            type: String,
            enum: [
                "AND",
                "OR"
            ],
            required: true
        },

        /*
         * Recursive condition tree.
         *
         * We intentionally use Mixed here because the tree
         * can recursively contain groups and conditions.
         *
         * Recursive validation should be implemented in the
         * strategy validation service later.
         */
        children: {
            type: [Schema.Types.Mixed],
            required: true
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Position Sizing
|--------------------------------------------------------------------------
*/

const positionSizingSchema = new Schema(
    {
        type: {
            type: String,
            enum: [
                "FIXED_QUANTITY",
                "FIXED_USDT",
                "PERCENT_CAPITAL"
            ],
            required: true
        },

        value: {
            type: Number,
            required: true,
            min: 0
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Stop Loss
|--------------------------------------------------------------------------
*/

const stopLossSchema = new Schema(
    {
        enabled: {
            type: Boolean,
            default: false
        },

        type: {
            type: String,
            enum: [
                "PERCENTAGE",
                "POINTS"
            ]
        },

        value: {
            type: Number,
            min: 0
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Take Profit
|--------------------------------------------------------------------------
*/

const takeProfitSchema = new Schema(
    {
        enabled: {
            type: Boolean,
            default: false
        },

        type: {
            type: String,
            enum: [
                "PERCENTAGE",
                "POINTS"
            ]
        },

        value: {
            type: Number,
            min: 0
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Trailing Stop
|--------------------------------------------------------------------------
*/

const trailingStopSchema = new Schema(
    {
        enabled: {
            type: Boolean,
            default: false
        },

        activation: {
            type: String,
            enum: [
                "IMMEDIATE",
                "AFTER_PROFIT"
            ]
        },

        activationValue: {
            type: Number,
            min: 0
        },

        type: {
            type: String,
            enum: [
                "PERCENTAGE",
                "POINTS"
            ]
        },

        value: {
            type: Number,
            min: 0
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Exit Schema
|--------------------------------------------------------------------------
*/

const exitSchema = new Schema(
    {
        indicator: {
            enabled: {
                type: Boolean,
                default: false
            },

            conditions: {
                type: Schema.Types.Mixed
            }
        },

        stopLoss: {
            type: stopLossSchema,
            default: () => ({
                enabled: false
            })
        },

        takeProfit: {
            type: takeProfitSchema,
            default: () => ({
                enabled: false
            })
        },

        trailingStop: {
            type: trailingStopSchema,
            default: () => ({
                enabled: false
            })
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Schedule Schema
|--------------------------------------------------------------------------
*/

const scheduleSchema = new Schema(
    {
        timezone: {
            type: String,
            enum: [
                "UTC",
                "Asia/Kolkata",
                "America/New_York",
                "Europe/London"
            ],
            required: true
        },

        tradingDays: {
            type: [String],
            enum: TRADING_DAYS,
            required: true,

            validate: {
                validator: value => value.length > 0,
                message: "At least one trading day is required"
            }
        },

        sessions: {
            type: [
                {
                    start: {
                        type: String,
                        required: true
                    },

                    end: {
                        type: String,
                        required: true
                    }
                }
            ],

            default: []
        },

        forceExit: {
            enabled: {
                type: Boolean,
                default: false
            },

            time: {
                type: String
            }
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Risk Management
|--------------------------------------------------------------------------
*/

const riskManagementSchema = new Schema(
    {
        maxOpenPositions: {
            type: Number,
            min: 1
        },

        maxCapitalAllocation: {
            type: Number,
            min: 0,
            max: 100
        },

        maxDailyLoss: {
            type: Number,
            min: 0
        },

        maxDailyLossAction: {
            type: String,
            enum: [
                "BLOCK_NEW_ENTRIES",
                "CLOSE_ALL_AND_STOP"
            ],
            default: "BLOCK_NEW_ENTRIES"
        },

        maxTradesPerDay: {
            type: Number,
            min: 1
        },

        cooldown: {
            enabled: {
                type: Boolean,
                default: false
            },

            value: {
                type: Number,
                min: 0
            },

            unit: {
                type: String,
                enum: [
                    "SECONDS",
                    "MINUTES",
                    "HOURS"
                ]
            }
        },

        overallProfitTarget: {
            enabled: {
                type: Boolean,
                default: false
            },

            amount: {
                type: Number,
                min: 0
            }
        },

        overallLossLimit: {
            enabled: {
                type: Boolean,
                default: false
            },

            amount: {
                type: Number,
                min: 0
            }
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Execution Settings
|--------------------------------------------------------------------------
*/

const executionSettingsSchema = new Schema(
    {
        exchange: {
            type: String,
            required: true
        },

        orderType: {
            type: String,
            enum: [
                "MARKET",
                "LIMIT"
            ],
            default: "MARKET"
        },

        slippage: {
            enabled: {
                type: Boolean,
                default: true
            },

            percentage: {
                type: Number,
                min: 0
            }
        }
    },
    {
        _id: false
    }
);


/*
--------------------------------------------------------------------------
| Strategy Schema
|--------------------------------------------------------------------------
*/

const strategySchema = new Schema(
    {
        strategyName: {
            type: String,
            minlength: 3,
            maxlength: 50,
            required: true,
            trim: true
        },

        description: {
            type: String,
            maxlength: 500,
            trim: true
        },

        version: {
            type: Number,
            default: 1,
            min: 1
        },

        status: {
            type: String,
            enum: [
                "DRAFT",
                "VALIDATED",
                "BACKTESTED",
                "PAPER_TRADING",
                "ACTIVE",
                "PAUSED",
                "STOPPED"
            ],
            default: "DRAFT"
        },

        markets: {
            type: [String],
            enum: MARKETS,
            required: true,

            validate: {
                validator: value => value.length > 0,
                message: "At least one market is required"
            }
        },

        chartType: {
            type: String,
            enum: [
                "CANDLESTICK"
            ],
            default: "CANDLESTICK"
        },

        schedule: {
            type: scheduleSchema,
            required: true
        },

        /*
        |--------------------------------------------------------------------------
        | Entry
        |--------------------------------------------------------------------------
        |
        | Spot V1 is long-only.
        |
        | Entry action:
        | BUY
        |
        | Trigger:
        | FALSE_TO_TRUE
        |
        */

        entry: {
            action: {
                type: String,
                enum: [
                    "BUY"
                ],
                default: "BUY"
            },

            trigger: {
                type: String,
                enum: [
                    "FALSE_TO_TRUE"
                ],
                default: "FALSE_TO_TRUE"
            },

            conditions: {
                type: Schema.Types.Mixed,
                required: true
            }
        },

        positionSizing: {
            type: positionSizingSchema,
            required: true
        },

        exit: {
            type: exitSchema,
            required: true
        },

        riskManagement: {
            type: riskManagementSchema,
            required: true
        },

        execution: {
            type: executionSettingsSchema,
            required: true
        },

        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);


/*
--------------------------------------------------------------------------
| Indexes
|--------------------------------------------------------------------------
*/

strategySchema.index({
    createdBy: 1,
    status: 1
});

strategySchema.index({
    createdBy: 1,
    createdAt: -1
});


export default mongoose.model(
    "Strategy",
    strategySchema
);
