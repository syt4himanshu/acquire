const Joi = require('joi');

// Sugar is not a supported commodity. It is absent from this schema
// deliberately rather than accepted-and-zeroed: `validate` runs Joi with its
// default allowUnknown:false, so a request carrying sugar_qty_kg is rejected
// with 400 '"sugar_qty_kg" is not allowed' instead of being silently dropped.
const dispenseSchema = Joi.object({
    ration_card_id: Joi.string().uuid().required(),
    session_id: Joi.string().required(),
    beneficiary_user_id: Joi.string().uuid().optional(),
    rice_qty_kg: Joi.number().min(0).optional(),
    wheat_qty_kg: Joi.number().min(0).optional(),
    rice_session_id: Joi.string().uuid().optional(),
    wheat_session_id: Joi.string().uuid().optional(),
}).custom((value, helpers) => {
    if (value.rice_qty_kg === 0 && value.wheat_qty_kg === 0 && !value.rice_session_id && !value.wheat_session_id) {
        return helpers.error('any.invalid');
    }
    return value;
}).messages({
    'any.invalid': 'At least one quantity or IoT session must be provided',
});

// Blockchain-stable transaction schema — mirrors PDSLedger.recordTransaction,
// which has only riceQtyGrams/wheatQtyGrams on-chain.
const transactionSchema = Joi.object({
    ration_card_id: Joi.string().uuid().required(),
    rice_qty: Joi.number().min(0).required(),
    wheat_qty: Joi.number().min(0).required(),
}).custom((value, helpers) => {
    if (value.rice_qty === 0 && value.wheat_qty === 0) {
        return helpers.error('any.invalid');
    }
    return value;
}).messages({
    'any.invalid': 'At least one quantity must be greater than 0',
});

const { MAX_QUEUE_COUNT } = require('../config/shopStatus');

// Strict: "12", "12.0", "1e2" and null are refused rather than coerced, so
// the stored value is exactly what the shopkeeper typed as a whole number.
const openStatusSchema = Joi.object({
    is_open: Joi.boolean().strict().required(),
});

const queueCountSchema = Joi.object({
    queue_count: Joi.number().integer().min(0).max(MAX_QUEUE_COUNT).strict().required(),
});

module.exports = { dispenseSchema, transactionSchema, openStatusSchema, queueCountSchema };
