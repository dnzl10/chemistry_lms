/**
 * services/notificationService.js
 * Centralized, production-grade notification service for Elementa LMS.
 * Handles database persistence, unread tracking, pagination, and click-to-redirect deep-linking.
 */

const db = require('../db');

class NotificationService {
    constructor() {
        this._teacherSyncCache = new Map();
        this._legacyRepaired = false;
    }

    /**
     * Dispatch an in-app notification to one or multiple recipients.
     * @param {Object} params
     * @param {number|number[]} params.recipientIds - User ID or array of User IDs
     * @param {number|null} [params.actorId=null] - User ID who triggered the event
     * @param {string} params.role - 'Student' | 'Teacher' | 'Admin'
     * @param {string} [params.category='academic'] - 'academic' | 'assessment' | 'forum' | 'integrity' | 'system' | 'social'
     * @param {string} [params.priority='normal'] - 'low' | 'normal' | 'high' | 'urgent'
     * @param {string} params.eventType - e.g. 'submission_created', 'grade_released', 'cheating_flagged'
     * @param {string} params.title - Headline/Summary of the notification
     * @param {string} params.message - Descriptive text
     * @param {string|null} [params.targetUrl=null] - Destination path when notification is clicked
     * @param {Object|null} [params.metadata=null] - Optional structured metadata (IDs, hashes, etc.)
     */
    async dispatch({
        recipientIds,
        actorId = null,
        role,
        category = 'academic',
        priority = 'normal',
        eventType,
        title,
        message,
        targetUrl = null,
        metadata = null
    }) {
        try {
            const rawIds = Array.isArray(recipientIds) ? recipientIds : [recipientIds];
            const uniqueIds = [...new Set(rawIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0))];

            if (uniqueIds.length === 0) return { success: false, count: 0, message: 'No valid recipients' };

            const metaStr = metadata ? JSON.stringify(metadata) : null;
            const values = uniqueIds.map(uid => [
                uid,
                actorId ? parseInt(actorId, 10) : null,
                role,
                category,
                priority,
                eventType,
                title.substring(0, 255),
                message,
                targetUrl ? targetUrl.substring(0, 500) : null,
                metaStr,
                0 // is_read = false
            ]);

            const query = `
                INSERT INTO notifications 
                (user_id, actor_id, role, category, priority, event_type, title, message, target_url, metadata, is_read)
                VALUES ?
            `;

            const [result] = await db.query(query, [values]);
            return {
                success: true,
                count: result.affectedRows,
                insertId: result.insertId
            };
        } catch (err) {
            console.error('[NotificationService.dispatch Error]', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Idempotently dispatch a single notification using a deduplication key stored in metadata.dedupeKey.
     * Prevents duplicate proactive alerts while preserving read/dismissed states once acted upon.
     */
    async dispatchOnce({
        recipientId,
        actorId = null,
        role,
        category = 'academic',
        priority = 'normal',
        eventType,
        title,
        message,
        targetUrl = null,
        dedupeKey,
        metadata = {}
    }) {
        try {
            const uid = parseInt(recipientId, 10);
            if (!uid || isNaN(uid) || !dedupeKey) {
                return { success: false, count: 0, message: 'Invalid recipientId or dedupeKey' };
            }

            const [existing] = await db.query(`
                SELECT notification_id
                FROM notifications
                WHERE user_id = ?
                  AND role = ?
                  AND event_type = ?
                  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.dedupeKey')) = ?
                LIMIT 1
            `, [uid, role, eventType, String(dedupeKey)]);

            if (existing && existing.length > 0) {
                return { success: true, skipped: true, notificationId: existing[0].notification_id };
            }

            return await this.dispatch({
                recipientIds: uid,
                actorId,
                role,
                category,
                priority,
                eventType,
                title,
                message,
                targetUrl,
                metadata: { ...(metadata || {}), dedupeKey: String(dedupeKey) }
            });
        } catch (err) {
            console.error('[NotificationService.dispatchOnce Error]', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * One-time idempotent repair of historical Teacher notification rows (target_url & role normalization).
     */
    async repairLegacyTeacherNotifications() {
        if (this._legacyRepaired) return;
        this._legacyRepaired = true;
        try {
            // 1. Rewrite /teacher/question_bank -> /teacher/question-bank
            await db.query(`
                UPDATE notifications
                SET target_url = REPLACE(target_url, '/teacher/question_bank', '/teacher/question-bank')
                WHERE INSTR(target_url, '/teacher/question_bank') = 1
            `);

            // 2. Rewrite /forums/view/:id... -> /teacher/forums?forum_id=:id#forum-:id for Teacher users
            const [forumRows] = await db.query(`
                SELECT n.notification_id, n.target_url
                FROM notifications n
                JOIN users u ON n.user_id = u.user_id
                WHERE u.role = 'Teacher'
                  AND INSTR(n.target_url, '/forums/view/') = 1
            `);
            for (const row of forumRows) {
                const m = (row.target_url || '').match(/^\/forums\/view\/(\d+)/);
                const newUrl = m ? `/teacher/forums?forum_id=${m[1]}#forum-${m[1]}` : '/teacher/forums';
                await db.query(
                    `UPDATE notifications SET target_url = ?, role = 'Teacher' WHERE notification_id = ?`,
                    [newUrl, row.notification_id]
                );
            }

            // 2b. Scrub actor_id on any historical notifications triggered by an anonymous forum reply
            try {
                await db.query(`
                    UPDATE notifications n
                    JOIN forum_replies fr ON fr.reply_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(n.metadata, '$.replyId')) AS UNSIGNED)
                    SET n.actor_id = NULL,
                        n.title = CASE WHEN n.event_type = 'forum_mention' THEN 'Mentioned by Anonymous Student' ELSE n.title END
                    WHERE n.event_type IN ('forum_reply_received', 'forum_mention')
                      AND fr.is_anonymous = 1
                      AND n.actor_id IS NOT NULL
                `);
            } catch (_) {}

            // 3. Ensure Teacher announcement notifications point to /teacher/dashboard instead of student /dashboard
            await db.query(`
                UPDATE notifications n
                JOIN users u ON n.user_id = u.user_id
                SET n.target_url = '/teacher/dashboard'
                WHERE u.role = 'Teacher'
                  AND n.role = 'Teacher'
                  AND n.event_type = 'announcement_created'
                  AND INSTR(n.target_url, '/dashboard') = 1
            `);
        } catch (err) {
            console.warn('[repairLegacyTeacherNotifications Warning]', err.message);
        }
    }

    /**
     * Synchronize state-driven / proactive Teacher alerts into the persistent notifications table.
     * Throttled per teacherId (60s TTL) so frequent polling remains lightweight.
     */
    async syncTeacherProactiveAlerts(teacherId, force = false) {
        await this.repairLegacyTeacherNotifications();

        const tid = parseInt(teacherId, 10);
        if (!tid || isNaN(tid)) return;

        const now = Date.now();
        const lastSync = this._teacherSyncCache.get(tid) || 0;
        if (!force && (now - lastSync) < 60000) {
            return;
        }
        this._teacherSyncCache.set(tid, now);

        // 1. T-05: Ungraded Deliverable / Essay Backlog Reminder
        try {
            const [backlogs] = await db.query(`
                SELECT 
                    a.assessment_id,
                    a.assessment_name,
                    c.class_id,
                    c.class_name,
                    COUNT(DISTINCT ss.score_id) AS ungraded_count
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                JOIN student_scores ss ON ss.assessment_id = a.assessment_id
                JOIN class_students cs ON cs.class_id = c.class_id AND cs.student_id = ss.student_id
                WHERE c.teacher_id = ?
                  AND ss.score_obtained IS NULL
                  AND (ss.submitted_at IS NOT NULL OR ss.file_path IS NOT NULL)
                GROUP BY a.assessment_id, a.assessment_name, c.class_id, c.class_name
                HAVING ungraded_count > 0
            `, [tid]);

            for (const row of backlogs) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: null,
                    role: 'Teacher',
                    category: 'assessment',
                    priority: 'normal',
                    eventType: 'ungraded_backlog_reminder',
                    title: `Ungraded Submissions: ${row.assessment_name}`,
                    message: `${row.ungraded_count} submission${row.ungraded_count > 1 ? 's' : ''} in ${row.class_name} awaiting grading for "${row.assessment_name}".`,
                    targetUrl: `/teacher/grading-workspace/${row.assessment_id}`,
                    dedupeKey: `backlog_${row.assessment_id}_${row.class_id}_${row.ungraded_count}`,
                    metadata: { assessmentId: row.assessment_id, classId: row.class_id, ungradedCount: row.ungraded_count }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: ungraded_backlog_reminder]', err.message);
        }

        // 2. T-08: Upcoming Assessment Deadline (Due within 3 days)
        try {
            const [deadlines] = await db.query(`
                SELECT 
                    a.assessment_id,
                    a.assessment_name,
                    DATE_FORMAT(a.due_date, '%b %d, %Y %h:%i %p') AS due_formatted,
                    c.class_id,
                    c.class_name
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                  AND a.due_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 3 DAY)
            `, [tid]);

            for (const row of deadlines) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: null,
                    role: 'Teacher',
                    category: 'assessment',
                    priority: 'normal',
                    eventType: 'upcoming_deadline',
                    title: `Upcoming Deadline: ${row.assessment_name}`,
                    message: `"${row.assessment_name}" (${row.class_name}) is due on ${row.due_formatted}.`,
                    targetUrl: `/teacher/class/${row.class_id}?tab=content`,
                    dedupeKey: `deadline_${row.assessment_id}_${row.class_id}`,
                    metadata: { assessmentId: row.assessment_id, classId: row.class_id }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: upcoming_deadline]', err.message);
        }

        // 3. T-09: Locked Assessment Past Due Date Warning
        try {
            const [lockedPastDue] = await db.query(`
                SELECT 
                    a.assessment_id,
                    a.assessment_name,
                    DATE_FORMAT(a.due_date, '%b %d, %Y') AS due_formatted,
                    c.class_id,
                    c.class_name
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                  AND a.is_unlocked = 0
                  AND a.due_date IS NOT NULL
                  AND a.due_date < NOW()
            `, [tid]);

            for (const row of lockedPastDue) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: null,
                    role: 'Teacher',
                    category: 'assessment',
                    priority: 'high',
                    eventType: 'locked_assessment_past_due',
                    title: `Locked Assessment Past Due: ${row.assessment_name}`,
                    message: `"${row.assessment_name}" in ${row.class_name} passed its due date (${row.due_formatted}) while still locked.`,
                    targetUrl: `/teacher/class/${row.class_id}?tab=content`,
                    dedupeKey: `locked_past_due_${row.assessment_id}_${row.class_id}`,
                    metadata: { assessmentId: row.assessment_id, classId: row.class_id }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: locked_assessment_past_due]', err.message);
        }

        // 4. T-12: Struggling / At-Risk Student Alert (< 50% Subject Mastery, strictly enrolled in teacher's class)
        try {
            const [struggling] = await db.query(`
                SELECT 
                    u.user_id AS student_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                    sp.progress_percent,
                    s.subject_name,
                    c.class_id,
                    c.class_name
                FROM student_progress sp
                JOIN users u ON sp.student_id = u.user_id
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                JOIN class_students cs ON cs.class_id = c.class_id AND cs.student_id = u.user_id
                WHERE c.teacher_id = ?
                  AND sp.progress_percent > 0
                  AND sp.progress_percent < 50
            `, [tid]);

            for (const row of struggling) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: row.student_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'high',
                    eventType: 'struggling_student',
                    title: `At-Risk Student: ${row.student_name}`,
                    message: `${row.student_name} (${row.class_name}) is struggling in ${row.subject_name} (${row.progress_percent}% mastery).`,
                    targetUrl: `/teacher/class/${row.class_id}?tab=students`,
                    dedupeKey: `struggling_${row.student_id}_${row.class_id}`,
                    metadata: { studentId: row.student_id, classId: row.class_id, progressPercent: row.progress_percent }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: struggling_student]', err.message);
        }

        // 5. T-14: Lab Safety Lockout Risk Alert (Levels 1-2 accuracy < 60% with >= 3 attempts)
        try {
            const [safetyRisks] = await db.query(`
                SELECT 
                    u.user_id AS student_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                    c.class_id,
                    c.class_name,
                    COUNT(ca.attempt_id) AS total_attempts,
                    ROUND(SUM(ca.is_correct = 1) / COUNT(ca.attempt_id) * 100) AS accuracy_pct
                FROM elementa_customer_attempts ca
                JOIN elementa_level_runs lr ON lr.run_id = ca.run_id
                JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
                JOIN users u ON u.user_id = (CASE lr.player_number WHEN 2 THEN gs.student_id_p2 ELSE gs.student_id_p1 END)
                JOIN class_students cs ON cs.student_id = u.user_id
                JOIN classes c ON c.class_id = cs.class_id
                WHERE c.teacher_id = ?
                  AND COALESCE(ca.level_number, lr.level_number) IN (1, 2)
                GROUP BY u.user_id, student_name, c.class_id, c.class_name
                HAVING total_attempts >= 3 AND accuracy_pct < 60
            `, [tid]);

            for (const row of safetyRisks) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: row.student_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'high',
                    eventType: 'safety_lockout_triggered',
                    title: `Lab Safety Lockout Risk: ${row.student_name}`,
                    message: `${row.student_name} (${row.class_name}) has ${row.accuracy_pct}% accuracy on Lab Safety & Equipment (Levels 1–2).`,
                    targetUrl: `/teacher/arcade-telemetry?class_id=${row.class_id}`,
                    dedupeKey: `safety_lockout_${row.student_id}_${row.class_id}`,
                    metadata: { studentId: row.student_id, classId: row.class_id, accuracyPct: row.accuracy_pct }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: safety_lockout_triggered]', err.message);
        }

        // 6. T-18: Question Awaiting Admin Verification
        try {
            const [pendingQs] = await db.query(`
                SELECT question_id, LEFT(prompt, 60) AS prompt_preview
                FROM elementa_questions
                WHERE teacher_id = ?
                  AND verification_status = 'Pending'
                  AND is_active = 1
                ORDER BY created_at DESC
                LIMIT 10
            `, [tid]);

            for (const row of pendingQs) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: tid,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'low',
                    eventType: 'pending_question',
                    title: `Question Pending Verification`,
                    message: `Your submitted question "${row.prompt_preview}..." is awaiting Admin review.`,
                    targetUrl: `/teacher/question-bank?tab=status&sub=pending&q=${row.question_id}`,
                    dedupeKey: `pending_q_${row.question_id}`,
                    metadata: { questionId: row.question_id }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: pending_question]', err.message);
        }

