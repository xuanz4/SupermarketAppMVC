const Order = require('../models/order');
const cartStore = require('../models/cartStorage');
const Payment = require('../models/payment');
const Wallet = require('../models/wallet');
const paypal = require('../services/paypal');
const netsService = require('../services/nets');
const stripeService = require('../services/stripe');

const ensureCart = (req) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }
};

const calculateTotals = (cartItems, deliveryFee) => {
    const itemsTotal = cartItems.reduce((sum, item) => {
        const unitPrice = Number(item.price);
        const quantity = Number(item.quantity);
        if (!Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
            return sum;
        }
        return sum + (unitPrice * quantity);
    }, 0);

    const safeDeliveryFee = Number(deliveryFee || 0);
    const totalWithFees = Number((itemsTotal + safeDeliveryFee).toFixed(2));

    return {
        itemsTotal: Number(itemsTotal.toFixed(2)),
        totalWithFees
    };
};

const createPaypalOrder = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);

    try {
        const order = await paypal.createOrder(totalWithFees.toFixed(2));
        return res.json(order);
    } catch (error) {
        console.error('Error creating PayPal order:', error);
        return res.status(500).json({ error: 'Unable to create PayPal order.' });
    }
};

const capturePaypalOrder = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { orderId } = req.body || {};
    if (!orderId) {
        return res.status(400).json({ error: 'Missing PayPal order ID.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const expectedTotal = totalWithFees.toFixed(2);

    try {
        const capture = await paypal.captureOrder(orderId);
        if (capture.status !== 'COMPLETED') {
            return res.status(400).json({ error: 'PayPal payment not completed.' });
        }

        const capturedAmount = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value
            || capture?.purchase_units?.[0]?.amount?.value;
        const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;

        if (capturedAmount && capturedAmount !== expectedTotal) {
            return res.status(400).json({ error: 'PayPal amount mismatch.' });
        }

        Order.create(req.session.user.id, cartItems, {
            deliveryMethod: pending.deliveryMethod,
            deliveryAddress: pending.deliveryAddress,
            deliveryFee: Number(pending.deliveryFee || 0)
        }, (error, orderResult) => {
            if (error) {
                console.error('Error during PayPal checkout:', error);
                return res.status(500).json({ error: 'Unable to complete checkout. Please try again.' });
            }

            if (orderResult && orderResult.orderId) {
                Payment.create(orderResult.orderId, {
                    provider: 'paypal',
                    status: 'paid',
                    amount: Number(expectedTotal),
                    currency: 'SGD',
                    providerRef: captureId
                }, (paymentErr) => {
                    if (paymentErr) {
                        console.error('Error saving PayPal payment:', paymentErr);
                    }
                });
            }

            req.session.cart = [];
            req.session.pendingCheckout = null;
            if (req.session.user) {
                cartStore.save(req.session.user.id, [], (clearErr) => {
                    if (clearErr) {
                        console.error('Error clearing persisted cart after PayPal checkout:', clearErr);
                    }
                });
            }

            return res.json({ success: true, redirect: '/orders/history' });
        });
    } catch (error) {
        console.error('Error capturing PayPal order:', error);
        return res.status(500).json({ error: 'Unable to capture PayPal payment.' });
    }
};

const generateNetsQr = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can make payments.');
        return res.redirect('/cart');
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        req.flash('error', 'Please confirm delivery details first.');
        return res.redirect('/checkout');
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);

    try {
        const responseData = await netsService.requestQrCode(totalWithFees.toFixed(2));
        const qrData = responseData?.result?.data;

        if (!qrData) {
            req.flash('error', 'Unable to read NETS QR response.');
            return res.redirect('/payment');
        }

        if (qrData.response_code === '00' && qrData.txn_status === 1 && qrData.qr_code) {
            const { webhookUrl, courseInitId } = netsService.buildWebhookUrl(qrData.txn_retrieval_ref);
            req.session.netsPending = {
                total: totalWithFees.toFixed(2),
                txnRetrievalRef: qrData.txn_retrieval_ref
            };

            return res.render('netsQr', {
                total: totalWithFees.toFixed(2),
                title: 'Scan to Pay',
                qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
                txnRetrievalRef: qrData.txn_retrieval_ref,
                courseInitId,
                networkCode: qrData.network_status,
                timer: 300,
                webhookUrl,
                fullNetsResponse: responseData,
                apiKey: process.env.API_KEY,
                projectId: process.env.PROJECT_ID
            });
        }

        let errorMsg = 'An error occurred while generating the QR code.';
        if (qrData.network_status !== 0) {
            errorMsg = qrData.error_message || 'Transaction failed. Please try again.';
        }
        req.session.netsPending = null;
        return res.render('netsQrFail', {
            title: 'Error',
            responseCode: 'N.A.',
            instructions: '',
            errorMsg
        });
    } catch (error) {
        console.error('Error in generateNetsQr:', error.message);
        req.session.netsPending = null;
        return res.render('netsQrFail', {
            title: 'Error',
            responseCode: 'N.A.',
            instructions: '',
            errorMsg: 'Unable to reach NETS sandbox. Please try again.'
        });
    }
};

