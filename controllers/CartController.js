const db = require('../db');

const ensureCart = (req) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }
};

const findCartItem = (cart, productId) =>
    cart.find(item => item.productId === productId);

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

        if (existingItem) {
            existingItem.quantity += quantity;
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
                quantity: quantity,
                image: product.image
            });
        }

        req.flash('success', 'Item added to cart.');
        return res.redirect('/cart');
    });
};

const viewCart = (req, res) => {
    if (!ensureShopperRole(req, res)) {
        return;
    }

    ensureCart(req);
    res.render('cart', {
        cart: req.session.cart,
        user: req.session.user,
        messages: req.flash('success'),
        errors: req.flash('error')
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
        req.session.cart = req.session.cart.filter(cartItem => cartItem.productId !== productId);
        req.flash('success', 'Item removed from cart.');
    } else {
        item.quantity = quantity;
        req.flash('success', 'Cart updated successfully.');
    }

    return res.redirect('/cart');
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
    req.session.cart = req.session.cart.filter(cartItem => cartItem.productId !== productId);

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
