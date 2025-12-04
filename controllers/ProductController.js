const Product = require('../models/product');
const Review = require('../models/review');
const Order = require('../models/order');

const toCurrency = (value, precision = 2) => {
    const numberValue = Number.parseFloat(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) {
        return 0;
    }
    return Number(numberValue.toFixed(precision));
};

const clampDiscount = (value) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }
    if (parsed > 100) {
        return 100;
    }
    return Number(parsed.toFixed(2));
};

const normaliseOfferMessage = (message) => {
    if (!message) {
        return null;
    }
    const trimmed = message.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.slice(0, 255);
};

const buildProductPayload = (body, image) => {
    const {
        name,
        quantity,
        price,
        discount,
        offer,
        category
    } = body;

    return {
        name: name ? name.trim() : '',
        quantity: Math.max(0, Number.parseInt(quantity, 10) || 0),
        price: toCurrency(price),
        discountPercentage: clampDiscount(discount),
        offerMessage: normaliseOfferMessage(offer),
        image: image || null,
        category: category ? category.trim() || 'General' : 'General'
    };
};

const enhanceProductRecord = (product) => {
    if (!product) {
        return product;
    }

    const basePrice = toCurrency(product.price);
    const discountPercentage = clampDiscount(product.discountPercentage);
    const hasDiscount = discountPercentage > 0;
    const finalPrice = hasDiscount
        ? toCurrency(basePrice * (1 - discountPercentage / 100))
        : basePrice;

    return {
        ...product,
        price: basePrice,
        discountPercentage,
        offerMessage: normaliseOfferMessage(product.offerMessage),
        effectivePrice: finalPrice,
        hasDiscount,
        category: product.category || 'General'
    };
};

const ProductController = {
    // Show the inventory page
    showInventory: (req, res) => {
        const activeCategory = req.query.category ? String(req.query.category).trim() : '';
        const searchTerm = req.query.search ? String(req.query.search).trim() : '';
        const lowStockOnly = req.query.lowStock === '1';
        const sort = req.query.sort ? String(req.query.sort).trim() : 'stock_asc';

        Product.getFiltered({ category: activeCategory, search: searchTerm, sort, lowStockOnly }, (error, results) => {
            if (error) throw error;
            const products = (results || []).map(enhanceProductRecord);

            Product.getCategories((catErr, categoryRows) => {
                if (catErr) {
                    console.error('Error loading categories:', catErr);
                }
                const categories = (categoryRows || []).map((row) => row.category).filter(Boolean);

                res.render('inventory', {
                    products,
                    categories,
                    activeCategory,
                    searchTerm,
                    lowStockOnly,
                    sort,
                    user: req.session.user,
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            });
        });
    },

    // Show the add product page
    showAddProductForm: (req, res) => {
        res.render('addProduct', {
            user: req.session.user,
            messages: req.flash('success'),
            errors: req.flash('error')
        });
    },

    // Handle product creation
    addProduct: (req, res) => {
        const image = req.file ? req.file.filename : null;
        const productData = buildProductPayload(req.body, image);

        if (!productData.name) {
            req.flash('error', 'Product name is required.');
            return res.redirect('/addProduct');
        }

        Product.create(productData, (error, results) => {
            if (error) {
                console.error("Error adding product:", error);
                res.status(500).send('Error adding product');
            } else {
                req.flash('success', `Product "${productData.name}" added successfully.`);
                res.redirect('/inventory');
            }
        });
    },

    // Show the update product form
    showUpdateProductForm: (req, res) => {
        const productId = req.params.id;
        Product.getById(productId, (error, results) => {
            if (error) throw error;
            if (results.length > 0) {
                res.render('updateProduct', {
                    product: enhanceProductRecord(results[0]),
                    errors: req.flash('error'),
                    messages: req.flash('success')
                });
            } else {
                res.status(404).send('Product not found');
            }
        });
    },

    // Handle product update
    updateProduct: (req, res) => {
        const productId = req.params.id;
        let image = req.body.currentImage;

        if (req.file) {
            image = req.file.filename;
        }

        const productData = buildProductPayload(req.body, image);

        if (!productData.name) {
            req.flash('error', 'Product name is required.');
            return res.redirect(`/updateProduct/${productId}`);
        }

        Product.update(productId, productData, (error, results) => {
            if (error) {
                console.error("Error updating product:", error);
                res.status(500).send('Error updating product');
            } else {
                req.flash('success', `Product "${productData.name}" updated successfully.`);
                res.redirect('/inventory');
            }
        });
    },

    // Handle product deletion
    deleteProduct: (req, res) => {
        const productId = req.params.id;

        Product.delete(productId, (error, results) => {
            if (error) {
                console.error("Error deleting product:", error);
                res.status(500).send('Error deleting product');
            } else {
                req.flash('success', 'Product deleted successfully.');
                res.redirect('/inventory');
            }
        });
    },

    // Shopper catalogue
    showShopping: async (req, res) => {
        const activeCategory = req.query.category ? String(req.query.category).trim() : '';
        const searchTerm = req.query.search ? String(req.query.search).trim() : '';
        const sort = req.query.sort ? String(req.query.sort).trim() : '';
        const minPrice = Number.parseFloat(req.query.minPrice);
        const maxPrice = Number.parseFloat(req.query.maxPrice);

        const asPromise = (fn, ...args) => new Promise((resolve, reject) => {
            fn(...args, (err, result) => (err ? reject(err) : resolve(result)));
        });

        try {
            const [products, categoryRows, bestSellers] = await Promise.all([
                asPromise(Product.getFiltered, { category: activeCategory, search: searchTerm, sort, minPrice, maxPrice }),
                asPromise(Product.getCategories),
                asPromise(Order.getBestSellers, 3)
            ]);

            res.render('shopping', {
                user: req.session.user,
                products: (products || []).map(enhanceProductRecord),
                categories: (categoryRows || []).map((row) => row.category).filter(Boolean),
                activeCategory,
                searchTerm,
                sort,
                minPrice: Number.isFinite(minPrice) ? minPrice : '',
                maxPrice: Number.isFinite(maxPrice) ? maxPrice : '',
                bestSellers: (bestSellers && bestSellers.length) ? bestSellers.map(enhanceProductRecord) : [],
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        } catch (error) {
            console.error('Error loading shopping data:', error);
            req.flash('error', 'Unable to load products right now.');
            return res.redirect('/');
        }
    },

    // Show individual product details
    showProductDetails: (req, res) => {
        const productId = req.params.id;

        Product.getById(productId, (error, results) => {
            if (error) throw error;
            if (results.length > 0) {
                const product = enhanceProductRecord(results[0]);
                Review.findByProduct(productId, (reviewError, reviewResults) => {
                    if (reviewError) {
                        console.error('Error fetching reviews for product:', reviewError);
                    }

                    const reviews = reviewResults || [];
                    const averageRating = reviews.length
                        ? (reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length)
                        : null;

                    const userReview = req.session.user
                        ? reviews.find(review => review.user_id === req.session.user.id)
                        : null;

                    res.render('product', {
                        product,
                        user: req.session.user,
                        reviews,
                        averageRating,
                        userReview,
                        messages: req.flash('success'),
                        errors: req.flash('error')
                    });
                });
            } else {
                res.status(404).send('Product not found');
            }
        });
    }
};

module.exports = ProductController;