const showNetsFail = (req, res) => {
    const reason = typeof req.query.reason === 'string' ? req.query.reason : '';
    const errorMsg = reason === 'timeout'
        ? 'Payment window expired. Please generate a new NETS QR code.'
        : 'NETS payment could not be completed.';

    req.session.netsPending = null;
    return res.render('netsQrFail', {
        title: 'Error',
        responseCode: 'N.A.',
        instructions: '',
        errorMsg
    });
};

const streamNetsPaymentStatus = (req, res) => {
    const txnRetrievalRef = req.params.txnRetrievalRef;
    if (!txnRetrievalRef) {
        return res.status(400).end();
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let pollCount = 0;
    const maxPolls = 60;
    let frontendTimeoutStatus = 0;

    const interval = setInterval(async () => {
        pollCount += 1;

        try {
            const responseData = await netsService.queryPaymentStatus(txnRetrievalRef, frontendTimeoutStatus);
            res.write(`data: ${JSON.stringify(responseData)}\n\n`);

            const resData = responseData?.result?.data;
            if (resData && resData.response_code === '00' && resData.txn_status === 1) {
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                res.end();
                return;
            }

            if (frontendTimeoutStatus === 1 && resData && (resData.response_code !== '00' || resData.txn_status === 2)) {
                res.write(`data: ${JSON.stringify({ fail: true, ...resData })}\n\n`);
                clearInterval(interval);
                res.end();
                return;
            }
        } catch (error) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
            return;
        }

        if (pollCount >= maxPolls) {
            clearInterval(interval);
            frontendTimeoutStatus = 1;
            res.write(`data: ${JSON.stringify({ fail: true, error: 'Timeout' })}\n\n`);
            res.end();
        }
    }, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
};

const parseAmount = (value) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Number(parsed.toFixed(2));
};

