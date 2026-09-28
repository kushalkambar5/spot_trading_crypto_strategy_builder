import mongoose from "mongoose";

const { Schema } = mongoose;

const backtestRunSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        strategyId: {
            type: Schema.Types.ObjectId,
            ref: "Strategy",
            required: true,
            index: true
        },

        strategyVersionId: {
            type: Schema.Types.ObjectId,
            ref: "StrategyVersion",
            required: true,
            index: true
        },

        markets: {
            type: [String],
            required: true
        },

        startDate: {
            type: Date,
            required: true
        },

        endDate: {
            type: Date,
            required: true
        },

        initialCapital: {
            type: Number,
            required: true,
            min: 0
        },

        fees: {
            type: Number,
            default: 0,
            min: 0
        },

        slippage: {
            type: Number,
            default: 0,
            min: 0
        },

        status: {
            type: String,
            enum: [
                "PENDING",
                "RUNNING",
                "COMPLETED",
                "FAILED"
            ],
            default: "PENDING",
            required: true,
            index: true
        },

        netPnl: {
            type: Number,
            default: 0
        },

        returnPercentage: {
            type: Number,
            default: 0
        },

        winRate: {
            type: Number,
            default: 0
        },

        profitFactor: {
            type: Number,
            default: 0
        },

        maxDrawdown: {
            type: Number,
            default: 0
        },

        sharpeRatio: {
            type: Number,
            default: 0
        },

        totalTrades: {
            type: Number,
            default: 0,
            min: 0
        },

        winningTrades: {
            type: Number,
            default: 0,
            min: 0
        },

        losingTrades: {
            type: Number,
            default: 0,
            min: 0
        },

        averageTrade: {
            type: Number,
            default: 0
        },

        equityCurve: {
            type: [
                {
                    timestamp: {
                        type: Date,
                        required: true
                    },

                    equity: {
                        type: Number,
                        required: true
                    }
                }
            ],
            default: []
        },

        startedAt: {
            type: Date
        },

        completedAt: {
            type: Date
        },

        errorMessage: {
            type: String
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

backtestRunSchema.index({
    strategyId: 1,
    createdAt: -1
});

export default mongoose.model(
    "BacktestRun",
    backtestRunSchema
);
