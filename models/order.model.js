import mongoose from "mongoose";

const { Schema } = mongoose;

const orderSchema = new Schema(
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
            ref: "Position"
        },

        exchange: {
            type: String,
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
                "BUY",
                "SELL"
            ],
            required: true
        },

        orderType: {
            type: String,
            enum: [
                "MARKET",
                "LIMIT"
            ],
            required: true
        },

        quantity: {
            type: Number,
            required: true,
            min: 0
        },

        price: {
            type: Number,
            min: 0
        },

        averageFillPrice: {
            type: Number,
            min: 0
        },

        status: {
            type: String,
            enum: [
                "PENDING",
                "OPEN",
                "PARTIALLY_FILLED",
                "FILLED",
                "CANCELLED",
                "REJECTED",
                "FAILED"
            ],
            default: "PENDING",
            required: true,
            index: true
        },

        exchangeOrderId: {
            type: String,
            index: true
        },

        clientOrderId: {
            type: String
        },

        fee: {
            type: Number,
            default: 0,
            min: 0
        },

        feeAsset: {
            type: String
        },

        slippage: {
            type: Number,
            default: 0
        },

        submittedAt: {
            type: Date
        },

        filledAt: {
            type: Date
        },

        errorCode: {
            type: String
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

orderSchema.index({
    strategyId: 1,
    status: 1
});

orderSchema.index({
    positionId: 1
});

export default mongoose.model(
    "Order",
    orderSchema
);
