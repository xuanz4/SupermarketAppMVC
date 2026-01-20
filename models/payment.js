const connection = require('../db');

const create = (orderId, payment, callback) => {
    const {
        provider,
        status = 'paid',
        amount,
        currency = 'SGD',
        providerRef = null
    } = payment || {};

    const sql = `
        INSERT INTO payments (order_id, provider, status, amount, currency, provider_ref)
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    connection.query(
        sql,
        [orderId, provider, status, amount, currency, providerRef],
        callback
    );
};

const findByOrderIds = (orderIds, callback) => {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return callback(null, []);
    }

    const sql = `
        SELECT id, order_id, provider, status, amount, currency, provider_ref, created_at, refunded_at
        FROM payments
        WHERE order_id IN (?)
        ORDER BY created_at DESC, id DESC
    `;
    connection.query(sql, [orderIds], callback);
};

const findByOrderId = (orderId, callback) => {
    const sql = `
        SELECT id, order_id, provider, status, amount, currency, provider_ref, created_at, refunded_at
        FROM payments
        WHERE order_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `;
    connection.query(sql, [orderId], callback);
};

const markRefunded = (paymentId, callback) => {
    const sql = `
        UPDATE payments
        SET status = 'refunded', refunded_at = NOW()
        WHERE id = ?
    `;
    connection.query(sql, [paymentId], callback);
};

module.exports = {
    create,
    findByOrderIds,
    findByOrderId,
    markRefunded
};
