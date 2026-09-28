import mongoose from "mongoose";

const { Schema } = mongoose;

const tradeSchema = new Schema(
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

        positionId: {
            type: Schema.Types.ObjectId,
            ref: "Position",
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

        entryOrderId: {
            type: Schema.Types.ObjectId,
            ref: "Order",
            required: true
        },

        exitOrderId: {
            type: Schema.Types.ObjectId,
            ref: "Order"
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

        entryTime: {
            type: Date,
            required: true
        },

        exitTime: {
            type: Date
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

tradeSchema.index({
    strategyId: 1,
    entryTime: -1
});

tradeSchema.index({
    userId: 1,
    market: 1,
    entryTime: -1
});

export default mongoose.model(
    "Trade",
    tradeSchema
);
