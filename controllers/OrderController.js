const Order = require('../models/order');
const User = require('../models/user');
const cartStore = require('../models/cartStorage');
const Payment = require('../models/payment');
const RefundRequest = require('../models/refundRequest');
const Wallet = require('../models/wallet');

const DELIVERY_FEE = 1.5;
const ALLOWED_STATUSES = ['processing', 'dispatched', 'delivered'];

const ensureCart = (req) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }
};

const normalisePrice = (value) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }
    return Number(parsed.toFixed(2));
};

const decorateProduct = (product) => {
    if (!product) {
        return product;
    }

    const basePrice = normalisePrice(product.price);
    const discountPercentage = Math.min(
        100,
        Math.max(0, Number.parseFloat(product.discountPercentage) || 0)
    );
    const hasDiscount = discountPercentage > 0;
    const offerMessage = product.offerMessage ? String(product.offerMessage).trim() : null;
    const effectivePrice = hasDiscount
        ? normalisePrice(basePrice * (1 - discountPercentage / 100))
        : basePrice;

    return {
        ...product,
        price: basePrice,
        discountPercentage,
        offerMessage,
        effectivePrice,
        hasDiscount
    };
};

const computeDeliveryFee = (user, deliveryMethod, waiveFee = false) => {
    if (deliveryMethod !== 'delivery') {
        return 0;
    }

    if (waiveFee) {
        return 0;
    }

    if (user && (user.free_delivery || user.free_delivery === 1)) {
        return 0;
    }

    return DELIVERY_FEE;
};

const sanitiseDeliveryAddress = (address) => {
    if (!address) {
        return null;
    }
    const trimmed = address.trim();
    return trimmed.length ? trimmed.slice(0, 255) : null;
};

/**
 * Show checkout form for delivery details.
 */
const showCheckout = (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can checkout.');
        return res.redirect('/cart');
    }

    const cartItems = req.session.cart;

    if (!cartItems.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    const itemsTotal = cartItems.reduce((sum, item) => {
        const unitPrice = Number(item.price);
        const quantity = Number(item.quantity);
        if (!Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
            return sum;
        }
        return sum + (unitPrice * quantity);
    }, 0);

    const decoratedCart = cartItems.map((item) => ({
        ...item,
        lineTotal: Number((Number(item.price) * Number(item.quantity)).toFixed(2))
    }));

    res.render('checkout', {
        user: req.session.user,
        cart: decoratedCart,
        itemsTotal: Number(itemsTotal.toFixed(2)),
        deliveryFee: computeDeliveryFee(req.session.user, 'delivery'),
        pickupEta: 'Ready in 15-25 mins',
        deliveryEta: 'Arrives in 40-70 mins',
        messages: req.flash('success'),
        errors: req.flash('error')
    });
};

/**
 * Handle checkout form submission and move to payment screen.
 */
const startPayment = (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can proceed to payment.');
        return res.redirect('/cart');
    }

    const cartItems = req.session.cart;

    if (!cartItems.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    const deliveryMethod = req.body.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';
    const providedAddress = sanitiseDeliveryAddress(req.body.deliveryAddress) || req.session.user.address;
    const deliveryAddress = deliveryMethod === 'delivery' ? sanitiseDeliveryAddress(providedAddress) : null;

    if (deliveryMethod === 'delivery' && !deliveryAddress) {
        req.flash('error', 'Please provide a delivery address.');
        return res.redirect('/checkout');
    }

    const deliveryFee = computeDeliveryFee(req.session.user, deliveryMethod);

    req.session.pendingCheckout = {
        deliveryMethod,
        deliveryAddress,
        deliveryFee,
        fullName: (req.body.fullName || '').trim(),
        email: (req.body.email || '').trim(),
        contact: (req.body.contact || '').trim()
    };

    return res.redirect('/payment');
};

/**
 * Show payment page with order summary.
 */
const showPayment = (req, res) => {
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

    const itemsTotal = cartItems.reduce((sum, item) => {
        const unitPrice = Number(item.price);
        const quantity = Number(item.quantity);
        if (!Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
            return sum;
        }
        return sum + (unitPrice * quantity);
    }, 0);

    const decoratedCart = cartItems.map((item) => ({
        ...item,
        lineTotal: Number((Number(item.price) * Number(item.quantity)).toFixed(2))
    }));

    Wallet.getBalance(req.session.user.id, (balanceErr, walletBalance) => {
        if (balanceErr) {
            console.error('Error fetching wallet balance:', balanceErr);
        }

        res.render('payment', {
            user: req.session.user,
            cart: decoratedCart,
            itemsTotal: Number(itemsTotal.toFixed(2)),
            deliveryFee: Number(pending.deliveryFee || 0),
            pending,
            totalWithFees: Number((itemsTotal + (Number(pending.deliveryFee || 0))).toFixed(2)),
            paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            walletBalance: Number(walletBalance || 0),
            messages: req.flash('success'),
            errors: req.flash('error')
        });
    });
};

