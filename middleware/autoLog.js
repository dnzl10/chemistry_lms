// middleware/autoLog.js
// ─────────────────────────────────────────────────────────────────────────────
// AUTO-LOG MIDDLEWARE
//
// Attach this once per router file and it will automatically record an
// activity_log entry for every mutating request (POST / PUT / PATCH / DELETE)
// that completes successfully (2xx / 3xx response).
//
// HOW TO ATTACH (once per router file, right after requireXxx middleware):
//
//   const autoLog = require('../middleware/autoLog');
//
//   // Teacher router
//   router.use(autoLog(teacherActionMap));
//
//   // Student router
//   router.use(autoLog(studentActionMap));
//
// The ACTION MAP tells the middleware what label to use for each route.
// Keys are strings matched against  METHOD + ' ' + PATH_PREFIX.
// Use the most specific prefix first; the first match wins.
//
// Example map entry:
//   'POST /teacher/assessments':  'CREATE_ASSESSMENT'
//   'DELETE /teacher/question':   'DELETE_QUESTION'
//
// For routes that need richer descriptions (e.g. include a name or ID that
// only the route handler knows), call logActivity() MANUALLY inside that
// route and skip the map entry — the middleware simply won't find a match
// and will stay silent.
// ─────────────────────────────────────────────────────────────────────────────

const { logActivity } = require('../utils/logger');

/**
 * @param {Object.<string, string>} actionMap
 *   Keys:   'METHOD /path/prefix'   (e.g. 'POST /teacher/forum')
 *   Values: Action label string     (e.g. 'CREATE_FORUM_REPLY')
 */
function autoLog(actionMap) {
    return function autoLogMiddleware(req, res, next) {
        // Only watch mutating verbs
        const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
        if (!MUTATING.includes(req.method)) return next();

        // Intercept res.end to check the final status code
        const originalEnd = res.end.bind(res);

        res.end = function (...args) {
            // Restore before calling so the response is sent normally
            res.end = originalEnd;
            res.end(...args);

            // Only log on successful (non-error) responses
            const statusCode = res.statusCode;
            if (statusCode >= 200 && statusCode < 400) {
                // Find the best matching action label
                const fullPath = req.method + ' ' + req.path;
                let matched = null;

                for (const [key, label] of Object.entries(actionMap)) {
                    if (fullPath.startsWith(key) || fullPath === key) {
                        matched = label;
                        break;
                    }
                }

                if (matched) {
                    // Fire-and-forget — don't await, response is already sent
                    logActivity(req, matched, `Auto: ${req.method} ${req.path}`).catch(() => {});
                }
            }
        };

        next();
    };
}

module.exports = autoLog;
