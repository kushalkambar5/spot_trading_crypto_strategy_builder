import mongoose from "mongoose";

const { Schema } = mongoose;

const positionSchema = new Schema(
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

        side: {
            type: String,
            enum: [
                "LONG"
            ],
            default: "LONG",
            required: true
        },

        quantity: {
            type: Number,
            required: true,
            min: 0
        },

        entryPrice: {
            type: Number,
            required: true,
            min: 0
        },

        averageEntryPrice: {
            type: Number,
            required: true,
            min: 0
        },

        currentPrice: {
            type: Number,
            min: 0
        },

        stopLossPrice: {
            type: Number,
            min: 0
        },

        takeProfitPrice: {
            type: Number,
            min: 0
        },

        trailingStopPrice: {
            type: Number,
            min: 0
        },

        status: {
            type: String,
            enum: [
                "OPEN",
                "CLOSED"
            ],
            default: "OPEN",
            required: true,
            index: true
        },

        entryTime: {
            type: Date,
            required: true
        },

        exitTime: {
            type: Date
        },

        realizedPnl: {
            type: Number,
            default: 0
        },

        unrealizedPnl: {
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
                "MANUAL",
                "OTHER"
            ]
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

positionSchema.index({
    strategyId: 1,
    status: 1
});

positionSchema.index({
    userId: 1,
    status: 1
});

positionSchema.index({
    market: 1,
    status: 1
});

export default mongoose.model(
    "Position",
    positionSchema
);
