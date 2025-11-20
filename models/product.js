const connection = require('../db');

// Product model
const Product = {
    getAll: (callback) => {
        const sql = 'SELECT * FROM products';
        connection.query(sql, callback);
    },

    getByCategory: (category, callback) => {
        const sql = 'SELECT * FROM products WHERE category = ?';
        connection.query(sql, [category], callback);
    },

    getFiltered: ({ category, search, sort, lowStockOnly = false, minPrice, maxPrice }, callback) => {
        const params = [];
        let sql = 'SELECT * FROM products WHERE 1=1';

        if (category) {
            sql += ' AND category = ?';
            params.push(category);
        }

        if (search) {
            sql += ' AND productName LIKE ?';
            params.push(`%${search}%`);
        }

        if (Number.isFinite(minPrice)) {
            sql += ' AND price >= ?';
            params.push(minPrice);
        }

        if (Number.isFinite(maxPrice)) {
            sql += ' AND price <= ?';
            params.push(maxPrice);
        }

        if (lowStockOnly) {
            sql += ' AND quantity <= 5';
        }

        const sortMap = {
            price_asc: 'price ASC',
            price_desc: 'price DESC',
            discount_desc: 'discountPercentage DESC',
            newest: 'id DESC',
            stock_asc: 'quantity ASC',
            stock_desc: 'quantity DESC'
        };

        const orderBy = sortMap[sort] || 'productName ASC';
        sql += ` ORDER BY ${orderBy}`;

        connection.query(sql, params, callback);
    },

    getCategories: (callback) => {
        const sql = 'SELECT DISTINCT category FROM products ORDER BY category ASC';
        connection.query(sql, callback);
    },

    getById: (productId, callback) => {
        const sql = 'SELECT * FROM products WHERE id = ?';
        connection.query(sql, [productId], callback);
    },

    create: (productData, callback) => {
        const {
            name,
            quantity,
            price,
            image,
            discountPercentage = 0,
            offerMessage = null,
            category = 'General'
        } = productData;
        const sql = `
            INSERT INTO products
                (productName, quantity, price, discountPercentage, offerMessage, image, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        connection.query(sql, [name, quantity, price, discountPercentage, offerMessage, image, category], callback);
    },

    update: (productId, productData, callback) => {
        const {
            name,
            quantity,
            price,
            image,
            discountPercentage = 0,
            offerMessage = null,
            category = 'General'
        } = productData;
        const sql = `
            UPDATE products
            SET productName = ?, quantity = ?, price = ?, discountPercentage = ?, offerMessage = ?, image = ?, category = ?
            WHERE id = ?
        `;
        connection.query(sql, [name, quantity, price, discountPercentage, offerMessage, image, category, productId], callback);
    },

    delete: (productId, callback) => {
        const sql = 'DELETE FROM products WHERE id = ?';
        connection.query(sql, [productId], callback);
    }
};

module.exports = Product;
