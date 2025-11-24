const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const app = express();

const userController = require('./controllers/UserController');
const cartController = require('./controllers/CartController');
const productController = require('./controllers/ProductController');
const orderController = require('./controllers/OrderController');
const reviewController = require('./controllers/ReviewController');
const Product = require('./models/product');
const Order = require('./models/order');

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

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// Set up view engine
app.set('view engine', 'ejs');
// Enable static files
app.use(express.static('public'));
// Enable form processing
app.use(express.urlencoded({
    extended: false
}));

// Session Middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));

app.use(flash());

// Make the signed-in user available to all views to avoid undefined errors
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Middleware to check if user is logged in
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    } else {
        req.flash('error', 'Please log in to view this resource');
        res.redirect('/login');
    }
};

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    } else {
        req.flash('error', 'Access denied');
        res.redirect('/shopping');
    }
};

// Middleware to restrict access based on allowed roles
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

// Routes
app.get('/', (req, res) => {
    res.render('index', {user: req.session.user});
});

app.get('/inventory', checkAuthenticated, checkAdmin, productController.showInventory);

app.get('/register', userController.showRegister);
app.post('/register', userController.register);

app.get('/login', userController.showLogin);
app.post('/login', userController.login);

app.get('/admin/users', checkAuthenticated, checkAdmin, userController.listUsers);
app.get('/admin/users/:id/edit', checkAuthenticated, checkAdmin, userController.editUserForm);
app.post('/admin/users/:id', checkAuthenticated, checkAdmin, userController.updateUserRole);
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, userController.deleteUser);

// Friendly alias for shopping
app.get('/shop', (req, res) => res.redirect('/shopping'));

app.get('/shopping', checkAuthenticated, (req, res) => {
    const activeCategory = req.query.category ? String(req.query.category).trim() : '';
    const searchTerm = req.query.search ? String(req.query.search).trim() : '';
    const sort = req.query.sort ? String(req.query.sort).trim() : '';
    const minPrice = Number.parseFloat(req.query.minPrice);
    const maxPrice = Number.parseFloat(req.query.maxPrice);

    Product.getFiltered({ category: activeCategory, search: searchTerm, sort, minPrice, maxPrice }, (error, products) => {
        if (error) {
            console.error('Error loading products:', error);
            req.flash('error', 'Unable to load products right now.');
            return res.redirect('/');
        }

        Product.getCategories((catErr, categoryRows) => {
            if (catErr) {
                console.error('Error loading categories:', catErr);
            }

            const productList = (products || []).map(decorateProduct);
            const categories = (categoryRows || []).map((row) => row.category).filter(Boolean);

            Order.getBestSellers(3, (bestErr, bestSellers) => {
                if (bestErr) {
                    console.error('Error fetching best sellers:', bestErr);
                }

                res.render('shopping', {
                    user: req.session.user,
                    products: productList,
                    categories,
                    activeCategory,
                    searchTerm,
                    sort,
                    minPrice: Number.isFinite(minPrice) ? minPrice : '',
                    maxPrice: Number.isFinite(maxPrice) ? maxPrice : '',
                    bestSellers: (bestSellers && bestSellers.length) ? bestSellers.map(decorateProduct) : [],
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            });
        });
    });
});

app.post('/add-to-cart/:id', checkAuthenticated, checkRoles('user'), cartController.addToCart);
app.get('/cart', checkAuthenticated, checkRoles('user'), cartController.viewCart);
app.post('/cart/update/:id', checkAuthenticated, checkRoles('user'), cartController.updateCartItem);
app.post('/cart/remove/:id', checkAuthenticated, checkRoles('user'), cartController.removeCartItem);
app.get('/checkout', checkAuthenticated, checkRoles('user'), orderController.showCheckout);
app.post('/checkout', checkAuthenticated, checkRoles('user'), orderController.checkout);
app.get('/orders/history', checkAuthenticated, checkRoles('user'), orderController.history);
app.post('/orders/:id/delivery', checkAuthenticated, orderController.updateDeliveryDetails);
app.post('/orders/:id/delete', checkAuthenticated, checkAdmin, orderController.deleteOrder);

app.get('/logout', userController.logout);

app.get('/product/:id', checkAuthenticated, productController.showProductDetails);
app.post('/product/:id/reviews', checkAuthenticated, checkRoles('user'), reviewController.upsert);
app.post('/product/:id/reviews/:reviewId/delete', checkAuthenticated, checkRoles('user'), reviewController.remove);

app.get('/addProduct', checkAuthenticated, checkAdmin, productController.showAddProductForm);
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), productController.addProduct);

app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, productController.showUpdateProductForm);
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), productController.updateProduct);

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, productController.deleteProduct);
app.get('/admin/deliveries', checkAuthenticated, checkAdmin, orderController.listAllDeliveries);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));