/**
 * Handle payment confirmation and order creation.
 */
const checkout = (req, res) => {
    ensureCart(req);

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can complete checkout.');
        return res.redirect('/cart');
    }

    const cartItems = req.session.cart;

    if (!cartItems.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    const pending = req.session.pendingCheckout;
    const deliveryMethod = pending ? pending.deliveryMethod : (req.body.deliveryMethod === 'delivery' ? 'delivery' : 'pickup');
    const providedAddress = pending ? pending.deliveryAddress : (sanitiseDeliveryAddress(req.body.deliveryAddress) || req.session.user.address);
    const deliveryAddress = deliveryMethod === 'delivery' ? sanitiseDeliveryAddress(providedAddress) : null;

    if (deliveryMethod === 'delivery' && !deliveryAddress) {
        req.flash('error', 'Please provide a delivery address.');
        return res.redirect('/payment');
    }

    const paymentMethod = ['paypal', 'nets', 'wallet', 'stripe', 'stripe_paynow'].includes(req.body.paymentMethod)
        ? req.body.paymentMethod
        : 'paypal';

    if (paymentMethod === 'paypal') {
        req.flash('error', 'Please complete the PayPal payment using the PayPal button.');
        return res.redirect('/payment');
    }

    if (paymentMethod === 'nets') {
        req.flash('error', 'Please generate the NETS QR code to continue.');
        return res.redirect('/payment');
    }

    if (paymentMethod === 'stripe') {
        req.flash('error', 'Please complete the Stripe payment.');
        return res.redirect('/payment');
    }

    if (paymentMethod === 'stripe_paynow') {
        req.flash('error', 'Please complete the Stripe PayNow payment.');
        return res.redirect('/payment');
    }
    if (paymentMethod === 'wallet') {
        const deliveryFee = pending ? Number(pending.deliveryFee || 0) : computeDeliveryFee(req.session.user, deliveryMethod);

        return Order.createWithWallet(req.session.user.id, cartItems, {
            deliveryMethod,
            deliveryAddress,
            deliveryFee
        }, (walletErr, result) => {
            if (walletErr) {
                req.flash('error', walletErr.message || 'Unable to use wallet balance.');
                return res.redirect('/payment');
            }

            if (result && result.orderId) {
                Payment.create(result.orderId, {
                    provider: 'wallet',
                    status: 'paid',
                    amount: Number(result.total || 0),
                    currency: 'SGD',
                    providerRef: `wallet:${req.session.user.id}`
                }, (paymentErr) => {
                    if (paymentErr) {
                        console.error('Error saving wallet payment:', paymentErr);
                    }
                });
            }

            req.session.cart = [];
            req.session.pendingCheckout = null;
            if (req.session.user) {
                req.session.user.wallet_balance = Number(result.walletBalance || 0);
                cartStore.save(req.session.user.id, [], (clearErr) => {
                    if (clearErr) {
                        console.error('Error clearing persisted cart after wallet checkout:', clearErr);
                    }
                });
            }

            req.flash('success', 'Thanks for your purchase! Wallet payment recorded.');
            return res.redirect('/orders/history');
        });
    }

    const deliveryFee = pending ? Number(pending.deliveryFee || 0) : computeDeliveryFee(req.session.user, deliveryMethod);

    Order.create(req.session.user.id, cartItems, { deliveryMethod, deliveryAddress, deliveryFee }, (error) => {
        if (error) {
            console.error('Error during checkout:', error);
            req.flash('error', error.message || 'Unable to complete checkout. Please try again.');
            return res.redirect('/cart');
        }

        req.session.cart = [];
        req.session.pendingCheckout = null;
        if (req.session.user) {
            cartStore.save(req.session.user.id, [], (clearErr) => {
                if (clearErr) {
                    console.error('Error clearing persisted cart after checkout:', clearErr);
                }
            });
        }
        const paymentCopy = 'Payment recorded.';
        req.flash('success', `Thanks for your purchase! ${paymentCopy} ${deliveryMethod === 'delivery' ? 'We will deliver your order shortly.' : 'Pickup details will be shared soon.'}`);
        return res.redirect('/orders/history');
    });
};

