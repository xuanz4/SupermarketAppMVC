const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const createPaymentIntent = async (amountCents, currency = 'sgd') => {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('Stripe secret key is missing.');
    }
    return stripe.paymentIntents.create({
        amount: amountCents,
        currency,
        automatic_payment_methods: { enabled: true }
    });
};

const retrievePaymentIntent = async (paymentIntentId) => {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('Stripe secret key is missing.');
    }
    return stripe.paymentIntents.retrieve(paymentIntentId);
};

const createPaynowIntent = async (amountCents, returnUrl) => {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('Stripe secret key is missing.');
    }
    return stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'sgd',
        payment_method_types: ['paynow'],
        payment_method_data: { type: 'paynow' },
        confirm: true,
        return_url: returnUrl
    });
};

module.exports = {
    createPaymentIntent,
    retrievePaymentIntent,
    createPaynowIntent
};
