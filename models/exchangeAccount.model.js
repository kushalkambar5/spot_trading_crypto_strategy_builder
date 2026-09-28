import mongoose from "mongoose";

const { Schema } = mongoose;

const exchangeAccountSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        exchange: {
            type: String,
            required: true
        },

        label: {
            type: String,
            trim: true,
            maxlength: 100
        },

        /*
         * IMPORTANT:
         *
         * Do NOT store raw API secrets in plain text.
         *
         * The actual implementation should encrypt credentials
         * or store them in a secure secrets manager.
         *
         * These fields are placeholders for the encrypted values.
         */

        apiKeyEncrypted: {
            type: String
        },

        apiSecretEncrypted: {
            type: String
        },

        passphraseEncrypted: {
            type: String
        },

        isActive: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

exchangeAccountSchema.index({
    userId: 1,
    exchange: 1
});

export default mongoose.model(
    "ExchangeAccount",
    exchangeAccountSchema
);