/**
 * Display purchase history for the logged-in user.
 */
const history = (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to view purchases.');
        return res.redirect('/login');
    }

    if (req.session.user.role === 'admin') {
        req.flash('error', 'Admins manage deliveries instead of viewing shopper orders.');
        return res.redirect('/admin/deliveries');
    }

    Order.findByUser(req.session.user.id, (ordersError, orderRows) => {
        if (ordersError) {
            console.error('Error fetching purchase history:', ordersError);
            req.flash('error', 'Unable to load purchase history.');
            return res.redirect('/shopping');
        }

        const orders = (orderRows || []).map((order) => ({
            ...order,
            delivery_method: order.delivery_method || 'pickup',
            delivery_address: order.delivery_address,
            delivery_fee: Number(order.delivery_fee || 0),
            status: order.status || 'processing'
        }));
        const orderIds = orders.map(order => order.id);

        Order.findItemsByOrderIds(orderIds, (itemsError, itemRows) => {
            if (itemsError) {
                console.error('Error fetching order items:', itemsError);
                req.flash('error', 'Unable to load purchase history.');
                return res.redirect('/shopping');
            }

            const itemsByOrder = orderIds.reduce((acc, id) => {
                acc[id] = [];
                return acc;
            }, {});

            (itemRows || []).forEach((item) => {
                if (!itemsByOrder[item.order_id]) {
                    itemsByOrder[item.order_id] = [];
                }
                itemsByOrder[item.order_id].push(item);
            });

            Payment.findByOrderIds(orderIds, (paymentErr, paymentRows) => {
                if (paymentErr) {
                    console.error('Error fetching payments:', paymentErr);
                }

                const paymentByOrder = (paymentRows || []).reduce((acc, payment) => {
                    if (!acc[payment.order_id]) {
                        acc[payment.order_id] = payment;
                    }
                    return acc;
                }, {});

                RefundRequest.findByOrderIds(orderIds, (refundErr, refundRows) => {
                    if (refundErr) {
                        console.error('Error fetching refund requests:', refundErr);
                    }

                    const refundByOrder = (refundRows || []).reduce((acc, request) => {
                        if (!acc[request.order_id]) {
                            acc[request.order_id] = request;
                        }
                        return acc;
                    }, {});

                    const ordersWithRefunds = orders.map((order) => ({
                        ...order,
                        payment: paymentByOrder[order.id] || null,
                        refundRequest: refundByOrder[order.id] || null
                    }));

                    Order.getBestSellers(4, (bestErr, bestRows) => {
                        if (bestErr) {
                            console.error('Error fetching best sellers:', bestErr);
                        }

                        res.render('orderHistory', {
                            user: req.session.user,
                            orders: ordersWithRefunds,
                            orderItems: itemsByOrder,
                            bestSellers: (bestRows || []).map(decorateProduct),
                            messages: req.flash('success'),
                            errors: req.flash('error')
                        });
                    });
                });
            });
        });
    });
};

const listAllDeliveries = (req, res) => {
    Order.findAllWithUsers((orderErr, orderRows) => {
        if (orderErr) {
            console.error('Error fetching deliveries:', orderErr);
            req.flash('error', 'Unable to load deliveries.');
            return res.redirect('/inventory');
        }

        const orders = orderRows || [];
        const orderIds = orders.map(order => order.id);

        Order.findItemsByOrderIds(orderIds, (itemsErr, itemRows) => {
            if (itemsErr) {
                console.error('Error fetching delivery items:', itemsErr);
                req.flash('error', 'Unable to load deliveries.');
                return res.redirect('/inventory');
            }

            const itemsByOrder = orderIds.reduce((acc, id) => {
                acc[id] = [];
                return acc;
            }, {});

            (itemRows || []).forEach((item) => {
                if (!itemsByOrder[item.order_id]) {
                    itemsByOrder[item.order_id] = [];
                }
                itemsByOrder[item.order_id].push(item);
            });

            Payment.findByOrderIds(orderIds, (paymentErr, paymentRows) => {
                if (paymentErr) {
                    console.error('Error fetching payments:', paymentErr);
                }

                const paymentByOrder = (paymentRows || []).reduce((acc, payment) => {
                    if (!acc[payment.order_id]) {
                        acc[payment.order_id] = payment;
                    }
                    return acc;
                }, {});

                RefundRequest.findByOrderIds(orderIds, (refundErr, refundRows) => {
                    if (refundErr) {
                        console.error('Error fetching refund requests:', refundErr);
                    }

                    const refundByOrder = (refundRows || []).reduce((acc, request) => {
                        if (!acc[request.order_id]) {
                            acc[request.order_id] = request;
                        }
                        return acc;
                    }, {});

                    const ordersWithPayments = orders.map((order) => ({
                        ...order,
                        payment: paymentByOrder[order.id] || null,
                        refundRequest: refundByOrder[order.id] || null
                    }));

                    res.render('adminDeliveries', {
                        user: req.session.user,
                        orders: ordersWithPayments,
                        orderItems: itemsByOrder,
                        messages: req.flash('success'),
                        errors: req.flash('error')
                    });
                });
            });
        });
    });
};

