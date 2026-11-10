const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const qrcode = require('qrcode');
const receiptGenerator = require('../utils/receiptGenerator');
const notificationService = require('../services/notificationService');
const levelProgressionService = require('../services/levelProgressionService');
const arcadeAnalyticsService = require('../services/arcadeAnalyticsService');
const forumExpService = require('../services/forumExpService');
const topicScheduleService = require('../services/topicScheduleService');
const academicHelper = require('../utils/academicHelper');
const forumStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const forumDir = path.join(__dirname, '../files');
        if (!fs.existsSync(forumDir)) fs.mkdirSync(forumDir, { recursive: true });
        cb(null, forumDir);
    },
    filename: function (req, file, cb) {
        const filename = 'file-' + Date.now() + path.extname(file.originalname);
        cb(null, filename);
    }
});
const forumUploadRaw = multer({
    storage: forumStorage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file || !file.originalname) return cb(null, true);
        const allowed = /jpeg|jpg|png|gif|webp|svg|pdf|doc|docx|ppt|pptx|xls|xlsx|txt|mp4|mov|webm|mp3|wav|ogg|m4a/;
        const ext = allowed.test(path.extname(file.originalname).toLowerCase());
        if (ext) cb(null, true);
        else cb(new Error("File type not allowed"));
    }
}).fields([
    { name: 'file', maxCount: 1 },
    { name: 'forum_file', maxCount: 1 },
    { name: 'reply_file', maxCount: 1 },
    { name: 'attachment', maxCount: 1 }
]);

const forumUpload = (req, res, next) => {
    forumUploadRaw(req, res, (err) => {
        if (err) return typeof next === 'function' ? next(err) : res.status(400).json({ error: err.message });
        if (req.files) {
            req.file = req.files['file']?.[0] || req.files['forum_file']?.[0] || req.files['reply_file']?.[0] || req.files['attachment']?.[0] || null;
        }
        if (typeof next === 'function') next();
    });
};
const assignmentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dest = path.join(__dirname, '../public/material_uploads');
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const unique = `asgn_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, unique);
    }
});
const assignmentUpload = multer({
    storage: assignmentStorage,
    limits: { fileSize: 50 * 1024 * 1024 }
});



// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Recalculate and upsert student_progress for one student+subject.
// Formula: (done forums + done assessments + done materials) / total × 100
// Call this after any insert to student_forum_done, student_scores,
// or student_material_interactions.
// ─────────────────────────────────────────────────────────────────────────────
async function recalculateProgress(studentId, subjectId, syId = null) {
    try {
        let effSyId = syId ? Number(syId) : null;
        if (!effSyId) {
            const syCtx = await academicHelper.resolveStudentSchoolYearContext(db, studentId);
            const [[studentClassRow]] = await db.query(`
                SELECT c.sy_id
                FROM classes c
                JOIN class_students cs ON c.class_id = cs.class_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                WHERE cs.student_id = ?
                  AND c.subject_id = ?
                  AND sy.status <> 'Draft'
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                ORDER BY (c.sy_id = ?) DESC, (sy.status = 'Current') DESC, sy.start_date DESC, c.class_id ASC
                LIMIT 1
            `, [studentId, subjectId, syCtx.targetSyId || 0]);
            effSyId = studentClassRow ? Number(studentClassRow.sy_id) : syCtx.targetSyId;
        }

        if (!effSyId) return;

        // --- Total counts (all unlocked items linked to this subject & school year) ---
        const [[{ totalForums }]] = await db.query(`
            SELECT COUNT(*) AS totalForums
            FROM forum_topics ft
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0
              AND ft.sy_id = ?
        `, [subjectId, effSyId]);

        const [[{ totalAssessments }]] = await db.query(`
            SELECT COUNT(*) AS totalAssessments
            FROM assessments a
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
            WHERE q.subject_id = ?
              AND (t.is_locked = 0 OR t.is_locked IS NULL)
              AND a.is_unlocked = 1
              AND a.sy_id = ?
        `, [subjectId, effSyId]);

        const [[{ totalMaterials }]] = await db.query(`
            SELECT COUNT(*) AS totalMaterials
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0 AND lm.is_locked = 0
              AND lm.sy_id = ?
        `, [subjectId, effSyId]);

        // --- Done counts for this specific student & school year ---
        const [[{ doneForums }]] = await db.query(`
            SELECT COUNT(DISTINCT sfd.forum_id) AS doneForums
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE sfd.student_id = ? AND q.subject_id = ? AND ft.sy_id = ?
        `, [studentId, subjectId, effSyId]);

        const [[{ doneAssessments }]] = await db.query(`
            SELECT COUNT(DISTINCT ss.assessment_id) AS doneAssessments
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
            WHERE ss.student_id = ? AND q.subject_id = ? AND a.sy_id = ?
        `, [studentId, subjectId, effSyId]);

        const [[{ doneMaterials }]] = await db.query(`
            SELECT COUNT(DISTINCT smi.material_id) AS doneMaterials
            FROM student_material_interactions smi
            JOIN learning_materials lm ON smi.material_id = lm.material_id
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE smi.student_id = ? AND q.subject_id = ? AND lm.sy_id = ?
        `, [studentId, subjectId, effSyId]);

        // --- Calculate ---
        const total = (totalForums + totalAssessments + totalMaterials) || 0;
        const done = (doneForums + doneAssessments + doneMaterials) || 0;
        const progressPercent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

        // --- Upsert student_progress per (student_id, subject_id, sy_id) ---
        await db.query(`
            INSERT INTO student_progress (student_id, subject_id, sy_id, progress_percent, last_accessed)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                progress_percent = VALUES(progress_percent),
                last_accessed    = NOW()
        `, [studentId, subjectId, effSyId, progressPercent]);

    } catch (err) {
        // Non-fatal — log but don't crash the calling route
        console.error('[recalculateProgress] Error:', err.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {

    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const studentId = req.user.user_id;

    try {
        const syCtx = await academicHelper.resolveStudentSchoolYearContext(db, studentId);
        const { targetSY, targetSyId, syMode, enrolledClassIds, enrolledSubjectIds } = syCtx;
        const hasEnrollments = targetSyId !== null && enrolledClassIds.length > 0 && enrolledSubjectIds.length > 0;

        // Build announcement query strictly scoped to targetSyId (and student's enrolled classes/subjects)
        const fetchAnnouncements = () => {
            if (targetSyId === null) return Promise.resolve([[]]);
            if (!hasEnrollments) {
                return db.query(`
                    SELECT a.*, u.first_name, u.last_name
                    FROM announcements a
                    JOIN users u ON a.teacher_id = u.user_id
                    WHERE a.sy_id = ?
                      AND a.scope = 'global'
                    ORDER BY a.is_critical DESC, a.is_priority DESC, a.created_at DESC
                    LIMIT 5
                `, [targetSyId]);
            }
            return db.query(`
                SELECT DISTINCT a.*, u.first_name, u.last_name
                FROM announcements a
                JOIN users u ON a.teacher_id = u.user_id
                LEFT JOIN classes c ON a.class_id = c.class_id
                WHERE a.sy_id = ?
                  AND (
                      a.scope = 'global'
                      OR (a.scope = 'subject' AND a.class_id IS NULL AND a.subject_id IN (?))
                      OR (a.class_id IN (?) AND c.sy_id = ?)
                  )
                ORDER BY a.is_critical DESC, a.is_priority DESC, a.created_at DESC
                LIMIT 5
            `, [targetSyId, enrolledSubjectIds, enrolledClassIds, targetSyId]);
        };

        const fetchUpcomingTasks = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT DISTINCT
                    a.assessment_id,
                    a.quarter_id,
                    a.topic_id,
                    a.assessment_name,
                    a.assessment_type,
                    a.total_items,
                    a.duration_minutes,
                    a.timer_type,
                    a.competitive_enabled,
                    a.is_unlocked,
                    a.start_date,
                    a.due_date,
                    a.allow_grace,
                    a.grace_period_minutes,
                    a.category,
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    t.topic_name
                FROM assessments a
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id AND c.sy_id = ?
                JOIN class_students cs ON c.class_id = cs.class_id AND cs.student_id = ?
                WHERE a.sy_id = ?
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                  AND cs.class_id IN (?)
                  AND a.is_unlocked = 1
                  AND (t.is_locked = 0 OR t.is_locked IS NULL)
                  AND (q.is_locked = 0 OR q.is_locked IS NULL)
                  AND (a.start_date IS NULL OR a.start_date <= NOW())
                  AND a.due_date IS NOT NULL
                  AND (
                      a.due_date >= NOW() 
                      OR (a.allow_grace = 1 AND a.grace_period_minutes > 0 AND DATE_ADD(a.due_date, INTERVAL a.grace_period_minutes MINUTE) >= NOW())
                  )
                  AND (
                      a.target_audience IS NULL 
                      OR a.target_audience = 'everyone' 
                      OR a.target_audience = ''
                      OR (a.target_audience = 'sections' AND EXISTS (
                          SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.class_id = cs.class_id
                      ))
                      OR (a.target_audience = 'students' AND EXISTS (
                          SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.student_id = cs.student_id
                      ))
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM student_scores ss 
                      WHERE ss.assessment_id = a.assessment_id AND ss.student_id = cs.student_id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM elementa_game_sessions egs 
                      WHERE (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id) 
                        AND egs.assessment_id = a.assessment_id 
                        AND (egs.session_status = 'Completed' OR egs.is_synced_to_gradebook = 1)
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM elementa_assessment_tickets eat 
                      WHERE eat.student_id = cs.student_id 
                        AND eat.assessment_id = a.assessment_id 
                        AND eat.status = 'Consumed'
                  )
                ORDER BY a.due_date ASC
                LIMIT 50
            `, [targetSyId, studentId, targetSyId, enrolledClassIds]);
        };

        const fetchSubjects = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT 
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    s.subject_image,
                    c.class_id,
                    c.class_name,
                    c.sy_id,
                    sy.sy_range,
                    sy.status AS sy_status,
                    COALESCE(MAX(sp.progress_percent), 0) AS progress_percent,
                    MAX(sp.last_accessed) AS last_accessed
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                JOIN subjects s ON c.subject_id = s.subject_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                LEFT JOIN student_progress sp 
                       ON sp.subject_id = s.subject_id 
                      AND sp.student_id = cs.student_id
                      AND sp.sy_id = c.sy_id
                WHERE cs.student_id = ?
                  AND c.sy_id = ?
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                  AND sy.status <> 'Draft'
                GROUP BY s.subject_id, s.subject_name, s.subject_code, s.subject_image, c.class_id, c.class_name, c.sy_id, sy.sy_range, sy.status
                ORDER BY last_accessed DESC, s.subject_name ASC
            `, [studentId, targetSyId]);
        };

        const fetchEvents = () => {
            if (targetSyId === null) return Promise.resolve([[]]);
            if (!hasEnrollments) {
                return db.query(`
                    SELECT DISTINCT ce.*
                    FROM calendar_events ce
                    WHERE ce.sy_id = ?
                      AND ce.teacher_id = ?
                      AND ce.creator_role = 'Student'
                      AND MONTH(ce.event_date) = MONTH(CURRENT_DATE())
                      AND YEAR(ce.event_date) = YEAR(CURRENT_DATE())
                    ORDER BY ce.event_date ASC
                `, [targetSyId, studentId]);
            }
            return db.query(`
                SELECT DISTINCT ce.*
                FROM calendar_events ce
                WHERE ce.sy_id = ?
                  AND MONTH(ce.event_date) = MONTH(CURRENT_DATE())
                  AND YEAR(ce.event_date) = YEAR(CURRENT_DATE())
                  AND (
                      (ce.teacher_id = ? AND ce.creator_role = 'Student')
                      OR (
                          ce.creator_role IN ('Teacher', 'Admin')
                          AND (
                              (ce.class_id IS NOT NULL AND ce.class_id IN (?))
                              OR (ce.class_id IS NULL AND ce.subject_id IN (?))
                          )
                      )
                  )
                ORDER BY ce.event_date ASC
            `, [targetSyId, studentId, enrolledClassIds, enrolledSubjectIds]);
        };

        const fetchAssessmentDates = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT DISTINCT
                    DATE(a.due_date) AS due_date,
                    a.assessment_name
                FROM assessments a
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id AND c.sy_id = ?
                JOIN class_students cs ON c.class_id = cs.class_id AND cs.student_id = ?
                WHERE a.sy_id = ?
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                  AND cs.class_id IN (?)
                  AND a.due_date IS NOT NULL
                  AND a.is_unlocked = 1
                  AND (t.is_locked = 0 OR t.is_locked IS NULL)
                  AND (q.is_locked = 0 OR q.is_locked IS NULL)
                  AND (
                      a.target_audience IS NULL
                      OR a.target_audience = 'everyone'
                      OR a.target_audience = ''
                      OR (a.target_audience = 'sections' AND EXISTS (
                          SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.class_id = cs.class_id
                      ))
                      OR (a.target_audience = 'students' AND EXISTS (
                          SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.student_id = cs.student_id
                      ))
                  )
            `, [targetSyId, studentId, targetSyId, enrolledClassIds]);
        };

        const fetchRecentForums = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT DISTINCT
                    ft.forum_id, ft.title, ft.subject_id, ft.teacher_id, ft.created_at,
                    ft.is_pinned, s.subject_code
                FROM forum_topics ft
                JOIN subjects s ON ft.subject_id = s.subject_id
                LEFT JOIN topics t ON ft.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE ft.sy_id = ?
                  AND (t.is_locked = 0 OR t.is_locked IS NULL)
                  AND (q.is_locked = 0 OR q.is_locked IS NULL)
                  AND (
                      (ft.class_id IS NOT NULL AND ft.class_id IN (?))
                      OR (ft.class_id IS NULL AND ft.subject_id IN (?))
                  )
                ORDER BY ft.is_pinned DESC, ft.created_at DESC
                LIMIT 20 OFFSET 0
            `, [targetSyId, enrolledClassIds, enrolledSubjectIds]);
        };

        const fetchRecentMaterials = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT 
                    lm.material_id,
                    lm.title,
                    lm.material_type,
                    lm.file_path_or_url,
                    lm.ai_summary,
                    lm.is_locked,
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    MAX(smi.interacted_at) AS last_interacted_at,
                    SUBSTRING_INDEX(GROUP_CONCAT(smi.interaction_type ORDER BY smi.interacted_at DESC), ',', 1) AS interaction_type
                FROM student_material_interactions smi
                JOIN learning_materials lm ON smi.material_id = lm.material_id
                JOIN topics t ON lm.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id AND c.sy_id = ?
                JOIN class_students cs ON c.class_id = cs.class_id AND cs.student_id = smi.student_id
                JOIN users teacher ON c.teacher_id = teacher.user_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                WHERE smi.student_id = ?
                  AND lm.sy_id = ?
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                  AND cs.class_id IN (?)
                  AND sy.status <> 'Draft'
                  AND lm.is_locked = 0
                  AND (t.is_locked = 0 OR t.is_locked IS NULL)
                  AND (q.is_locked = 0 OR q.is_locked IS NULL)
                GROUP BY lm.material_id, lm.title, lm.material_type, lm.file_path_or_url, lm.ai_summary, lm.is_locked, s.subject_id, s.subject_name, s.subject_code
                ORDER BY last_interacted_at DESC
                LIMIT 6
            `, [targetSyId, studentId, targetSyId, enrolledClassIds]);
        };

        const fetchCompletedAssignments = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT 
                    ss.score_id,
                    ss.student_id,
                    ss.assessment_id,
                    ss.score_obtained,
                    ss.total_possible_score,
                    ss.total_items,
                    ss.exp_gained,
                    ss.feedback,
                    ss.date_recorded,
                    ss.submitted_at,
                    ss.attempt_number,
                    ss.file_path,
                    ss.original_filename,
                    a.assessment_name,
                    a.assessment_type,
                    a.timer_type,
                    a.duration_minutes,
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    COALESCE(ss.submitted_at, ss.date_recorded) AS completion_date
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                WHERE ss.student_id = ? 
                  AND ss.score_obtained IS NOT NULL
                  AND a.assessment_type = 'Assignment'
                  AND a.sy_id = ?
                  AND EXISTS (
                      SELECT 1 FROM class_students cs
                      JOIN classes c ON cs.class_id = c.class_id
                      WHERE cs.student_id = ss.student_id
                        AND c.subject_id = s.subject_id
                        AND c.sy_id = ?
                        AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                        AND cs.class_id IN (?)
                  )
                ORDER BY completion_date DESC
                LIMIT 2
            `, [studentId, targetSyId, targetSyId, enrolledClassIds]);
        };

        const fetchCompletedAssessments = () => {
            if (!hasEnrollments) return Promise.resolve([[]]);
            return db.query(`
                SELECT * FROM (
                    SELECT 
                        ss.score_id,
                        ss.student_id,
                        ss.assessment_id,
                        ss.score_obtained,
                        ss.total_possible_score,
                        ss.total_items,
                        ss.exp_gained,
                        ss.feedback,
                        ss.date_recorded,
                        ss.submitted_at,
                        ss.attempt_number,
                        ss.file_path,
                        ss.original_filename,
                        a.assessment_name,
                        a.assessment_type,
                        a.timer_type,
                        a.duration_minutes,
                        s.subject_id,
                        s.subject_name,
                        s.subject_code,
                        COALESCE(ss.submitted_at, ss.date_recorded) AS completion_date
                    FROM student_scores ss
                    JOIN assessments a ON ss.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    WHERE ss.student_id = ? 
                      AND ss.score_obtained IS NOT NULL
                      AND (a.assessment_type IS NULL OR a.assessment_type != 'Assignment')
                      AND a.sy_id = ?
                      AND EXISTS (
                          SELECT 1 FROM class_students cs
                          JOIN classes c ON cs.class_id = c.class_id
                          WHERE cs.student_id = ss.student_id
                            AND c.subject_id = s.subject_id
                            AND c.sy_id = ?
                            AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                            AND cs.class_id IN (?)
                      )
                    UNION ALL
                    SELECT 
                        MAX(egs.session_id) AS score_id,
                        ? AS student_id,
                        egs.assessment_id,
                        MAX(CASE WHEN egs.student_id_p1 = ? THEN egs.final_score_p1 ELSE egs.final_score_p2 END) AS score_obtained,
                        COALESCE(a.total_items, 10) AS total_possible_score,
                        COALESCE(a.total_items, 10) AS total_items,
                        MAX(CASE WHEN egs.student_id_p1 = ? THEN ROUND(COALESCE(egs.final_score_p1, 0) * 10) ELSE ROUND(COALESCE(egs.final_score_p2, 0) * 10) END) AS exp_gained,
                        NULL AS feedback,
                        MAX(egs.started_at) AS date_recorded,
                        MAX(egs.ended_at) AS submitted_at,
                        1 AS attempt_number,
                        NULL AS file_path,
                        NULL AS original_filename,
                        a.assessment_name,
                        COALESCE(a.assessment_type, 'Arcade Assessment') AS assessment_type,
                        a.timer_type,
                        a.duration_minutes,
                        s.subject_id,
                        s.subject_name,
                        s.subject_code,
                        MAX(COALESCE(egs.ended_at, egs.started_at)) AS completion_date
                    FROM elementa_game_sessions egs
                    JOIN assessments a ON egs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    WHERE (egs.student_id_p1 = ? OR egs.student_id_p2 = ?)
                      AND (egs.session_status = 'Completed' OR egs.is_synced_to_gradebook = 1)
                      AND (a.assessment_type IS NULL OR a.assessment_type != 'Assignment')
                      AND a.sy_id = ?
                      AND (egs.class_id IS NULL OR egs.class_id IN (?))
                      AND NOT EXISTS (
                          SELECT 1 FROM student_scores ss2 WHERE ss2.assessment_id = egs.assessment_id AND ss2.student_id = ?
                      )
                      AND EXISTS (
                          SELECT 1 FROM class_students cs
                          JOIN classes c ON cs.class_id = c.class_id
                          WHERE cs.student_id = ?
                            AND c.subject_id = s.subject_id
                            AND c.sy_id = ?
                            AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                            AND cs.class_id IN (?)
                      )
                    GROUP BY egs.assessment_id, a.total_items, a.assessment_name, a.assessment_type, a.timer_type, a.duration_minutes, s.subject_id, s.subject_name, s.subject_code
                ) AS combined_completed_assessments
                ORDER BY completion_date DESC
                LIMIT 2
            `, [
                studentId, targetSyId, targetSyId, enrolledClassIds,
                studentId, studentId, studentId,
                studentId, studentId, targetSyId, enrolledClassIds,
                studentId, studentId, targetSyId, enrolledClassIds
            ]);
        };

        const fetchRecentUpdates = () => {
            if (targetSyId === null) return Promise.resolve([[]]);
            if (!hasEnrollments) {
                return db.query(`
                    SELECT
                        'announcement' AS update_type,
                        a.title,
                        NULL AS subject_id,
                        'CAMPUS' AS subject_code,
                        'Campus Broadcast' AS subject_name,
                        a.created_at,
                        CONCAT('/dashboard#ann-card-', a.announcement_id) AS link_url
                    FROM announcements a
                    WHERE a.sy_id = ?
                      AND a.scope = 'global'
                    ORDER BY a.created_at DESC
                    LIMIT 20
                `, [targetSyId]);
            }
            return db.query(`
                SELECT * FROM (
                    SELECT
                        'announcement' AS update_type,
                        a.title,
                        COALESCE(a.subject_id, c.subject_id) AS subject_id,
                        COALESCE(s.subject_code, 'CAMPUS') AS subject_code,
                        COALESCE(s.subject_name, 'Campus Broadcast') AS subject_name,
                        a.created_at,
                        CONCAT('/dashboard#ann-card-', a.announcement_id) AS link_url
                    FROM announcements a
                    LEFT JOIN classes c ON a.class_id = c.class_id
                    LEFT JOIN subjects s ON COALESCE(a.subject_id, c.subject_id) = s.subject_id
                    WHERE a.sy_id = ?
                      AND (
                          a.scope = 'global'
                          OR (a.scope = 'subject' AND a.class_id IS NULL AND a.subject_id IN (?))
                          OR (a.class_id IN (?) AND c.sy_id = ?)
                      )

                    UNION ALL

                    SELECT
                        'forum' AS update_type,
                        ft.title,
                        ft.subject_id,
                        s.subject_code,
                        s.subject_name,
                        ft.created_at,
                        CONCAT('/forums/view/', ft.forum_id) AS link_url
                    FROM forum_topics ft
                    JOIN subjects s ON ft.subject_id = s.subject_id
                    LEFT JOIN topics t ON ft.topic_id = t.topic_id
                    LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                    WHERE ft.sy_id = ?
                      AND (t.is_locked = 0 OR t.is_locked IS NULL)
                      AND (q.is_locked = 0 OR q.is_locked IS NULL)
                      AND (
                          (ft.class_id IS NOT NULL AND ft.class_id IN (?))
                          OR (ft.class_id IS NULL AND ft.subject_id IN (?))
                      )

                    UNION ALL

                    SELECT
                        'material' AS update_type,
                        lm.title,
                        s.subject_id,
                        s.subject_code,
                        s.subject_name,
                        lm.created_at,
                        CONCAT('/subjects/open/', s.subject_id, '?tab=materials') AS link_url
                    FROM learning_materials lm
                    JOIN topics t ON lm.topic_id = t.topic_id
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    WHERE lm.sy_id = ?
                      AND q.subject_id IN (?)
                      AND lm.is_locked = 0
                      AND (t.is_locked = 0 OR t.is_locked IS NULL)
                      AND (q.is_locked = 0 OR q.is_locked IS NULL)

                    UNION ALL

                    SELECT
                        'assessment' AS update_type,
                        a.assessment_name AS title,
                        s.subject_id,
                        s.subject_code,
                        s.subject_name,
                        a.created_at,
                        CONCAT('/subjects/open/', s.subject_id, '?tab=', IF(a.assessment_type = 'Assignment', 'assignments', 'assessments'), '&assessment_id=', a.assessment_id) AS link_url
                    FROM assessments a
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    WHERE a.sy_id = ?
                      AND q.subject_id IN (?)
                      AND a.is_unlocked = 1
                      AND (t.is_locked = 0 OR t.is_locked IS NULL)
                      AND (q.is_locked = 0 OR q.is_locked IS NULL)
                      AND (a.start_date IS NULL OR a.start_date <= NOW())
                      AND (
                          a.target_audience IS NULL
                          OR a.target_audience = 'everyone'
                          OR a.target_audience = ''
                          OR (a.target_audience = 'sections' AND EXISTS (
                              SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.class_id IN (?)
                          ))
                          OR (a.target_audience = 'students' AND EXISTS (
                              SELECT 1 FROM assignment_audiences aa WHERE aa.assessment_id = a.assessment_id AND aa.student_id = ?
                          ))
                      )
                ) AS sy_recent_updates
                ORDER BY created_at DESC
                LIMIT 20
            `, [
                targetSyId, enrolledSubjectIds, enrolledClassIds, targetSyId,
                targetSyId, enrolledClassIds, enrolledSubjectIds,
                targetSyId, enrolledSubjectIds,
                targetSyId, enrolledSubjectIds, enrolledClassIds, studentId
            ]);
        };

        const [
            [announcements],
            [upcomingTasks],
            [subjects],
            [events],
            [assessmentDates],
            [recentForums],
            [recentMaterials],
            [completedAssignments],
            [completedAssessments],
            [recentUpdates]
        ] = await Promise.all([
            fetchAnnouncements(),
            fetchUpcomingTasks(),
            fetchSubjects(),
            fetchEvents(),
            fetchAssessmentDates(),
            fetchRecentForums(),
            fetchRecentMaterials(),
            fetchCompletedAssignments(),
            fetchCompletedAssessments(),
            fetchRecentUpdates()
        ]);

        const [[currentUser]] = await db.query(
            'SELECT flagged_assessment_id FROM users WHERE user_id = ?',
            [studentId]
        );

        // Normalize progress
        subjects.forEach(c => {
            c.progress_percent = Math.min(100, Math.max(0, Math.round(c.progress_percent || 0)));
        });

        // Calendar Logic
        const today = new Date();
        const year = today.getFullYear();
        const month = today.getMonth();

        // Convert assessment due dates to day numbers for current month and year only
        const dueDays = (assessmentDates || []).filter(a => {
            if (!a.due_date) return false;
            const d = new Date(a.due_date);
            return d.getFullYear() === year && d.getMonth() === month;
        }).map(a => {
            const d = new Date(a.due_date);
            return d.getDate();
        });

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        let calendarDays = [];

        for (let i = 0; i < firstDay; i++) {
            calendarDays.push(null);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            calendarDays.push(d);
        }

        // Render dashboard strictly scoped to the student's enrolled School Year
        res.render('dashboard-student', {
            user: req.user,
            currentSY: targetSY,
            enrolledSY: targetSY,
            syMode,
            archivedSubjects: [],
            announcements: announcements ?? [],
            upcomingTasks: upcomingTasks ?? [],
            timeline: [],
            subjects: subjects ?? [],
            events: events ?? [],
            calendarDays,
            month,
            year,
            dueDays,   // IMPORTANT 
            recentForums: recentForums ?? [],
            recentUpdates: recentUpdates ?? [],
            recentMaterials: recentMaterials ?? [],
            completedAssignments: completedAssignments ?? [],
            completedAssessments: completedAssessments ?? [],
            flaggedAssessmentId: currentUser?.flagged_assessment_id ?? null
        });

    } catch (err) {
        // 1️⃣ Log the full error object
        console.error("Dashboard Data Error:", err);

        // 2️⃣ Log the SQL message if available (mysql2/promise)
        if (err.sqlMessage) {
            console.error("SQL Message:", err.sqlMessage);
        }
        if (err.sql) {
            console.error("SQL Query that caused error:", err.sql);
        }

        // 3️⃣ Optional: log stack trace
        console.error(err.stack);

        // 4️⃣ Respond with more info temporarily (for dev)
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error: " + err.message);
        }
    }
});


router.post('/flag-assessment', async (req, res) => {
    console.log('BODY:', req.body); // If this prints "undefined" → express.json() missing
    console.log('=== FLAG ASSESSMENT HIT ===');
    console.log('isAuthenticated:', req.isAuthenticated());
    console.log('Body:', req.body);
    console.log('User:', req.user?.user_id);

    if (!req.isAuthenticated()) return res.sendStatus(401);

    const { assessment_id } = req.body;
    const student_id = req.user.user_id;

    if (!assessment_id) {
        console.log('ERROR: assessment_id is missing from body');
        return res.status(400).json({ error: 'assessment_id missing' });
    }

    try {
        await db.query(
            'UPDATE users SET flagged_assessment_id = ? WHERE user_id = ?',
            [assessment_id, student_id]
        );
        console.log(`Flagged assessment ${assessment_id} for user ${student_id}`);
        // T-10: Notify Teacher of security flag
        notifyTeachersOfFlaggedAssessment(student_id, assessment_id).catch(() => {});
        res.sendStatus(200);
    } catch (err) {
        console.error("Flag Assessment Error:", err);
        res.sendStatus(500);
    }
});

// Helper: T-10 Notify teachers when a student is flagged for assessment integrity violation
async function notifyTeachersOfFlaggedAssessment(studentId, assessmentId) {
    try {
        const [[student]] = await db.query(
            `SELECT first_name, last_name FROM users WHERE user_id = ?`,
            [studentId]
        );
        const studentName = student ? `${student.first_name} ${student.last_name}`.trim() : 'A student';
        const [rows] = await db.query(
            `SELECT a.assessment_name, c.teacher_id, c.class_id, c.class_name
             FROM assessments a
             JOIN topics t ON a.topic_id = t.topic_id
             JOIN quarters q ON t.quarter_id = q.quarter_id
             JOIN classes c ON q.subject_id = c.subject_id
             JOIN class_students cs ON cs.class_id = c.class_id
             WHERE a.assessment_id = ? AND cs.student_id = ? AND c.teacher_id IS NOT NULL`,
            [assessmentId, studentId]
        );
        for (const r of rows) {
            await notificationService.dispatch({
                recipientIds: r.teacher_id,
                actorId: studentId,
                role: 'Teacher',
                category: 'integrity',
                priority: 'urgent',
                eventType: 'cheating_flagged',
                title: 'Assessment Security Flag Triggered',
                message: `${studentName} (${r.class_name}) was flagged for an integrity violation during '${r.assessment_name}'.`,
                targetUrl: `/teacher/class/${r.class_id}?tab=students`,
                metadata: { studentId, assessmentId, classId: r.class_id }
            });
        }
    } catch (err) {
        console.error('[notifyTeachersOfFlaggedAssessment Error]', err.message);
    }
}

const QRCode = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// MULTER — Profile picture uploads
// Saves to /public/profile_uploads/ (max 5MB, images only)
// ─────────────────────────────────────────────────────────────────────────────
const profilePicStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'profile_uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `profile-${Date.now()}${ext}`);
    }
});
const profilePicUpload = multer({
    storage: profilePicStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files allowed'));
    }
});

// Route para sa View Profile
router.get('/profile', async (req, res) => {
    // 1. Siguraduhin na ang user ay logged in (Passport.js usually uses req.user)
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    try {
        const studentId = req.user.user_id;

        // Fetch fresh user row & level progression statistics
        const [[userRow]] = await db.query(
            `SELECT * FROM users WHERE user_id = ?`,
            [studentId]
        );
        const user = userRow || req.user;

        let levelStats = null;
        try {
            levelStats = await levelProgressionService.getStudentLevelStats(studentId, null, db);
        } catch (lvlErr) {
            console.warn('[Profile:LevelStatsError]', lvlErr.message);
        }

        // 2. Generate ang QR Code Base64 string gamit ang token ng user
        // Kung walang token, maaari mong gamitin ang email o ID bilang fallback
        const token = user.qr_code_token || `USER-${user.id}`;
        const qrCodeData = await QRCode.toDataURL(token, {
            color: {
                dark: '#1e293b', // Kulay ng QR (Slate 800)
                light: '#ffffff' // Background
            },
            margin: 2
        });

        // 3. I-render ang profile page at ipasa ang user, qrCodeData, at levelStats
        res.render('profile', {
            user: user,
            qrCodeData: qrCodeData,
            levelStats: levelStats
        });

    } catch (err) {
        console.error("Profile Rendering Error:", err);
        res.status(500).send("Internal Server Error");
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /update-profile
// Updates editable user fields + optional profile picture upload.
// Uses multipart/form-data (FormData from frontend).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/update-profile', profilePicUpload.single('profile_pic'), async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    const userId = req.user.user_id;
    const {
        pic_description,
        self_description,
        city_town,
        mobile_number,
        home_address,
        alternative_name,
        interests
    } = req.body;

    try {
        // If a new photo was uploaded, delete the old one (unless it's the default)
        let newPic = undefined; // undefined = don't touch the column
        if (req.file) {
            newPic = req.file.filename;
            // Delete old pic if not the default
            const [[currentUser]] = await db.query(
                'SELECT profile_pic FROM users WHERE user_id = ?', [userId]
            );
            if (currentUser?.profile_pic && currentUser.profile_pic !== 'default_avatar.png') {
                const oldPath = path.join(__dirname, '..', 'public', 'profile_uploads', currentUser.profile_pic);
                fs.unlink(oldPath, () => { }); // silent fail — file may already be gone
            }
        }

        // Build the SET clause dynamically so we only update profile_pic when a new one is uploaded
        if (newPic !== undefined) {
            await db.query(
                `UPDATE users
                 SET profile_pic      = ?,
                     pic_description  = ?,
                     self_description = ?,
                     city_town        = ?,
                     mobile_number    = ?,
                     home_address     = ?,
                     alternative_name = ?,
                     interests        = ?
                 WHERE user_id = ?`,
                [newPic, pic_description || null, self_description || null,
                    city_town || null, mobile_number || null, home_address || null,
                    alternative_name || null, interests || null, userId]
            );
        } else {
            await db.query(
                `UPDATE users
                 SET pic_description  = ?,
                     self_description = ?,
                     city_town        = ?,
                     mobile_number    = ?,
                     home_address     = ?,
                     alternative_name = ?,
                     interests        = ?
                 WHERE user_id = ?`,
                [pic_description || null, self_description || null, city_town || null,
                mobile_number || null, home_address || null,
                alternative_name || null, interests || null, userId]
            );
        }

        // Refresh the session user object so req.user reflects changes immediately
        const [[updated]] = await db.query(
            'SELECT * FROM users WHERE user_id = ?', [userId]
        );
        // Passport stores user in req.user — update it in the session
        Object.assign(req.user, updated);

        return res.json({
            success: true,
            profile_pic: updated.profile_pic
        });

    } catch (err) {
        console.error('[UPDATE PROFILE]', err);
        // Clean up uploaded file if DB update failed
        if (req.file) {
            const failedPath = path.join(__dirname, '..', 'public', 'profile_uploads', req.file.filename);
            fs.unlink(failedPath, () => { });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});



// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT-BASED MESSAGING SECURITY GUARDS & CONTROLLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict Enrollment Authorization Guard
 * Enforces that students can ONLY communicate with:
 * 1. Peers who share at least one active enrolled class section in class_students
 * 2. Course instructors/advisers teaching at least one class the student is enrolled in
 */
async function canCommunicate(studentId, targetUserId) {
    const sId = parseInt(studentId, 10);
    const tId = parseInt(targetUserId, 10);
    if (isNaN(sId) || isNaN(tId) || sId === tId) return false;

    try {
        const [rows] = await db.query(`
            SELECT 1 
            WHERE EXISTS (
                -- 1. Co-enrolled peer sharing at least one class section
                SELECT 1 
                FROM class_students cs_me
                JOIN class_students cs_peer ON cs_me.class_id = cs_peer.class_id
                WHERE cs_me.student_id = ? AND cs_peer.student_id = ?
            )
            OR EXISTS (
                -- 2. Instructor or adviser teaching one of the student's enrolled classes
                SELECT 1 
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ? AND c.teacher_id = ?
            )
            LIMIT 1
        `, [sId, tId, sId, tId]);

        return rows.length > 0;
    } catch (err) {
        console.error('[CAN COMMUNICATE GUARD ERROR]', err);
        return false;
    }
}

/**
 * Retrieves the authorized contacts directory for a student, strictly filtered
 * to peers and instructors sharing active enrolled classes/subjects.
 */
async function getAuthorizedMessagingContacts(studentId, searchQuery = '', subjectIdFilter = null) {
    const sId = parseInt(studentId, 10);
    if (isNaN(sId)) return [];

    let filterClause = '';
    const params = [sId, sId, sId];

    if (searchQuery && searchQuery.trim().length > 0) {
        filterClause += ` AND (
            contact.first_name LIKE ? OR 
            contact.last_name LIKE ? OR 
            CONCAT(contact.first_name, ' ', contact.last_name) LIKE ? OR
            contact.subject_code LIKE ?
        )`;
        const q = `%${searchQuery.trim()}%`;
        params.push(q, q, q, q);
    }

    if (subjectIdFilter) {
        const subId = parseInt(subjectIdFilter, 10);
        if (!isNaN(subId)) {
            filterClause += ` AND contact.subject_id = ?`;
            params.push(subId);
        }
    }

    const sql = `
        SELECT 
            contact.user_id,
            contact.first_name,
            contact.last_name,
            contact.role,
            contact.profile_pic,
            contact.section,
            contact.grade_level,
            contact.strand,
            contact.department,
            contact.contact_type,
            GROUP_CONCAT(DISTINCT contact.subject_code ORDER BY contact.subject_code SEPARATOR ', ') AS shared_subjects,
            GROUP_CONCAT(DISTINCT contact.subject_id) AS shared_subject_ids,
            GROUP_CONCAT(DISTINCT CONCAT(contact.subject_code, ' (', contact.class_name, ')') ORDER BY contact.subject_code SEPARATOR ', ') AS shared_classes
        FROM (
            -- 1. Co-enrolled Classmates (Peers)
            SELECT 
                u.user_id,
                u.first_name,
                u.last_name,
                u.role,
                u.profile_pic,
                u.section,
                u.grade_level,
                u.strand,
                u.department,
                'classmate' AS contact_type,
                s.subject_id,
                s.subject_code,
                c.class_name
            FROM class_students cs_me
            JOIN classes c ON cs_me.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN class_students cs_peer ON c.class_id = cs_peer.class_id
            JOIN users u ON cs_peer.student_id = u.user_id
            WHERE cs_me.student_id = ? AND cs_peer.student_id <> ?

            UNION ALL

            -- 2. Instructors & Advisers
            SELECT 
                t.user_id,
                t.first_name,
                t.last_name,
                t.role,
                t.profile_pic,
                t.section,
                t.grade_level,
                t.strand,
                t.department,
                'adviser' AS contact_type,
                s.subject_id,
                s.subject_code,
                c.class_name
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN users t ON c.teacher_id = t.user_id
            WHERE cs.student_id = ? AND c.teacher_id IS NOT NULL AND c.teacher_id > 0
        ) contact
        WHERE 1=1 ${filterClause}
        GROUP BY contact.user_id, contact.first_name, contact.last_name, contact.role, contact.profile_pic, contact.section, contact.grade_level, contact.strand, contact.department, contact.contact_type
        ORDER BY (contact.contact_type = 'adviser') DESC, contact.first_name ASC, contact.last_name ASC
    `;

    const [rows] = await db.query(sql, params);
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /messages - In-App Student Messenger View
// ─────────────────────────────────────────────────────────────────────────────
router.get('/messages', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;

    try {
        // Enrolled subjects for class filter chips
        const [enrolledSubjects] = await db.query(`
            SELECT DISTINCT 
                s.subject_id,
                s.subject_code,
                s.subject_name
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE cs.student_id = ?
            ORDER BY s.subject_code ASC
        `, [studentId]);

        res.render('message-student', {
            user: req.user,
            subjects: enrolledSubjects,
            activeNav: 'none'
        });
    } catch (err) {
        console.error('[GET MESSAGES VIEW]', err);
        res.status(500).send('Unable to load messaging interface.');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/student/messaging/contacts
// Returns authorized peers and advisers grouped by subject
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/student/messaging/contacts', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const studentId = req.user.user_id;
    const q = req.query.q || '';
    const subjectId = req.query.subject_id || null;

    try {
        const contacts = await getAuthorizedMessagingContacts(studentId, q, subjectId);
        res.json({ success: true, contacts });
    } catch (err) {
        console.error('[GET MESSAGING CONTACTS]', err);
        res.status(500).json({ error: 'Failed to retrieve contacts' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING CONTROLLER FUNCTIONS & REST APIS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Controller: Get Conversation Threads
 * Returns unique conversation partners for the current user, strictly
 * filtered to authorized co-enrolled classmates and instructors.
 */
async function handleGetConversations(req, res) {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId = req.user.user_id;

    try {
        const [rows] = await db.query(`
            SELECT
                partner.user_id                                        AS other_user_id,
                CONCAT(partner.first_name, ' ', partner.last_name)     AS other_name,
                partner.role                                           AS other_role,
                partner.profile_pic                                    AS other_pic,
                partner.section                                        AS other_section,
                partner.grade_level                                    AS other_grade_level,
                partner.strand                                         AS other_strand,
                partner.department                                     AS other_department,
                latest.message_text                                    AS last_message,
                latest.sent_at,
                COALESCE(unread.cnt, 0)                                AS unread,
                IF(EXISTS(
                    SELECT 1 FROM class_students cs JOIN classes c ON cs.class_id = c.class_id 
                    WHERE cs.student_id = ? AND c.teacher_id = partner.user_id
                ), 'adviser', 'classmate')                             AS contact_type
            FROM (
                SELECT 
                    IF(sender_id = ?, receiver_id, sender_id) AS partner_id,
                    MAX(message_id) AS latest_message_id
                FROM private_messages
                WHERE sender_id = ? OR receiver_id = ?
                GROUP BY partner_id
            ) convo
            JOIN users partner ON partner.user_id = convo.partner_id
            JOIN private_messages latest ON latest.message_id = convo.latest_message_id
            LEFT JOIN (
                SELECT sender_id, COUNT(*) AS cnt
                FROM private_messages
                WHERE receiver_id = ? AND is_read = 0
                GROUP BY sender_id
            ) unread ON unread.sender_id = convo.partner_id
            WHERE (
                -- Strict Enrollment Boundary: Peer must share class OR be student's instructor
                EXISTS (
                    SELECT 1 
                    FROM class_students cs_me
                    JOIN class_students cs_peer ON cs_me.class_id = cs_peer.class_id
                    WHERE cs_me.student_id = ? AND cs_peer.student_id = convo.partner_id
                )
                OR EXISTS (
                    SELECT 1 
                    FROM class_students cs
                    JOIN classes c ON cs.class_id = c.class_id
                    WHERE cs.student_id = ? AND c.teacher_id = convo.partner_id
                )
            )
            ORDER BY latest.sent_at DESC
        `, [myId, myId, myId, myId, myId, myId, myId]);

        res.json(rows);
    } catch (err) {
        console.error('[GET CONVERSATIONS]', err);
        res.status(500).json([]);
    }
}

/**
 * Controller: Get Thread Messages
 * Returns message history between current user and target partner.
 * Strictly verifies enrollment boundary (403 if unauthorized) and marks
 * incoming unread messages as read.
 */
async function handleGetThreadMessages(req, res) {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId = req.user.user_id;
    const otherId = parseInt(req.params.userId || req.params.partnerId, 10);

    if (isNaN(otherId)) return res.status(400).json({ error: 'Valid user ID required' });

    try {
        // Strict Authorization Guard: Enrollment Boundary
        const allowed = await canCommunicate(myId, otherId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only message peers and instructors from your enrolled classes.' });
        }

        const [messages] = await db.query(`
            SELECT message_id, sender_id, receiver_id, message_text, sent_at, is_read
            FROM private_messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY sent_at ASC
        `, [myId, otherId, otherId, myId]);

        // Mark incoming messages as read (unless client disabled read receipts)
        const markRead = req.query.markRead !== 'false';
        if (markRead) {
            await db.query(
                `UPDATE private_messages SET is_read = 1
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [otherId, myId]
            );
            await notificationService.markSenderMessageNotificationsRead({ userId: myId, senderId: otherId });
        }

        res.json(messages);
    } catch (err) {
        console.error('[GET MESSAGES]', err);
        res.status(500).json([]);
    }
}

