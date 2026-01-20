const connection = require('../db');

/**
 * Create a new order for the given user and cart items.
 * Inserts into orders, creates order_items, and deducts inventory within a transaction.
 * @param {number} userId
 * @param {Array<{productId:number, productName:string, quantity:number, price:number}>} cartItems
 * @param {Function} callback Node-style callback(err, result)
 */
const create = (userId, cartItems, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const {
        deliveryMethod = 'pickup',
        deliveryAddress = null,
        deliveryFee = 0
    } = options || {};

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return callback(new Error('Cart is empty.'));
    }

    connection.beginTransaction((transactionError) => {
        if (transactionError) {
            return callback(transactionError);
        }

        const totalBeforeRound = cartItems.reduce((sum, item) => {
            const unitPrice = Number(item.price);
            const quantity = Number(item.quantity);
            if (!Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
                return sum;
            }
            return sum + (unitPrice * quantity);
        }, 0);

        const orderTotal = Number(totalBeforeRound.toFixed(2));
        const safeDeliveryFee = Number.isFinite(deliveryFee) && deliveryFee > 0
            ? Number(deliveryFee.toFixed(2))
            : 0;
        const finalTotal = Number((orderTotal + safeDeliveryFee).toFixed(2));

        const productIds = [...new Set(cartItems.map((item) => item.productId))];
        const placeholders = productIds.map(() => '?').join(',');
        const stockSql = `SELECT id, quantity FROM products WHERE id IN (${placeholders}) FOR UPDATE`;

        connection.query(stockSql, productIds, (stockErr, stockRows) => {
            if (stockErr) {
                return connection.rollback(() => callback(stockErr));
            }

            const stockMap = new Map();
            (stockRows || []).forEach((row) => {
                stockMap.set(Number(row.id), Number(row.quantity));
            });

            for (const item of cartItems) {
                const requested = Number(item.quantity);
                const onHand = stockMap.has(Number(item.productId)) ? Number(stockMap.get(Number(item.productId))) : 0;
                if (!Number.isFinite(requested) || requested <= 0) {
                    return connection.rollback(() => callback(new Error(`Invalid quantity for ${item.productName}.`)));
                }
                if (onHand < requested) {
                    return connection.rollback(() => callback(new Error(`Not enough stock for ${item.productName || 'item'}.`)));
                }
            }

            const orderSql = `
                INSERT INTO orders (user_id, total, delivery_method, delivery_address, delivery_fee)
                VALUES (?, ?, ?, ?, ?)
            `;
            connection.query(orderSql, [userId, finalTotal, deliveryMethod, deliveryAddress, safeDeliveryFee], (orderError, orderResult) => {
                if (orderError) {
                    return connection.rollback(() => callback(orderError));
                }

                const orderId = orderResult.insertId;

                const itemPromises = cartItems.map((item) => new Promise((resolve, reject) => {
                    const quantity = Number(item.quantity);
                    if (!Number.isFinite(quantity) || quantity <= 0) {
                        return reject(new Error(`Invalid quantity detected for ${item.productName}.`));
                    }

                    const unitPrice = Number(item.price);
                    if (!Number.isFinite(unitPrice)) {
                        return reject(new Error(`Invalid price detected for ${item.productName}.`));
                    }

                    const updateStockSql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
                    connection.query(updateStockSql, [quantity, item.productId, quantity], (stockUpdateErr, stockUpdateRes) => {
                        if (stockUpdateErr) {
                            return reject(stockUpdateErr);
                        }
                        if (!stockUpdateRes.affectedRows) {
                            return reject(new Error(`Not enough stock for ${item.productName || 'item'}.`));
                        }

                        const insertItemSql = 'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)';
                        connection.query(insertItemSql, [orderId, item.productId, quantity, unitPrice], (itemError) => {
                            if (itemError) {
                                return reject(itemError);
                            }
                            resolve();
                        });
                    });
                }));

                Promise.all(itemPromises)
                    .then(() => {
                        connection.commit((commitError) => {
                            if (commitError) {
                                return connection.rollback(() => callback(commitError));
                            }
                            callback(null, {
                                orderId,
                                total: finalTotal,
                                deliveryMethod,
                                deliveryAddress,
                                deliveryFee: safeDeliveryFee
                            });
                        });
                    })
                    .catch((error) => {
                        connection.rollback(() => callback(error));
                    });
            });
        });
    });
};

/**
 * Create a new order paid with wallet balance.
 * Deducts wallet balance and records wallet transaction in the same transaction.
 * @param {number} userId
 * @param {Array<{productId:number, productName:string, quantity:number, price:number}>} cartItems
 * @param {Object} options
 * @param {Function} callback
 */