const updateDeliveryDetails = (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect(req.session.user && req.session.user.role === 'admin' ? '/admin/deliveries' : '/orders/history');
    }

    Order.findById(orderId, (orderErr, orderRows) => {
        if (orderErr) {
            console.error('Error locating order for delivery update:', orderErr);
            req.flash('error', 'Unable to update delivery.');
            return res.redirect(req.session.user && req.session.user.role === 'admin' ? '/admin/deliveries' : '/orders/history');
        }

        if (!orderRows || !orderRows.length) {
            req.flash('error', 'Order not found.');
            return res.redirect(req.session.user && req.session.user.role === 'admin' ? '/admin/deliveries' : '/orders/history');
        }

        const order = orderRows[0];
        const sessionUser = req.session.user;
        const isAdmin = sessionUser && sessionUser.role === 'admin';
        const isOwner = sessionUser && sessionUser.id === order.user_id;

        if (!isAdmin && !isOwner) {
            req.flash('error', 'You are not authorised to update this delivery.');
            return res.redirect('/orders/history');
        }

        User.findById(order.user_id, (userErr, userRows) => {
            if (userErr) {
                console.error('Error fetching user for delivery update:', userErr);
                req.flash('error', 'Unable to update delivery.');
                return res.redirect(isAdmin ? '/admin/deliveries' : '/orders/history');
            }

            const account = userRows && userRows[0];
            const deliveryMethod = isAdmin
                ? (req.body.deliveryMethod === 'delivery' ? 'delivery' : 'pickup')
                : (order.delivery_method || 'pickup');
            const statusInput = req.body.status;
            const requestedAddress = sanitiseDeliveryAddress(req.body.deliveryAddress) || (account ? account.address : null);
            const waiveFee = isAdmin && (req.body.waiveFee === 'on' || req.body.waiveFee === 'true');
            const deliveryFee = computeDeliveryFee(account, deliveryMethod, waiveFee);
            const status = isAdmin && ALLOWED_STATUSES.includes(statusInput) ? statusInput : (order.status || 'processing');
            const redirectPath = isAdmin ? '/admin/deliveries' : '/orders/history';

            if (deliveryMethod === 'delivery' && !requestedAddress) {
                req.flash('error', 'Delivery address is required.');
                return res.redirect(redirectPath);
            }

            Order.updateDelivery(orderId, {
                deliveryMethod,
                deliveryAddress: deliveryMethod === 'delivery' ? requestedAddress : null,
                deliveryFee,
                status
            }, (updateErr) => {
                if (updateErr) {
                    console.error('Error updating delivery details:', updateErr);
                    req.flash('error', 'Unable to update delivery right now.');
                    return res.redirect(redirectPath);
                }

                if (!isAdmin && sessionUser && deliveryMethod === 'delivery') {
                    sessionUser.address = requestedAddress;
                }

                req.flash('success', 'Delivery details updated.');
                return res.redirect(redirectPath);
            });
        });
    });
};

const deleteOrder = (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect('/admin/deliveries');
    }

    if (!req.session.user || req.session.user.role !== 'admin') {
        req.flash('error', 'Only admins can delete orders.');
        return res.redirect('/orders/history');
    }

    Order.remove(orderId, (err, result) => {
        if (err) {
            console.error('Error deleting order:', err);
            req.flash('error', 'Unable to delete order right now.');
            return res.redirect('/admin/deliveries');
        }

        if (!result || result.affectedRows === 0) {
            req.flash('error', 'Order not found or already removed.');
            return res.redirect('/admin/deliveries');
        }

        req.flash('success', 'Order deleted.');
        return res.redirect('/admin/deliveries');
    });
};

