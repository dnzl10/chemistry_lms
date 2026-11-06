/**
 * forumExpService.js
 * ============================================================================
 * Centralized Dynamic Gamification & EXP Service for Forum Discussions.
 *
 * Implements:
 * 1. Early-Bird Time-Decay EXP Algorithm:
 *    - Pioneer / Early Bird (First 25% of window or within 24h): 100% Base EXP
 *    - Prompt Scholar (25% - 50% of window): 85% Base EXP
 *    - Standard On-Time (50% - 100% of window): 70% Base EXP
 *    - Late Turn-in (Past Deadline): 40% Base EXP
 *    - Fallback Podium (if no deadline): Top 3 get 100%, 4-8 get 85%, rest get 70%
 *
 * 2. Instructor Endorsement Quality Bonus (+50 EXP):
 *    - Awarded when teacher marks student response as officially endorsed
 *    - Clean reversion if endorsement is removed
 *
 * Connects directly to `users.total_exp` and `levelProgressionService.recalculateStudentLevel`.
 * ============================================================================
 */

const pool = require('../db');
const levelProgressionService = require('./levelProgressionService');

/**
 * Calculates dynamic EXP based on submission timing and deadline.
 *
 * @param {object} forum - Forum metadata { created_at, due_date, base_exp }
 * @param {Date|string} completedAt - Timestamp of student completion
 * @param {number} priorCompletionsCount - Number of students who completed before this student
 * @returns {{ expToAward: number, multiplier: number, timeTier: string, tierTitle: string }}
 */
function calculateForumExp(forum, completedAt = new Date(), priorCompletionsCount = 0) {
    const baseExp = parseInt(forum.base_exp, 10) || 100;
    const doneTime = new Date(completedAt).getTime();
    const startTime = new Date(forum.created_at || Date.now()).getTime();

    let multiplier = 0.70; // default standard
    let timeTier = 'standard';
    let tierTitle = '🕒 On-Time Completion';

    if (forum.due_date) {
        const dueTime = new Date(forum.due_date).getTime();
        const totalWindow = dueTime - startTime;
        const timeElapsed = doneTime - startTime;

        if (totalWindow > 0) {
            const ratio = timeElapsed / totalWindow;

            // Tier 1: Pioneer / Early Bird (First 25% or within first 24 hours)
            if (ratio <= 0.25 || timeElapsed <= 24 * 3600 * 1000) {
                multiplier = 1.0;
                timeTier = 'early_bird';
                tierTitle = '⚡ Early Bird / Pioneer';
            }
            // Tier 2: Prompt Scholar (25% to 50% of window)
            else if (ratio <= 0.50) {
                multiplier = 0.85;
                timeTier = 'prompt_scholar';
                tierTitle = '🏃 Prompt Scholar';
            }
            // Tier 3: Standard On-Time (50% to 100% of window)
            else if (ratio <= 1.00) {
                multiplier = 0.70;
                timeTier = 'standard';
                tierTitle = '🕒 On-Time Completion';
            }
            // Tier 4: Late Submission (Past deadline)
            else {
                multiplier = 0.40;
                timeTier = 'late';
                tierTitle = '⏳ Late Submission';
            }
        }
    } else {
        // Fallback Podium Tiering when no specific deadline is set
        if (priorCompletionsCount < 3) {
            multiplier = 1.0;
            timeTier = 'early_bird';
            tierTitle = '⚡ Pioneer Contributor (Top 3)';
        } else if (priorCompletionsCount < 8) {
            multiplier = 0.85;
            timeTier = 'prompt_scholar';
            tierTitle = '🏃 Prompt Contributor';
        } else {
            multiplier = 0.70;
            timeTier = 'standard';
            tierTitle = '🕒 Standard Completion';
        }
    }

    const expToAward = Math.round(baseExp * multiplier);
    return { expToAward, multiplier, timeTier, tierTitle };
}

/**
 * Awards completion EXP to student when they finish a forum activity.
 *
 * @param {object|null} dbConn - Database connection or null for default pool
 * @param {number} studentId - Target student ID
 * @param {number} forumId - Target forum ID
 * @param {Date|string} completedAt - Completion timestamp
 * @returns {Promise<object>} Result containing expAwarded, timeTier, tierTitle, and newLevel
 */