/**
 * Controller: Send Private Message
 * Inserts message into private_messages after strictly validating
 * enrollment boundary. Returns created message payload.
 */
async function handleSendMessage(req, res) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const senderId = req.user.user_id;
    const targetId = parseInt(req.body.receiver_id || req.body.partner_id, 10);
    const messageText = (req.body.message_text || req.body.text || '').trim();

    if (isNaN(targetId) || !messageText) {
        return res.status(400).json({ error: 'receiver_id and message_text are required' });
    }

    try {
        // Strict Authorization Guard: Enrollment Boundary
        const allowed = await canCommunicate(senderId, targetId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only message peers and instructors from your enrolled classes.' });
        }

        const [result] = await db.query(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text, is_read)
             VALUES (?, ?, ?, 0)`,
            [senderId, targetId, messageText]
        );

        // Dispatch in-app notification to receiver (Social category)
        try {
            const senderName = `${req.user.first_name || 'Classmate'} ${req.user.last_name || ''}`.trim();
            const previewText = messageText.length > 80 ? messageText.substring(0, 77) + '...' : messageText;
            const [targetUserRows] = await db.query('SELECT role FROM users WHERE user_id = ?', [targetId]);
            const targetRole = targetUserRows[0]?.role || 'Student';

            // Student receiver goes to /messages?userId=... while Teacher goes to /teacher/messages/...
            const targetUrl = targetRole === 'Teacher'
                ? `/teacher/messages/${senderId}`
                : `/messages?userId=${senderId}`;

            await notificationService.dispatch({
                recipientIds: targetId,
                actorId: senderId,
                role: targetRole,
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_received',
                title: `Message from ${senderName}`,
                message: previewText,
                targetUrl: targetUrl,
                metadata: { senderId, messageId: result.insertId }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Send Message]', notifErr.message);
        }

        res.json({
            success: true,
            message_id: result.insertId,
            sender_id: senderId,
            receiver_id: targetId,
            message_text: messageText,
            sent_at: new Date()
        });
    } catch (err) {
        console.error('[POST MESSAGES]', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
}

/**
 * Controller: Attachment Upload
 */
const chatStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../files');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = 'chat_' + Date.now() + '_' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const chatUpload = multer({
    storage: chatStorage,
    limits: { fileSize: 25 * 1024 * 1024 }
});

async function handleMessageUpload(req, res) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const senderId = req.user.user_id;
    const receiverId = parseInt(req.body.receiver_id || req.body.partner_id, 10);

    if (isNaN(receiverId)) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: 'receiver_id is missing or invalid' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        // Strict Authorization Guard: Enrollment Boundary
        const allowed = await canCommunicate(senderId, receiverId);
        if (!allowed) {
            fs.unlink(req.file.path, () => { });
            return res.status(403).json({ error: 'Access denied: You can only message peers and instructors from your enrolled classes.' });
        }

        const fileUrl = '/forum_uploads/' + req.file.filename;
        const origName = req.file.originalname;
        const msgText = fileUrl + '||' + origName;

        const [result] = await db.query(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text, is_read)
             VALUES (?, ?, ?, 0)`,
            [senderId, receiverId, msgText]
        );

        // Dispatch in-app notification for attachment
        try {
            const senderName = `${req.user.first_name || 'Classmate'} ${req.user.last_name || ''}`.trim();
            const [targetUserRows] = await db.query('SELECT role FROM users WHERE user_id = ?', [receiverId]);
            const targetRole = targetUserRows[0]?.role || 'Student';

            const targetUrl = targetRole === 'Teacher'
                ? `/teacher/messages/${senderId}`
                : `/messages?userId=${senderId}`;

            await notificationService.dispatch({
                recipientIds: receiverId,
                actorId: senderId,
                role: targetRole,
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_attachment',
                title: `Attachment from ${senderName}`,
                message: `Shared an attachment: ${origName}`,
                targetUrl: targetUrl,
                metadata: { senderId, messageId: result.insertId, fileUrl }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Message Upload]', notifErr.message);
        }

        res.json({
            success: true,
            message_id: result.insertId,
            sender_id: senderId,
            receiver_id: receiverId,
            message_text: msgText,
            file_url: fileUrl,
            file_name: origName,
            sent_at: new Date()
        });
    } catch (err) {
        console.error('[POST MESSAGE UPLOAD]', err);
        if (req.file) fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: 'Failed to upload attachment' });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE REGISTRATIONS (Root & Namespaced REST Endpoints)
// ─────────────────────────────────────────────────────────────────────────────

// GET Conversations List
router.get('/api/conversations', handleGetConversations);
router.get('/api/student/messaging/conversations', handleGetConversations);

// GET Message Thread
router.get('/api/messages/:userId', handleGetThreadMessages);
router.get('/api/student/messaging/thread/:partnerId', handleGetThreadMessages);

// POST Send Message
router.post('/api/messages', handleSendMessage);
router.post('/api/student/messaging/send', handleSendMessage);

// POST Upload Attachment
router.post('/api/messages/upload', chatUpload.single('file'), handleMessageUpload);
router.post('/api/student/messaging/upload', chatUpload.single('file'), handleMessageUpload);

// GET Search Users (Strictly within authorized contacts)
router.get('/api/search-users', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId = req.user.user_id;
    const q = String(req.query.q || '').trim();

    if (!q) return res.json([]);

    try {
        const users = await getAuthorizedMessagingContacts(myId, q);
        res.json(users);
    } catch (err) {
        console.error('[SEARCH USERS]', err);
        res.status(500).json([]);
    }
});

