import mongoose from "mongoose";

const { Schema } = mongoose;

const strategyVersionSchema = new Schema(
    {
        strategyId: {
            type: Schema.Types.ObjectId,
            ref: "Strategy",
            required: true,
            index: true
        },

        version: {
            type: Number,
            required: true,
            min: 1
        },

        definition: {
            type: Schema.Types.Mixed,
            required: true
        },

        status: {
            type: String,
            enum: [
                "DRAFT",
                "VALIDATED",
                "BACKTESTED",
                "DEPLOYED",
                "ARCHIVED"
            ],
            default: "DRAFT"
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

strategyVersionSchema.index(
    {
        strategyId: 1,
        version: 1
    },
    {
        unique: true
    }
);

export default mongoose.model(
    "StrategyVersion",
    strategyVersionSchema
);
