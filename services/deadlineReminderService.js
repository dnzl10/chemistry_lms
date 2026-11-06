/**
 * services/deadlineReminderService.js
 * Background scheduler for proactive assessment deadline notifications.
 * Runs non-blocking hourly checks for unsubmitted assessments due within 24 hours.
 */

const db = require('../db');
const notificationService = require('./notificationService');

class DeadlineReminderService {
    constructor() {
        this.timer = null;
    }

    /**
     * Check for unsubmitted assessments due in the next 24 hours and notify students.
     */
    async checkUpcomingDeadlines() {
        try {
            // Find unsubmitted assessments due within the next 24 hours for enrolled students
            const [rows] = await db.query(`
                SELECT 
                    a.assessment_id, 
                    a.assessment_name, 
                    a.due_date, 
                    c.class_id, 
                    cs.student_id
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                JOIN class_students cs ON c.class_id = cs.class_id
                LEFT JOIN student_scores ss ON a.assessment_id = ss.assessment_id AND cs.student_id = ss.student_id
                WHERE ss.score_id IS NULL
                  AND a.due_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
            `);

            if (!rows || rows.length === 0) return 0;

            let sentCount = 0;
            for (const row of rows) {
                // Check if student was already notified about this assessment deadline
                const [existing] = await db.query(`
                    SELECT notification_id 
                    FROM notifications 
                    WHERE user_id = ? 
                      AND event_type = 'deadline_warning_24h'
                      AND JSON_EXTRACT(metadata, '$.assessmentId') = ?
                    LIMIT 1
                `, [row.student_id, row.assessment_id]);

                if (existing.length === 0) {
                    const dueDateStr = new Date(row.due_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    await notificationService.dispatch({
                        recipientIds: row.student_id,
                        role: 'Student',
                        category: 'assessment',
                        priority: 'high',
                        eventType: 'deadline_warning_24h',
                        title: `Upcoming Deadline: ${row.assessment_name}`,
                        message: `This assessment is due soon (today at ${dueDateStr}). Be sure to submit on time.`,
                        targetUrl: `/subjects/open/${row.class_id}`,
                        metadata: { assessmentId: row.assessment_id, classId: row.class_id }
                    });
                    sentCount++;
                }
            }

            return sentCount;
        } catch (err) {
            console.error('[DeadlineReminderService Error]', err.message);
            return 0;
        }
    }

    /**
     * Start the periodic scanner.
     * @param {number} [intervalMs=3600000] - Default check interval (1 hour)
     */
    start(intervalMs = 3600000) {
        if (this.timer) clearInterval(this.timer);
        
        // Initial run after brief delay to allow server initialization
        setTimeout(() => {
            this.checkUpcomingDeadlines();
        }, 10000);

        // Periodic hourly interval
        this.timer = setInterval(() => {
            this.checkUpcomingDeadlines();
        }, intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = new DeadlineReminderService();