// GET Delta Polling Endpoint (?partnerId=:id&since=:timestamp)
router.get('/api/student/messaging/poll', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const myId = req.user.user_id;
    const partnerId = parseInt(req.query.partnerId || req.query.partner_id, 10);
    const since = req.query.since || null;

    if (isNaN(partnerId)) return res.status(400).json({ error: 'partnerId is required' });

    try {
        const allowed = await canCommunicate(myId, partnerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only communicate with peers from your enrolled classes.' });
        }

        let query = `
            SELECT message_id, sender_id, receiver_id, message_text, sent_at, is_read
            FROM private_messages
            WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        `;
        const params = [myId, partnerId, partnerId, myId];

        if (since) {
            const sinceDate = new Date(since);
            if (!isNaN(sinceDate.getTime())) {
                query += ` AND sent_at > ?`;
                params.push(sinceDate);
            }
        }

        query += ` ORDER BY sent_at ASC`;

        const [newMessages] = await db.query(query, params);

        // Mark incoming messages as read (unless client disabled read receipts)
        const markRead = req.query.markRead !== 'false';
        if (markRead && newMessages.some(m => m.receiver_id === myId && !m.is_read)) {
            await db.query(
                `UPDATE private_messages SET is_read = 1
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [partnerId, myId]
            );
            await notificationService.markSenderMessageNotificationsRead({ userId: myId, senderId: partnerId });
        }

        res.json({ success: true, messages: newMessages });
    } catch (err) {
        console.error('[POLL MESSAGES]', err);
        res.status(500).json({ error: 'Failed to poll messages' });
    }
});

// POST Mark Read Endpoint
router.post('/api/student/messaging/read', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const myId = req.user.user_id;
    const partnerId = parseInt(req.body.partner_id || req.body.partnerId, 10);

    if (isNaN(partnerId)) return res.status(400).json({ error: 'partner_id is required' });

    try {
        await db.query(
            `UPDATE private_messages SET is_read = 1
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [partnerId, myId]
        );
        await notificationService.markSenderMessageNotificationsRead({ userId: myId, senderId: partnerId });
        res.json({ success: true });
    } catch (err) {
        console.error('[MARK READ]', err);
        res.status(500).json({ error: 'Failed to mark messages as read' });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/my-game-stats
// Returns the current user's level, total EXP, and all student_scores records
// with assessment name, type, score, total, exp_gained, date_recorded.
// Also returns EXP history (last 10 scores) for the bar chart.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/my-game-stats', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    const studentId = req.user.user_id;

    try {
        // User summary (level + total exp + leveling progression metrics)
        const [[summaryRow]] = await db.query(
            `SELECT user_id, first_name, last_name, current_level, total_exp
             FROM users WHERE user_id = ?`,
            [studentId]
        );

        let levelStats = null;
        try {
            levelStats = await levelProgressionService.getStudentLevelStats(studentId, null, db);
        } catch (_) {}

        const summary = {
            ...(summaryRow || {}),
            current_level: levelStats?.calculatedLevel || summaryRow?.current_level || 1,
            total_exp: summaryRow?.total_exp || 0,
            total_max_exp: levelStats?.totalMaxExp || 52100,
            bracket_size: levelStats?.bracketSize || 4342,
            progress_pct: levelStats?.progressPct || 0,
            level_title: levelStats?.levelTitle || 'Cadet',
            tier: levelStats?.tier || 'Cadet',
            exp_into_level: levelStats?.expIntoLevel || 0,
            exp_needed_for_next: levelStats?.expNeededForNext || 4342
        };

        // All assessment scores for this student
        const [scores] = await db.query(`
            SELECT
                ss.score_id,
                ss.assessment_id,
                ss.score_obtained,
                ss.total_possible_score,
                ss.total_items,
                ss.exp_gained,
                ss.date_recorded,
                a.assessment_name,
                a.assessment_type
            FROM student_scores ss
            JOIN assessments a ON a.assessment_id = ss.assessment_id
            WHERE ss.student_id = ?
            ORDER BY ss.date_recorded DESC
        `, [studentId]);

        // EXP history for chart (last 10 assessments chronological)
        const expHistory = [...scores].reverse().slice(-10).map(s => ({
            label: s.assessment_name,
            exp_gained: s.exp_gained || 0
        }));

        res.json({ success: true, summary, scores, expHistory });

    } catch (err) {
        console.error('[MY GAME STATS]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /home - Institutional DepEd Curriculum Showcase & Enrollment Catalog
router.get('/home', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");

    const studentId = req.user.user_id;

    try {
        const activeSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = activeSY ? activeSY.sy_id : null;

        // 1. Fetch all curriculum subjects
        const [allSubjects] = await db.query(`
            SELECT s.*
            FROM subjects s
            ORDER BY s.semester ASC, s.subject_id ASC
        `);

        // 2. Fetch official section enrollments for this student in the active school year
        const [enrolledRows] = await db.query(`
            SELECT cs.class_id, c.subject_id, c.class_name, c.max_capacity, c.enrolled_count,
                   u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, u.profile_pic AS teacher_profile_pic
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            LEFT JOIN users u ON c.teacher_id = u.user_id
            WHERE cs.student_id = ? ${currentSyId ? 'AND (cs.sy_id = ' + Number(currentSyId) + ' OR c.sy_id = ' + Number(currentSyId) + ')' : ''}
        `, [studentId]);

        const enrolledBySubject = new Map();
        enrolledRows.forEach(row => {
            if (!enrolledBySubject.has(row.subject_id)) {
                enrolledBySubject.set(row.subject_id, row);
            }
        });

        // 3. Fetch default/representative section info for subjects the student is not yet enrolled in
        const [generalClasses] = await db.query(`
            SELECT c.class_id, c.subject_id, c.class_name, c.max_capacity, c.enrolled_count,
                   u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, u.profile_pic AS teacher_profile_pic
            FROM classes c
            LEFT JOIN users u ON c.teacher_id = u.user_id
            WHERE 1=1 ${currentSyId ? 'AND c.sy_id = ' + Number(currentSyId) : ''}
            ORDER BY c.class_id ASC
        `);

        const generalBySubject = new Map();
        generalClasses.forEach(row => {
            if (!generalBySubject.has(row.subject_id)) {
                generalBySubject.set(row.subject_id, row);
            }
        });

        // 4. Build consolidated subject list with institutional enrollment & prerequisite checks
        const subjects = [];
        for (const s of allSubjects) {
            const enrolled = enrolledBySubject.get(s.subject_id);
            const gen = generalBySubject.get(s.subject_id);
            const isEnrolled = Boolean(enrolled);
            const activeClass = enrolled || gen || {};

            const enrollmentStatus = academicHelper.isSemesterEnrollmentOpen(activeSY, s.semester);
            const prerequisite = await academicHelper.checkStudentPrerequisite(db, studentId, s.subject_id, activeSY);

            subjects.push({
                ...s,
                is_enrolled: isEnrolled,
                class_id: activeClass.class_id || null,
                class_name: isEnrolled ? activeClass.class_name : (gen ? gen.class_name : null),
                max_capacity: activeClass.max_capacity || null,
                enrolled_count: activeClass.enrolled_count || null,
                first_name: activeClass.teacher_first_name || null,
                last_name: activeClass.teacher_last_name || null,
                profile_pic: activeClass.teacher_profile_pic || null,
                sy_range: activeSY ? activeSY.sy_range : null,
                enrollmentStatus,
                prerequisite
            });
        }

        res.render('home-student', { user: req.user, subjects, activeSY, currentSY: activeSY });
    } catch (err) {
        console.error('[Student Home Route Error]', err);
        res.status(500).send("Server Error");
    }
});

// POST /enroll - Decommissioned / Retired static self-enrollment gate
router.post('/enroll', async (req, res) => {
    // Institutional Policy: Direct self-enrollment via static access codes has been decommissioned.
    // Class section roster placements are managed centrally by the Academic Administrator and Registrar.
    return res.send(`
        <script>
            alert('Institutional Notice: Direct course self-enrollment using static access codes has been decommissioned in compliance with DepEd curriculum policies.\\n\\nSection assignments and roster enrollment are managed centrally by the Academic Administrator / Registrar. Please consult your school administration or class adviser for section assignment.');
            window.location = '/home';
        </script>
    `);
});

// GET Events Page
router.get('/events', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const studentId = req.user.user_id;

    try {
        // 1. Teacher-created calendar events for the student's enrolled subjects
        //    (these are read-only for students)
        const [teacherEvents] = await db.query(`
            SELECT 
                e.*,
                s.subject_name,
                s.subject_code
            FROM calendar_events e
            JOIN subjects s ON e.subject_id = s.subject_id
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            JOIN users u ON e.teacher_id = u.user_id
            WHERE cs.student_id = ?
              AND u.role IN ('Teacher', 'Admin')
            ORDER BY e.event_date ASC
        `, [studentId]);

        // 2. Student's own personal events
        //    (teacher_id column stores the creator; students are stored there too)
        const [studentEvents] = await db.query(`
            SELECT 
                e.*,
                s.subject_name,
                s.subject_code
            FROM calendar_events e
            LEFT JOIN subjects s ON e.subject_id = s.subject_id
            WHERE e.teacher_id = ?
            ORDER BY e.event_date ASC
        `, [studentId]);

        // 3. Assessment due dates for enrolled + unlocked assessments
        //    Pulled from assessments table (not calendar_events)
        const [dueDates] = await db.query(`
            SELECT
                a.assessment_id,
                a.assessment_name,
                DATE(a.due_date) AS due_date,
                a.due_date AS full_due_date,
                a.assessment_type,
                s.subject_id,
                s.subject_name,
                s.subject_code
            FROM assessments a
            JOIN quarters q ON a.quarter_id = q.quarter_id
            JOIN subjects s ON q.subject_id = s.subject_id
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            WHERE cs.student_id = ?
              AND a.is_unlocked = 1
              AND a.due_date IS NOT NULL
            ORDER BY a.due_date ASC
        `, [studentId]);

        // 4. Enrolled subjects for the "New Event" subject dropdown
        const [userSubjects] = await db.query(`
            SELECT s.subject_id, s.subject_name
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            WHERE cs.student_id = ?
            ORDER BY s.subject_name ASC
        `, [studentId]);

        res.render('event-student', {
            user: req.user,
            teacherEvents: teacherEvents || [],
            studentEvents: studentEvents || [],
            dueDates: dueDates || [],
            userSubjects: userSubjects || []
        });

    } catch (error) {
        console.error('Events Route Error:', error);
        if (error.sqlMessage) console.error('SQL:', error.sqlMessage);
        res.status(500).send('Internal Server Error');
    }
});

// POST Add New Event
router.post('/events/add', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const studentId = req.user.user_id;

    try {
        const {
            subject_id,
            event_title,
            event_description,
            event_type,
            event_date,
            event_location,
            duration_type,
            start_date,
            end_date,
            duration_minutes,
            is_repeatable,
            repeat_cycle
        } = req.body;

        if (!event_title || !event_date) {
            return res.status(400).send('Event title and date are required.');
        }

        const syCtx = await academicHelper.resolveStudentSchoolYearContext(db, studentId);
        const targetSyId = syCtx.targetSyId;

        // Validate subject enrollment in the student's active/enrolled SY if subject is selected
        let enrolledClassId = null;
        if (subject_id) {
            const [[enrolled]] = await db.query(`
                SELECT cs.class_id
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                WHERE cs.student_id = ?
                  AND c.subject_id = ?
                  AND c.sy_id = ?
                  AND sy.status <> 'Draft'
                  AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
                LIMIT 1
            `, [studentId, subject_id, targetSyId]);
            if (!enrolled) return res.status(403).send('Not enrolled in this subject for the active school year.');
            enrolledClassId = enrolled.class_id;
        }

        const finalStartDate = duration_type === 'DateRange' ? (start_date || null) : null;
        const finalEndDate = duration_type === 'DateRange' ? (end_date || null) : null;
        const finalMinutes = duration_type === 'Minutes' ? (duration_minutes || null) : null;
        const repeatableFlag = is_repeatable === 'on' ? 1 : 0;
        const finalCycle = repeatableFlag ? (repeat_cycle || 'None') : 'None';

        await db.query(`
            INSERT INTO calendar_events (
                subject_id, class_id, sy_id, event_title, event_description, event_location,
                event_type, event_date, duration_type,
                start_date, end_date, duration_minutes,
                is_repeatable, repeat_cycle, teacher_id, creator_role
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            subject_id || null,
            enrolledClassId,
            targetSyId,
            event_title,
            event_description || null,
            event_location || 'TBA',
            event_type || 'Material',
            event_date,
            duration_type || 'None',
            finalStartDate,
            finalEndDate,
            finalMinutes,
            repeatableFlag,
            finalCycle,
            studentId,   // student is the creator
            'Student'
        ]);

        res.redirect('/events?success=Event+Added');

    } catch (error) {
        console.error('Add Event Error:', error);
        res.status(500).send('Error saving event: ' + error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /events/edit/:id
// Student edits one of their own events.
// Ownership is strictly enforced: teacher_id must equal the student's user_id.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/events/edit/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const studentId = req.user.user_id;
    const eventId = parseInt(req.params.id, 10);

    try {
        // Ownership check — only allow editing if teacher_id === student's id
        const [[existing]] = await db.query(
            'SELECT * FROM calendar_events WHERE event_id = ? AND teacher_id = ?',
            [eventId, studentId]
        );

        if (!existing) {
            return res.status(403).send('You are not allowed to edit this event.');
        }

        const {
            subject_id,
            event_title,
            event_description,
            event_type,
            event_date,
            event_location,
            duration_type,
            start_date,
            end_date,
            duration_minutes,
            is_repeatable,
            repeat_cycle,
            is_ajax
        } = req.body;

        const finalTitle = (event_title !== undefined && event_title !== '') ? event_title : existing.event_title;
        const finalDate = (event_date !== undefined && event_date !== '') ? event_date : existing.event_date;

        if (!finalTitle || !finalDate) {
            return res.status(400).send('Event title and date are required.');
        }

        const effDurationType = duration_type !== undefined ? duration_type : (existing.duration_type || 'None');
        const finalStartDate = effDurationType === 'DateRange' ? (start_date !== undefined ? (start_date || null) : existing.start_date) : null;
        const finalEndDate = effDurationType === 'DateRange' ? (end_date !== undefined ? (end_date || null) : existing.end_date) : null;
        const finalMinutes = effDurationType === 'Minutes' ? (duration_minutes !== undefined ? (duration_minutes || null) : existing.duration_minutes) : null;
        const repeatableFlag = is_repeatable !== undefined ? (is_repeatable === 'on' || is_repeatable === 1 || is_repeatable === true ? 1 : 0) : existing.is_repeatable;
        const finalCycle = repeatableFlag ? (repeat_cycle || existing.repeat_cycle || 'None') : 'None';

        await db.query(`
            UPDATE calendar_events SET
                subject_id       = ?,
                event_title      = ?,
                event_description= ?,
                event_location   = ?,
                event_type       = ?,
                event_date       = ?,
                duration_type    = ?,
                start_date       = ?,
                end_date         = ?,
                duration_minutes = ?,
                is_repeatable    = ?,
                repeat_cycle     = ?
            WHERE event_id = ? AND teacher_id = ?
        `, [
            subject_id !== undefined ? (subject_id || null) : existing.subject_id,
            finalTitle,
            event_description !== undefined ? (event_description || null) : existing.event_description,
            event_location !== undefined ? (event_location || 'TBA') : existing.event_location,
            event_type !== undefined ? (event_type || 'Material') : existing.event_type,
            finalDate,
            effDurationType,
            finalStartDate,
            finalEndDate,
            finalMinutes,
            repeatableFlag,
            finalCycle,
            eventId,
            studentId   // double-enforce ownership in WHERE clause
        ]);

        if (is_ajax || req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, message: 'Event Updated' });
        }

        res.redirect('/events?success=Event+Updated');

    } catch (error) {
        console.error('Edit Event Error:', error);
        res.status(500).send('Error updating event: ' + error.message);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /events/delete/:id
// Student deletes one of their own events.
// Returns JSON so the frontend can handle it without a page reload.
// Ownership is strictly enforced.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/events/delete/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const studentId = req.user.user_id;
    const eventId = parseInt(req.params.id, 10);

    try {
        // Ownership check
        const [[existing]] = await db.query(
            'SELECT event_id FROM calendar_events WHERE event_id = ? AND teacher_id = ?',
            [eventId, studentId]
        );

        if (!existing) {
            return res.status(403).json({ success: false, message: 'Not allowed to delete this event.' });
        }

        await db.query(
            'DELETE FROM calendar_events WHERE event_id = ? AND teacher_id = ?',
            [eventId, studentId]
        );

        return res.json({ success: true });

    } catch (error) {
        console.error('Delete Event Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/subjects', async (req, res) => {
    try {
        // Kunin ang student ID mula sa session (kung Passport.js ito, karaniwang req.user.user_id)
        const studentId = req.user ? req.user.user_id : req.session.userId;

        if (!studentId) {
            return res.redirect('/login');
        }

        // Query base sa iyong SQL structure:
        // Users -> class_students -> classes -> subjects
        // classes -> users (para sa Teacher name, optional)
        // classes -> school_years (para sa SY range, optional)
        const [enrolledSubjects] = await db.execute(`
            SELECT DISTINCT
                s.subject_id,
                s.subject_code,
                s.subject_name,
                s.subject_image,
                s.description,
                s.semester,
                COALESCE(NULLIF(TRIM(CONCAT(COALESCE(t.first_name, ''), ' ', COALESCE(t.last_name, ''))), ''), 'Instructor') AS teacher_name,
                COALESCE(sy.sy_range, '2025-2026') AS sy_range,
                c.class_id,
                c.class_name
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN users t ON c.teacher_id = t.user_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE cs.student_id = ?
            ORDER BY s.subject_name ASC
        `, [studentId]);

        // I-render ang EJS at ipasa ang data
        res.render('subject-student', {
            user: req.user, // Siguraduhin na may user object para sa header profile
            subjects: enrolledSubjects
        });

    } catch (error) {
        console.error("Database Error sa Subjects Page:", error);
        res.status(500).send("Nagkaroon ng problema sa pag-load ng iyong mga subjects.");
    }
});

// Compatibility redirect alias for notification links targeting individual assessments
router.get('/subject/:subjectId/assessment/:assessmentId', (req, res) => {
    const { subjectId, assessmentId } = req.params;
    return res.redirect(`/subjects/open/${subjectId}?tab=assessments&assessment_id=${assessmentId}#asgn-card-${assessmentId}`);
});

// POST /api/topics/evaluate-schedule - Instant evaluation endpoint for due topic schedules
router.post('/api/topics/evaluate-schedule', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const result = await topicScheduleService.evaluateNow();
        return res.json({
            success: true,
            unlocked: result.unlocked || 0,
            locked: result.locked || 0,
            unlockedTopics: result.unlockedTopics || [],
            lockedTopics: result.lockedTopics || [],
            serverTimeManila: topicScheduleService.getManilaDateTimeString()
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET /subjects/open/:id - View specific subject details
router.get('/subjects/open/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const subjectId = req.params.id;
    const studentId = req.user.user_id;

    try {
        // 1. SUBJECT INFO & ENROLLED CLASS SCOPE (Strictly exclude Draft SYs; prioritize Current SY)
        const syCtx = await academicHelper.resolveStudentSchoolYearContext(db, studentId);
        const [enrolledClassRows] = await db.query(`
            SELECT c.class_id, c.class_name, c.sy_id, sy.sy_range, sy.status AS sy_status,
                   COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), ''), 'Instructor') AS teacher_name,
                   u.profile_pic AS teacher_pic
            FROM classes c
            JOIN class_students cs ON c.class_id = cs.class_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN users u ON c.teacher_id = u.user_id
            WHERE cs.student_id = ?
              AND c.subject_id = ?
              AND sy.status <> 'Draft'
              AND (cs.sy_id IS NULL OR cs.sy_id = c.sy_id)
            ORDER BY (c.sy_id = ?) DESC, (sy.status = 'Current') DESC, sy.start_date DESC, c.class_id ASC
            LIMIT 1
        `, [studentId, subjectId, syCtx.targetSyId || 0]);

        const [subjectInfo] = await db.query(`SELECT * FROM subjects WHERE subject_id = ?`, [subjectId]);

        if (subjectInfo.length === 0) {
            return res.status(404).render('404', {
                title: 'Subject Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Student',
                requestedPath: req.originalUrl,
                customMessage: 'The requested General Chemistry subject record does not exist or has been archived.'
            });
        }

        const enrolledClass = enrolledClassRows.length > 0 ? enrolledClassRows[0] : null;
        const activeSY = await academicHelper.getCurrentSchoolYear(db);
        const studentSyId = (enrolledClass && enrolledClass.sy_id) ? enrolledClass.sy_id : (activeSY ? activeSY.sy_id : null);

        subjectInfo[0].class_name = enrolledClass ? enrolledClass.class_name : 'General Chemistry';
        subjectInfo[0].sy_range = (enrolledClass && enrolledClass.sy_range) ? enrolledClass.sy_range : (activeSY ? activeSY.sy_range : '2028-2029');
        subjectInfo[0].teacher_name = enrolledClass ? enrolledClass.teacher_name : 'Instructor';
        subjectInfo[0].teacher_pic = enrolledClass ? enrolledClass.teacher_pic : null;
        subjectInfo[0].class_id = enrolledClass ? enrolledClass.class_id : null;

        // Evaluate any due automatic topic unlock/lock schedules before reading quarters and topics
        await topicScheduleService.evaluateNow();

        // 2. GET QUARTERS
        const [quartersRaw] = await db.query(`SELECT * FROM quarters WHERE subject_id = ?`, [subjectId]);

        // 3. GET TOPICS
        const [topicsRaw] = await db.query(`
            SELECT topic_id, quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked,
                   DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') AS auto_unlock_at,
                   DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') AS auto_lock_at
            FROM topics WHERE quarter_id IN (
                SELECT quarter_id FROM quarters WHERE subject_id = ?
            )
            ORDER BY topic_id ASC
        `, [subjectId]);

        // 4. GET MATERIALS
        const [materialsRaw] = await db.query(`
            SELECT * FROM learning_materials WHERE topic_id IN (
                SELECT topic_id FROM topics WHERE quarter_id IN (
                    SELECT quarter_id FROM quarters WHERE subject_id = ?
                )
            ) AND (sy_id = ? OR (? IS NULL AND sy_id IS NULL))
        `, [subjectId, studentSyId, studentSyId]);

        // 5. GET ASSESSMENTS
        const [assessmentsRaw] = await db.query(`
            SELECT a.*
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND (a.sy_id = ? OR (? IS NULL AND a.sy_id IS NULL))
            ORDER BY a.due_date ASC
        `, [subjectId, studentSyId, studentSyId]);

        // 6. GET ANNOUNCEMENTS
        const [announcementsRaw] = await db.query(`
            SELECT a.*, u.first_name, u.last_name
            FROM announcements a
            JOIN users u ON a.teacher_id = u.user_id
            LEFT JOIN classes c ON a.class_id = c.class_id
            WHERE (a.scope = 'global' AND (c.subject_id = ? OR a.class_id IS NULL))
               OR (a.class_id IN (
                   SELECT class_id FROM class_students WHERE student_id = ?
               ) AND c.subject_id = ?)
            ORDER BY a.is_critical DESC, a.is_priority DESC, a.created_at DESC
        `, [subjectId, studentId, subjectId]);

        // 7. GET FORUM THREADS
        const [forumsRaw] = await db.query(`
            SELECT f.*, COALESCE(CONCAT(u.first_name, ' ', u.last_name), 'Instructor') AS author_name
            FROM forum_topics f
            LEFT JOIN users u ON f.teacher_id = u.user_id
            WHERE f.subject_id = ? OR f.topic_id IN (
                SELECT t.topic_id FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE q.subject_id = ?
            )
            ORDER BY f.is_pinned DESC, f.created_at DESC
        `, [subjectId, subjectId]);

        // 8. STUDENT COMPLETED TASKS
        const [doneForums] = await db.query(`SELECT forum_id FROM student_forum_done WHERE student_id = ?`, [studentId]);
        const [doneAssessments] = await db.query(`
            SELECT DISTINCT assessment_id FROM (
                SELECT assessment_id FROM student_scores WHERE student_id = ?
                UNION
                SELECT assessment_id FROM elementa_game_sessions 
                WHERE (student_id_p1 = ? OR student_id_p2 = ?) 
                  AND assessment_id IS NOT NULL 
                  AND (session_status = 'Completed' OR is_synced_to_gradebook = 1)
                UNION
                SELECT assessment_id FROM elementa_assessment_tickets 
                WHERE student_id = ? 
                  AND assessment_id IS NOT NULL 
                  AND status = 'Consumed'
            ) AS combined_done
        `, [studentId, studentId, studentId, studentId]);

        // 8b. STUDENT MATERIAL INTERACTIONS
        const [materialInteractions] = await db.query(
            `SELECT DISTINCT material_id FROM student_material_interactions WHERE student_id = ?`,
            [studentId]
        );
        const interactedMaterialIds = new Set(materialInteractions.map(r => r.material_id));

        // 8c. ATTENDANCE STATS FOR THIS SUBJECT
        const [attendanceRows] = await db.query(`
            SELECT ar.attendance_id, ar.status, ar.attendance_method, ar.override_reason,
                   DATE_FORMAT(ar.session_date, '%b %d, %Y') AS session_date,
                   DAYNAME(ar.session_date) AS day_name,
                   DATE_FORMAT(ar.check_in_time, '%h:%i %p') AS check_in_time
            FROM attendance_records ar
            JOIN classes c ON ar.class_id = c.class_id
            WHERE ar.student_id = ? AND c.subject_id = ?
            ORDER BY ar.session_date DESC
        `, [studentId, subjectId]);

        const presCount = attendanceRows.filter(r => r.status === 'Present').length;
        const lateCount = attendanceRows.filter(r => r.status === 'Late').length;
        const absCount = attendanceRows.filter(r => r.status === 'Absent').length;
        const excCount = attendanceRows.filter(r => r.status === 'Excused').length;
        const totalSessions = attendanceRows.length;
        const attRate = totalSessions > 0 ? Math.round(((presCount + lateCount + excCount) / totalSessions) * 100) : 100;

        const attendanceStats = {
            present: presCount,
            late: lateCount,
            absent: absCount,
            excused: excCount,
            total: totalSessions,
            rate: attRate,
            records: attendanceRows
        };

        // 8d. STUDENT SUBMISSIONS & RUBRICS & GROUPS FOR ASSIGNMENTS
        const [studentSubmissions] = await db.query(`
            SELECT ss.*, sr.receipt_id, sr.sha256_hash, sr.server_timestamp,
                   u.first_name AS submitted_by_first, u.last_name AS submitted_by_last
            FROM student_scores ss
            LEFT JOIN submission_receipts sr ON ss.score_id = sr.score_id
            LEFT JOIN users u ON ss.submitted_by_user_id = u.user_id
            WHERE ss.student_id = ?
        `, [studentId]);
        const submissionMap = new Map();
        studentSubmissions.forEach(sub => submissionMap.set(sub.assessment_id, sub));

        const [rubricRows] = await db.query(`
            SELECT rc.*, r.assessment_id
            FROM rubric_criteria rc
            JOIN rubrics r ON rc.rubric_id = r.rubric_id
        `);
        const rubricMap = new Map();
        rubricRows.forEach(rc => {
            if (!rubricMap.has(rc.assessment_id)) rubricMap.set(rc.assessment_id, []);
            rubricMap.get(rc.assessment_id).push(rc);
        });

        const [groupRows] = await db.query(`
            SELECT sg.group_id, sg.group_name, sg.group_set_id,
                   GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ') AS teammates
            FROM group_members gm
            JOIN student_groups sg ON gm.group_id = sg.group_id
            JOIN group_members gm2 ON gm2.group_id = sg.group_id
            JOIN users u ON gm2.student_id = u.user_id
            WHERE gm.student_id = ?
            GROUP BY sg.group_id, sg.group_name, sg.group_set_id
        `, [studentId]);
        const groupMap = new Map();
        groupRows.forEach(g => groupMap.set(g.group_set_id, g));

        // 9. BUILD NESTED QUARTERS/TOPICS
        const now = new Date();
        const quarters = quartersRaw.map((q, qIndex) => {
            const topics = topicsRaw
                .filter(t => t.quarter_id === q.quarter_id)
                .map((t, tIndex) => {
                    const topicLocked = t.is_locked === 1 || t.is_locked === '1' || t.is_locked === true || Number(t.is_locked) === 1;

                    const materials = materialsRaw.filter(m => m.topic_id === t.topic_id).map(m => ({
                        ...m,
                        is_locked: (m.is_locked === 1 || m.is_locked === '1' || m.is_locked === true || Number(m.is_locked) === 1) ? 1 : 0,
                        is_interacted: interactedMaterialIds.has(m.material_id)
                    }));

                    const allTopicAssessments = assessmentsRaw
                        .filter(a => a.topic_id === t.topic_id)
                        .map((a, aIndex) => {
                            const isLocked = topicLocked ? 1 : (a.is_unlocked === 1 || aIndex === 0 ? 0 : 1);
                            const isDone = doneAssessments.some(da => da.assessment_id === a.assessment_id) ? 1 : 0;
                            const isUpcoming = a.start_date && new Date(a.start_date) > now;
                            const isExpired = a.due_date && new Date(a.due_date) < now;
                            const isInGrace = isExpired && a.allow_grace && a.grace_period_minutes && (new Date(a.due_date).getTime() + a.grace_period_minutes * 60000 > now.getTime());
                            const isAvailable = (!isUpcoming && !isExpired) || isInGrace;
                            const canSubmit = isAvailable && (!isDone || a.allow_resubmission);

                            const sub = submissionMap.get(a.assessment_id) || null;
                            const rubricCriteria = rubricMap.get(a.assessment_id) || [];
                            const grp = a.group_set_id ? groupMap.get(a.group_set_id) : null;

                            return {
                                ...a,
                                is_unlocked: isLocked ? 0 : 1,
                                is_locked: isLocked,
                                is_done: isDone,
                                is_upcoming: isUpcoming,
                                is_expired: isExpired,
                                is_in_grace: !!isInGrace,
                                is_available: isAvailable,
                                can_submit: canSubmit,
                                submission: sub,
                                rubric: { criteria: rubricCriteria },
                                group: grp
                            };
                        });

                    // Separate Assessments and Assignments
                    const assignments = allTopicAssessments.filter(a => a.assessment_type === 'Assignment');
                    const assessments = allTopicAssessments.filter(a => a.assessment_type !== 'Assignment');

                    const preTest = assessments.find(a => a.assessment_type === 'Pre-Test') || null;
                    const postTest = assessments.find(a => a.assessment_type === 'Post-Test') || null;
                    const competitive = assessments.find(a => (a.competitive_enabled == 1 || a.assessment_type === 'Competitive') && a !== preTest && a !== postTest) || null;
                    const otherAssessments = assessments.filter(a => a !== preTest && a !== postTest && a !== competitive);

                    const topicForums = forumsRaw
                        .filter(f => f.topic_id === t.topic_id)
                        .map(f => ({
                            ...f,
                            is_unlocked: topicLocked ? 0 : 1,
                            is_done: doneForums.some(df => df.forum_id === f.forum_id) ? 1 : 0
                        }));

                    const topicAnnouncements = [];

                    return {
                        ...t,
                        is_locked: topicLocked,
                        materials,
                        assessments,
                        assignments,
                        preTest,
                        postTest,
                        competitive,
                        otherAssessments,
                        forums: topicForums,
                        announcements: topicAnnouncements
                    };
                });

            return { ...q, topics };
        });

        // 10. CALCULATE PROGRESS PERCENT
        let totalTasks = 0, completedTasks = 0;
        quarters.forEach(q => {
            q.topics.forEach(t => {
                if (t.is_locked) return; // skip locked topics
                t.forums.forEach(f => { totalTasks++; if (f.is_done) completedTasks++; });
                t.assessments.forEach(a => { totalTasks++; if (a.is_done) completedTasks++; });
                t.assignments.forEach(a => { totalTasks++; if (a.is_done) completedTasks++; });
            });
        });

        const progressPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

        // 11. UPDATE student_progress (scoped per student_id, subject_id, sy_id)
        if (studentSyId) {
            await db.query(`
                INSERT INTO student_progress (student_id, subject_id, sy_id, progress_percent, last_accessed)
                VALUES (?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE 
                    progress_percent = VALUES(progress_percent),
                    last_accessed = NOW()
            `, [studentId, subjectId, studentSyId, progressPercent]);
        }

        // 12. GET LEADERBOARD
        const [leaderboard] = await db.query(`
            SELECT u.first_name, u.last_name, COALESCE(sp.progress_percent, 0) as total_exp
            FROM student_progress sp
            JOIN users u ON sp.student_id = u.user_id
            WHERE sp.subject_id = ?
              AND (? IS NULL OR sp.sy_id = ?)
            ORDER BY sp.progress_percent DESC
            LIMIT 5
        `, [subjectId, studentSyId, studentSyId]);

        // 13. RENDER
        res.render('opensubject-student', {
            user: req.user,
            subject: subjectInfo[0],
            quarters,
            announcements: announcementsRaw,
            attendanceStats,
            progress: progressPercent,
            leaderboard: leaderboard || []
        });

    } catch (error) {
        console.error("FULL ERROR DETAILS:", error);
        res.status(500).send("Nagkaroon ng problema sa pag-load ng data: " + error.message);
    }
});

// GET /api/assessment-result/:id — full result data for the Analysis+Review modal
router.get('/api/assessment-result/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const assessmentId = req.params.id;
    const studentId = req.user.user_id;

    try {
        // Verify assessment belongs to the student's active/enrolled School Year and enrolled subject
        const syCtx = await academicHelper.resolveStudentSchoolYearContext(db, studentId);
        const [[asmtMeta]] = await db.query(`
            SELECT a.assessment_id, a.sy_id, COALESCE(q1.subject_id, q2.subject_id) AS subject_id
            FROM assessments a
            LEFT JOIN quarters q1 ON a.quarter_id = q1.quarter_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN quarters q2 ON t.quarter_id = q2.quarter_id
            WHERE a.assessment_id = ?
            LIMIT 1
        `, [assessmentId]);

        if (!asmtMeta) return res.status(404).json({ error: 'Assessment not found' });
        if (
            !syCtx.targetSyId ||
            Number(asmtMeta.sy_id) !== Number(syCtx.targetSyId) ||
            !syCtx.enrolledSubjectIds.includes(Number(asmtMeta.subject_id))
        ) {
            return res.status(403).json({ error: 'Forbidden: Assessment does not belong to your enrolled School Year.' });
        }

        // Score record
        let [[score]] = await db.query(`
            SELECT ss.*,
                   a.assessment_name, a.assessment_type, a.timer_type, a.duration_minutes,
                   s.subject_name, s.subject_code, s.subject_id
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
            JOIN subjects s ON q.subject_id = s.subject_id
            WHERE ss.assessment_id = ? AND ss.student_id = ? AND a.sy_id = ?
            ORDER BY ss.date_recorded DESC LIMIT 1
        `, [assessmentId, studentId, syCtx.targetSyId]);

        // Retrieve arcade/game session if one exists for this assessment and student
        let sessionRecord = null;
        try {
            const [[sess]] = await db.query(`
                SELECT * FROM elementa_game_sessions 
                WHERE assessment_id = ? AND (student_id_p1 = ? OR student_id_p2 = ?)
                ORDER BY (session_status = 'Completed') DESC, ended_at DESC, session_id DESC LIMIT 1
            `, [assessmentId, studentId, studentId]);
            sessionRecord = sess || null;
        } catch (e) { /* non-fatal */ }

        if (!score && sessionRecord) {
            const [[asmt]] = await db.query(`
                SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.timer_type, a.duration_minutes, a.total_items,
                       s.subject_name, s.subject_code, s.subject_id
                FROM assessments a
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                WHERE a.assessment_id = ? AND a.sy_id = ?
            `, [assessmentId, syCtx.targetSyId]);

            if (asmt) {
                const isP1 = sessionRecord.student_id_p1 === studentId;
                const finalScore = isP1 ? sessionRecord.final_score_p1 : sessionRecord.final_score_p2;
                score = {
                    score_id: sessionRecord.session_id,
                    assessment_id: asmt.assessment_id,
                    student_id: studentId,
                    score_obtained: finalScore != null ? finalScore : 0,
                    total_possible_score: asmt.total_items || 10,
                    total_items: asmt.total_items || 10,
                    exp_gained: Math.round((finalScore || 0) * 100),
                    assessment_name: asmt.assessment_name,
                    assessment_type: asmt.assessment_type || 'Arcade Assessment',
                    timer_type: asmt.timer_type,
                    duration_minutes: sessionRecord.total_duration_s ? Math.ceil(sessionRecord.total_duration_s / 60) : asmt.duration_minutes,
                    subject_name: asmt.subject_name,
                    subject_code: asmt.subject_code,
                    subject_id: asmt.subject_id
                };
            }
        }

        if (score && (score.exp_gained == null || score.exp_gained === 0) && score.score_obtained > 0) {
            score.exp_gained = Math.round(Number(score.score_obtained) * 100);
        }

        if (!score) return res.status(404).json({ error: 'No score found' });

        // Optional Rubrics for assignments/deliverables
        let rubrics = [];
        try {
            const [rubricRows] = await db.query(`
                SELECT srs.*, rc.title, rc.max_points, rc.description
                FROM submission_rubric_scores srs
                JOIN rubric_criteria rc ON srs.criterion_id = rc.criterion_id
                WHERE srs.score_id = ?
                ORDER BY rc.sort_order ASC, rc.criterion_id ASC
            `, [score.score_id]);
            rubrics = rubricRows || [];
        } catch (e) { /* non-fatal */ }
        score.rubrics = rubrics;

        // Optional Arcade attempts from elementa_customer_attempts or elementa_grade_responses
        let arcadeAttempts = [];
        try {
            let caRows = [];
            if (sessionRecord && sessionRecord.session_id) {
                const isP1 = sessionRecord.student_id_p1 === studentId;
                const playerNum = isP1 ? 1 : 2;
                [caRows] = await db.query(`
                    SELECT 
                        ca.attempt_id,
                        ca.run_id,
                        ca.question_id,
                        ca.machine_used,
                        ca.player_answer,
                        ca.correct_answer,
                        ca.is_correct,
                        ca.is_timeout,
                        ca.time_given_s,
                        ca.time_remaining_s,
                        ca.response_time_s,
                        ca.points_awarded,
                        ca.level_number,
                        ca.hesitation_score,
                        ca.scaffolding_used,
                        ca.attempted_at,
                        COALESCE(ca.question_snapshot, eq.prompt, 'Mission Question') AS prompt,
                        COALESCE(ca.question_snapshot, eq.prompt, 'Mission Question') AS question_text,
                        COALESCE(ca.player_answer, '') AS student_answer,
                        COALESCE(ca.correct_answer, eq.answer_text, '') AS accepted_answer,
                        eq.steps_json,
                        COALESCE(eq.topic, 'General Chemistry') AS topic,
                        COALESCE(eq.difficulty, 'Standard') AS difficulty,
                        COALESCE(ca.time_given_s, eq.time_limit_s, 90) AS time_limit_s,
                        COALESCE(eq.points, 1) AS points,
                        rm.rem_id AS remediation_id,
                        rm.advice_text,
                        rm.link_url,
                        lm.title AS material_title,
                        lm.file_path_or_url AS material_path
                    FROM elementa_customer_attempts ca
                    JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                    LEFT JOIN elementa_questions eq ON ca.question_id = eq.question_id
                    LEFT JOIN remediation_materials rm ON rm.question_id = ca.question_id
                    LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
                    WHERE lr.session_id = ? AND (lr.player_number = ? OR lr.player_number IS NULL)
                    ORDER BY ca.attempt_id ASC
                `, [sessionRecord.session_id, playerNum]);
            }

            if (!caRows || caRows.length === 0) {
                [caRows] = await db.query(`
                    SELECT 
                        ca.attempt_id,
                        ca.run_id,
                        ca.question_id,
                        ca.machine_used,
                        ca.player_answer,
                        ca.correct_answer,
                        ca.is_correct,
                        ca.is_timeout,
                        ca.time_given_s,
                        ca.time_remaining_s,
                        ca.response_time_s,
                        ca.points_awarded,
                        ca.level_number,
                        ca.hesitation_score,
                        ca.scaffolding_used,
                        ca.attempted_at,
                        COALESCE(ca.question_snapshot, eq.prompt, 'Mission Question') AS prompt,
                        COALESCE(ca.question_snapshot, eq.prompt, 'Mission Question') AS question_text,
                        COALESCE(ca.player_answer, '') AS student_answer,
                        COALESCE(ca.correct_answer, eq.answer_text, '') AS accepted_answer,
                        eq.steps_json,
                        COALESCE(eq.topic, 'General Chemistry') AS topic,
                        COALESCE(eq.difficulty, 'Standard') AS difficulty,
                        COALESCE(ca.time_given_s, eq.time_limit_s, 90) AS time_limit_s,
                        COALESCE(eq.points, 1) AS points,
                        rm.rem_id AS remediation_id,
                        rm.advice_text,
                        rm.link_url,
                        lm.title AS material_title,
                        lm.file_path_or_url AS material_path
                    FROM elementa_customer_attempts ca
                    JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                    JOIN elementa_game_sessions egs ON lr.session_id = egs.session_id
                    LEFT JOIN elementa_questions eq ON ca.question_id = eq.question_id
                    LEFT JOIN remediation_materials rm ON rm.question_id = ca.question_id
                    LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
                    WHERE egs.assessment_id = ? AND (egs.student_id_p1 = ? OR egs.student_id_p2 = ?)
                    ORDER BY ca.attempt_id ASC
                `, [assessmentId, studentId, studentId]);
            }

            if (caRows && caRows.length > 0) {
                arcadeAttempts = caRows;
            } else {
                const [egrRows] = await db.query(`
                    SELECT egr.*, 
                           COALESCE(egr.question_asked, eq.prompt) AS prompt,
                           COALESCE(egr.question_asked, eq.prompt) AS question_text,
                           eq.difficulty, eq.topic, eq.steps_json, eq.points,
                           rm.advice_text, rm.link_url, lm.title AS material_title, lm.file_path_or_url AS material_path
                    FROM elementa_grade_responses egr
                    LEFT JOIN elementa_questions eq ON egr.question_id = eq.question_id
                    LEFT JOIN remediation_materials rm ON rm.question_id = egr.question_id
                    LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
                    WHERE egr.assessment_id = ? AND egr.student_id = ?
                    ORDER BY egr.question_number ASC, egr.attempt_id ASC
                `, [assessmentId, studentId]);
                arcadeAttempts = egrRows || [];
            }

            if (arcadeAttempts.length > 0 && score) {
                score.total_items = arcadeAttempts.length;
                score.total_possible_score = arcadeAttempts.length;
                if (score.score_obtained == null) {
                    score.score_obtained = arcadeAttempts.reduce((sum, a) => sum + (Number(a.points_awarded) || (a.is_correct ? 1 : 0)), 0);
                }
            }
        } catch (e) { console.error('Error fetching arcade attempts:', e); }

        // Questions from elementa_assessment_questions / question_bank joined with student attempts
        let questions = [];
        try {
            const isP1 = sessionRecord ? (sessionRecord.student_id_p1 === studentId) : true;
            const playerNum = isP1 ? 1 : 2;
            const sessionId = sessionRecord ? sessionRecord.session_id : 0;

            const [qRows] = await db.query(`
                SELECT
                    COALESCE(qb.question_id, eq.question_id, eaq.question_id) AS question_id,
                    COALESCE(qb.question_text, eq.prompt, ca.question_snapshot, 'Question') AS question_text,
                    COALESCE(qb.question_text, eq.prompt, ca.question_snapshot, 'Question') AS question,
                    COALESCE(ca.correct_answer, qb.correct_answer, eq.answer_text) AS correct_answer,
                    COALESCE(ca.player_answer, egr.student_answer, '') AS selected_option,
                    COALESCE(ca.player_answer, egr.student_answer, '') AS student_answer,
                    COALESCE(ca.is_correct, egr.is_correct, 0) AS is_correct,
                    COALESCE(ca.points_awarded, egr.points_awarded, 0) AS points_awarded,
                    CASE 
                        WHEN ca.response_time_s IS NOT NULL THEN ROUND(ca.response_time_s * 1000)
                        WHEN egr.response_time_s IS NOT NULL THEN ROUND(egr.response_time_s * 1000)
                        ELSE NULL 
                    END AS response_time_ms,
                    COALESCE(ca.time_given_s, qb.time_limit, eq.time_limit_s, 90) AS time_limit,
                    COALESCE(ca.machine_used, qb.mechanic_type, eq.machine_name) AS mechanic_type,
                    COALESCE(qb.difficulty, eq.difficulty, 'Standard') AS difficulty,
                    COALESCE(qb.input_mode, 'standard_mcq') AS input_mode,
                    COALESCE(qb.base_exp, 100) AS base_exp,
                    qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                    qb.numeric_answer, qb.numeric_tolerance,
                    eaq.sort_order,
                    rm.rem_id AS remediation_id, rm.link_url, rm.preview_json, rm.advice_text,
                    rm.created_at AS remediation_created_at,
                    lm.title AS material_title, lm.file_path_or_url AS material_path, lm.material_type
                FROM elementa_assessment_questions eaq
                LEFT JOIN question_bank qb ON eaq.question_id = qb.question_id
                LEFT JOIN elementa_questions eq ON eaq.question_id = eq.question_id
                LEFT JOIN (
                    SELECT ca.*
                    FROM elementa_customer_attempts ca
                    JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                    WHERE lr.session_id = ? AND (lr.player_number = ? OR lr.player_number IS NULL)
                ) ca ON (ca.question_id = eaq.question_id OR ca.customer_index = eaq.sort_order)
                LEFT JOIN elementa_grade_responses egr ON (
                    egr.assessment_id = eaq.assessment_id AND 
                    egr.student_id = ? AND 
                    (egr.question_id = eaq.question_id OR egr.question_number = eaq.sort_order)
                )
                LEFT JOIN remediation_materials rm ON rm.question_id = eaq.question_id
                LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
                WHERE eaq.assessment_id = ?
                ORDER BY eaq.sort_order ASC
            `, [sessionId, playerNum, studentId, assessmentId]);
            questions = qRows || [];
        } catch (e) { console.error('Error fetching questions for assessment-result:', e); }

        // 1v1 Dual / Versus Match Telemetry & Outcome Calculation
        let dualMatch = null;
        if (sessionRecord && sessionRecord.play_mode === 'Versus') {
            const isP1 = sessionRecord.student_id_p1 === studentId;
            const myPlayerNum = isP1 ? 1 : 2;
            const oppPlayerNum = isP1 ? 2 : 1;
            const oppStudentId = isP1 ? sessionRecord.student_id_p2 : sessionRecord.student_id_p1;

            let oppUser = null;
            if (oppStudentId) {
                try {
                    const [[ou]] = await db.query(
                        'SELECT user_id, first_name, last_name, alternative_name, profile_pic, section, strand, is_ghost_mode, ghost_name, ghost_avatar FROM users WHERE user_id = ?',
                        [oppStudentId]
                    );
                    oppUser = ou || null;
                } catch (e) { console.error('Error fetching oppUser:', e); }
            }

            const myScore = isP1 ? (sessionRecord.final_score_p1 || 0) : (sessionRecord.final_score_p2 || 0);
            const oppScore = isP1 ? (sessionRecord.final_score_p2 || 0) : (sessionRecord.final_score_p1 || 0);

            // Calculate active response times for both players from elementa_customer_attempts
            let myActiveTimeS = 0;
            let oppActiveTimeS = 0;
            try {
                const [timeRows] = await db.query(`
                    SELECT lr.player_number, COALESCE(SUM(ca.response_time_s), 0) AS total_response_time, COUNT(ca.attempt_id) AS items_attempted
                    FROM elementa_level_runs lr
                    JOIN elementa_customer_attempts ca ON ca.run_id = lr.run_id
                    WHERE lr.session_id = ?
                    GROUP BY lr.player_number
                `, [sessionRecord.session_id]);

                for (const tr of timeRows) {
                    if (tr.player_number === myPlayerNum) {
                        myActiveTimeS = Number(tr.total_response_time) || 0;
                    } else if (tr.player_number === oppPlayerNum) {
                        oppActiveTimeS = Number(tr.total_response_time) || 0;
                    }
                }
            } catch (e) { console.error('Error calculating active times:', e); }

            if (myActiveTimeS === 0 && oppActiveTimeS === 0 && sessionRecord.total_duration_s) {
                myActiveTimeS = Number(sessionRecord.total_duration_s);
                oppActiveTimeS = Number(sessionRecord.total_duration_s);
            }

            const winnerField = sessionRecord.winner || (myScore > oppScore ? (isP1 ? 'P1' : 'P2') : (oppScore > myScore ? (isP1 ? 'P2' : 'P1') : (myActiveTimeS < oppActiveTimeS ? (isP1 ? 'P1' : 'P2') : (oppActiveTimeS < myActiveTimeS ? (isP1 ? 'P2' : 'P1') : 'Tie'))));

            let outcome = 'DRAW';
            let isWinner = false;
            let isLoser = false;
            let isTie = false;

            if (winnerField === 'P1') {
                if (isP1) {
                    outcome = 'VICTORY';
                    isWinner = true;
                } else {
                    outcome = 'DEFEAT';
                    isLoser = true;
                }
            } else if (winnerField === 'P2') {
                if (!isP1) {
                    outcome = 'VICTORY';
                    isWinner = true;
                } else {
                    outcome = 'DEFEAT';
                    isLoser = true;
                }
            } else {
                outcome = 'DRAW';
                isTie = true;
            }

            const timeDiffS = Math.abs(myActiveTimeS - oppActiveTimeS);
            const isTiedScore = myScore === oppScore;

            const oppIsGhost = Boolean(oppUser && oppUser.is_ghost_mode);
            const oppName = oppUser
                ? (oppIsGhost ? (oppUser.ghost_name || 'Anonymous Chemist') : `${oppUser.first_name} ${oppUser.last_name}`)
                : 'Opponent Chemist';
            const oppAvatar = oppUser
                ? (oppIsGhost
                    ? (oppUser.ghost_avatar?.startsWith('/') ? oppUser.ghost_avatar : '/images/ghost_avatars/' + (oppUser.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (oppUser.profile_pic ? `/profile_uploads/${oppUser.profile_pic}` : '/profile_uploads/default_avatar.png'))
                : '/profile_uploads/default_avatar.png';

            const formatDuration = (s) => {
                const totalSec = Math.round(s);
                const mins = Math.floor(totalSec / 60);
                const secs = totalSec % 60;
                return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            };

            let tieBreakerReason = null;
            if (isTiedScore) {
                if (isWinner) {
                    tieBreakerReason = `Both cadets scored ${myScore}/${score.total_possible_score || myScore}, but you secured victory by completing challenges ${timeDiffS.toFixed(1)}s faster!`;
                } else if (isLoser) {
                    tieBreakerReason = `Both cadets scored ${myScore}/${score.total_possible_score || myScore}, but ${oppName} claimed victory by completing challenges ${timeDiffS.toFixed(1)}s faster.`;
                } else {
                    tieBreakerReason = `Both cadets achieved identical score (${myScore}) and identical reaction pace!`;
                }
            }

            let viewerUser = req.user || {};
            if (!viewerUser.first_name) {
                try {
                    const [[vu]] = await db.query(
                        'SELECT user_id, first_name, last_name, alternative_name, profile_pic, section, strand, is_ghost_mode, ghost_name, ghost_avatar FROM users WHERE user_id = ?',
                        [studentId]
                    );
                    if (vu) viewerUser = { ...viewerUser, ...vu };
                } catch (e) { console.error('Error fetching viewerUser:', e); }
            }
            const viewerIsGhost = Boolean(viewerUser.is_ghost_mode);
            const viewerName = viewerIsGhost ? (viewerUser.ghost_name || 'Anonymous Chemist') : `${viewerUser.first_name || 'Cadet'} ${viewerUser.last_name || ''}`.trim();
            const viewerAvatar = viewerIsGhost
                ? (viewerUser.ghost_avatar?.startsWith('/') ? viewerUser.ghost_avatar : '/images/ghost_avatars/' + (viewerUser.ghost_avatar || 'ghost_avatar_1.svg'))
                : (viewerUser.profile_pic ? `/profile_uploads/${viewerUser.profile_pic}` : '/profile_uploads/default_avatar.png');

            dualMatch = {
                isDual: true,
                outcome,
                isWinner,
                isLoser,
                isTie,
                myPlayerNumber: myPlayerNum,
                oppPlayerNumber: oppPlayerNum,
                myScore,
                oppScore,
                myTimeFormatted: formatDuration(myActiveTimeS),
                oppTimeFormatted: formatDuration(oppActiveTimeS),
                myTimeSeconds: Number(myActiveTimeS.toFixed(1)),
                oppTimeSeconds: Number(oppActiveTimeS.toFixed(1)),
                timeDiffSeconds: Number(timeDiffS.toFixed(1)),
                isTiedScore,
                tieBreakerReason,
                viewer: {
                    userId: studentId,
                    name: viewerName,
                    avatar: viewerAvatar,
                    section: viewerIsGhost ? 'Classified' : (viewerUser.section || 'General'),
                    strand: viewerIsGhost ? 'Classified' : (viewerUser.strand || 'STEM'),
                    isGhost: viewerIsGhost
                },
                opponent: {
                    userId: oppStudentId,
                    name: oppName,
                    avatar: oppAvatar,
                    section: oppUser ? (oppIsGhost ? 'Classified' : (oppUser.section || 'General')) : 'General',
                    strand: oppUser ? (oppIsGhost ? 'Classified' : (oppUser.strand || 'STEM')) : 'STEM',
                    isGhost: oppIsGhost
                }
            };
        }

        res.json({ score, questions, arcadeAttempts, dualMatch });
    } catch (err) {
        console.error('Assessment result error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/flag-assessment
router.post('/api/flag-assessment', async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const { assessment_id } = req.body;
    const studentId = req.user.user_id;
    if (!assessment_id) return res.status(400).json({ error: 'Missing assessment_id' });
    try {
        await db.query(`UPDATE users SET flagged_assessment_id = ? WHERE user_id = ?`, [assessment_id, studentId]);
        notifyTeachersOfFlaggedAssessment(studentId, assessment_id).catch(() => {});
        res.json({ success: true });
    } catch (err) {
        console.error('Flag assessment error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/material-interaction — log viewed/downloaded
router.post('/api/material-interaction', async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const { material_id, interaction_type } = req.body;
    const student_id = req.user.user_id;

    if (!material_id || !['viewed', 'downloaded'].includes(interaction_type)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    try {
        // Verify the material exists and is not locked before logging
        const [[material]] = await db.query(
            `SELECT material_id, is_locked FROM learning_materials WHERE material_id = ?`,
            [material_id]
        );

        if (!material) return res.status(404).json({ error: 'Material not found' });
        if (material.is_locked) return res.status(403).json({ error: 'Material is locked' });

        await db.query(
            `INSERT INTO student_material_interactions (student_id, material_id, interaction_type)
             VALUES (?, ?, ?)`,
            [student_id, material_id, interaction_type]
        );

        // ── Recalculate progress ──────────────────────────────────────────────
        // Find which subject this material belongs to (via topic → quarter → subject)
        const [[subjectRow]] = await db.query(`
            SELECT q.subject_id, lm.sy_id
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE lm.material_id = ?
        `, [material_id]);

        if (subjectRow) {
            await recalculateProgress(student_id, subjectRow.subject_id, subjectRow.sy_id);
        }
        // ─────────────────────────────────────────────────────────────────────

        res.json({ success: true });
    } catch (err) {
        console.error('Material interaction error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /leaderboards - View global and subject-specific leaderboards
router.get('/leaderboards', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;

    // ── 1. Parse Filter & State Parameters ────────────────────────────────────
    const cohortScope = req.query.cohort_scope || req.query.cohortScope || 'all'; // 'all' | 'class'
    let activeClassId = req.query.class_id || req.query.activeClassId || '';
    const assessmentMode = req.query.mode || req.query.assessmentMode || 'solo'; // 'solo' | 'dual'
    const topicScope = req.query.topic_scope || req.query.topicScope || 'all'; // 'all' | topic_id
    const assessmentType = req.query.assessment_type || req.query.assessmentType || 'all'; // 'all' | 'Pre-Test' | 'Post-Test' | 'Quiz' | 'Competitive'
    const selectedAssessmentId = req.query.assessment_id || req.query.selectedAssessmentId || '';
    const viewWindow = req.query.view_window || req.query.viewWindow || 'three_rank'; // 'three_rank' | 'full' | 'growth'
    const sortMode = req.query.sort || req.query.sortMode || (assessmentMode === 'dual' ? 'wins' : 'best');

    function getChemicalTier(score, accuracy) {
        if (score >= 100 || accuracy >= 95) {
            return { name: 'Noble Gas', color: 'cyan', icon: 'fa-gem', badgeBg: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
        } else if (score >= 70 || accuracy >= 80) {
            return { name: 'Halogen', color: 'indigo', icon: 'fa-flask-vial', badgeBg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
        } else if (score >= 40 || accuracy >= 65) {
            return { name: 'Transition Metal', color: 'amber', icon: 'fa-shield-halved', badgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
        } else {
            return { name: 'Alkali Earth', color: 'emerald', icon: 'fa-atom', badgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' };
        }
    }

    try {
        // ── 2. Authenticated Student User & Ghost Preferences ─────────────────
        const [[userData]] = await db.query(`
            SELECT user_id, first_name, last_name, alternative_name, role, profile_pic,
                   current_level, total_exp, strand, section,
                   is_ghost_mode, ghost_name, ghost_avatar
            FROM users WHERE user_id = ?
        `, [studentId]);

        const user = userData || req.user;
        const isGhostMode = Boolean(user.is_ghost_mode);
        const ghostName = user.ghost_name || '';
        const ghostAvatar = user.ghost_avatar || 'ghost_avatar_1.svg';

        // ── 3. Student Classes (Cohort Scope) ─────────────────────────────────
        const [myClasses] = await db.query(`
            SELECT c.class_id, c.class_name, s.subject_name, s.subject_code
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE cs.student_id = ?
            ORDER BY c.class_name ASC
        `, [studentId]);

        if (cohortScope === 'class' && !activeClassId && myClasses.length > 0) {
            activeClassId = String(myClasses[0].class_id);
        }

        // ── 4. Curricular Topics ──────────────────────────────────────────────
        const [topicsRows] = await db.query(`
            SELECT DISTINCT t.topic_id AS id, t.topic_name AS name, s.subject_code AS subject
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN classes c ON q.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            JOIN subjects s ON q.subject_id = s.subject_id
            WHERE cs.student_id = ? AND t.is_locked = 0
            ORDER BY t.topic_id ASC
        `, [studentId]);

        const curricularTopics = [
            { id: 'all', name: 'All Topics', subject: '' },
            ...topicsRows
        ];

        // ── 5. Available Assessments (Synchronized with Cohort, Mode, Topic & Type) ───
        let assessmentSql = `
            SELECT DISTINCT a.assessment_id, a.assessment_name, a.assessment_type, t.topic_name, a.topic_id
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN classes c ON q.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            WHERE cs.student_id = ?
        `;
        const assessmentParams = [studentId];

        if (cohortScope === 'class' && activeClassId) {
            assessmentSql += ' AND c.class_id = ?';
            assessmentParams.push(parseInt(activeClassId, 10));
        }

        if (assessmentMode === 'solo') {
            assessmentSql += " AND a.assessment_type != 'Competitive'";
        } else if (assessmentMode === 'dual') {
            assessmentSql += " AND a.assessment_type = 'Competitive'";
        }

        if (topicScope !== 'all' && !isNaN(topicScope)) {
            assessmentSql += ' AND a.topic_id = ?';
            assessmentParams.push(parseInt(topicScope, 10));
        }
        if (assessmentType !== 'all') {
            assessmentSql += ' AND a.assessment_type = ?';
            assessmentParams.push(assessmentType);
        }
        assessmentSql += ' ORDER BY a.assessment_name ASC';
        const [myAssessments] = await db.query(assessmentSql, assessmentParams);

        // Sanitize selectedAssessmentId: ensure it actually exists within the active filtered assessment set
        let effectiveAssessmentId = selectedAssessmentId;
        if (effectiveAssessmentId && !isNaN(effectiveAssessmentId)) {
            const exists = myAssessments.some(a => String(a.assessment_id) === String(effectiveAssessmentId));
            if (!exists) {
                effectiveAssessmentId = ''; // Reset invalid assessment for this topic/type/mode
            }
        }

        // ── 6. Leaderboard Rows & Standings ───────────────────────────────────
        const isCumulativeScope = assessmentMode !== 'dual' && !effectiveAssessmentId;
        let leaderboardRows = [];

        if (assessmentMode === 'dual') {
            // DUAL MODE: 1v1 Versus Aggregations from elementa_game_sessions
            let duelSql = `
                SELECT 
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                    u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                    COUNT(*) AS total_matches,
                    SUM(CASE WHEN (gs.winner = 'P1' AND gs.student_id_p1 = u.user_id) OR (gs.winner = 'P2' AND gs.student_id_p2 = u.user_id) THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN (gs.winner = 'P2' AND gs.student_id_p1 = u.user_id) OR (gs.winner = 'P1' AND gs.student_id_p2 = u.user_id) THEN 1 ELSE 0 END) AS losses,
                    COALESCE(MAX(gs.highest_level_reached), 1) AS highest_level_reached,
                    MAX(gs.started_at) AS started_at,
                    MAX(gs.ended_at) AS ended_at,
                    COALESCE(AVG(gs.total_duration_s), 180) AS avg_duration_s,
                    COALESCE(MAX(CASE WHEN gs.student_id_p1 = u.user_id THEN gs.final_score_p1 ELSE gs.final_score_p2 END), 0) AS best_score_total
                FROM elementa_game_sessions gs
                JOIN users u ON (u.user_id = gs.student_id_p1 OR u.user_id = gs.student_id_p2)
                WHERE gs.play_mode = 'Versus' AND gs.session_status = 'Completed'
            `;
            const duelParams = [];

            if (cohortScope === 'class' && activeClassId) {
                duelSql += ' AND (gs.class_id = ? OR u.user_id IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                duelParams.push(parseInt(activeClassId, 10), parseInt(activeClassId, 10));
            }
            if (topicScope !== 'all' && !isNaN(topicScope)) {
                duelSql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE topic_id = ?)';
                duelParams.push(parseInt(topicScope, 10));
            }
            if (assessmentType !== 'all') {
                duelSql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE assessment_type = ?)';
                duelParams.push(assessmentType);
            }
            if (effectiveAssessmentId && !isNaN(effectiveAssessmentId)) {
                duelSql += ' AND gs.assessment_id = ?';
                duelParams.push(parseInt(effectiveAssessmentId, 10));
            }

            duelSql += ' GROUP BY u.user_id ORDER BY wins DESC, total_matches DESC';

            const [duelRows] = await db.query(duelSql, duelParams);

            leaderboardRows = duelRows.map((r, idx) => {
                const isMe = Number(r.student_id) === Number(studentId);
                const rank = idx + 1;
                const isGhost = Boolean(r.is_ghost_mode);
                const gamertag = isGhost ? (r.ghost_name || 'Anonymous Chemist') : (r.alternative_name || `${r.first_name} ${r.last_name}`);
                const displayAvatar = isGhost
                    ? (r.ghost_avatar?.startsWith('/') ? r.ghost_avatar : '/images/ghost_avatars/' + (r.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (r.profile_pic ? '/profile_uploads/' + r.profile_pic : '/profile_uploads/default_avatar.png');

                const totalM = Number(r.total_matches) || 0;
                const wins = Number(r.wins) || 0;
                const losses = Number(r.losses) || 0;
                const winRate = totalM > 0 ? Math.round((wins / totalM) * 100) : 0;
                const elo = 1200 + (wins * 25) - (losses * 15);

                const dur = Math.round(r.avg_duration_s || 180);
                const durStr = `${Math.floor(dur / 60)}m ${dur % 60}s`;

                return {
                    student_id: r.student_id,
                    isMe,
                    rank,
                    displayRank: `#${rank}`,
                    trendClass: 'text-purple-500',
                    trendSymbol: '▲',
                    is_ghost_mode: isGhost,
                    gamertag,
                    displayAvatar,
                    profile_pic: r.profile_pic,
                    displayStrand: isGhost ? 'Hidden' : (r.strand || 'STEM'),
                    displaySection: isGhost ? 'Hidden' : (r.section || 'General'),
                    highest_level_reached: r.highest_level_reached || 1,
                    formatted_started_at: r.started_at ? new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:00 AM',
                    formatted_ended_at: r.ended_at ? new Date(r.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:05 AM',
                    formatted_duration: durStr,
                    tier: getChemicalTier(r.best_score_total || 0, winRate),
                    accuracy_pct: winRate,
                    best_score_total: r.best_score_total || 0,
                    max_combo: Math.min(10, Math.max(1, wins + 1)),
                    wins,
                    losses,
                    win_rate: winRate,
                    arena_elo: elo
                };
            });

        } else {
            // SOLO MODE: Standings aggregated contextually
            // Leaf Node: Single Assessment (Personal Best)
            // Multi-Assessment Scope: Cumulative Summation of personal bests across distinct assessments
            const isCumulativeScope = !effectiveAssessmentId;
            let soloRows = [];

            if (!isCumulativeScope) {
                // Branch 1: Single Specific Assessment
                let soloSql = `
                    SELECT 
                        gs.session_id,
                        gs.session_id AS lb_id,
                        gs.student_id_p1 AS student_id,
                        gs.class_id,
                        gs.assessment_id,
                        gs.final_score_p1 AS best_score_total,
                        COALESCE(gs.highest_level_reached, 1) AS best_level_reached,
                        gs.started_at,
                        gs.ended_at,
                        gs.total_duration_s,
                        u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                        u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                        ROUND(COALESCE(SUM(ca.is_correct) / NULLIF(COUNT(ca.attempt_id), 0) * 100, 100), 1) AS accuracy_pct,
                        COUNT(*) OVER (PARTITION BY gs.student_id_p1) AS total_runs,
                        1 AS assessments_completed
                    FROM elementa_game_sessions gs
                    JOIN users u ON gs.student_id_p1 = u.user_id
                    LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
                    LEFT JOIN elementa_level_runs lr ON gs.session_id = lr.session_id
                    LEFT JOIN elementa_customer_attempts ca ON lr.run_id = ca.run_id
                    WHERE u.role = 'Student'
                      AND gs.play_mode = 'Solo'
                      AND gs.session_status = 'Completed'
                      AND gs.assessment_id = ?
                `;
                const soloParams = [parseInt(effectiveAssessmentId, 10)];

                if (cohortScope === 'class' && activeClassId) {
                    soloSql += ' AND (gs.class_id = ? OR u.user_id IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                    soloParams.push(parseInt(activeClassId, 10), parseInt(activeClassId, 10));
                }

                soloSql += ' GROUP BY gs.session_id';

                if (sortMode === 'precision') {
                    soloSql += ' ORDER BY accuracy_pct DESC, best_score_total DESC, gs.started_at DESC';
                } else {
                    soloSql += ' ORDER BY best_score_total DESC, accuracy_pct DESC, gs.started_at DESC';
                }

                const [rows] = await db.query(soloSql, soloParams);

                // Deduplicate by student_id: Keep the single highest-ranking entry per student
                const seenStudents = new Set();
                for (const r of rows) {
                    const sId = Number(r.student_id);
                    if (!seenStudents.has(sId)) {
                        seenStudents.add(sId);
                        soloRows.push(r);
                    }
                }
            } else {
                // Branch 2: Cumulative Multi-Assessment Scope (Topic, Type, or Global All)
                let subSql = `
                    SELECT 
                        gs.student_id_p1 AS student_id,
                        gs.assessment_id,
                        MAX(gs.final_score_p1) AS best_score,
                        MAX(COALESCE(gs.highest_level_reached, 1)) AS highest_level_reached,
                        AVG(gs.total_duration_s) AS duration_s,
                        MAX(gs.ended_at) AS latest_ended_at,
                        MIN(gs.started_at) AS earliest_started_at,
                        COUNT(DISTINCT gs.session_id) AS total_runs_for_assessment,
                        SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) AS correct_attempts,
                        COUNT(ca.attempt_id) AS total_attempts
                    FROM elementa_game_sessions gs
                    JOIN assessments a ON gs.assessment_id = a.assessment_id
                    LEFT JOIN elementa_level_runs lr ON gs.session_id = lr.session_id
                    LEFT JOIN elementa_customer_attempts ca ON lr.run_id = ca.run_id
                    WHERE gs.play_mode = 'Solo'
                      AND gs.session_status = 'Completed'
                      AND a.assessment_type != 'Competitive'
                `;
                const subParams = [];

                if (cohortScope === 'class' && activeClassId) {
                    subSql += ' AND (gs.class_id = ? OR gs.student_id_p1 IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                    subParams.push(parseInt(activeClassId, 10), parseInt(activeClassId, 10));
                }

                if (topicScope !== 'all' && !isNaN(topicScope)) {
                    subSql += ' AND a.topic_id = ?';
                    subParams.push(parseInt(topicScope, 10));
                }

                if (assessmentType !== 'all') {
                    subSql += ' AND a.assessment_type = ?';
                    subParams.push(assessmentType);
                }

                subSql += ' GROUP BY gs.student_id_p1, gs.assessment_id';

                let mainSql = `
                    SELECT 
                        pb.student_id,
                        CAST(SUM(pb.best_score) AS UNSIGNED) AS best_score_total,
                        COUNT(DISTINCT pb.assessment_id) AS assessments_completed,
                        MAX(pb.highest_level_reached) AS best_level_reached,
                        ROUND(SUM(pb.duration_s)) AS total_duration_s,
                        MAX(pb.latest_ended_at) AS ended_at,
                        MIN(pb.earliest_started_at) AS started_at,
                        SUM(pb.total_runs_for_assessment) AS total_runs,
                        u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                        u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                        ROUND(COALESCE(SUM(pb.correct_attempts) / NULLIF(SUM(pb.total_attempts), 0) * 100, 100), 1) AS accuracy_pct
                    FROM (${subSql}) pb
                    JOIN users u ON pb.student_id = u.user_id
                    WHERE u.role = 'Student'
                    GROUP BY pb.student_id
                `;

                if (sortMode === 'precision') {
                    mainSql += ' ORDER BY accuracy_pct DESC, best_score_total DESC, assessments_completed DESC';
                } else {
                    mainSql += ' ORDER BY best_score_total DESC, accuracy_pct DESC, assessments_completed DESC';
                }

                const [rows] = await db.query(mainSql, subParams);
                soloRows = rows;
            }

            leaderboardRows = soloRows.map((r, idx) => {
                const isMe = Number(r.student_id) === Number(studentId);
                const rank = idx + 1;
                const isGhost = Boolean(r.is_ghost_mode);
                const gamertag = isGhost ? (r.ghost_name || 'Anonymous Chemist') : (r.alternative_name || `${r.first_name} ${r.last_name}`);
                const displayAvatar = isGhost
                    ? (r.ghost_avatar?.startsWith('/') ? r.ghost_avatar : '/images/ghost_avatars/' + (r.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (r.profile_pic ? '/profile_uploads/' + r.profile_pic : '/profile_uploads/default_avatar.png');

                const score = Number(r.best_score_total) || 0;
                const accuracy = parseFloat(r.accuracy_pct) || 0;
                const assessmentsCompleted = Number(r.assessments_completed) || 1;

                let durStr = '3m 15s';
                if (r.total_duration_s) {
                    const mins = Math.floor(r.total_duration_s / 60);
                    const secs = Math.round(r.total_duration_s % 60);
                    durStr = `${mins}m ${secs}s`;
                }

                return {
                    lb_id: r.session_id || r.student_id,
                    student_id: r.student_id,
                    isMe,
                    rank,
                    displayRank: `#${rank}`,
                    trendClass: 'text-emerald-500',
                    trendSymbol: '▲',
                    is_ghost_mode: isGhost,
                    gamertag,
                    displayAvatar,
                    profile_pic: r.profile_pic,
                    displayStrand: isGhost ? 'Hidden' : (r.strand || 'STEM'),
                    displaySection: isGhost ? 'Hidden' : (r.section || 'General'),
                    highest_level_reached: r.best_level_reached || 1,
                    total_runs: r.total_runs || 1,
                    assessments_completed: assessmentsCompleted,
                    is_cumulative_scope: isCumulativeScope,
                    formatted_started_at: r.started_at ? new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:00 AM',
                    formatted_ended_at: r.ended_at ? new Date(r.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:05 AM',
                    formatted_duration: durStr,
                    tier: getChemicalTier(score, accuracy),
                    accuracy_pct: accuracy,
                    best_score_total: score,
                    max_combo: Math.min(10, Math.max(1, Math.floor(score / 5) + 1)),
                    wins: 0,
                    losses: 0,
                    win_rate: 0,
                    arena_elo: 1200
                };
            });
        }

        // ── 7. Top 3 Performers & Three-Rank Window Focused Projection ───────
        const myIndex = leaderboardRows.findIndex(r => r.isMe);
        const topThree = leaderboardRows.slice(0, 3);
        const myEntry = myIndex !== -1 ? leaderboardRows[myIndex] : null;
        const isMyEntryInTopThree = myIndex !== -1 && myIndex < 3;

        // Calculate points / wins needed to reach the podium or next threshold
        let pointsToPodium = 0;
        if (myIndex >= 3 && topThree.length >= 3 && myEntry) {
            const rank3 = topThree[2];
            if (assessmentMode === 'dual') {
                pointsToPodium = Math.max(1, (rank3.wins || 0) - (myEntry.wins || 0) + 1);
            } else {
                pointsToPodium = Math.max(1, (rank3.best_score_total || 0) - (myEntry.best_score_total || 0) + 1);
            }
        } else if (myIndex > 0 && myIndex < 3 && topThree.length > 0 && myEntry) {
            const leader = topThree[0];
            if (assessmentMode === 'dual') {
                pointsToPodium = Math.max(1, (leader.wins || 0) - (myEntry.wins || 0) + 1);
            } else {
                pointsToPodium = Math.max(1, (leader.best_score_total || 0) - (myEntry.best_score_total || 0) + 1);
            }
        }

        // Defensively locate distinct peers above and below
        let peerAbove = null;
        if (myIndex > 0 && myEntry) {
            for (let i = myIndex - 1; i >= 0; i--) {
                if (Number(leaderboardRows[i].student_id) !== Number(myEntry.student_id)) {
                    peerAbove = leaderboardRows[i];
                    break;
                }
            }
        }

        let peerBelow = null;
        if (myIndex !== -1 && myEntry && myIndex < leaderboardRows.length - 1) {
            for (let i = myIndex + 1; i < leaderboardRows.length; i++) {
                if (Number(leaderboardRows[i].student_id) !== Number(myEntry.student_id)) {
                    peerBelow = leaderboardRows[i];
                    break;
                }
            }
        }

        const pointsToOvertake = peerAbove && myEntry
            ? Math.max(1, assessmentMode === 'dual' ? ((peerAbove.wins || 0) - (myEntry.wins || 0)) : ((peerAbove.best_score_total || 0) - (myEntry.best_score_total || 0)))
            : 0;

        const threeRankWindow = {
            topThree,
            myEntry,
            myIndex,
            isMyEntryInTopThree,
            isCumulativeScope,
            pointsToPodium,
            peerAbove,
            peerBelow,
            pointsToOvertake
        };

        // ── 8. Dual Mode Heat Match / Showdown ────────────────────────────────
        let heatMatch = null;
        if (assessmentMode === 'dual') {
            const [heatRows] = await db.query(`
                SELECT gs.*,
                       u1.first_name AS p1_fname, u1.last_name AS p1_lname, u1.profile_pic AS p1_pic, u1.section AS p1_sec,
                       u1.is_ghost_mode AS p1_is_ghost, u1.ghost_name AS p1_ghost_name, u1.ghost_avatar AS p1_ghost_avatar,
                       u2.first_name AS p2_fname, u2.last_name AS p2_lname, u2.profile_pic AS p2_pic, u2.section AS p2_sec,
                       u2.is_ghost_mode AS p2_is_ghost, u2.ghost_name AS p2_ghost_name, u2.ghost_avatar AS p2_ghost_avatar,
                       a.assessment_name
                FROM elementa_game_sessions gs
                LEFT JOIN users u1 ON gs.student_id_p1 = u1.user_id
                LEFT JOIN users u2 ON gs.student_id_p2 = u2.user_id
                LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
                WHERE gs.play_mode = 'Versus' AND gs.session_status = 'Completed'
                ORDER BY ABS(gs.final_score_p1 - gs.final_score_p2) ASC, (gs.final_score_p1 + gs.final_score_p2) DESC
                LIMIT 1
            `);

            if (heatRows.length > 0) {
                const hm = heatRows[0];
                const dur = hm.total_duration_s || 240;
                heatMatch = {
                    assessment_name: hm.assessment_name || 'Dual Arena Showdown',
                    score_diff: Math.abs((hm.final_score_p1 || 0) - (hm.final_score_p2 || 0)),
                    formatted_duration: `${Math.floor(dur / 60)}m ${dur % 60}s`,
                    highest_level_reached: hm.highest_level_reached || 1,
                    winner: hm.winner,
                    final_score_p1: hm.final_score_p1 || 0,
                    final_score_p2: hm.final_score_p2 || 0,
                    p1_name: hm.p1_is_ghost ? (hm.p1_ghost_name || 'Anonymous Chemist') : `${hm.p1_fname} ${hm.p1_lname}`,
                    p1_avatar: hm.p1_is_ghost ? (hm.p1_ghost_avatar?.startsWith('/') ? hm.p1_ghost_avatar : '/images/ghost_avatars/' + (hm.p1_ghost_avatar || 'ghost_avatar_1.svg')) : null,
                    p1_pic: hm.p1_pic,
                    p1_is_ghost: Boolean(hm.p1_is_ghost),
                    p1_section: hm.p1_sec || 'General',
                    formatted_started_at: hm.started_at ? new Date(hm.started_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent Match',
                    p2_name: hm.p2_is_ghost ? (hm.p2_ghost_name || 'Anonymous Chemist') : `${hm.p2_fname} ${hm.p2_lname}`,
                    p2_avatar: hm.p2_is_ghost ? (hm.p2_ghost_avatar?.startsWith('/') ? hm.p2_ghost_avatar : '/images/ghost_avatars/' + (hm.p2_ghost_avatar || 'ghost_avatar_1.svg')) : null,
                    p2_pic: hm.p2_pic,
                    p2_is_ghost: Boolean(hm.p2_is_ghost),
                    p2_section: hm.p2_sec || 'General',
                    formatted_ended_at: hm.ended_at ? new Date(hm.ended_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent Match'
                };
            }
        }

        // ── 9. Most Improved: Chronological Progression & Pre-to-Post Gain ────
        let growthDeltaBoard = [];

        if (assessmentMode === 'dual') {
            // Dual Mode: 1v1 Battle Progression & Win Velocity
            let dualGrowthSql = `
                SELECT 
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                    u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                    COUNT(DISTINCT gs.session_id) AS total_matches,
                    COUNT(DISTINCT CASE WHEN (gs.student_id_p1 = u.user_id AND gs.winner = 'P1') 
                                         OR (gs.student_id_p2 = u.user_id AND gs.winner = 'P2') 
                                   THEN gs.session_id END) AS wins,
                    COUNT(DISTINCT CASE WHEN (gs.student_id_p1 = u.user_id AND gs.winner = 'P2') 
                                         OR (gs.student_id_p2 = u.user_id AND gs.winner = 'P1') 
                                   THEN gs.session_id END) AS losses,
                    MAX(COALESCE(gs.highest_level_reached, 1)) AS highest_level_reached,
                    MIN(gs.started_at) AS first_match_at,
                    MAX(gs.ended_at) AS latest_match_at,
                    AVG(COALESCE(gs.total_duration_s, 180)) AS avg_duration_s
                FROM users u
                JOIN elementa_game_sessions gs ON (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
                WHERE u.role = 'Student'
                  AND gs.play_mode = 'Versus'
                  AND gs.session_status = 'Completed'
            `;
            const dualGrowthParams = [];

            if (cohortScope === 'class' && activeClassId) {
                dualGrowthSql += ' AND (u.user_id IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                dualGrowthParams.push(parseInt(activeClassId, 10));
            }
            if (topicScope !== 'all' && !isNaN(topicScope)) {
                dualGrowthSql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE topic_id = ?)';
                dualGrowthParams.push(parseInt(topicScope, 10));
            }
            if (effectiveAssessmentId && !isNaN(effectiveAssessmentId)) {
                dualGrowthSql += ' AND gs.assessment_id = ?';
                dualGrowthParams.push(parseInt(effectiveAssessmentId, 10));
            }

            dualGrowthSql += ' GROUP BY u.user_id HAVING wins > 0 ORDER BY wins DESC, total_matches DESC LIMIT 10';
            const [dualGrowthRows] = await db.query(dualGrowthSql, dualGrowthParams);

            growthDeltaBoard = dualGrowthRows.map((g, idx) => {
                const isMe = Number(g.student_id) === Number(studentId);
                const isGhost = Boolean(g.is_ghost_mode);
                const gamertag = isGhost ? (g.ghost_name || 'Anonymous Chemist') : (g.alternative_name || `${g.first_name} ${g.last_name}`);
                const displayAvatar = isGhost
                    ? (g.ghost_avatar?.startsWith('/') ? g.ghost_avatar : '/images/ghost_avatars/' + (g.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (g.profile_pic ? '/profile_uploads/' + g.profile_pic : '/profile_uploads/default_avatar.png');

                const totalM = Number(g.total_matches) || 0;
                const wins = Number(g.wins) || 0;
                const losses = Number(g.losses) || 0;
                const winRate = totalM > 0 ? Math.round((wins / totalM) * 100) : 0;
                const dur = Math.round(g.avg_duration_s || 180);
                const durStr = `${Math.floor(dur / 60)}m ${dur % 60}s`;
                const formattedDate = g.latest_match_at ? new Date(g.latest_match_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Recent';

                return {
                    rank: idx + 1,
                    student_id: g.student_id,
                    isMe,
                    gamertag,
                    displayAvatar,
                    profile_pic: g.profile_pic,
                    is_ghost_mode: isGhost,
                    highest_level_reached: g.highest_level_reached || 1,
                    formatted_duration: durStr,
                    formatted_started_at: formattedDate,
                    growth_delta: wins,
                    delta_score: wins,
                    wins,
                    losses,
                    win_rate: winRate,
                    delta_pct: winRate,
                    improvement_type: '1v1 Battle Mastery',
                    attempts_count: totalM
                };
            });
        } else {
            // Solo Mode: True Chronological Improvement (Pre-to-Post Gain + Session Progression)
            // 1. Check Pre-to-Post Learning Gains
            let prePostSql = `
                SELECT 
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                    u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                    pre.score AS pre_score,
                    post.score AS post_score,
                    (post.score - pre.score) AS pre_post_delta,
                    post.ended_at AS latest_run_at,
                    post.duration_s AS post_duration_s,
                    COALESCE(post.highest_level, 1) AS highest_level_reached,
                    (COALESCE(pre.attempts, 1) + COALESCE(post.attempts, 1)) AS attempts_count
                FROM (
                    SELECT gs.student_id_p1 AS student_id, a.topic_id, MIN(gs.final_score_p1) AS score, COUNT(*) AS attempts
                    FROM elementa_game_sessions gs
                    JOIN assessments a ON gs.assessment_id = a.assessment_id
                    WHERE a.assessment_type = 'Pre-Test' AND gs.session_status = 'Completed'
                    GROUP BY gs.student_id_p1, a.topic_id
                ) pre
                JOIN (
                    SELECT gs.student_id_p1 AS student_id, a.topic_id, MAX(gs.final_score_p1) AS score, MAX(gs.ended_at) AS ended_at, AVG(gs.total_duration_s) AS duration_s, MAX(gs.highest_level_reached) AS highest_level, COUNT(*) AS attempts
                    FROM elementa_game_sessions gs
                    JOIN assessments a ON gs.assessment_id = a.assessment_id
                    WHERE a.assessment_type = 'Post-Test' AND gs.session_status = 'Completed'
                    GROUP BY gs.student_id_p1, a.topic_id
                ) post ON pre.student_id = post.student_id AND pre.topic_id = post.topic_id
                JOIN users u ON pre.student_id = u.user_id
                WHERE u.role = 'Student'
                  AND (post.score - pre.score) > 0
            `;
            const prePostParams = [];
            if (cohortScope === 'class' && activeClassId) {
                prePostSql += ' AND (u.user_id IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                prePostParams.push(parseInt(activeClassId, 10));
            }
            if (topicScope !== 'all' && !isNaN(topicScope)) {
                prePostSql += ' AND pre.topic_id = ?';
                prePostParams.push(parseInt(topicScope, 10));
            }

            const [prePostRows] = await db.query(prePostSql, prePostParams);
            const seenStudentIds = new Set();
            const candidates = [];

            // First: Add confirmed Pre-to-Post gains (highest curricular achievement)
            for (const pp of prePostRows) {
                const sId = Number(pp.student_id);
                seenStudentIds.add(sId);
                const isMe = sId === Number(studentId);
                const isGhost = Boolean(pp.is_ghost_mode);
                const gamertag = isGhost ? (pp.ghost_name || 'Anonymous Chemist') : (pp.alternative_name || `${pp.first_name} ${pp.last_name}`);
                const displayAvatar = isGhost
                    ? (pp.ghost_avatar?.startsWith('/') ? pp.ghost_avatar : '/images/ghost_avatars/' + (pp.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (pp.profile_pic ? '/profile_uploads/' + pp.profile_pic : '/profile_uploads/default_avatar.png');

                const initS = Number(pp.pre_score) || 0;
                const currS = Number(pp.post_score) || 0;
                const deltaS = currS - initS;
                const deltaPct = initS > 0 ? Math.round((deltaS / initS) * 100) : 100;
                const dur = Math.round(pp.post_duration_s || 120);
                const durStr = `${Math.floor(dur / 60)}m ${dur % 60}s`;
                const formattedDate = pp.latest_run_at ? new Date(pp.latest_run_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Recent';

                candidates.push({
                    student_id: sId,
                    isMe,
                    gamertag,
                    displayAvatar,
                    profile_pic: pp.profile_pic,
                    is_ghost_mode: isGhost,
                    highest_level_reached: pp.highest_level_reached || 1,
                    formatted_duration: durStr,
                    formatted_started_at: formattedDate,
                    growth_delta: deltaS,
                    delta_score: deltaS,
                    initial_score: initS,
                    current_score: currS,
                    delta_pct: deltaPct,
                    improvement_type: 'Pre-to-Post Gain',
                    attempts_count: pp.attempts_count
                });
            }

            // 2. Query Chronological Session Velocity (Earliest vs Latest attempt)
            let sessionSql = `
                SELECT 
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.alternative_name, u.profile_pic,
                    u.strand, u.section, u.is_ghost_mode, u.ghost_name, u.ghost_avatar,
                    COUNT(lr.run_id) AS attempts_count,
                    MAX(lr.level_number) AS highest_level_reached,
                    AVG(lr.duration_s) AS avg_duration_s,
                    MAX(lr.ended_at) AS latest_run_at,
                    SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(gs.final_score_p1, lr.score) ORDER BY gs.started_at ASC SEPARATOR ','), ',', 1) AS initial_score,
                    SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(gs.final_score_p1, lr.score) ORDER BY gs.started_at DESC SEPARATOR ','), ',', 1) AS current_score
                FROM elementa_level_runs lr
                JOIN elementa_game_sessions gs ON lr.session_id = gs.session_id
                JOIN users u ON u.user_id = (CASE lr.player_number WHEN 1 THEN gs.student_id_p1 ELSE gs.student_id_p2 END)
                WHERE lr.run_status = 'Completed' AND u.role = 'Student' AND gs.play_mode = 'Solo'
            `;
            const sessionParams = [];

            if (cohortScope === 'class' && activeClassId) {
                sessionSql += ' AND (u.user_id IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                sessionParams.push(parseInt(activeClassId, 10));
            }
            if (topicScope !== 'all' && !isNaN(topicScope)) {
                const topicIdNum = parseInt(topicScope, 10);
                sessionSql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE topic_id = ?)';
                sessionParams.push(topicIdNum);
            }
            if (assessmentType !== 'all') {
                sessionSql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE assessment_type = ?)';
                sessionParams.push(assessmentType);
            }
            if (effectiveAssessmentId && !isNaN(effectiveAssessmentId)) {
                sessionSql += ' AND gs.assessment_id = ?';
                sessionParams.push(parseInt(effectiveAssessmentId, 10));
            } else {
                sessionSql += ' AND gs.assessment_id IS NOT NULL';
            }

            sessionSql += ' GROUP BY u.user_id HAVING attempts_count >= 1';
            const [sessionRows] = await db.query(sessionSql, sessionParams);

            for (const sr of sessionRows) {
                const sId = Number(sr.student_id);
                if (seenStudentIds.has(sId)) continue;

                const initS = Number(sr.initial_score) || 0;
                const currS = Number(sr.current_score) || 0;
                const deltaS = currS - initS;
                if (deltaS <= 0) continue; // Only positive progression

                const isMe = sId === Number(studentId);
                const isGhost = Boolean(sr.is_ghost_mode);
                const gamertag = isGhost ? (sr.ghost_name || 'Anonymous Chemist') : (sr.alternative_name || `${sr.first_name} ${sr.last_name}`);
                const displayAvatar = isGhost
                    ? (sr.ghost_avatar?.startsWith('/') ? sr.ghost_avatar : '/images/ghost_avatars/' + (sr.ghost_avatar || 'ghost_avatar_1.svg'))
                    : (sr.profile_pic ? '/profile_uploads/' + sr.profile_pic : '/profile_uploads/default_avatar.png');

                const deltaPct = initS > 0 ? Math.round((deltaS / initS) * 100) : (currS > 0 ? 100 : 0);
                const dur = Math.round(sr.avg_duration_s || 120);
                const durStr = `${Math.floor(dur / 60)}m ${dur % 60}s`;
                const formattedDate = sr.latest_run_at ? new Date(sr.latest_run_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Recent';

                candidates.push({
                    student_id: sId,
                    isMe,
                    gamertag,
                    displayAvatar,
                    profile_pic: sr.profile_pic,
                    is_ghost_mode: isGhost,
                    highest_level_reached: sr.highest_level_reached || 1,
                    formatted_duration: durStr,
                    formatted_started_at: formattedDate,
                    growth_delta: deltaS,
                    delta_score: deltaS,
                    initial_score: initS,
                    current_score: currS,
                    delta_pct: deltaPct,
                    improvement_type: 'Session Velocity',
                    attempts_count: sr.attempts_count
                });
            }

            growthDeltaBoard = candidates
                .sort((a, b) => b.growth_delta - a.growth_delta || b.current_score - a.current_score)
                .slice(0, 10)
                .map((item, idx) => ({ ...item, rank: idx + 1 }));
        }

        // ── 10. Periodic Table Chemical Heatmap & Mastery Diagnostics ─────────
        function buildAttemptScopeClause(params) {
            let sql = `
                JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                JOIN elementa_game_sessions gs ON lr.session_id = gs.session_id
                WHERE 1=1
            `;
            if (cohortScope === 'class' && activeClassId) {
                sql += ' AND (gs.student_id_p1 IN (SELECT student_id FROM class_students WHERE class_id = ?) OR gs.student_id_p2 IN (SELECT student_id FROM class_students WHERE class_id = ?))';
                params.push(parseInt(activeClassId, 10), parseInt(activeClassId, 10));
            } else {
                sql += ' AND (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)';
                params.push(studentId, studentId);
            }

            if (assessmentMode === 'dual') {
                sql += " AND gs.play_mode = 'Versus'";
            } else {
                sql += " AND gs.play_mode = 'Solo' AND gs.assessment_id IS NOT NULL";
            }

            if (topicScope !== 'all' && !isNaN(topicScope)) {
                const topicIdNum = parseInt(topicScope, 10);
                sql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE topic_id = ?)';
                params.push(topicIdNum);
            }

            if (assessmentType !== 'all') {
                sql += ' AND gs.assessment_id IN (SELECT assessment_id FROM assessments WHERE assessment_type = ?)';
                params.push(assessmentType);
            }

            if (effectiveAssessmentId && !isNaN(effectiveAssessmentId)) {
                sql += ' AND gs.assessment_id = ?';
                params.push(parseInt(effectiveAssessmentId, 10));
            }

            return sql;
        }

        // 1. Periodic Table Buttons (scoped)
        const periodicParams = [];
        const periodicFilterSql = buildAttemptScopeClause(periodicParams);
        const [periodicButtons] = await db.query(`
            SELECT 
                b.btn_id, b.element_symbol, b.element_name, b.atomic_number, b.group_col, b.period_row, b.category,
                COUNT(ca.attempt_id) AS total_answered,
                COALESCE(SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct_count,
                COALESCE(SUM(CASE WHEN ca.is_correct = 0 OR ca.is_timeout = 1 THEN 1 ELSE 0 END), 0) AS wrong_count,
                CASE 
                    WHEN COUNT(ca.attempt_id) > 0 THEN ROUND((SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(ca.attempt_id)) * 100, 1)
                    ELSE 100.0
                END AS accuracy_pct
            FROM elementa_periodic_table_buttons b
            LEFT JOIN (
                SELECT ca.attempt_id, ca.run_id, ca.correct_answer, ca.player_answer, ca.is_correct, ca.is_timeout
                FROM elementa_customer_attempts ca
                ${periodicFilterSql}
            ) ca ON (ca.correct_answer LIKE CONCAT('%', b.element_symbol, '%') OR ca.player_answer LIKE CONCAT('%', b.element_symbol, '%'))
            GROUP BY b.btn_id, b.element_symbol, b.element_name, b.atomic_number, b.group_col, b.period_row, b.category
            ORDER BY b.atomic_number ASC
        `, periodicParams);

        const periodicGrid = periodicButtons;

        // 2. High Familiarity / Mastered Elements (>=80% accuracy)
        const masteredParams = [];
        const masteredFilterSql = buildAttemptScopeClause(masteredParams);
        const [masteredRows] = await db.query(`
            SELECT 
                b.element_symbol,
                b.element_name,
                COUNT(ca.attempt_id) AS total_answered,
                SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                ROUND((SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(ca.attempt_id)) * 100, 1) AS accuracy_pct
            FROM elementa_periodic_table_buttons b
            JOIN elementa_customer_attempts ca 
                ON (ca.correct_answer LIKE CONCAT('%', b.element_symbol, '%') OR ca.player_answer LIKE CONCAT('%', b.element_symbol, '%'))
            ${masteredFilterSql}
            GROUP BY b.element_symbol, b.element_name
            HAVING total_answered >= 1 AND accuracy_pct >= 80
            ORDER BY total_answered DESC, accuracy_pct DESC
            LIMIT 6
        `, masteredParams);
        const masteredElements = masteredRows;

        // 3. Struggling Elements (Study Focus areas with errors/timeouts)
        const strugglingParams = [];
        const strugglingFilterSql = buildAttemptScopeClause(strugglingParams);
        let [strugglingRows] = await db.query(`
            SELECT 
                b.element_symbol,
                b.element_name,
                COUNT(ca.attempt_id) AS total_answered,
                SUM(CASE WHEN ca.is_correct = 0 OR ca.is_timeout = 1 THEN 1 ELSE 0 END) AS wrong_count,
                ROUND((SUM(CASE WHEN ca.is_correct = 0 OR ca.is_timeout = 1 THEN 1 ELSE 0 END) / COUNT(ca.attempt_id)) * 100, 1) AS miss_rate
            FROM elementa_periodic_table_buttons b
            JOIN elementa_customer_attempts ca 
                ON (ca.correct_answer LIKE CONCAT('%', b.element_symbol, '%') OR ca.player_answer LIKE CONCAT('%', b.element_symbol, '%'))
            ${strugglingFilterSql}
            GROUP BY b.element_symbol, b.element_name
            HAVING wrong_count > 0
            ORDER BY wrong_count DESC, miss_rate DESC
            LIMIT 6
        `, strugglingParams);

        // Fallback: If 0 struggling elements in this scope, query student's overall struggling elements
        if (strugglingRows.length === 0) {
            const [fallbackStruggling] = await db.query(`
                SELECT 
                    b.element_symbol,
                    b.element_name,
                    COUNT(ca.attempt_id) AS total_answered,
                    SUM(CASE WHEN ca.is_correct = 0 OR ca.is_timeout = 1 THEN 1 ELSE 0 END) AS wrong_count,
                    ROUND((SUM(CASE WHEN ca.is_correct = 0 OR ca.is_timeout = 1 THEN 1 ELSE 0 END) / COUNT(ca.attempt_id)) * 100, 1) AS miss_rate
                FROM elementa_periodic_table_buttons b
                JOIN elementa_customer_attempts ca 
                    ON (ca.correct_answer LIKE CONCAT('%', b.element_symbol, '%') OR ca.player_answer LIKE CONCAT('%', b.element_symbol, '%'))
                JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                JOIN elementa_game_sessions gs ON lr.session_id = gs.session_id
                WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
                GROUP BY b.element_symbol, b.element_name
                HAVING wrong_count > 0
                ORDER BY wrong_count DESC, miss_rate DESC
                LIMIT 6
            `, [studentId, studentId]);
            strugglingRows = fallbackStruggling;
        }
        const strugglingElements = strugglingRows;

        // Click Origin Breakdown
        const [clickBreakdownRows] = await db.query(`
            SELECT click_source, COUNT(*) AS count
            FROM elementa_element_clicks
            GROUP BY click_source
        `);
        const clickSourceBreakdown = clickBreakdownRows.length > 0
            ? clickBreakdownRows
            : [{ click_source: 'Terminal Keypad', count: 8 }, { click_source: 'On-Screen Palette', count: 2 }];

        // ── 11. Machine Practice Stats ────────────────────────────────────────
        const machineParams = [];
        const machineFilterSql = buildAttemptScopeClause(machineParams);
        let [machineRows] = await db.query(`
            SELECT 
                ca.machine_used AS machine,
                COUNT(*) AS total_attempts,
                ROUND(AVG(ca.is_correct) * 100, 1) AS accuracy_pct,
                ROUND(AVG(ca.is_timeout) * 100, 1) AS timeout_rate_pct,
                ROUND(AVG(ca.response_time_s), 1) AS avg_response_time_s
            FROM elementa_customer_attempts ca
            ${machineFilterSql}
              AND ca.machine_used IS NOT NULL AND ca.machine_used != ''
            GROUP BY ca.machine_used
            ORDER BY total_attempts DESC
        `, machineParams);

        if (machineRows.length === 0) {
            // Fallback to student's overall machine practice stats across all sessions
            const [studentOverallMachines] = await db.query(`
                SELECT 
                    ca.machine_used AS machine,
                    COUNT(*) AS total_attempts,
                    ROUND(AVG(ca.is_correct) * 100, 1) AS accuracy_pct,
                    ROUND(AVG(ca.is_timeout) * 100, 1) AS timeout_rate_pct,
                    ROUND(AVG(ca.response_time_s), 1) AS avg_response_time_s
                FROM elementa_customer_attempts ca
                JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
                JOIN elementa_game_sessions gs ON lr.session_id = gs.session_id
                WHERE ca.machine_used IS NOT NULL AND ca.machine_used != ''
                  AND (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
                GROUP BY ca.machine_used
                ORDER BY total_attempts DESC
            `, [studentId, studentId]);
            machineRows = studentOverallMachines;
        }
        const machineStats = machineRows;

        // ── 12. Benchmark Dial & Cohort Median ────────────────────────────────
        const scoreValues = leaderboardRows.map(r => r.best_score_total).sort((a, b) => a - b);
        const midIdx = Math.floor(scoreValues.length / 2);
        const cohortMedian = scoreValues.length > 0
            ? (scoreValues.length % 2 !== 0 ? scoreValues[midIdx] : Math.round((scoreValues[midIdx - 1] + scoreValues[midIdx]) / 2))
            : 0;

        const myBestScore = (threeRankWindow && threeRankWindow.myEntry) ? (threeRankWindow.myEntry.best_score_total || 0) : 0;
        const medianDeltaPct = (myBestScore > 0 && cohortMedian > 0) ? Math.round(((myBestScore - cohortMedian) / cohortMedian) * 100) : 0;
        const benchmarkDialPct = Math.min(100, Math.max(0, Math.round(50 + (medianDeltaPct / 2))));

        // ── 13. Cadet Dossier Telemetry & 12 Chemistry Level Districts ─────────
        // 13.1 Query real curriculum topics from database
        const [dbTopics] = await db.query(`
            SELECT topic_id, quarter_id, topic_name 
            FROM topics 
            ORDER BY topic_id ASC
        `);

        // 13.2 Query student performance per assessment and session
        const [studentScores] = await db.query(`
            SELECT sc.score_id, sc.assessment_id, sc.score_obtained, sc.total_possible_score, sc.total_items, a.topic_id, a.assessment_name
            FROM student_scores sc
            JOIN assessments a ON sc.assessment_id = a.assessment_id
            WHERE sc.student_id = ?
        `, [studentId]);

        const [studentSessions] = await db.query(`
            SELECT gs.session_id, gs.assessment_id, gs.student_id_p1, gs.student_id_p2,
                   gs.final_score_p1, gs.final_score_p2, gs.total_duration_s,
                   a.topic_id, a.total_items, a.assessment_name
            FROM elementa_game_sessions gs
            LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
            WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
        `, [studentId, studentId]);

        // 13.3 Aggregate progress across 12 real curriculum topics
        const districtProgress = dbTopics.map((t, idx) => {
            const levelNumber = idx + 1;
            const topicId = t.topic_id;
            const cleanTopicName = (t.topic_name || `Topic ${topicId}`).replace(/\s+/g, ' ').trim();

            const topicSessions = studentSessions.filter(s => s.topic_id === topicId);
            const topicScores = studentScores.filter(s => s.topic_id === topicId);

            let played = false;
            let totalGainedScore = 0;
            let totalItems = 0;
            let durationSeconds = 0;

            if (topicSessions.length > 0 || topicScores.length > 0) {
                played = true;
                const assessMap = new Map();

                // Process game sessions
                for (const s of topicSessions) {
                    if (!s.assessment_id) continue;
                    const myScore = s.student_id_p1 === studentId ? (s.final_score_p1 || 0) : (s.final_score_p2 || 0);
                    const maxScore = s.total_items || 10;
                    // Strict clamp: score cannot exceed maxScore
                    const clampedScore = Math.min(myScore, maxScore);
                    const dur = s.total_duration_s || 0;

                    if (!assessMap.has(s.assessment_id)) {
                        assessMap.set(s.assessment_id, { bestScore: clampedScore, maxScore, duration: dur });
                    } else {
                        const prev = assessMap.get(s.assessment_id);
                        if (clampedScore > prev.bestScore) prev.bestScore = clampedScore;
                        prev.duration = Math.max(prev.duration, dur);
                    }
                }

                // Process student_scores (web LMS submissions)
                for (const sc of topicScores) {
                    if (!sc.assessment_id) continue;
                    const rawScore = sc.score_obtained || 0;
                    const max = sc.total_items || sc.total_possible_score || 10;
                    const clampedScore = Math.min(rawScore, max);

                    if (!assessMap.has(sc.assessment_id)) {
                        assessMap.set(sc.assessment_id, { bestScore: clampedScore, maxScore: max, duration: 0 });
                    } else {
                        const prev = assessMap.get(sc.assessment_id);
                        if (clampedScore > prev.bestScore) prev.bestScore = clampedScore;
                    }
                }

                if (assessMap.size > 0) {
                    for (const item of assessMap.values()) {
                        totalGainedScore += item.bestScore;
                        totalItems += item.maxScore;
                        durationSeconds += item.duration;
                    }
                } else {
                    for (const s of topicSessions) {
                        const myScore = s.student_id_p1 === studentId ? (s.final_score_p1 || 0) : (s.final_score_p2 || 0);
                        const max = s.total_items || 10;
                        totalGainedScore = Math.max(totalGainedScore, Math.min(myScore, max));
                        totalItems = Math.max(totalItems, max);
                        durationSeconds = Math.max(durationSeconds, s.total_duration_s || 0);
                    }
                }
            }

            const scorePct = totalItems > 0 ? Math.min(100, Math.round((totalGainedScore / totalItems) * 100)) : 0;

            // Accurate Star Calculation:
            // 3 Stars: >= 85%
            // 2 Stars: >= 60%
            // 1 Star: completed with > 0%
            // 0 Stars: 0% or unattempted
            let stars = 0;
            if (played && totalGainedScore > 0) {
                if (scorePct >= 85) stars = 3;
                else if (scorePct >= 60) stars = 2;
                else stars = 1;
            }

            const mins = Math.floor(durationSeconds / 60);
            const secs = durationSeconds % 60;
            const fastestDuration = played ? (durationSeconds > 0 ? `${mins}m ${secs}s` : '0s') : 'N/A';

            return {
                levelNumber,
                topicId,
                topicName: cleanTopicName,
                played,
                stars,
                totalItems: played ? totalItems : 10,
                totalGainedScore: played ? totalGainedScore : 0,
                scorePct,
                fastestDuration
            };
        });

        // 13.4 Bloom's Taxonomy Radar via official arcadeAnalyticsService
        let radarData = null;
        try {
            radarData = await arcadeAnalyticsService.getStudentRadar(studentId);
        } catch (err) {
            console.error('[Cadet Dossier getStudentRadar Error]', err);
        }

        if (!radarData) {
            radarData = {
                remembering: 0,
                understanding: 0,
                applying: 0,
                analyzing: 0,
                precision: 0,
                totalAttemptsAnalyzed: 0,
                rememberingDetails: { correct: 0, total: 0, attempted: false },
                understandingDetails: { correct: 0, total: 0, attempted: false },
                applyingDetails: { correct: 0, total: 0, attempted: false },
                analyzingDetails: { correct: 0, total: 0, attempted: false },
                precisionDetails: { correct: 0, total: 0, baseIndex: 0, attempted: false }
            };
        }

        const studentPrecision = radarData.precision ?? 0;

        // 13.5 Mistakes Diagnostic (Recent Errors)
        const [studentAttempts] = await db.query(`
            SELECT ca.*, lr.level_number, lr.level_topic, a.topic_id AS assess_topic_id
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs lr ON ca.run_id = lr.run_id
            JOIN elementa_game_sessions gs ON lr.session_id = gs.session_id
            LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
            WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
            ORDER BY ca.attempted_at DESC
        `, [studentId, studentId]);

        const mistakes = studentAttempts
            .filter(a => !a.is_correct)
            .slice(0, 5)
            .map(m => ({
                failure_type: m.failure_type || (m.is_timeout ? 'Timeout' : 'Mistake'),
                level_number: m.level_number || 1,
                level_topic: m.level_topic || 'Chemistry Lab',
                question_snapshot: m.question_snapshot,
                player_answer: m.player_answer,
                correct_answer: m.correct_answer,
                is_timeout: m.is_timeout,
                matched_subject_id: 1,
                matched_topic_id: m.assess_topic_id || (m.level_number >= 8 ? 3 : 1)
            }));

        let cadetLevelStats = null;
        try {
            cadetLevelStats = await levelProgressionService.getStudentLevelStats(user.user_id, null, db);
        } catch (_) {}

        const myStudentRow = leaderboardRows.find(r => r.isMe);
        const myTotalCareerRuns = myStudentRow ? (myStudentRow.total_runs || 1) : 1;

        const arcadeStats = {
            cadetLevel: cadetLevelStats?.calculatedLevel || user.current_level || 1,
            totalExp: cadetLevelStats?.totalExp ?? (user.total_exp || 0),
            totalMaxExp: cadetLevelStats?.totalMaxExp || 52100,
            bracketSize: cadetLevelStats?.bracketSize || 4342,
            progressPct: cadetLevelStats?.progressPct || 0,
            levelTitle: cadetLevelStats?.levelTitle || 'Cadet',
            tier: cadetLevelStats?.tier || 'Cadet',
            globalRank: myIndex !== -1 ? (myIndex + 1) : 'N/A',
            precision: studentPrecision,
            bestLevel: (threeRankWindow && threeRankWindow.myEntry) ? (threeRankWindow.myEntry.highest_level_reached || 1) : (districtProgress.filter(d => d.played).length || 1),
            bestScore: myBestScore,
            totalRuns: myTotalCareerRuns,
            avgResponseTime: '16.4',
            chemicalTier: getChemicalTier(myBestScore, studentPrecision),
            cohortMedian,
            medianDeltaPct,
            benchmarkDialPct,
            radar: radarData,
            districtProgress,
            mistakes
        };

        const topicMasteryRings = [
            { name: 'Atomic Foundation', percent: 92, status: 'Mastered', color: '#06b6d4', icon: 'fa-atom' },
            { name: 'Periodic Trends', percent: 84, status: 'Proficient', color: '#6366f1', icon: 'fa-table-cells' },
            { name: 'Chemical Bonding', percent: 76, status: 'In Progress', color: '#10b981', icon: 'fa-link' }
        ];

        // ── 14. Render Full Leaderboard ───────────────────────────────────────
        res.render('leaderboard-student', {
            user,
            myClasses,
            myAssessments,
            curricularTopics,
            cohortScope,
            activeClassId,
            topicScope,
            assessmentMode,
            assessmentType,
            viewWindow,
            sortMode,
            selectedAssessmentId: effectiveAssessmentId,
            isCumulativeScope,
            isGhostMode,
            ghostName,
            ghostAvatar,
            cohortMedian,
            leaderboardRows,
            threeRankWindow,
            heatMatch,
            topicMasteryRings,
            growthDeltaBoard,
            periodicGrid,
            masteredElements,
            strugglingElements,
            clickSourceBreakdown,
            machineStats,
            arcadeStats,
            totalCount: leaderboardRows.length,
            myRank: myIndex !== -1 ? (myIndex + 1) : 'N/A'
        });

    } catch (error) {
        console.error('[LEADERBOARDS ERROR]', error);
        res.status(500).send("Error loading leaderboards: " + error.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /student/api/set-ghost-mode — Toggle Ghost Mode Privacy Masking
// ─────────────────────────────────────────────────────────────────────────────
router.post('/student/api/set-ghost-mode', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const studentId = req.user.user_id;
    const { enabled, ghost_name, ghost_avatar } = req.body;

    try {
        await db.query(`
            UPDATE users
            SET is_ghost_mode = ?, ghost_name = ?, ghost_avatar = ?
            WHERE user_id = ?
        `, [enabled ? 1 : 0, ghost_name || null, ghost_avatar || 'ghost_avatar_1.svg', studentId]);

        req.user.is_ghost_mode = enabled ? 1 : 0;
        req.user.ghost_name = ghost_name || null;
        req.user.ghost_avatar = ghost_avatar || 'ghost_avatar_1.svg';

        res.json({ success: true, is_ghost_mode: enabled ? 1 : 0 });
    } catch (err) {
        console.error('[SET GHOST MODE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Alias for root-mounted /api/set-ghost-mode
router.post('/api/set-ghost-mode', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const studentId = req.user.user_id;
    const { enabled, ghost_name, ghost_avatar } = req.body;

    try {
        await db.query(`
            UPDATE users
            SET is_ghost_mode = ?, ghost_name = ?, ghost_avatar = ?
            WHERE user_id = ?
        `, [enabled ? 1 : 0, ghost_name || null, ghost_avatar || 'ghost_avatar_1.svg', studentId]);

        req.user.is_ghost_mode = enabled ? 1 : 0;
        req.user.ghost_name = ghost_name || null;
        req.user.ghost_avatar = ghost_avatar || 'ghost_avatar_1.svg';

        res.json({ success: true, is_ghost_mode: enabled ? 1 : 0 });
    } catch (err) {
        console.error('[SET GHOST MODE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /student/api/update-gamertag — Update Student Arcade Gamertag / Codename
// ─────────────────────────────────────────────────────────────────────────────
router.post('/student/api/update-gamertag', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const studentId = req.user.user_id;
    const { gamertag } = req.body;
    if (!gamertag || !gamertag.trim()) {
        return res.status(400).json({ success: false, error: 'Gamertag cannot be empty' });
    }
    const cleanTag = gamertag.trim().substring(0, 50);

    try {
        await db.query('UPDATE users SET alternative_name = ? WHERE user_id = ?', [cleanTag, studentId]);
        req.user.alternative_name = cleanTag;
        res.json({ success: true, gamertag: cleanTag });
    } catch (err) {
        console.error('[UPDATE GAMERTAG ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /student/api/session-diagnostic/:sessionId — Post-Assessment Diagnostic
// ─────────────────────────────────────────────────────────────────────────────
router.get('/student/api/session-diagnostic/:sessionId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const sessionId = req.params.sessionId;

    try {
        // 1. Session Telemetry & Curricular Hierarchy
        const [sessRows] = await db.query(`
            SELECT s.session_id, s.student_id, s.topic_id, s.total_duration_s,
                   ct.topic_name, ct.subject_id,
                   (SELECT lr.level_topic FROM elementa_level_runs lr WHERE lr.session_id = s.session_id ORDER BY lr.run_id ASC LIMIT 1) AS level_topic
            FROM elementa_game_sessions s
            LEFT JOIN curriculum_topics ct ON s.topic_id = ct.topic_id
            WHERE s.session_id = ?
        `, [sessionId]);

        if (sessRows.length === 0) {
            return res.json({ success: false, error: 'Diagnostic data unavailable for this session.' });
        }

        // 2. Question Deficits
        const [deficits] = await db.query(`
            SELECT eca.question_snapshot, eca.player_answer, eca.correct_answer, eca.failure_type,
                   q.material_id
            FROM elementa_customer_attempts eca
            JOIN elementa_level_runs lr ON eca.run_id = lr.run_id
            LEFT JOIN questions q ON eca.question_id = q.question_id
            WHERE lr.session_id = ? AND eca.is_correct = 0
            ORDER BY eca.attempt_id ASC
            LIMIT 10
        `, [sessionId]);

        res.json({
            success: true,
            session: sessRows[0],
            conceptDeficits: deficits
        });
    } catch (err) {
        console.error('[SESSION DIAGNOSTIC ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper: Check if a forum has an expired deadline
async function checkForumDeadlineExpired(forumId) {
    if (!forumId) return { expired: false, dueDate: null };
    try {
        const [[forumRow]] = await db.query(
            `SELECT due_date FROM forum_topics WHERE forum_id = ?`,
            [forumId]
        );
        if (!forumRow || !forumRow.due_date) return { expired: false, dueDate: null };
        const dueDate = new Date(forumRow.due_date);
        const expired = dueDate.getTime() < Date.now();
        return { expired, dueDate };
    } catch (e) {
        console.error('[FORUM DEADLINE CHECK ERROR]', e);
        return { expired: false, dueDate: null };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /forums/view/:id — Student Forum Topic Discussion Page
// ─────────────────────────────────────────────────────────────────────────────
router.get('/forums/view/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const studentId = req.user.user_id;
    const forumId = req.params.id;

    try {
        const [[forum]] = await db.query(`
            SELECT ft.*,
                   s.subject_name, s.subject_code, s.subject_image,
                   t.topic_name,
                   u.first_name AS teacher_name, u.last_name AS teacher_lname, u.profile_pic AS teacher_pic,
                   EXISTS(SELECT 1 FROM student_forum_done sfd WHERE sfd.forum_id = ft.forum_id AND sfd.student_id = ?) AS is_done
            FROM forum_topics ft
            JOIN subjects s ON ft.subject_id = s.subject_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.forum_id = ?
              AND EXISTS (
                  SELECT 1
                  FROM class_students cs
                  JOIN classes c ON cs.class_id = c.class_id
                  JOIN users tu ON c.teacher_id = tu.user_id
                  JOIN school_years sy ON c.sy_id = sy.sy_id
                  WHERE cs.student_id  = ?
                    AND c.subject_id   = ft.subject_id
                    AND sy.is_active   = 1
              )
        `, [studentId, forumId, studentId]);

        if (!forum) {
            return res.redirect('/forums?error=Unauthorized+or+forum+not+found');
        }

        const [discussions] = await db.query(`
            SELECT fr.*,
                   u.first_name, u.last_name, u.profile_pic, u.role,
                   (SELECT COUNT(*) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS reply_count,
                   (SELECT MAX(c.created_at) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS last_reply_at,
                   (SELECT CONCAT(u2.first_name, ' ', u2.last_name) 
                    FROM forum_replies c2 
                    JOIN users u2 ON c2.user_id = u2.user_id 
                    WHERE c2.parent_reply_id = fr.reply_id 
                    ORDER BY c2.created_at DESC LIMIT 1) AS last_reply_user_name,
                   EXISTS(SELECT 1 FROM forum_reply_stars frs WHERE frs.reply_id = fr.reply_id AND frs.user_id = ?) AS is_starred,
                   EXISTS(SELECT 1 FROM forum_reply_hidden frh WHERE frh.reply_id = fr.reply_id AND frh.user_id = ?) AS is_hidden
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ? AND fr.parent_reply_id IS NULL
            ORDER BY fr.is_endorsed DESC, fr.created_at DESC
        `, [studentId, studentId, forumId]);

        discussions.forEach(d => {
            if (d.is_anonymous && d.role === 'Student') {
                d.author_name = Number(d.user_id) === Number(studentId) ? `${d.first_name} ${d.last_name} (You)` : 'Anonymous Student';
                d.author_pic = 'default_avatar.png';
            } else {
                d.author_name = `${d.first_name} ${d.last_name}`;
                d.author_pic = d.profile_pic || 'default_avatar.png';
            }
        });

        let totalResponsesCount = 0;
        discussions.forEach(d => { totalResponsesCount += (1 + (d.reply_count || 0)); });

        // Check if student has posted in this forum (for post-first gating)
        const [[postCountRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM forum_replies WHERE topic_id = ? AND user_id = ?`,
            [forumId, studentId]
        );
        const hasPosted = postCountRow && postCountRow.cnt > 0;

        // Dynamic EXP preview based on current time
        let expPreview = null;
        try {
            const [[priorCompletions]] = await db.query(
                `SELECT COUNT(*) AS cnt FROM student_forum_done WHERE forum_id = ?`,
                [forumId]
            );
            expPreview = forumExpService.calculateForumExp(forum, new Date(), priorCompletions ? priorCompletions.cnt : 0);
        } catch (expErr) {
            console.warn('[EXP Preview Error]', expErr);
        }

        const isExpired = Boolean(forum.due_date && new Date(forum.due_date).getTime() < Date.now());

        res.render('forumview-student', {
            user: req.user,
            forum,
            discussions,
            totalResponsesCount,
            hasPosted: Boolean(hasPosted),
            expPreview,
            isExpired
        });

    } catch (err) {
        console.error('[FORUM VIEW ERROR]', err);
        res.status(500).send('Error loading forum: ' + err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forum-discussion/:replyId — Fetch discussion thread details, nested replies & files
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/forum-discussion/:replyId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const replyId = req.params.replyId;

    try {
        const [[rootRow]] = await db.query(`
            SELECT fr.*,
                   ft.title AS forum_title,
                   ft.due_date,
                   s.subject_name,
                   u.first_name, u.last_name, u.profile_pic, u.role,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS like_count,
                   EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.user_id = ?) AS user_liked
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            JOIN subjects s ON ft.subject_id = s.subject_id
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.reply_id = ?
        `, [studentId, replyId]);

        if (!rootRow) {
            return res.status(404).json({ success: false, error: 'Discussion not found' });
        }

        const isForumClosed = Boolean(rootRow.due_date && new Date(rootRow.due_date).getTime() < Date.now());

        const rootTopic = {
            reply_id: rootRow.reply_id,
            topic_id: rootRow.topic_id,
            forum_title: rootRow.forum_title,
            subject_name: rootRow.subject_name,
            reply_title: rootRow.reply_title || rootRow.forum_title,
            reply_content: rootRow.reply_content,
            author_id: rootRow.user_id,
            author_name: (rootRow.is_anonymous && rootRow.role === 'Student')
                ? (Number(rootRow.user_id) === Number(studentId) ? `${rootRow.first_name} ${rootRow.last_name} (You)` : 'Anonymous Student')
                : `${rootRow.first_name} ${rootRow.last_name}`,
            author_pic: (rootRow.is_anonymous && rootRow.role === 'Student')
                ? 'default_avatar.png'
                : (rootRow.profile_pic || 'default_avatar.png'),
            author_role: rootRow.role,
            is_endorsed: !!rootRow.is_endorsed,
            created_at: rootRow.created_at,
            due_date: rootRow.due_date,
            is_closed: isForumClosed,
            file_path: rootRow.file_path,
            file_name: rootRow.file_name,
            file_type: rootRow.file_type,
            external_link: rootRow.external_link,
            like_count: rootRow.like_count || 0,
            user_liked: !!rootRow.user_liked
        };

        const [subRows] = await db.query(`
            SELECT fr.*,
                   u.first_name, u.last_name, u.profile_pic, u.role,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS like_count,
                   EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.user_id = ?) AS user_liked
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE (fr.parent_reply_id = ? OR fr.parent_reply_id IN (
                SELECT r2.reply_id FROM forum_replies r2 WHERE r2.parent_reply_id = ?
            ))
            ORDER BY fr.is_endorsed DESC, fr.created_at ASC
        `, [studentId, replyId, replyId]);

        const subReplies = subRows.map(r => ({
            reply_id: r.reply_id,
            parent_reply_id: r.parent_reply_id,
            reply_content: r.reply_content,
            created_at: r.created_at,
            file_path: r.file_path,
            file_name: r.file_name,
            file_type: r.file_type,
            is_endorsed: !!r.is_endorsed,
            user_id: r.user_id,
            user_name: (r.is_anonymous && r.role === 'Student')
                ? (Number(r.user_id) === Number(studentId) ? `${r.first_name} ${r.last_name} (You)` : 'Anonymous Student')
                : `${r.first_name} ${r.last_name}`,
            profile_pic: (r.is_anonymous && r.role === 'Student')
                ? 'default_avatar.png'
                : (r.profile_pic || 'default_avatar.png'),
            role: r.role,
            like_count: r.like_count || 0,
            user_liked: !!r.user_liked
        }));

        const files = [];
        if (rootTopic.file_path) {
            files.push({
                file_path: rootTopic.file_path,
                file_name: rootTopic.file_name || rootTopic.file_path,
                file_type: rootTopic.file_type,
                author_name: rootTopic.author_name,
                created_at: rootTopic.created_at
            });
        }
        subReplies.forEach(r => {
            if (r.file_path) {
                files.push({
                    file_path: r.file_path,
                    file_name: r.file_name || r.file_path,
                    file_type: r.file_type,
                    author_name: r.user_name,
                    created_at: r.created_at
                });
            }
        });

        res.json({
            success: true,
            rootTopic,
            subReplies,
            files,
            is_closed: rootTopic.is_closed
        });
    } catch (err) {
        console.error('[GET FORUM DISCUSSION ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper: Process and dispatch forum reply and @mention notifications
async function notifyForumReplyAndMentions({ forumId, replyId, parentReplyId, senderId, senderName, content, isAnonymous = false }) {
    try {
        // 1. Fetch forum topic info (including subject_id for mention scoping)
        const [[topic]] = await db.query(
            `SELECT title, teacher_id, subject_id FROM forum_topics WHERE forum_id = ? LIMIT 1`,
            [forumId]
        );
        const forumSubjectId = topic ? topic.subject_id : null;
        const topicTitle = topic ? topic.title : 'Forum Discussion';
        const studentTargetUrl = `/forums/view/${forumId}#reply-${replyId}`;
        const teacherTargetUrl = `/teacher/forums?forum_id=${forumId}#forum-${forumId}`;
        const snippet = content.length > 80 ? content.substring(0, 77) + '...' : content;
        const safeActorId = isAnonymous ? null : senderId;

        // 2. Determine author of parent reply or topic
        let targetAuthorId = null;
        if (parentReplyId) {
            const [[parent]] = await db.query(
                `SELECT user_id FROM forum_replies WHERE reply_id = ? LIMIT 1`,
                [parentReplyId]
            );
            if (parent && parent.user_id && parent.user_id !== senderId) {
                targetAuthorId = parent.user_id;
            }
        } else if (topic && topic.teacher_id && topic.teacher_id !== senderId) {
            targetAuthorId = topic.teacher_id;
        }

        // Notify parent/topic author
        if (targetAuthorId) {
            const [[userRow]] = await db.query(`SELECT role FROM users WHERE user_id = ?`, [targetAuthorId]);
            const recipientRole = userRow?.role || 'Student';
            await notificationService.dispatch({
                recipientIds: targetAuthorId,
                actorId: safeActorId,
                role: recipientRole,
                category: 'forum',
                priority: 'normal',
                eventType: 'forum_reply_received',
                title: `New Reply in "${topicTitle}"`,
                message: `${senderName}: "${snippet}"`,
                targetUrl: recipientRole === 'Teacher' ? teacherTargetUrl : studentTargetUrl,
                metadata: { forumId, replyId }
            });
        }

        // If a student replied to a subreply on a teacher's forum, also notify the forum owner teacher
        if (topic && topic.teacher_id && topic.teacher_id !== senderId && topic.teacher_id !== targetAuthorId) {
            await notificationService.dispatch({
                recipientIds: topic.teacher_id,
                actorId: safeActorId,
                role: 'Teacher',
                category: 'forum',
                priority: 'normal',
                eventType: 'forum_reply_received',
                title: `New Reply in "${topicTitle}"`,
                message: `${senderName}: "${snippet}"`,
                targetUrl: teacherTargetUrl,
                metadata: { forumId, replyId }
            });
        }

        // 3. Scan for @mentions: @Firstname_Lastname or @Username
        const mentionRegex = /@([a-zA-Z0-9._-]+)/g;
        const matches = [];
        let match;
        while ((match = mentionRegex.exec(content)) !== null) {
            matches.push(match[1]);
        }
        const handles = [...new Set(matches)];

        if (handles.length > 0) {
            // Find users whose username or concat(first_name,last_name) matches
            for (const handle of handles) {
                const cleanHandle = handle.replace(/_/g, ' ');
                const [users] = await db.query(`
                    SELECT u.user_id, u.role 
                    FROM users u
                    WHERE (u.username = ? OR CONCAT(u.first_name, u.last_name) = ? OR CONCAT(u.first_name, ' ', u.last_name) = ?)
                      AND u.user_id != ?
                      AND (
                          ? IS NULL
                          OR u.user_id = ?
                          OR EXISTS (SELECT 1 FROM classes c WHERE c.subject_id = ? AND c.teacher_id = u.user_id)
                          OR EXISTS (SELECT 1 FROM class_students cs JOIN classes c ON cs.class_id = c.class_id WHERE c.subject_id = ? AND cs.student_id = u.user_id)
                      )
                    LIMIT 1
                `, [handle, handle.replace(/[._]/g, ''), cleanHandle, senderId, forumSubjectId, topic ? topic.teacher_id : null, forumSubjectId, forumSubjectId]);

                if (users.length > 0 && users[0].user_id !== targetAuthorId) {
                    const recipientRole = users[0].role || 'Student';
                    await notificationService.dispatch({
                        recipientIds: users[0].user_id,
                        actorId: safeActorId,
                        role: recipientRole,
                        category: 'social',
                        priority: 'high',
                        eventType: 'forum_mention',
                        title: `Mentioned by ${senderName}`,
                        message: `Mentioned you in "${topicTitle}": "${snippet}"`,
                        targetUrl: recipientRole === 'Teacher' ? teacherTargetUrl : studentTargetUrl,
                        metadata: { forumId, replyId }
                    });
                }
            }
        }
    } catch (err) {
        console.error('[Forum Notification Error]', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-subreply — Post nested/threaded reply
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-subreply', (req, res) => {
    forumUpload(req, res, async (err) => {
        if (err) {
            console.error('[FORUM SUBREPLY] Multer error:', err);
            return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
        }
        if (!req.isAuthenticated()) {
            return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
        }

        const studentId = req.user.user_id;
        const { forum_id, parent_reply_id, reply_content, is_anonymous } = req.body;
        const content = (reply_content || '').trim();

        if (!content) {
            return res.status(400).json({ success: false, error: 'Reply content cannot be empty.' });
        }

        const safeForumId = parseInt(forum_id, 10);
        const safeParentId = parent_reply_id ? parseInt(parent_reply_id, 10) : null;
        const isAnon = is_anonymous === '1' ? 1 : 0;
        const filePath = req.file ? req.file.filename : null;
        const fileName = req.file ? req.file.originalname : null;
        const fileType = req.file ? req.file.mimetype : null;

        try {
            // Deadline Security Guard: reject if forum due date has passed
            const deadlineCheck = await checkForumDeadlineExpired(safeForumId);
            if (deadlineCheck.expired) {
                const formattedDue = deadlineCheck.dueDate.toLocaleString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
                });
                return res.status(403).json({
                    success: false,
                    error: `This discussion thread closed on ${formattedDue}. Further replies are locked.`,
                    isClosed: true
                });
            }

            const [result] = await db.query(`
                INSERT INTO forum_replies
                    (topic_id, user_id, is_anonymous, parent_reply_id, reply_content,
                     file_path, file_name, file_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [safeForumId, studentId, isAnon, safeParentId, content, filePath, fileName, fileType]);

            // Trigger in-app notification to thread author and @mentioned users
            const senderName = isAnon ? 'Anonymous Student' : `${req.user.first_name || 'Student'} ${req.user.last_name || ''}`.trim();
            notifyForumReplyAndMentions({
                forumId: safeForumId,
                replyId: result.insertId,
                parentReplyId: safeParentId,
                senderId: studentId,
                senderName,
                content,
                isAnonymous: Boolean(isAnon)
            }).catch(() => { });

            res.json({ success: true, reply_id: result.insertId });
        } catch (dbErr) {
            console.error('[FORUM SUBREPLY ERROR]', dbErr);
            res.status(500).json({ success: false, error: dbErr.message });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-discussion-topic — Create student discussion topic
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-discussion-topic', (req, res) => {
    forumUpload(req, res, async (err) => {
        if (err) {
            console.error('[FORUM TOPIC] Multer error:', err);
            return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
        }
        if (!req.isAuthenticated()) {
            return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
        }

        const studentId = req.user.user_id;
        const { forum_id, reply_title, reply_content, is_anonymous, external_link } = req.body;
        const title = (reply_title || '').trim();
        const content = (reply_content || '').trim();

        if (!title || !content) {
            return res.status(400).json({ success: false, error: 'Title and content are required.' });
        }

        const safeForumId = parseInt(forum_id, 10);
        const isAnon = is_anonymous === '1' ? 1 : 0;
        const filePath = req.file ? req.file.filename : null;
        const fileName = req.file ? req.file.originalname : null;
        const fileType = req.file ? req.file.mimetype : null;
        const extLink = (external_link || '').trim() || null;

        try {
            // Deadline Security Guard: reject if forum due date has passed
            const deadlineCheck = await checkForumDeadlineExpired(safeForumId);
            if (deadlineCheck.expired) {
                const formattedDue = deadlineCheck.dueDate.toLocaleString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
                });
                return res.status(403).json({
                    success: false,
                    error: `This forum closed on ${formattedDue}. New discussion topics can no longer be submitted.`,
                    isClosed: true
                });
            }

            const [result] = await db.query(`
                INSERT INTO forum_replies
                    (topic_id, user_id, is_anonymous, parent_reply_id, reply_title, reply_content,
                     file_path, file_name, file_type, external_link, created_at)
                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NOW())
            `, [safeForumId, studentId, isAnon, title, content, filePath, fileName, fileType, extLink]);

            // Trigger in-app notification to topic instructor and @mentioned users
            const senderName = isAnon ? 'Anonymous Student' : `${req.user.first_name || 'Student'} ${req.user.last_name || ''}`.trim();
            notifyForumReplyAndMentions({
                forumId: safeForumId,
                replyId: result.insertId,
                parentReplyId: null,
                senderId: studentId,
                senderName,
                content: `${title} — ${content}`,
                isAnonymous: Boolean(isAnon)
            }).catch(() => { });

            res.json({ success: true, reply_id: result.insertId });
        } catch (dbErr) {
            console.error('[FORUM DISCUSSION TOPIC ERROR]', dbErr);
            res.status(500).json({ success: false, error: dbErr.message });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-reply/:replyId/like — Upvote/like toggle
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-reply/:replyId/like', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const replyId = req.params.replyId;

    try {
        const [existing] = await db.query(
            'SELECT vote_id FROM reply_votes WHERE reply_id = ? AND user_id = ?',
            [replyId, studentId]
        );

        let liked = false;
        if (existing.length > 0) {
            await db.query('DELETE FROM reply_votes WHERE vote_id = ?', [existing[0].vote_id]);
            liked = false;
        } else {
            await db.query('INSERT INTO reply_votes (reply_id, user_id, is_teacher, created_at) VALUES (?, ?, 0, NOW())', [replyId, studentId]);
            liked = true;
        }

        const [[countRow]] = await db.query(
            'SELECT COUNT(*) AS like_count FROM reply_votes WHERE reply_id = ?',
            [replyId]
        );

        res.json({ success: true, liked, like_count: countRow ? countRow.like_count : 0 });
    } catch (err) {
        console.error('[FORUM LIKE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-reply/:replyId/star — Bookmark discussion toggle
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-reply/:replyId/star', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const replyId = req.params.replyId;

    try {
        const [existing] = await db.query(
            'SELECT star_id FROM forum_reply_stars WHERE reply_id = ? AND user_id = ?',
            [replyId, studentId]
        );

        let is_starred = false;
        if (existing.length > 0) {
            await db.query('DELETE FROM forum_reply_stars WHERE star_id = ?', [existing[0].star_id]);
            is_starred = false;
        } else {
            await db.query('INSERT INTO forum_reply_stars (user_id, reply_id, created_at) VALUES (?, ?, NOW())', [studentId, replyId]);
            is_starred = true;
        }

        res.json({ success: true, is_starred });
    } catch (err) {
        console.error('[FORUM STAR ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-reply/:replyId/hide — Hide discussion for current student
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-reply/:replyId/hide', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const replyId = req.params.replyId;

    try {
        await db.query(
            'INSERT IGNORE INTO forum_reply_hidden (user_id, reply_id, created_at) VALUES (?, ?, NOW())',
            [studentId, replyId]
        );
        res.json({ success: true, is_hidden: true });
    } catch (err) {
        console.error('[FORUM HIDE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forum-reply/:replyId/report — Report discussion or comment
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/forum-reply/:replyId/report', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const replyId = req.params.replyId;
    const { reason, details } = req.body;

    try {
        await db.query(`
            INSERT INTO forum_reports (reporter_id, reply_id, reason, details, status, created_at)
            VALUES (?, ?, ?, ?, 'pending', NOW())
        `, [studentId, replyId, reason || 'General', details || '']);

        // T-21: Notify Forum Instructor of reported post
        try {
            const [[ft]] = await db.query(
                `SELECT ft.forum_id, ft.title, ft.teacher_id
                 FROM forum_replies fr
                 JOIN forum_topics ft ON fr.topic_id = ft.forum_id
                 WHERE fr.reply_id = ? LIMIT 1`,
                [replyId]
            );
            if (ft && ft.teacher_id) {
                await notificationService.dispatch({
                    recipientIds: ft.teacher_id,
                    actorId: studentId,
                    role: 'Teacher',
                    category: 'integrity',
                    priority: 'high',
                    eventType: 'forum_post_reported',
                    title: `Forum Post Reported in '${ft.title}'`,
                    message: `A student reported a discussion post for '${reason || 'General'}': ${details || 'Needs moderation review.'}`,
                    targetUrl: `/teacher/forums?forum_id=${ft.forum_id}#forum-${ft.forum_id}`,
                    metadata: { forumId: ft.forum_id, replyId: Number(replyId), reason: reason || 'General' }
                });
            }
        } catch (repNotifErr) {
            console.error('[Forum Report Notification Error]', repNotifErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[FORUM REPORT ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forum/repository-files — Fetch subject/topic learning materials
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/forum/repository-files', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const subjectId = req.query.subject_id;
    const topicId = req.query.topic_id;

    try {
        let materials = [];
        if (topicId && !isNaN(topicId)) {
            const [rows] = await db.query(`
                SELECT material_id, title, file_path_or_url, material_type
                FROM learning_materials
                WHERE topic_id = ? AND is_locked = 0
                ORDER BY title ASC
            `, [topicId]);
            materials = rows;
        } else if (subjectId && !isNaN(subjectId)) {
            const [rows] = await db.query(`
                SELECT lm.material_id, lm.title, lm.file_path_or_url, lm.material_type
                FROM learning_materials lm
                JOIN topics t ON lm.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE q.subject_id = ? AND lm.is_locked = 0
                ORDER BY lm.title ASC
            `, [subjectId]);
            materials = rows;
        }

        res.json({ success: true, materials });
    } catch (err) {
        console.error('[FORUM REPO FILES ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/forums', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;

    try {
        // Fetch subjects the student is officially enrolled in
        const [enrolledSubjects] = await db.query(`
            SELECT DISTINCT s.subject_id, s.subject_name, s.subject_code
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN users t ON c.teacher_id = t.user_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE cs.student_id = ?
              AND (sy.is_active = 1 OR sy.is_active IS NULL)
            ORDER BY s.subject_name ASC
        `, [studentId]);

        const enrolledSubjectIds = (enrolledSubjects || []).map(s => s.subject_id);

        let forums = [];
        if (enrolledSubjectIds.length > 0) {
            const [rows] = await db.query(`
                SELECT DISTINCT
                    ft.forum_id,
                    ft.topic_id,
                    ft.subject_id,
                    ft.teacher_id,
                    ft.title,
                    ft.forum_content,
                    ft.is_pinned,
                    ft.created_at,
                    s.subject_name,
                    t.topic_name,
                    u.first_name  AS teacher_fname,
                    u.last_name   AS teacher_lname,
                    u.profile_pic AS teacher_pic,

                    -- Correct reply count: fr.topic_id is the FK to forum_topics.forum_id
                    (
                        SELECT COUNT(*)
                        FROM forum_replies fr
                        WHERE fr.topic_id = ft.forum_id
                    ) AS reply_count,

                    -- Done flag for this student
                    (
                        SELECT EXISTS(
                            SELECT 1
                            FROM student_forum_done sfd
                            WHERE sfd.forum_id  = ft.forum_id
                              AND sfd.student_id = ?
                        )
                    ) AS is_done

                FROM forum_topics ft
                JOIN subjects s ON ft.subject_id = s.subject_id
                LEFT JOIN topics   t ON ft.topic_id   = t.topic_id
                LEFT JOIN users    u ON ft.teacher_id  = u.user_id

                -- Strictly return forums belonging to subjects the student is officially enrolled in
                WHERE ft.subject_id IN (?)
                  AND EXISTS (
                      SELECT 1
                      FROM class_students cs
                      JOIN classes c ON cs.class_id = c.class_id
                      JOIN users tu ON c.teacher_id = tu.user_id
                      JOIN school_years sy ON c.sy_id = sy.sy_id
                      WHERE cs.student_id  = ?
                        AND c.subject_id   = ft.subject_id
                        AND sy.is_active = 1
                  )

                ORDER BY ft.is_pinned DESC, ft.created_at DESC
            `, [studentId, enrolledSubjectIds, studentId]);
            forums = rows;
        }

        // Count how many distinct forums the student has actually replied in
        // (used for the "Discussions Joined" stat card)
        const [[{ totalParticipated }]] = await db.query(`
            SELECT COUNT(DISTINCT fr.topic_id) AS totalParticipated
            FROM forum_replies fr
            WHERE fr.user_id = ?
        `, [studentId]);

        res.render('forum-student', {
            user: req.user,
            forums: forums ?? [],
            subjects: enrolledSubjects ?? [],
            enrolledSubjects: enrolledSubjects ?? [],
            totalParticipated: totalParticipated ?? 0
        });

    } catch (error) {
        console.error('[FORUMS] Page error:', error);
        res.status(500).send('Database Error: ' + error.message);
    }
});

// ==============================
// 📌 GET: SINGLE FORUM (FOR MODAL)
// ==============================
router.get('/api/forum-topic/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const [[row]] = await db.query(`
            SELECT
                ft.forum_id,
                ft.title,
                ft.forum_content,
                ft.created_at,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                u.profile_pic AS teacher_pic,
                s.subject_name,
                t.topic_name
            FROM forum_topics ft
            JOIN  users    u ON ft.teacher_id  = u.user_id
            LEFT JOIN subjects s ON ft.subject_id = s.subject_id
            LEFT JOIN topics   t ON ft.topic_id   = t.topic_id
            WHERE ft.forum_id = ?
        `, [req.params.id]);

        if (!row) return res.status(404).json({ error: 'Forum not found' });

        res.json(row);

    } catch (err) {
        console.error('[FORUM TOPIC API]', err);
        res.status(500).json({ error: err.message });
    }
});

// ==============================
// 📌 GET: REPLIES
// ==============================
router.get('/api/forum-replies/:forumId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const [replies] = await db.query(`
            SELECT
                fr.reply_id,
                fr.topic_id,
                fr.user_id,
                fr.parent_reply_id,
                fr.reply_content,
                fr.file_path,
                fr.file_name,
                fr.file_type,
                fr.external_link,
                fr.created_at,
                u.first_name,
                u.last_name,
                u.profile_pic,
                u.role
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.created_at ASC
        `, [req.params.forumId]);

        res.json(replies);

    } catch (err) {
        console.error('[FORUM REPLIES API]', err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/forum-members/:forumId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    try {
        // 1. Get the subject_id for this forum (needed to find classmates)
        const [[forumRow]] = await db.query(
            'SELECT subject_id, teacher_id FROM forum_topics WHERE forum_id = ?',
            [req.params.forumId]
        );

        if (!forumRow) return res.status(404).json({ error: 'Forum not found' });

        const { subject_id, teacher_id } = forumRow;

        // 2. Teacher of this forum
        const [teacherRows] = await db.query(`
            SELECT user_id, first_name, last_name, profile_pic, role
            FROM users
            WHERE user_id = ?
        `, [teacher_id]);

        // 3. All students enrolled in the same subject
        //    (via class_students → classes → subjects)
        const [studentRows] = await db.query(`
            SELECT DISTINCT
                u.user_id,
                u.first_name,
                u.last_name,
                u.profile_pic,
                u.role
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN users   u ON cs.student_id = u.user_id
            WHERE c.subject_id = ?
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [subject_id]);

        // Teacher first, then students
        const members = [...teacherRows, ...studentRows];

        res.json(members);

    } catch (err) {
        console.error('[FORUM MEMBERS API]', err);
        res.status(500).json({ error: err.message });
    }
});

// ==============================
// 📌 POST: REPLY WITH FILE
// ==============================
router.post('/api/forum-reply', (req, res) => {
    forumUpload(req, res, async (err) => {
        if (err) {
            console.error('[FORUM REPLY] Multer error:', err);
            return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
        }

        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
        }

        const userId = req.user.user_id;
        const { forum_id, reply_text, parent_id, is_anonymous } = req.body;
        const content = (reply_text || '').trim();

        if (!forum_id || !content) {
            return res.status(400).json({ success: false, error: 'forum_id and reply_text are required.' });
        }

        const safeForumId = parseInt(forum_id, 10);
        const safeParentId = parent_id && !isNaN(parent_id) ? parseInt(parent_id, 10) : null;
        const isAnon = is_anonymous === '1' || is_anonymous === true ? 1 : 0;
        const filePath = req.file ? req.file.filename : null;
        const fileName = req.file ? req.file.originalname : null;
        const fileType = req.file ? req.file.mimetype : null;

        try {
            // Deadline Security Guard: reject if forum due date has passed
            const deadlineCheck = await checkForumDeadlineExpired(safeForumId);
            if (deadlineCheck.expired) {
                const formattedDue = deadlineCheck.dueDate.toLocaleString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
                });
                return res.status(403).json({
                    success: false,
                    error: `This discussion thread closed on ${formattedDue}. Further replies are locked.`,
                    isClosed: true
                });
            }

            const [result] = await db.query(`
                INSERT INTO forum_replies
                    (topic_id, user_id, is_anonymous, parent_reply_id, reply_content,
                     file_path, file_name, file_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [forum_id, userId, isAnon, safeParentId, content, filePath, fileName, fileType]);

            // Trigger in-app notification to thread author and @mentioned users
            const senderName = isAnon ? 'Anonymous Student' : `${req.user.first_name || 'Student'} ${req.user.last_name || ''}`.trim();
            notifyForumReplyAndMentions({
                forumId: parseInt(forum_id, 10),
                replyId: result.insertId,
                parentReplyId: safeParentId,
                senderId: userId,
                senderName,
                content,
                isAnonymous: Boolean(isAnon)
            }).catch(() => { });

            return res.status(200).json({ success: true, reply_id: result.insertId });

        } catch (sqlErr) {
            console.error('[FORUM REPLY] DB error:', sqlErr);
            return res.status(500).json({ success: false, error: sqlErr.sqlMessage || sqlErr.message });
        }
    });
});


router.post('/api/forum-done', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const { forum_id } = req.body;

    if (!forum_id) {
        return res.status(400).json({ success: false, error: 'forum_id is required.' });
    }

    try {
        const [existing] = await db.query(
            'SELECT id, exp_awarded FROM student_forum_done WHERE student_id = ? AND forum_id = ?',
            [studentId, forum_id]
        );

        let is_done = false;
        let expAwarded = 0;
        let timeTier = null;
        let tierTitle = null;

        if (existing.length > 0) {
            const prevAwarded = existing[0].exp_awarded || 0;
            if (prevAwarded > 0) {
                await db.query('UPDATE users SET total_exp = GREATEST(0, total_exp - ?) WHERE user_id = ?', [prevAwarded, studentId]);
                await levelProgressionService.recalculateStudentLevel(studentId, db);
            }
            await db.query('DELETE FROM student_forum_done WHERE student_id = ? AND forum_id = ?', [studentId, forum_id]);
            is_done = false;
        } else {
            const expResult = await forumExpService.awardForumCompletionExp(db, studentId, forum_id, new Date());
            is_done = true;
            expAwarded = expResult.expAwarded || 0;
            timeTier = expResult.timeTier;
            tierTitle = expResult.tierTitle;
        }

        const [[forumRow]] = await db.query(
            `SELECT subject_id FROM forum_topics WHERE forum_id = ?`,
            [forum_id]
        );

        if (forumRow) {
            await recalculateProgress(studentId, forumRow.subject_id);
        }

        res.json({ success: true, is_done, expAwarded, timeTier, tierTitle });
    } catch (err) {
        console.error('[FORUM DONE API]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});



router.post('/api/send-message', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    const senderId = req.user.user_id;
    const { receiver_id, message } = req.body;

    if (!receiver_id || !message || !String(message).trim()) {
        return res.status(400).json({ success: false, error: 'receiver_id and message are required.' });
    }

    // Prevent sending to yourself
    if (parseInt(receiver_id, 10) === senderId) {
        return res.status(400).json({ success: false, error: 'Cannot send a message to yourself.' });
    }

    try {
        const targetId = parseInt(receiver_id, 10);
        const msgText = String(message).trim();
        const [result] = await db.query(`
            INSERT INTO private_messages (sender_id, receiver_id, message_text, sent_at)
            VALUES (?, ?, ?, NOW())
        `, [senderId, targetId, msgText]);

        // T-22: Dispatch in-app notification to receiver
        try {
            const senderName = `${req.user.first_name || 'Classmate'} ${req.user.last_name || ''}`.trim();
            const previewText = msgText.length > 80 ? msgText.substring(0, 77) + '...' : msgText;
            const [targetUserRows] = await db.query('SELECT role FROM users WHERE user_id = ?', [targetId]);
            const targetRole = targetUserRows[0]?.role || 'Student';
            const targetUrl = targetRole === 'Teacher'
                ? `/teacher/messages/${senderId}`
                : `/messages?userId=${senderId}`;

            await notificationService.dispatch({
                recipientIds: targetId,
                actorId: senderId,
                role: targetRole,
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_received',
                title: `Message from ${senderName}`,
                message: previewText,
                targetUrl: targetUrl,
                metadata: { senderId, messageId: result.insertId }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on /api/send-message]', notifErr.message);
        }

        res.json({ success: true });

    } catch (err) {
        console.error('[SEND MESSAGE API]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==============================
// 📌 OPTIONAL: THREAD PAGE
// ==============================
router.get('/forum-thread/:forumId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    try {
        const [forum] = await db.query(`
            SELECT ft.*, u.first_name, u.last_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.forum_id = ?
        `, [req.params.forumId]);

        if (!forum.length) {
            return res.status(404).render('404', {
                title: 'Forum Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Student',
                requestedPath: req.originalUrl,
                customMessage: 'The requested forum discussion could not be found or has been removed.'
            });
        }

        res.render('forum-thread', {
            user: req.user,
            forum: forum[0]
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading thread");
    }
});

// Legacy shadow route /api/notifications removed (now served by routes/notifications.js)

// routes/student.js

// DAPAT NANDITO ITO:
router.get('/arcade/standby', (req, res) => {
    res.render('arcade/standby'); // Siguraduhing may views/arcade/standby.ejs ka
});

// Verification Logic
router.get('/arcade/verify', async (req, res) => {
    const { token } = req.query;

    try {
        // Gagamit tayo ng LEFT JOIN para hindi tayo ma-block kung walang assessment
        const query = `
            SELECT u.*, a.assessment_name, a.assessment_type 
            FROM users u
            LEFT JOIN assessments a ON u.flagged_assessment_id = a.assessment_id
            WHERE u.qr_code_token = ?
        `;
        const [results] = await db.execute(query, [token]);

        if (results.length > 0) {
            const user = results[0];

            // Fallback: Kung walang nahanap na assessment name, bigyan ng default
            const assessmentData = {
                assessment_name: user.assessment_name || "No Assessment Selected",
                assessment_type: user.assessment_type || "N/A"
            };

            res.render('arcade/welcome', {
                user: user,
                assessment: assessmentData
            });
        } else {
            res.redirect('/arcade/standby?error=not_found');
        }
    } catch (err) {
        console.error("SQL Error:", err);
        res.redirect('/arcade/standby');
    }
});

// --- ARCADE GUIDELINES ---
// ─────────────────────────────────────────────────────────────────────────────
// GET /arcade/guidelines/:token
// Loads the Mission Briefing page before the student starts the game.
//
// CHANGES FROM ORIGINAL ROUTER:
//   • Fetches timer_type, duration_minutes, time_limit from assessments
//   • Counts actual Approved questions per difficulty from question_bank
//     (rather than computing distribution from total_items alone)
//   • Passes token back to EJS so the socket can register the player
//   • Passes full user object (user_id, first_name, last_name, profile_pic,
//     qr_code_token) needed by TTS and Socket.IO registration
//
// EJS variables rendered to views/arcade/guidelines.ejs:
//   user       : { user_id, first_name, last_name, profile_pic, qr_code_token }
//   assessment : { assessment_name, assessment_type, timer_type,
//                  duration_minutes, time_limit }
//   total      : integer — actual approved question count (capped to total_items)
//   dist       : { easy, average, difficult } — actual counts from question_bank
//   token      : raw QR token string
// ─────────────────────────────────────────────────────────────────────────────
router.get('/arcade/guidelines/:token', async (req, res) => {
    const token = req.params.token;

    try {
        // ── 1. Resolve token → user + assessment ──────────────────────────────
        // Also fetch timer_type, duration_minutes, and the topic's time_limit
        // (time_limit lives on question_bank rows; we pick the most common value
        //  or the assessment's own per-item seconds if stored there).
        const [[row]] = await db.execute(`
            SELECT
                u.user_id,      u.first_name,   u.last_name,
                u.profile_pic,  u.qr_code_token,
                a.assessment_id,     a.assessment_name,  a.assessment_type,
                a.total_items,       a.timer_type,       a.duration_minutes,
                a.topic_id,          a.is_unlocked
            FROM users u
            JOIN assessments a ON a.assessment_id = u.flagged_assessment_id
            WHERE u.qr_code_token = ?
            LIMIT 1
        `, [token]);

        if (!row) {
            console.warn('[GUIDELINES] Token not found:', token);
            return res.redirect('/arcade/standby');
        }

        if (!row.is_unlocked) {
            console.warn('[GUIDELINES] Assessment locked for user:', row.user_id);
            return res.redirect('/arcade/standby?error=locked');
        }

        const assessmentId = row.assessment_id;
        const topicId = row.topic_id;
        const totalItems = row.total_items || 15;

        // ── 2. Count APPROVED questions by difficulty from the mandatory pool ──
        // Uses assessment_questions → question_bank join so counts reflect
        // only what this assessment actually has, not the whole topic bank.
        const [difficultyCounts] = await db.execute(`
            SELECT
                qb.difficulty,
                COUNT(*) AS cnt
            FROM assessment_questions aq
            JOIN question_bank qb
              ON qb.question_id = aq.question_id
             AND qb.verification_status = 'Approved'
            WHERE aq.assessment_id = ?
            GROUP BY qb.difficulty
        `, [assessmentId]);

        // Map results to { Easy, Average, Difficult }
        const countMap = { Easy: 0, Average: 0, Difficult: 0 };
        difficultyCounts.forEach(r => {
            if (r.difficulty in countMap) countMap[r.difficulty] = parseInt(r.cnt, 10);
        });

        const approvedMandatory = countMap.Easy + countMap.Average + countMap.Difficult;

        // If mandatory approved questions < total_items, filler questions will be
        // pulled at game time. For display purposes we show total_items as the target.
        const displayTotal = totalItems;

        // If there are filler questions needed, distribute remaining proportionally
        const fillerNeeded = Math.max(0, totalItems - approvedMandatory);
        let distEasy = countMap.Easy;
        let distAverage = countMap.Average;
        let distDifficult = countMap.Difficult;

        if (fillerNeeded > 0) {
            // Distribute filler evenly; remainder goes to Easy
            const baseF = Math.floor(fillerNeeded / 3);
            const remainderF = fillerNeeded % 3;
            distEasy += baseF + remainderF;
            distAverage += baseF;
            distDifficult += baseF;
        }

        // ── 3. Resolve per-item time_limit ────────────────────────────────────
        // For PerItem timer, grab the median/most-common time_limit from the
        // assessment's question pool.
        let perItemSeconds = 30; // safe default
        if (row.timer_type === 'PerItem') {
            const [[tlRow]] = await db.execute(`
                SELECT qb.time_limit
                FROM assessment_questions aq
                JOIN question_bank qb ON qb.question_id = aq.question_id
                WHERE aq.assessment_id = ?
                  AND qb.verification_status = 'Approved'
                  AND qb.time_limit IS NOT NULL
                ORDER BY qb.time_limit ASC
                LIMIT 1
            `, [assessmentId]);
            if (tlRow) perItemSeconds = parseInt(tlRow.time_limit, 10) || 30;
        }

        // ── 4. Render ─────────────────────────────────────────────────────────
        return res.render('arcade/guidelines', {
            token,
            user: {
                user_id: row.user_id,
                first_name: row.first_name || '',
                last_name: row.last_name || '',
                profile_pic: row.profile_pic || 'default_avatar.png',
                qr_code_token: row.qr_code_token,
            },
            assessment: {
                assessment_name: row.assessment_name,
                assessment_type: row.assessment_type,
                timer_type: row.timer_type || 'Global',
                duration_minutes: row.duration_minutes || 30,
                time_limit: perItemSeconds,        // per-item seconds (PerItem only)
            },
            total: displayTotal,
            dist: {
                easy: distEasy,
                average: distAverage,
                difficult: distDifficult,
            },
        });

    } catch (err) {
        console.error('[GUIDELINES] Error:', err.message, err.stack);
        return res.redirect('/arcade/standby');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ██████╗  █████╗ ███╗   ███╗███████╗
// ██╔════╝ ██╔══██╗████╗ ████║██╔════╝
// ██║  ███╗███████║██╔████╔██║█████╗
// ██║   ██║██╔══██║██║╚██╔╝██║██╔══╝
// ╚██████╔╝██║  ██║██║ ╚═╝ ██║███████╗
//  ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝
// ARCADE GAME ROUTER — v2.1 — game_proper.ejs compatible
// Fixes from v2.0:
//   FIX 1: subject_id now included in ASSESSMENT JSON passed to EJS
//           (was silently dropped → leaderboard_history never written)
//   FIX 2: surpassedCount now computed and returned by /arcade/submit-results
//           (EJS reads result.surpassedCount on the final screen)
//   FIX 3: submit-duel savePlayer() now correctly writes total_possible_score
//           (was omitted → column left at DEFAULT 0 for every duel submission)
// ═══════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// GET /arcade/game/:token
// Main entry point. Resolves token → user → flagged assessment → questions.
//
// EJS variables rendered to game_proper.ejs:
//   user              : { user_id, first_name, last_name, profile_pic,
//                         current_level, total_exp }
//   assessment        : { assessment_id, assessment_name, assessment_type,
//                         timer_type, duration_minutes, total_items,
//                         sound_bg, sound_correct, sound_wrong,
//                         sound_result_pass, sound_result_fail,
//                         speech_enabled, subject_id }
//   questions         : processed array — each item has theme_id, topic_name
//   totalPossibleScore: integer
//   token             : QR token string
//   assessmentId      : integer
//   buttonMappings    : array of { button_pin, element_symbol, player_side }
//   resumeIndex       : integer (0 = fresh, N = resume from N-th question)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/arcade/game/:token', async (req, res) => {
    const token = req.params.token;

    try {
        // ── 1. Resolve token → student + flagged assessment + topic chain ─────
        const [[userRow]] = await db.execute(`
            SELECT
                u.user_id,        u.first_name,     u.last_name,
                u.profile_pic,    u.current_level,  u.total_exp,
                u.flagged_assessment_id,

                a.assessment_id,       a.assessment_name,    a.assessment_type,
                a.timer_type,          a.duration_minutes,   a.total_items,
                a.topic_id,            a.quarter_id,         a.is_unlocked,
                a.sound_bg,            a.sound_correct,      a.sound_wrong,
                a.sound_result_pass,   a.sound_result_fail,  a.speech_enabled,

                t.topic_name,    t.theme_id,
                q.subject_id

            FROM users u
            LEFT JOIN assessments a  ON a.assessment_id = u.flagged_assessment_id
            LEFT JOIN topics      t  ON t.topic_id      = a.topic_id
            LEFT JOIN quarters    q  ON q.quarter_id    = a.quarter_id
            WHERE u.qr_code_token = ?
        `, [token]);

        if (!userRow) {
            console.warn('[GAME_PROPER] Token not found:', token);
            return res.redirect('/arcade/standby');
        }

        if (!userRow.flagged_assessment_id) {
            console.warn('[GAME_PROPER] No flagged assessment for user:', userRow.user_id);
            return res.redirect('/arcade/standby');
        }

        if (!userRow.is_unlocked) {
            console.warn('[GAME_PROPER] Assessment is locked:', userRow.assessment_id);
            return res.redirect('/arcade/standby?error=locked');
        }

        const assessmentId = userRow.flagged_assessment_id;
        const topicId = userRow.topic_id;
        const themeId = userRow.theme_id || 'default_lab';
        const topicName = userRow.topic_name || '';
        const subjectId = userRow.subject_id || null;

        // ── 2. Check for existing ongoing session (resume support) ────────────
        const [[existingSession]] = await db.execute(`
            SELECT session_id, current_item_index, accumulated_score
            FROM active_sessions
            WHERE student_id    = ?
              AND assessment_id  = ?
              AND session_status = 'Ongoing'
            LIMIT 1
        `, [userRow.user_id, assessmentId]);

        // ── 3. Fetch APPROVED mandatory questions from assessment_questions ────
        const [mandatoryRows] = await db.execute(`
            SELECT
                aq.aq_id,            aq.sort_order,        aq.selected_bg_key,
                qb.question_id,      qb.question_text,     qb.instruction_override,
                qb.media_path,       qb.media_type,
                qb.difficulty,       qb.input_mode,        qb.mechanic_type,
                qb.base_exp,         qb.points,            qb.time_limit,
                qb.is_multiple_answer, qb.required_answers_count,
                qb.option_a,         qb.option_a_image,
                qb.option_b,         qb.option_b_image,
                qb.option_c,         qb.option_c_image,
                qb.option_d,         qb.option_d_image,
                qb.correct_answer,
                qb.numeric_answer,   qb.numeric_tolerance
            FROM assessment_questions aq
            JOIN question_bank qb ON aq.question_id = qb.question_id
            WHERE aq.assessment_id      = ?
              AND qb.verification_status = 'Approved'
            ORDER BY aq.sort_order ASC
        `, [assessmentId]);

        // ── 4. Fetch answer_sequences for mandatory questions ─────────────────
        const mandatoryWithSeqs = await Promise.all(mandatoryRows.map(async (q) => {
            const [seqRows] = await db.execute(`
                SELECT element_symbol, subscript, sort_order
                FROM answer_sequences
                WHERE question_id = ?
                ORDER BY sort_order ASC
            `, [q.question_id]);
            return { ...q, answer_sequences: seqRows, theme_id: themeId, topic_name: topicName };
        }));

        // ── 5. Compute how many filler questions are needed ───────────────────
        const mandatoryCount = mandatoryWithSeqs.length;
        const totalItems = userRow.total_items || mandatoryCount;
        const fillerNeeded = Math.max(0, totalItems - mandatoryCount);
        const mandatoryIds = mandatoryWithSeqs.map(q => q.question_id);

        // ── 6. Pull APPROVED random filler questions from the same topic ──────
        let fillerQuestions = [];
        if (fillerNeeded > 0 && topicId) {
            let fillerQuery;
            let fillerParams;

            if (mandatoryIds.length > 0) {
                const excludePlaceholders = mandatoryIds.map(() => '?').join(',');
                fillerQuery = `
                    SELECT
                        qb.question_id,      qb.question_text,     qb.instruction_override,
                        qb.media_path,       qb.media_type,
                        qb.difficulty,       qb.input_mode,        qb.mechanic_type,
                        qb.base_exp,         qb.points,            qb.time_limit,
                        qb.is_multiple_answer, qb.required_answers_count,
                        qb.option_a,         qb.option_a_image,
                        qb.option_b,         qb.option_b_image,
                        qb.option_c,         qb.option_c_image,
                        qb.option_d,         qb.option_d_image,
                        qb.correct_answer,
                        qb.numeric_answer,   qb.numeric_tolerance,
                        NULL AS aq_id, NULL AS sort_order, NULL AS selected_bg_key
                    FROM question_bank qb
                    WHERE qb.topic_id             = ?
                      AND qb.verification_status   = 'Approved'
                      AND qb.question_id NOT IN (${excludePlaceholders})
                    ORDER BY RAND()
                    LIMIT ?`;
                fillerParams = [topicId, ...mandatoryIds, fillerNeeded];
            } else {
                fillerQuery = `
                    SELECT
                        qb.question_id,      qb.question_text,     qb.instruction_override,
                        qb.media_path,       qb.media_type,
                        qb.difficulty,       qb.input_mode,        qb.mechanic_type,
                        qb.base_exp,         qb.points,            qb.time_limit,
                        qb.is_multiple_answer, qb.required_answers_count,
                        qb.option_a,         qb.option_a_image,
                        qb.option_b,         qb.option_b_image,
                        qb.option_c,         qb.option_c_image,
                        qb.option_d,         qb.option_d_image,
                        qb.correct_answer,
                        qb.numeric_answer,   qb.numeric_tolerance,
                        NULL AS aq_id, NULL AS sort_order, NULL AS selected_bg_key
                    FROM question_bank qb
                    WHERE qb.topic_id           = ?
                      AND qb.verification_status = 'Approved'
                    ORDER BY RAND()
                    LIMIT ?`;
                fillerParams = [topicId, fillerNeeded];
            }

            const [fillerRows] = await db.execute(fillerQuery, fillerParams);

            fillerQuestions = await Promise.all(fillerRows.map(async (q) => {
                const [seqRows] = await db.execute(`
                    SELECT element_symbol, subscript, sort_order
                    FROM answer_sequences
                    WHERE question_id = ?
                    ORDER BY sort_order ASC
                `, [q.question_id]);
                return { ...q, answer_sequences: seqRows, theme_id: themeId, topic_name: topicName };
            }));
        }

        // ── 7. Combine mandatory + filler → Fisher-Yates shuffle ─────────────
        const combinedPool = [...mandatoryWithSeqs, ...fillerQuestions];

        for (let i = combinedPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [combinedPool[i], combinedPool[j]] = [combinedPool[j], combinedPool[i]];
        }

        if (combinedPool.length === 0) {
            console.warn('[GAME_PROPER] No approved questions found for assessment:', assessmentId);
            return res.redirect('/arcade/standby?error=no_questions');
        }

        // ── 8. Process each question — build target_answer + sanitize ─────────
        const processedQuestions = combinedPool.map(q => {
            let target_answer = '';

            if (q.input_mode === 'Standard') {
                const normalize = {
                    '1': 'A', '2': 'B', '3': 'C', '4': 'D',
                    a: 'A', b: 'B', c: 'C', d: 'D',
                    A: 'A', B: 'B', C: 'C', D: 'D',
                };
                target_answer = normalize[q.correct_answer] || q.correct_answer || 'A';

            } else if (q.input_mode === 'Numeric') {
                target_answer = q.numeric_answer !== null && q.numeric_answer !== undefined
                    ? String(q.numeric_answer) : '0';

            } else if (q.input_mode === 'Periodic_Single') {
                target_answer = q.answer_sequences[0]?.element_symbol?.toUpperCase() || '';

            } else if (q.input_mode === 'Periodic_Sequence') {
                target_answer = q.answer_sequences
                    .map(s => s.element_symbol.toUpperCase())
                    .join(',');
            }

            return {
                question_id: q.question_id,
                question_text: q.question_text || '',
                instruction_override: q.instruction_override || null,
                media_path: q.media_path || null,
                media_type: q.media_type || null,
                difficulty: q.difficulty || 'Easy',
                input_mode: q.input_mode || 'Standard',
                mechanic_type: q.mechanic_type || 'standard_mcq',
                base_exp: parseInt(q.base_exp, 10) || 100,
                points: parseInt(q.points, 10) || 1,
                time_limit: parseInt(q.time_limit, 10) || 30,
                is_multiple_answer: q.is_multiple_answer ? 1 : 0,
                required_answers_count: parseInt(q.required_answers_count, 10) || 1,
                option_a: q.option_a || null,
                option_a_image: q.option_a_image || null,
                option_b: q.option_b || null,
                option_b_image: q.option_b_image || null,
                option_c: q.option_c || null,
                option_c_image: q.option_c_image || null,
                option_d: q.option_d || null,
                option_d_image: q.option_d_image || null,
                correct_answer: q.correct_answer || null,
                numeric_answer: q.numeric_answer !== undefined ? q.numeric_answer : null,
                numeric_tolerance: parseFloat(q.numeric_tolerance) || 0,
                selected_bg_key: q.selected_bg_key || null,
                answer_sequences: q.answer_sequences || [],
                theme_id: q.theme_id || 'default_lab',
                topic_name: q.topic_name || '',
                target_answer,
            };
        });

        // ── 9. Compute total_possible_score ───────────────────────────────────
        const totalPossibleScore = processedQuestions.reduce(
            (sum, q) => sum + (q.points || 1), 0
        );

        // ── 10. Upsert active_sessions ────────────────────────────────────────
        // Clear any stale 'Ongoing' sessions from OTHER students before starting.
        // Without this, /api/check-answer picks the wrong student_id from the DB.
        await db.execute(`
            UPDATE active_sessions
            SET session_status = 'Completed'
            WHERE session_status = 'Ongoing'
            AND student_id != ?
        `, [userRow.user_id]);

        if (!existingSession) {
            await db.execute(`
                INSERT INTO active_sessions
                    (student_id, assessment_id, player_mode, session_status,
                     current_item_index, accumulated_score)
                VALUES (?, ?, 'Single', 'Ongoing', 1, 0)
                ON DUPLICATE KEY UPDATE
                    assessment_id      = VALUES(assessment_id),
                    session_status     = 'Ongoing',
                    current_item_index = 1,
                    accumulated_score  = 0,
                    start_time         = NOW()
            `, [userRow.user_id, assessmentId]);
        }

        // ── 11. Fetch button mappings for hardware controller ─────────────────
        const [buttonMappings] = await db.execute(`
            SELECT button_pin, element_symbol, player_side
            FROM button_mappings
            WHERE player_side = 1
        `);

        // ── 12. Render game_proper ────────────────────────────────────────────
        return res.render('arcade/game_proper', {
            assessmentId,
            user: {
                user_id: userRow.user_id,
                first_name: userRow.first_name,
                last_name: userRow.last_name || '',
                profile_pic: userRow.profile_pic || 'default_avatar.png',
                current_level: userRow.current_level || 1,
                total_exp: userRow.total_exp || 0,
            },
            assessment: {
                assessment_id: assessmentId,
                assessment_name: userRow.assessment_name,
                assessment_type: userRow.assessment_type,
                timer_type: userRow.timer_type || 'Global',
                duration_minutes: userRow.duration_minutes || 30,
                total_items: totalItems,
                sound_bg: userRow.sound_bg || '',
                sound_correct: userRow.sound_correct || '',
                sound_wrong: userRow.sound_wrong || '',
                sound_result_pass: userRow.sound_result_pass || '',
                sound_result_fail: userRow.sound_result_fail || '',
                speech_enabled: userRow.speech_enabled || 0,
                // ── FIX 1: subject_id must be in the assessment object so the
                //    EJS serializes it into ASSESSMENT.subject_id on line 1189.
                //    Without this, ASSESSMENT.subject_id is always undefined →
                //    submit-results receives subjectId=null → leaderboard never written.
                subject_id: subjectId,
            },
            questions: processedQuestions,
            totalPossibleScore,
            token,
            buttonMappings: buttonMappings || [],
            resumeIndex: existingSession
                ? (existingSession.current_item_index - 1)
                : 0,
        });

    } catch (err) {
        console.error('[GAME_PROPER] CRITICAL ERROR:', err.message, err.stack);
        return res.redirect('/arcade/standby');
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /arcade/game/update-session
// Called after each question answer to keep active_sessions in sync.
//
// Body: { studentId, assessmentId, currentItemIndex, accumulatedScore }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/arcade/game/update-session', async (req, res) => {
    const { studentId, assessmentId, currentItemIndex, accumulatedScore } = req.body;

    if (!studentId || !assessmentId) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
        await db.execute(`
            UPDATE active_sessions
            SET current_item_index = ?,
                accumulated_score  = ?
            WHERE student_id    = ?
              AND assessment_id  = ?
              AND session_status = 'Ongoing'
        `, [
            parseInt(currentItemIndex, 10) || 1,
            parseInt(accumulatedScore, 10) || 0,
            parseInt(studentId, 10),
            parseInt(assessmentId, 10),
        ]);

        return res.json({ success: true });

    } catch (err) {
        console.error('[GAME_PROPER] update-session error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /arcade/submit-results
// Saves score + responses, fires EXP trigger, recomputes level, upserts
// leaderboard_history, and computes surpassedCount for the final screen.
//
// Body (JSON): {
//   userId, assessmentId, subjectId,
//   scoreObtained, totalPossibleScore, totalItems,
//   expGained, responses[]
// }
// Returns: { success, scoreId, finalScore, totalPossible,
//            totalExpGained, newTotalExp, newLevel, surpassedCount }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/arcade/submit-results', async (req, res) => {
    const {
        userId, assessmentId, subjectId,
        scoreObtained, totalPossibleScore, totalItems,
        expGained, responses,
    } = req.body;

    if (userId === undefined || assessmentId === undefined || scoreObtained === undefined) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const cleanUserId = parseInt(userId, 10);
    const cleanAsmId = parseInt(assessmentId, 10);
    const cleanSubjId = parseInt(subjectId, 10) || null;
    const cleanScore = parseInt(scoreObtained, 10) || 0;
    const cleanPossible = parseInt(totalPossibleScore, 10) || 0;
    const cleanTotal = parseInt(totalItems, 10) || 0;
    const cleanExp = parseInt(expGained, 10) || 0;

    if (isNaN(cleanUserId) || isNaN(cleanAsmId)) {
        return res.status(400).json({ success: false, message: 'Invalid userId or assessmentId.' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // ── 1. Validate user ──────────────────────────────────────────────────
        const [[user]] = await connection.execute(
            `SELECT user_id, total_exp, current_level FROM users WHERE user_id = ?`,
            [cleanUserId]
        );
        if (!user) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // ── 2. Validate assessment ────────────────────────────────────────────
        const [[asm]] = await connection.execute(
            `SELECT assessment_id, total_items FROM assessments WHERE assessment_id = ?`,
            [cleanAsmId]
        );
        if (!asm) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Assessment not found.' });
        }

        // ── 3. Insert student_scores ──────────────────────────────────────────
        // DB trigger `update_total_exp` fires AFTER INSERT and auto-increments
        // users.total_exp by exp_gained.
        const [insertResult] = await connection.execute(`
            INSERT INTO student_scores
                (student_id, assessment_id, score_obtained, total_possible_score,
                 total_items, exp_gained, date_recorded)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [cleanUserId, cleanAsmId, cleanScore, cleanPossible, cleanTotal, cleanExp]);

        const newScoreId = insertResult.insertId;

        // ── 4. Insert student_responses (deduplicated by questionId) ──────────
        if (responses && Array.isArray(responses) && responses.length > 0) {
            const seen = new Map();
            responses.forEach(r => {
                if (r && r.questionId) seen.set(parseInt(r.questionId, 10), r);
            });
            const uniqueResponses = Array.from(seen.values());

            const responseRows = uniqueResponses.map(r => [
                1,
                newScoreId,
                parseInt(r.questionId, 10) || 0,
                String(r.selected || 'timeout').substring(0, 255),
                r.isCorrect ? 1 : 0,
                parseInt(r.timeTaken || 0, 10),
            ]);

            await connection.query(`
                INSERT INTO student_responses
                    (player_number, score_id, question_id, selected_option,
                     is_correct, response_time_ms)
                VALUES ?
            `, [responseRows]);
        }

        // ── 5. Mark active_session as Finished ───────────────────────────────
        await connection.execute(`
            UPDATE active_sessions
            SET session_status    = 'Finished',
                accumulated_score = ?
            WHERE student_id   = ?
              AND assessment_id = ?
        `, [cleanScore, cleanUserId, cleanAsmId]);

        // ── 5b. Recalculate progress for this subject ─────────────────────────
        if (cleanSubjId) {
            await recalculateProgress(cleanUserId, cleanSubjId);
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── 6. Recompute current_level via levelProgressionService ────────────
        let newLevel = 1;
        let newTotalExp = 0;
        try {
            const levelStats = await levelProgressionService.recalculateStudentLevel(cleanUserId, connection);
            newLevel = levelStats.current_level;
            newTotalExp = levelStats.total_exp;
        } catch (lvlErr) {
            console.warn('[submit-assessment:LevelRecalcError]', lvlErr.message);
            const [[uRow]] = await connection.execute(
                `SELECT total_exp, current_level FROM users WHERE user_id = ?`,
                [cleanUserId]
            );
            newTotalExp = uRow ? uRow.total_exp : 0;
            newLevel = uRow ? uRow.current_level : 1;
        }

        await connection.execute(`
            UPDATE users
            SET is_ready_for_arcade   = 0,
                flagged_assessment_id = NULL
            WHERE user_id = ?
        `, [cleanUserId]);

        // ── 7. Upsert leaderboard_history ─────────────────────────────────────
        // FIX 1 enables this block to actually execute (subject_id now arrives non-null).
        let surpassedCount = 0;

        if (cleanSubjId) {
            const [[todayRecord]] = await connection.execute(`
                SELECT history_id
                FROM leaderboard_history
                WHERE student_id = ?
                  AND subject_id = ?
                  AND DATE(awarded_date) = CURDATE()
                LIMIT 1
            `, [cleanUserId, cleanSubjId]);

            if (todayRecord) {
                await connection.execute(`
                    UPDATE leaderboard_history
                    SET total_exp_snapshot = ?
                    WHERE history_id = ?
                `, [newTotalExp, todayRecord.history_id]);
            } else {
                await connection.execute(`
                    INSERT INTO leaderboard_history
                        (student_id, subject_id, rank_achieved, total_exp_snapshot, awarded_date)
                    VALUES (?, ?, 0, ?, NOW())
                `, [cleanUserId, cleanSubjId, newTotalExp]);
            }

            // Recompute ranks for ALL students in this subject today
            const [todayRanks] = await connection.execute(`
                SELECT history_id,
                       RANK() OVER (ORDER BY total_exp_snapshot DESC) AS computed_rank
                FROM leaderboard_history
                WHERE subject_id         = ?
                  AND DATE(awarded_date) = CURDATE()
            `, [cleanSubjId]);

            for (const row of todayRanks) {
                await connection.execute(`
                    UPDATE leaderboard_history
                    SET rank_achieved = ?
                    WHERE history_id  = ?
                `, [row.computed_rank, row.history_id]);
            }

            // ── FIX 2: Compute surpassedCount ─────────────────────────────────
            // Count how many OTHER students in this subject today have a lower
            // total_exp_snapshot than this student's new snapshot.
            // The EJS final screen reads: result.surpassedCount || 0
            const [[surpassRow]] = await connection.execute(`
                SELECT COUNT(*) AS cnt
                FROM leaderboard_history
                WHERE subject_id          = ?
                  AND DATE(awarded_date)  = CURDATE()
                  AND student_id         != ?
                  AND total_exp_snapshot  < ?
            `, [cleanSubjId, cleanUserId, newTotalExp]);

            surpassedCount = surpassRow ? (surpassRow.cnt || 0) : 0;
        }

        await connection.commit();

        // T-06: Notify Teacher of Arcade Assessment Completion
        try {
            const [[studentUser]] = await db.query(
                `SELECT first_name, last_name FROM users WHERE user_id = ?`,
                [cleanUserId]
            );
            const studentName = studentUser ? `${studentUser.first_name} ${studentUser.last_name}`.trim() : 'A student';
            const [clsRows] = await db.query(
                `SELECT DISTINCT a.assessment_name, a.total_items, c.teacher_id, c.class_id
                 FROM assessments a
                 JOIN topics t ON a.topic_id = t.topic_id
                 JOIN quarters q ON t.quarter_id = q.quarter_id
                 JOIN classes c ON q.subject_id = c.subject_id
                 JOIN class_students cs ON cs.class_id = c.class_id
                 WHERE a.assessment_id = ? AND cs.student_id = ? AND c.teacher_id IS NOT NULL`,
                [cleanAsmId, cleanUserId]
            );
            for (const cRow of clsRows) {
                await notificationService.dispatch({
                    recipientIds: cRow.teacher_id,
                    actorId: cleanUserId,
                    role: 'Teacher',
                    category: 'assessment',
                    priority: 'normal',
                    eventType: 'arcade_assessment_completed',
                    title: `Assessment Completed: ${cRow.assessment_name}`,
                    message: `${studentName} completed '${cRow.assessment_name}' with a score of ${cleanScore}/${cleanTotal || cRow.total_items || 10}.`,
                    targetUrl: `/teacher/analysis/${newScoreId}`,
                    metadata: { scoreId: newScoreId, assessmentId: cleanAsmId, studentId: cleanUserId }
                });
            }
        } catch (notifErr) {
            console.error('[GAME_PROPER Teacher Notification Error]', notifErr.message);
        }

        return res.json({
            success: true,
            scoreId: newScoreId,
            finalScore: cleanScore,
            totalPossible: cleanPossible,
            totalExpGained: cleanExp,
            newTotalExp,
            newLevel,
            // ── FIX 2: now returned so the EJS final screen can display it ──
            surpassedCount,
        });

    } catch (err) {
        try { await connection.rollback(); } catch (_) { }
        console.error('[GAME_PROPER] submit-results error:', err.message, err.stack);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        connection.release();
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/check-answer
// ESP32 hardware endpoint.
// Receives button_pin → looks up element_symbol in button_mappings →
// emits esp32-press only to the matching student's browser socket.
//
// Body: { button_pin }
// Returns: { success, symbol, player }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/check-answer', async (req, res) => {
    const { button_pin } = req.body;
    const io = req.app.get('socketio');

    if (button_pin === undefined) {
        return res.status(400).json({ success: false, message: 'No button_pin provided' });
    }

    try {
        // ── 1. Resolve pin → element symbol + player side ─────────────────────
        const [rows] = await db.query(
            'SELECT element_symbol, player_side FROM button_mappings WHERE button_pin = ?',
            [button_pin]
        );

        if (rows.length === 0) {
            console.warn(`[ESP32] No mapping for pin ${button_pin}`);
            return res.status(404).json({ success: false, message: 'Pin mapping not found' });
        }

        const { element_symbol, player_side } = rows[0];
        console.log(`[ESP32] Pin:${button_pin} → Symbol:${element_symbol} | Player:${player_side}`);

        // ── 2. Find the active Ongoing student session ────────────────────────
        const [sessions] = await db.query(
            `SELECT student_id FROM active_sessions WHERE session_status = 'Ongoing' LIMIT 1`
        );

        // ── 3. Targeted socket emit — only this student's browser ─────────────
        if (sessions.length > 0 && io) {
            const targetStudentId = sessions[0].student_id;
            const activeSockets = req.app.get('activeSockets');
            const targetSocketId = activeSockets ? activeSockets[targetStudentId] : null;

            if (targetSocketId) {
                io.to(targetSocketId).emit('esp32-press', {
                    symbol: element_symbol,
                    player: player_side,
                });
                console.log(`[Socket] → student ${targetStudentId} (socket ${targetSocketId})`);
            } else {
                console.warn(`[Socket] Student ${targetStudentId} has no active socket`);
            }
        } else if (!io) {
            console.error('[Socket] Socket.io instance missing from app.');
            return res.status(500).json({ success: false, message: 'Socket server error' });
        }

        return res.json({ success: true, symbol: element_symbol, player: player_side });

    } catch (err) {
        console.error('[ESP32] DB error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /arcade/submit-duel
// Competitive (Duel) mode — both players submitted together.
// Winner determined server-side by score comparison.
//
// Body (JSON): {
//   p1: { userId, score, expGained, totalItems, totalPossibleScore, responses[] },
//   p2: { userId, score, expGained, totalItems, totalPossibleScore, responses[] },
//   assessmentId
// }
// Returns: { success, winnerId, p1Result, p2Result }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/arcade/submit-duel', async (req, res) => {
    const { p1, p2, assessmentId } = req.body;

    if (!p1 || !p2 || !assessmentId) {
        return res.status(400).json({ success: false, message: 'Missing p1, p2, or assessmentId.' });
    }

    const cleanAsmId = parseInt(assessmentId, 10);
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // ── Helper: save one player's scores + responses, update their level ──
        const savePlayer = async (playerData, playerNumber) => {
            const userId = parseInt(playerData.userId, 10);
            const score = parseInt(playerData.score, 10) || 0;
            const expGained = parseInt(playerData.expGained || 0, 10);

            // ── FIX 3: capture total_possible_score from playerData ───────────
            // Previously omitted — the column has NOT NULL DEFAULT 0, so duel
            // submissions always silently stored 0 instead of the real value.
            const totalPossible = parseInt(playerData.totalPossibleScore || 0, 10);

            const [[user]] = await connection.execute(
                `SELECT user_id, total_exp, current_level FROM users WHERE user_id = ?`,
                [userId]
            );
            if (!user) throw new Error(`Player ${playerNumber} (id=${userId}) not found.`);

            // Insert score row (DB trigger increments total_exp automatically)
            const [ins] = await connection.execute(`
                INSERT INTO student_scores
                    (student_id, assessment_id, score_obtained, total_possible_score,
                     total_items, exp_gained, date_recorded)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `, [userId, cleanAsmId, score, totalPossible, playerData.totalItems || 15, expGained]);
            //                              ^^^^^^^^^^^^^ FIX 3: was missing entirely

            const scoreId = ins.insertId;

            // Insert responses
            if (playerData.responses && Array.isArray(playerData.responses) && playerData.responses.length) {
                const rows = playerData.responses.map(r => [
                    playerNumber,
                    scoreId,
                    parseInt(r.questionId, 10) || 0,
                    String(r.selected || '').substring(0, 255),
                    r.isCorrect ? 1 : 0,
                    parseInt(r.timeTaken || 0, 10),
                ]);
                await connection.query(`
                    INSERT INTO student_responses
                        (player_number, score_id, question_id, selected_option, is_correct, response_time_ms)
                    VALUES ?
                `, [rows]);
            }

            // Recalculate level dynamically based on Total Max EXP
            let newLevel = 1;
            try {
                const levelStats = await levelProgressionService.recalculateStudentLevel(userId, connection);
                newLevel = levelStats.current_level;
            } catch (lvlErr) {
                console.warn('[savePlayer:LevelRecalcError]', lvlErr.message);
                const [[uRow]] = await connection.execute(
                    `SELECT current_level FROM users WHERE user_id = ?`, [userId]
                );
                newLevel = uRow ? uRow.current_level : 1;
            }

            await connection.execute(`
                UPDATE users
                SET is_ready_for_arcade = 0, flagged_assessment_id = NULL
                WHERE user_id = ?
            `, [userId]);

            return { userId, score, expGained, newLevel };
        };

        const p1Result = await savePlayer(p1, 1);
        const p2Result = await savePlayer(p2, 2);

        // ── Determine winner (null = draw) ────────────────────────────────────
        let winnerId = null;
        if (p1Result.score > p2Result.score) winnerId = p1Result.userId;
        else if (p2Result.score > p1Result.score) winnerId = p2Result.userId;

        // ── Record competitive match ──────────────────────────────────────────
        await connection.execute(`
            INSERT INTO competitive_matches
                (p1_id, p2_id, p1_score, p2_score, winner_id, assessment_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [p1Result.userId, p2Result.userId, p1Result.score, p2Result.score, winnerId, cleanAsmId]);

        await connection.commit();

        // T-07: Notify Teacher of Competitive Duel Completion
        try {
            const [uRows] = await db.query(
                `SELECT user_id, first_name, last_name FROM users WHERE user_id IN (?, ?)`,
                [p1Result.userId, p2Result.userId]
            );
            const p1User = uRows.find(u => u.user_id === p1Result.userId);
            const p2User = uRows.find(u => u.user_id === p2Result.userId);
            const p1Name = p1User ? `${p1User.first_name} ${p1User.last_name}`.trim() : 'Player 1';
            const p2Name = p2User ? `${p2User.first_name} ${p2User.last_name}`.trim() : 'Player 2';
            const [clsRows] = await db.query(
                `SELECT DISTINCT a.assessment_name, c.teacher_id, c.class_id
                 FROM assessments a
                 JOIN topics t ON a.topic_id = t.topic_id
                 JOIN quarters q ON t.quarter_id = q.quarter_id
                 JOIN classes c ON q.subject_id = c.subject_id
                 JOIN class_students cs ON cs.class_id = c.class_id
                 WHERE a.assessment_id = ? AND cs.student_id IN (?, ?) AND c.teacher_id IS NOT NULL`,
                [cleanAsmId, p1Result.userId, p2Result.userId]
            );
            for (const cRow of clsRows) {
                await notificationService.dispatch({
                    recipientIds: cRow.teacher_id,
                    actorId: p1Result.userId,
                    role: 'Teacher',
                    category: 'assessment',
                    priority: 'normal',
                    eventType: 'competitive_duel_completed',
                    title: `Competitive Duel Finished: ${cRow.assessment_name}`,
                    message: `${p1Name} (${p1Result.score} pts) vs. ${p2Name} (${p2Result.score} pts) completed '${cRow.assessment_name}'.`,
                    targetUrl: `/teacher/class/${cRow.class_id}?tab=analytics`,
                    metadata: { assessmentId: cleanAsmId, p1Id: p1Result.userId, p2Id: p2Result.userId }
                });
            }
        } catch (duelNotifErr) {
            console.error('[DUEL Teacher Notification Error]', duelNotifErr.message);
        }

        return res.json({ success: true, winnerId, p1Result, p2Result });

    } catch (err) {
        try { await connection.rollback(); } catch (_) { }
        console.error('[DUEL] submit-duel error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        if (connection) connection.release();
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /arcade/standby
// Rendered when there is no active session or token is invalid.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/arcade/standby', (req, res) => {
    res.render('arcade/standby');
});

router.get('/test-game', (req, res) => {
    const mockQuestions = [
        {
            question_text: "What is the chemical symbol for Water?",
            input_mode: "Periodic",
            answers: "H,H,O",
            required_answers_count: 3,
            base_exp: 150,
            time_limit: 15
        },
        {
            question_text: "Which of these is a Noble Gas?",
            input_mode: "Standard",
            option_a: "Oxygen",
            option_b: "Neon",
            option_c: "Iron",
            option_d: "Silver",
            answers: "B",
            base_exp: 100,
            time_limit: 10
        }
    ];
    res.render('arcade/game', { questions: mockQuestions, user: { user_id: 1 } });
});


module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// MATERIAL AI DATA API
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/material/:materialId/ai-data', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const [[mat]] = await db.query(`
            SELECT material_id, title, ai_summary, ai_flashcards, ai_status
            FROM learning_materials WHERE material_id = ?
        `, [req.params.materialId]);

        if (!mat) return res.status(404).json({ error: 'Material not found' });
        res.json(mat);
    } catch (err) {
        console.error('[GET AI DATA API]', err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARCADE ASSESSMENT TICKET GENERATOR API
// ─────────────────────────────────────────────────────────────────────────────
router.post('/student/api/assessment-ticket/generate', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const studentId = req.user.user_id;
    const { assessment_id, play_mode = 'Solo', player_slot = 1 } = req.body;

    if (!assessment_id) {
        return res.status(400).json({ success: false, error: 'assessment_id is required' });
    }

    try {
        const [[assessment]] = await db.query(`
            SELECT a.*, 
                   t.topic_name, 
                   t.is_locked AS topic_is_locked,
                   COALESCE(
                       (SELECT eq.level_number FROM elementa_assessment_questions eaq JOIN elementa_questions eq ON eaq.question_id = eq.question_id WHERE eaq.assessment_id = a.assessment_id LIMIT 1),
                       (SELECT eq.level_number FROM elementa_questions eq WHERE eq.topic_id = a.topic_id LIMIT 1),
                       1
                   ) AS level_number
            FROM assessments a
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            WHERE a.assessment_id = ?
        `, [assessment_id]);

        if (!assessment) {
            return res.status(404).json({ success: false, error: 'Assessment not found' });
        }

        if (assessment.topic_is_locked === 1 || assessment.is_unlocked === 0) {
            return res.status(403).json({ success: false, error: 'Assessment is currently locked.' });
        }

        const now = new Date();
        if (assessment.start_date && new Date(assessment.start_date) > now) {
            return res.status(403).json({ success: false, error: 'Assessment has not started yet.' });
        }
        if (assessment.due_date && new Date(assessment.due_date) < now) {
            const graceActive = assessment.allow_grace && assessment.grace_period_minutes && (new Date(assessment.due_date).getTime() + assessment.grace_period_minutes * 60000 > now.getTime());
            if (!graceActive) {
                return res.status(403).json({ success: false, error: 'Assessment deadline has expired.' });
            }
        }

        if (!assessment.allow_resubmission && (assessment.max_attempts || 1) <= 1) {
            const [[alreadyDone]] = await db.query(`
                SELECT 1 FROM (
                    SELECT assessment_id FROM student_scores WHERE student_id = ? AND assessment_id = ?
                    UNION
                    SELECT assessment_id FROM elementa_game_sessions 
                    WHERE (student_id_p1 = ? OR student_id_p2 = ?) 
                      AND assessment_id = ? 
                      AND (session_status = 'Completed' OR is_synced_to_gradebook = 1)
                    UNION
                    SELECT assessment_id FROM elementa_assessment_tickets 
                    WHERE student_id = ? 
                      AND assessment_id = ? 
                      AND status = 'Consumed'
                ) AS completed_check LIMIT 1
            `, [studentId, assessment_id, studentId, studentId, assessment_id, studentId, assessment_id]);

            if (alreadyDone) {
                return res.status(403).json({
                    success: false,
                    error: 'You have already completed this assessment.',
                    is_completed: true,
                    assessment_id: Number(assessment_id)
                });
            }
        }

        const ticketCode = 'ELM-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        const qrToken = crypto.randomBytes(16).toString('hex');
        const qrDataUrl = await qrcode.toDataURL(ticketCode);

        const effPlayMode = (assessment.competitive_enabled == 1 || assessment.assessment_type === 'Competitive' || play_mode === 'Competitive') ? 'Competitive' : 'Solo';

        const [result] = await db.query(`
            INSERT INTO elementa_assessment_tickets 
            (ticket_code, qr_token, student_id, assessment_id, topic_id, level_number, play_mode, player_slot, status, generated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR))
        `, [ticketCode, qrToken, studentId, assessment_id, assessment.topic_id, assessment.level_number || 1, effPlayMode, player_slot]);

        const [[savedTicket]] = await db.query('SELECT expires_at FROM elementa_assessment_tickets WHERE ticket_id = ?', [result.insertId]);

        res.json({
            success: true,
            ticket_code: ticketCode,
            qr_data_url: qrDataUrl,
            expires_at: savedTicket ? savedTicket.expires_at : new Date(Date.now() + 3600000),
            play_mode: effPlayMode,
            competitive_enabled: assessment.competitive_enabled,
            timer_type: assessment.timer_type || 'Global',
            duration_minutes: assessment.duration_minutes || 30
        });

    } catch (err) {
        console.error('[GENERATE TICKET API]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENT DELIVERABLE SUBMISSION API
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/assessment/:asgnId/submit', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Unauthorized' });

    assignmentUpload.single('submission_file')(req, res, async (uploadErr) => {
        if (uploadErr) {
            return res.status(400).json({ success: false, error: uploadErr.message });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Please choose a deliverable file to upload.' });
        }

        const studentId = req.user.user_id;
        const asgnId = req.params.asgnId;

        try {
            const [[asgn]] = await db.query(`
                SELECT a.*, q.subject_id
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE a.assessment_id = ?
            `, [asgnId]);

            if (!asgn) {
                return res.status(404).json({ success: false, error: 'Assignment not found.' });
            }

            const now = new Date();
            let isGracePeriod = 0;
            if (asgn.due_date && new Date(asgn.due_date) < now) {
                if (asgn.allow_grace && asgn.grace_period_minutes && (new Date(asgn.due_date).getTime() + asgn.grace_period_minutes * 60000 > now.getTime())) {
                    isGracePeriod = 1;
                } else {
                    return res.status(403).json({ success: false, error: 'Submission deadline has passed.' });
                }
            }

            // Read file buffer for cryptographic SHA-256 receipt
            const fileBuffer = fs.readFileSync(req.file.path);
            const originalFilename = req.file.originalname;
            const fileSize = req.file.size;
            const filePath = '/material_uploads/' + req.file.filename;

            // Check if existing score entry exists
            const [[existingScore]] = await db.query(
                'SELECT score_id, attempt_number FROM student_scores WHERE student_id = ? AND assessment_id = ?',
                [studentId, asgnId]
            );

            let scoreId = null;
            let attemptNumber = 1;

            if (existingScore) {
                if (!asgn.allow_resubmission && asgn.max_attempts <= 1) {
                    return res.status(403).json({ success: false, error: 'Resubmission is not permitted for this assignment.' });
                }
                scoreId = existingScore.score_id;
                attemptNumber = (existingScore.attempt_number || 1) + 1;

                await db.query(`
                    UPDATE student_scores SET
                        file_path = ?,
                        file_size_bytes = ?,
                        original_filename = ?,
                        submitted_at = NOW(),
                        is_grace_period = ?,
                        attempt_number = ?,
                        submitted_by_user_id = ?
                    WHERE score_id = ?
                `, [filePath, fileSize, originalFilename, isGracePeriod, attemptNumber, studentId, scoreId]);
            } else {
                const [ins] = await db.query(`
                    INSERT INTO student_scores 
                    (student_id, assessment_id, score_obtained, total_possible_score, total_items, submitted_at, is_grace_period, attempt_number, submitted_by_user_id, file_path, file_size_bytes, original_filename)
                    VALUES (?, ?, NULL, ?, ?, NOW(), ?, 1, ?, ?, ?, ?)
                `, [studentId, asgnId, asgn.total_items, asgn.total_items, isGracePeriod, studentId, filePath, fileSize, originalFilename]);
                scoreId = ins.insertId;
            }

            // Generate tamper-proof cryptographic receipt
            const receipt = await receiptGenerator.generateReceipt({
                scoreId,
                studentId,
                assessmentId: asgnId,
                content: fileBuffer,
                originalFilename,
                clientIp: req.ip,
                studentEmail: req.user.email,
                assessmentTitle: asgn.assessment_name
            });

            // Recalculate student progress
            if (asgn.subject_id) {
                await recalculateProgress(studentId, asgn.subject_id);
            }

            // T-01, T-02, T-03, T-04: Dispatch Teacher Assignment Submission Notification
            try {
                const studentName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'A student';
                const [teacherClasses] = await db.query(
                    `SELECT DISTINCT c.teacher_id, c.class_id, c.class_name
                     FROM classes c
                     JOIN class_students cs ON cs.class_id = c.class_id
                     WHERE cs.student_id = ? AND c.subject_id = ? AND c.teacher_id IS NOT NULL`,
                    [studentId, asgn.subject_id]
                );

                let groupName = null;
                if (asgn.is_group_assignment && asgn.group_set_id) {
                    const [grpRows] = await db.query(
                        `SELECT sg.group_name 
                         FROM group_members gm 
                         JOIN student_groups sg ON gm.group_id = sg.group_id 
                         WHERE gm.student_id = ? AND sg.group_set_id = ? 
                         LIMIT 1`,
                        [studentId, asgn.group_set_id]
                    );
                    if (grpRows.length > 0) {
                        groupName = grpRows[0].group_name;
                    }
                }

                const recipients = teacherClasses.length > 0
                    ? teacherClasses.map(tc => ({ ...tc, group_name: groupName }))
                    : (asgn.teacher_id ? [{ teacher_id: asgn.teacher_id, class_id: null, class_name: 'Course', group_name: groupName }] : []);

                for (const r of recipients) {
                    let eventType = 'submission_created';
                    let priority = 'normal';
                    let title = `New Assignment Submission: ${asgn.assessment_name}`;
                    let msg = `${studentName} (${r.class_name}) submitted '${asgn.assessment_name}'.`;

                    if (isGracePeriod === 1) {
                        eventType = 'late_grace_submission';
                        priority = 'high';
                        title = `Grace-Period Submission: ${asgn.assessment_name}`;
                        msg = `${studentName} (${r.class_name}) submitted '${asgn.assessment_name}' during the late grace period.`;
                    } else if (attemptNumber > 1) {
                        eventType = 'submission_resubmitted';
                        priority = 'normal';
                        title = `Assignment Resubmitted (Attempt #${attemptNumber})`;
                        msg = `${studentName} (${r.class_name}) uploaded a revised deliverable (Attempt #${attemptNumber}) for '${asgn.assessment_name}'.`;
                    } else if (r.group_name) {
                        eventType = 'group_submission_created';
                        priority = 'normal';
                        title = `Group Assignment Submitted: ${r.group_name}`;
                        msg = `${studentName} submitted '${asgn.assessment_name}' on behalf of group '${r.group_name}' (${r.class_name}).`;
                    }

                    await notificationService.dispatch({
                        recipientIds: r.teacher_id,
                        actorId: studentId,
                        role: 'Teacher',
                        category: 'assessment',
                        priority,
                        eventType,
                        title,
                        message: msg,
                        targetUrl: `/teacher/grading-workspace/${asgnId}?scoreId=${scoreId}`,
                        metadata: { assessmentId: Number(asgnId), scoreId, attemptNumber, isGracePeriod }
                    });
                }
            } catch (subNotifErr) {
                console.error('[Assignment Submission Teacher Notification Error]', subNotifErr.message);
            }

            res.json({
                success: true,
                message: 'Assignment submitted successfully!',
                receipt: {
                    receipt_id: receipt.receipt_id,
                    sha256_hash: receipt.sha256_hash,
                    server_timestamp: receipt.server_timestamp,
                    original_filename: originalFilename,
                    is_grace_period: !!isGracePeriod
                }
            });

        } catch (err) {
            console.error('[SUBMIT DELIVERABLE API]', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD DELIVERABLE API
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/deliverables/download/:scoreId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('Unauthorized');

    try {
        const [[score]] = await db.query(`
            SELECT ss.*, sr.original_filename AS receipt_filename
            FROM student_scores ss
            LEFT JOIN submission_receipts sr ON ss.score_id = sr.score_id
            WHERE ss.score_id = ?
        `, [req.params.scoreId]);

        if (!score || !score.file_path) {
            return res.status(404).send('Deliverable file not found.');
        }

        // Student can only download their own deliverable unless Teacher or Admin
        if (req.user.role === 'Student' && Number(score.student_id) !== Number(req.user.user_id)) {
            return res.status(403).send('Forbidden: You can only download your own submission.');
        }

        const cleanPath = score.file_path.replace(/^\/?material_uploads\/?/, '');
        const fullDiskPath = path.join(__dirname, '../public/material_uploads', cleanPath);

        if (!fs.existsSync(fullDiskPath)) {
            return res.status(404).send('Physical file missing from server storage.');
        }

        const downloadName = score.original_filename || score.receipt_filename || path.basename(fullDiskPath);
        res.download(fullDiskPath, downloadName);

    } catch (err) {
        console.error('[DOWNLOAD DELIVERABLE]', err);
        res.status(500).send('Error downloading deliverable: ' + err.message);
    }
});
