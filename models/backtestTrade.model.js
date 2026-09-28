import mongoose from "mongoose";

const { Schema } = mongoose;

const backtestTradeSchema = new Schema(
    {
        backtestRunId: {
            type: Schema.Types.ObjectId,
            ref: "BacktestRun",
            required: true,
            index: true
        },

        strategyId: {
            type: Schema.Types.ObjectId,
            ref: "Strategy",
            required: true
        },

        strategyVersionId: {
            type: Schema.Types.ObjectId,
            ref: "StrategyVersion",
            required: true
        },

        market: {
            type: String,
            required: true,
            enum: [
                "BTC/USDT",
                "ETH/USDT",
                "SOL/USDT",
                "BNB/USDT"
            ]
        },

        entryTime: {
            type: Date,
            required: true
        },

        exitTime: {
            type: Date
        },

        entryPrice: {
            type: Number,
            required: true,
            min: 0
        },

        exitPrice: {
            type: Number,
            min: 0
        },

        quantity: {
            type: Number,
            required: true,
            min: 0
        },

        grossPnl: {
            type: Number,
            default: 0
        },

        fees: {
            type: Number,
            default: 0,
            min: 0
        },

        netPnl: {
            type: Number,
            default: 0
        },

        returnPercentage: {
            type: Number,
            default: 0
        },

        exitReason: {
            type: String,
            enum: [
                "STOP_LOSS",
                "TAKE_PROFIT",
                "TRAILING_STOP",
                "INDICATOR",
                "FORCE_EXIT",
                "RISK_LIMIT",
                "OTHER"
            ]
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

backtestTradeSchema.index({
    backtestRunId: 1,
    entryTime: 1
});

export default mongoose.model(
    "BacktestTrade",
    backtestTradeSchema
);
