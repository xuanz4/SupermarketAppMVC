const fetch = global.fetch || require('node-fetch');

const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = process.env.PAYPAL_API || 'https://api-m.sandbox.paypal.com';

const getAccessToken = async () => {
    if (!PAYPAL_CLIENT || !PAYPAL_SECRET) {
        throw new Error('PayPal credentials are missing.');
    }

    const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error_description || 'Unable to obtain PayPal access token.');
    }

    return data.access_token;
};

const createOrder = async (amount, currency = 'SGD') => {
    const accessToken = await getAccessToken();
    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency,
                    value: amount
                }
            }]
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Unable to create PayPal order.');
    }

    return data;
};

const captureOrder = async (orderId) => {
    const accessToken = await getAccessToken();
    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        }
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Unable to capture PayPal order.');
    }

    return data;
};

const refundCapture = async (captureId) => {
    const accessToken = await getAccessToken();
    const response = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        }
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Unable to refund PayPal capture.');
    }

    return data;
};

module.exports = {
    createOrder,
    captureOrder,
    refundCapture
};
