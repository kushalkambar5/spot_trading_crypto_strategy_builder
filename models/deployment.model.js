import mongoose from "mongoose";

const { Schema } = mongoose;

const deploymentSchema = new Schema(
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

        exchangeAccountId: {
            type: Schema.Types.ObjectId,
            ref: "ExchangeAccount",
            required: true
        },

        mode: {
            type: String,
            enum: [
                "PAPER",
                "LIVE"
            ],
            required: true
        },

        status: {
            type: String,
            enum: [
                "ACTIVE",
                "PAUSED",
                "STOPPED",
                "FAILED"
            ],
            default: "ACTIVE",
            required: true,
            index: true
        },

        startedAt: {
            type: Date,
            required: true
        },

        stoppedAt: {
            type: Date
        },

        lastHeartbeatAt: {
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

deploymentSchema.index({
    strategyId: 1,
    strategyVersionId: 1,
    status: 1
});

export default mongoose.model(
    "Deployment",
    deploymentSchema
);