const showRefundPage = (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect('/orders/history');
    }

    if (!req.session.user) {
        req.flash('error', 'Please log in to request a refund.');
        return res.redirect('/login');
    }

    Order.findById(orderId, (orderErr, orderRows) => {
        if (orderErr) {
            console.error('Error fetching order for refund page:', orderErr);
            req.flash('error', 'Unable to load refund page.');
            return res.redirect('/orders/history');
        }

        const order = orderRows && orderRows[0];
        if (!order || order.user_id !== req.session.user.id) {
            req.flash('error', 'Order not found.');
            return res.redirect('/orders/history');
        }

        RefundRequest.findByOrderId(order.id, (refundErr, refundRows) => {
            if (refundErr) {
                console.error('Error fetching refund request:', refundErr);
            }

            const existingRequest = refundRows && refundRows[0] ? refundRows[0] : null;

            Order.findItemsByOrderIds([order.id], (itemsErr, itemRows) => {
                if (itemsErr) {
                    console.error('Error fetching order items for refund page:', itemsErr);
                }
                res.render('refundRequestPage', {
                    user: req.session.user,
                    order,
                    items: itemRows || [],
                    refundRequest: existingRequest,
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            });
        });
    });
};

const showInvoicePage = (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect('/orders/history');
    }

    if (!req.session.user) {
        req.flash('error', 'Please log in to view invoices.');
        return res.redirect('/login');
    }

    Order.findById(orderId, (orderErr, orderRows) => {
        if (orderErr) {
            console.error('Error fetching order for invoice:', orderErr);
            req.flash('error', 'Unable to load invoice.');
            return res.redirect('/orders/history');
        }

        const order = orderRows && orderRows[0];
        if (!order || order.user_id !== req.session.user.id) {
            req.flash('error', 'Order not found.');
            return res.redirect('/orders/history');
        }

        Order.findItemsByOrderIds([order.id], (itemsErr, itemRows) => {
            if (itemsErr) {
                console.error('Error fetching order items for invoice:', itemsErr);
            }

            res.render('invoice', {
                user: req.session.user,
                order,
                items: itemRows || [],
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        });
    });
};

const submitRefundRequest = (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
        req.flash('error', 'Invalid order selected.');
        return res.redirect('/orders/history');
    }

    if (!req.session.user || req.session.user.role !== 'user') {
        req.flash('error', 'Only shoppers can request refunds.');
        return res.redirect('/orders/history');
    }

    const reasonType = typeof req.body.reasonType === 'string' ? req.body.reasonType.trim() : '';
    const reasonText = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const reason = reasonType
        ? `${reasonType} – ${reasonText}`
        : reasonText;
    if (!reason) {
        req.flash('error', 'Please provide a reason for the refund request.');
        return res.redirect('/orders/history');
    }

    Order.findById(orderId, (orderErr, orderRows) => {
        if (orderErr) {
            console.error('Error fetching order for refund request:', orderErr);
            req.flash('error', 'Unable to submit refund request.');
            return res.redirect('/orders/history');
        }

        const order = orderRows && orderRows[0];
        if (!order || order.user_id !== req.session.user.id) {
            req.flash('error', 'Order not found or not yours.');
            return res.redirect('/orders/history');
        }

        RefundRequest.findByOrderId(orderId, (refundErr, refundRows) => {
            if (refundErr) {
                console.error('Error checking refund request:', refundErr);
                req.flash('error', 'Unable to submit refund request.');
                return res.redirect('/orders/history');
            }

            const existingRequest = refundRows && refundRows[0] ? refundRows[0] : null;
            if (existingRequest) {
                const statusLabel = (existingRequest.status || 'pending').toUpperCase();
                req.flash('error', `Refund request already submitted (${statusLabel}).`);
                return res.redirect('/orders/history');
            }

            const imagePath = req.file ? `/uploads/refunds/${req.file.filename}` : null;

            RefundRequest.create(orderId, req.session.user.id, {
                reason: reason.slice(0, 500),
                imagePath,
                status: 'pending'
            }, (createErr) => {
                if (createErr) {
                    console.error('Error creating refund request:', createErr);
                    req.flash('error', 'Unable to submit refund request right now.');
                    return res.redirect('/orders/history');
                }

                req.flash('success', 'Refund request submitted.');
                return res.redirect('/orders/history');
            });
        });
    });
};

module.exports = {
    showCheckout,
    startPayment,
    showPayment,
    checkout,
    history,
    listAllDeliveries,
    updateDeliveryDetails,
    deleteOrder,
    submitRefundRequest,
    showRefundPage,
    showInvoicePage
};