const createWithWallet = (userId, cartItems, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const {
        deliveryMethod = 'pickup',
        deliveryAddress = null,
        deliveryFee = 0
    } = options || {};

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        return callback(new Error('Cart is empty.'));
    }

    connection.beginTransaction((transactionError) => {
        if (transactionError) {
            return callback(transactionError);
        }

        const totalBeforeRound = cartItems.reduce((sum, item) => {
            const unitPrice = Number(item.price);
            const quantity = Number(item.quantity);
            if (!Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
                return sum;
            }
            return sum + (unitPrice * quantity);
        }, 0);

        const orderTotal = Number(totalBeforeRound.toFixed(2));
        const safeDeliveryFee = Number.isFinite(deliveryFee) && deliveryFee > 0
            ? Number(deliveryFee.toFixed(2))
            : 0;
        const finalTotal = Number((orderTotal + safeDeliveryFee).toFixed(2));

        const walletSql = 'SELECT wallet_balance FROM users WHERE id = ? FOR UPDATE';
        connection.query(walletSql, [userId], (walletErr, walletRows) => {
            if (walletErr) {
                return connection.rollback(() => callback(walletErr));
            }

            const currentBalance = walletRows && walletRows[0]
                ? Number(walletRows[0].wallet_balance || 0)
                : 0;

            if (!Number.isFinite(currentBalance) || currentBalance < finalTotal) {
                return connection.rollback(() => callback(new Error('Insufficient wallet balance.')));
            }

            const productIds = [...new Set(cartItems.map((item) => item.productId))];
            const placeholders = productIds.map(() => '?').join(',');
            const stockSql = `SELECT id, quantity FROM products WHERE id IN (${placeholders}) FOR UPDATE`;

            connection.query(stockSql, productIds, (stockErr, stockRows) => {
                if (stockErr) {
                    return connection.rollback(() => callback(stockErr));
                }

                const stockMap = new Map();
                (stockRows || []).forEach((row) => {
                    stockMap.set(Number(row.id), Number(row.quantity));
                });

                for (const item of cartItems) {
                    const requested = Number(item.quantity);
                    const onHand = stockMap.has(Number(item.productId)) ? Number(stockMap.get(Number(item.productId))) : 0;
                    if (!Number.isFinite(requested) || requested <= 0) {
                        return connection.rollback(() => callback(new Error(`Invalid quantity for ${item.productName}.`)));
                    }
                    if (onHand < requested) {
                        return connection.rollback(() => callback(new Error(`Not enough stock for ${item.productName || 'item'}.`)));
                    }
                }

                const orderSql = `
                    INSERT INTO orders (user_id, total, delivery_method, delivery_address, delivery_fee)
                    VALUES (?, ?, ?, ?, ?)
                `;
                connection.query(orderSql, [userId, finalTotal, deliveryMethod, deliveryAddress, safeDeliveryFee], (orderError, orderResult) => {
                    if (orderError) {
                        return connection.rollback(() => callback(orderError));
                    }

                    const orderId = orderResult.insertId;
                    const itemPromises = cartItems.map((item) => new Promise((resolve, reject) => {
                        const quantity = Number(item.quantity);
                        if (!Number.isFinite(quantity) || quantity <= 0) {
                            return reject(new Error(`Invalid quantity detected for ${item.productName}.`));
                        }

                        const unitPrice = Number(item.price);
                        if (!Number.isFinite(unitPrice)) {
                            return reject(new Error(`Invalid price detected for ${item.productName}.`));
                        }

                        const updateStockSql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
                        connection.query(updateStockSql, [quantity, item.productId, quantity], (stockUpdateErr, stockUpdateRes) => {
                            if (stockUpdateErr) {
                                return reject(stockUpdateErr);
                            }
                            if (!stockUpdateRes.affectedRows) {
                                return reject(new Error(`Not enough stock for ${item.productName || 'item'}.`));
                            }

                            const insertItemSql = 'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)';
                            connection.query(insertItemSql, [orderId, item.productId, quantity, unitPrice], (itemError) => {
                                if (itemError) {
                                    return reject(itemError);
                                }
                                resolve();
                            });
                        });
                    }));

                    Promise.all(itemPromises)
                        .then(() => {
                            const newBalance = Number((currentBalance - finalTotal).toFixed(2));
                            const updateWalletSql = 'UPDATE users SET wallet_balance = ? WHERE id = ?';
                            connection.query(updateWalletSql, [newBalance, userId], (walletUpdateErr) => {
                                if (walletUpdateErr) {
                                    return connection.rollback(() => callback(walletUpdateErr));
                                }

                                const txSql = `
                                    INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference)
                                    VALUES (?, 'purchase', ?, ?, ?)
                                `;
                                connection.query(txSql, [userId, -finalTotal, newBalance, `order:${orderId}`], (txErr) => {
                                    if (txErr) {
                                        return connection.rollback(() => callback(txErr));
                                    }

                                    connection.commit((commitError) => {
                                        if (commitError) {
                                            return connection.rollback(() => callback(commitError));
                                        }
                                        callback(null, {
                                            orderId,
                                            total: finalTotal,
                                            deliveryMethod,
                                            deliveryAddress,
                                            deliveryFee: safeDeliveryFee,
                                            walletBalance: newBalance
                                        });
                                    });
                                });
                            });
                        })
                        .catch((error) => {
                            connection.rollback(() => callback(error));
                        });
                });
            });
        });
    });
};

