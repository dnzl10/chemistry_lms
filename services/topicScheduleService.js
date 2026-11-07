/**
 * services/topicScheduleService.js
 * ============================================================================
 * Automatic Topic Unlock & Lock Scheduler Service.
 *
 * Responsibilities:
 * 1. Ensures `auto_unlock_at` and `auto_lock_at` columns exist on `topics`.
 * 2. Evaluates due `auto_unlock_at` and `auto_lock_at` schedules both on a
 *    60-second background interval AND on-demand during Student/Teacher/Admin
 *    page reads for zero-lag accuracy.
 * 3. Consumes (clears) triggered schedule timestamps once applied so subsequent
 *    manual lock/unlock actions by a Teacher or Admin are never overridden by
 *    stale past timestamps.
 * 4. Dispatches student notifications when a topic automatically unlocks.
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
     * Evaluate and apply any due `auto_unlock_at` and `auto_lock_at` schedules right now.
     * Safe to call on-demand before Student/Teacher/Admin topic queries as well as from cron.
     */
    async evaluateNow() {
        if (this.isEvaluating) return { unlocked: 0, locked: 0 };
        this.isEvaluating = true;

        let unlockedCount = 0;
        let lockedCount = 0;

        try {
            await this.ensureSchema();

            // 1. Process due AUTO-UNLOCK schedules (auto_unlock_at <= NOW())
            // If both auto_unlock_at and auto_lock_at are in the past and auto_lock_at > auto_unlock_at,
            // step 2 below will immediately apply the subsequent lock.
            const [dueUnlocks] = await db.query(`
                SELECT t.topic_id, t.topic_name, t.quarter_id, t.is_locked,
                       q.subject_id, q.quarter_number, q.is_locked AS quarter_is_locked,
                       s.subject_name
                FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                WHERE t.auto_unlock_at IS NOT NULL
                  AND t.auto_unlock_at <= NOW()
            `);

            for (const row of dueUnlocks) {
                const wasLocked = Number(row.is_locked) === 1;
                await db.query(
                    `UPDATE topics SET is_locked = 0, auto_unlock_at = NULL WHERE topic_id = ?`,
                    [row.topic_id]
                );

                // Ensure parent quarter is also unlocked so students can see the newly unlocked topic
                if (Number(row.quarter_is_locked) === 1) {
                    await db.query(
                        `UPDATE quarters SET is_locked = 0 WHERE quarter_id = ?`,
                        [row.quarter_id]
                    );
                }

                if (wasLocked) {
                    unlockedCount++;
                    // Notify enrolled students in classes for this subject
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

            // 2. Process due AUTO-LOCK schedules (auto_lock_at <= NOW())
            const [dueLocks] = await db.query(`
                SELECT t.topic_id, t.topic_name, t.is_locked
                FROM topics t
                WHERE t.auto_lock_at IS NOT NULL
                  AND t.auto_lock_at <= NOW()
            `);

            for (const row of dueLocks) {
                const wasUnlocked = Number(row.is_locked) === 0;
                await db.query(
                    `UPDATE topics SET is_locked = 1, auto_lock_at = NULL WHERE topic_id = ?`,
                    [row.topic_id]
                );
                if (wasUnlocked) {
                    lockedCount++;
                }
            }

            return { unlocked: unlockedCount, locked: lockedCount };
        } catch (err) {
            console.error('[TopicScheduleService Evaluate Error]', err.message);
            return { unlocked: 0, locked: 0 };
        } finally {
            this.isEvaluating = false;
        }
    }

    /**
     * Start the periodic background scanner.
     * @param {number} [intervalMs=60000] - Default check interval (60 seconds)
     */
    start(intervalMs = 60000) {
        if (this.timer) clearInterval(this.timer);

        setTimeout(() => {
            this.evaluateNow();
        }, 5000);

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