        // 7. T-31: Class Calendar Event Today Reminder
        try {
            const [calEvents] = await db.query(`
                SELECT 
                    ce.event_id,
                    ce.event_title,
                    ce.event_type,
                    DATE_FORMAT(ce.event_date, '%Y-%m-%d') AS event_day,
                    MIN(c.class_id) AS class_id,
                    MIN(c.class_name) AS class_name
                FROM calendar_events ce
                JOIN classes c ON ce.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                  AND DATE(ce.event_date) = CURDATE()
                GROUP BY ce.event_id, ce.event_title, ce.event_type, event_day
            `, [tid]);

            for (const row of calEvents) {
                await this.dispatchOnce({
                    recipientId: tid,
                    actorId: tid,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'calendar_event_reminder',
                    title: `Today's Schedule: ${row.event_title}`,
                    message: `${row.event_type || 'Class Event'} "${row.event_title}" is scheduled for today (${row.class_name}).`,
                    targetUrl: `/teacher/class/${row.class_id}?tab=calendar`,
                    dedupeKey: `cal_${row.event_id}_${row.event_day}`,
                    metadata: { eventId: row.event_id, classId: row.class_id }
                });
            }
        } catch (err) {
            console.warn('[syncTeacherProactiveAlerts: calendar_event_reminder]', err.message);
        }
    }

    /**
     * Retrieve paginated notifications for a specific user.
     */
    async getUserNotifications(arg1, arg2 = {}) {
        try {
            const opts = (typeof arg1 === 'object' && arg1 !== null) ? arg1 : { userId: arg1, ...arg2 };
            const uid = parseInt(opts.userId, 10);
            const role = opts.role || null;
            const p = Math.max(1, parseInt(opts.page, 10) || 1);
            const lim = Math.min(50, Math.max(1, parseInt(opts.limit, 10) || 20));
            const offset = (p - 1) * lim;
            const unreadOnly = opts.unreadOnly;
            const category = opts.category;

            let whereClauses = ['n.user_id = ?', 'n.is_dismissed = 0'];
            let params = [uid];

            if (role) {
                whereClauses.push('n.role = ?');
                params.push(role);
            }

            if (unreadOnly) {
                whereClauses.push('n.is_read = 0');
            }

            if (category && category !== 'all') {
                whereClauses.push('n.category = ?');
                params.push(category);
            }

            const whereSql = whereClauses.join(' AND ');

            // Fetch notification items with optional actor profile info
            const [items] = await db.query(`
                SELECT 
                    n.notification_id,
                    n.user_id,
                    n.actor_id,
                    n.role,
                    n.category,
                    n.priority,
                    n.event_type,
                    n.title,
                    n.message,
                    n.target_url,
                    n.metadata,
                    n.is_read,
                    n.read_at,
                    n.created_at,
                    CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                    u.profile_pic AS actor_pic
                FROM notifications n
                LEFT JOIN users u ON n.actor_id = u.user_id
                WHERE ${whereSql}
                ORDER BY n.created_at DESC
                LIMIT ? OFFSET ?
            `, [...params, lim, offset]);

            // Total count for pagination
            const [countResult] = await db.query(`
                SELECT COUNT(*) AS total 
                FROM notifications n 
                WHERE ${whereSql}
            `, params);
            const total = countResult[0]?.total || 0;

            // Fast unread count scoped to role
            const unreadCount = await this.getUnreadCount({ userId: uid, role });

            return {
                success: true,
                notifications: items,
                total,
                unreadCount,
                page: p,
                limit: lim,
                totalPages: Math.ceil(total / lim) || 1
            };
        } catch (err) {
            console.error('[NotificationService.getUserNotifications Error]', err);
            return {
                success: false,
                notifications: [],
                total: 0,
                unreadCount: 0,
                page: 1,
                totalPages: 1,
                error: err.message
            };
        }
    }

    /**
     * Get count of unread notifications for navbar badges.
     */
    async getUnreadCount(arg1, arg2 = null) {
        try {
            const uid = parseInt(typeof arg1 === 'object' && arg1 !== null ? arg1.userId : arg1, 10);
            const role = (typeof arg1 === 'object' && arg1 !== null) ? (arg1.role || null) : arg2;
            if (isNaN(uid)) return 0;

            let sql = `
                SELECT COUNT(*) AS unread_count 
                FROM notifications 
                WHERE user_id = ? AND is_read = 0 AND is_dismissed = 0
            `;
            const params = [uid];
            if (role) {
                sql += ` AND role = ?`;
                params.push(role);
            }

            const [rows] = await db.query(sql, params);
            return rows[0]?.unread_count || 0;
        } catch (err) {
            console.error('[NotificationService.getUnreadCount Error]', err);
            return 0;
        }
    }

    /**
     * Mark a single notification as read.
     */
    async markAsRead(arg1, arg2, arg3 = null) {
        try {
            let uid, nid, role = null;
            if (typeof arg1 === 'object' && arg1 !== null) {
                uid = parseInt(arg1.userId, 10);
                nid = parseInt(arg1.notificationId, 10);
                role = arg1.role || null;
            } else {
                nid = parseInt(arg1, 10);
                uid = parseInt(arg2, 10);
                role = arg3 || null;
            }

            let sql = `
                UPDATE notifications 
                SET is_read = 1, read_at = NOW() 
                WHERE notification_id = ? AND user_id = ?
            `;
            const params = [nid, uid];
            if (role) {
                sql += ` AND role = ?`;
                params.push(role);
            }

            const [result] = await db.query(sql, params);

            const unreadCount = await this.getUnreadCount({ userId: uid, role });
            return { success: true, affected: result.affectedRows, unreadCount };
        } catch (err) {
            console.error('[NotificationService.markAsRead Error]', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Mark all unread notifications as read for a user.
     */
    async markAllAsRead(arg1, arg2 = null) {
        try {
            const uid = parseInt(typeof arg1 === 'object' && arg1 !== null ? arg1.userId : arg1, 10);
            const role = (typeof arg1 === 'object' && arg1 !== null) ? (arg1.role || null) : arg2;

            let sql = `
                UPDATE notifications 
                SET is_read = 1, read_at = NOW() 
                WHERE user_id = ? AND is_read = 0 AND is_dismissed = 0
            `;
            const params = [uid];
            if (role) {
                sql += ` AND role = ?`;
                params.push(role);
            }

            const [result] = await db.query(sql, params);
            return { success: true, affected: result.affectedRows, unreadCount: 0 };
        } catch (err) {
            console.error('[NotificationService.markAllAsRead Error]', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Soft-delete / dismiss a notification.
     */
    async dismissNotification(arg1, arg2, arg3 = null) {
        try {
            let uid, nid, role = null;
            if (typeof arg1 === 'object' && arg1 !== null) {
                uid = parseInt(arg1.userId, 10);
                nid = parseInt(arg1.notificationId, 10);
                role = arg1.role || null;
            } else {
                nid = parseInt(arg1, 10);
                uid = parseInt(arg2, 10);
                role = arg3 || null;
            }

            let sql = `
                UPDATE notifications 
                SET is_dismissed = 1 
                WHERE notification_id = ? AND user_id = ?
            `;
            const params = [nid, uid];
            if (role) {
                sql += ` AND role = ?`;
                params.push(role);
            }

            const [result] = await db.query(sql, params);

            const unreadCount = await this.getUnreadCount({ userId: uid, role });
            return { success: true, affected: result.affectedRows, unreadCount };
        } catch (err) {
            console.error('[NotificationService.dismissNotification Error]', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Process click-to-redirect:
     * Validates ownership, marks read, and retrieves destination URL.
     */
    async getNotificationForNavigation(arg1, arg2) {
        try {
            let uid, nid;
            if (typeof arg1 === 'object' && arg1 !== null) {
                uid = parseInt(arg1.userId, 10);
                nid = parseInt(arg1.notificationId, 10);
            } else {
                nid = parseInt(arg1, 10);
                uid = parseInt(arg2, 10);
            }

            const [rows] = await db.query(`
                SELECT notification_id, target_url, is_read, role
                FROM notifications
                WHERE notification_id = ? AND user_id = ?
                LIMIT 1
            `, [nid, uid]);

            if (rows.length === 0) return null;

            const notif = rows[0];

            // Mark read if unread
            if (!notif.is_read) {
                await db.query(`
                    UPDATE notifications 
                    SET is_read = 1, read_at = NOW() 
                    WHERE notification_id = ?
                `, [nid]);
            }

            return { ...notif, targetUrl: notif.target_url };
        } catch (err) {
            console.error('[NotificationService.getNotificationForNavigation Error]', err);
            return null;
        }
    }
}

module.exports = new NotificationService();
