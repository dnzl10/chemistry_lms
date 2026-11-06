/**
 * arcadeGradeSyncService.js
 * ============================================================================
 * Handles automated Gradebook Synchronization and Micro-Telemetry Remediation.
 * 
 * 1. Upon session completion (when linked to a Competitive assessment):
 *    - Records final score and exp into `student_scores`.
 *    - Accrues XP into `users.total_exp`.
 * 
 * 2. Micro-Telemetry Remediation Triggering:
 *    - Inspects the attempts from the level run.
 *    - Detects targeted failure triggers:
 *      * >= 2 Timeouts (Cognitive freeze / severe disorientation)
 *      * >= 3 WrongConfig / WrongNumber failures (Valence / unit / calibration error)
 *    - Dispatches a targeted academic notification to the student linking them
 *      directly to the relevant reading material in `learning_materials`.
 * ============================================================================
 */

const pool = require('../db');
const levelProgressionService = require('./levelProgressionService');

/**
 * Synchronize completed session with the LMS gradebook and student profile.
 */
async function syncSessionToGradebook(sessionId) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Fetch Session and Linked Assessment
        const [sessionRows] = await conn.query(
            `SELECT session_id, student_id_p1, student_id_p2, assessment_id, 
                    class_id, final_score_p1, final_score_p2, highest_level_reached,
                    is_synced_to_gradebook
             FROM elementa_game_sessions 
             WHERE session_id = ?`,
            [sessionId]
        );

        if (!sessionRows || sessionRows.length === 0) {
            await conn.rollback();
            return { success: false, reason: 'Session not found' };
        }

        const session = sessionRows[0];
        const assessmentId = session.assessment_id;

        // Free-play runs (assessmentId = null) are not graded in student_scores
        if (!assessmentId) {
            await conn.query(
                `UPDATE elementa_game_sessions SET is_synced_to_gradebook = 1 WHERE session_id = ?`,
                [sessionId]
            );
            await conn.commit();
            return { success: true, graded: false, message: 'Free-play session recorded' };
        }

        const [assessmentRows] = await conn.query(
            `SELECT assessment_id, assessment_name, total_items, topic_id, due_date, allow_grace, grace_period_minutes FROM assessments WHERE assessment_id = ?`,
            [assessmentId]
        );
        const asmt = assessmentRows[0] || {};
        let totalItems = asmt.total_items || 0;
        if (!totalItems || totalItems <= 0) {
            const [[cntRow]] = await conn.query(
                `SELECT COUNT(*) AS cnt FROM elementa_assessment_questions WHERE assessment_id = ?`,
                [assessmentId]
            );
            totalItems = cntRow?.cnt || 10;
        }
        const assessmentName = asmt.assessment_name || 'Arcade Assessment';
        const topicId = asmt.topic_id || null;

        // Grace period calculation
        let isGracePeriod = 0;
        let graceMinutesUsed = 0;
        if (asmt.due_date && asmt.allow_grace) {
            const dueDate = new Date(asmt.due_date);
            const completionDate = session.ended_at ? new Date(session.ended_at) : new Date();
            const diffMs = completionDate - dueDate;
            if (diffMs > 0) {
                const diffMin = Math.ceil(diffMs / 60000);
                const graceLimit = Number(asmt.grace_period_minutes) || 15;
                if (diffMin <= graceLimit) {
                    isGracePeriod = 1;
                    graceMinutesUsed = diffMin;
                }
            }
        }

        const playersToSync = [];
        if (session.student_id_p1 && session.student_id_p1 > 0) {
            playersToSync.push({ 
                id: session.student_id_p1, 
                playerNumber: 1, 
                score: Number(session.final_score_p1) || 0 
            });
        }
        if (session.student_id_p2 && session.student_id_p2 > 0) {
            playersToSync.push({ 
                id: session.student_id_p2, 
                playerNumber: 2, 
                score: Number(session.final_score_p2) || 0 
            });
        }

        const playerSyncDetails = [];
        for (const player of playersToSync) {
            // Dynamic base_exp from questions answered correctly in this session
            let expEarned = 0;
            try {
                const [[expRow]] = await conn.query(
                    `SELECT COALESCE(SUM(COALESCE(qb.base_exp, 100)), 0) AS earned_exp
                     FROM elementa_customer_attempts ca
                     JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                     LEFT JOIN question_bank qb ON ca.question_id = qb.question_id
                     WHERE lr.session_id = ? AND lr.player_number = ? AND ca.is_correct = 1`,
                    [sessionId, player.playerNumber]
                );
                if (expRow && Number(expRow.earned_exp) > 0) {
                    expEarned = Number(expRow.earned_exp);
                }
            } catch (expErr) {
                console.warn('[syncSessionToGradebook:expCalc]', expErr.message);
            }

            // Fallback: standard 100 EXP per point scored
            if (expEarned <= 0) {
                expEarned = player.score * 100;
            }

            // Check if student_scores record already exists
            const [existingScores] = await conn.query(
                `SELECT score_id, score_obtained, exp_gained FROM student_scores WHERE student_id = ? AND assessment_id = ? ORDER BY score_id DESC LIMIT 1`,
                [player.id, assessmentId]
            );

            let expDelta = expEarned;
            if (existingScores.length > 0) {
                const existing = existingScores[0];
                expDelta = Math.max(0, expEarned - (Number(existing.exp_gained) || 0));
                await conn.query(
                    `UPDATE student_scores 
                     SET score_obtained = GREATEST(score_obtained, ?),
                         total_possible_score = ?,
                         total_items = ?,
                         exp_gained = GREATEST(COALESCE(exp_gained, 0), ?),
                         is_grace_period = CASE WHEN ? = 1 THEN 1 ELSE is_grace_period END,
                         grace_minutes_used = GREATEST(COALESCE(grace_minutes_used, 0), ?),
                         date_recorded = NOW(),
                         submitted_at = COALESCE(submitted_at, NOW())
                     WHERE score_id = ?`,
                    [player.score, totalItems, totalItems, expEarned, isGracePeriod, graceMinutesUsed, existing.score_id]
                );
            } else {
                await conn.query(
                    `INSERT INTO student_scores 
                     (student_id, assessment_id, score_obtained, total_possible_score, total_items, exp_gained, feedback, date_recorded, submitted_at, is_sanitized, is_grace_period, grace_minutes_used)
                     VALUES (?, ?, ?, ?, ?, ?, 'Completed via Elementa Arcade.', NOW(), NOW(), 1, ?, ?)`,
                    [player.id, assessmentId, player.score, totalItems, totalItems, expEarned, isGracePeriod, graceMinutesUsed]
                );
                // If session was already synced in a prior run, users.total_exp was already credited
                if (session.is_synced_to_gradebook === 1) {
                    expDelta = 0;
                }
            }

            // Increment users.total_exp only by positive delta to avoid duplicate EXP
            if (expDelta > 0) {
                await conn.query(
                    `UPDATE users SET total_exp = total_exp + ? WHERE user_id = ?`,
                    [expDelta, player.id]
                );
            }

            // Recalculate level dynamically based on Total Max EXP
            let levelStats = null;
            try {
                levelStats = await levelProgressionService.recalculateStudentLevel(player.id, conn);
            } catch (lvlErr) {
                console.warn('[syncSessionToGradebook:recalculateStudentLevel]', lvlErr.message);
            }

            const [[userRow]] = await conn.query(
                `SELECT total_exp, current_level FROM users WHERE user_id = ?`,
                [player.id]
            );

            playerSyncDetails.push({
                studentId: player.id,
                playerNumber: player.playerNumber,
                score: player.score,
                totalItems: totalItems,
                expEarned: expEarned,
                expDelta: expDelta,
                totalExp: userRow ? userRow.total_exp : 0,
                currentLevel: levelStats ? levelStats.current_level : (userRow?.current_level || 1),
                levelTitle: levelStats?.level_title || 'Cadet',
                progressPct: levelStats?.progress_pct || 0,
                bracketSize: levelStats?.bracket_size || 0,
                totalMaxExp: levelStats?.total_max_exp || 0
            });

            // Run Micro-Telemetry Remediation Evaluation
            await evaluateMicroTelemetryRemediation(conn, sessionId, player.id, topicId, assessmentName);
        }

        await conn.query(
            `UPDATE elementa_game_sessions SET is_synced_to_gradebook = 1 WHERE session_id = ?`,
            [sessionId]
        );

        await conn.commit();
        return { 
            success: true, 
            graded: true, 
            syncedStudents: playersToSync.length,
            playerSyncDetails
        };
    } catch (err) {
        await conn.rollback();
        console.error('[arcadeGradeSyncService.syncSessionToGradebook]', err);
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Evaluates fine-grained micro-telemetry and dispatches targeted remediation notifications.
 */
async function evaluateMicroTelemetryRemediation(conn, sessionId, studentId, topicId, assessmentName) {
    try {
        const [attempts] = await conn.query(
            `SELECT ca.is_correct, ca.is_timeout, ca.failure_type, ca.machine_used, ca.response_time_s
             FROM elementa_customer_attempts ca
             JOIN elementa_level_runs lr ON lr.run_id = ca.run_id
             JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
             WHERE gs.session_id = ? 
               AND (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)`,
            [sessionId, studentId, studentId]
        );

        if (!attempts || attempts.length === 0) return;

        let timeouts = 0;
        let configErrors = 0;
        let numberErrors = 0;
        let mostTroubledMachine = null;
        const machineErrors = {};

        for (const a of attempts) {
            if (a.is_timeout) timeouts++;
            if (a.failure_type === 'WrongConfig') configErrors++;
            if (a.failure_type === 'WrongNumber') numberErrors++;
            if (!a.is_correct && a.machine_used) {
                machineErrors[a.machine_used] = (machineErrors[a.machine_used] || 0) + 1;
            }
        }

        // Find machine with most errors
        let maxErr = 0;
        for (const [m, count] of Object.entries(machineErrors)) {
            if (count > maxErr) {
                maxErr = count;
                mostTroubledMachine = m;
            }
        }

        let needsRemediation = false;
        let diagnosticReason = '';

        if (timeouts >= 2) {
            needsRemediation = true;
            diagnosticReason = `You encountered ${timeouts} timeouts during the lab exercise, suggesting cognitive freeze or difficulty navigating the station.`;
        } else if (configErrors >= 2) {
            needsRemediation = true;
            diagnosticReason = `You had multiple chemical configuration errors in the ${mostTroubledMachine || 'workstation'}. Review valence and naming rules.`;
        } else if (numberErrors >= 3) {
            needsRemediation = true;
            diagnosticReason = `Precision calibration drift detected in ${mostTroubledMachine || 'the lab'}. Review unit conversions and tolerance reading.`;
        }

        if (needsRemediation) {
            // Find recommended material
            let targetUrl = '/leaderboard';
            let materialTitle = 'Recommended Chemistry Review Note';

            if (topicId) {
                const [mats] = await conn.query(
                    `SELECT material_id, title FROM learning_materials WHERE topic_id = ? LIMIT 1`,
                    [topicId]
                );
                if (mats && mats.length > 0) {
                    targetUrl = `/material_uploads/${mats[0].material_id}`;
                    materialTitle = mats[0].title;
                }
            }

            // Create notification in LMS
            await conn.query(
                `INSERT INTO notifications
                    (user_id, role, category, priority, event_type, title, message, target_url)
                 VALUES (?, 'Student', 'academic', 'high', 'arcade_remediation_flag', ?, ?, ?)`,
                [
                    studentId,
                    `🎯 Targeted Lab Remediation: ${assessmentName}`,
                    `${diagnosticReason} Review the assigned study guide: "${materialTitle}".`,
                    targetUrl
                ]
            );

            // T-13: Dispatch Teacher notification for arcade remediation triggered
            try {
                const [teacherRows] = await conn.query(
                    `SELECT u.first_name, u.last_name, c.teacher_id, c.class_id
                     FROM users u
                     JOIN class_students cs ON cs.student_id = u.user_id
                     JOIN classes c ON cs.class_id = c.class_id
                     LEFT JOIN topics t ON t.topic_id = ?
                     LEFT JOIN quarters q ON q.quarter_id = t.quarter_id
                     WHERE u.user_id = ? AND c.teacher_id IS NOT NULL
                       AND (q.subject_id IS NULL OR c.subject_id = q.subject_id)
                     LIMIT 1`,
                    [topicId, studentId]
                );
                if (teacherRows && teacherRows.length > 0) {
                    const tr = teacherRows[0];
                    const studentName = `${tr.first_name || ''} ${tr.last_name || ''}`.trim() || 'A student';
                    await conn.query(
                        `INSERT INTO notifications
                            (user_id, actor_id, role, category, priority, event_type, title, message, target_url)
                         VALUES (?, ?, 'Teacher', 'academic', 'high', 'arcade_remediation_triggered', ?, ?, ?)`,
                        [
                            tr.teacher_id,
                            studentId,
                            `Lab Telemetry Alert: ${studentName}`,
                            `${studentName} triggered auto-remediation on ${mostTroubledMachine || 'Lab Station'} during '${assessmentName}'.`,
                            `/teacher/arcade-telemetry?classId=${tr.class_id}`
                        ]
                    );
                }
            } catch (tErr) {
                console.error('[arcadeGradeSyncService:TeacherRemediationNotifError]', tErr.message);
            }
        }
    } catch (err) {
        console.error('[arcadeGradeSyncService.evaluateMicroTelemetryRemediation]', err);
    }
}

module.exports = {
    syncSessionToGradebook,
    evaluateMicroTelemetryRemediation
};
