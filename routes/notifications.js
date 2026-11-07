/**
 * routes/notifications.js
 * Unified, enterprise REST endpoints for notifications across Elementa LMS.
 * Handles notification retrieval, unread counts, mark-as-read, and deep-link click redirection.
 */

const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');

// Middleware: ensure user is authenticated
function requireAuth(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        if (req.accepts('html') && !req.xhr && !req.path.startsWith('/unread-count')) {
            return res.redirect('/login');
        }
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
}

router.use(requireAuth);

/**
 * GET /api/notifications
 * Query params:
 *   - page: number (default 1)
 *   - limit: number (default 20)
 *   - unreadOnly: boolean (true/false)
 *   - category: string ('academic', 'assessment', 'forum', 'integrity', 'system', 'social')
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const role = req.user.role || null;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
        const category = req.query.category || null;

        if (role === 'Teacher') {
            await notificationService.syncTeacherProactiveAlerts(userId);
        }

        const result = await notificationService.getUserNotifications({
            userId,
            role,
            page,
            limit,
            unreadOnly,
            category
        });

        res.json(result);
    } catch (err) {
        console.error('[GET /api/notifications Error]', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/notifications/unread-count
 * Lightweight, fast endpoint for updating navbar bell and message badges.
 */
router.get('/unread-count', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const role = req.user.role || null;
        if (role === 'Teacher') {
            await notificationService.syncTeacherProactiveAlerts(userId);
        }
        const [count, unreadMessagesCount] = await Promise.all([
            notificationService.getUnreadCount({ userId, role }),
            notificationService.getUnreadMessagesCount({ userId, role })
        ]);
        res.json({ success: true, unreadCount: count, unreadMessagesCount });
    } catch (err) {
        console.error('[GET /api/notifications/unread-count Error]', err);
        res.status(500).json({ success: false, unreadCount: 0, unreadMessagesCount: 0 });
    }
});

/**
 * GET /api/notifications/:id/navigate
 * Core click-to-redirect endpoint:
 * 1. Validates ownership.
 * 2. Automatically marks notification as read in MySQL.
 * 3. Immediately 302 redirects user to the destination page.
 */
router.get('/:id/navigate', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const notificationId = req.params.id;

        const notif = await notificationService.getNotificationForNavigation({
            userId,
            notificationId
        });

        // Default fallbacks based on user role
        let defaultUrl = '/dashboard';
        if (req.user.role === 'Teacher') defaultUrl = '/teacher/dashboard';
        else if (req.user.role === 'Admin') defaultUrl = '/admin/dashboard';

        if (!notif || !notif.target_url) {
            return res.redirect(defaultUrl);
        }

        let targetUrl = notif.target_url;
        if (targetUrl.startsWith('/uploads/materials/')) {
            targetUrl = targetUrl.replace('/uploads/materials/', '/material_uploads/');
        }

        // Normalize Teacher deep-links so legacy or student-formatted URLs never fail
        if (req.user.role === 'Teacher') {
            if (targetUrl.startsWith('/teacher/question_bank')) {
                targetUrl = targetUrl.replace(/^\/teacher\/question_bank/, '/teacher/question-bank');
            } else if (targetUrl.startsWith('/forums/view/')) {
                const forumMatch = targetUrl.match(/^\/forums\/view\/(\d+)/);
                if (forumMatch) {
                    targetUrl = `/teacher/forums?forum_id=${forumMatch[1]}#forum-${forumMatch[1]}`;
                } else {
                    targetUrl = '/teacher/forums';
                }
            }
        }

        // Redirect directly to destination page
        return res.redirect(targetUrl);
    } catch (err) {
        console.error('[GET /api/notifications/:id/navigate Error]', err);
        const fallback = req.user.role === 'Teacher' ? '/teacher/dashboard' : (req.user.role === 'Admin' ? '/admin/dashboard' : '/dashboard');
        res.redirect(fallback);
    }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark an individual notification as read.
 */
router.patch('/:id/read', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const role = req.user.role || null;
        const notificationId = req.params.id;

        const result = await notificationService.markAsRead({ userId, notificationId, role });
        res.json(result);
    } catch (err) {
        console.error('[PATCH /api/notifications/:id/read Error]', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /api/notifications/mark-all-read
 * Mark all unread notifications as read for current user.
 */
router.post('/mark-all-read', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const role = req.user.role || null;
        const result = await notificationService.markAllAsRead({ userId, role });
        res.json(result);
    } catch (err) {
        console.error('[POST /api/notifications/mark-all-read Error]', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * DELETE /api/notifications/:id
 * Dismiss / soft-delete a notification.
 */
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.user.user_id;
        const role = req.user.role || null;
        const notificationId = req.params.id;

        const result = await notificationService.dismissNotification({ userId, notificationId, role });
        res.json(result);
    } catch (err) {
        console.error('[DELETE /api/notifications/:id Error]', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
