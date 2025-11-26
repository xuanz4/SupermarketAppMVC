const db = require('../db');

/**
 * Load persisted cart items for a user.
 * @param {number} userId
 * @param {(err: Error|null, items?: Array<{productId:number, quantity:number}>)} callback
 */
const load = (userId, callback) => {
    const sql = 'SELECT product_id AS productId, quantity FROM user_carts WHERE user_id = ?';
    db.query(sql, [userId], (err, rows) => {
        if (err) return callback(err);
        callback(null, rows || []);
    });
};

/**
 * Save cart items for a user (replaces existing).
 * @param {number} userId
 * @param {Array<{productId:number, quantity:number}>} items
 * @param {(err: Error|null)=>void} callback
 */
const save = (userId, items, callback) => {
    db.beginTransaction((txErr) => {
        if (txErr) return callback(txErr);

        const deleteSql = 'DELETE FROM user_carts WHERE user_id = ?';
        db.query(deleteSql, [userId], (delErr) => {
            if (delErr) {
                return db.rollback(() => callback(delErr));
            }

            const validItems = (items || []).filter((item) => Number.isFinite(item.productId) && Number.isFinite(item.quantity) && item.quantity > 0);
            if (!validItems.length) {
                return db.commit((commitErr) => {
                    if (commitErr) {
                        return db.rollback(() => callback(commitErr));
                    }
                    callback(null);
                });
            }

            const insertSql = 'INSERT INTO user_carts (user_id, product_id, quantity) VALUES ?';
            const values = validItems.map((item) => [userId, item.productId, item.quantity]);

            db.query(insertSql, [values], (insErr) => {
                if (insErr) {
                    return db.rollback(() => callback(insErr));
                }
                db.commit((commitErr) => {
                    if (commitErr) {
                        return db.rollback(() => callback(commitErr));
                    }
                    callback(null);
                });
            });
        });
    });
};

module.exports = {
    load,
    save
};
