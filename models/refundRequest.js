const connection = require('../db');

const create = (orderId, userId, request, callback) => {
    const {
        reason,
        imagePath = null,
        status = 'pending'
    } = request || {};

    const sql = `
        INSERT INTO refund_requests (order_id, user_id, reason, image_path, status)
        VALUES (?, ?, ?, ?, ?)
    `;
    connection.query(sql, [orderId, userId, reason, imagePath, status], callback);
};

const findByOrderIds = (orderIds, callback) => {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return callback(null, []);
    }

    const sql = `
        SELECT id, order_id, user_id, reason, image_path, status, created_at
        FROM refund_requests
        WHERE order_id IN (?)
        ORDER BY created_at DESC, id DESC
    `;
    connection.query(sql, [orderIds], callback);
};

const findByOrderId = (orderId, callback) => {
    const sql = `
        SELECT id, order_id, user_id, reason, image_path, status, created_at
        FROM refund_requests
        WHERE order_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `;
    connection.query(sql, [orderId], callback);
};

module.exports = {
    create,
    findByOrderIds,
    findByOrderId
};