const showWallet = (req, res) => {
    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can access the wallet.');
        return res.redirect('/shopping');
    }

    if (req.query && req.query.nets === 'fail') {
        req.flash('error', 'NETS top up failed or timed out. Please try again.');
    }

    Wallet.getBalance(req.session.user.id, (balanceErr, balance) => {
        if (balanceErr) {
            console.error('Error fetching wallet balance:', balanceErr);
        }

        Wallet.findByUser(req.session.user.id, (topupErr, topups) => {
            if (topupErr) {
                console.error('Error fetching wallet topups:', topupErr);
            }

            Wallet.findTransactions(req.session.user.id, (txErr, transactions) => {
                if (txErr) {
                    console.error('Error fetching wallet transactions:', txErr);
                }

                const netsQr = req.session.walletNetsQr || null;
                req.session.walletNetsQr = null;

                res.render('wallet', {
                    user: req.session.user,
                    walletBalance: Number(balance || 0),
                    topups: topups || [],
                    transactions: transactions || [],
                    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
                    netsQr,
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            });
        });
    });
};

const createPaypalTopupOrder = async (req, res) => {
    const amount = parseAmount(req.body.amount);
    if (!amount) {
        return res.status(400).json({ error: 'Invalid top up amount.' });
    }

    try {
        const order = await paypal.createOrder(amount.toFixed(2));
        return res.json(order);
    } catch (error) {
        console.error('Error creating PayPal top up order:', error);
        return res.status(500).json({ error: 'Unable to create PayPal order.' });
    }
};

const capturePaypalTopup = async (req, res) => {
    const { orderId } = req.body || {};
    if (!orderId) {
        return res.status(400).json({ error: 'Missing PayPal order ID.' });
    }

    try {
        const capture = await paypal.captureOrder(orderId);
        if (capture.status !== 'COMPLETED') {
            return res.status(400).json({ error: 'PayPal payment not completed.' });
        }

        const captureData = capture?.purchase_units?.[0]?.payments?.captures?.[0];
        const captureId = captureData?.id || null;
        const capturedAmount = captureData?.amount?.value;

        if (!captureId || !capturedAmount) {
            return res.status(400).json({ error: 'Unable to confirm PayPal payment.' });
        }

        Wallet.findByProviderRef(captureId, (lookupErr, existingTopup) => {
            if (lookupErr) {
                console.error('Error checking PayPal top up:', lookupErr);
                return res.status(500).json({ error: 'Unable to verify top up.' });
            }

            if (existingTopup) {
                return res.json({ success: true, redirect: '/wallet' });
            }

            Wallet.credit(req.session.user.id, Number(capturedAmount), `paypal:${captureId}`, (creditErr, newBalance) => {
                if (creditErr) {
                    console.error('Error crediting wallet:', creditErr);
                    return res.status(500).json({ error: 'Unable to credit wallet.' });
                }

                Wallet.create(req.session.user.id, {
                    provider: 'paypal',
                    amount: Number(capturedAmount),
                    status: 'completed',
                    providerRef: captureId
                }, (topupErr) => {
                    if (topupErr) {
                        console.error('Error saving PayPal top up:', topupErr);
                    }
                });

                if (req.session.user) {
                    req.session.user.wallet_balance = Number(newBalance || 0);
                }

                return res.json({ success: true, redirect: '/wallet' });
            });
        });
    } catch (error) {
        console.error('Error capturing PayPal top up:', error);
        return res.status(500).json({ error: 'Unable to capture PayPal payment.' });
    }
};

const createNetsTopup = async (req, res) => {
    const amount = parseAmount(req.body.amount);
    if (!amount) {
        req.flash('error', 'Invalid top up amount.');
        return res.redirect('/wallet');
    }

    try {
        const responseData = await netsService.requestQrCode(amount.toFixed(2));
        const qrData = responseData?.result?.data;

        if (!qrData || qrData.response_code !== '00' || qrData.txn_status !== 1 || !qrData.qr_code) {
            req.flash('error', qrData?.error_message || 'Unable to generate NETS QR.');
            return res.redirect('/wallet');
        }

        Wallet.create(req.session.user.id, {
            provider: 'nets',
            amount,
            status: 'pending',
            providerRef: qrData.txn_retrieval_ref
        }, (topupErr) => {
            if (topupErr) {
                console.error('Error saving NETS top up:', topupErr);
            }
        });

        const { webhookUrl, courseInitId } = netsService.buildWebhookUrl(qrData.txn_retrieval_ref);
        req.session.walletNetsQr = {
            total: amount.toFixed(2),
            title: 'Top up wallet',
            qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
            txnRetrievalRef: qrData.txn_retrieval_ref,
            courseInitId,
            networkCode: qrData.network_status,
            timer: 300,
            webhookUrl
        };

        return res.redirect('/wallet');
    } catch (error) {
        console.error('Error creating NETS top up:', error.message);
        req.flash('error', 'Unable to reach NETS sandbox. Please try again.');
        return res.redirect('/wallet');
    }
};

const confirmNetsTopup = (req, res) => {
    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can access the wallet.');
        return res.redirect('/shopping');
    }

    const txnRetrievalRef = (req.query && req.query.txnRetrievalRef)
        || (req.body && req.body.txnRetrievalRef);
    if (!txnRetrievalRef) {
        req.flash('error', 'Missing NETS transaction reference.');
        return res.redirect('/wallet');
    }

    Wallet.findByProviderRef(txnRetrievalRef, (lookupErr, topup) => {
        if (lookupErr) {
            console.error('Error checking NETS top up:', lookupErr);
            req.flash('error', 'Unable to verify NETS top up.');
            return res.redirect('/wallet');
        }

        if (!topup || Number(topup.user_id) !== Number(req.session.user.id)) {
            req.flash('error', 'NETS top up not found.');
            return res.redirect('/wallet');
        }

        if (topup.status !== 'pending') {
            req.flash('success', 'Wallet top up already processed.');
            return res.redirect('/wallet');
        }

        Wallet.credit(req.session.user.id, Number(topup.amount), `nets:${txnRetrievalRef}`, (creditErr, newBalance) => {
            if (creditErr) {
                console.error('Error crediting wallet:', creditErr);
                req.flash('error', 'Unable to credit wallet.');
                return res.redirect('/wallet');
            }

            Wallet.markCompleted(topup.id, (updateErr) => {
                if (updateErr) {
                    console.error('Error updating NETS top up status:', updateErr);
                    req.flash('error', 'Wallet credited but status update failed.');
                    return res.redirect('/wallet');
                }

                if (req.session.user) {
                    req.session.user.wallet_balance = Number(newBalance || 0);
                }

                req.flash('success', 'NETS top up credited successfully.');
                return res.redirect('/wallet');
            });
        });
    });
};

