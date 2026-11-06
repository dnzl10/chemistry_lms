/**
 * utils/mysqlSessionStore.js
 * ============================================================================
 * Zero-dependency MySQL-backed Express Session Store using the existing db.js
 * connection pool. Ensures that deployments, code updates, and cloud container
 * restarts NEVER log out active Students, Teachers, or Admins.
 * ============================================================================
 */

const session = require('express-session');

class MySQLSessionStore extends session.Store {
    constructor(dbPool, options = {}) {
        super();
        this.db = dbPool;
        this.tableName = options.tableName || 'user_sessions';
        this.ttlMs = options.ttlMs || 30 * 60 * 1000; // Default 30 mins
        this.cleanupIntervalMs = options.cleanupIntervalMs || 15 * 60 * 1000; // 15 mins
        this.initialized = false;
        this.initPromise = this._initTable();

        // Periodically purge expired sessions
        this.cleanupTimer = setInterval(() => {
            this.clearExpiredSessions().catch(() => {});
        }, this.cleanupIntervalMs);
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    async _initTable() {
        if (this.initialized) return;
        try {
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
                    \`session_id\` VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
                    \`expires\` BIGINT UNSIGNED NOT NULL,
                    \`data\` MEDIUMTEXT COLLATE utf8mb4_bin,
                    PRIMARY KEY (\`session_id\`),
                    INDEX \`idx_session_expires\` (\`expires\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
            `);
            this.initialized = true;
        } catch (err) {
            console.warn('[MySQLSessionStore] Table init warning:', err.message);
        }
    }

    _getExpiresTimestamp(sess) {
        if (sess && sess.cookie && sess.cookie.expires) {
            return new Date(sess.cookie.expires).getTime();
        }
        if (sess && sess.cookie && typeof sess.cookie.maxAge === 'number') {
            return Date.now() + sess.cookie.maxAge;
        }
        return Date.now() + this.ttlMs;
    }

    async get(sid, cb) {
        try {
            await this.initPromise;
            const [rows] = await this.db.query(
                `SELECT data, expires FROM \`${this.tableName}\` WHERE session_id = ? LIMIT 1`,
                [sid]
            );
            if (!rows || rows.length === 0) {
                return cb(null, null);
            }
            const row = rows[0];
            if (Number(row.expires) <= Date.now()) {
                await this.db.query(`DELETE FROM \`${this.tableName}\` WHERE session_id = ?`, [sid]).catch(() => {});
                return cb(null, null);
            }
            const parsed = JSON.parse(row.data);
            return cb(null, parsed);
        } catch (err) {
            return cb(err);
        }
    }

    async set(sid, sess, cb) {
        try {
            await this.initPromise;
            const expires = this._getExpiresTimestamp(sess);
            const data = JSON.stringify(sess);
            await this.db.query(
                `INSERT INTO \`${this.tableName}\` (session_id, expires, data)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
                [sid, expires, data]
            );
            if (cb) cb(null);
        } catch (err) {
            if (cb) cb(err);
        }
    }

    async touch(sid, sess, cb) {
        try {
            await this.initPromise;
            const expires = this._getExpiresTimestamp(sess);
            await this.db.query(
                `UPDATE \`${this.tableName}\` SET expires = ? WHERE session_id = ?`,
                [expires, sid]
            );
            if (cb) cb(null);
        } catch (err) {
            if (cb) cb(err);
        }
    }

    async destroy(sid, cb) {
        try {
            await this.initPromise;
            await this.db.query(
                `DELETE FROM \`${this.tableName}\` WHERE session_id = ?`,
                [sid]
            );
            if (cb) cb(null);
        } catch (err) {
            if (cb) cb(err);
        }
    }

    async clearExpiredSessions() {
        await this.initPromise;
        const now = Date.now();
        await this.db.query(`DELETE FROM \`${this.tableName}\` WHERE expires <= ?`, [now]);
    }
}

module.exports = MySQLSessionStore;

