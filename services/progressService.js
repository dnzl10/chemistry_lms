const db = require('../db');

/**
 * Recalculate and upsert student_progress for one student + subject.
 * 
 * Factors:
 * 1. Learning Materials: COUNT(DISTINCT smi.material_id) / total unlocked learning_materials
 * 2. Discussion Forums: COUNT(sfd.forum_id) / total unlocked forum_topics
 * 3. Arcade Assessments: COUNT(DISTINCT gs.assessment_id) from elementa_game_sessions (session_status = 'Completed') / total unlocked arcade assessments (assessment_type != 'Assignment')
 * 4. Assignments: COUNT(DISTINCT ss.assessment_id) from student_scores / total unlocked assignments (assessment_type = 'Assignment')
 */
async function recalculateProgress(studentId, subjectId) {
    if (!studentId || !subjectId) return 0;

    try {
        // ==========================================
        // 1. TOTAL REQUIRED COUNTS (DENOMINATOR)
        // ==========================================

        // 1a. Total Learning Materials
        const [[{ totalMaterials }]] = await db.query(`
            SELECT COUNT(*) AS totalMaterials
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0 AND lm.is_locked = 0
        `, [subjectId]);

        // 1b. Total Discussion Forums
        const [[{ totalForums }]] = await db.query(`
            SELECT COUNT(*) AS totalForums
            FROM forum_topics ft
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0
        `, [subjectId]);

        // 1c. Total Arcade Assessments (Pre-Tests, Post-Tests, Quizzes, Competitive)
        const [[{ totalArcadeAssessments }]] = await db.query(`
            SELECT COUNT(*) AS totalArcadeAssessments
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? 
              AND t.is_locked = 0 
              AND a.is_unlocked = 1 
              AND a.assessment_type != 'Assignment'
        `, [subjectId]);

        // 1d. Total Assignments
        const [[{ totalAssignments }]] = await db.query(`
            SELECT COUNT(*) AS totalAssignments
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? 
              AND t.is_locked = 0 
              AND a.is_unlocked = 1 
              AND a.assessment_type = 'Assignment'
        `, [subjectId]);

        // ==========================================
        // 2. STUDENT COMPLETED COUNTS (NUMERATOR)
        // ==========================================

        // 2a. Completed Materials (Viewed or Downloaded)
        const [[{ doneMaterials }]] = await db.query(`
            SELECT COUNT(DISTINCT smi.material_id) AS doneMaterials
            FROM student_material_interactions smi
            JOIN learning_materials lm ON smi.material_id = lm.material_id
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE smi.student_id = ? AND q.subject_id = ?
        `, [studentId, subjectId]);

        // 2b. Completed Discussion Forums
        const [[{ doneForums }]] = await db.query(`
            SELECT COUNT(*) AS doneForums
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE sfd.student_id = ? AND q.subject_id = ?
        `, [studentId, subjectId]);

        // 2c. Completed Arcade Assessments (from elementa_game_sessions with session_status = 'Completed')
        const [[{ doneArcadeAssessments }]] = await db.query(`
            SELECT COUNT(DISTINCT gs.assessment_id) AS doneArcadeAssessments
            FROM elementa_game_sessions gs
            JOIN assessments a ON gs.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
              AND gs.session_status = 'Completed'
              AND a.assessment_type != 'Assignment'
              AND q.subject_id = ?
        `, [studentId, studentId, subjectId]);

        // 2d. Completed Assignments (from student_scores submissions)
        const [[{ doneAssignments }]] = await db.query(`
            SELECT COUNT(DISTINCT ss.assessment_id) AS doneAssignments
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ss.student_id = ? 
              AND a.assessment_type = 'Assignment'
              AND q.subject_id = ?
        `, [studentId, subjectId]);

        // ==========================================
        // 3. FINAL COURSE COMPLETION COMPUTATION
        // ==========================================
        const total = (totalMaterials + totalForums + totalArcadeAssessments + totalAssignments) || 0;
        const done  = (doneMaterials  + doneForums  + doneArcadeAssessments  + doneAssignments)  || 0;
        const progressPercent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

        // 4. Upsert into student_progress
        await db.query(`
            INSERT INTO student_progress (student_id, subject_id, progress_percent, last_accessed)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                progress_percent = VALUES(progress_percent),
                last_accessed    = NOW()
        `, [studentId, subjectId, progressPercent]);

        return progressPercent;
    } catch (err) {
        console.error('[progressService.recalculateProgress] Error:', err.message);
        return 0;
    }
}

module.exports = {
    recalculateProgress
};
