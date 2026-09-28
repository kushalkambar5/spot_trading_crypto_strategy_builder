export const indicatorRegistry = {
    EMA: {
        outputs: [
            "value"
        ],

        settings: {
            period: {
                type: "number",
                min: 1,
                max: 1000
            },

            source: {
                type: "enum",
                values: [
                    "open",
                    "high",
                    "low",
                    "close"
                ]
            }
        }
    },

    SMA: {
        outputs: [
            "value"
        ],

        settings: {
            period: {
                type: "number",
                min: 1,
                max: 1000
            },

            source: {
                type: "enum",
                values: [
                    "open",
                    "high",
                    "low",
                    "close"
                ]
            }
        }
    },

    VWAP: {
        outputs: [
            "value"
        ],

        settings: {
            source: {
                type: "enum",
                values: [
                    "close"
                ]
            }
        }
    },

    RSI: {
        outputs: [
            "value"
        ],

        settings: {
            period: {
                type: "number",
                min: 1,
                max: 500
            },

            source: {
                type: "enum",
                values: [
                    "open",
                    "high",
                    "low",
                    "close"
                ]
            }
        }
    },

    MACD: {
        outputs: [
            "line",
            "signal",
            "histogram"
        ],

        settings: {
            fastPeriod: {
                type: "number",
                min: 1,
                max: 500
            },

            slowPeriod: {
                type: "number",
                min: 1,
                max: 1000
            },

            signalPeriod: {
                type: "number",
                min: 1,
                max: 500
            }
        }
    },

    SUPERTREND: {
        outputs: [
            "value",
            "direction"
        ],

        settings: {
            atrPeriod: {
                type: "number",
                min: 1,
                max: 500
            },

            multiplier: {
                type: "number",
                min: 0.1,
                max: 20
            }
        }
    }
};

export default indicatorRegistry;