const confirmNetsPayment = (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can make payments.');
        return res.redirect('/cart');
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        req.flash('error', 'Please confirm delivery details first.');
        return res.redirect('/checkout');
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    const netsPending = req.session.netsPending;
    if (!netsPending) {
        req.flash('error', 'Please generate a NETS QR code first.');
        return res.redirect('/payment');
    }

    const txnRetrievalRef = (req.body && req.body.txnRetrievalRef)
        || (req.query && req.query.txnRetrievalRef);
    if (!txnRetrievalRef || txnRetrievalRef !== netsPending.txnRetrievalRef) {
        req.flash('error', 'NETS payment reference mismatch. Please regenerate the QR code.');
        return res.redirect('/payment');
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const expectedTotal = totalWithFees.toFixed(2);
    if (netsPending.total && netsPending.total !== expectedTotal) {
        req.flash('error', 'Order total changed. Please regenerate the QR code.');
        return res.redirect('/payment');
    }

    Order.create(req.session.user.id, cartItems, {
        deliveryMethod: pending.deliveryMethod,
        deliveryAddress: pending.deliveryAddress,
        deliveryFee: Number(pending.deliveryFee || 0)
    }, (error, orderResult) => {
        if (error) {
            console.error('Error during NETS checkout:', error);
            req.flash('error', 'Unable to complete checkout. Please try again.');
            return res.redirect('/payment');
        }

        if (orderResult && orderResult.orderId) {
            Payment.create(orderResult.orderId, {
                provider: 'nets',
                status: 'paid',
                amount: Number(expectedTotal),
                currency: 'SGD',
                providerRef: netsPending.txnRetrievalRef || null
            }, (paymentErr) => {
                if (paymentErr) {
                    console.error('Error saving NETS payment:', paymentErr);
                }
            });
        }

        req.session.cart = [];
        req.session.pendingCheckout = null;
        req.session.netsPending = null;
        if (req.session.user) {
            cartStore.save(req.session.user.id, [], (clearErr) => {
                if (clearErr) {
                    console.error('Error clearing persisted cart after NETS checkout:', clearErr);
                }
            });
        }

        req.flash('success', 'Thanks for your purchase! NETS payment recorded.');
        return res.redirect('/orders/history');
    });
};

const createStripePaymentIntent = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const amountCents = Math.round(Number(totalWithFees) * 100);

    try {
        const intent = await stripeService.createPaymentIntent(amountCents, 'sgd');
        return res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
    } catch (error) {
        console.error('Error creating Stripe payment intent:', error);
        return res.status(500).json({ error: 'Unable to create Stripe payment intent.' });
    }
};

