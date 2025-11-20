const connection = require('../db');

/**
 * Create a new review.
 * @param {Object} reviewData
 * @param {Function} callback
 */
const create = (reviewData, callback) => {
    const { productId, userId, rating, comment } = reviewData;
    const sql = `
        INSERT INTO product_reviews (product_id, user_id, rating, comment)
        VALUES (?, ?, ?, ?)
    `;
    connection.query(sql, [productId, userId, rating, comment], callback);
};

/**
 * Update an existing review.
 * @param {number} id
 * @param {Object} reviewData
 * @param {Function} callback
 */
const update = (id, reviewData, callback) => {
    const { rating, comment } = reviewData;
    const sql = `
        UPDATE product_reviews
        SET rating = ?, comment = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `;
    connection.query(sql, [rating, comment, id], callback);
};

/**
 * Remove a review by id.
 * @param {number} id
 * @param {Function} callback
 */
const remove = (id, callback) => {
    const sql = 'DELETE FROM product_reviews WHERE id = ?';
    connection.query(sql, [id], callback);
};

/**
 * Find a review submitted by a user for a product.
 * @param {number} userId
 * @param {number} productId
 * @param {Function} callback
 */
const findByUserAndProduct = (userId, productId, callback) => {
    const sql = `
        SELECT *
        FROM product_reviews
        WHERE user_id = ? AND product_id = ?
        LIMIT 1
    `;
    connection.query(sql, [userId, productId], callback);
};

/**
 * Retrieve all reviews for a product ordered by newest first.
 * @param {number} productId
 * @param {Function} callback
 */
const findByProduct = (productId, callback) => {
    const sql = `
        SELECT r.id, r.product_id, r.user_id, r.rating, r.comment, r.created_at, r.updated_at, u.username
        FROM product_reviews r
        JOIN users u ON u.id = r.user_id
        WHERE r.product_id = ?
        ORDER BY r.created_at DESC
    `;
    connection.query(sql, [productId], callback);
};

module.exports = {
    create,
    update,
    remove,
    findByUserAndProduct,
    findByProduct
};

