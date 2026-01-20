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
const paymentController = require('./controllers/PaymentController');
const { attachUser, attachCartCount, checkAuthenticated, checkAdmin, checkRoles } = require('./middleware');

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
const refundStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/refunds');
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const refundUpload = multer({ storage: refundStorage });

// Set up view engine
app.set('view engine', 'ejs');
// Enable static files
app.use(express.static('public'));
// Enable form processing
app.use(express.urlencoded({
    extended: false
}));
app.use(express.json());

// Session Middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));

app.use(flash());

// Make the signed-in user available to all views to avoid undefined errors
app.use(attachUser);

// Make cart item count available to all views
app.use(attachCartCount);

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

app.get('/shopping', checkAuthenticated, productController.showShopping);

app.post('/add-to-cart/:id', checkAuthenticated, checkRoles('user'), cartController.addToCart);
app.get('/cart', checkAuthenticated, checkRoles('user'), cartController.viewCart);
app.post('/cart/update/:id', checkAuthenticated, checkRoles('user'), cartController.updateCartItem);
app.post('/cart/remove/:id', checkAuthenticated, checkRoles('user'), cartController.removeCartItem);
app.get('/checkout', checkAuthenticated, checkRoles('user'), orderController.showCheckout);
app.post('/checkout', checkAuthenticated, checkRoles('user'), orderController.startPayment);
app.get('/payment', checkAuthenticated, checkRoles('user'), orderController.showPayment);
app.post('/payment/confirm', checkAuthenticated, checkRoles('user'), orderController.checkout);
app.post('/paypal/create-order', checkAuthenticated, checkRoles('user'), paymentController.createPaypalOrder);
app.post('/paypal/capture-order', checkAuthenticated, checkRoles('user'), paymentController.capturePaypalOrder);
app.post('/nets-qr/create', checkAuthenticated, checkRoles('user'), paymentController.generateNetsQr);
app.post('/nets-qr/confirm', checkAuthenticated, checkRoles('user'), paymentController.confirmNetsPayment);
app.get('/nets-qr/confirm', checkAuthenticated, checkRoles('user'), paymentController.confirmNetsPayment);
app.get('/nets-qr/fail', checkAuthenticated, checkRoles('user'), paymentController.showNetsFail);
app.get('/sse/payment-status/:txnRetrievalRef', checkAuthenticated, checkRoles('user'), paymentController.streamNetsPaymentStatus);
app.post('/payments/:orderId/refund', checkAuthenticated, checkAdmin, paymentController.refundPayment);
app.get('/wallet', checkAuthenticated, checkRoles('user'), paymentController.showWallet);
app.post('/wallet/topup/paypal/create-order', checkAuthenticated, checkRoles('user'), paymentController.createPaypalTopupOrder);
app.post('/wallet/topup/paypal/capture', checkAuthenticated, checkRoles('user'), paymentController.capturePaypalTopup);
app.post('/wallet/topup/nets/create', checkAuthenticated, checkRoles('user'), paymentController.createNetsTopup);
app.get('/wallet/topup/nets/confirm', checkAuthenticated, checkRoles('user'), paymentController.confirmNetsTopup);
app.get('/orders/history', checkAuthenticated, checkRoles('user'), orderController.history);
app.post('/orders/:id/delivery', checkAuthenticated, orderController.updateDeliveryDetails);
app.post('/orders/:id/refund-request', checkAuthenticated, checkRoles('user'), refundUpload.single('refundImage'), orderController.submitRefundRequest);
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
