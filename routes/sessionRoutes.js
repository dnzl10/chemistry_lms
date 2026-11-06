/**
 * routes/sessionRoutes.js
 * Comprehensive REST API endpoints for real-time Session Security & Lifecycle Management.
 * Powers idle warning modals, concurrent login handshakes, and system notifications.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const sessionHandshakeService = require('../services/sessionHandshakeService');

/**
 * GET /api/session/status
 * Core heartbeat endpoint polled by client-side session guardian.
 */
router.get('/status', async (req, res) => {
    try {
        const serverBootId = sessionHandshakeService.serverBootId;
        const serverBootTime = sessionHandshakeService.serverBootTime;

        if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
            return res.json({
                authenticated: false,
                serverBootId,
                serverBootTime
            });
        }

        const userId = req.user.user_id;

        // Query fresh status from DB
        const [rows] = await db.query(
            "SELECT user_id, is_active, is_suspended, current_session_id FROM users WHERE user_id = ?",
            [userId]
        );

        if (!rows || rows.length === 0) {
            return res.json({
                authenticated: false,
                status: 'account_not_found',
                serverBootId,
                serverBootTime
            });
        }

        const userRow = rows[0];

        // 1. Suspension or Deactivation Check
        if (Number(userRow.is_suspended) === 1 || Number(userRow.is_active) === 0) {
            return res.json({
                authenticated: true,
                active: false,
                status: 'suspended',
                reason: 'Account suspended or deactivated by administration.',
                serverBootId,
                serverBootTime
            });
        }

        // 2. Displaced Session Check (Logged in elsewhere without grant)
        if (userRow.current_session_id && userRow.current_session_id !== req.sessionID) {
            return res.json({
                authenticated: true,
                active: false,
                status: 'displaced',
                reason: 'Your session has ended because your account was logged in from another device.',
                serverBootId,
                serverBootTime
            });
        }

        // 3. Pending Concurrent Request Check (Incoming Device B asking for approval)
        const pending = sessionHandshakeService.getPendingRequestForUser(userId);

        const now = Date.now();
        const createdAt = req.session.createdAt || now;
        const elapsedMs = now - createdAt;
        const maxLifetimeMs = 12 * 60 * 60 * 1000; // 12 hours
        const idleTimeoutMs = 30 * 60 * 1000;      // 30 minutes

        res.json({
            authenticated: true,
            active: true,
            status: 'healthy',
            userId,
            role: req.user.role,
            userName: req.user.first_name || req.user.name || 'User',
            sessionId: req.sessionID,
            serverBootId,
            serverBootTime,
            createdAt,
            elapsedMs,
            maxLifetimeMs,
            idleTimeoutMs,
            pendingConcurrentRequest: pending ? {
                requestId: pending.requestId,
                deviceInfo: pending.deviceInfo,
                createdAt: pending.createdAt,
                expiresInSeconds: Math.max(0, Math.round((pending.expiresAt - now) / 1000))
            } : null
        });

    } catch (err) {
        console.error('[GET /api/session/status Error]', err);
        res.status(500).json({ error: 'Failed to inspect session status' });
    }
});

/**
 * POST /api/session/keep-alive
 * Touches session cookie to refresh inactivity timeout.
 */
router.post('/keep-alive', (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    if (req.session) {
        req.session.touch();
    }

    res.json({
        success: true,
        message: 'Session extended successfully',
        timestamp: Date.now()
    });
});

/**
 * POST /api/session/resolve-concurrent
 * Called by Device A to Grant or Deny Device B's login attempt.
 */
router.post('/resolve-concurrent', async (req, res) => {
    try {
        if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
            return res.status(401).json({ success: false, error: 'Unauthenticated' });
        }

        const { requestId, decision } = req.body;

        if (!requestId || !['grant', 'deny'].includes(decision)) {
            return res.status(400).json({ success: false, error: 'Invalid requestId or decision' });
        }

        const result = sessionHandshakeService.resolveRequest(requestId, decision, req.user.user_id);

        if (!result.success) {
            return res.status(400).json(result);
        }

        // If granted, mark Device A's local session note so it knows it was intentionally transferred
        if (decision === 'grant') {
            req.session.transferredToNewDevice = true;
        }

        res.json({
            success: true,
            requestId,
            decision,
            status: result.status
        });

    } catch (err) {
        console.error('[POST /api/session/resolve-concurrent Error]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/session/check-request/:requestId
 * Polled by Device B while waiting for Device A's confirmation.
 */
router.get('/check-request/:requestId', (req, res) => {
    const request = sessionHandshakeService.getRequest(req.params.requestId);

    if (!request) {
        return res.status(404).json({ success: false, error: 'Request not found or expired' });
    }

    const now = Date.now();
    res.json({
        success: true,
        requestId: request.requestId,
        status: request.status,
        deviceInfo: request.deviceInfo,
        expiresInSeconds: Math.max(0, Math.round((request.expiresAt - now) / 1000))
    });
});

/**
 * POST /api/session/cancel-request
 * Allows Device B to cancel its own waiting request.
 */
router.post('/cancel-request', (req, res) => {
    const { requestId } = req.body;
    if (!requestId) {
        return res.status(400).json({ success: false, error: 'Missing requestId' });
    }

    const cancelled = sessionHandshakeService.cancelRequest(requestId);
    res.json({ success: true, cancelled });
});

module.exports = router;

