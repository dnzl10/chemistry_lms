const db = require('../db');

function isApiRequest(req) {
    return Boolean(
        req.xhr ||
        req.path.startsWith('/api') ||
        req.originalUrl.includes('/api/') ||
        (req.headers.accept && req.headers.accept.includes('application/json'))
    );
}

function ensureAuthenticated(req, res, next) {
    const isApi = isApiRequest(req);

    if (!req.isAuthenticated()) {
        if (isApi) {
            return res.status(401).json({ success: false, error: 'Session expired or unauthenticated. Please log in again.' });
        }
        return res.redirect('/login');
    }

    // 1. Immediate Suspension & Deactivation Check
    if (Number(req.user.is_suspended) === 1 || Number(req.user.is_active) === 0) {
        if (req.user && req.user.user_id) {
            db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [req.user.user_id]).catch(()=>{});
        }
        return req.logout(() => {
            req.session.destroy();
            if (isApi) {
                return res.status(403).json({ success: false, error: 'Your account has been deactivated or suspended.' });
            }
            res.redirect('/login?error=' + encodeURIComponent('Your account has been deactivated or suspended.'));
        });
    }

    // 2. Absolute Session Expiration (Max 12 hours)
    const MAX_LIFETIME = 12 * 60 * 60 * 1000;
    if (req.session.createdAt && (Date.now() - req.session.createdAt > MAX_LIFETIME)) {
        if (req.user && req.user.user_id) {
            db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [req.user.user_id]).catch(()=>{});
        }
        return req.logout(() => {
            req.session.destroy();
            if (isApi) {
                return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
            }
            res.redirect('/login?error=' + encodeURIComponent('Session expired. Please log in again.'));
        });
    }

    // 3. Single Active Session / Concurrent Login Restriction
    if (!req.user.current_session_id || req.user.current_session_id !== req.sessionID) {
        return req.logout((err) => {
            req.session.destroy();
            if (isApi) {
                return res.status(401).json({ success: false, error: 'Your session has ended because your account was logged in from another device or the server restarted. Please log in again.' });
            }
            res.redirect('/login?error=' + encodeURIComponent('Your session has ended because your account was logged in from another device.'));
        });
    }

    next();
}

function requireRole(roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            const isApi = isApiRequest(req);
            if (isApi) {
                return res.status(403).json({ success: false, error: 'Forbidden: Insufficient privileges.' });
            }
            return res.status(403).send("Forbidden: Insufficient privileges.");
        }
        next();
    };
}

module.exports = { ensureAuthenticated, requireRole, isApiRequest };