const confirmStripeOrder = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId) {
        return res.status(400).json({ error: 'Missing Stripe payment intent.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const expectedCents = Math.round(Number(totalWithFees) * 100);

    try {
        const intent = await stripeService.retrievePaymentIntent(paymentIntentId);
        if (!intent || intent.status !== 'succeeded') {
            return res.status(400).json({ error: 'Stripe payment not completed.' });
        }

        if (intent.amount_received !== expectedCents) {
            return res.status(400).json({ error: 'Stripe amount mismatch.' });
        }

        Order.create(req.session.user.id, cartItems, {
            deliveryMethod: pending.deliveryMethod,
            deliveryAddress: pending.deliveryAddress,
            deliveryFee: Number(pending.deliveryFee || 0)
        }, (error, orderResult) => {
            if (error) {
                console.error('Error during Stripe checkout:', error);
                return res.status(500).json({ error: 'Unable to complete checkout. Please try again.' });
            }

            if (orderResult && orderResult.orderId) {
                Payment.create(orderResult.orderId, {
                    provider: 'stripe',
                    status: 'paid',
                    amount: Number(totalWithFees),
                    currency: 'SGD',
                    providerRef: paymentIntentId
                }, (paymentErr) => {
                    if (paymentErr) {
                        console.error('Error saving Stripe payment:', paymentErr);
                    }
                });
            }

            req.session.cart = [];
            req.session.pendingCheckout = null;
            if (req.session.user) {
                cartStore.save(req.session.user.id, [], (clearErr) => {
                    if (clearErr) {
                        console.error('Error clearing persisted cart after Stripe checkout:', clearErr);
                    }
                });
            }

            return res.json({ success: true, redirect: '/orders/history' });
        });
    } catch (error) {
        console.error('Error confirming Stripe payment:', error);
        return res.status(500).json({ error: 'Unable to confirm Stripe payment.' });
    }
};

const createStripePaynow = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const amountCents = Math.round(Number(totalWithFees) * 100);
    const returnUrl = `${req.protocol}://${req.get('host')}/orders/history`;

    try {
        const intent = await stripeService.createPaynowIntent(amountCents, returnUrl);
        req.session.stripePaynow = {
            paymentIntentId: intent.id,
            total: totalWithFees.toFixed(2)
        };
        const nextAction = intent.next_action || {};
        let qrPayload = null;
        let hostedUrl = null;

        if (nextAction.display_qr_code) {
            qrPayload = nextAction.display_qr_code;
            hostedUrl = nextAction.display_qr_code.hosted_instructions_url || null;
        } else if (nextAction.paynow_display_qr_code) {
            qrPayload = nextAction.paynow_display_qr_code;
            hostedUrl = nextAction.paynow_display_qr_code.hosted_instructions_url || null;
        } else if (nextAction.redirect_to_url && nextAction.redirect_to_url.url) {
            hostedUrl = nextAction.redirect_to_url.url;
        } else {
            const qrKey = Object.keys(nextAction).find((key) => (
                key.includes('display_qr_code') || key.includes('handle_redirect_or_display_qr_code')
            ));
            if (qrKey && nextAction[qrKey]) {
                const payload = nextAction[qrKey];
                qrPayload = payload.qr_code || payload.display_qr_code || payload;
                hostedUrl = payload.hosted_instructions_url || payload?.qr_code?.hosted_instructions_url || null;
            }
        }

        return res.json({
            paymentIntentId: intent.id,
            status: intent.status,
            nextActionType: nextAction.type || null,
            hostedUrl,
            qrCodeUrl: qrPayload
                ? (qrPayload.image_url || qrPayload.image_url_png || qrPayload.image_url_svg || null)
                : null,
            qrCodeData: qrPayload
                ? (qrPayload.image_data || null)
                : null
        });
    } catch (error) {
        console.error('Error creating Stripe PayNow intent:', error);
        return res.status(500).json({ error: 'Unable to create Stripe PayNow payment.' });
    }
};

const confirmStripePaynowOrder = async (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        return res.status(403).json({ error: 'Only shoppers can make payments.' });
    }

    const pending = req.session.pendingCheckout;
    if (!pending) {
        return res.status(400).json({ error: 'Please confirm delivery details first.' });
    }

    const cartItems = req.session.cart || [];
    if (!cartItems.length) {
        return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId) {
        return res.status(400).json({ error: 'Missing Stripe PayNow intent.' });
    }

    const sessionIntent = req.session.stripePaynow;
    if (!sessionIntent || sessionIntent.paymentIntentId !== paymentIntentId) {
        return res.status(400).json({ error: 'Stripe PayNow session mismatch.' });
    }

    const { totalWithFees } = calculateTotals(cartItems, pending.deliveryFee || 0);
    const expectedCents = Math.round(Number(totalWithFees) * 100);

    try {
        const intent = await stripeService.retrievePaymentIntent(paymentIntentId);
        if (!intent || intent.status !== 'succeeded') {
            return res.json({ pending: true, status: intent ? intent.status : 'unknown' });
        }
        if (intent.amount_received !== expectedCents) {
            return res.status(400).json({ error: 'Stripe PayNow amount mismatch.' });
        }

        Order.create(req.session.user.id, cartItems, {
            deliveryMethod: pending.deliveryMethod,
            deliveryAddress: pending.deliveryAddress,
            deliveryFee: Number(pending.deliveryFee || 0)
        }, (error, orderResult) => {
            if (error) {
                console.error('Error during Stripe PayNow checkout:', error);
                return res.status(500).json({ error: 'Unable to complete checkout. Please try again.' });
            }

            if (orderResult && orderResult.orderId) {
                Payment.create(orderResult.orderId, {
                    provider: 'stripe_paynow',
                    status: 'paid',
                    amount: Number(totalWithFees),
                    currency: 'SGD',
                    providerRef: paymentIntentId
                }, (paymentErr) => {
                    if (paymentErr) {
                        console.error('Error saving Stripe PayNow payment:', paymentErr);
                    }
                });
            }

            req.session.cart = [];
            req.session.pendingCheckout = null;
            req.session.stripePaynow = null;
            if (req.session.user) {
                cartStore.save(req.session.user.id, [], (clearErr) => {
                    if (clearErr) {
                        console.error('Error clearing persisted cart after Stripe PayNow checkout:', clearErr);
                    }
                });
            }

            return res.json({ success: true, redirect: '/orders/history' });
        });
    } catch (error) {
        console.error('Error confirming Stripe PayNow payment:', error);
        return res.status(500).json({ error: 'Unable to confirm Stripe PayNow payment.' });
    }
};
const refundPayment = (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect('/admin/deliveries');
    }

    Payment.findByOrderId(orderId, async (paymentErr, paymentRows) => {
        if (paymentErr) {
            console.error('Error fetching payment:', paymentErr);
            req.flash('error', 'Unable to process refund.');
            return res.redirect('/admin/deliveries');
        }

        const payment = paymentRows && paymentRows[0];
        if (!payment) {
            req.flash('error', 'No payment record found for this order.');
            return res.redirect('/admin/deliveries');
        }

        if (payment.status === 'refunded') {
            req.flash('error', 'Payment already refunded.');
            return res.redirect('/admin/deliveries');
        }

        return Order.findById(orderId, (orderErr, orderRows) => {
            if (orderErr) {
                console.error('Error fetching order for refund:', orderErr);
                req.flash('error', 'Unable to process refund.');
                return res.redirect('/admin/deliveries');
            }

            const order = orderRows && orderRows[0];
            if (!order) {
                req.flash('error', 'Order not found.');
                return res.redirect('/admin/deliveries');
            }

            const refundAmount = Number(payment.amount || 0);
            Wallet.creditWithType(order.user_id, refundAmount, 'refund', `refund:order:${orderId}`, (walletErr) => {
                if (walletErr) {
                    console.error('Error crediting wallet refund:', walletErr);
                    req.flash('error', 'Unable to credit wallet refund.');
                    return res.redirect('/admin/deliveries');
                }

                return Payment.markRefunded(payment.id, (markErr) => {
                    if (markErr) {
                        console.error('Error updating refund status:', markErr);
                        req.flash('error', 'Refund processed but status update failed.');
                        return res.redirect('/admin/deliveries');
                    }

                    req.flash('success', 'Refund credited to customer wallet balance.');
                    return res.redirect('/admin/deliveries');
                });
            });
        });
    });
};

module.exports = {
    createPaypalOrder,
    capturePaypalOrder,
    generateNetsQr,
    showNetsFail,
    confirmNetsPayment,
    refundPayment,
    streamNetsPaymentStatus,
    showWallet,
    createPaypalTopupOrder,
    capturePaypalTopup,
    createNetsTopup,
    confirmNetsTopup,
    createStripePaymentIntent,
    confirmStripeOrder,
    createStripePaynow,
    confirmStripePaynowOrder
};
