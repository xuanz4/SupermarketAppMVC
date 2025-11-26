const db = require('../db');
const cartStore = require('../models/cartStorage');

const ensureCart = (req) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }
};

const findCartItem = (cart, productId) =>
    cart.find(item => item.productId === productId);

// Hard cap safeguard; real limit is stock on hand
const MAX_CART_QTY = 9999;

const ensureShopperRole = (req, res) => {
    if (req.session.user) {
        return true; // allow any authenticated user (admin or normal)
    }
    req.flash('error', 'Please log in to continue.');
    res.redirect('/login');
    return false;
};

const calculatePricing = (product) => {
    const basePrice = Number.parseFloat(product.price) || 0;
    const discountPercentage = Math.min(
        100,
        Math.max(0, Number.parseFloat(product.discountPercentage) || 0)
    );
    const hasDiscount = discountPercentage > 0;
    const discountedPrice = hasDiscount
        ? Number((basePrice * (1 - discountPercentage / 100)).toFixed(2))
        : Number(basePrice.toFixed(2));

    return {
        basePrice: Number(basePrice.toFixed(2)),
        discountPercentage,
        finalPrice: discountedPrice,
        hasDiscount
    };
};

const hydrateCart = (req, res, done) => {
    if (!req.session.user) {
        ensureCart(req);
        return done();
    }
    if (req.session.cart) {
        return done();
    }

    cartStore.load(req.session.user.id, (storeErr, storedItems) => {
        if (storeErr) {
            console.error('Error loading stored cart:', storeErr);
            ensureCart(req);
            return done();
        }
        const ids = (storedItems || []).map(item => item.productId).filter(Boolean);
        if (!ids.length) {
            ensureCart(req);
            return done();
        }
        const placeholders = ids.map(() => '?').join(',');
        const sql = `SELECT * FROM products WHERE id IN (${placeholders})`;
        db.query(sql, ids, (err, rows) => {
            if (err) {
                console.error('Error hydrating cart products:', err);
                ensureCart(req);
                return done();
            }
            const byId = new Map();
            (rows || []).forEach(r => byId.set(Number(r.id), r));
            const hydrated = [];
            (storedItems || []).forEach((item) => {
                const product = byId.get(Number(item.productId));
                if (!product) {
                    return;
                }
                const pricing = calculatePricing(product);
                const offerMessage = product.offerMessage ? String(product.offerMessage).trim() : null;
                hydrated.push({
                    productId: product.id,
                    productName: product.productName,
                    price: pricing.finalPrice,
                    originalPrice: pricing.basePrice,
                    discountPercentage: pricing.discountPercentage,
                    offerMessage,
                    hasDiscount: pricing.hasDiscount,
                    quantity: item.quantity,
                    image: product.image
                });
            });
            req.session.cart = hydrated;
            return done();
        });
    });
};

const persistCartIfNeeded = (req) => {
    if (!req.session.user) return;
    cartStore.save(req.session.user.id, req.session.cart || [], (err) => {
        if (err) {
            console.error('Error saving cart:', err);
        }
    });
};

const addToCart = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10) || 1;

    if (Number.isNaN(productId)) {
        req.flash('error', 'Invalid product selected.');
        return res.redirect('/shopping');
    }

    hydrateCart(req, res, () => {
        db.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
            if (error) {
                console.error('Error fetching product:', error);
                req.flash('error', 'Unable to add product to cart at this time.');
                return res.redirect('/shopping');
            }

            if (results.length === 0) {
                req.flash('error', 'Product not found.');
                return res.redirect('/shopping');
            }

            ensureCart(req);
            const product = results[0];
            const existingItem = findCartItem(req.session.cart, productId);
            const pricing = calculatePricing(product);
            const offerMessage = product.offerMessage ? String(product.offerMessage).trim() : null;

            const existingQty = existingItem ? existingItem.quantity : 0;
            const remainingStock = Math.max(0, Number(product.quantity) || 0);
            const maxTotalAllowed = Math.min(remainingStock, MAX_CART_QTY);
            const allowedToAdd = Math.max(0, maxTotalAllowed - existingQty);
            const finalAdd = Math.min(quantity, allowedToAdd);

            if (finalAdd <= 0) {
                req.flash('error', 'Not enough stock available.');
                return res.redirect('/cart');
            }

            const cappedNote = finalAdd < quantity ? ` Limited to ${finalAdd} in cart based on stock.` : '';

            if (existingItem) {
                existingItem.quantity = existingQty + finalAdd;
                existingItem.price = pricing.finalPrice;
                existingItem.originalPrice = pricing.basePrice;
                existingItem.discountPercentage = pricing.discountPercentage;
                existingItem.offerMessage = offerMessage;
                existingItem.hasDiscount = pricing.hasDiscount;
            } else {
                req.session.cart.push({
                    productId: product.id,
                    productName: product.productName,
                    price: pricing.finalPrice,
                    originalPrice: pricing.basePrice,
                    discountPercentage: pricing.discountPercentage,
                    offerMessage,
                    hasDiscount: pricing.hasDiscount,
                    quantity: finalAdd,
                    image: product.image
                });
            }

            persistCartIfNeeded(req);
            req.flash('success', `Item added to cart.${cappedNote}`.trim());
            return res.redirect('/cart');
        });
    });
};

