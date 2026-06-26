// utils/logger.js
// ─────────────────────────────────────────────────────────────────────────────
// SHARED ACTIVITY LOGGER
// Import this in any router:  const { logActivity } = require('../utils/logger');
//
// Usage (manual, for specific meaningful actions):
//   await logActivity(req, 'APPROVE_QUESTION', `Approved question ID ${id}: "${text}"`);
//   await logActivity(req, 'DELETE_USER',      `Deleted user: ${name} (ID: ${uid})`);
//
// The function reads actor_id and actor_role directly from req.user so you
// never have to pass them manually.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../db');

/**
 * Log a single activity entry.
 *
 * @param {object}      req         Express request object (must have req.user)
 * @param {string}      action      Snake-case action key  e.g. 'APPROVE_QUESTION'
 * @param {string}      [description] Human-readable detail string
 */
async function logActivity(req, action, description = null) {
    try {
        const actorId   = req.user?.user_id  ?? null;
        const actorRole = req.user?.role      ?? 'Student';

        await db.query(
            `INSERT INTO activity_logs (actor_id, actor_role, action, description)
             VALUES (?, ?, ?, ?)`,
            [actorId, actorRole, action, description]
        );
    } catch (_) {
        // Non-fatal — a logging failure must never crash a route
    }
}

module.exports = { logActivity };
