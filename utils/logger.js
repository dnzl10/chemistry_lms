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
 * Log a single activity entry with forensic network telemetry.
 * Supports both:
 * 1. logActivity(req, action, description, overrideActorId, overrideActorRole)
 * 2. logActivity(actorId, actorRole, action, description)
 */
async function logActivity(arg1, arg2, arg3 = null, arg4 = null, arg5 = null) {
    try {
        let actorId = null;
        let actorRole = 'Student';
        let ipAddress = null;
        let userAgent = null;
        let sessionId = null;
        let action = '';
        let description = null;

        if (arg1 && typeof arg1 === 'object' && (arg1.headers || arg1.session || arg1.user)) {
            // Called with Express request object
            const req = arg1;
            action = arg2;
            description = arg3;
            actorId = arg4 || req.user?.user_id || null;
            actorRole = arg5 || req.user?.role || 'Student';

            const rawIp = req.headers ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress) : null;
            ipAddress = rawIp ? rawIp.replace('::ffff:', '') : null;
            userAgent = (req.headers?.['user-agent'] || '').slice(0, 255) || null;
            sessionId = req.sessionID || null;
        } else {
            // Direct ID invocation: (actorId, actorRole, action, description)
            actorId = arg1 || null;
            actorRole = arg2 || 'Admin';
            action = arg3 || '';
            description = arg4 || null;
        }

        await db.query(
            `INSERT INTO activity_logs (actor_id, actor_role, ip_address, user_agent, session_id, action, description)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [actorId, actorRole, ipAddress, userAgent, sessionId, action, description]
        );
    } catch (_) {
        // Non-fatal — a logging failure must never crash a route
    }
}

module.exports = { logActivity };
