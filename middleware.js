const cartStore = require('./models/cartStorage');

const attachUser = (req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
};

const attachCartCount = (req, res, next) => {
    const computeCount = (items) => (items || []).reduce((sum, item) => {
        const qty = Number(item && item.quantity);
        return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
    }, 0);

    if (!req.session.user) {
        res.locals.cartCount = computeCount(req.session.cart);
        return next();
    }

    if (Array.isArray(req.session.cart)) {
        res.locals.cartCount = computeCount(req.session.cart);
        return next();
    }

    cartStore.load(req.session.user.id, (err, storedItems) => {
        if (err) {
            console.error('Error loading cart count:', err);
            res.locals.cartCount = 0;
            return next();
        }
        res.locals.cartCount = computeCount(storedItems);
        return next();
    });
};

const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    req.flash('error', 'Access denied');
    res.redirect('/shopping');
};

// Role guard: admin or listed roles; if no roles provided, any signed-in user is allowed
const checkRoles = (...roles) => (req, res, next) => {
    if (req.session.user) {
        if (req.session.user.role === 'admin') {
            return next();
        }
        if (!roles.length || roles.includes(req.session.user.role)) {
            return next();
        }
        req.flash('error', 'Access denied');
        return res.redirect('/orders/history');
    }
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};

module.exports = {
    attachUser,
    attachCartCount,
    checkAuthenticated,
    checkAdmin,
    checkRoles
};
