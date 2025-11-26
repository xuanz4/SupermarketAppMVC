const db = require('../db');

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
        const allowedToAdd = Math.min(remainingStock, Math.max(0, MAX_CART_QTY - existingQty));
        const finalAdd = Math.min(quantity, allowedToAdd);

        if (finalAdd <= 0) {
            req.flash('error', 'Not enough stock available.');
            return res.redirect('/cart');
        }

        if (finalAdd < quantity) {
            req.flash('error', `Only ${finalAdd} available to add right now.`);
        }

        const updateProductSql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
        db.query(updateProductSql, [finalAdd, productId, finalAdd], (updateErr, updateRes) => {
            if (updateErr) {
                console.error('Error updating stock for cart add:', updateErr);
                req.flash('error', 'Unable to update stock for this item.');
                return res.redirect('/cart');
            }
            if (!updateRes.affectedRows) {
                req.flash('error', 'Not enough stock available.');
                return res.redirect('/cart');
            }

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

            req.flash('success', 'Item added to cart.');
            return res.redirect('/cart');
        });
    });
};

const viewCart = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

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
};

const updateCartItem = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

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
        // Return stock when removing
        const restoreSql = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
        db.query(restoreSql, [item.quantity, productId], () => {});
        req.session.cart = req.session.cart.filter(cartItem => cartItem.productId !== productId);
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
        const delta = targetQty - item.quantity;

        if (requestedQty > maxAllowed) {
            req.flash('error', `Only ${maxAllowed} available right now.`);
            if (delta === 0) {
                return res.redirect('/cart');
            }
        }

        if (delta === 0) {
            req.flash('success', 'Cart updated successfully.');
            return res.redirect('/cart');
        }

        if (delta > 0) {
            const stockSql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
            db.query(stockSql, [delta, productId, delta], (stockErr, result) => {
                if (stockErr) {
                    console.error('Error reducing stock for cart update:', stockErr);
                    req.flash('error', 'Unable to update stock.');
                    return res.redirect('/cart');
                }
                if (!result.affectedRows) {
                    req.flash('error', 'Not enough stock available.');
                    return res.redirect('/cart');
                }
                item.quantity = targetQty;
                req.flash('success', 'Cart updated successfully.');
                return res.redirect('/cart');
            });
        } else {
            const restore = Math.abs(delta);
            const restoreSql = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
            db.query(restoreSql, [restore, productId], (restoreErr) => {
                if (restoreErr) {
                    console.error('Error restoring stock for cart update:', restoreErr);
                }
                item.quantity = targetQty;
                req.flash('success', 'Cart updated successfully.');
                return res.redirect('/cart');
            });
        }
    });
};

const removeCartItem = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    const productId = parseInt(req.params.id, 10);

    ensureCart(req);

    if (Number.isNaN(productId)) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/cart');
    }

    const originalLength = req.session.cart.length;
    let removedQty = 0;
    req.session.cart = req.session.cart.filter(cartItem => {
        if (cartItem.productId === productId) {
            removedQty += cartItem.quantity;
            return false;
        }
        return true;
    });

    if (removedQty > 0) {
        const restoreSql = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
        db.query(restoreSql, [removedQty, productId], (err) => {
            if (err) {
                console.error('Error restoring stock on remove:', err);
            }
        });
    }

    if (req.session.cart.length === originalLength) {
        req.flash('error', 'Item not found in cart.');
    } else {
        req.flash('success', 'Item removed from cart.');
    }

    return res.redirect('/cart');
};

module.exports = {
    addToCart,
    viewCart,
    updateCartItem,
    removeCartItem
};