async function awardForumCompletionExp(dbConn, studentId, forumId, completedAt = new Date()) {
    const conn = dbConn || pool;

    // 1. Check if already marked done with EXP awarded
    const [existing] = await conn.execute(
        `SELECT id, exp_awarded, time_tier FROM student_forum_done WHERE student_id = ? AND forum_id = ?`,
        [studentId, forumId]
    );

    if (existing.length > 0 && existing[0].exp_awarded > 0) {
        return {
            alreadyAwarded: true,
            expAwarded: existing[0].exp_awarded,
            timeTier: existing[0].time_tier
        };
    }

    // 2. Fetch forum details
    const [forumRows] = await conn.execute(
        `SELECT forum_id, title, created_at, due_date, base_exp FROM forum_topics WHERE forum_id = ?`,
        [forumId]
    );

    if (forumRows.length === 0) {
        throw new Error('Forum not found: ' + forumId);
    }
    const forum = forumRows[0];

    // 3. Count prior completions
    const [[countRow]] = await conn.execute(
        `SELECT COUNT(*) AS prior_count FROM student_forum_done WHERE forum_id = ? AND student_id != ?`,
        [forumId, studentId]
    );
    const priorCount = countRow ? countRow.prior_count : 0;

    // 4. Calculate dynamic EXP
    const { expToAward, timeTier, tierTitle } = calculateForumExp(forum, completedAt, priorCount);

    // 5. Insert/Update student_forum_done
    await conn.execute(
        `INSERT INTO student_forum_done (student_id, forum_id, done_at, exp_awarded, time_tier)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE done_at = VALUES(done_at), exp_awarded = VALUES(exp_awarded), time_tier = VALUES(time_tier)`,
        [studentId, forumId, completedAt, expToAward, timeTier]
    );

    // 6. Accrue EXP into users.total_exp
    await conn.execute(
        `UPDATE users SET total_exp = total_exp + ? WHERE user_id = ?`,
        [expToAward, studentId]
    );

    // 7. Recalculate level progression
    const levelStats = await levelProgressionService.recalculateStudentLevel(studentId, conn);

    // 8. Dispatch in-app notification
    try {
        await conn.execute(
            `INSERT INTO notifications (user_id, role, category, priority, event_type, title, message, target_url, is_read, created_at)
             VALUES (?, 'Student', 'gamification', 'normal', 'forum_exp_awarded', ?, ?, ?, 0, NOW())`,
            [
                studentId,
                'Forum Activity Completed!',
                `You earned +${expToAward} EXP (${tierTitle}) for completing "${forum.title}". Total EXP: ${levelStats.total_exp.toLocaleString()}.`,
                `/forums/view/${forumId}`
            ]
        );
    } catch (notifErr) {
        console.warn('⚠️ Notification dispatch skipped:', notifErr.message);
    }

    return {
        success: true,
        expAwarded: expToAward,
        timeTier,
        tierTitle,
        totalExp: levelStats.total_exp,
        currentLevel: levelStats.current_level
    };
}

/**
 * Awards +50 EXP to author when their answer is endorsed by the instructor.
 *
 * @param {object|null} dbConn
 * @param {number} replyId
 * @returns {Promise<object>}
 */
async function awardEndorsementExp(dbConn, replyId) {
    const conn = dbConn || pool;

    const [rows] = await conn.execute(
        `SELECT fr.reply_id, fr.user_id, fr.is_endorsed, fr.endorsement_exp_awarded, fr.reply_title,
                ft.title AS forum_title
         FROM forum_replies fr
         JOIN forum_topics ft ON fr.topic_id = ft.forum_id
         WHERE fr.reply_id = ?`,
        [replyId]
    );

    if (rows.length === 0) {
        throw new Error('Reply not found: ' + replyId);
    }

    const reply = rows[0];
    const authorId = reply.user_id;
    const bonusExp = 50;

    if (reply.endorsement_exp_awarded) {
        return { alreadyAwarded: true, bonusExp: 0 };
    }

    // Mark endorsed & awarded in reply
    await conn.execute(
        `UPDATE forum_replies SET is_endorsed = 1, endorsement_exp_awarded = 1 WHERE reply_id = ?`,
        [replyId]
    );

    // Credit bonus EXP
    await conn.execute(
        `UPDATE users SET total_exp = total_exp + ? WHERE user_id = ?`,
        [bonusExp, authorId]
    );

    // Recalculate author level
    const levelStats = await levelProgressionService.recalculateStudentLevel(authorId, conn);

    // Dispatch notification
    try {
        await conn.execute(
            `INSERT INTO notifications (user_id, role, category, priority, event_type, title, message, target_url, is_read, created_at)
             VALUES (?, 'Student', 'academic', 'high', 'forum_reply_endorsed', ?, ?, ?, 0, NOW())`,
            [
                authorId,
                '🏆 Solution Endorsed by Instructor!',
                `Your answer in "${reply.forum_title}" was officially verified and endorsed! +${bonusExp} Bonus EXP awarded.`,
                `/forums/view/${reply.topic_id || ''}`
            ]
        );
    } catch (e) {
        console.warn('⚠️ Notification skipped:', e.message);
    }

    return {
        success: true,
        bonusExp,
        authorId,
        newTotalExp: levelStats.total_exp,
        newLevel: levelStats.current_level
    };
}

/**
 * Revokes endorsement and subtracts the 50 EXP bonus if instructor un-endorses.
 *
 * @param {object|null} dbConn
 * @param {number} replyId
 * @returns {Promise<object>}
 */
async function revokeEndorsementExp(dbConn, replyId) {
    const conn = dbConn || pool;

    const [rows] = await conn.execute(
        `SELECT fr.reply_id, fr.user_id, fr.is_endorsed, fr.endorsement_exp_awarded
         FROM forum_replies fr
         WHERE fr.reply_id = ?`,
        [replyId]
    );

    if (rows.length === 0) return { notFound: true };
    const reply = rows[0];
    const authorId = reply.user_id;

    if (!reply.endorsement_exp_awarded) {
        await conn.execute(`UPDATE forum_replies SET is_endorsed = 0 WHERE reply_id = ?`, [replyId]);
        return { revoked: false, bonusDeducted: 0 };
    }

    const deduction = 50;
    await conn.execute(
        `UPDATE forum_replies SET is_endorsed = 0, endorsement_exp_awarded = 0 WHERE reply_id = ?`,
        [replyId]
    );

    await conn.execute(
        `UPDATE users SET total_exp = GREATEST(0, total_exp - ?) WHERE user_id = ?`,
        [deduction, authorId]
    );

    const levelStats = await levelProgressionService.recalculateStudentLevel(authorId, conn);

    return {
        success: true,
        revoked: true,
        bonusDeducted: deduction,
        newTotalExp: levelStats.total_exp,
        newLevel: levelStats.current_level
    };
}

module.exports = {
    calculateForumExp,
    awardForumCompletionExp,
    awardEndorsementExp,
    revokeEndorsementExp
};