const viewCart = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    hydrateCart(req, res, () => {
        ensureCart(req);
        const cart = req.session.cart;
        if (!cart.length) {
            return res.render('cart', {
                cart,
                user: req.session.user,
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        }

        const ids = cart
            .map(item => item.productId)
            .filter((v, i, arr) => Number.isFinite(v) && arr.indexOf(v) === i);

        if (!ids.length) {
            return res.render('cart', {
                cart,
                user: req.session.user,
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        }

        const placeholders = ids.map(() => '?').join(',');
        const sql = `SELECT id, quantity FROM products WHERE id IN (${placeholders})`;

        db.query(sql, ids, (err, rows) => {
            if (err) {
                console.error('Error fetching stock for cart:', err);
            }
            const stockMap = new Map();
            (rows || []).forEach(r => {
                stockMap.set(Number(r.id), Number(r.quantity));
            });

            const decoratedCart = cart.map(item => {
                const onHand = stockMap.has(Number(item.productId)) ? Number(stockMap.get(Number(item.productId))) : 0;
                const maxAllowed = Math.max(1, Math.min(MAX_CART_QTY, Math.max(0, onHand)));
                return { ...item, maxAllowed };
            });

            res.render('cart', {
                cart: decoratedCart,
                user: req.session.user,
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        });
    });
};

const updateCartItem = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    hydrateCart(req, res, () => {
        const productId = parseInt(req.params.id, 10);
        const quantity = parseInt(req.body.quantity, 10);

        ensureCart(req);

        if (Number.isNaN(productId)) {
            req.flash('error', 'Invalid product.');
            return res.redirect('/cart');
        }

        const item = findCartItem(req.session.cart, productId);
        if (!item) {
            req.flash('error', 'Item not found in cart.');
            return res.redirect('/cart');
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            req.session.cart = req.session.cart.filter(cartItem => cartItem.productId !== productId);
            persistCartIfNeeded(req);
            req.flash('success', 'Item removed from cart.');
            return res.redirect('/cart');
        }

        const productSql = 'SELECT quantity FROM products WHERE id = ?';
        db.query(productSql, [productId], (err, rows) => {
            if (err) {
                console.error('Error checking stock for update:', err);
                req.flash('error', 'Unable to update stock.');
                return res.redirect('/cart');
            }
            const available = rows && rows[0] ? Number(rows[0].quantity) || 0 : 0;
            const maxAllowed = Math.max(1, Math.min(MAX_CART_QTY, available));
            const requestedQty = Number.isFinite(quantity) ? quantity : 0;
            const targetQty = Math.min(requestedQty, maxAllowed);

            if (requestedQty > maxAllowed) {
                req.flash('error', `Only ${maxAllowed} available right now.`);
            }

            item.quantity = targetQty;
            persistCartIfNeeded(req);
            req.flash('success', 'Cart updated successfully.');
            return res.redirect('/cart');
        });
    });
};

const removeCartItem = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    hydrateCart(req, res, () => {
        const productId = parseInt(req.params.id, 10);

        ensureCart(req);

        if (Number.isNaN(productId)) {
            req.flash('error', 'Invalid product.');
            return res.redirect('/cart');
        }

        const originalLength = req.session.cart.length;
        req.session.cart = req.session.cart.filter(cartItem => cartItem.productId !== productId);

        if (req.session.cart.length === originalLength) {
            req.flash('error', 'Item not found in cart.');
        } else {
            persistCartIfNeeded(req);
            req.flash('success', 'Item removed from cart.');
        }

        return res.redirect('/cart');
    });
};

module.exports = {
    addToCart,
    viewCart,
    updateCartItem,
    removeCartItem
};
