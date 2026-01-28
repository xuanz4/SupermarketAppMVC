const connection = require('../db');

const getBalance = (userId, callback) => {
    const sql = 'SELECT wallet_balance FROM users WHERE id = ?';
    connection.query(sql, [userId], (err, rows) => {
        if (err) {
            return callback(err);
        }
        const balance = rows && rows[0] ? Number(rows[0].wallet_balance || 0) : 0;
        callback(null, balance);
    });
};

const creditWithType = (userId, amount, type, reference, callback) => {
    const safeAmount = Number(amount);
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
        return callback(new Error('Invalid top up amount.'));
    }

    connection.beginTransaction((startErr) => {
        if (startErr) {
            return callback(startErr);
        }

        const balanceSql = 'SELECT wallet_balance FROM users WHERE id = ? FOR UPDATE';
        connection.query(balanceSql, [userId], (balanceErr, balanceRows) => {
            if (balanceErr) {
                return connection.rollback(() => callback(balanceErr));
            }

            const currentBalance = balanceRows && balanceRows[0]
                ? Number(balanceRows[0].wallet_balance || 0)
                : 0;
            const newBalance = Number((currentBalance + safeAmount).toFixed(2));

            const updateSql = 'UPDATE users SET wallet_balance = ? WHERE id = ?';
            connection.query(updateSql, [newBalance, userId], (updateErr) => {
                if (updateErr) {
                    return connection.rollback(() => callback(updateErr));
                }

                const txSql = `
                    INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference)
                    VALUES (?, ?, ?, ?, ?)
                `;
                connection.query(txSql, [userId, type || 'topup', safeAmount, newBalance, reference || null], (txErr) => {
                    if (txErr) {
                        return connection.rollback(() => callback(txErr));
                    }

                    connection.commit((commitErr) => {
                        if (commitErr) {
                            return connection.rollback(() => callback(commitErr));
                        }
                        callback(null, newBalance);
                    });
                });
            });
        });
    });
};

const credit = (userId, amount, reference, callback) => {
    creditWithType(userId, amount, 'topup', reference, callback);
};

const create = (userId, topup, callback) => {
    const {
        provider,
        amount,
        status = 'pending',
        providerRef = null
    } = topup || {};

    const sql = `
        INSERT INTO wallet_topups (user_id, provider, amount, status, provider_ref)
        VALUES (?, ?, ?, ?, ?)
    `;
    connection.query(sql, [userId, provider, amount, status, providerRef], callback);
};

const findByUser = (userId, callback) => {
    const sql = `
        SELECT id, provider, amount, status, provider_ref, created_at, completed_at
        FROM wallet_topups
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 10
    `;
    connection.query(sql, [userId], callback);
};

const findTransactions = (userId, callback) => {
    const sql = `
        SELECT id, type, amount, balance_after, reference, created_at
        FROM wallet_transactions
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 10
    `;
    connection.query(sql, [userId], callback);
};

const findByProviderRef = (providerRef, callback) => {
    const sql = `
        SELECT id, user_id, provider, amount, status, provider_ref, created_at, completed_at
        FROM wallet_topups
        WHERE provider_ref = ?
        LIMIT 1
    `;
    connection.query(sql, [providerRef], (err, rows) => {
        if (err) {
            return callback(err);
        }
        callback(null, rows && rows[0] ? rows[0] : null);
    });
};

const markCompleted = (id, callback) => {
    const sql = `
        UPDATE wallet_topups
        SET status = 'completed', completed_at = NOW()
        WHERE id = ?
    `;
    connection.query(sql, [id], callback);
};

module.exports = {
    getBalance,
    credit,
    creditWithType,
    create,
    findByUser,
    findTransactions,
    findByProviderRef,
    markCompleted
};
