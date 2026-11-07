/**
 * services/topicScheduleService.js
 * ============================================================================
 * Timezone-Safe Automatic Topic Unlock & Lock Scheduler Service.
 *
 * All schedule comparisons operate in Philippine Standard Time (Asia/Manila,
 * UTC+08:00) so browser `<input type="datetime-local">` values match 1:1
 * regardless of the cloud database or container OS timezone.
 * ============================================================================
 */

const db = require('../db');
const notificationService = require('./notificationService');

class TopicScheduleService {
    constructor() {
        this.timer = null;
        this.schemaVerified = false;
        this.isEvaluating = false;
    }

    /**
     * Format a Date object (or timestamp) as 'YYYY-MM-DD HH:mm:ss' in Asia/Manila (UTC+8).
     */
    getManilaDateTimeString(dateInput = new Date()) {
        const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
        if (isNaN(d.getTime())) return null;
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).formatToParts(d);

        const map = {};
        for (const p of parts) {
            map[p.type] = p.value;
        }
        const hour = map.hour === '24' ? '00' : map.hour;
        return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}:${map.second}`;
    }

    /**
     * Parse a local wall-clock string ('YYYY-MM-DDTHH:mm' or 'YYYY-MM-DD HH:mm:ss')
     * as Asia/Manila (+08:00) epoch milliseconds.
     */
    parseManilaWallClockToMs(rawStr) {
        if (!rawStr) return NaN;
        if (rawStr instanceof Date) return rawStr.getTime();
        let s = String(rawStr).trim().replace(' ', 'T');
        if (!s) return NaN;
        // Strip any trailing Z or timezone offset if present, then attach +08:00
        s = s.replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i, '');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
            s += ':00';
        }
        const d = new Date(`${s}+08:00`);
        return d.getTime();
    }

    /**
     * Normalize and prepare { is_locked, auto_unlock_at, auto_lock_at } when saving a topic.
     * - If the user sets a schedule to "now" (within the current minute or <= now),
     *   schedules it for `now + 2 seconds` so the topic visibly transitions 1-2 seconds
     *   after saving.
     * - Automatically aligns initial `is_locked` state with the configured schedule:
     *   - If `auto_lock_at` is set (and no future `auto_unlock_at` precedes it), starts Unlocked (0)
     *     so it can lock when `auto_lock_at` is reached.
     *   - If `auto_unlock_at` is set, starts Locked (1) so it can unlock when `auto_unlock_at` is reached.
     */
    prepareTopicSchedulePayload({ is_locked, auto_unlock_at, auto_lock_at, fallbackLocked = 1 }) {
        const nowMs = Date.now();

        let unlockMs = (auto_unlock_at !== undefined && auto_unlock_at !== null && String(auto_unlock_at).trim() !== '')
            ? this.parseManilaWallClockToMs(auto_unlock_at)
            : null;
        let lockMs = (auto_lock_at !== undefined && auto_lock_at !== null && String(auto_lock_at).trim() !== '')
            ? this.parseManilaWallClockToMs(auto_lock_at)
            : null;

        if (unlockMs !== null && isNaN(unlockMs)) {
            throw new Error('Invalid Auto-Unlock date/time format.');
        }
        if (lockMs !== null && isNaN(lockMs)) {
            throw new Error('Invalid Auto-Lock date/time format.');
        }

        // If user selected "now" (e.g. current minute where :00 is up to 60s behind current seconds, or <= now),
        // bump to now + 2 seconds so it triggers right after saving ("after a second")
        if (unlockMs !== null && unlockMs <= nowMs + 1000) {
            unlockMs = nowMs + 2000;
        }
        if (lockMs !== null && lockMs <= nowMs + 1000) {
            lockMs = nowMs + 2000;
        }

        if (unlockMs !== null && lockMs !== null && lockMs <= unlockMs) {
            throw new Error('Auto-lock date/time must be later than the auto-unlock date/time.');
        }

        let finalLocked = (is_locked !== undefined && is_locked !== null && is_locked !== '')
            ? ((Number(is_locked) === 1 || is_locked === true || is_locked === '1') ? 1 : 0)
            : Number(fallbackLocked);

        // Ensure initial lock state allows the scheduled action to take effect:
        if (unlockMs !== null && unlockMs > nowMs) {
            // Waiting for auto-unlock -> topic should be locked until unlockMs
            finalLocked = 1;
        } else if (lockMs !== null && lockMs > nowMs && unlockMs === null) {
            // Waiting only for auto-lock -> topic must be unlocked now so it locks at lockMs
            finalLocked = 0;
        }

        return {
            is_locked: finalLocked,
            auto_unlock_at: unlockMs !== null ? this.getManilaDateTimeString(new Date(unlockMs)) : null,
            auto_lock_at: lockMs !== null ? this.getManilaDateTimeString(new Date(lockMs)) : null
        };
    }

    /**
     * Idempotently ensure `auto_unlock_at` and `auto_lock_at` columns exist on `topics`.
     */
    async ensureSchema() {
        if (this.schemaVerified) return true;
        try {
            const [cols] = await db.query(`SHOW COLUMNS FROM \`topics\``);
            const colNames = new Set(cols.map(c => c.Field));

            if (!colNames.has('auto_unlock_at')) {
                await db.query(`ALTER TABLE \`topics\` ADD COLUMN \`auto_unlock_at\` DATETIME NULL DEFAULT NULL`);
                console.log('[TopicScheduleService] Added missing column `auto_unlock_at` to `topics`.');
            }
            if (!colNames.has('auto_lock_at')) {
                await db.query(`ALTER TABLE \`topics\` ADD COLUMN \`auto_lock_at\` DATETIME NULL DEFAULT NULL`);
                console.log('[TopicScheduleService] Added missing column `auto_lock_at` to `topics`.');
            }

            this.schemaVerified = true;
            return true;
        } catch (err) {
            console.warn('[TopicScheduleService Schema Check Warning]', err.message);
            return false;
        }
    }

    /**
     * Evaluate and apply any due `auto_unlock_at` and `auto_lock_at` schedules right now
     * using Philippine Standard Time (Asia/Manila, UTC+8).
     */
    async evaluateNow() {
        if (this.isEvaluating) {
            return { unlocked: 0, locked: 0, unlockedTopics: [], lockedTopics: [] };
        }
        this.isEvaluating = true;

        let unlockedCount = 0;
        let lockedCount = 0;
        const unlockedTopics = [];
        const lockedTopics = [];

        try {
            await this.ensureSchema();

            const nowManila = this.getManilaDateTimeString(new Date());

            // 1. Process due AUTO-UNLOCK schedules (auto_unlock_at <= nowManila)
            const [dueUnlocks] = await db.query(`
                SELECT t.topic_id, t.topic_name, t.quarter_id, t.is_locked,
                       q.subject_id, q.quarter_number, q.is_locked AS quarter_is_locked,
                       s.subject_name
                FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                WHERE t.auto_unlock_at IS NOT NULL
                  AND DATE_FORMAT(t.auto_unlock_at, '%Y-%m-%d %H:%i:%s') <= ?
            `, [nowManila]);

            for (const row of dueUnlocks) {
                const wasLocked = Number(row.is_locked) === 1;
                await db.query(
                    `UPDATE topics SET is_locked = 0, auto_unlock_at = NULL WHERE topic_id = ?`,
                    [row.topic_id]
                );

                if (Number(row.quarter_is_locked) === 1) {
                    await db.query(
                        `UPDATE quarters SET is_locked = 0 WHERE quarter_id = ?`,
                        [row.quarter_id]
                    );
                }

                unlockedTopics.push({
                    topic_id: row.topic_id,
                    topic_name: row.topic_name,
                    quarter_id: row.quarter_id,
                    subject_id: row.subject_id
                });

                if (wasLocked) {
                    unlockedCount++;
                    try {
                        const [studentRows] = await db.query(`
                            SELECT DISTINCT cs.student_id, c.class_id
                            FROM classes c
                            JOIN class_students cs ON c.class_id = cs.class_id
                            WHERE c.subject_id = ?
                        `, [row.subject_id]);

                        if (studentRows && studentRows.length > 0) {
                            const studentIds = [...new Set(studentRows.map(r => r.student_id))];
                            await notificationService.dispatch({
                                recipientIds: studentIds,
                                actorId: null,
                                role: 'Student',
                                category: 'academic',
                                priority: 'normal',
                                eventType: 'topic_auto_unlocked',
                                title: `Topic Unlocked: ${row.topic_name}`,
                                message: `"${row.topic_name}" (Quarter ${row.quarter_number}) in ${row.subject_name} is now unlocked and available.`,
                                targetUrl: `/subjects/open/${row.subject_id}#topic-${row.topic_id}`,
                                metadata: {
                                    topicId: row.topic_id,
                                    quarterId: row.quarter_id,
                                    subjectId: row.subject_id
                                }
                            });
                        }
                    } catch (notifErr) {
                        console.error('[TopicScheduleService Auto-Unlock Notification Error]', notifErr.message);
                    }
                }
            }

            // 2. Process due AUTO-LOCK schedules (auto_lock_at <= nowManila)
            const [dueLocks] = await db.query(`
                SELECT t.topic_id, t.topic_name, t.quarter_id, t.is_locked,
                       q.subject_id, q.quarter_number, s.subject_name
                FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                WHERE t.auto_lock_at IS NOT NULL
                  AND DATE_FORMAT(t.auto_lock_at, '%Y-%m-%d %H:%i:%s') <= ?
            `, [nowManila]);

            for (const row of dueLocks) {
                const wasUnlocked = Number(row.is_locked) === 0;
                await db.query(
                    `UPDATE topics SET is_locked = 1, auto_lock_at = NULL WHERE topic_id = ?`,
                    [row.topic_id]
                );
                lockedTopics.push({
                    topic_id: row.topic_id,
                    topic_name: row.topic_name,
                    quarter_id: row.quarter_id,
                    subject_id: row.subject_id
                });
                if (wasUnlocked) {
                    lockedCount++;
                }
            }

            return { unlocked: unlockedCount, locked: lockedCount, unlockedTopics, lockedTopics };
        } catch (err) {
            console.error('[TopicScheduleService Evaluate Error]', err.message);
            return { unlocked: 0, locked: 0, unlockedTopics: [], lockedTopics: [] };
        } finally {
            this.isEvaluating = false;
        }
    }

    /**
     * Start the periodic background scanner.
     * @param {number} [intervalMs=5000] - Default check interval (5 seconds)
     */
    start(intervalMs = 5000) {
        if (this.timer) clearInterval(this.timer);

        setTimeout(() => {
            this.evaluateNow();
        }, 2000);

        this.timer = setInterval(() => {
            this.evaluateNow();
        }, intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = new TopicScheduleService();
