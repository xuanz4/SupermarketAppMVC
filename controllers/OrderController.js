const Order = require('../models/order');
const User = require('../models/user');

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

    res.render('payment', {
        user: req.session.user,
        cart: decoratedCart,
        itemsTotal: Number(itemsTotal.toFixed(2)),
        deliveryFee: Number(pending.deliveryFee || 0),
        pending,
        totalWithFees: Number((itemsTotal + (Number(pending.deliveryFee || 0))).toFixed(2)),
        messages: req.flash('success'),
        errors: req.flash('error')
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

    const deliveryFee = pending ? Number(pending.deliveryFee || 0) : computeDeliveryFee(req.session.user, deliveryMethod);

    Order.create(req.session.user.id, cartItems, { deliveryMethod, deliveryAddress, deliveryFee }, (error) => {
        if (error) {
            console.error('Error during checkout:', error);
            req.flash('error', error.message || 'Unable to complete checkout. Please try again.');
            return res.redirect('/cart');
        }

        req.session.cart = [];
        req.session.pendingCheckout = null;
        req.flash('success', `Thanks for your purchase! ${deliveryMethod === 'delivery' ? 'We will deliver your order shortly.' : 'Pickup details will be shared soon.'}`);
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

            Order.getBestSellers(4, (bestErr, bestRows) => {
                if (bestErr) {
                    console.error('Error fetching best sellers:', bestErr);
                }

                res.render('orderHistory', {
                    user: req.session.user,
                    orders,
                    orderItems: itemsByOrder,
                    bestSellers: (bestRows || []).map(decorateProduct),
                    messages: req.flash('success'),
                    errors: req.flash('error')
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

            res.render('adminDeliveries', {
                user: req.session.user,
                orders,
                orderItems: itemsByOrder,
                messages: req.flash('success'),
                errors: req.flash('error')
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
            const deliveryMethod = req.body.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';
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

module.exports = {
    showCheckout,
    startPayment,
    showPayment,
    checkout,
    history,
    listAllDeliveries,
    updateDeliveryDetails,
    deleteOrder
};