/**
 * Retrieve orders placed by a specific user.
 * @param {number} userId
 * @param {Function} callback
 */
const findByUser = (userId, callback) => {
    const sql = `
        SELECT id, total, created_at, delivery_method, delivery_address, delivery_fee, status
        FROM orders
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
    `;
    connection.query(sql, [userId], callback);
};

const findById = (orderId, callback) => {
    const sql = `
        SELECT id, user_id, total, created_at, delivery_method, delivery_address, delivery_fee, status
        FROM orders
        WHERE id = ?
        LIMIT 1
    `;
    connection.query(sql, [orderId], callback);
};

const findAllWithUsers = (callback) => {
    const sql = `
        SELECT
            o.id,
            o.total,
            o.created_at,
            o.delivery_method,
            o.delivery_address,
            o.delivery_fee,\n            o.status,\n            u.username,
            u.email,
            u.contact,
            u.address AS account_address,
            u.free_delivery
        FROM orders o
        JOIN users u ON u.id = o.user_id
        ORDER BY o.created_at DESC, o.id DESC
    `;
    connection.query(sql, callback);
};

/**
 * Retrieve order items for a list of order ids.
 * @param {number[]} orderIds
 * @param {Function} callback
 */
const findItemsByOrderIds = (orderIds, callback) => {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return callback(null, []);
    }

    const sql = `
        SELECT oi.order_id, oi.product_id, oi.quantity, oi.price, p.productName, p.image, p.discountPercentage, p.offerMessage
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id IN (?)
        ORDER BY oi.order_id DESC, p.productName ASC
    `;
    connection.query(sql, [orderIds], callback);
};

/**
 * Retrieve global best-selling products ordered by total quantity sold.
 * @param {number} limit Number of products to fetch
 * @param {Function} callback
 */
const getBestSellers = (limit, callback) => {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
    const sql = `
        SELECT
            p.id,
            p.productName,
            p.price,
            p.image,
            p.discountPercentage,
            p.offerMessage,
            SUM(oi.quantity) AS totalSold
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        GROUP BY p.id, p.productName, p.price, p.image, p.discountPercentage, p.offerMessage
        ORDER BY totalSold DESC
        LIMIT ?
    `;
    connection.query(sql, [safeLimit], callback);
};

/**
 * Delete an order and its items inside a transaction.
 * @param {number} orderId
 * @param {Function} callback
 */
const remove = (orderId, callback) => {
    connection.beginTransaction((startErr) => {
        if (startErr) return callback(startErr);

        connection.query('DELETE FROM order_items WHERE order_id = ?', [orderId], (itemsErr) => {
            if (itemsErr) {
                return connection.rollback(() => callback(itemsErr));
            }

            connection.query('DELETE FROM orders WHERE id = ?', [orderId], (orderErr, result) => {
                if (orderErr) {
                    return connection.rollback(() => callback(orderErr));
                }

                connection.commit((commitErr) => {
                    if (commitErr) {
                        return connection.rollback(() => callback(commitErr));
                    }
                    callback(null, result);
                });
            });
        });
    });
};

const updateDelivery = (orderId, deliveryData, callback) => {
    const {
        deliveryMethod = 'pickup',
        deliveryAddress = null,
        deliveryFee = 0,
        status = null
    } = deliveryData || {};

    const safeFee = Number.isFinite(deliveryFee) && deliveryFee > 0
        ? Number(deliveryFee.toFixed(2))
        : 0;
    const fields = [
        'delivery_method = ?',
        'delivery_address = ?',
        'delivery_fee = ?',
        'total = total - delivery_fee + ?'
    ];
    const params = [deliveryMethod, deliveryAddress, safeFee, safeFee];

    if (status) {
        fields.push('status = ?');
        params.push(status);
    }

    params.push(orderId);

    const sql = `
        UPDATE orders
        SET ${fields.join(', ')}
        WHERE id = ?
    `;
    connection.query(sql, params, callback);
};

module.exports = {
    create,
    createWithWallet,
    findByUser,
    findById,
    findAllWithUsers,
    findItemsByOrderIds,
    getBestSellers,
    remove,
    updateDelivery
};

