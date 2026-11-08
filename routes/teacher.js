const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
router.use(ensureAuthenticated);
const db = require('../db');
const academicHelper = require('../utils/academicHelper');

// Universal Teacher School Year Context Middleware
// Automatically resolves the active current school year set by the Admin and attaches it
// to req and res.locals so all teacher views and routes are strictly scoped to the active SY.
router.use(async (req, res, next) => {
    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        req.currentSY = currentSY;
        req.activeSY = currentSY;
        res.locals.currentSY = currentSY;
        res.locals.activeSY = currentSY;
    } catch (err) {
        console.error('[Teacher SY Middleware] Failed to resolve current SY:', err);
    }
    next();
});
const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { dispatchAnnouncementWebhook } = require('../utils/webhookDispatcher');
const notificationService = require('../services/notificationService');
const { logActivity } = require('../utils/logger');
const {
    generateAuditRef,
    drawPdfDocumentHeader,
    attachPdfFooters,
    applyExcelMetadataHeader,
    setExportHttpHeaders
} = require('../utils/reportHeaderHelper');
const arcadeAnalyticsService = require('../services/arcadeAnalyticsService');
const levelProgressionService = require('../services/levelProgressionService');
const forumExpService = require('../services/forumExpService');
const topicScheduleService = require('../services/topicScheduleService');
const { SIMULATIONS_REGISTRY } = require('../services/simulationQuizService');

const simTitleMap = {};
if (Array.isArray(SIMULATIONS_REGISTRY)) {
    SIMULATIONS_REGISTRY.forEach(s => { simTitleMap[s.slug] = s.title; });
}


// MIDDLEWARE: Proteksyon para tanging Guro lang ang makapasok
function isTeacher(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'Teacher' || req.user.role === 'Admin')) {
        return next();
    }
    const isApi = Boolean(
        req.xhr ||
        req.path.startsWith('/api') ||
        req.originalUrl.includes('/api/') ||
        (req.headers.accept && req.headers.accept.includes('application/json'))
    );
    if (isApi) {
        return res.status(req.isAuthenticated() ? 403 : 401).json({
            success: false,
            error: req.isAuthenticated() ? 'Access Denied: Teachers and Admins Only' : 'Session expired or unauthenticated. Please log in again.'
        });
    }
    res.status(403).send("Access Denied: Teachers and Admins Only");
}

// ============================================================
// SHARED PDF HEADER HELPER (header.docx Standard for Teacher)
// Draws the standard Mabini College branded header on every PDF.
// ============================================================
function drawPdfHeader(doc, title, subtitle, teacher, auditRef = null, isContinuation = false) {
    return drawPdfDocumentHeader(doc, {
        title,
        subtitle,
        user: { first_name: teacher || '', last_name: '', role: 'Teacher' },
        role: 'Teacher',
        classification: 'CONFIDENTIAL — TEACHER COPY',
        auditRef: auditRef || doc._currentAuditRef || generateAuditRef('TCH'),
        isContinuation
    });
}

// Helper: draw a thin divider line
function pdfDivider(doc, color = '#e2e8f0') {
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor(color).lineWidth(0.5).stroke();
    doc.moveDown(0.4);
}

// Helper: add page footer with page number
function addPageNumbers(doc, auditRef = null) {
    attachPdfFooters(doc, auditRef || doc._currentAuditRef || generateAuditRef('TCH'), 'CONFIDENTIAL — TEACHER COPY');
}

// ============================================================
// MULTER — Learning Material file uploads
// Saves to /public/material_uploads/  (max 50 MB)
// Accepts: PDF, Word, PPT, images, video
// ============================================================
const materialStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'material_uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 60);
        cb(null, `mat_${Date.now()}_${base}${ext}`);
    }
});

const materialUpload = multer({
    storage: materialStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
            'video/mp4', 'video/webm', 'video/ogg', 'video/x-matroska', 'video/mkv', 'video/quicktime', 'video/x-msvideo'
        ];
        if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
});

// ============================================================
// MULTER — Announcement Attachments (PDF, Images, Word documents)
// Saves to /public/announcement_uploads/ (max 25 MB)
// ============================================================
const announcementStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'announcement_uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 50);
        cb(null, `ann_${Date.now()}_${base}${ext}`);
    }
});

const announcementUpload = multer({
    storage: announcementStorage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp'
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`File type not allowed for announcement: ${file.mimetype}`));
    }
});

// ============================================================
// MULTER — Subject cover image uploads
// Saves to /public/profile_uploads/  (max 5 MB, images only)
// ============================================================
const subjectImgStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'profile_uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `subject_${Date.now()}${ext}`);
    }
});

const subjectImgUpload = multer({
    storage: subjectImgStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed for subject image.'));
    }
});

// ============================================================
// MULTER — Teacher profile picture uploads
// Saves to /public/profile_uploads/  (max 5 MB, images only)
// ============================================================
const profileStorage = multer.diskStorage({
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

const profileUpload = multer({
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed for profile picture.'));
    }
});

// ============================================================
// MULTER — Assignment Format Templates & Sample Output Uploads
// ============================================================
const { sanitizeFileName, isDangerousFile } = require('../utils/fileSecurityHelper');

const assignmentAssetStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subfolder = 'assignment_templates';
        if (file.fieldname === 'sample_file') {
            subfolder = 'assignment_samples';
        }
        const dir = path.join(__dirname, '..', 'public', subfolder);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const cleanName = sanitizeFileName(file.originalname);
        cb(null, `asgn_${Date.now()}_${cleanName}`);
    }
});

const assignmentAssetUpload = multer({
    storage: assignmentAssetStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (isDangerousFile(file.originalname)) {
            return cb(new Error('Executable and dangerous script files are prohibited.'));
        }
        cb(null, true);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER — fetches notifications for any teacher page
// Call: const notifications = await getTeacherNotifications(db, teacherId);
// ─────────────────────────────────────────────────────────────────────────────
async function getTeacherNotifications(db, teacherId) {
    try {
        await notificationService.syncTeacherProactiveAlerts(teacherId);

        const [persistent] = await db.query(`
            SELECT 
                n.notification_id,
                n.notification_id AS ref_id,
                n.category,
                n.priority,
                n.event_type,
                n.event_type AS notif_type,
                n.title,
                n.message,
                n.target_url,
                n.is_read,
                n.created_at,
                n.created_at AS notif_time,
                CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                u.profile_pic AS actor_pic
            FROM notifications n
            LEFT JOIN users u ON n.actor_id = u.user_id
            WHERE n.user_id = ?
              AND n.role = 'Teacher'
              AND n.is_dismissed = 0
            ORDER BY n.created_at DESC
            LIMIT 30
        `, [teacherId]);

        return persistent || [];
    } catch (err) {
        console.error('[getTeacherNotifications Error]', err);
        return [];
    }
}


router.get('/dashboard', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;

    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;
        const syStartDate = currentSY && currentSY.start_date ? new Date(currentSY.start_date) : null;
        const syEndDate = currentSY && currentSY.end_date ? new Date(currentSY.end_date) : null;

        const [
            [classes],
            [statsResult],
            [recentScores],
            [forumActivity],
            [pendingAssessments],
            [needsAttention],
            [announcements],
            [pinnedDiscussions],
            [events],
            [leaderboard],
            [performanceStats],
            [subjectAssessmentStats],
            [weeklyPerformanceStats],
        ] = await Promise.all([
            db.query(`
                SELECT c.*, s.subject_name, s.subject_code, s.subject_image,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count
                FROM classes c JOIN subjects s ON c.subject_id = s.subject_id
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)`, [teacherId, currentSyId, currentSyId]),

            db.query(`
                SELECT 
                    (SELECT COUNT(DISTINCT cs.student_id) FROM class_students cs JOIN classes c ON cs.class_id = c.class_id WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)) as totalStudents,
                    (SELECT COUNT(*) FROM elementa_game_sessions egs 
                     JOIN class_students cs ON (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id)
                     JOIN classes c ON cs.class_id = c.class_id 
                     WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)) as totalAttempts`,
                [teacherId, currentSyId, currentSyId, teacherId, currentSyId, currentSyId]),

            db.query(`
                SELECT * FROM (
                    -- 1. Standard Individual Student Submissions (Assignments, Quizzes, Solo Arcade)
                    SELECT 
                        0 AS is_versus,
                        ss.score_id,
                        ss.student_id,
                        u.first_name, 
                        u.last_name, 
                        u.profile_pic AS student_pic,
                        ss.score_obtained,
                        ss.exp_gained,
                        NULL AS p2_id,
                        NULL AS p2_first_name,
                        NULL AS p2_last_name,
                        NULL AS p2_pic,
                        NULL AS p2_score,
                        NULL AS p2_exp,
                        NULL AS winner,
                        ss.total_items,
                        ss.assessment_id,
                        COALESCE(a.assessment_name, 'Assessment') AS assessment_name,
                        COALESCE(t.topic_name, 'General Chemistry') AS topic_name,
                        COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                        s.subject_id,
                        c.class_id,
                        c.class_name,
                        ss.is_grace_period,
                        ss.grace_minutes_used,
                        COALESCE(ss.submitted_at, ss.date_recorded) AS submitted_at,
                        ss.file_path,
                        ss.original_filename,
                        ss.feedback,
                        egs.session_id,
                        CASE 
                            WHEN egs.session_id IS NOT NULL OR ss.feedback LIKE '%Arcade%' THEN 'arcade'
                            ELSE 'assignment'
                        END AS submission_type,
                        CASE
                            WHEN egs.session_id IS NOT NULL THEN CONCAT('/teacher/analysis/', egs.session_id, '?student_id=', ss.student_id)
                            ELSE CONCAT('/teacher/grading-workspace/', ss.assessment_id, '?score_id=', ss.score_id)
                        END AS target_url
                    FROM student_scores ss
                    JOIN users u ON ss.student_id = u.user_id
                    JOIN assessments a ON ss.assessment_id = a.assessment_id
                    JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    JOIN classes c ON c.subject_id = s.subject_id AND c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                    JOIN class_students cs ON cs.class_id = c.class_id AND cs.student_id = ss.student_id
                    LEFT JOIN elementa_game_sessions egs ON (
                        egs.assessment_id = ss.assessment_id 
                        AND (egs.student_id_p1 = ss.student_id OR egs.student_id_p2 = ss.student_id)
                    )
                    WHERE NOT (
                        egs.play_mode = 'Versus' 
                        OR (egs.student_id_p1 IS NOT NULL AND egs.student_id_p2 IS NOT NULL AND egs.student_id_p2 > 0)
                    )

                    UNION ALL

                    -- 2. Consolidated 2-Player Versus / Dual Matches (1 row per game match)
                    SELECT 
                        1 AS is_versus,
                        egs.session_id AS score_id,
                        u1.user_id AS student_id,
                        u1.first_name,
                        u1.last_name,
                        u1.profile_pic AS student_pic,
                        egs.final_score_p1 AS score_obtained,
                        COALESCE((SELECT ss.exp_gained FROM student_scores ss WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = u1.user_id LIMIT 1), egs.final_score_p1 * 100, 100) AS exp_gained,
                        u2.user_id AS p2_id,
                        u2.first_name AS p2_first_name,
                        u2.last_name AS p2_last_name,
                        u2.profile_pic AS p2_pic,
                        egs.final_score_p2 AS p2_score,
                        COALESCE((SELECT ss.exp_gained FROM student_scores ss WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = u2.user_id LIMIT 1), egs.final_score_p2 * 100, 100) AS p2_exp,
                        CASE 
                            WHEN UPPER(egs.winner) IN ('P1', 'P2') THEN UPPER(egs.winner)
                            WHEN UPPER(egs.winner) IN ('TIE', 'DRAW') THEN 'Tie'
                            WHEN egs.final_score_p1 > egs.final_score_p2 THEN 'P1'
                            WHEN egs.final_score_p2 > egs.final_score_p1 THEN 'P2'
                            ELSE 'Tie'
                        END AS winner,
                        COALESCE(a.total_items, 3) AS total_items,
                        egs.assessment_id,
                        COALESCE(a.assessment_name, CONCAT('Arcade Level ', egs.highest_level_reached)) AS assessment_name,
                        COALESCE(t.topic_name, 'Scientific Measurement') AS topic_name,
                        COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                        s.subject_id,
                        c.class_id,
                        c.class_name,
                        0 AS is_grace_period,
                        0 AS grace_minutes_used,
                        COALESCE(egs.ended_at, egs.started_at) AS submitted_at,
                        NULL AS file_path,
                        NULL AS original_filename,
                        'Elementa Versus Match' AS feedback,
                        egs.session_id,
                        'arcade' AS submission_type,
                        CONCAT('/teacher/analysis/', egs.session_id) AS target_url
                    FROM elementa_game_sessions egs
                    JOIN users u1 ON egs.student_id_p1 = u1.user_id
                    JOIN users u2 ON egs.student_id_p2 = u2.user_id
                    LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                    LEFT JOIN (
                        SELECT cs2.student_id, MAX(cs2.class_id) AS class_id, c2.subject_id
                        FROM class_students cs2
                        JOIN classes c2 ON cs2.class_id = c2.class_id
                        WHERE c2.teacher_id = ? AND (? IS NULL OR c2.sy_id = ?)
                        GROUP BY cs2.student_id, c2.subject_id
                    ) fallback_p1 ON fallback_p1.student_id = u1.user_id
                        AND (q.subject_id IS NULL OR fallback_p1.subject_id = q.subject_id)
                    JOIN classes c ON c.class_id = COALESCE(egs.class_id, fallback_p1.class_id)
                    JOIN subjects s ON s.subject_id = COALESCE(q.subject_id, c.subject_id)
                    WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                      AND (egs.play_mode = 'Versus' OR (egs.student_id_p1 IS NOT NULL AND egs.student_id_p2 IS NOT NULL AND egs.student_id_p2 > 0))

                    UNION ALL

                    -- 3. Solo Arcade Freeplay (sessions without assessment_id or not synced)
                    SELECT 
                        0 AS is_versus,
                        egs.session_id AS score_id,
                        u.user_id AS student_id,
                        u.first_name,
                        u.last_name,
                        u.profile_pic AS student_pic,
                        egs.final_score_p1 AS score_obtained,
                        COALESCE(egs.final_score_p1 * 100, 100) AS exp_gained,
                        NULL AS p2_id,
                        NULL AS p2_first_name,
                        NULL AS p2_last_name,
                        NULL AS p2_pic,
                        NULL AS p2_score,
                        NULL AS p2_exp,
                        NULL AS winner,
                        GREATEST(COALESCE(a.total_items, egs.highest_level_reached, 1), egs.final_score_p1) AS total_items,
                        egs.assessment_id,
                        COALESCE(a.assessment_name, CONCAT('Arcade Level ', egs.highest_level_reached)) AS assessment_name,
                        COALESCE(t.topic_name, 'Arcade Mode') AS topic_name,
                        COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                        s.subject_id,
                        c.class_id,
                        c.class_name,
                        0 AS is_grace_period,
                        0 AS grace_minutes_used,
                        COALESCE(egs.ended_at, egs.started_at) AS submitted_at,
                        NULL AS file_path,
                        NULL AS original_filename,
                        'Elementa Freeplay' AS feedback,
                        egs.session_id,
                        'arcade' AS submission_type,
                        CONCAT('/teacher/analysis/', egs.session_id, '?student_id=', u.user_id) AS target_url
                    FROM elementa_game_sessions egs
                    JOIN users u ON egs.student_id_p1 = u.user_id
                    LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                    LEFT JOIN (
                        SELECT cs2.student_id, MAX(cs2.class_id) AS class_id, c2.subject_id
                        FROM class_students cs2
                        JOIN classes c2 ON cs2.class_id = c2.class_id
                        WHERE c2.teacher_id = ? AND (? IS NULL OR c2.sy_id = ?)
                        GROUP BY cs2.student_id, c2.subject_id
                    ) fallback_fp ON fallback_fp.student_id = u.user_id
                        AND (q.subject_id IS NULL OR fallback_fp.subject_id = q.subject_id)
                    JOIN classes c ON c.class_id = COALESCE(egs.class_id, fallback_fp.class_id)
                    JOIN subjects s ON s.subject_id = COALESCE(q.subject_id, c.subject_id)
                    WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                      AND (egs.student_id_p2 IS NULL OR egs.student_id_p2 = 0)
                      AND (egs.assessment_id IS NULL OR NOT EXISTS (
                          SELECT 1 FROM student_scores ss2 
                          WHERE ss2.assessment_id = egs.assessment_id 
                            AND ss2.student_id = u.user_id
                      ))
                ) AS consolidated_feed
                ORDER BY submitted_at DESC, score_id DESC
                LIMIT 10`, [
                    teacherId, currentSyId, currentSyId,
                    teacherId, currentSyId, currentSyId,
                    teacherId, currentSyId, currentSyId,
                    teacherId, currentSyId, currentSyId,
                    teacherId, currentSyId, currentSyId
                ]),

            db.query(`
                SELECT ft.*, t.topic_name, q.subject_id
                FROM forum_topics ft 
                LEFT JOIN topics t ON ft.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE ft.teacher_id = ? 
                  AND (
                      ft.class_id IN (SELECT class_id FROM classes WHERE teacher_id = ? AND (? IS NULL OR sy_id = ?))
                      OR (ft.class_id IS NULL AND (? IS NULL OR (ft.created_at >= ? AND ft.created_at <= ?)))
                  )
                ORDER BY ft.created_at DESC`, [teacherId, teacherId, currentSyId, currentSyId, currentSyId, syStartDate, syEndDate]),

            db.query(`
            SELECT DISTINCT
                a.assessment_id,
                a.assessment_name,
                a.assessment_type AS type,
                a.total_items,
                a.due_date,
                a.is_unlocked,
                t.topic_name,
                q.quarter_number AS quarter
            FROM assessments a 
            JOIN topics t ON a.topic_id = t.topic_id 
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN classes c ON q.subject_id = c.subject_id
            WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?) AND a.due_date >= CURDATE()
            ORDER BY a.due_date ASC
            LIMIT 10
        `, [teacherId, currentSyId, currentSyId]),

            db.query(`
                SELECT u.first_name, u.last_name, u.profile_pic, sp.progress_percent, s.subject_name, s.subject_id
                FROM student_progress sp 
                JOIN users u ON sp.student_id = u.user_id
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?) AND sp.progress_percent < 50 
                GROUP BY u.user_id, s.subject_id`, [teacherId, currentSyId, currentSyId]),

            db.query(`
                SELECT * FROM announcements 
                WHERE teacher_id = ? 
                  AND (
                      sy_id = ?
                      OR class_id IN (SELECT class_id FROM classes WHERE teacher_id = ? AND (? IS NULL OR sy_id = ?))
                      OR (sy_id IS NULL AND class_id IS NULL AND (? IS NULL OR (created_at >= ? AND created_at <= ?)))
                  )
                ORDER BY created_at DESC LIMIT 3`, [teacherId, currentSyId, teacherId, currentSyId, currentSyId, currentSyId, syStartDate, syEndDate]),

            db.query(`
                SELECT * FROM forum_topics 
                WHERE teacher_id = ? AND is_pinned = 1
                  AND (
                      class_id IN (SELECT class_id FROM classes WHERE teacher_id = ? AND (? IS NULL OR sy_id = ?))
                      OR (class_id IS NULL AND (? IS NULL OR (created_at >= ? AND created_at <= ?)))
                  )`, [teacherId, teacherId, currentSyId, currentSyId, currentSyId, syStartDate, syEndDate]),

            db.query(`
                SELECT ev.*, s.subject_name 
                FROM calendar_events ev
                LEFT JOIN subjects s ON ev.subject_id = s.subject_id
                WHERE ev.teacher_id = ? 
                  AND (
                      ev.class_id IN (SELECT class_id FROM classes WHERE teacher_id = ? AND (? IS NULL OR sy_id = ?))
                      OR (ev.class_id IS NULL AND (? IS NULL OR (ev.event_date >= ? AND ev.event_date <= ?)))
                  )
                ORDER BY ev.event_date ASC`, [teacherId, teacherId, currentSyId, currentSyId, currentSyId, syStartDate, syEndDate]),

            db.query(`
                SELECT u.first_name, u.last_name, u.profile_pic,
                       COALESCE(
                           (SELECT SUM(ss.exp_gained) FROM student_scores ss
                            JOIN assessments a ON ss.assessment_id = a.assessment_id
                            JOIN topics t ON a.topic_id = t.topic_id
                            JOIN quarters q ON t.quarter_id = q.quarter_id
                            JOIN classes c2 ON q.subject_id = c2.subject_id AND c2.class_id = cs.class_id
                            WHERE ss.student_id = u.user_id AND (? IS NULL OR c2.sy_id = ?)),
                           u.total_exp, 0
                       ) AS total_points
                FROM users u
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?) AND u.role = 'Student'
                GROUP BY u.user_id ORDER BY total_points DESC LIMIT 5`, [currentSyId, currentSyId, teacherId, currentSyId, currentSyId]),

            db.query(`
                SELECT ROUND(AVG(eca.is_correct) * 100, 1) as avg_accuracy
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                JOIN class_students cs ON (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id)
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)`, [teacherId, currentSyId, currentSyId]),

            /* NEW: Subject Assessment Completion Stats for bar chart */
            db.query(`
                SELECT
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    COUNT(DISTINCT a.assessment_id) AS total_assessments,
                    COUNT(DISTINCT cs.student_id) AS total_students,
                    COUNT(DISTINCT esg.student_id) AS students_completed,
                    ROUND(
                        (COUNT(DISTINCT esg.student_id) / NULLIF(COUNT(DISTINCT cs.student_id), 0)) * 100
                    , 1) AS completion_percent
                FROM subjects s
                JOIN classes c ON s.subject_id = c.subject_id
                LEFT JOIN class_students cs ON c.class_id = cs.class_id
                LEFT JOIN quarters q ON s.subject_id = q.subject_id
                LEFT JOIN topics t ON q.quarter_id = t.quarter_id
                LEFT JOIN assessments a ON t.topic_id = a.topic_id
                LEFT JOIN elementa_student_grades esg ON (a.assessment_id = esg.assessment_id AND esg.student_id = cs.student_id)
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                GROUP BY s.subject_id, s.subject_name, s.subject_code
                ORDER BY completion_percent ASC`, [teacherId, currentSyId, currentSyId]),

            /* Weekly Performance Trends for Performance Overview line chart */
            db.query(`
                SELECT 
                    WEEKDAY(ts) as weekday_idx,
                    DAYNAME(ts) as day_name,
                    COUNT(*) as total_entries,
                    ROUND(AVG(score_pct), 1) as avg_score,
                    SUM(CASE WHEN ts >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as recent_entries,
                    ROUND(AVG(CASE WHEN ts >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN score_pct ELSE NULL END), 1) as recent_avg_score
                FROM (
                    -- 1. Standard Assessment Scores
                    SELECT 
                        COALESCE(ss.submitted_at, ss.date_recorded) as ts,
                        (ss.score_obtained / NULLIF(ss.total_items, 0)) * 100 as score_pct
                    FROM student_scores ss
                    JOIN assessments a ON ss.assessment_id = a.assessment_id
                    JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    JOIN classes c ON c.subject_id = s.subject_id AND c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                    JOIN class_students cs ON cs.class_id = c.class_id AND cs.student_id = ss.student_id
                    WHERE ss.score_obtained IS NOT NULL AND ss.total_items > 0

                    UNION ALL

                    -- 2. Arcade Level Runs Accuracy
                    SELECT 
                        COALESCE(egs.ended_at, egs.started_at) as ts,
                        (eca.is_correct * 100) as score_pct
                    FROM elementa_customer_attempts eca
                    JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                    JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                    JOIN class_students cs ON (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id)
                    JOIN classes c ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                ) all_attempts
                GROUP BY weekday_idx, day_name
                ORDER BY weekday_idx ASC`, [teacherId, currentSyId, currentSyId, teacherId, currentSyId, currentSyId]),
        ]);

        // Build Weekly Trends 7-day data (Mon=0, Tue=1, ..., Sun=6)
        const weeklyDayMap = {};
        const weeklyCountMap = {};
        (weeklyPerformanceStats || []).forEach(r => {
            const score = (r.recent_entries > 0 && r.recent_avg_score !== null)
                ? parseFloat(r.recent_avg_score)
                : parseFloat(r.avg_score);
            weeklyDayMap[r.weekday_idx] = score;
            weeklyCountMap[r.weekday_idx] = parseInt(r.recent_entries > 0 ? r.recent_entries : r.total_entries, 10);
        });

        const dayAbbrs = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const weeklyTrends = {
            labels: dayAbbrs,
            scores: dayAbbrs.map((_, idx) => weeklyDayMap[idx] !== undefined ? weeklyDayMap[idx] : 0),
            counts: dayAbbrs.map((_, idx) => weeklyCountMap[idx] !== undefined ? weeklyCountMap[idx] : 0)
        };

        const notifications = await getTeacherNotifications(db, teacherId);

        res.render('teacher/dashboard', {
            user: req.user,
            currentSY,
            classes,
            stats: { ...statsResult[0], avgAccuracy: performanceStats[0]?.avg_accuracy || 0 },
            recentScores,
            forumActivity,
            pendingAssessments,
            needsAttention,
            announcements,
            pinnedDiscussions,
            events,
            leaderboard,
            subjectAssessmentStats,
            weeklyTrends,
            notifications,
        });

    } catch (err) {
        console.error("❌ Teacher Dashboard Error:", err);
        res.status(500).send("Problem loading dashboard.");
    }
});


// ============================================================
// ALL ACTIVITIES & SUBMISSIONS ARCHIVE ROUTE
// ============================================================
router.get('/all-activities', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;

        const [activities] = await db.query(`
            SELECT * FROM (
                -- 1. Standard Individual Student Submissions (Assignments, Quizzes, Solo Arcade)
                SELECT 
                    0 AS is_versus,
                    ss.score_id,
                    ss.student_id,
                    u.first_name, 
                    u.last_name, 
                    u.profile_pic AS student_pic,
                    ss.score_obtained,
                    ss.exp_gained,
                    NULL AS p2_id,
                    NULL AS p2_first_name,
                    NULL AS p2_last_name,
                    NULL AS p2_pic,
                    NULL AS p2_score,
                    NULL AS p2_exp,
                    NULL AS winner,
                    ss.total_items,
                    ss.assessment_id,
                    COALESCE(a.assessment_name, 'Assessment') AS assessment_name,
                    COALESCE(t.topic_name, 'General Chemistry') AS topic_name,
                    COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                    s.subject_id,
                    c.class_id,
                    c.class_name,
                    ss.is_grace_period,
                    ss.grace_minutes_used,
                    COALESCE(ss.submitted_at, ss.date_recorded) AS submitted_at,
                    ss.file_path,
                    ss.original_filename,
                    ss.feedback,
                    egs.session_id,
                    CASE 
                        WHEN egs.session_id IS NOT NULL OR ss.feedback LIKE '%Arcade%' THEN 'arcade'
                        ELSE 'assignment'
                    END AS submission_type,
                    CASE
                        WHEN egs.session_id IS NOT NULL THEN CONCAT('/teacher/analysis/', egs.session_id, '?student_id=', ss.student_id)
                        ELSE CONCAT('/teacher/grading-workspace/', ss.assessment_id, '?score_id=', ss.score_id)
                    END AS target_url
                FROM student_scores ss
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                JOIN classes c ON c.subject_id = s.subject_id AND c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                JOIN class_students cs ON cs.class_id = c.class_id AND cs.student_id = ss.student_id
                LEFT JOIN elementa_game_sessions egs ON (
                    egs.assessment_id = ss.assessment_id 
                    AND (egs.student_id_p1 = ss.student_id OR egs.student_id_p2 = ss.student_id)
                )
                WHERE NOT (
                    egs.play_mode = 'Versus' 
                    OR (egs.student_id_p1 IS NOT NULL AND egs.student_id_p2 IS NOT NULL AND egs.student_id_p2 > 0)
                )

                UNION ALL

                -- 2. Consolidated 2-Player Versus / Dual Matches (1 row per game match)
                SELECT 
                    1 AS is_versus,
                    egs.session_id AS score_id,
                    u1.user_id AS student_id,
                    u1.first_name,
                    u1.last_name,
                    u1.profile_pic AS student_pic,
                    egs.final_score_p1 AS score_obtained,
                    COALESCE((SELECT ss.exp_gained FROM student_scores ss WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = u1.user_id LIMIT 1), egs.final_score_p1 * 100, 100) AS exp_gained,
                    u2.user_id AS p2_id,
                    u2.first_name AS p2_first_name,
                    u2.last_name AS p2_last_name,
                    u2.profile_pic AS p2_pic,
                    egs.final_score_p2 AS p2_score,
                    COALESCE((SELECT ss.exp_gained FROM student_scores ss WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = u2.user_id LIMIT 1), egs.final_score_p2 * 100, 100) AS p2_exp,
                    CASE 
                        WHEN UPPER(egs.winner) IN ('P1', 'P2') THEN UPPER(egs.winner)
                        WHEN UPPER(egs.winner) IN ('TIE', 'DRAW') THEN 'Tie'
                        WHEN egs.final_score_p1 > egs.final_score_p2 THEN 'P1'
                        WHEN egs.final_score_p2 > egs.final_score_p1 THEN 'P2'
                        ELSE 'Tie'
                    END AS winner,
                    COALESCE(a.total_items, 3) AS total_items,
                    egs.assessment_id,
                    COALESCE(a.assessment_name, CONCAT('Arcade Level ', egs.highest_level_reached)) AS assessment_name,
                    COALESCE(t.topic_name, 'Scientific Measurement') AS topic_name,
                    COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                    s.subject_id,
                    c.class_id,
                    c.class_name,
                    0 AS is_grace_period,
                    0 AS grace_minutes_used,
                    COALESCE(egs.ended_at, egs.started_at) AS submitted_at,
                    NULL AS file_path,
                    NULL AS original_filename,
                    'Elementa Versus Match' AS feedback,
                    egs.session_id,
                    'arcade' AS submission_type,
                    CONCAT('/teacher/analysis/', egs.session_id) AS target_url
                FROM elementa_game_sessions egs
                JOIN users u1 ON egs.student_id_p1 = u1.user_id
                JOIN users u2 ON egs.student_id_p2 = u2.user_id
                LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                LEFT JOIN (
                    SELECT cs2.student_id, MAX(cs2.class_id) AS class_id, c2.subject_id
                    FROM class_students cs2
                    JOIN classes c2 ON cs2.class_id = c2.class_id
                    WHERE c2.teacher_id = ? AND (? IS NULL OR c2.sy_id = ?)
                    GROUP BY cs2.student_id, c2.subject_id
                ) fallback_p1 ON fallback_p1.student_id = u1.user_id
                    AND (q.subject_id IS NULL OR fallback_p1.subject_id = q.subject_id)
                JOIN classes c ON c.class_id = COALESCE(egs.class_id, fallback_p1.class_id)
                JOIN subjects s ON s.subject_id = COALESCE(q.subject_id, c.subject_id)
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                  AND (egs.play_mode = 'Versus' OR (egs.student_id_p1 IS NOT NULL AND egs.student_id_p2 IS NOT NULL AND egs.student_id_p2 > 0))

                UNION ALL

                -- 3. Solo Arcade Freeplay (sessions without assessment_id or not synced)
                SELECT 
                    0 AS is_versus,
                    egs.session_id AS score_id,
                    u.user_id AS student_id,
                    u.first_name,
                    u.last_name,
                    u.profile_pic AS student_pic,
                    egs.final_score_p1 AS score_obtained,
                    COALESCE(egs.final_score_p1 * 100, 100) AS exp_gained,
                    NULL AS p2_id,
                    NULL AS p2_first_name,
                    NULL AS p2_last_name,
                    NULL AS p2_pic,
                    NULL AS p2_score,
                    NULL AS p2_exp,
                    NULL AS winner,
                    GREATEST(COALESCE(a.total_items, egs.highest_level_reached, 1), egs.final_score_p1) AS total_items,
                    egs.assessment_id,
                    COALESCE(a.assessment_name, CONCAT('Arcade Level ', egs.highest_level_reached)) AS assessment_name,
                    COALESCE(t.topic_name, 'Arcade Mode') AS topic_name,
                    COALESCE(s.subject_name, 'Chemistry') AS subject_name,
                    s.subject_id,
                    c.class_id,
                    c.class_name,
                    0 AS is_grace_period,
                    0 AS grace_minutes_used,
                    COALESCE(egs.ended_at, egs.started_at) AS submitted_at,
                    NULL AS file_path,
                    NULL AS original_filename,
                    'Elementa Freeplay' AS feedback,
                    egs.session_id,
                    'arcade' AS submission_type,
                    CONCAT('/teacher/analysis/', egs.session_id, '?student_id=', u.user_id) AS target_url
                FROM elementa_game_sessions egs
                JOIN users u ON egs.student_id_p1 = u.user_id
                LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                LEFT JOIN (
                    SELECT cs2.student_id, MAX(cs2.class_id) AS class_id, c2.subject_id
                    FROM class_students cs2
                    JOIN classes c2 ON cs2.class_id = c2.class_id
                    WHERE c2.teacher_id = ? AND (? IS NULL OR c2.sy_id = ?)
                    GROUP BY cs2.student_id, c2.subject_id
                ) fallback_fp ON fallback_fp.student_id = u.user_id
                    AND (q.subject_id IS NULL OR fallback_fp.subject_id = q.subject_id)
                JOIN classes c ON c.class_id = COALESCE(egs.class_id, fallback_fp.class_id)
                JOIN subjects s ON s.subject_id = COALESCE(q.subject_id, c.subject_id)
                WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
                  AND (egs.student_id_p2 IS NULL OR egs.student_id_p2 = 0)
                  AND (egs.assessment_id IS NULL OR NOT EXISTS (
                      SELECT 1 FROM student_scores ss2 
                      WHERE ss2.assessment_id = egs.assessment_id 
                        AND ss2.student_id = u.user_id
                  ))
            ) AS all_feed
            ORDER BY submitted_at DESC
            LIMIT 100
        `, [
            teacherId, currentSyId, currentSyId,
            teacherId, currentSyId, currentSyId,
            teacherId, currentSyId, currentSyId,
            teacherId, currentSyId, currentSyId,
            teacherId, currentSyId, currentSyId
        ]);

        const notifications = await getTeacherNotifications(db, teacherId);

        res.render('teacher/all_activities', {
            user: req.user,
            currentSY,
            activities,
            notifications
        });
    } catch (err) {
        console.error("❌ Teacher All Activities Error:", err);
        res.status(500).send("Problem loading activities archive: " + err.message);
    }
});


// ============================================================
// CLASS VIEW ROUTE (full detail: quarters / topics / analytics)
// ============================================================

router.get('/class/:classId', isTeacher, async (req, res) => {
    console.log(`[GET] /class/${req.params.classId}`);
    try {
        const classId = req.params.classId;
        const teacherId = req.user.user_id;

        const [classData] = await db.execute(`
            SELECT c.*, s.*, sy.sy_range, sy.status AS sy_status, sy.is_active AS sy_is_active
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE c.class_id = ? AND c.teacher_id = ?`, [classId, teacherId]);

        if (!classData.length) {
            return res.status(404).render('404', {
                title: 'Class Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Teacher',
                requestedPath: req.originalUrl,
                customMessage: 'The requested class record does not exist or is not assigned to your instructor account.'
            });
        }
        console.log('[DEBUG] subject_image:', classData[0].subject_image);

        const subjectId = classData[0].subject_id;

        const [students] = await db.execute(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.middle_name,
                u.profile_pic, u.lrn_number, u.grade_level, u.section,
                u.current_level, u.flagged_assessment_id,
                COALESCE((
                    SELECT SUM(CASE WHEN gs.student_id_p1 = u.user_id THEN gs.final_score_p1 ELSE gs.final_score_p2 END)
                    FROM elementa_game_sessions gs
                    LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN quarters qt ON t.quarter_id = qt.quarter_id
                    WHERE (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
                      AND gs.play_mode = 'Solo'
                      AND (gs.class_id = cs.class_id OR qt.subject_id = ? OR gs.assessment_id IS NULL)
                ), 0) AS total_solo_score,
                COALESCE((
                    SELECT SUM(CASE WHEN gs.student_id_p1 = u.user_id THEN gs.final_score_p1 ELSE gs.final_score_p2 END)
                    FROM elementa_game_sessions gs
                    LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN quarters qt ON t.quarter_id = qt.quarter_id
                    WHERE (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
                      AND gs.play_mode = 'Versus'
                      AND (gs.class_id = cs.class_id OR qt.subject_id = ? OR gs.assessment_id IS NULL)
                ), 0) AS total_versus_score,
                COALESCE((
                    SELECT SUM(CASE 
                        WHEN (gs.student_id_p1 = u.user_id AND gs.winner = 'P1') 
                          OR (gs.student_id_p2 = u.user_id AND gs.winner = 'P2') 
                        THEN 1 
                        ELSE 0 
                    END)
                    FROM elementa_game_sessions gs
                    LEFT JOIN assessments a ON gs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN quarters qt ON t.quarter_id = qt.quarter_id
                    WHERE (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
                      AND gs.play_mode = 'Versus'
                      AND (gs.class_id = cs.class_id OR qt.subject_id = ? OR gs.assessment_id IS NULL)
                ), 0) AS total_versus_wins,
                COALESCE(u.total_exp, 0) AS total_exp,
                sp.progress_percent,
                sp.last_accessed,
                (SELECT MAX(pm.sent_at) 
                 FROM private_messages pm 
                 WHERE (pm.sender_id = u.user_id AND pm.receiver_id = ?)
                    OR (pm.sender_id = ? AND pm.receiver_id = u.user_id)
                ) AS last_message_time,
                (SELECT pm.message_text 
                 FROM private_messages pm 
                 WHERE (pm.sender_id = u.user_id AND pm.receiver_id = ?)
                    OR (pm.sender_id = ? AND pm.receiver_id = u.user_id)
                 ORDER BY pm.sent_at DESC LIMIT 1
                ) AS last_message_text
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            LEFT JOIN student_progress sp
                   ON u.user_id = sp.student_id AND sp.subject_id = ?
            WHERE cs.class_id = ? AND u.role = 'Student'
            ORDER BY u.last_name ASC`,
            [subjectId, subjectId, subjectId, teacherId, teacherId, teacherId, teacherId, subjectId, classId]
        );

        students.forEach(s => {
            s.total_solo_score = parseInt(s.total_solo_score) || 0;
            s.total_versus_score = parseInt(s.total_versus_score) || 0;
            s.total_versus_wins = parseInt(s.total_versus_wins) || 0;
            s.total_score = s.total_solo_score + s.total_versus_score;
        });

        await topicScheduleService.evaluateNow();

        const [quarters] = await db.execute(
            `SELECT * FROM quarters WHERE subject_id = ? ORDER BY quarter_number ASC`,
            [subjectId]
        );

        for (const q of quarters) {
            const [topics] = await db.execute(
                `SELECT topic_id, quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked,
                        DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') AS auto_unlock_at,
                        DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') AS auto_lock_at
                 FROM topics WHERE quarter_id = ? ORDER BY topic_id ASC`,
                [q.quarter_id]
            );
            for (const t of topics) {
                const [[mats], [asms], [frms]] = await Promise.all([
                    db.execute(`
                        SELECT lm.*, 0 AS query_count
                        FROM learning_materials lm 
                        WHERE lm.topic_id = ?`, [t.topic_id]),
                    db.execute(`
                        SELECT a.*,
                            (SELECT COUNT(*) FROM elementa_game_sessions egs WHERE egs.assessment_id = a.assessment_id) AS submission_count,
                            (SELECT COUNT(*) FROM elementa_game_sessions egs WHERE egs.assessment_id = a.assessment_id AND egs.session_status = 'Completed') AS graded_count
                        FROM assessments a 
                        WHERE a.topic_id = ? 
                        ORDER BY a.assessment_id ASC`, [t.topic_id]),
                    db.execute(`SELECT * FROM forum_topics WHERE topic_id = ? ORDER BY is_pinned DESC, created_at DESC`, [t.topic_id]),
                ]);
                t.materials = mats;
                t.assessments = asms.filter(a => a.assessment_type !== 'Assignment');
                t.assignments = asms.filter(a => a.assessment_type === 'Assignment');
                t.forums = frms;
            }
            q.topics = topics;
        }

        const [classAnnouncements] = await db.query(`
            SELECT a.*, 
                   CONCAT(u.first_name, ' ', u.last_name) AS author_name,
                   u.profile_pic AS author_pic
            FROM announcements a
            LEFT JOIN users u ON a.teacher_id = u.user_id
            WHERE a.class_id = ? OR a.scope = 'global'
            ORDER BY a.is_critical DESC, a.is_priority DESC, a.created_at DESC
        `, [classId]);

        const [scores] = await db.execute(`
            (
                -- 1. Standard LMS Student Scores (Assignments, Quizzes, Deliverables)
                SELECT 
                    CONCAT('ss_', ss.score_id) AS score_id,
                    ss.score_obtained,
                    COALESCE(NULLIF(ss.total_items, 0), NULLIF(ss.total_possible_score, 0), NULLIF(a.total_items, 0), 100) AS total_items,
                    COALESCE(ss.exp_gained, 0) AS exp_gained,
                    COALESCE(ss.submitted_at, ss.date_recorded) AS date_recorded,
                    a.assessment_id,
                    a.assessment_name,
                    COALESCE(a.assessment_type, 'Assignment') AS assessment_type,
                    qt.quarter_id,
                    qt.quarter_number,
                    u.user_id,
                    u.first_name,
                    u.last_name,
                    u.profile_pic,
                    'lms' AS record_source
                FROM student_scores ss
                JOIN users u ON ss.student_id = u.user_id
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN quarters qt ON t.quarter_id = qt.quarter_id
                WHERE cs.class_id = ? 
                  AND (qt.subject_id = ? OR a.assessment_id IS NULL)
                  AND (ss.feedback IS NULL OR ss.feedback NOT LIKE '%Arcade%')
            )
            UNION ALL
            (
                -- 2. Elementa Arcade Game Sessions (Solo & Versus) with Player Isolation
                SELECT 
                    CAST(egs.session_id AS CHAR) AS score_id,
                    GREATEST(
                        COALESCE(CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END, 0),
                        COALESCE((SELECT COUNT(*) FROM elementa_customer_attempts eca 
                                  JOIN elementa_level_runs elr ON eca.run_id = elr.run_id 
                                  WHERE elr.session_id = egs.session_id 
                                    AND elr.player_number = (CASE WHEN egs.student_id_p1 = u.user_id THEN 1 ELSE 2 END)
                                    AND eca.is_correct = 1), 0)
                    ) AS score_obtained,
                    GREATEST(
                        COALESCE(a.total_items, (SELECT COUNT(*) FROM elementa_customer_attempts eca 
                                                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id 
                                                WHERE elr.session_id = egs.session_id 
                                                  AND elr.player_number = (CASE WHEN egs.student_id_p1 = u.user_id THEN 1 ELSE 2 END)), 1),
                        1
                    ) AS total_items,
                    COALESCE(
                        (SELECT ss.exp_gained FROM student_scores ss 
                         WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = u.user_id 
                         ORDER BY ss.score_id DESC LIMIT 1),
                        CASE 
                            WHEN (CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END) > 0 
                            THEN (CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END) * 100
                            ELSE 0
                        END
                    ) AS exp_gained,
                    egs.started_at AS date_recorded,
                    a.assessment_id,
                    COALESCE(a.assessment_name, 'Arcade Free Play') AS assessment_name,
                    COALESCE(a.assessment_type, 'Arcade') AS assessment_type,
                    qt.quarter_id,
                    qt.quarter_number,
                    u.user_id,
                    u.first_name,
                    u.last_name,
                    u.profile_pic,
                    'arcade' AS record_source
                FROM elementa_game_sessions egs
                LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                LEFT JOIN topics t      ON a.topic_id       = t.topic_id
                LEFT JOIN quarters qt   ON t.quarter_id     = qt.quarter_id
                JOIN users u            ON (egs.student_id_p1 = u.user_id OR egs.student_id_p2 = u.user_id)
                JOIN class_students cs  ON u.user_id        = cs.student_id
                WHERE cs.class_id = ? AND (qt.subject_id = ? OR egs.assessment_id IS NULL)
            )
            ORDER BY date_recorded DESC`,
            [classId, subjectId, classId, subjectId]
        );

        const [competitiveMatches] = await db.execute(`
            SELECT egs.session_id AS match_id,
                egs.final_score_p1 AS p1_score,
                egs.final_score_p2 AS p2_score,
                CASE 
                    WHEN egs.winner = 'P1' THEN egs.student_id_p1
                    WHEN egs.winner = 'P2' THEN egs.student_id_p2
                    ELSE NULL
                END AS winner_id,
                egs.started_at AS match_date,
                egs.student_id_p1 AS p1_id,
                egs.student_id_p2 AS p2_id,
                COALESCE(a.assessment_name, 'Arcade 1v1 Duel') AS assessment_name,
                u1.first_name AS p1_first, u1.last_name AS p1_last,
                u2.first_name AS p2_first, u2.last_name AS p2_last
            FROM elementa_game_sessions egs
            LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
            LEFT JOIN topics t      ON a.topic_id       = t.topic_id
            LEFT JOIN quarters qt   ON t.quarter_id     = qt.quarter_id
            LEFT JOIN users u1      ON egs.student_id_p1 = u1.user_id
            LEFT JOIN users u2      ON egs.student_id_p2 = u2.user_id
            WHERE egs.play_mode = 'Versus'
              AND (qt.subject_id = ? OR egs.assessment_id IS NULL)
              AND (
                egs.student_id_p1 IN (SELECT student_id FROM class_students WHERE class_id = ?)
                OR
                egs.student_id_p2 IN (SELECT student_id FROM class_students WHERE class_id = ?)
              )
            ORDER BY egs.started_at DESC`,
            [subjectId, classId, classId]
        );

        const leaderboardHistory = [];

        const [activeSessions] = await db.execute(`
            SELECT egs.session_id, egs.play_mode AS player_mode,
                egs.highest_level_reached AS current_item_index,
                egs.final_score_p1 AS accumulated_score,
                egs.session_status, egs.started_at AS start_time,
                u.first_name, u.last_name, u.profile_pic,
                COALESCE(a.assessment_name, 'Arcade Session') AS assessment_name,
                12 AS total_items
            FROM elementa_game_sessions egs
            LEFT JOIN users u ON egs.student_id_p1 = u.user_id
            LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
            LEFT JOIN class_students cs ON u.user_id = cs.student_id
            WHERE (cs.class_id = ? OR egs.class_id = ?) AND egs.session_status = 'Ongoing'
            ORDER BY egs.started_at ASC`,
            [classId, classId]
        );

        const [forumDone] = await db.execute(`
            SELECT sfd.forum_id, sfd.student_id
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            JOIN topics t        ON ft.topic_id  = t.topic_id
            JOIN quarters qt     ON t.quarter_id = qt.quarter_id
            WHERE qt.subject_id = ?`, [subjectId]);

        const forumDoneMap = {};
        forumDone.forEach(row => {
            if (!forumDoneMap[row.forum_id]) forumDoneMap[row.forum_id] = [];
            forumDoneMap[row.forum_id].push(row.student_id);
        });

        const [calendarEvents] = await db.execute(`
            SELECT * FROM calendar_events WHERE subject_id = ? ORDER BY event_date ASC`,
            [subjectId]
        );

        const [whitelists] = await db.execute(`
            SELECT * FROM class_whitelists WHERE class_id = ? ORDER BY created_at DESC`,
            [classId]
        );

        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const isHistoricalSY = !currentSY || (classData[0].sy_id !== currentSY.sy_id);

        if (quarters && quarters.length > 0) {
            quarters.forEach(q => {
                if (isHistoricalSY) {
                    q.gradingStatus = {
                        isOpen: false,
                        status: 'LOCKED',
                        deadline: null,
                        message: 'Archived Academic Year: Grade modifications locked.'
                    };
                } else {
                    q.gradingStatus = academicHelper.isQuarterGradingOpen(currentSY, q.quarter_number);
                }
            });
        }

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/class-view', {
            user: req.user,
            activeSY: currentSY,
            currentSY,
            isHistoricalSY,
            classInfo: {
                class_name: classData[0].class_name,
                class_id: Number(classId),
                max_capacity: classData[0].max_capacity,
                enrolled_count: classData[0].enrolled_count,
                enrollment_start: classData[0].enrollment_start,
                enrollment_end: classData[0].enrollment_end
            },
            subject: classData[0],
            schoolYear: {
                sy_id: classData[0].sy_id,
                sy_range: classData[0].sy_range,
                status: classData[0].sy_status,
                is_active: classData[0].sy_is_active
            },
            students: students || [],
            quarters: quarters || [],
            scores: scores || [],
            competitiveMatches: competitiveMatches || [],
            leaderboardHistory: leaderboardHistory || [],
            activeSessions: activeSessions || [],
            forumDoneMap,
            calendarEvents: calendarEvents || [],
            whitelists: whitelists || [],
            notifications,
            announcements: classAnnouncements || [],
        });

    } catch (err) {
        console.error('[ERROR] GET /class/:classId', err);
        res.status(500).send('Internal Server Error');
    }
});

// ============================================================
// ENROLLMENT CONFIGURATION (SETTINGS & WHITELIST)
// ============================================================

const uploadWhitelist = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

async function verifyClassOwnership(dbConn, teacherId, classId) {
    const [[c]] = await dbConn.execute(
        `SELECT c.class_id, c.class_name, c.teacher_id, c.sy_id, sy.status AS sy_status, sy.is_active AS sy_is_active 
         FROM classes c 
         LEFT JOIN school_years sy ON c.sy_id = sy.sy_id 
         WHERE c.class_id = ?`, 
        [classId]
    );
    if (!c || (teacherId && c.teacher_id !== teacherId)) {
        const err = new Error("Unauthorized to access this class.");
        err.statusCode = 403;
        throw err;
    }
    return c;
}

async function assertActiveClass(dbConn, teacherId, classId) {
    const c = await verifyClassOwnership(dbConn, teacherId, classId);
    const currentSY = await academicHelper.getCurrentSchoolYear(dbConn);
    if (!currentSY || c.sy_id !== currentSY.sy_id || !c.sy_is_active) {
        const err = new Error("This class belongs to an archived School Year and is read-only. Modifications are not allowed.");
        err.statusCode = 403;
        throw err;
    }
    return c;
}

// 1. Settings (Dates and Capacity)
router.post('/class/:id/settings', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const classId = req.params.id;
        let { enrollment_start, enrollment_end, max_capacity } = req.body;

        await assertActiveClass(conn, req.user.user_id, classId);

        if (enrollment_start && enrollment_end && new Date(enrollment_start) >= new Date(enrollment_end)) {
            return res.status(400).json({ success: false, message: "Start date must be before end date." });
        }

        await conn.beginTransaction();

        const [[cls]] = await conn.execute('SELECT enrolled_count FROM classes WHERE class_id = ? FOR UPDATE', [classId]);
        if (!cls) throw new Error("Class not found.");

        if (max_capacity !== '' && max_capacity !== null && max_capacity !== undefined) {
            max_capacity = Number(max_capacity);
            if (max_capacity < 0) {
                await conn.rollback();
                return res.status(400).json({ success: false, message: "Capacity cannot be negative." });
            }
            if (max_capacity < cls.enrolled_count) {
                await conn.rollback();
                return res.status(400).json({ success: false, message: `Capacity cannot be lower than the current enrolled count (${cls.enrolled_count}).` });
            }
        } else {
            max_capacity = null;
        }

        await conn.execute(
            'UPDATE classes SET enrollment_start = ?, enrollment_end = ?, max_capacity = ? WHERE class_id = ?',
            [enrollment_start || null, enrollment_end || null, max_capacity, classId]
        );

        await conn.commit();
        res.json({ success: true, message: "Settings updated successfully." });
    } catch (err) {
        await conn.rollback();
        console.error(err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
    } finally {
        conn.release();
    }
});

// 2. Upload Whitelist (CSV/Excel)
router.post('/class/:id/whitelist/upload', isTeacher, uploadWhitelist.single('file'), async (req, res) => {
    try {
        const classId = req.params.id;
        await assertActiveClass(db, req.user.user_id, classId);

        if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

        const workbook = new ExcelJS.Workbook();
        let loaded = false;

        try {
            await workbook.xlsx.load(req.file.buffer);
            loaded = true;
        } catch (e) {
            // Fallback for CSV
            try {
                const stream = require('stream');
                const bufferStream = new stream.PassThrough();
                bufferStream.end(req.file.buffer);
                await workbook.csv.read(bufferStream);
                loaded = true;
            } catch (errCsv) {
                console.error("CSV parse error", errCsv);
            }
        }

        if (!loaded) return res.status(400).json({ success: false, message: "Invalid file format. Please upload a valid CSV or XLSX file." });

        const worksheet = workbook.worksheets[0];
        if (!worksheet) return res.status(400).json({ success: false, message: "Invalid file format." });

        const newEntries = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            let email = row.getCell(1).value;
            let student_name = row.getCell(2).value;

            // Handle object types if parsed as rich text/hyperlink
            if (email && typeof email === 'object') email = email.text || email.hyperlink || '';
            if (student_name && typeof student_name === 'object') student_name = student_name.text || student_name.hyperlink || '';

            if (email) {
                email = email.toString().trim().toLowerCase();
                student_name = student_name ? student_name.toString().trim() : null;
                // Anti-Injection sanitization
                if (email.match(/^[=+\-@]/) || (student_name && student_name.match(/^[=+\-@]/))) {
                    return; // skip malicious
                }
                if (email.includes('@')) {
                    newEntries.push({ email, student_name });
                }
            }
        });

        if (newEntries.length === 0) {
            return res.status(400).json({ success: false, message: "No valid entries found." });
        }

        const expirationDate = req.body.expirationDate;
        if (!expirationDate) return res.status(400).json({ success: false, message: "Invitation Expiration Date is required." });

        try {
            const { addedCount, invalidEmails } = await processWhitelistEntries(db, classId, newEntries, expirationDate);
            res.json({
                success: true,
                message: `Successfully sent enrollment invitations to ${addedCount} valid students.`,
                invalidEmails
            });
        } catch (err) {
            console.error('[Teacher Whitelist Helper Error]', err);
            return res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
        }
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
    }
});

// 3. Add Single Whitelist Entry
router.post('/class/:id/whitelist/add', isTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        await assertActiveClass(db, req.user.user_id, classId);

        let { email, student_name, expirationDate } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email is required." });
        if (!expirationDate) return res.status(400).json({ success: false, message: "Expiration Date is required." });

        email = email.trim().toLowerCase();

        if (email.match(/^[=+\-@]/) || (student_name && student_name.match(/^[=+\-@]/))) {
            return res.status(400).json({ success: false, message: "Invalid characters detected." });
        }

        try {
            const { addedCount, invalidEmails } = await processWhitelistEntries(db, classId, [{ email, student_name }], expirationDate);
            if (invalidEmails.length > 0) {
                return res.status(400).json({ success: false, message: "Student is not a registered user." });
            }
            if (addedCount === 0) {
                return res.status(400).json({ success: false, message: "Student is already in the whitelist." });
            }
            res.json({ success: true, message: "Invitation sent successfully." });
        } catch (err) {
            return res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
        }
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
    }
});

// 4. Remove Single Whitelist Entry
router.delete('/class/:id/whitelist/remove', isTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        await assertActiveClass(db, req.user.user_id, classId);

        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email is required." });

        await db.execute('DELETE FROM class_whitelists WHERE class_id = ? AND email = ?', [classId, email]);
        res.json({ success: true, message: "Student removed from whitelist." });
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message, error: err.message });
    }
});


// ============================================================
// PATCH — LOCK TOGGLES
// ============================================================

router.patch('/api/quarter/:qid/lock', isTeacher, async (req, res) => {
    try {
        const { is_locked } = req.body;
        if (is_locked === undefined) throw new Error('is_locked missing');
        await db.execute(`UPDATE quarters SET is_locked = ? WHERE quarter_id = ?`, [is_locked, req.params.qid]);
        if (Number(is_locked) === 1) {
            await db.execute(`UPDATE topics SET is_locked = 1 WHERE quarter_id = ?`, [req.params.qid]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/topic/:tid/lock', isTeacher, async (req, res) => {
    try {
        const { is_locked } = req.body;
        if (is_locked === undefined) throw new Error('is_locked missing');
        const lockVal = (Number(is_locked) === 1 || is_locked === true || is_locked === '1') ? 1 : 0;
        const nowManila = topicScheduleService.getManilaDateTimeString();
        if (lockVal === 0) {
            await db.execute(
                `UPDATE topics
                 SET is_locked = 0,
                     auto_unlock_at = CASE WHEN auto_unlock_at IS NOT NULL AND DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') <= ? THEN NULL ELSE auto_unlock_at END
                 WHERE topic_id = ?`,
                [nowManila, req.params.tid]
            );
        } else {
            await db.execute(
                `UPDATE topics
                 SET is_locked = 1,
                     auto_lock_at = CASE WHEN auto_lock_at IS NOT NULL AND DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') <= ? THEN NULL ELSE auto_lock_at END
                 WHERE topic_id = ?`,
                [nowManila, req.params.tid]
            );
        }
        res.json({ success: true, is_locked: lockVal });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/material/:mid/lock', isTeacher, async (req, res) => {
    try {
        const { is_locked } = req.body;
        if (is_locked === undefined) throw new Error('is_locked missing');
        await db.execute(`UPDATE learning_materials SET is_locked = ? WHERE material_id = ?`, [is_locked, req.params.mid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/assessment/:aid/unlock', isTeacher, async (req, res) => {
    try {
        const { is_unlocked } = req.body;
        if (is_unlocked === undefined) throw new Error('is_unlocked missing');
        const unlockVal = (Number(is_unlocked) === 1 || is_unlocked === true || is_unlocked === '1') ? 1 : 0;
        await db.execute(`UPDATE assessments SET is_unlocked = ? WHERE assessment_id = ?`, [unlockVal, req.params.aid]);

        if (unlockVal === 1) {
            try {
                const [rows] = await db.query(`
                    SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.due_date,
                           cs.student_id, c.subject_id
                    FROM assessments a
                    JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN classes c ON q.subject_id = c.subject_id
                    JOIN class_students cs ON c.class_id = cs.class_id
                    WHERE a.assessment_id = ?
                `, [req.params.aid]);

                if (rows && rows.length > 0) {
                    const studentIds = [...new Set(rows.map(r => r.student_id))];
                    const meta = rows[0];
                    const dueStr = meta.due_date ? ` (Due: ${new Date(meta.due_date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '';

                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user.user_id,
                        role: 'Student',
                        category: 'assessment',
                        priority: 'high',
                        eventType: 'assessment_unlocked',
                        title: `Assessment Unlocked: ${meta.assessment_name}`,
                        message: `The ${meta.assessment_type || 'Arcade'} assessment "${meta.assessment_name}" is now unlocked and available to complete${dueStr}.`,
                        targetUrl: `/subjects/open/${meta.subject_id}?tab=assessments&assessment_id=${meta.assessment_id}#asgn-card-${meta.assessment_id}`,
                        metadata: { assessmentId: meta.assessment_id, subjectId: meta.subject_id }
                    });
                }
            } catch (notifErr) {
                console.error('[Notification Dispatch Error on Assessment Unlock]', notifErr.message);
            }
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/announcement/:aid/priority', isTeacher, async (req, res) => {
    try {
        const { is_priority } = req.body;
        if (is_priority === undefined) throw new Error('is_priority missing');

        // RBAC / IDOR Protection: Verify author, class teacher, or Admin
        const [[ann]] = await db.query(
            `SELECT a.announcement_id, a.teacher_id, c.teacher_id AS class_teacher_id
             FROM announcements a
             LEFT JOIN classes c ON a.class_id = c.class_id
             WHERE a.announcement_id = ?`,
            [req.params.aid]
        );

        if (!ann) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        const isAuthor = Number(ann.teacher_id) === Number(req.user.user_id);
        const isClassTeacher = ann.class_teacher_id && Number(ann.class_teacher_id) === Number(req.user.user_id);
        const isAdmin = req.user.role === 'Admin';

        if (!isAuthor && !isClassTeacher && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized: You do not have permission to modify this announcement.' });
        }

        await db.execute(
            `UPDATE announcements SET is_priority = ? WHERE announcement_id = ?`,
            [is_priority ? 1 : 0, req.params.aid]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: PATCH /api/forum/:id/pin is defined below with ownership validation.


// ============================================================
// TOPIC — GET MATERIALS / POST / PUT / DELETE
// ============================================================

function normalizeScheduleDateTime(rawVal) {
    if (rawVal === undefined || rawVal === null) return null;
    const str = String(rawVal).trim();
    if (!str) return null;
    const normalized = str.replace('T', ' ');
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) {
        throw new Error('Invalid schedule date/time format.');
    }
    return normalized.length === 16 ? `${normalized}:00` : normalized;
}

router.get('/api/topic/:tid/materials', isTeacher, async (req, res) => {
    try {
        const topicId = parseInt(req.params.tid, 10);
        if (isNaN(topicId)) return res.status(400).json({ success: false, error: 'Invalid topic_id' });
        const [materials] = await db.query(
            `SELECT material_id, topic_id, title, material_type, file_path_or_url, is_locked, uploaded_by
             FROM learning_materials
             WHERE topic_id = ?
             ORDER BY material_id ASC`,
            [topicId]
        );
        res.json({ success: true, materials });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/api/topic', isTeacher, async (req, res) => {
    try {
        const { quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at } = req.body;
        if (!quarter_id) throw new Error('quarter_id missing');
        if (!topic_name || !String(topic_name).trim()) throw new Error('topic_name missing');
        if (!topic_description || !String(topic_description).trim()) throw new Error('topic_description missing');
        if (!topic_objectives || !String(topic_objectives).trim()) throw new Error('topic_objectives missing');
        if (!video_url || !String(video_url).trim()) throw new Error('video_url missing');

        const sched = topicScheduleService.prepareTopicSchedulePayload({
            is_locked,
            auto_unlock_at,
            auto_lock_at,
            fallbackLocked: 1
        });

        const [result] = await db.execute(
            `INSERT INTO topics (quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                quarter_id,
                String(topic_name).trim(),
                String(topic_description).trim(),
                String(topic_objectives).trim(),
                String(video_url).trim(),
                sched.is_locked,
                sched.auto_unlock_at,
                sched.auto_lock_at
            ]
        );

        res.json({
            success: true,
            topic_id: result.insertId,
            is_locked: sched.is_locked,
            auto_unlock_at: sched.auto_unlock_at,
            auto_lock_at: sched.auto_lock_at
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/api/topic/:tid', isTeacher, async (req, res) => {
    try {
        const { topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at } = req.body;
        if (!topic_name || !String(topic_name).trim()) throw new Error('topic_name missing');
        if (!topic_description || !String(topic_description).trim()) throw new Error('topic_description missing');
        if (!topic_objectives || !String(topic_objectives).trim()) throw new Error('topic_objectives missing');
        if (!video_url || !String(video_url).trim()) throw new Error('video_url missing');

        const [[existing]] = await db.query(
            `SELECT topic_id, is_locked,
                    DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') AS auto_unlock_at,
                    DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') AS auto_lock_at
             FROM topics WHERE topic_id = ?`,
            [req.params.tid]
        );
        if (!existing) return res.status(404).json({ success: false, error: 'Topic not found' });

        const sched = topicScheduleService.prepareTopicSchedulePayload({
            is_locked: is_locked !== undefined ? is_locked : existing.is_locked,
            auto_unlock_at: auto_unlock_at !== undefined ? auto_unlock_at : existing.auto_unlock_at,
            auto_lock_at: auto_lock_at !== undefined ? auto_lock_at : existing.auto_lock_at,
            fallbackLocked: Number(existing.is_locked)
        });

        await db.execute(
            `UPDATE topics
             SET topic_name = ?, topic_description = ?, topic_objectives = ?, video_url = ?,
                 is_locked = ?, auto_unlock_at = ?, auto_lock_at = ?
             WHERE topic_id = ?`,
            [
                String(topic_name).trim(),
                String(topic_description).trim(),
                String(topic_objectives).trim(),
                String(video_url).trim(),
                sched.is_locked,
                sched.auto_unlock_at,
                sched.auto_lock_at,
                req.params.tid
            ]
        );

        res.json({
            success: true,
            topic_id: Number(req.params.tid),
            is_locked: sched.is_locked,
            auto_unlock_at: sched.auto_unlock_at,
            auto_lock_at: sched.auto_lock_at
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/api/topic/:tid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM topics WHERE topic_id = ?`, [req.params.tid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// LEARNING MATERIALS — POST / PUT / DELETE
// ============================================================

// POST /teacher/api/material
// Accepts multipart/form-data.
// Mode 1: file field present  → uploads file to /public/material_uploads/, saves path in DB.
// Mode 2: file_path_or_url    → saves URL string as-is (YouTube, Drive link, etc.)
router.post('/api/material', isTeacher, (req, res) => {
    materialUpload.single('file')(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ success: false, error: uploadErr.message });
        try {
            const { topic_id, title, material_type, file_path_or_url, is_locked } = req.body;
            if (!topic_id) throw new Error('topic_id is required');
            if (!title) throw new Error('title is required');
            if (!material_type) throw new Error('material_type is required');

            let savedPath;
            if (req.file) {
                // Store ONLY the filename — never the path prefix
                savedPath = req.file.filename;
            } else if (file_path_or_url && file_path_or_url.trim()) {
                savedPath = file_path_or_url.trim();
            } else {
                throw new Error('Either upload a file or provide a URL.');
            }

            const [result] = await db.execute(
                `INSERT INTO learning_materials (topic_id, title, material_type, file_path_or_url, is_locked, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
                [topic_id, title, material_type, savedPath, is_locked === '1' || is_locked === 1 ? 1 : 0, req.user.user_id]
            );

            const materialId = result.insertId;

            // Trigger AI Processing in background if it's a supported type
            const ext = savedPath.toLowerCase().match(/\.(pdf|docx|pptx|doc|ppt|jpg|jpeg|png|webp|heic|heif)$/);
            if (req.file && ext) {
                const aiService = require('../services/aiService');
                aiService.processMaterialWithAI(req.file.path, db, materialId).catch(console.error);
            }

            // Notify Enrolled Students in this class
            try {
                const [students] = await db.query(`
                    SELECT c.class_id, cs.student_id, s.subject_name, t.topic_name
                    FROM topics t
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN subjects s ON q.subject_id = s.subject_id
                    JOIN classes c ON s.subject_id = c.subject_id
                    JOIN class_students cs ON c.class_id = cs.class_id
                    WHERE t.topic_id = ?
                `, [topic_id]);

                if (students.length > 0) {
                    const studentIds = [...new Set(students.map(s => s.student_id))];
                    const classId = students[0].class_id;
                    const subjectName = students[0].subject_name || 'Subject';
                    const topicName = students[0].topic_name || 'Topic';
                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user ? req.user.user_id : null,
                        role: 'Student',
                        category: 'academic',
                        priority: 'normal',
                        eventType: 'material_uploaded',
                        title: `New Material: ${title}`,
                        message: `New learning material was posted for ${topicName} in ${subjectName}.`,
                        targetUrl: `/subjects/open/${classId}`,
                        metadata: { materialId, topicId: topic_id, classId }
                    });
                }
            } catch (notifErr) {
                console.error('[Material Upload Notification Error]', notifErr.message);
            }

            res.json({ success: true, file_path_or_url: savedPath });
        } catch (e) {
            if (req.file) fs.unlink(req.file.path, () => { });
            console.error('[MATERIAL POST]', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
});

// PUT /teacher/api/material/:mid
// Same dual-mode as POST: new file upload OR new URL OR keep existing path.
router.put('/api/material/:mid', isTeacher, (req, res) => {
    materialUpload.single('file')(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ success: false, error: uploadErr.message });
        try {
            const { title, material_type, file_path_or_url, is_locked } = req.body;
            const mid = req.params.mid;
            if (!title) throw new Error('title is required');

            const [[existing]] = await db.execute(
                `SELECT file_path_or_url FROM learning_materials WHERE material_id = ?`, [mid]
            );
            if (!existing) return res.status(404).json({ success: false, error: 'Material not found' });

            // Normalize helper: strip any leading /material_uploads/ prefix
            // so we always store just the bare filename in the DB.
            const bareFilename = (p) => p ? p.replace(/^\/?material_uploads\//, '') : p;

            let savedPath;
            if (req.file) {
                // Store ONLY the filename
                savedPath = req.file.filename;
                // Delete old local file if it was an upload (not a URL)
                const oldRaw = existing.file_path_or_url;
                if (oldRaw && !oldRaw.startsWith('http')) {
                    const oldFile = path.join(__dirname, '..', 'public', 'material_uploads', bareFilename(oldRaw));
                    fs.unlink(oldFile, () => { });
                }
            } else if (file_path_or_url && file_path_or_url.trim()) {
                savedPath = file_path_or_url.trim();
            } else {
                savedPath = existing.file_path_or_url; // keep existing
            }

            await db.execute(
                `UPDATE learning_materials SET title = ?, material_type = ?, file_path_or_url = ?, is_locked = ? WHERE material_id = ?`,
                [title, material_type, savedPath, is_locked === '1' || is_locked === 1 ? 1 : 0, mid]
            );
            res.json({ success: true, file_path_or_url: savedPath });
        } catch (e) {
            if (req.file) fs.unlink(req.file.path, () => { });
            console.error('[MATERIAL PUT]', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
});

router.delete('/api/material/:mid', isTeacher, async (req, res) => {
    try {
        const mid = req.params.mid;
        const [[mat]] = await db.query(
            `SELECT material_id, material_type, file_path_or_url FROM learning_materials WHERE material_id = ?`,
            [mid]
        );
        if (mat) {
            // Delete linked interactions and clear remediation references
            await db.query(`DELETE FROM student_material_interactions WHERE material_id = ?`, [mid]);
            await db.query(`UPDATE remediation_materials SET material_id = NULL WHERE material_id = ?`, [mid]);

            // Delete physical file from both potential storage directories
            if (mat.material_type !== 'link' && mat.file_path_or_url) {
                const bareName = mat.file_path_or_url.replace(/^\/?material_uploads\//, '');
                const p1 = path.join(__dirname, '..', 'public', 'material_uploads', bareName);
                const p2 = path.join(__dirname, '..', 'material_uploads', bareName);
                if (fs.existsSync(p1)) fs.unlink(p1, () => { });
                if (fs.existsSync(p2)) fs.unlink(p2, () => { });
            }
        }
        await db.execute(`DELETE FROM learning_materials WHERE material_id = ?`, [mid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// ASSESSMENTS — POST / PUT / DELETE
// ============================================================
const {
    LEVEL_MACHINES,
    TOPIC_LEVEL_MAP,
    LEVEL_TOPIC_MAP,
    resolveLevelFromTopicName,
    resolveLevelForTopicId,
    resolveTopicIdForLevel
} = require('../utils/elementaTopicLevelHelper');

// GET available Elementa questions pool for a topic (with question shortage detection)
router.get('/api/topic-questions-pool/:topic_id', isTeacher, async (req, res) => {
    try {
        const topicId = parseInt(req.params.topic_id, 10);
        const levelNumber = await resolveLevelForTopicId(db, topicId);
        const [questions] = await db.query(
            `SELECT question_id, question_code, level_number, topic, machine_name,
                    prompt, answer_text, time_limit_s, points
             FROM elementa_questions
             WHERE (topic_id = ? OR (level_number IS NOT NULL AND level_number = ?))
               AND is_active = 1 AND verification_status = 'Approved'
             ORDER BY display_order ASC, question_id ASC`,
            [topicId, levelNumber]
        );
        res.json({
            success: true,
            topic_id: topicId,
            level_number: levelNumber,
            count: questions.length,
            questions: questions
        });
    } catch (e) {
        console.error('[GET /api/topic-questions-pool/:topic_id]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/api/assessment/:aid', isTeacher, async (req, res) => {
    try {
        const [[asmt]] = await db.query(
            `SELECT a.*, t.topic_name, CONCAT('Quarter ', q.quarter_number) AS quarter_name
             FROM assessments a
             LEFT JOIN topics t ON t.topic_id = a.topic_id
             LEFT JOIN quarters q ON q.quarter_id = a.quarter_id
             WHERE a.assessment_id = ?`,
            [req.params.aid]
        );
        if (!asmt) return res.status(404).json({ success: false, error: 'Assessment not found' });

        const [manualQuestions] = await db.query(
            `SELECT eaq.eaq_id, eaq.question_id, eaq.sort_order, eaq.custom_points,
                    eq.question_code, eq.machine_name, eq.prompt, eq.answer_text, eq.time_limit_s, eq.points AS base_points
             FROM elementa_assessment_questions eaq
             JOIN elementa_questions eq ON eq.question_id = eaq.question_id
             WHERE eaq.assessment_id = ?
             ORDER BY eaq.sort_order ASC`,
            [req.params.aid]
        );
        asmt.manual_questions = manualQuestions || [];

        res.json({ success: true, assessment: asmt });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/api/assessment', isTeacher, async (req, res) => {
    try {
        const {
            topic_id, quarter_id, assessment_name, assessment_type,
            total_items = 10, duration_minutes = 30, timer_type = 'Global',
            start_date, due_date, is_unlocked = 1, competitive_enabled = 0,
            question_selection_mode = 'random', selected_questions = []
        } = req.body;
        if (!topic_id || !assessment_name || !assessment_type) throw new Error('Missing required fields');
        const [result] = await db.execute(
            `INSERT INTO assessments 
             (quarter_id, topic_id, assessment_name, assessment_type, total_items, duration_minutes, timer_type, is_unlocked, start_date, due_date, competitive_enabled, question_selection_mode, teacher_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                quarter_id || null,
                topic_id,
                assessment_name,
                assessment_type,
                Number(total_items) || 10,
                Number(duration_minutes) || 30,
                timer_type || 'Global',
                Number(is_unlocked) || 1,
                start_date || null,
                due_date || null,
                Number(competitive_enabled) || 0,
                question_selection_mode === 'manual' ? 'manual' : 'random',
                req.user.user_id
            ]
        );
        const newAssessmentId = result.insertId;

        // If manual selection mode, save selected questions into elementa_assessment_questions
        if (question_selection_mode === 'manual' && Array.isArray(selected_questions) && selected_questions.length > 0) {
            for (let i = 0; i < selected_questions.length; i++) {
                const sq = selected_questions[i];
                await db.execute(
                    `INSERT INTO elementa_assessment_questions (assessment_id, question_id, sort_order, custom_points)
                     VALUES (?, ?, ?, ?)`,
                    [newAssessmentId, parseInt(sq.question_id, 10), i + 1, parseInt(sq.custom_points, 10) || 1]
                );
            }
        }

        // Dispatch in-app notification to all enrolled students
        if (Number(is_unlocked) !== 0) {
            try {
                const [students] = await db.query(`
                    SELECT DISTINCT cs.student_id, c.subject_id
                    FROM topics t
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN classes c ON q.subject_id = c.subject_id
                    JOIN class_students cs ON c.class_id = cs.class_id
                    WHERE t.topic_id = ?
                `, [topic_id]);

                if (students.length > 0) {
                    const studentIds = [...new Set(students.map(s => s.student_id))];
                    const subjectId = students[0].subject_id;
                    const dueStr = due_date ? ` (Due: ${new Date(due_date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '';

                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user.user_id,
                        role: 'Student',
                        category: 'assessment',
                        priority: 'high',
                        eventType: 'assessment_published',
                        title: `New Assessment: ${assessment_name}`,
                        message: `A new ${assessment_type} has been assigned${dueStr}. Click to view details.`,
                        targetUrl: `/subjects/open/${subjectId}?tab=assessments&assessment_id=${newAssessmentId}#asgn-card-${newAssessmentId}`,
                        metadata: { assessmentId: newAssessmentId, subjectId }
                    });
                }
            } catch (notifErr) {
                console.error('[Notification Dispatch Error on Assessment Create]', notifErr.message);
            }
        }

        res.json({ success: true, assessment_id: newAssessmentId });
    } catch (e) {
        console.error('[POST /api/assessment]', e);
        res.status(500).json({ error: e.message });
    }
});

router.put('/api/assessment/:aid', isTeacher, async (req, res) => {
    try {
        const {
            assessment_name, assessment_type, total_items = 10,
            duration_minutes = 30, timer_type = 'Global',
            start_date, due_date, is_unlocked, competitive_enabled,
            question_selection_mode = 'random', selected_questions = []
        } = req.body;
        if (!assessment_name) throw new Error('assessment_name missing');
        const aid = req.params.aid;
        const [[prevAssessment]] = await db.query('SELECT is_unlocked FROM assessments WHERE assessment_id = ?', [aid]);

        await db.execute(
            `UPDATE assessments 
             SET assessment_name = ?, 
                 assessment_type = ?, 
                 total_items = ?, 
                 duration_minutes = ?, 
                 timer_type = ?, 
                 start_date = ?, 
                 due_date = ?, 
                 is_unlocked = COALESCE(?, is_unlocked), 
                 competitive_enabled = COALESCE(?, competitive_enabled),
                 question_selection_mode = ?
             WHERE assessment_id = ?`,
            [
                assessment_name,
                assessment_type,
                Number(total_items) || 10,
                Number(duration_minutes) || 30,
                timer_type || 'Global',
                start_date || null,
                due_date || null,
                is_unlocked !== undefined && is_unlocked !== null ? Number(is_unlocked) : null,
                competitive_enabled !== undefined && competitive_enabled !== null ? Number(competitive_enabled) : null,
                question_selection_mode === 'manual' ? 'manual' : 'random',
                aid
            ]
        );

        // Always sync manual questions table
        await db.execute(`DELETE FROM elementa_assessment_questions WHERE assessment_id = ?`, [aid]);
        if (question_selection_mode === 'manual' && Array.isArray(selected_questions) && selected_questions.length > 0) {
            for (let i = 0; i < selected_questions.length; i++) {
                const sq = selected_questions[i];
                await db.execute(
                    `INSERT INTO elementa_assessment_questions (assessment_id, question_id, sort_order, custom_points)
                     VALUES (?, ?, ?, ?)`,
                    [aid, parseInt(sq.question_id, 10), i + 1, parseInt(sq.custom_points, 10) || 1]
                );
            }
        }

        // If newly unlocked during edit, dispatch in-app notification
        if (prevAssessment && Number(prevAssessment.is_unlocked) === 0 && (Number(is_unlocked) === 1 || is_unlocked === true)) {
            try {
                const [rows] = await db.query(`
                    SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.due_date,
                           cs.student_id, c.subject_id
                    FROM assessments a
                    JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN classes c ON q.subject_id = c.subject_id
                    JOIN class_students cs ON c.class_id = cs.class_id
                    WHERE a.assessment_id = ?
                `, [aid]);

                if (rows && rows.length > 0) {
                    const studentIds = [...new Set(rows.map(r => r.student_id))];
                    const meta = rows[0];
                    const dueStr = due_date ? ` (Due: ${new Date(due_date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '';

                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user.user_id,
                        role: 'Student',
                        category: 'assessment',
                        priority: 'high',
                        eventType: 'assessment_unlocked',
                        title: `Assessment Unlocked: ${assessment_name}`,
                        message: `The ${assessment_type || 'Arcade'} assessment "${assessment_name}" is now unlocked and available to complete${dueStr}.`,
                        targetUrl: `/subjects/open/${meta.subject_id}?tab=assessments&assessment_id=${aid}#asgn-card-${aid}`,
                        metadata: { assessmentId: aid, subjectId: meta.subject_id }
                    });
                }
            } catch (notifErr) {
                console.error('[Notification Dispatch Error on Assessment Edit Unlock]', notifErr.message);
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[PUT /api/assessment/:aid]', e);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/api/assessment/:aid', isTeacher, async (req, res) => {
    try {
        const aid = req.params.aid;
        await db.execute(`UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id = ?`, [aid]);
        await db.execute(`DELETE FROM elementa_assessment_questions WHERE assessment_id = ?`, [aid]).catch(() => { });
        await db.execute(`DELETE FROM elementa_assessment_tickets WHERE assessment_id = ?`, [aid]).catch(() => { });
        await db.execute(`DELETE FROM student_scores      WHERE assessment_id = ?`, [aid]).catch(() => { });
        await db.execute(`DELETE FROM assessments         WHERE assessment_id = ?`, [aid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ASSIGNMENTS — POST / GET / PUT / DELETE (Enterprise Assignment Management)
// ============================================================

router.post('/api/assignment', isTeacher, assignmentAssetUpload.fields([
    { name: 'format_file', maxCount: 1 },
    { name: 'sample_output', maxCount: 1 },
    { name: 'sample_file', maxCount: 1 }
]), async (req, res) => {
    try {
        const {
            topic_id, quarter_id, assessment_name, total_items, due_date,
            category, objectives, description, instructions,
            allowed_extensions, max_file_size_mb, target_audience,
            target_sections, target_students,
            is_group_assignment, group_set_id, group_submission_mode, group_grading_mode,
            allow_resubmission, max_attempts,
            allow_grace, grace_period_minutes, min_word_count, max_word_count,
            disallow_blank_pages, rubric_title
        } = req.body;

        if (!topic_id || !assessment_name) {
            return res.status(400).json({ success: false, error: 'Topic and Assignment Title are required' });
        }

        let rubricCriteria = [];
        if (req.body.rubric_criteria) {
            try {
                rubricCriteria = typeof req.body.rubric_criteria === 'string'
                    ? JSON.parse(req.body.rubric_criteria)
                    : req.body.rubric_criteria;
            } catch (e) {
                console.warn('[Rubric Criteria Parse Warning]', e.message);
            }
        }

        let formatFilePath = null;
        let formatFileName = null;
        if (req.files && req.files['format_file'] && req.files['format_file'][0]) {
            formatFilePath = '/assignment_templates/' + req.files['format_file'][0].filename;
            formatFileName = req.files['format_file'][0].originalname;
        }

        let sampleFilePath = null;
        let sampleFileName = null;
        const sampleFileObj = req.files && (req.files['sample_output']?.[0] || req.files['sample_file']?.[0]);
        if (sampleFileObj) {
            sampleFilePath = '/assignment_samples/' + sampleFileObj.filename;
            sampleFileName = sampleFileObj.originalname;
        }

        const isGroup = (is_group_assignment == 1 || is_group_assignment === 'true' || is_group_assignment === true) ? 1 : 0;
        const subMode = group_submission_mode || req.body.group_submission_policy || 'one_per_group';
        const gradMode = group_grading_mode || (req.body.group_grading_policy === 'individual' ? 'individual_grade' : 'shared_grade');
        let parsedGroupSetId = group_set_id ? Number(group_set_id) : null;
        if (isGroup && (!parsedGroupSetId || isNaN(parsedGroupSetId))) {
            const [[firstSet]] = await db.query(
                `SELECT gs.group_set_id FROM group_sets gs 
                 JOIN classes c ON gs.class_id = c.class_id 
                 JOIN quarters q ON q.subject_id = c.subject_id 
                 JOIN topics t ON t.quarter_id = q.quarter_id 
                 WHERE t.topic_id = ? ORDER BY gs.created_at DESC LIMIT 1`,
                [topic_id]
            );
            if (firstSet) parsedGroupSetId = firstSet.group_set_id;
        }

        const insertParams = [
            quarter_id || null,
            topic_id,
            assessment_name,
            Number(total_items) || 100,
            due_date || null,
            req.user.user_id,
            category || 'Homework',
            objectives || null,
            description || null,
            instructions || null,
            formatFilePath || null,
            formatFileName || null,
            sampleFilePath || null,
            sampleFileName || null,
            allowed_extensions || '.pdf,.docx,.doc,.xlsx,.pptx,.zip,.png,.jpg',
            Number(max_file_size_mb) || 25,
            target_audience || 'everyone',
            isGroup,
            (parsedGroupSetId && !isNaN(parsedGroupSetId)) ? Number(parsedGroupSetId) : null,
            subMode || 'one_per_group',
            gradMode || 'shared_grade',
            (allow_resubmission == 1 || allow_resubmission === 'true' || allow_resubmission === true) ? 1 : 0,
            Number(max_attempts) || 1,
            allow_grace !== undefined ? (allow_grace == 1 || allow_grace === 'true' || allow_grace === true ? 1 : 0) : 1,
            Number(grace_period_minutes) || 5,
            min_word_count ? Number(min_word_count) : null,
            max_word_count ? Number(max_word_count) : null,
            disallow_blank_pages !== undefined ? (disallow_blank_pages == 1 || disallow_blank_pages === 'true' || disallow_blank_pages === true ? 1 : 0) : 1
        ].map(val => (val === undefined ? null : val));

        const [result] = await db.execute(
            `INSERT INTO assessments 
             (quarter_id, topic_id, assessment_name, assessment_type, total_items, duration_minutes, timer_type, is_unlocked, due_date, teacher_id,
              category, objectives, description, instructions, format_file_path, format_file_name, sample_file_path, sample_file_name,
              allowed_extensions, max_file_size_mb, target_audience, is_group_assignment, group_set_id, group_submission_mode, group_grading_mode,
              allow_resubmission, max_attempts, allow_grace, grace_period_minutes, min_word_count, max_word_count, disallow_blank_pages)
             VALUES (?, ?, ?, 'Assignment', ?, 0, 'Global', 1, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?)`,
            insertParams
        );

        const assignmentId = result.insertId;

        // Populate assignment_audiences junction table
        if (target_audience === 'sections' && target_sections) {
            const secIds = Array.isArray(target_sections) ? target_sections : String(target_sections).split(',').map(s => s.trim()).filter(Boolean);
            for (const sid of secIds) {
                await db.execute(`INSERT INTO assignment_audiences (assessment_id, class_id) VALUES (?, ?)`, [assignmentId, sid]);
            }
        } else if (target_audience === 'students' && target_students) {
            const stuIds = Array.isArray(target_students) ? target_students : String(target_students).split(',').map(s => s.trim()).filter(Boolean);
            for (const sid of stuIds) {
                await db.execute(`INSERT INTO assignment_audiences (assessment_id, student_id) VALUES (?, ?)`, [assignmentId, sid]);
            }
        }

        // If rubric criteria are provided, create rubric
        if (rubricCriteria && Array.isArray(rubricCriteria) && rubricCriteria.length > 0) {
            const [rubricResult] = await db.execute(
                `INSERT INTO rubrics (assessment_id, title) VALUES (?, ?)`,
                [assignmentId, rubric_title || `${assessment_name} Rubric`]
            );
            const rubricId = rubricResult.insertId;

            for (let i = 0; i < rubricCriteria.length; i++) {
                const crit = rubricCriteria[i];
                if (crit.title) {
                    await db.execute(
                        `INSERT INTO rubric_criteria (rubric_id, title, description, max_points, sort_order) VALUES (?, ?, ?, ?, ?)`,
                        [rubricId, crit.title, crit.description || '', Number(crit.max_points) || 10, i + 1]
                    );
                }
            }
        }

        res.json({ success: true, assignment_id: assignmentId });
    } catch (e) {
        console.error('[POST /api/assignment]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/api/assignment/:aid', isTeacher, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT a.*, r.rubric_id, r.title AS rubric_title
             FROM assessments a
             LEFT JOIN rubrics r ON r.assessment_id = a.assessment_id
             WHERE a.assessment_id = ? AND a.assessment_type = 'Assignment'`,
            [req.params.aid]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Assignment not found' });

        const assignment = rows[0];

        // Fetch criteria
        let criteria = [];
        if (assignment.rubric_id) {
            const [crits] = await db.query(
                `SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC`,
                [assignment.rubric_id]
            );
            criteria = crits;
        }
        assignment.criteria = criteria;

        // Fetch target audiences
        const [audiences] = await db.query(
            `SELECT class_id, student_id FROM assignment_audiences WHERE assessment_id = ?`,
            [assignment.assessment_id]
        );
        assignment.target_sections = audiences.filter(a => a.class_id).map(a => a.class_id);
        assignment.target_students = audiences.filter(a => a.student_id).map(a => a.student_id);

        res.json({ success: true, assignment });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/api/assignment/:aid', isTeacher, assignmentAssetUpload.fields([
    { name: 'format_file', maxCount: 1 },
    { name: 'sample_output', maxCount: 1 },
    { name: 'sample_file', maxCount: 1 }
]), async (req, res) => {
    try {
        const aid = req.params.aid;
        const {
            assessment_name, total_items, due_date,
            category, objectives, description, instructions,
            allowed_extensions, max_file_size_mb, target_audience,
            target_sections, target_students,
            is_group_assignment, group_set_id, group_submission_mode, group_grading_mode,
            allow_resubmission, max_attempts,
            allow_grace, grace_period_minutes, min_word_count, max_word_count,
            disallow_blank_pages, rubric_title,
            remove_format_file, remove_sample_file
        } = req.body;

        if (!assessment_name) return res.status(400).json({ success: false, error: 'Assignment Title is required' });

        // Fetch current assignment files to handle replacement or removal
        const [[currentAsgn]] = await db.query(
            `SELECT format_file_path, format_file_name, sample_file_path, sample_file_name FROM assessments WHERE assessment_id = ?`,
            [aid]
        );

        let formatFilePath = (currentAsgn && currentAsgn.format_file_path) ? currentAsgn.format_file_path : null;
        let formatFileName = (currentAsgn && currentAsgn.format_file_name) ? currentAsgn.format_file_name : null;
        if (req.files && req.files['format_file'] && req.files['format_file'][0]) {
            if (currentAsgn && currentAsgn.format_file_path) {
                const oldPath = path.join(__dirname, '..', 'public', currentAsgn.format_file_path);
                if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) { }
            }
            formatFilePath = '/assignment_templates/' + req.files['format_file'][0].filename;
            formatFileName = req.files['format_file'][0].originalname;
        } else if (remove_format_file == 1 || remove_format_file === 'true') {
            if (currentAsgn && currentAsgn.format_file_path) {
                const oldPath = path.join(__dirname, '..', 'public', currentAsgn.format_file_path);
                if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) { }
            }
            formatFilePath = null;
            formatFileName = null;
        }

        let sampleFilePath = (currentAsgn && currentAsgn.sample_file_path) ? currentAsgn.sample_file_path : null;
        let sampleFileName = (currentAsgn && currentAsgn.sample_file_name) ? currentAsgn.sample_file_name : null;
        const sampleFileObj = req.files && (req.files['sample_output']?.[0] || req.files['sample_file']?.[0]);
        if (sampleFileObj) {
            if (currentAsgn && currentAsgn.sample_file_path) {
                const oldPath = path.join(__dirname, '..', 'public', currentAsgn.sample_file_path);
                if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) { }
            }
            sampleFilePath = '/assignment_samples/' + sampleFileObj.filename;
            sampleFileName = sampleFileObj.originalname;
        } else if (remove_sample_file == 1 || remove_sample_file === 'true') {
            if (currentAsgn && currentAsgn.sample_file_path) {
                const oldPath = path.join(__dirname, '..', 'public', currentAsgn.sample_file_path);
                if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) { }
            }
            sampleFilePath = null;
            sampleFileName = null;
        }

        let rubricCriteria = [];
        if (req.body.rubric_criteria) {
            try {
                rubricCriteria = typeof req.body.rubric_criteria === 'string'
                    ? JSON.parse(req.body.rubric_criteria)
                    : req.body.rubric_criteria;
            } catch (e) {
                console.warn('[Rubric Criteria Parse Warning]', e.message);
            }
        }

        const isGroup = (is_group_assignment == 1 || is_group_assignment === 'true' || is_group_assignment === true) ? 1 : 0;
        const subMode = group_submission_mode || req.body.group_submission_policy || 'one_per_group';
        const gradMode = group_grading_mode || (req.body.group_grading_policy === 'individual' ? 'individual_grade' : 'shared_grade');
        let parsedGroupSetId = group_set_id ? Number(group_set_id) : null;
        if (isGroup && (!parsedGroupSetId || isNaN(parsedGroupSetId))) {
            const [[firstSet]] = await db.query(
                `SELECT gs.group_set_id FROM group_sets gs 
                 JOIN classes c ON gs.class_id = c.class_id 
                 JOIN quarters q ON q.subject_id = c.subject_id 
                 JOIN topics t ON t.quarter_id = q.quarter_id 
                 JOIN assessments a ON a.topic_id = t.topic_id
                 WHERE a.assessment_id = ? ORDER BY gs.created_at DESC LIMIT 1`,
                [aid]
            );
            if (firstSet) parsedGroupSetId = firstSet.group_set_id;
        }

        const updateParams = [
            assessment_name,
            Number(total_items) || 100,
            due_date || null,
            category || 'Homework',
            objectives || null,
            description || null,
            instructions || null,
            formatFilePath || null,
            formatFileName || null,
            sampleFilePath || null,
            sampleFileName || null,
            allowed_extensions || '.pdf,.docx,.doc,.xlsx,.pptx,.zip,.png,.jpg',
            Number(max_file_size_mb) || 25,
            target_audience || 'everyone',
            isGroup,
            (parsedGroupSetId && !isNaN(parsedGroupSetId)) ? Number(parsedGroupSetId) : null,
            subMode || 'one_per_group',
            gradMode || 'shared_grade',
            (allow_resubmission == 1 || allow_resubmission === 'true' || allow_resubmission === true) ? 1 : 0,
            Number(max_attempts) || 1,
            allow_grace !== undefined ? (allow_grace == 1 || allow_grace === 'true' || allow_grace === true ? 1 : 0) : 1,
            Number(grace_period_minutes) || 5,
            min_word_count ? Number(min_word_count) : null,
            max_word_count ? Number(max_word_count) : null,
            disallow_blank_pages !== undefined ? (disallow_blank_pages == 1 || disallow_blank_pages === 'true' || disallow_blank_pages === true ? 1 : 0) : 1,
            aid
        ].map(val => (val === undefined ? null : val));

        await db.execute(
            `UPDATE assessments SET 
             assessment_name = ?, total_items = ?, due_date = ?,
             category = ?, objectives = ?, description = ?, instructions = ?,
             format_file_path = ?, format_file_name = ?,
             sample_file_path = ?, sample_file_name = ?,
             allowed_extensions = ?, max_file_size_mb = ?, target_audience = ?,
             is_group_assignment = ?, group_set_id = ?, group_submission_mode = ?, group_grading_mode = ?,
             allow_resubmission = ?, max_attempts = ?,
             allow_grace = ?, grace_period_minutes = ?, min_word_count = ?, max_word_count = ?, disallow_blank_pages = ?
             WHERE assessment_id = ?`,
            updateParams
        );

        // Update target audiences
        await db.execute(`DELETE FROM assignment_audiences WHERE assessment_id = ?`, [aid]);
        if (target_audience === 'sections' && target_sections) {
            const secIds = Array.isArray(target_sections) ? target_sections : String(target_sections).split(',').map(s => s.trim()).filter(Boolean);
            for (const sid of secIds) {
                await db.execute(`INSERT INTO assignment_audiences (assessment_id, class_id) VALUES (?, ?)`, [aid, sid]);
            }
        } else if (target_audience === 'students' && target_students) {
            const stuIds = Array.isArray(target_students) ? target_students : String(target_students).split(',').map(s => s.trim()).filter(Boolean);
            for (const sid of stuIds) {
                await db.execute(`INSERT INTO assignment_audiences (assessment_id, student_id) VALUES (?, ?)`, [aid, sid]);
            }
        }

        // Update rubrics & criteria
        if (rubricCriteria && Array.isArray(rubricCriteria)) {
            const [rRows] = await db.query(`SELECT rubric_id FROM rubrics WHERE assessment_id = ?`, [aid]);
            let rubricId;
            if (rRows.length > 0) {
                rubricId = rRows[0].rubric_id;
                if (rubric_title) {
                    await db.query(`UPDATE rubrics SET title = ? WHERE rubric_id = ?`, [rubric_title, rubricId]);
                }
                await db.query(`DELETE FROM rubric_criteria WHERE rubric_id = ?`, [rubricId]);
            } else if (rubricCriteria.length > 0) {
                const [rRes] = await db.execute(`INSERT INTO rubrics (assessment_id, title) VALUES (?, ?)`, [aid, rubric_title || `${assessment_name} Rubric`]);
                rubricId = rRes.insertId;
            }

            if (rubricId) {
                for (let i = 0; i < rubricCriteria.length; i++) {
                    const crit = rubricCriteria[i];
                    if (crit.title) {
                        await db.execute(
                            `INSERT INTO rubric_criteria (rubric_id, title, description, max_points, sort_order) VALUES (?, ?, ?, ?, ?)`,
                            [rubricId, crit.title, crit.description || '', Number(crit.max_points) || 10, i + 1]
                        );
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[PUT /api/assignment/:aid]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/api/assignment/:aid', isTeacher, async (req, res) => {
    try {
        const aid = req.params.aid;

        // Fetch format and sample files to delete from disk
        const [[asgn]] = await db.query(
            `SELECT format_file_path, sample_file_path FROM assessments WHERE assessment_id = ?`,
            [aid]
        );
        if (asgn) {
            if (asgn.format_file_path) {
                const p = path.join(__dirname, '..', 'public', asgn.format_file_path);
                if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) { }
            }
            if (asgn.sample_file_path) {
                const p = path.join(__dirname, '..', 'public', asgn.sample_file_path);
                if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) { }
            }
        }

        // Fetch all student submission files to delete from disk (if table exists)
        try {
            const [scoreFiles] = await db.query(
                `SELECT file_path FROM student_scores WHERE assessment_id = ? AND file_path IS NOT NULL`,
                [aid]
            );
            for (const sf of scoreFiles) {
                if (sf.file_path) {
                    const fp = path.join(__dirname, '..', 'material_uploads', path.basename(sf.file_path));
                    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (_) { }
                }
            }
        } catch (_) { }

        await db.execute(`DELETE FROM assignment_audiences WHERE assessment_id = ?`, [aid]);
        await db.execute(`DELETE FROM submission_receipts WHERE assessment_id = ?`, [aid]);
        await db.execute(`DELETE FROM rubrics WHERE assessment_id = ?`, [aid]);
        await db.execute(`DELETE FROM student_scores WHERE assessment_id = ?`, [aid]).catch(() => { });
        await db.execute(`DELETE FROM assessments WHERE assessment_id = ?`, [aid]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GROUP SETS & STUDENT GROUPS MANAGEMENT
// ============================================================

router.get('/api/classes/:classId/group-sets', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const [sets] = await db.query(
            `SELECT * FROM group_sets WHERE class_id = ? ORDER BY created_at DESC`,
            [classId]
        );

        for (const set of sets) {
            let totalMembers = 0;
            const [groups] = await db.query(
                `SELECT * FROM student_groups WHERE group_set_id = ? ORDER BY group_name ASC`,
                [set.group_set_id]
            );

            for (const grp of groups) {
                const [members] = await db.query(
                    `SELECT gm.student_id, u.first_name, u.last_name, u.email, u.profile_pic
                     FROM group_members gm
                     JOIN users u ON gm.student_id = u.user_id
                     WHERE gm.group_id = ?
                     ORDER BY u.last_name ASC`,
                    [grp.group_id]
                );
                grp.members = members;
                totalMembers += members.length;
            }
            set.groups = groups;
            set.group_count = groups.length;
            set.total_members = totalMembers;
            set.set_name = set.title;
        }

        res.json({ success: true, group_sets: sets, groupSets: sets });
    } catch (e) {
        console.error('[GET /api/classes/:classId/group-sets]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/api/classes/:classId/group-sets', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        await assertActiveClass(db, req.user.role === 'Admin' ? null : req.user.user_id, classId);
        const rawTitle = req.body.title || req.body.set_name || '';
        const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
        const description = (req.body.description || '').trim();
        const groups = req.body.groups;
        const membersPerGroup = parseInt(req.body.members_per_group, 10);
        let groupCount = parseInt(req.body.group_count, 10);
        const autoDistribute = req.body.auto_distribute !== false && req.body.auto_distribute !== 'false';
        const candidateStudentIds = Array.isArray(req.body.candidate_student_ids) ? req.body.candidate_student_ids.map(Number).filter(Boolean) : [];

        if (!title) {
            return res.status(400).json({ success: false, error: 'Group Set Title is required' });
        }

        const [setResult] = await db.execute(
            `INSERT INTO group_sets (class_id, title, description) VALUES (?, ?, ?)`,
            [classId, title, description || null]
        );
        const groupSetId = setResult.insertId;

        // Mode 1: Manual groups specified
        if (groups && Array.isArray(groups) && groups.length > 0) {
            for (const grp of groups) {
                if (grp.group_name && grp.group_name.trim()) {
                    const [gResult] = await db.execute(
                        `INSERT INTO student_groups (group_set_id, group_name) VALUES (?, ?)`,
                        [groupSetId, grp.group_name.trim()]
                    );
                    const groupId = gResult.insertId;

                    if (grp.student_ids && Array.isArray(grp.student_ids)) {
                        for (const sid of grp.student_ids) {
                            if (sid) {
                                await db.execute(
                                    `INSERT IGNORE INTO group_members (group_id, student_id) VALUES (?, ?)`,
                                    [groupId, sid]
                                );
                            }
                        }
                    }
                }
            }
        }
        // Mode 2: Auto / Random generation by members per group or group count
        else {
            // Determine student candidate pool
            let studentsToGroup = [];
            if (candidateStudentIds.length > 0) {
                const [targetStudents] = await db.query(
                    `SELECT u.user_id 
                     FROM users u
                     JOIN class_students cs ON u.user_id = cs.student_id
                     WHERE cs.class_id = ? AND u.role = 'Student' AND u.user_id IN (?)
                     ORDER BY RAND()`,
                    [classId, candidateStudentIds]
                );
                studentsToGroup = targetStudents;
            } else {
                const [enrolledStudents] = await db.query(
                    `SELECT u.user_id 
                     FROM users u
                     JOIN class_students cs ON u.user_id = cs.student_id
                     WHERE cs.class_id = ? AND u.role = 'Student'
                     ORDER BY RAND()`,
                    [classId]
                );
                studentsToGroup = enrolledStudents;
            }

            // Calculate number of groups based on membersPerGroup if specified
            if (membersPerGroup && membersPerGroup > 0) {
                const count = studentsToGroup.length > 0
                    ? Math.max(1, Math.ceil(studentsToGroup.length / membersPerGroup))
                    : 4;
                groupCount = Math.min(count, 50);
            } else if (!groupCount || groupCount <= 0) {
                groupCount = 4;
            }
            groupCount = Math.min(Math.max(groupCount, 1), 50);

            const groupIds = [];
            for (let i = 1; i <= groupCount; i++) {
                const [gResult] = await db.execute(
                    `INSERT INTO student_groups (group_set_id, group_name) VALUES (?, ?)`,
                    [groupSetId, `Group ${i}`]
                );
                groupIds.push(gResult.insertId);
            }

            if (autoDistribute && groupIds.length > 0 && studentsToGroup.length > 0) {
                for (let idx = 0; idx < studentsToGroup.length; idx++) {
                    const targetGroupId = groupIds[idx % groupIds.length];
                    await db.execute(
                        `INSERT IGNORE INTO group_members (group_id, student_id) VALUES (?, ?)`,
                        [targetGroupId, studentsToGroup[idx].user_id]
                    );
                }
            }
        }

        res.json({ success: true, group_set_id: groupSetId });
    } catch (e) {
        console.error('[POST /api/classes/:classId/group-sets]', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.delete('/api/group-sets/:setId', isTeacher, async (req, res) => {
    try {
        await db.execute(`UPDATE assessments SET group_set_id = NULL WHERE group_set_id = ?`, [req.params.setId]);
        await db.execute(`DELETE FROM group_sets WHERE group_set_id = ?`, [req.params.setId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/api/student-groups/:groupId', isTeacher, async (req, res) => {
    try {
        const groupId = req.params.groupId;
        await db.execute(`DELETE FROM group_members WHERE group_id = ?`, [groupId]);
        await db.execute(`DELETE FROM student_groups WHERE group_id = ?`, [groupId]);
        res.json({ success: true });
    } catch (e) {
        console.error('[DELETE /api/student-groups/:groupId]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});



// ============================================================
// ANNOUNCEMENTS — POST / PUT / DELETE & METRICS
// ============================================================

router.post('/api/announcement', isTeacher, announcementUpload.single('attachment'), async (req, res) => {
    try {
        const { class_id, title, content, is_priority, is_critical, due_date, forward_webhook } = req.body;
        if (!class_id || !title || !content) throw new Error('Missing required fields');

        // RBAC / IDOR Protection: Verify teacher teaches this class OR user is Admin
        const [[cls]] = await db.query(
            `SELECT class_id, class_name, teacher_id FROM classes WHERE class_id = ?`,
            [class_id]
        );
        if (!cls) {
            return res.status(404).json({ error: 'Class not found.' });
        }

        const isClassTeacher = cls.teacher_id && Number(cls.teacher_id) === Number(req.user.user_id);
        const isAdmin = req.user.role === 'Admin';

        if (!isClassTeacher && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized: You are not assigned to this class.' });
        }

        let attachment_url = null;
        let attachment_name = null;
        let attachment_type = null;

        if (req.file) {
            attachment_url = '/announcement_uploads/' + req.file.filename;
            attachment_name = req.file.originalname;
            attachment_type = req.file.mimetype.startsWith('image/') ? 'image' : (req.file.mimetype === 'application/pdf' ? 'pdf' : 'document');
        }

        const [insertRes] = await db.execute(
            `INSERT INTO announcements (class_id, teacher_id, title, content, is_priority, is_critical, due_date, attachment_url, attachment_name, attachment_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                class_id,
                req.user.user_id,
                title.trim(),
                content.trim(),
                is_priority ? 1 : 0,
                is_critical ? 1 : 0,
                due_date || null,
                attachment_url,
                attachment_name,
                attachment_type
            ]
        );

        // Zero-Queue Webhook Dispatch if requested
        if (forward_webhook) {
            const authorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Instructor';
            dispatchAnnouncementWebhook({
                announcement: {
                    title: title.trim(),
                    content: content.trim(),
                    is_critical: Boolean(is_critical),
                    due_date: due_date || null,
                    scope: 'class',
                    attachment_url
                },
                classId: class_id,
                authorName,
                className: cls.class_name
            }).catch(wErr => console.error('[Webhook Dispatch Warning]:', wErr.message));
        }

        // In-App Notification to enrolled students
        try {
            const [students] = await db.query('SELECT student_id FROM class_students WHERE class_id = ?', [class_id]);
            const recipientIds = students.map(s => s.student_id);
            if (recipientIds.length > 0) {
                await notificationService.dispatch({
                    recipientIds,
                    actorId: req.user.user_id,
                    role: 'Student',
                    category: 'academic',
                    priority: is_critical ? 'urgent' : (is_priority ? 'high' : 'normal'),
                    eventType: 'announcement_created',
                    title: `Announcement: ${title.trim()}`,
                    message: content.trim().substring(0, 160),
                    targetUrl: `/dashboard#ann-card-${insertRes.insertId}`,
                    metadata: { announcementId: insertRes.insertId, classId: class_id }
                });
            }
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Announcement]', notifErr);
        }

        res.json({ success: true, announcement_id: insertRes.insertId, attachment_url, attachment_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/announcement/:aid', isTeacher, announcementUpload.single('attachment'), async (req, res) => {
    try {
        const { title, content, is_priority, is_critical, due_date, remove_attachment } = req.body;
        if (!title || !content) throw new Error('Missing required fields');

        // 1. RBAC / IDOR Protection: Verify author, class teacher, or Admin
        const [[ann]] = await db.query(
            `SELECT a.*, c.teacher_id AS class_teacher_id 
             FROM announcements a
             LEFT JOIN classes c ON a.class_id = c.class_id
             WHERE a.announcement_id = ?`,
            [req.params.aid]
        );

        if (!ann) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        const isAuthor = Number(ann.teacher_id) === Number(req.user.user_id);
        const isClassTeacher = ann.class_teacher_id && Number(ann.class_teacher_id) === Number(req.user.user_id);
        const isAdmin = req.user.role === 'Admin';

        if (!isAuthor && !isClassTeacher && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized to edit this announcement' });
        }

        let attachmentUpdateSql = '';
        const params = [
            title.trim(),
            content.trim(),
            is_priority ? 1 : 0,
            is_critical ? 1 : 0,
            due_date || null
        ];

        if (req.file) {
            // Unlink previous file if replacing
            if (ann.attachment_url) {
                try {
                    const oldFilePath = path.join(__dirname, '..', 'public', ann.attachment_url.replace(/^\//, ''));
                    if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
                } catch (unlinkErr) {
                    console.warn('[Unlink Old Attachment Warning]:', unlinkErr.message);
                }
            }
            const attUrl = '/announcement_uploads/' + req.file.filename;
            const attName = req.file.originalname;
            const attType = req.file.mimetype.startsWith('image/') ? 'image' : (req.file.mimetype === 'application/pdf' ? 'pdf' : 'document');
            attachmentUpdateSql = ', attachment_url = ?, attachment_name = ?, attachment_type = ?';
            params.push(attUrl, attName, attType);
        } else if (remove_attachment === '1' || remove_attachment === true) {
            // If explicitly removing existing attachment, delete the old file on disk
            if (ann.attachment_url) {
                try {
                    const oldFilePath = path.join(__dirname, '..', 'public', ann.attachment_url.replace(/^\//, ''));
                    if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
                } catch (unlinkErr) {
                    console.warn('[Unlink Old Attachment Warning]:', unlinkErr.message);
                }
            }
            attachmentUpdateSql = ', attachment_url = NULL, attachment_name = NULL, attachment_type = NULL';
        }

        params.push(req.params.aid);

        await db.execute(
            `UPDATE announcements 
             SET title = ?, content = ?, is_priority = ?, is_critical = ?, due_date = ? ${attachmentUpdateSql}
             WHERE announcement_id = ?`,
            params
        );

        const finalAttUrl = req.file ? ('/announcement_uploads/' + req.file.filename) : (remove_attachment === '1' || remove_attachment === true ? null : ann.attachment_url);
        const finalAttName = req.file ? req.file.originalname : (remove_attachment === '1' || remove_attachment === true ? null : ann.attachment_name);
        res.json({ success: true, attachment_url: finalAttUrl, attachment_name: finalAttName });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/announcement/:aid', isTeacher, async (req, res) => {
    try {
        // 1. RBAC / IDOR Protection: Verify author, class teacher, or Admin
        const [[ann]] = await db.query(
            `SELECT a.*, c.teacher_id AS class_teacher_id 
             FROM announcements a
             LEFT JOIN classes c ON a.class_id = c.class_id
             WHERE a.announcement_id = ?`,
            [req.params.aid]
        );

        if (!ann) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        const isAuthor = Number(ann.teacher_id) === Number(req.user.user_id);
        const isClassTeacher = ann.class_teacher_id && Number(ann.class_teacher_id) === Number(req.user.user_id);
        const isAdmin = req.user.role === 'Admin';

        if (!isAuthor && !isClassTeacher && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized to delete this announcement' });
        }

        // 2. Safely unlink physical attachment file from disk
        if (ann.attachment_url) {
            const filePath = path.join(__dirname, '..', 'public', ann.attachment_url.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (fErr) { console.warn('[Unlink Attachment Warning]:', fErr.message); }
            }
        }

        // 3. Purge database record
        await db.execute(`DELETE FROM announcements WHERE announcement_id = ?`, [req.params.aid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});




// ============================================================
// FORUM TOPICS — POST / PUT / DELETE
// ============================================================

// NOTE: Forum CRUD routes (POST /api/forum, PUT /api/forum/:id, DELETE /api/forum/:id)
// are defined further below with full validation, ownership checks, and proper responses.


// ============================================================
// ANALYTICS API ENDPOINTS
// ============================================================

router.get('/api/breakdown/:assessmentId', isTeacher, async (req, res) => {
    try {
        const assessmentId = parseInt(req.params.assessmentId, 10);
        const classId = req.query.classId ? parseInt(req.query.classId, 10) : null;

        if (!assessmentId || isNaN(assessmentId)) {
            return res.json({ success: false, questions: [] });
        }

        // 1. Fetch assessment details to understand topic / type
        const [asmtRows] = await db.execute(`
            SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.topic_id, t.topic_name
            FROM assessments a
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            WHERE a.assessment_id = ?
        `, [assessmentId]);

        const asmt = asmtRows.length ? asmtRows[0] : null;

        // 2. Identify all questions belonging to this assessment:
        // Priority 1: elementa_assessment_questions (explicit assessment-to-question mappings)
        let [questions] = await db.execute(`
            SELECT eq.question_id, eq.prompt AS question_text, eq.difficulty,
                   COALESCE(eq.topic, t.topic_name, 'General') AS topic_name,
                   eaq.sort_order
            FROM elementa_assessment_questions eaq
            JOIN elementa_questions eq ON eaq.question_id = eq.question_id
            LEFT JOIN topics t ON eq.topic_id = t.topic_id
            WHERE eaq.assessment_id = ?
            ORDER BY eaq.sort_order ASC, eq.question_id ASC
        `, [assessmentId]);

        // Priority 2: if not mapped in elementa_assessment_questions, fetch questions by topic_id
        if (!questions.length && asmt && asmt.topic_id) {
            const [topicQuestions] = await db.execute(`
                SELECT eq.question_id, eq.prompt AS question_text, eq.difficulty,
                       COALESCE(eq.topic, t.topic_name, 'General') AS topic_name,
                       0 AS sort_order
                FROM elementa_questions eq
                LEFT JOIN topics t ON eq.topic_id = t.topic_id
                WHERE eq.topic_id = ?
                ORDER BY eq.question_id ASC
            `, [asmt.topic_id]);
            questions = topicQuestions;
        }

        // Priority 3: elementa_grade_responses
        if (!questions.length) {
            const [egrQuestions] = await db.execute(`
                SELECT DISTINCT egr.question_id,
                       COALESCE(egr.question_asked, eq.prompt, 'Assessment Question') AS question_text,
                       COALESCE(eq.difficulty, 'Average') AS difficulty,
                       COALESCE(eq.topic, 'General') AS topic_name,
                       COALESCE(egr.question_number, 0) AS sort_order
                FROM elementa_grade_responses egr
                LEFT JOIN elementa_questions eq ON egr.question_id = eq.question_id
                WHERE egr.assessment_id = ?
                ORDER BY sort_order ASC, egr.question_id ASC
            `, [assessmentId]);
            questions = egrQuestions;
        }

        // Priority 4: if still none, check customer attempts joined to sessions with this assessment_id
        if (!questions.length) {
            const [sessQuestions] = await db.execute(`
                SELECT DISTINCT eq.question_id, eq.prompt AS question_text, eq.difficulty,
                       COALESCE(eq.topic, 'General') AS topic_name,
                       0 AS sort_order
                FROM elementa_customer_attempts eca
                JOIN elementa_questions eq ON eca.question_id = eq.question_id
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                WHERE egs.assessment_id = ?
            `, [assessmentId]);
            questions = sessQuestions;
        }

        // If still no questions exist for this assessment anywhere in DB:
        if (!questions.length) {
            return res.json({ success: true, questions: [], assessment: asmt });
        }

        // 3. Compute student response statistics for each question
        const qIds = questions.map(q => q.question_id).filter(Boolean);
        const statsMap = {};

        if (qIds.length > 0) {
            const placeholders = qIds.map(() => '?').join(',');

            // A) Attempts associated with sessions for this assessment
            let sessionSql = `
                SELECT 
                    eca.question_id,
                    COUNT(eca.attempt_id) AS total_responses,
                    SUM(CASE WHEN eca.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                    SUM(CASE WHEN eca.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
                    AVG(eca.response_time_s * 1000) AS avg_response_ms
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                WHERE eca.question_id IN (${placeholders})
                  AND (egs.assessment_id = ? OR egs.assessment_id IS NULL)
            `;
            const sessionParams = [...qIds, assessmentId];
            if (classId) {
                const classSessionSql = sessionSql + ` AND (egs.class_id = ? OR egs.student_id_p1 IN (SELECT student_id FROM class_students WHERE class_id = ?)) GROUP BY eca.question_id`;
                const [classStats] = await db.query(classSessionSql, [...sessionParams, classId, classId]);
                classStats.forEach(s => {
                    statsMap[s.question_id] = s;
                });
            }

            // For questions not covered by class-filtered session attempts, check all session attempts
            const [generalSessStats] = await db.query(sessionSql + ` GROUP BY eca.question_id`, sessionParams);
            generalSessStats.forEach(s => {
                if (!statsMap[s.question_id] || Number(statsMap[s.question_id].total_responses) === 0) {
                    statsMap[s.question_id] = s;
                }
            });

            // B) For questions still without attempts, query all elementa_customer_attempts by question_id
            for (const q of questions) {
                if (!statsMap[q.question_id] || Number(statsMap[q.question_id].total_responses) === 0) {
                    const [directAttempts] = await db.execute(`
                        SELECT 
                            COUNT(attempt_id) AS total_responses,
                            SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                            SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
                            AVG(response_time_s * 1000) AS avg_response_ms
                        FROM elementa_customer_attempts
                        WHERE question_id = ?
                    `, [q.question_id]);
                    if (directAttempts.length && Number(directAttempts[0].total_responses) > 0) {
                        statsMap[q.question_id] = directAttempts[0];
                    }
                }
            }

            // C) Also check elementa_grade_responses
            let egrSql = `
                SELECT 
                    egr.question_id,
                    COUNT(egr.attempt_id) AS total_responses,
                    SUM(CASE WHEN egr.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                    SUM(CASE WHEN egr.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
                    AVG(egr.response_time_s * 1000) AS avg_response_ms
                FROM elementa_grade_responses egr
                WHERE egr.assessment_id = ?
            `;
            const egrParams = [assessmentId];
            if (classId) {
                egrSql += ` AND (egr.class_id = ? OR egr.student_id IN (SELECT student_id FROM class_students WHERE class_id = ?))`;
                egrParams.push(classId, classId);
            }
            egrSql += ` GROUP BY egr.question_id`;
            const [egrStats] = await db.query(egrSql, egrParams);
            egrStats.forEach(s => {
                if (s.question_id) {
                    const existing = statsMap[s.question_id];
                    if (!existing || Number(existing.total_responses) === 0) {
                        statsMap[s.question_id] = s;
                    }
                }
            });
        }

        // Map and enrich questions
        const enrichedQuestions = questions.map(q => {
            const s = statsMap[q.question_id] || {};
            const total = Number(s.total_responses) || 0;
            const correct = Number(s.correct_count) || 0;
            const wrong = Number(s.wrong_count) || 0;
            const correct_rate = total > 0 ? Math.round((correct / total) * 10000) / 10000 : 0;
            const avg_response_ms = s.avg_response_ms != null ? Math.round(Number(s.avg_response_ms)) : null;

            return {
                question_id: q.question_id,
                question_text: q.question_text || 'Assessment Question',
                difficulty: q.difficulty || 'Average',
                total_responses: total,
                correct_count: correct,
                wrong_count: wrong,
                avg_response_ms,
                correct_rate
            };
        });

        // Sort: lowest correct rate first (hardest questions), but questions with responses first
        enrichedQuestions.sort((a, b) => {
            if (a.total_responses === 0 && b.total_responses > 0) return 1;
            if (a.total_responses > 0 && b.total_responses === 0) return -1;
            return a.correct_rate - b.correct_rate;
        });

        res.json({
            success: true,
            questions: enrichedQuestions,
            assessment: asmt
        });
    } catch (e) {
        console.error('[API Breakdown Error]:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /teacher/api/assessment-diagnostic/:scoreId — Comprehensive Student Assessment Result & Diagnostic ──
router.get('/api/assessment-diagnostic/:scoreId', isTeacher, async (req, res) => {
    try {
        const rawScoreId = req.params.scoreId;
        const isLmsScore = typeof rawScoreId === 'string' && rawScoreId.startsWith('ss_');
        const scoreId = isLmsScore ? parseInt(rawScoreId.replace('ss_', ''), 10) : parseInt(rawScoreId, 10);
        const studentId = req.query.studentId ? parseInt(req.query.studentId, 10) : null;
        const classId = req.query.classId ? parseInt(req.query.classId, 10) : null;
        const assessmentIdQuery = req.query.assessmentId ? parseInt(req.query.assessmentId, 10) : null;

        // 1. Fetch Attempt / Session Metadata
        let attempt = null;

        if (!isLmsScore) {
            const [sessRows] = await db.execute(`
                SELECT 
                    egs.session_id,
                    egs.started_at,
                    egs.ended_at,
                    egs.play_mode,
                    egs.highest_level_reached,
                    GREATEST(
                        COALESCE(CASE WHEN egs.student_id_p1 = ? THEN egs.final_score_p1 ELSE egs.final_score_p2 END, 0),
                        COALESCE((SELECT COUNT(*) FROM elementa_customer_attempts eca 
                                  JOIN elementa_level_runs elr ON eca.run_id = elr.run_id 
                                  WHERE elr.session_id = egs.session_id 
                                    AND elr.player_number = (CASE WHEN egs.student_id_p1 = ? THEN 1 ELSE 2 END)
                                    AND eca.is_correct = 1), 0)
                    ) AS score_obtained,
                    GREATEST(
                        COALESCE(a.total_items, (SELECT COUNT(*) FROM elementa_assessment_questions WHERE assessment_id = egs.assessment_id), egs.highest_level_reached, 1),
                        COALESCE((SELECT COUNT(*) FROM elementa_customer_attempts eca 
                                  JOIN elementa_level_runs elr ON eca.run_id = elr.run_id 
                                  WHERE elr.session_id = egs.session_id 
                                    AND elr.player_number = (CASE WHEN egs.student_id_p1 = ? THEN 1 ELSE 2 END)), 1)
                    ) AS total_items,
                    COALESCE(a.quarter_id, 1) AS quarter_id,
                    COALESCE(
                        (SELECT ss.exp_gained FROM student_scores ss 
                         WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = ? 
                         ORDER BY ss.score_id DESC LIMIT 1),
                        CASE 
                            WHEN (CASE WHEN egs.student_id_p1 = ? THEN egs.final_score_p1 ELSE egs.final_score_p2 END) > 0 
                            THEN (CASE WHEN egs.student_id_p1 = ? THEN egs.final_score_p1 ELSE egs.final_score_p2 END) * 100
                            ELSE 0
                        END
                    ) AS exp_gained,
                    egs.assessment_id,
                    COALESCE(a.assessment_name, 'Arcade Challenge') AS assessment_name,
                    COALESCE(a.assessment_type, 'Assessment') AS assessment_type,
                    a.topic_id,
                    t.topic_name,
                    u.user_id,
                    u.first_name,
                    u.last_name,
                    u.profile_pic
                FROM elementa_game_sessions egs
                LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN users u ON u.user_id = ?
                WHERE egs.session_id = ?
                LIMIT 1
            `, [studentId || 0, studentId || 0, studentId || 0, studentId || 0, studentId || 0, studentId || 0, studentId || 0, scoreId]);

            if (sessRows.length > 0 && sessRows[0].user_id) {
                attempt = sessRows[0];
            } else {
                const [fallbackRows] = await db.execute(`
                    SELECT 
                        egs.session_id,
                        egs.started_at,
                        egs.ended_at,
                        egs.play_mode,
                        egs.highest_level_reached,
                        COALESCE(egs.final_score_p1, 0) AS score_obtained,
                        GREATEST(COALESCE(a.total_items, (SELECT COUNT(*) FROM elementa_assessment_questions WHERE assessment_id = egs.assessment_id), egs.highest_level_reached, 1), 1) AS total_items,
                        COALESCE(a.quarter_id, 1) AS quarter_id,
                        COALESCE(
                            (SELECT ss.exp_gained FROM student_scores ss 
                             WHERE ss.assessment_id = egs.assessment_id AND ss.student_id = egs.student_id_p1 
                             ORDER BY ss.score_id DESC LIMIT 1),
                            CASE WHEN egs.final_score_p1 > 0 THEN egs.final_score_p1 * 100 ELSE 0 END
                        ) AS exp_gained,
                        egs.assessment_id,
                        COALESCE(a.assessment_name, 'Arcade Challenge') AS assessment_name,
                        COALESCE(a.assessment_type, 'Assessment') AS assessment_type,
                        a.topic_id,
                        t.topic_name,
                        u.user_id,
                        u.first_name,
                        u.last_name,
                        u.profile_pic
                    FROM elementa_game_sessions egs
                    LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    LEFT JOIN users u ON u.user_id = egs.student_id_p1
                    WHERE egs.session_id = ?
                    LIMIT 1
                `, [scoreId]);
                if (fallbackRows.length > 0) attempt = fallbackRows[0];
            }
        }

        if (!attempt) {
            const [ssRows] = await db.execute(`
                SELECT 
                    ss.score_id AS session_id,
                    ss.date_recorded AS started_at,
                    ss.date_recorded AS ended_at,
                    'Standard' AS play_mode,
                    ss.total_items AS highest_level_reached,
                    ss.score_obtained,
                    COALESCE(NULLIF(ss.total_items, 0), NULLIF(ss.total_possible_score, 0), a.total_items, 100) AS total_items,
                    COALESCE(a.quarter_id, 1) AS quarter_id,
                    COALESCE(ss.exp_gained, 0) AS exp_gained,
                    ss.assessment_id,
                    COALESCE(a.assessment_name, 'Assignment') AS assessment_name,
                    COALESCE(a.assessment_type, 'Assignment') AS assessment_type,
                    a.topic_id,
                    t.topic_name,
                    u.user_id,
                    u.first_name,
                    u.last_name,
                    u.profile_pic
                FROM student_scores ss
                LEFT JOIN assessments a ON ss.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN users u ON u.user_id = ss.student_id
                WHERE ss.score_id = ?
                LIMIT 1
            `, [scoreId]);
            if (ssRows.length > 0) attempt = ssRows[0];
        }

        if (!attempt) {
            return res.status(404).json({ success: false, error: 'Assessment attempt record not found.' });
        }

        const effectiveAssessmentId = attempt.assessment_id || assessmentIdQuery;

        // 2. Fetch Student Question Responses & Micro-Telemetry
        let [questions] = await db.execute(`
            SELECT
                eca.attempt_id AS response_id,
                eca.player_answer AS student_answer,
                eca.is_correct,
                eca.response_time_s,
                COALESCE(eca.points_awarded, CASE WHEN eca.is_correct = 1 THEN 50 ELSE 0 END) AS points_awarded,
                COALESCE(eq.prompt, eca.question_snapshot, 'Arcade Question') AS question_text,
                COALESCE(eq.answer_text, eca.correct_answer) AS correct_answer,
                eq.question_id,
                COALESCE(eq.topic, t.topic_name, elr.level_topic, 'General Chemistry') AS topic_name,
                COALESCE(eq.machine_name, eca.machine_used, 'Standard') AS question_type,
                COALESCE(eq.difficulty, 'Normal') AS difficulty,
                COALESCE(eq.topic_id, t.topic_id, a.topic_id) AS topic_id
            FROM elementa_customer_attempts eca
            JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
            LEFT JOIN elementa_questions eq ON eca.question_id = eq.question_id
            LEFT JOIN topics t ON eq.topic_id = t.topic_id
            LEFT JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
            LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
            WHERE elr.session_id = ?
              AND (
                  ? = 0 OR 
                  egs.student_id_p2 IS NULL OR 
                  elr.player_number = (CASE WHEN egs.student_id_p1 = ? THEN 1 WHEN egs.student_id_p2 = ? THEN 2 ELSE 1 END)
              )
            ORDER BY eca.attempt_id ASC
        `, [scoreId, studentId || 0, studentId || 0, studentId || 0]);

        if (!questions.length) {
            const [egr] = await db.execute(`
                SELECT
                    egr.attempt_id AS response_id,
                    egr.student_answer,
                    egr.is_correct,
                    egr.response_time_s,
                    CASE WHEN egr.is_correct = 1 THEN 50 ELSE 0 END AS points_awarded,
                    egr.question_asked AS question_text,
                    egr.accepted_answer AS correct_answer,
                    egr.question_id,
                    COALESCE(egr.level_topic, 'General Chemistry') AS topic_name,
                    'Standard' AS question_type,
                    'Normal' AS difficulty,
                    a.topic_id
                FROM elementa_grade_responses egr
                LEFT JOIN assessments a ON egr.assessment_id = a.assessment_id
                WHERE egr.session_id = ?
                ORDER BY egr.question_number ASC
            `, [scoreId]);
            if (egr.length) questions = egr;
        }

        if (!questions.length && effectiveAssessmentId) {
            const [eaq] = await db.execute(`
                SELECT
                    eq.question_id,
                    eq.prompt AS question_text,
                    eq.answer_text AS correct_answer,
                    '— (Not recorded)' AS student_answer,
                    0 AS is_correct,
                    0 AS response_time_s,
                    0 AS points_awarded,
                    COALESCE(eq.topic, t.topic_name, 'General Chemistry') AS topic_name,
                    COALESCE(eq.machine_name, 'Standard') AS question_type,
                    eq.difficulty,
                    COALESCE(eq.topic_id, t.topic_id) AS topic_id
                FROM elementa_assessment_questions eaq
                JOIN elementa_questions eq ON eaq.question_id = eq.question_id
                LEFT JOIN topics t ON eq.topic_id = t.topic_id
                WHERE eaq.assessment_id = ?
                ORDER BY eaq.sort_order ASC
            `, [effectiveAssessmentId]);
            if (eaq.length) questions = eaq;
        }

        // 3. Analytical Breakdown: Topics & Question Types
        const topicMap = {};
        const qTypeMap = {};

        questions.forEach(q => {
            const tName = q.topic_name || 'General Chemistry';
            if (!topicMap[tName]) {
                topicMap[tName] = { name: tName, topic_id: q.topic_id, total: 0, correct: 0 };
            }
            topicMap[tName].total++;
            if (q.is_correct == 1) topicMap[tName].correct++;

            const qType = q.question_type || 'Standard';
            if (!qTypeMap[qType]) {
                qTypeMap[qType] = { name: qType, total: 0, correct: 0 };
            }
            qTypeMap[qType].total++;
            if (q.is_correct == 1) qTypeMap[qType].correct++;
        });

        const topicAnalytics = Object.values(topicMap).map(t => {
            const pct = t.total > 0 ? Math.round((t.correct / t.total) * 100) : 0;
            return {
                topic_id: t.topic_id,
                topic_name: t.name,
                name: t.name,
                title: t.name,
                total: t.total,
                correct: t.correct,
                wrong: Math.max(0, t.total - t.correct),
                accuracy: pct,
                pct: pct,
                ratio: `${t.correct}/${t.total}`,
                status: pct >= 75 ? 'mastered' : pct >= 50 ? 'developing' : 'gap'
            };
        });

        const qTypeAnalytics = Object.values(qTypeMap).map(qt => {
            const pct = qt.total > 0 ? Math.round((qt.correct / qt.total) * 100) : 0;
            return {
                type: qt.name,
                name: qt.name,
                title: qt.name,
                total: qt.total,
                correct: qt.correct,
                wrong: Math.max(0, qt.total - qt.correct),
                accuracy: pct,
                pct: pct,
                ratio: `${qt.correct}/${qt.total}`,
                status: pct >= 75 ? 'mastered' : pct >= 50 ? 'developing' : 'gap'
            };
        });

        const strengths = topicAnalytics
            .filter(t => t.accuracy >= 75)
            .map(t => ({
                ...t,
                type: 'Topic'
            }));

        const knowledgeGaps = topicAnalytics
            .filter(t => t.accuracy < 75)
            .map(t => ({
                ...t,
                type: 'Topic'
            }));

        // 4. Score & Telemetry Reconciliation
        const questionsCorrectCount = questions.filter(q => q.is_correct == 1).length;
        const totalItems = Math.max(
            Number(attempt.total_items) || 0,
            questions.length,
            1
        );
        let scoreObtained = attempt.score_obtained != null ? Number(attempt.score_obtained) : 0;
        if (questions.length > 0) {
            if (scoreObtained === 0 && questionsCorrectCount > 0) {
                scoreObtained = questionsCorrectCount;
            } else if (scoreObtained > totalItems) {
                scoreObtained = questionsCorrectCount;
            } else {
                scoreObtained = Math.max(scoreObtained, questionsCorrectCount);
            }
        }
        const scorePercentage = totalItems > 0 ? Math.round((scoreObtained / totalItems) * 100) : 0;
        const totalPointsAwarded = questions.reduce((sum, q) => sum + (Number(q.points_awarded) || 0), 0);
        let expGained = Number(attempt.exp_gained) || 0;
        if (expGained === 0 || expGained < scoreObtained * 10) {
            expGained = totalPointsAwarded > 0 ? totalPointsAwarded : Math.max(50, scoreObtained * 50);
        }

        // 5. Comparative Cohort Metrics
        let cohort = {
            totalStudents: 1,
            surpassedCount: 0,
            tiedCount: 1,
            percentile: scorePercentage,
            classAvgScore: scoreObtained.toString(),
            classAvgPercentage: scorePercentage,
            topScore: scoreObtained,
            studentScore: scoreObtained,
            pctRankText: 'Solo Baseline',
            isSingleParticipant: true
        };

        let cohortQuery = '';
        let queryParams = [];

        if (effectiveAssessmentId) {
            cohortQuery = `
                SELECT 
                    u.user_id,
                    GREATEST(
                        COALESCE(CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END, 0),
                        COALESCE((SELECT COUNT(*) FROM elementa_customer_attempts eca JOIN elementa_level_runs elr ON eca.run_id = elr.run_id WHERE elr.session_id = egs.session_id AND eca.is_correct = 1), 0)
                    ) AS score
                FROM elementa_game_sessions egs
                JOIN users u ON (egs.student_id_p1 = u.user_id OR egs.student_id_p2 = u.user_id)
                ${classId ? 'JOIN class_students cs ON u.user_id = cs.student_id WHERE cs.class_id = ? AND' : 'WHERE'}
                egs.assessment_id = ?
            `;
            queryParams = classId ? [classId, effectiveAssessmentId] : [effectiveAssessmentId];
        } else if (classId) {
            cohortQuery = `
                SELECT 
                    u.user_id,
                    GREATEST(
                        COALESCE(CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END, 0),
                        COALESCE((SELECT COUNT(*) FROM elementa_customer_attempts eca JOIN elementa_level_runs elr ON eca.run_id = elr.run_id WHERE elr.session_id = egs.session_id AND eca.is_correct = 1), 0)
                    ) AS score
                FROM elementa_game_sessions egs
                JOIN users u ON (egs.student_id_p1 = u.user_id OR egs.student_id_p2 = u.user_id)
                JOIN class_students cs ON u.user_id = cs.student_id
                WHERE cs.class_id = ? AND egs.assessment_id IS NULL
            `;
            queryParams = [classId];
        }

        if (cohortQuery) {
            const [cohortRows] = await db.execute(cohortQuery, queryParams);

            if (cohortRows.length > 0) {
                const studentBestScores = {};
                cohortRows.forEach(r => {
                    const sc = Number(r.score) || 0;
                    if (studentBestScores[r.user_id] === undefined || sc > studentBestScores[r.user_id]) {
                        studentBestScores[r.user_id] = sc;
                    }
                });

                if (attempt.user_id && (studentBestScores[attempt.user_id] === undefined || scoreObtained > studentBestScores[attempt.user_id])) {
                    studentBestScores[attempt.user_id] = scoreObtained;
                }

                const allScores = Object.values(studentBestScores);
                const currentScore = scoreObtained;
                const totalStudents = allScores.length;
                let surpassed = 0;
                let tied = 0;
                let sum = 0;
                let max = 0;

                allScores.forEach(s => {
                    sum += s;
                    if (s > max) max = s;
                    if (s < currentScore) surpassed++;
                    else if (s === currentScore) tied++;
                });

                if (totalStudents > 1) {
                    const rawPercentile = Math.round(((surpassed + (tied > 1 ? (tied - 1) * 0.5 : 0)) / totalStudents) * 100);
                    const percentile = Math.max(1, Math.min(100, rawPercentile));
                    cohort = {
                        totalStudents,
                        surpassedCount: surpassed,
                        tiedCount: tied,
                        percentile,
                        classAvgScore: (sum / totalStudents).toFixed(1),
                        classAvgPercentage: totalItems > 0 ? Math.round(((sum / totalStudents) / totalItems) * 100) : 0,
                        topScore: max,
                        studentScore: currentScore,
                        pctRankText: `${percentile}th Percentile`,
                        isSingleParticipant: false
                    };
                } else {
                    cohort = {
                        totalStudents: 1,
                        surpassedCount: 0,
                        tiedCount: 1,
                        percentile: scorePercentage,
                        classAvgScore: currentScore.toString(),
                        classAvgPercentage: scorePercentage,
                        topScore: currentScore,
                        studentScore: currentScore,
                        pctRankText: 'Solo Baseline',
                        isSingleParticipant: true
                    };
                }
            }
        }

        // 5. Curriculum Topics Mapping & Dynamic Learning Materials
        const incorrectQuestions = questions.filter(q => q.is_correct == 0);
        let relevantTopicIds = [...new Set(incorrectQuestions.map(q => q.topic_id).filter(Boolean))];
        if (!relevantTopicIds.length && attempt.topic_id) {
            relevantTopicIds = [attempt.topic_id];
        }

        let recommendedMaterials = [];
        if (relevantTopicIds.length > 0) {
            const placeholders = relevantTopicIds.map(() => '?').join(',');
            const [mats] = await db.query(`
                SELECT 
                    lm.material_id,
                    lm.topic_id,
                    lm.title,
                    lm.material_type,
                    lm.file_path_or_url,
                    lm.created_at,
                    t.topic_name
                FROM learning_materials lm
                LEFT JOIN topics t ON lm.topic_id = t.topic_id
                WHERE lm.topic_id IN (${placeholders})
                ORDER BY lm.created_at DESC
                LIMIT 8
            `, relevantTopicIds);
            recommendedMaterials = mats;
        }

        // Question-specific remediation materials
        const questionIds = questions.map(q => q.question_id).filter(Boolean);
        let questionRemediations = [];
        if (questionIds.length > 0) {
            const qPlaceholders = questionIds.map(() => '?').join(',');
            const [rems] = await db.query(`
                SELECT 
                    rm.rem_id,
                    rm.question_id,
                    rm.advice_text,
                    rm.link_url,
                    rm.preview_json,
                    lm.title AS material_title,
                    lm.file_path_or_url,
                    lm.material_type
                FROM remediation_materials rm
                LEFT JOIN learning_materials lm ON rm.material_id = lm.material_id
                WHERE rm.question_id IN (${qPlaceholders})
            `, questionIds);
            questionRemediations = rems;
        }

        // Group recommendations into an array of topic recommendations
        const recommendationsList = [];
        const allRelevantTopics = [...new Set([...(relevantTopicIds || []), attempt.topic_id])].filter(Boolean);

        allRelevantTopics.forEach(tId => {
            const topicMats = recommendedMaterials.filter(m => m.topic_id == tId);
            const topicRems = questionRemediations.filter(r => {
                const matchedQ = questions.find(q => q.question_id == r.question_id);
                return matchedQ && matchedQ.topic_id == tId;
            });
            const topicInfo = topicAnalytics.find(ta => ta.topic_id == tId);
            const topicName = (topicMats[0] && topicMats[0].topic_name) || (topicInfo && topicInfo.topic_name) || attempt.topic_name || 'Curriculum Concept';

            if (topicMats.length > 0 || topicRems.length > 0) {
                recommendationsList.push({
                    topic_id: tId,
                    topic_name: topicName,
                    accuracy: topicInfo ? topicInfo.accuracy : 0,
                    materials: topicMats,
                    remediations: topicRems
                });
            }
        });

        // Fallback if not grouped by topic
        if (recommendationsList.length === 0 && (recommendedMaterials.length > 0 || questionRemediations.length > 0)) {
            recommendationsList.push({
                topic_id: attempt.topic_id || 0,
                topic_name: attempt.topic_name || 'Curriculum Remediation',
                accuracy: 0,
                materials: recommendedMaterials,
                remediations: questionRemediations
            });
        }

        const classAvgScoreNum = Number(cohort.classAvgScore) || 0;
        const classAvgPercentage = cohort.classAvgPercentage != null ? cohort.classAvgPercentage : (totalItems > 0 ? Math.round((classAvgScoreNum / totalItems) * 100) : 0);
        cohort.classAvgPercentage = classAvgPercentage;

        res.json({
            success: true,
            attempt,
            student: {
                id: attempt.user_id,
                name: (attempt.first_name || attempt.last_name) ? `${attempt.last_name || ''}, ${attempt.first_name || ''}`.trim() : 'Student',
                first_name: attempt.first_name,
                last_name: attempt.last_name,
                profile_pic: attempt.profile_pic
            },
            assessment: {
                score_id: scoreId,
                assessment_id: attempt.assessment_id,
                title: attempt.assessment_name || 'Assessment',
                assessment_type: attempt.assessment_type || 'Assessment',
                quarter_id: attempt.quarter_id,
                date_recorded: attempt.started_at || attempt.ended_at
            },
            metrics: {
                score: scoreObtained,
                total: totalItems,
                percentage: scorePercentage,
                exp_gained: expGained,
                cohort
            },
            diagnostics: {
                topics: topicAnalytics,
                questionTypes: qTypeAnalytics,
                strengths,
                knowledgeGaps
            },
            analytics: {
                topics: topicAnalytics,
                questionTypes: qTypeAnalytics,
                strengths,
                knowledgeGaps
            },
            cohort,
            questions,
            recommendations: recommendationsList,
            recommendationsBundle: {
                materials: recommendedMaterials,
                remediations: questionRemediations,
                relevantTopicIds
            }
        });
    } catch (err) {
        console.error('❌ [GET /api/assessment-diagnostic/:scoreId]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/live-sessions/:classId', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const [sessions] = await db.execute(`
            SELECT egs.session_id, egs.play_mode AS player_mode, egs.highest_level_reached AS current_item_index,
                egs.final_score_p1 AS accumulated_score, egs.session_status, egs.started_at AS start_time,
                u.first_name, u.last_name, u.profile_pic,
                COALESCE(a.assessment_name, 'Arcade Session') AS assessment_name, 12 AS total_items
            FROM elementa_game_sessions egs
            LEFT JOIN users u           ON egs.student_id_p1 = u.user_id
            LEFT JOIN assessments a     ON egs.assessment_id = a.assessment_id
            LEFT JOIN class_students cs ON u.user_id         = cs.student_id
            WHERE (cs.class_id = ? OR egs.class_id = ?) AND egs.session_status = 'Ongoing'
            ORDER BY egs.started_at ASC`,
            [classId, classId]
        );
        res.json({ sessions });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ATTENDANCE MONITORING & RECORDING APIS
// ============================================================

// GET /teacher/api/attendance/:classId — Fetch attendance for class and date
router.get('/api/attendance/:classId', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.user.user_id;
        const targetDate = req.query.date || new Date().toISOString().slice(0, 10);

        // Verify class ownership (read-only view permitted for archived classes)
        const isAdmin = req.user.role === 'Admin';
        const clsObj = await verifyClassOwnership(db, isAdmin ? null : teacherId, classId);

        // Query enrolled students and left-join attendance_records for targetDate
        const [students] = await db.query(`
            SELECT 
                u.user_id AS student_id,
                u.first_name,
                u.last_name,
                u.lrn_number,
                u.profile_pic,
                u.sex,
                ar.attendance_id,
                ar.session_date,
                DATE_FORMAT(ar.check_in_time, '%H:%i') AS check_in_time,
                COALESCE(ar.status, 'Unmarked') AS status,
                ar.override_reason,
                ar.attendance_method
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            LEFT JOIN attendance_records ar 
                ON ar.student_id = u.user_id 
               AND ar.class_id = cs.class_id 
               AND ar.session_date = ?
            WHERE cs.class_id = ? AND u.role = 'Student'
            ORDER BY u.last_name ASC, u.first_name ASC`,
            [targetDate, classId]
        );

        let presentCount = 0, lateCount = 0, absentCount = 0, excusedCount = 0, unmarkedCount = 0;
        students.forEach(s => {
            if (s.status === 'Present') presentCount++;
            else if (s.status === 'Late') lateCount++;
            else if (s.status === 'Absent') absentCount++;
            else if (s.status === 'Excused') excusedCount++;
            else unmarkedCount++;
        });

        res.json({
            success: true,
            class_name: clsObj.class_name,
            date: targetDate,
            students,
            summary: {
                total: students.length,
                present: presentCount,
                late: lateCount,
                absent: absentCount,
                excused: excusedCount,
                unmarked: unmarkedCount
            }
        });
    } catch (e) {
        console.error('Error fetching attendance:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /teacher/api/attendance/:classId/save — Batch save attendance records
router.post('/api/attendance/:classId/save', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.user.user_id;
        const { date, records } = req.body;

        if (!date || !records || !Array.isArray(records)) {
            return res.status(400).json({ success: false, error: 'Invalid attendance payload' });
        }

        // Prevent recording attendance for future dates
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (date > todayStr) {
            return res.status(400).json({ success: false, error: 'Cannot mark or save attendance for future dates.' });
        }

        // Verify class ownership and active school year status (saving attendance is a mutation)
        const isAdmin = req.user.role === 'Admin';
        const clsObj = await assertActiveClass(db, isAdmin ? null : teacherId, classId);

        for (const r of records) {
            const studentId = r.student_id;
            const status = ['Present', 'Late', 'Absent', 'Excused'].includes(r.status) ? r.status : 'Present';
            const reason = r.override_reason || null;
            let checkInTime = null;
            if (r.check_in_time && /^\d{2}:\d{2}$/.test(r.check_in_time)) {
                checkInTime = `${date} ${r.check_in_time}:00`;
            }

            await db.query(`
                INSERT INTO attendance_records 
                    (student_id, class_id, session_date, check_in_time, status, attendance_method, teacher_id, override_reason)
                VALUES 
                    (?, ?, ?, COALESCE(?, NOW()), ?, 'Manual_Teacher', ?, ?)
                ON DUPLICATE KEY UPDATE
                    status = VALUES(status),
                    check_in_time = COALESCE(VALUES(check_in_time), check_in_time),
                    attendance_method = 'Manual_Teacher',
                    teacher_id = VALUES(teacher_id),
                    override_reason = VALUES(override_reason),
                    updated_at = NOW()`,
                [studentId, classId, date, checkInTime, status, teacherId, reason]
            );
        }

        await logActivity(req, 'RECORD_ATTENDANCE', `Recorded attendance for Class ID ${classId} (${clsObj.class_name}) on ${date} (${records.length} students)`, teacherId, 'Teacher');

        // T-26: Chronic Absence Alert (>= 3 recorded absences in this class)
        try {
            const absentStudentIds = records
                .filter(r => r && r.status === 'Absent' && r.student_id)
                .map(r => Number(r.student_id));
            if (absentStudentIds.length > 0) {
                const [absRows] = await db.query(
                    `SELECT ar.student_id, u.first_name, u.last_name, COUNT(*) AS absent_count
                     FROM attendance_records ar
                     JOIN users u ON ar.student_id = u.user_id
                     WHERE ar.class_id = ? AND ar.status = 'Absent' AND ar.student_id IN (?)
                     GROUP BY ar.student_id, u.first_name, u.last_name
                     HAVING absent_count >= 3`,
                    [classId, absentStudentIds]
                );
                for (const ab of absRows) {
                    const sName = `${ab.first_name || ''} ${ab.last_name || ''}`.trim() || 'Student';
                    await notificationService.dispatchOnce({
                        recipientId: teacherId,
                        actorId: ab.student_id,
                        role: 'Teacher',
                        category: 'academic',
                        priority: 'high',
                        eventType: 'chronic_absence_alert',
                        title: `Attendance Risk Alert: ${sName}`,
                        message: `${sName} has reached ${ab.absent_count} recorded absences in ${clsObj.class_name}.`,
                        targetUrl: `/teacher/class/${classId}?tab=attendance`,
                        dedupeKey: `chronic_abs_${classId}_${ab.student_id}_${ab.absent_count}`,
                        extraMeta: { classId: Number(classId), studentId: ab.student_id, absentCount: ab.absent_count }
                    });
                }
            }
        } catch (absNotifErr) {
            console.error('[Chronic Absence Notification Error]', absNotifErr.message);
        }

        res.json({ success: true, message: 'Attendance recorded successfully' });
    } catch (e) {
        console.error('Error saving attendance:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /teacher/api/attendance/:classId/analytics — Comprehensive Attendance Analytics
router.get('/api/attendance/:classId/analytics', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.user.user_id;
        const range = req.query.range || 'all'; // 'all', '30d', '7d', 'month'

        // Verify class ownership (read-only view permitted for archived classes)
        const isAdmin = req.user.role === 'Admin';
        const clsObj = await verifyClassOwnership(db, isAdmin ? null : teacherId, classId);

        let dateFilter = '';
        let lmsDateFilter = '';
        const params = [classId];
        const lmsParams = [classId];

        if (range === '7d') {
            dateFilter = 'AND ar.session_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
            lmsDateFilter = 'AND al.created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        } else if (range === '30d') {
            dateFilter = 'AND ar.session_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
            lmsDateFilter = 'AND al.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
        } else if (range === 'month') {
            dateFilter = "AND ar.session_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
            lmsDateFilter = "AND al.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
        }

        // 1. Session Trend Data
        const [trend] = await db.query(`
            SELECT 
                DATE_FORMAT(session_date, '%Y-%m-%d') AS session_date,
                DAYNAME(session_date) AS day_name,
                COUNT(*) AS total_recorded,
                SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) AS present_count,
                SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) AS late_count,
                SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) AS absent_count,
                SUM(CASE WHEN status = 'Excused' THEN 1 ELSE 0 END) AS excused_count
            FROM attendance_records ar
            WHERE class_id = ? ${dateFilter}
            GROUP BY session_date
            ORDER BY session_date ASC
        `, params);

        // 2. Student Aggregated Stats with Real-Time LMS Presence & Activity Telemetry
        const [students] = await db.query(`
            SELECT 
                u.user_id AS student_id,
                u.first_name,
                u.last_name,
                u.lrn_number,
                u.profile_pic,
                u.sex,
                u.email,
                CASE WHEN u.current_session_id IS NOT NULL AND lms.last_login >= DATE_SUB(NOW(), INTERVAL 30 MINUTE) THEN 1 ELSE 0 END AS is_online_now,
                COUNT(DISTINCT ar.attendance_id) AS total_sessions,
                COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.attendance_id ELSE NULL END) AS present_count,
                COUNT(DISTINCT CASE WHEN ar.status = 'Late' THEN ar.attendance_id ELSE NULL END) AS late_count,
                COUNT(DISTINCT CASE WHEN ar.status = 'Absent' THEN ar.attendance_id ELSE NULL END) AS absent_count,
                COUNT(DISTINCT CASE WHEN ar.status = 'Excused' THEN ar.attendance_id ELSE NULL END) AS excused_count,
                MAX(CASE WHEN ar.status IN ('Present', 'Late') THEN DATE_FORMAT(ar.session_date, '%Y-%m-%d') ELSE NULL END) AS last_present_date,
                lms.last_login,
                DATE_FORMAT(lms.last_login, '%Y-%m-%d %H:%i') AS last_login_formatted,
                COALESCE(lms.total_logins, 0) AS total_logins,
                COALESCE(lms.active_lms_days, 0) AS active_lms_days
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            LEFT JOIN (
                SELECT 
                    actor_id,
                    MAX(created_at) AS last_login,
                    COUNT(log_id) AS total_logins,
                    COUNT(DISTINCT DATE(created_at)) AS active_lms_days
                FROM activity_logs
                WHERE action = 'LOGIN_SUCCESS'
                GROUP BY actor_id
            ) lms ON lms.actor_id = u.user_id
            LEFT JOIN attendance_records ar 
                ON ar.student_id = u.user_id 
               AND ar.class_id = cs.class_id
               ${dateFilter}
            WHERE cs.class_id = ? AND u.role = 'Student'
            GROUP BY u.user_id
            ORDER BY u.last_name ASC, u.first_name ASC
        `, params);

        // 3. LMS Login Timeline for class (Cross-reference with roll call days)
        const [lmsTimeline] = await db.query(`
            SELECT 
                DATE_FORMAT(al.created_at, '%Y-%m-%d') AS login_date,
                DAYNAME(al.created_at) AS day_name,
                COUNT(DISTINCT al.actor_id) AS unique_students_logged_in,
                COUNT(al.log_id) AS total_login_events
            FROM activity_logs al
            JOIN class_students cs ON cs.student_id = al.actor_id
            WHERE cs.class_id = ? AND al.action = 'LOGIN_SUCCESS' ${lmsDateFilter}
            GROUP BY DATE(al.created_at)
            ORDER BY DATE(al.created_at) ASC
        `, lmsParams);

        // 4. Consecutive Absences & Status History Map
        const [recentLogs] = await db.query(`
            SELECT student_id, DATE_FORMAT(session_date, '%Y-%m-%d') as session_date, status
            FROM attendance_records
            WHERE class_id = ?
            ORDER BY session_date DESC
        `, [classId]);

        const studentLogsMap = {};
        recentLogs.forEach(r => {
            if (!studentLogsMap[r.student_id]) studentLogsMap[r.student_id] = [];
            studentLogsMap[r.student_id].push(r.status);
        });

        // 5. Calculate Roll Call Metrics
        let totalPresent = 0, totalLate = 0, totalAbsent = 0, totalExcused = 0, totalEntries = 0;
        trend.forEach(t => {
            t.present_count = Number(t.present_count);
            t.late_count = Number(t.late_count);
            t.absent_count = Number(t.absent_count);
            t.excused_count = Number(t.excused_count);
            t.total_recorded = Number(t.total_recorded);
            t.rate = t.total_recorded > 0 ? Math.round(((t.present_count + t.late_count) / t.total_recorded) * 100) : 0;
            totalPresent += t.present_count;
            totalLate += t.late_count;
            totalAbsent += t.absent_count;
            totalExcused += t.excused_count;
            totalEntries += t.total_recorded;
        });

        const now = new Date();
        let onlineNowCount = 0;
        let activeTodayCount = 0;
        let activeThisWeekCount = 0;
        let inactiveLmsCount = 0;
        let ghostStudentCount = 0;
        let loggedInEverCount = 0;

        let criticalCount = 0, atRiskCount = 0, goodCount = 0, exemplaryCount = 0, perfectCount = 0;

        const studentStats = students.map(s => {
            const pres = Number(s.present_count || 0);
            const late = Number(s.late_count || 0);
            const abs = Number(s.absent_count || 0);
            const exc = Number(s.excused_count || 0);
            const total = Number(s.total_sessions || 0);
            const attended = pres + late;
            const rate = total > 0 ? Math.round((attended / total) * 100) : 0;
            const punctuality = attended > 0 ? Math.round((pres / attended) * 100) : 100;

            const isOnline = Number(s.is_online_now) === 1;
            if (isOnline) onlineNowCount++;

            // LMS Presence Calculation
            let presenceTier = 'Dormant';
            let presenceLabel = 'Never Logged In';
            let daysSinceLogin = null;

            if (s.last_login) {
                loggedInEverCount++;
                const loginDate = new Date(s.last_login);
                const diffMs = now - loginDate;
                daysSinceLogin = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

                if (isOnline) {
                    presenceTier = 'Online';
                    presenceLabel = 'Online Now';
                } else if (diffMs < 24 * 60 * 60 * 1000 && loginDate.getDate() === now.getDate()) {
                    presenceTier = 'Active Today';
                    presenceLabel = 'Active Today';
                    activeTodayCount++;
                } else if (diffMs <= 7 * 24 * 60 * 60 * 1000) {
                    presenceTier = 'Active This Week';
                    presenceLabel = `${daysSinceLogin}d ago`;
                    activeThisWeekCount++;
                } else if (diffMs <= 14 * 24 * 60 * 60 * 1000) {
                    presenceTier = 'Inactive';
                    presenceLabel = `${daysSinceLogin}d ago`;
                    inactiveLmsCount++;
                } else {
                    presenceTier = 'Dormant';
                    presenceLabel = `${daysSinceLogin}d ago`;
                    inactiveLmsCount++;
                    ghostStudentCount++;
                }
            } else {
                inactiveLmsCount++;
                ghostStudentCount++;
            }

            // Consecutive absences
            const logs = studentLogsMap[s.student_id] || [];
            let consecutiveAbsences = 0;
            for (const st of logs) {
                if (st === 'Absent') consecutiveAbsences++;
                else break;
            }

            // Physical Attendance Standing Tier
            let tier = 'Good';
            let badgeColor = 'blue';
            if (total === 0) {
                tier = 'No Data';
                badgeColor = 'slate';
            } else if (rate < 75 || abs >= 3 || consecutiveAbsences >= 2) {
                tier = 'Critical';
                badgeColor = 'rose';
                criticalCount++;
            } else if (rate < 85 || abs >= 2) {
                tier = 'At Risk';
                badgeColor = 'amber';
                atRiskCount++;
            } else if (rate >= 95) {
                tier = 'Exemplary';
                badgeColor = 'emerald';
                exemplaryCount++;
                if (rate === 100 && total > 0) perfectCount++;
            } else {
                tier = 'Good';
                badgeColor = 'blue';
                goodCount++;
            }

            // Dual Cross-Audit (Physical Attendance vs Digital LMS Presence)
            let engagementCategory = 'Balanced';
            let engagementBadge = 'bg-slate-100 text-slate-700';

            const isLmsActive = daysSinceLogin !== null && daysSinceLogin <= 7;
            const isClassAttending = rate >= 80;

            if (isClassAttending && isLmsActive) {
                engagementCategory = 'All-Star (Class + LMS)';
                engagementBadge = 'bg-emerald-100 text-emerald-800 border-emerald-200';
            } else if (isClassAttending && !isLmsActive) {
                engagementCategory = 'Class Only (LMS Inactive)';
                engagementBadge = 'bg-amber-100 text-amber-800 border-amber-200';
            } else if (!isClassAttending && isLmsActive) {
                engagementCategory = 'LMS Active (Class Absentee)';
                engagementBadge = 'bg-sky-100 text-sky-800 border-sky-200';
            } else {
                engagementCategory = 'Ghost / Severe Disengagement';
                engagementBadge = 'bg-rose-100 text-rose-800 border-rose-200';
            }

            return {
                student_id: s.student_id,
                name: `${s.last_name}, ${s.first_name}`,
                first_name: s.first_name,
                last_name: s.last_name,
                lrn_number: s.lrn_number || '—',
                profile_pic: s.profile_pic,
                sex: s.sex || '—',
                email: s.email,
                is_online_now: isOnline,
                last_login_formatted: s.last_login_formatted || 'Never logged in',
                days_since_login: daysSinceLogin,
                presence_tier: presenceTier,
                presence_label: presenceLabel,
                total_logins: Number(s.total_logins),
                active_lms_days: Number(s.active_lms_days),
                total_sessions: total,
                present_count: pres,
                late_count: late,
                absent_count: abs,
                excused_count: exc,
                attended_count: attended,
                attendance_rate: rate,
                punctuality_rate: punctuality,
                consecutive_absences: consecutiveAbsences,
                last_present_date: s.last_present_date || '—',
                tier,
                badgeColor,
                engagementCategory,
                engagementBadge
            };
        });

        // 6. Weekday Aggregation (Monday - Friday)
        const weekdaysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const weekdayMap = {};
        weekdaysOrder.forEach(day => {
            weekdayMap[day] = { day, totalPresentLate: 0, totalRecorded: 0, sessions: 0 };
        });
        trend.forEach(t => {
            if (weekdayMap[t.day_name]) {
                weekdayMap[t.day_name].totalPresentLate += (t.present_count + t.late_count);
                weekdayMap[t.day_name].totalRecorded += t.total_recorded;
                weekdayMap[t.day_name].sessions++;
            }
        });
        const weekdayStats = weekdaysOrder.map(day => {
            const item = weekdayMap[day];
            const rate = item.totalRecorded > 0 ? Math.round((item.totalPresentLate / item.totalRecorded) * 100) : 0;
            return { day, rate, sessions: item.sessions };
        });

        const overallAttendanceRate = totalEntries > 0 ? Math.round(((totalPresent + totalLate) / totalEntries) * 100) : 100;
        const overallPunctualityRate = (totalPresent + totalLate) > 0 ? Math.round((totalPresent / (totalPresent + totalLate)) * 100) : 100;
        const avgDailyAttendance = trend.length > 0 ? (totalEntries > 0 ? ((totalPresent + totalLate) / trend.length).toFixed(1) : 0) : 0;
        const lmsAdoptionRate = students.length > 0 ? Math.round((loggedInEverCount / students.length) * 100) : 0;

        res.json({
            success: true,
            class_id: classId,
            class_name: clsObj.class_name,
            range,
            summary: {
                enrolledCount: students.length,
                totalSessionsHeld: trend.length,
                overallAttendanceRate,
                overallPunctualityRate,
                avgDailyAttendance,
                totalPresent,
                totalLate,
                totalAbsent,
                totalExcused,
                totalEntries,
                perfectCount,
                criticalCount,
                atRiskCount,
                goodCount,
                exemplaryCount,
                // LMS digital presence summary
                onlineNowCount,
                activeTodayCount,
                activeThisWeekCount,
                inactiveLmsCount,
                ghostStudentCount,
                lmsAdoptionRate
            },
            trend,
            lmsTimeline,
            distribution: {
                present: totalPresent,
                late: totalLate,
                absent: totalAbsent,
                excused: totalExcused
            },
            weekdayStats,
            studentStats
        });
    } catch (e) {
        console.error('Error fetching attendance analytics:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /teacher/api/attendance/:classId/student/:studentId/history — Detailed student attendance timeline
router.get('/api/attendance/:classId/student/:studentId/history', isTeacher, async (req, res) => {
    try {
        const { classId, studentId } = req.params;
        const teacherId = req.user.user_id;

        // Verify class ownership (read-only view permitted for archived classes)
        const isAdmin = req.user.role === 'Admin';
        const clsObj = await verifyClassOwnership(db, isAdmin ? null : teacherId, classId);

        // Student info with LMS telemetry
        const [studentRows] = await db.query(`
            SELECT 
                u.user_id, u.first_name, u.last_name, u.lrn_number, u.profile_pic, u.sex, u.email,
                (u.current_session_id IS NOT NULL AND (SELECT MAX(created_at) FROM activity_logs WHERE actor_id = u.user_id AND action = 'LOGIN_SUCCESS') >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)) AS is_online_now,
                (SELECT DATE_FORMAT(MAX(created_at), '%M %d, %Y %h:%i %p') FROM activity_logs WHERE actor_id = u.user_id AND action = 'LOGIN_SUCCESS') AS last_login_formatted,
                (SELECT COUNT(*) FROM activity_logs WHERE actor_id = u.user_id AND action = 'LOGIN_SUCCESS') AS total_logins,
                (SELECT COUNT(DISTINCT DATE(created_at)) FROM activity_logs WHERE actor_id = u.user_id AND action = 'LOGIN_SUCCESS') AS active_lms_days
            FROM users u WHERE u.user_id = ?
        `, [studentId]);
        if (!studentRows.length) return res.status(404).json({ success: false, error: 'Student not found' });

        const [history] = await db.query(`
            SELECT 
                ar.attendance_id,
                DATE_FORMAT(ar.session_date, '%Y-%m-%d') AS session_date,
                DAYNAME(ar.session_date) AS day_name,
                DATE_FORMAT(ar.check_in_time, '%H:%i') AS check_in_time,
                ar.status,
                ar.attendance_method,
                ar.override_reason,
                ar.created_at
            FROM attendance_records ar
            WHERE ar.class_id = ? AND ar.student_id = ?
            ORDER BY ar.session_date DESC
        `, [classId, studentId]);

        res.json({
            success: true,
            class_name: clsObj.class_name,
            student: studentRows[0],
            history
        });
    } catch (e) {
        console.error('Error fetching student attendance history:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});


// ============================================================
// SIDEBAR PAGE ROUTES
//
// BUG FIX (PRIMARY CRASH CAUSE):
// The original code had these bare render calls:
//
//   router.get('/classes', (req, res) => res.render('teacher/class-list'));  ← WRONG
//   router.get('/dashboard', (req, res) => res.render('teacher/dashboard')); ← WRONG
//
// These rendered templates WITHOUT the required data variables, causing:
//   ReferenceError: classData is not defined (class-list.ejs line 6)
//
// Fixes applied:
//   1. /dashboard — removed duplicate (already handled by the full route above)
//   2. /classes   — now renders 'teacher/classes' (overview) with actual class data,
//                   NOT 'teacher/class-list' which requires classData/students/stats
//   3. All sidebar routes now use isTeacher middleware and pass `user` at minimum
// ============================================================

// router.get('/question-bank', isTeacher, (req, res) => res.render('teacher/question_bank', { user: req.user }));
//router.get('/reports',       isTeacher, (req, res) => res.render('teacher/reports',        { user: req.user }));


// ============================================================
// CALENDAR EVENTS
// ============================================================

router.post('/events/add', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { subject_id, event_title, event_description, event_type, event_date,
        duration_type, start_date, end_date, duration_minutes, is_repeatable, repeat_cycle } = req.body;
    const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'));
    try {
        const [result] = await db.query(`
            INSERT INTO calendar_events 
            (teacher_id, subject_id, event_title, event_description, event_type, 
             event_date, duration_type, start_date, end_date, duration_minutes, is_repeatable, repeat_cycle) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [teacherId, subject_id, event_title, event_description, event_type, event_date, duration_type,
                start_date || null, end_date || null, duration_minutes || null,
                is_repeatable === 'on' ? 1 : 0, is_repeatable === 'on' ? repeat_cycle : null]
        );
        if (isAjax) {
            return res.json({ success: true, event_id: result.insertId });
        }
        res.redirect('/teacher/dashboard');
    } catch (err) {
        console.error("❌ Error adding event:", err);
        if (isAjax) {
            return res.status(500).json({ success: false, error: "Failed to save event." });
        }
        res.status(500).send("Failed to save event.");
    }
});

router.post('/api/calendar-event', isTeacher, async (req, res) => {
    try {
        const { subject_id, event_title, event_type, event_date, duration_type,
            start_date, end_date, duration_minutes, event_location, event_description,
            is_repeatable, repeat_cycle } = req.body;
        if (!event_title) throw new Error('event_title missing');
        if (!event_date) throw new Error('event_date missing');
        const [calResult] = await db.execute(
            `INSERT INTO calendar_events (subject_id, teacher_id, event_title, event_type, event_date, duration_type, start_date, end_date, duration_minutes, event_location, event_description, is_repeatable, repeat_cycle)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [subject_id, req.user.user_id, event_title, event_type || 'Material', event_date,
                duration_type || 'None', start_date || null, end_date || null, duration_minutes || null,
                event_location || 'TBA', event_description || null, is_repeatable ? 1 : 0, repeat_cycle || 'None']
        );

        // Notify enrolled students in this subject
        try {
            const [students] = await db.query(`
                SELECT cs.student_id
                FROM classes c
                JOIN class_students cs ON c.class_id = cs.class_id
                WHERE c.subject_id = ?
            `, [subject_id]);

            if (students.length > 0) {
                const studentIds = [...new Set(students.map(s => s.student_id))];
                const dateStr = new Date(event_date).toLocaleDateString();
                await notificationService.dispatch({
                    recipientIds: studentIds,
                    actorId: req.user.user_id,
                    role: 'Student',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'calendar_event_created',
                    title: `Calendar Event: ${event_title}`,
                    message: `${event_type || 'Event'} scheduled on ${dateStr}.`,
                    targetUrl: '/events',
                    metadata: { subjectId: subject_id, eventDate: event_date, eventId: calResult.insertId }
                });
            }
        } catch (notifErr) {
            console.error('[Calendar Event Notification Error]', notifErr.message);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/calendar-event/:eid', isTeacher, async (req, res) => {
    try {
        const { event_title, event_type, event_date, duration_type, start_date, end_date,
            duration_minutes, event_location, event_description, is_repeatable, repeat_cycle } = req.body;
        if (!event_title) throw new Error('event_title missing');
        await db.execute(
            `UPDATE calendar_events SET event_title=?, event_type=?, event_date=?, duration_type=?,
             start_date=?, end_date=?, duration_minutes=?, event_location=?, event_description=?,
             is_repeatable=?, repeat_cycle=? WHERE event_id=? AND teacher_id=?`,
            [event_title, event_type, event_date, duration_type || 'None', start_date || null,
                end_date || null, duration_minutes || null, event_location || 'TBA',
                event_description || null, is_repeatable ? 1 : 0, repeat_cycle || 'None', req.params.eid, req.user.user_id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/calendar-event/:eid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM calendar_events WHERE event_id = ? AND teacher_id = ?`, [req.params.eid, req.user.user_id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// MESSAGES
// ============================================================

router.get('/api/forum-replies/:forumId', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const forumId = req.params.forumId;
        const [replies] = await db.execute(`
            SELECT fr.*, u.first_name, u.last_name, u.profile_pic, u.role,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS vote_count,
                   (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.created_at ASC`, [teacherId, forumId]);

        replies.forEach(r => {
            if (r.is_anonymous && r.role === 'Student') {
                if (r.is_unmasked > 0) {
                    r.first_name = `${r.first_name} ${r.last_name} (Unmasked)`;
                    r.last_name = '';
                    r.unmasked = true;
                } else {
                    r.first_name = 'Anonymous';
                    r.last_name = 'Student';
                    r.profile_pic = 'default_avatar.png';
                    r.user_id = null;
                    r.unmasked = false;
                }
            }
        });

        const [topics] = await db.execute(`
            SELECT ft.*, CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, u.profile_pic AS teacher_pic,
                   t.topic_name, s.subject_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN subjects s ON ft.subject_id = s.subject_id
            WHERE ft.forum_id = ?`, [forumId]);

        res.json({ replies, topic: topics[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// TEACHER MESSAGING MODULE — Security Guards, Directory & REST APIs
// ============================================================

/**
 * Strict Teacher Messaging Authorization Guard
 * Enforces that a teacher can ONLY communicate with:
 * 1. Students enrolled in at least one class taught by this teacher (classes.teacher_id = ?)
 * 2. Users with whom the teacher already has an existing conversation thread in private_messages
 */
async function canTeacherCommunicate(teacherId, targetUserId) {
    const tId = parseInt(teacherId, 10);
    const uId = parseInt(targetUserId, 10);
    if (isNaN(tId) || isNaN(uId) || tId === uId) return false;

    try {
        const [rows] = await db.query(`
            SELECT 1
            WHERE EXISTS (
                -- 1. Student enrolled in any class taught by this teacher
                SELECT 1
                FROM classes c
                JOIN class_students cs ON cs.class_id = c.class_id
                WHERE c.teacher_id = ? AND cs.student_id = ?
            )
            OR EXISTS (
                -- 2. Existing message history between teacher and user
                SELECT 1
                FROM private_messages pm
                WHERE (pm.sender_id = ? AND pm.receiver_id = ?)
                   OR (pm.sender_id = ? AND pm.receiver_id = ?)
            )
            LIMIT 1
        `, [tId, uId, tId, uId, uId, tId]);

        return rows.length > 0;
    } catch (err) {
        console.error('[CAN TEACHER COMMUNICATE GUARD ERROR]', err);
        return false;
    }
}

/**
 * Retrieves the authorized student contacts directory for a teacher,
 * deduplicated by student user_id and enriched with shared classes & subjects.
 */
async function getAuthorizedTeacherContacts(teacherId, searchQuery = '', classIdFilter = null, subjectIdFilter = null) {
    const tId = parseInt(teacherId, 10);
    if (isNaN(tId)) return [];

    let filterClause = '';
    const params = [tId];

    if (searchQuery && searchQuery.trim().length > 0) {
        filterClause += ` AND (
            contact.first_name LIKE ? OR
            contact.last_name LIKE ? OR
            CONCAT(contact.first_name, ' ', contact.last_name) LIKE ? OR
            COALESCE(contact.lrn_number, '') LIKE ? OR
            COALESCE(contact.section, '') LIKE ? OR
            COALESCE(contact.grade_level, '') LIKE ? OR
            COALESCE(contact.strand, '') LIKE ? OR
            contact.subject_code LIKE ? OR
            contact.subject_name LIKE ? OR
            contact.class_name LIKE ?
        )`;
        const q = `%${searchQuery.trim()}%`;
        params.push(q, q, q, q, q, q, q, q, q, q);
    }

    if (classIdFilter) {
        const clsId = parseInt(classIdFilter, 10);
        if (!isNaN(clsId)) {
            filterClause += ` AND contact.class_id = ?`;
            params.push(clsId);
        }
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
            contact.lrn_number,
            contact.lrn_number AS id_number,
            contact.first_name,
            contact.last_name,
            contact.role,
            contact.profile_pic,
            contact.section,
            contact.grade_level,
            contact.strand,
            contact.department,
            'student' AS contact_type,
            GROUP_CONCAT(DISTINCT contact.subject_code ORDER BY contact.subject_code SEPARATOR ', ') AS shared_subjects,
            GROUP_CONCAT(DISTINCT contact.subject_id ORDER BY contact.subject_id SEPARATOR ',') AS shared_subject_ids,
            GROUP_CONCAT(DISTINCT contact.class_id ORDER BY contact.class_id SEPARATOR ',') AS shared_class_ids,
            GROUP_CONCAT(DISTINCT CONCAT(contact.subject_code, ' (', contact.class_name, ')') ORDER BY contact.subject_code SEPARATOR ', ') AS shared_classes
        FROM (
            SELECT
                u.user_id,
                u.lrn_number,
                u.first_name,
                u.last_name,
                u.role,
                u.profile_pic,
                u.section,
                u.grade_level,
                u.strand,
                u.department,
                c.class_id,
                c.class_name,
                s.subject_id,
                s.subject_code,
                s.subject_name
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            JOIN users u ON cs.student_id = u.user_id
            WHERE c.teacher_id = ?
        ) contact
        WHERE 1=1 ${filterClause}
        GROUP BY
            contact.user_id,
            contact.lrn_number,
            contact.first_name,
            contact.last_name,
            contact.role,
            contact.profile_pic,
            contact.section,
            contact.grade_level,
            contact.strand,
            contact.department
        ORDER BY contact.last_name ASC, contact.first_name ASC
    `;

    const [rows] = await db.query(sql, params);
    return rows;
}

router.canTeacherCommunicate = canTeacherCommunicate;
router.getAuthorizedTeacherContacts = getAuthorizedTeacherContacts;

// ── GET /teacher/messages — Dedicated Teacher Messenger Workspace ─────────────
router.get('/messages', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;

        const [teacherClasses] = await db.query(`
            SELECT
                c.class_id,
                c.class_name,
                c.subject_id,
                s.subject_code,
                s.subject_name,
                COUNT(DISTINCT cs.student_id) AS student_count
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN class_students cs ON c.class_id = cs.class_id
            WHERE c.teacher_id = ?
            GROUP BY c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name
            ORDER BY s.subject_code ASC, c.class_name ASC
        `, [teacherId]);

        const subjectMap = new Map();
        for (const cls of teacherClasses) {
            if (!subjectMap.has(cls.subject_id)) {
                subjectMap.set(cls.subject_id, {
                    subject_id: cls.subject_id,
                    subject_code: cls.subject_code,
                    subject_name: cls.subject_name
                });
            }
        }
        const uniqueSubjects = Array.from(subjectMap.values());
        const notifications = await getTeacherNotifications(db, teacherId);

        res.render('teacher/messages', {
            user: req.user,
            classes: teacherClasses,
            subjects: uniqueSubjects,
            notifications,
            activeNav: 'none'
        });
    } catch (err) {
        console.error('[GET /teacher/messages Error]', err);
        res.status(500).send('Unable to load teacher messaging workspace.');
    }
});

// ── GET /teacher/messages/:studentId — Deep-Link Resolver for Notification Clicks ─
router.get('/messages/:studentId', isTeacher, async (req, res) => {
    try {
        const studentId = parseInt(req.params.studentId, 10);
        if (isNaN(studentId)) {
            return res.redirect('/teacher/messages');
        }
        return res.redirect(`/teacher/messages?userId=${studentId}`);
    } catch (err) {
        console.error('[GET /teacher/messages/:studentId Error]', err);
        return res.redirect('/teacher/messages');
    }
});

// ── GET /teacher/api/messaging/contacts — Directory of Enrolled Students ──────
router.get('/api/messaging/contacts', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const q = req.query.q || '';
        const classId = req.query.class_id || null;
        const subjectId = req.query.subject_id || null;

        const contacts = await getAuthorizedTeacherContacts(teacherId, q, classId, subjectId);
        res.json({ success: true, count: contacts.length, contacts });
    } catch (err) {
        console.error('[GET /teacher/api/messaging/contacts Error]', err);
        res.status(500).json({ error: 'Failed to retrieve student directory' });
    }
});

// ── GET /teacher/api/messaging/conversations — Active Threads List ────────────
router.get('/api/messaging/conversations', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;

        const [rows] = await db.query(`
            SELECT
                partner.user_id                                        AS other_user_id,
                partner.lrn_number                                     AS other_lrn,
                partner.lrn_number                                     AS other_id_number,
                CONCAT(partner.first_name, ' ', partner.last_name)     AS other_name,
                partner.first_name                                     AS other_first_name,
                partner.last_name                                      AS other_last_name,
                partner.role                                           AS other_role,
                partner.profile_pic                                    AS other_pic,
                partner.section                                        AS other_section,
                partner.grade_level                                    AS other_grade_level,
                partner.strand                                         AS other_strand,
                partner.department                                     AS other_department,
                latest.message_text                                    AS last_message,
                latest.sent_at,
                COALESCE(unread.cnt, 0)                                AS unread,
                'student'                                              AS contact_type,
                (
                    SELECT GROUP_CONCAT(DISTINCT CONCAT(s.subject_code, ' (', c.class_name, ')') ORDER BY s.subject_code SEPARATOR ', ')
                    FROM classes c
                    JOIN subjects s ON c.subject_id = s.subject_id
                    JOIN class_students cs ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND cs.student_id = partner.user_id
                ) AS shared_classes,
                (
                    SELECT GROUP_CONCAT(DISTINCT s.subject_code ORDER BY s.subject_code SEPARATOR ', ')
                    FROM classes c
                    JOIN subjects s ON c.subject_id = s.subject_id
                    JOIN class_students cs ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND cs.student_id = partner.user_id
                ) AS shared_subjects
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
            ORDER BY latest.sent_at DESC, latest.message_id DESC
        `, [teacherId, teacherId, teacherId, teacherId, teacherId, teacherId]);

        res.json(rows);
    } catch (err) {
        console.error('[GET /teacher/api/messaging/conversations Error]', err);
        res.status(500).json([]);
    }
});

// ── GET /teacher/api/messaging/thread/:partnerId — Full Thread + Partner Info ─
router.get('/api/messaging/thread/:partnerId', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const partnerId = parseInt(req.params.partnerId, 10);
        if (isNaN(partnerId)) {
            return res.status(400).json({ error: 'Valid student/partner user ID required' });
        }

        const allowed = await canTeacherCommunicate(teacherId, partnerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only message students enrolled in your classes.' });
        }

        const [messages] = await db.query(`
            SELECT message_id, sender_id, receiver_id, message_text, sent_at, is_read
            FROM private_messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY sent_at ASC, message_id ASC
        `, [teacherId, partnerId, partnerId, teacherId]);

        const markRead = req.query.markRead !== 'false';
        if (markRead) {
            await db.query(
                `UPDATE private_messages SET is_read = 1
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [partnerId, teacherId]
            );
            await notificationService.markSenderMessageNotificationsRead({ userId: teacherId, senderId: partnerId });
        }

        const [partnerRows] = await db.query(`
            SELECT
                u.user_id,
                u.lrn_number,
                u.lrn_number AS id_number,
                u.first_name,
                u.last_name,
                u.role,
                u.profile_pic,
                u.section,
                u.grade_level,
                u.strand,
                u.department,
                (
                    SELECT GROUP_CONCAT(DISTINCT CONCAT(s.subject_code, ' (', c.class_name, ')') ORDER BY s.subject_code SEPARATOR ', ')
                    FROM classes c
                    JOIN subjects s ON c.subject_id = s.subject_id
                    JOIN class_students cs ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND cs.student_id = u.user_id
                ) AS shared_classes,
                (
                    SELECT GROUP_CONCAT(DISTINCT s.subject_code ORDER BY s.subject_code SEPARATOR ', ')
                    FROM classes c
                    JOIN subjects s ON c.subject_id = s.subject_id
                    JOIN class_students cs ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND cs.student_id = u.user_id
                ) AS shared_subjects
            FROM users u
            WHERE u.user_id = ?
            LIMIT 1
        `, [teacherId, teacherId, partnerId]);

        res.json({
            success: true,
            messages,
            partner: partnerRows[0] || null
        });
    } catch (err) {
        console.error('[GET /teacher/api/messaging/thread/:partnerId Error]', err);
        res.status(500).json({ error: 'Failed to retrieve conversation thread' });
    }
});

// ── GET /teacher/api/messaging/poll — Delta Polling Endpoint ──────────────────
router.get('/api/messaging/poll', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const partnerId = parseInt(req.query.partnerId || req.query.partner_id, 10);
        const since = req.query.since || null;

        if (isNaN(partnerId)) {
            return res.status(400).json({ error: 'partnerId is required' });
        }

        const allowed = await canTeacherCommunicate(teacherId, partnerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only communicate with students enrolled in your classes.' });
        }

        let query = `
            SELECT message_id, sender_id, receiver_id, message_text, sent_at, is_read
            FROM private_messages
            WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        `;
        const params = [teacherId, partnerId, partnerId, teacherId];

        if (since) {
            const sinceDate = new Date(since);
            if (!isNaN(sinceDate.getTime())) {
                query += ` AND sent_at > ?`;
                params.push(sinceDate);
            }
        }

        query += ` ORDER BY sent_at ASC, message_id ASC`;

        const [newMessages] = await db.query(query, params);

        const markRead = req.query.markRead !== 'false';
        if (markRead && newMessages.some(m => m.receiver_id === teacherId && !m.is_read)) {
            await db.query(
                `UPDATE private_messages SET is_read = 1
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [partnerId, teacherId]
            );
            await notificationService.markSenderMessageNotificationsRead({ userId: teacherId, senderId: partnerId });
        }

        res.json({ success: true, messages: newMessages });
    } catch (err) {
        console.error('[GET /teacher/api/messaging/poll Error]', err);
        res.status(500).json({ error: 'Failed to poll messages' });
    }
});

// ── POST /teacher/api/messaging/read — Explicit Mark Read Endpoint ────────────
router.post('/api/messaging/read', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const partnerId = parseInt(req.body.partner_id || req.body.partnerId, 10);
        if (isNaN(partnerId)) {
            return res.status(400).json({ error: 'partner_id is required' });
        }

        await db.query(
            `UPDATE private_messages SET is_read = 1
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [partnerId, teacherId]
        );
        await notificationService.markSenderMessageNotificationsRead({ userId: teacherId, senderId: partnerId });
        res.json({ success: true });
    } catch (err) {
        console.error('[POST /teacher/api/messaging/read Error]', err);
        res.status(500).json({ error: 'Failed to mark messages as read' });
    }
});

// ── GET /teacher/api/messages/:studentId (Preserved for class-view.ejs) ───────
router.get('/api/messages/:studentId', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const studentId = parseInt(req.params.studentId, 10);
        if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid studentId' });

        const allowed = await canTeacherCommunicate(teacherId, studentId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only message students enrolled in your classes.' });
        }

        const [messages] = await db.execute(`
            SELECT * FROM private_messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY sent_at ASC, message_id ASC LIMIT 200`,
            [teacherId, studentId, studentId, teacherId]);

        if (req.query.markRead !== 'false') {
            await db.query(
                `UPDATE private_messages SET is_read = 1
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [studentId, teacherId]
            );
            await notificationService.markSenderMessageNotificationsRead({ userId: teacherId, senderId: studentId });
        }

        res.json({ messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /teacher/api/messages & /teacher/api/messaging/send ──────────────────
async function handleTeacherSendMessage(req, res) {
    try {
        const teacherId = req.user.user_id;
        const receiverId = parseInt(req.body.receiver_id || req.body.partner_id, 10);
        const messageText = (req.body.message_text || req.body.text || '').trim();

        if (isNaN(receiverId)) return res.status(400).json({ error: 'receiver_id missing' });
        if (!messageText) return res.status(400).json({ error: 'Empty message' });

        const allowed = await canTeacherCommunicate(teacherId, receiverId);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: You can only message students enrolled in your classes.' });
        }

        const [result] = await db.execute(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text, is_read) VALUES (?, ?, ?, 0)`,
            [teacherId, receiverId, messageText]
        );

        // Dispatch in-app notification to student
        try {
            const senderName = `${req.user.first_name || 'Instructor'} ${req.user.last_name || ''}`.trim();
            const previewText = messageText.length > 80 ? messageText.substring(0, 77) + '...' : messageText;
            await notificationService.dispatch({
                recipientIds: receiverId,
                actorId: teacherId,
                role: 'Student',
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_received',
                title: `Message from ${senderName}`,
                message: previewText,
                targetUrl: `/messages?userId=${teacherId}`,
                metadata: { senderId: teacherId, messageId: result.insertId }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Teacher Send Message]', notifErr.message);
        }

        res.json({
            success: true,
            message_id: result.insertId,
            sender_id: teacherId,
            receiver_id: receiverId,
            message_text: messageText,
            sent_at: new Date()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

router.post('/api/messages', isTeacher, handleTeacherSendMessage);
router.post('/api/messaging/send', isTeacher, handleTeacherSendMessage);

// ── Private Messages Media/File Upload ───────────────────────
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

async function handleTeacherMessageUpload(req, res) {
    try {
        const teacherId = req.user.user_id;
        const receiverId = parseInt(req.body.receiver_id || req.body.partner_id, 10);
        if (isNaN(receiverId)) {
            if (req.file) fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: 'receiver_id missing' });
        }
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const allowed = await canTeacherCommunicate(teacherId, receiverId);
        if (!allowed) {
            if (req.file) fs.unlink(req.file.path, () => { });
            return res.status(403).json({ error: 'Access denied: You can only message students enrolled in your classes.' });
        }

        const fileUrl = '/forum_uploads/' + req.file.filename;
        const origName = req.file.originalname;
        const msgText = fileUrl + '||' + origName;
        const [result] = await db.execute(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text, is_read) VALUES (?, ?, ?, 0)`,
            [teacherId, receiverId, msgText]
        );

        // Dispatch in-app notification to student
        try {
            const senderName = `${req.user.first_name || 'Instructor'} ${req.user.last_name || ''}`.trim();
            await notificationService.dispatch({
                recipientIds: receiverId,
                actorId: teacherId,
                role: 'Student',
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_attachment',
                title: `Attachment from ${senderName}`,
                message: `Shared an attachment: ${origName}`,
                targetUrl: `/messages?userId=${teacherId}`,
                metadata: { senderId: teacherId, messageId: result.insertId, fileUrl }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Teacher Upload Message]', notifErr.message);
        }

        res.json({
            success: true,
            message_id: result.insertId,
            sender_id: teacherId,
            receiver_id: receiverId,
            message_text: msgText,
            file_url: fileUrl,
            file_name: origName,
            sent_at: new Date()
        });
    } catch (e) {
        if (req.file) fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: e.message });
    }
}

router.post('/api/messages/upload', isTeacher, chatUpload.single('file'), handleTeacherMessageUpload);
router.post('/api/messaging/upload', isTeacher, chatUpload.single('file'), handleTeacherMessageUpload);


// ============================================================
// CLASSES LIST ROUTER — to be added inside teacher.js
// All routes prefixed with /teacher (set by the parent router)
// ============================================================

// ── GET /teacher/classes ──────────────────────────────────────
// Renders the classes_list.ejs page
router.get('/classes', isTeacher, async (req, res) => {
    console.log(`[GET] /teacher/classes — user: ${req.user?.user_id}`);
    try {
        const teacherId = req.user.user_id;
        const currentSY = await academicHelper.getCurrentSchoolYear(db);

        const [schoolYears] = await db.execute(
            `SELECT sy_id, sy_range, sy_code, status, is_active
             FROM school_years
             ORDER BY is_active DESC, sy_range DESC`
        );

        const [classes] = await db.execute(`
            SELECT
                c.class_id,
                c.class_name,
                c.subject_id,
                c.sy_id,
                sy.sy_range,
                sy.status     AS sy_status,
                sy.is_active  AS sy_is_active,
                s.subject_name,
                s.subject_code,
                s.subject_image,
                s.semester,
                s.enrollment_code,
                COUNT(DISTINCT cs.student_id)                AS student_count,
                COALESCE(ROUND(AVG(sp.progress_percent)), 0) AS avg_progress
            FROM classes c
            JOIN subjects s      ON c.subject_id = s.subject_id
            JOIN school_years sy  ON c.sy_id      = sy.sy_id
            LEFT JOIN class_students cs ON c.class_id = cs.class_id
            LEFT JOIN student_progress sp
                   ON cs.student_id = sp.student_id
                  AND sp.subject_id = c.subject_id
            WHERE c.teacher_id = ?
            GROUP BY
                c.class_id, c.class_name, c.subject_id, c.sy_id,
                sy.sy_range, sy.status, sy.is_active,
                s.subject_name, s.subject_code, s.subject_image,
                s.semester, s.enrollment_code
            ORDER BY sy.is_active DESC, sy.sy_id DESC, c.class_name ASC`,
            [teacherId]
        );

        console.log(`[DEBUG] ${classes.length} classes found for teacher ${teacherId}`);

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/class_list', {
            user: req.user,
            currentSY,
            classes: classes || [],
            schoolYears: schoolYears || [],
            notifications,
        });

    } catch (err) {
        console.error('[ERROR] GET /teacher/classes:', err);
        res.status(500).send('Internal Server Error');
    }
});


// ── GET /teacher/api/class-roster/:classId ────────────────────
// Returns full student list for a class as JSON (used by roster table)
router.get('/api/class-roster/:classId', isTeacher, async (req, res) => {
    console.log(`[GET] /teacher/api/class-roster/${req.params.classId}`);
    try {
        if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

        const classId = req.params.classId;
        const teacherId = req.user.user_id;

        // Safety: confirm this class belongs to the requesting teacher
        const [ownership] = await db.execute(
            `SELECT class_id, subject_id FROM classes WHERE class_id = ? AND teacher_id = ?`,
            [classId, teacherId]
        );
        if (!ownership.length) {
            return res.status(403).json({ error: 'Access denied or class not found' });
        }
        const subjectId = ownership[0].subject_id;

        // Full student profiles with gamification + progress data
        const [students] = await db.execute(`
            SELECT
                u.user_id,
                u.first_name,
                u.last_name,
                u.middle_name,
                u.alternative_name,
                u.suffix,
                u.email,
                u.profile_pic,
                u.lrn_number,
                u.grade_level,
                u.section,
                u.strand,
                u.department,
                u.mobile_number,
                u.home_address,
                u.city_town,
                u.sex,
                u.birthdate,
                u.self_description,
                u.current_level,
                u.flagged_assessment_id,
                COALESCE(u.total_exp, 0) AS total_exp,
                sp.progress_percent,
                sp.last_accessed
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
                                   AND cs.class_id = ?
            LEFT JOIN student_progress sp
                   ON u.user_id    = sp.student_id
                  AND sp.subject_id = ?
            WHERE u.role = 'Student'
            ORDER BY u.last_name ASC, u.first_name ASC`,
            [classId, subjectId]
        );

        // Leaderboard history per student (purged dead table)
        const studentIds = students.map(s => s.user_id);
        const lbRows = [];

        // Assessment scores per student for this subject
        let scoreRows = [];
        if (studentIds.length) {
            const placeholders = studentIds.map(() => '?').join(',');
            const [scData] = await db.execute(
                `SELECT
                     esg.student_id,
                     esg.points_earned AS score_obtained,
                     esg.points_possible AS total_items,
                     esg.points_earned AS exp_gained,
                     esg.started_at AS date_recorded,
                     COALESCE(a.assessment_name, CONCAT('Level ', esg.assessment_number, ': ', esg.level_topic)) AS assessment_name,
                     COALESCE(a.assessment_type, esg.play_mode) AS assessment_type
                 FROM elementa_student_grades esg
                 LEFT JOIN assessments a  ON esg.assessment_id = a.assessment_id
                 LEFT JOIN topics t       ON a.topic_id       = t.topic_id
                 LEFT JOIN quarters qt    ON t.quarter_id     = qt.quarter_id
                 WHERE esg.student_id IN (${placeholders})
                   AND (qt.subject_id = ? OR esg.assessment_id IS NULL)
                 ORDER BY esg.started_at DESC`,
                [...studentIds, subjectId]
            );
            scoreRows = scData;
        }

        // Merge lb history + scores into each student object
        students.forEach(s => {
            s.leaderboard_history = lbRows
                .filter(h => h.student_id === s.user_id)
                .slice(0, 5);
            s.scores = scoreRows
                .filter(sc => sc.student_id === s.user_id);
        });

        res.json({ students });

    } catch (err) {
        console.error('[ERROR] GET /teacher/api/class-roster:', err);
        res.status(500).json({ error: err.message });
    }
});


// ============================================================
// STUDENT DETAILED SCORES & TOPIC BREAKDOWN API
// ============================================================

async function handleGetStudentDetailedScores(req, res) {
    try {
        const studentId = parseInt(req.params.studentId, 10);
        const subjectId = parseInt(req.query.subject || req.query.subjectId, 10) || null;
        const classId = parseInt(req.query.classId || req.query.class_id, 10) || null;
        const teacherId = req.user.user_id;

        if (isNaN(studentId)) {
            return res.status(400).json({ success: false, error: 'Invalid student ID.' });
        }

        // 1. Verify student and instructor class association (Multi-tenant IDOR protection)
        const [studentRows] = await db.query(`
            SELECT u.user_id, u.first_name, u.last_name, u.middle_name, u.suffix, u.lrn_number,
                   u.grade_level, u.section, u.strand, u.profile_pic, u.current_level,
                   COALESCE(u.total_exp, 0) AS total_exp, u.email,
                   c.class_id, c.class_name, c.subject_id, s.subject_name, s.subject_code
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE u.user_id = ? AND (c.teacher_id = ? OR ? = 'Admin')
              AND (? IS NULL OR c.subject_id = ?)
              AND (? IS NULL OR c.class_id = ?)
            ORDER BY c.class_id ASC
            LIMIT 1
        `, [studentId, teacherId, req.user.role, subjectId, subjectId, classId, classId]);

        if (!studentRows.length) {
            return res.status(404).json({ success: false, error: 'Student record not found or access denied for this instructor account.' });
        }

        const student = studentRows[0];
        const effSubjectId = student.subject_id;
        const effClassId = student.class_id;

        // 2. Fetch all quarters and topics for this subject
        const [topics] = await db.query(`
            SELECT t.topic_id, t.topic_name, t.topic_description,
                   q.quarter_id, q.quarter_number
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
            ORDER BY q.quarter_number ASC, t.topic_id ASC
        `, [effSubjectId]);

        // 3. Fetch all assigned assessments & assignments for these topics
        const [assessments] = await db.query(`
            SELECT a.assessment_id, a.topic_id, a.quarter_id, a.assessment_name,
                   COALESCE(a.assessment_type, 'Assignment') AS assessment_type,
                   COALESCE(a.category, 'Homework') AS category,
                   COALESCE(NULLIF(a.total_items, 0), 100) AS total_items,
                   a.due_date, a.is_group_assignment, a.instructions
            FROM assessments a
            WHERE a.topic_id IN (
                SELECT t.topic_id FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE q.subject_id = ?
            )
            ORDER BY a.topic_id ASC, a.assessment_type ASC, a.assessment_id ASC
        `, [effSubjectId]);

        // 4. Fetch student's LMS scores
        const [lmsScores] = await db.query(`
            SELECT ss.score_id, ss.student_id, ss.assessment_id,
                   ss.score_obtained,
                   COALESCE(NULLIF(ss.total_items, 0), NULLIF(ss.total_possible_score, 0), a.total_items, 100) AS total_items,
                   COALESCE(ss.exp_gained, 0) AS exp_gained,
                   ss.feedback,
                   COALESCE(ss.submitted_at, ss.date_recorded) AS submitted_at,
                   ss.is_grace_period,
                   ss.attempt_number,
                   ss.group_id,
                   ss.file_path,
                   ss.original_filename,
                   'lms' AS source
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ss.student_id = ? AND q.subject_id = ?
            ORDER BY ss.assessment_id ASC, ss.attempt_number DESC, ss.score_id DESC
        `, [studentId, effSubjectId]);

        // 5. Fetch Elementa Arcade completed sessions
        const [arcadeScores] = await db.query(`
            SELECT esg.session_id, esg.assessment_id, esg.level_topic, esg.play_mode,
                   esg.correct_answers AS score_obtained,
                   esg.points_possible AS total_items,
                   esg.points_earned AS exp_gained,
                   esg.grade_percent,
                   esg.started_at AS submitted_at,
                   'arcade' AS source
            FROM elementa_student_grades esg
            JOIN assessments a ON esg.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE esg.student_id = ? AND q.subject_id = ? AND esg.run_status = 'Completed'
            ORDER BY esg.started_at DESC
        `, [studentId, effSubjectId]);

        // 6. Fetch all assigned discussion forums for this subject (including general subject-level forums where topic_id IS NULL)
        const [allSubjectForums] = await db.query(`
            SELECT ft.forum_id, ft.topic_id, ft.title, ft.base_exp, ft.due_date,
                   COALESCE(CASE WHEN q.subject_id = ft.subject_id THEN t.topic_name ELSE NULL END, 'General Subject Forum') AS topic_name,
                   COALESCE(
                       CASE WHEN q.subject_id = ft.subject_id THEN q.quarter_number ELSE NULL END,
                       (SELECT MIN(q2.quarter_number) FROM quarters q2 WHERE q2.subject_id = ft.subject_id)
                   ) AS quarter_number
            FROM forum_topics ft
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ft.subject_id = ?
            ORDER BY quarter_number ASC, ft.topic_id ASC, ft.forum_id ASC
        `, [effSubjectId]);

        // 7. Fetch student's completed forum records (using actual awarded EXP from database)
        const [studentForumDone] = await db.query(`
            SELECT sfd.id, sfd.student_id, sfd.forum_id, sfd.done_at,
                   COALESCE(sfd.exp_awarded, 0) AS exp_awarded,
                   COALESCE(sfd.time_tier, 'standard') AS time_tier,
                   ft.title, ft.topic_id, ft.base_exp, ft.due_date
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            WHERE sfd.student_id = ? AND ft.subject_id = ?
            ORDER BY sfd.done_at DESC
        `, [studentId, effSubjectId]);

        // 8. Fetch student's interactive simulation quiz submissions
        const [simulationSubmissions] = await db.query(`
            SELECT esqs.submission_id, esqs.quiz_id, esqs.student_id, esqs.simulation_slug,
                   esqs.score, esqs.total_questions, esqs.correct_count, esqs.incorrect_count,
                   esqs.percentage, esqs.exp_earned, esqs.submitted_at,
                   q.title AS quiz_title, q.total_bonus_exp, q.created_by, q.section
            FROM elementa_simulation_quiz_submissions esqs
            JOIN elementa_simulation_custom_quizzes q ON esqs.quiz_id = q.quiz_id
            WHERE esqs.student_id = ?
            ORDER BY esqs.submitted_at DESC
        `, [studentId]);

        // 9. Deduplicate per assessment_id (pick highest score obtained)
        const scoreMap = new Map();
        for (const sc of lmsScores) {
            const aid = sc.assessment_id;
            const score = Number(sc.score_obtained) || 0;
            const total = Number(sc.total_items) || 100;
            const pct = total > 0 ? (score / total) * 100 : 0;
            if (!scoreMap.has(aid) || pct > scoreMap.get(aid).pct) {
                scoreMap.set(aid, {
                    score_obtained: score,
                    total_items: total,
                    pct,
                    exp_gained: Number(sc.exp_gained) || 0,
                    feedback: sc.feedback,
                    submitted_at: sc.submitted_at,
                    is_grace_period: sc.is_grace_period,
                    attempt_number: sc.attempt_number || 1,
                    group_id: sc.group_id,
                    file_path: sc.file_path,
                    original_filename: sc.original_filename,
                    source: 'lms'
                });
            }
        }

        for (const arc of arcadeScores) {
            const aid = arc.assessment_id;
            const score = Number(arc.score_obtained) || 0;
            const total = Number(arc.total_items) || 1;
            const pct = total > 0 ? (score / total) * 100 : 0;

            // Only officially synced gradebook runs in student_scores grant credited EXP.
            // Raw gameplay logs in elementa_student_grades do not fabricate arbitrary multipliers.
            if (!scoreMap.has(aid)) {
                scoreMap.set(aid, {
                    score_obtained: score,
                    total_items: total,
                    pct,
                    exp_gained: 0,
                    feedback: `Completed via Elementa Arcade (${arc.play_mode})`,
                    submitted_at: arc.submitted_at,
                    is_grace_period: 0,
                    attempt_number: 1,
                    group_id: null,
                    file_path: null,
                    original_filename: null,
                    source: 'arcade'
                });
            } else {
                const existing = scoreMap.get(aid);
                if (pct > existing.pct) {
                    existing.score_obtained = score;
                    existing.total_items = total;
                    existing.pct = pct;
                    existing.source = 'arcade';
                }
            }
        }

        // 9. Map student forum completions by forum_id
        const studentForumDoneMap = new Map();
        for (const sfd of studentForumDone) {
            if (!studentForumDoneMap.has(sfd.forum_id)) {
                studentForumDoneMap.set(sfd.forum_id, sfd);
            }
        }

        // 10. Aggregate distribution & topic drilldowns
        let masteryCount = 0;    // >= 90%
        let proficientCount = 0; // 80% - 89%
        let approachingCount = 0;// 75% - 79%
        let developingCount = 0; // < 75%

        let subjectTotalScore = 0;
        let subjectTotalItems = 0;
        let totalCompletedTasks = 0;
        let totalAssignedTasks = assessments.length;

        // Curriculum-wide aggregate metrics (across ALL assigned courseworks in subject)
        let curriculumTotalScore = 0;
        let curriculumTotalItems = 0;
        let totalTaskPctSum = 0;

        let asmtScoreSum = 0;
        let asmtItemsSum = 0;
        let asmtExpSum = 0;
        let asmtCompletedCount = 0;
        let asgnScoreSum = 0;
        let asgnItemsSum = 0;
        let asgnExpSum = 0;
        let asgnCompletedCount = 0;

        const topicResults = topics.map(t => {
            const topicAsms = assessments.filter(a => a.topic_id === t.topic_id);
            const assessmentsList = [];
            const assignmentsList = [];

            let topicScore = 0;
            let topicItems = 0;
            let topicAsmtExp = 0;
            let topicAsgnExp = 0;
            let topicCompleted = 0;

            for (const asm of topicAsms) {
                const sc = scoreMap.get(asm.assessment_id);
                const isSubmitted = !!sc;
                const scoreObt = isSubmitted ? sc.score_obtained : null;
                const items = isSubmitted ? sc.total_items : asm.total_items;
                const exp = isSubmitted ? sc.exp_gained : 0;
                const pct = isSubmitted && items > 0 ? Math.round((scoreObt / items) * 100) : null;

                // Curriculum-wide accumulation (unsubmitted counts as 0 earned points/pct)
                curriculumTotalScore += (isSubmitted ? scoreObt : 0);
                curriculumTotalItems += (items > 0 ? items : 1);
                totalTaskPctSum += (pct !== null ? pct : 0);

                if (isSubmitted) {
                    topicScore += scoreObt;
                    topicItems += items;
                    topicCompleted++;

                    // Add to score distribution brackets
                    if (pct >= 90) masteryCount++;
                    else if (pct >= 80) proficientCount++;
                    else if (pct >= 75) approachingCount++;
                    else developingCount++;

                    // Track assessment vs assignment category aggregates
                    if (asm.assessment_type === 'Assignment') {
                        asgnScoreSum += scoreObt;
                        asgnItemsSum += items;
                        asgnExpSum += exp;
                        topicAsgnExp += exp;
                        asgnCompletedCount++;
                    } else {
                        asmtScoreSum += scoreObt;
                        asmtItemsSum += items;
                        asmtExpSum += exp;
                        topicAsmtExp += exp;
                        asmtCompletedCount++;
                    }
                }

                const itemPayload = {
                    assessment_id: asm.assessment_id,
                    assessment_name: asm.assessment_name,
                    assessment_type: asm.assessment_type,
                    category: asm.category,
                    total_items: items,
                    score_obtained: scoreObt,
                    percentage: pct,
                    exp_gained: exp,
                    is_submitted: isSubmitted,
                    submitted_at: sc?.submitted_at || null,
                    feedback: sc?.feedback || null,
                    file_path: sc?.file_path || null,
                    original_filename: sc?.original_filename || null,
                    is_group: !!asm.is_group_assignment,
                    source: sc?.source || null
                };

                if (asm.assessment_type === 'Assignment') {
                    assignmentsList.push(itemPayload);
                } else {
                    assessmentsList.push(itemPayload);
                }
            }

            // Map topic forums
            const topicForums = allSubjectForums.filter(f => f.topic_id === t.topic_id);
            let topicForumExp = 0;
            let topicForumsCompleted = 0;
            const forumsList = topicForums.map(f => {
                const done = studentForumDoneMap.get(f.forum_id);
                const isCompleted = !!done;
                const exp = isCompleted ? (Number(done.exp_awarded) || 0) : 0;
                if (isCompleted) {
                    topicForumExp += exp;
                    topicForumsCompleted++;
                }
                return {
                    forum_id: f.forum_id,
                    title: f.title,
                    due_date: f.due_date,
                    base_exp: Number(f.base_exp) || 100,
                    is_completed: isCompleted,
                    done_at: done?.done_at || null,
                    time_tier: done?.time_tier || null,
                    exp_awarded: exp
                };
            });

            const topicPct = topicItems > 0 ? Math.round((topicScore / topicItems) * 100) : (topicCompleted === 0 ? null : 0);
            let status = 'Not Started';
            if (topicCompleted > 0) {
                if (topicPct >= 85) status = 'Excelling';
                else if (topicPct >= 75) status = 'Proficient';
                else status = 'Lagging Behind';
            }

            const topicExp = topicAsmtExp + topicAsgnExp;
            const topicTotalExp = topicExp + topicForumExp;

            subjectTotalScore += topicScore;
            subjectTotalItems += topicItems;
            totalCompletedTasks += topicCompleted;

            return {
                topic_id: t.topic_id,
                topic_name: (t.topic_name || '').replace(/\s+/g, ' ').trim(),
                topic_description: t.topic_description,
                quarter_number: t.quarter_number,
                assessments: assessmentsList,
                assignments: assignmentsList,
                forums: forumsList,
                completed_count: topicCompleted,
                total_count: topicAsms.length,
                forums_completed_count: topicForumsCompleted,
                forums_total_count: topicForums.length,
                score_obtained: topicScore,
                total_items: topicItems,
                percentage: topicPct,
                assessments_exp: topicAsmtExp,
                assignments_exp: topicAsgnExp,
                forums_exp: topicForumExp,
                total_exp: topicTotalExp,
                status
            };
        });

        // 11. Process Simulation Quiz Submissions
        const simulationQuizzesList = simulationSubmissions.map(sq => {
            const score = Number(sq.score) || 0;
            const total = Number(sq.total_questions) || 0;
            const expEarned = Number(sq.exp_earned) || 0;
            const pct = sq.percentage !== null && sq.percentage !== undefined ? Number(sq.percentage) : (total > 0 ? Math.round((score / total) * 100) : 0);
            return {
                submission_id: sq.submission_id,
                quiz_id: sq.quiz_id,
                quiz_title: sq.quiz_title,
                simulation_slug: sq.simulation_slug,
                score: score,
                total_questions: total,
                correct_count: Number(sq.correct_count) || 0,
                incorrect_count: Number(sq.incorrect_count) || 0,
                percentage: pct,
                exp_earned: expEarned,
                total_bonus_exp: Number(sq.total_bonus_exp) || 0,
                submitted_at: sq.submitted_at,
                created_by: sq.created_by,
                section: sq.section
            };
        });

        const totalSimulationBonusExp = simulationQuizzesList.reduce((sum, sq) => sum + sq.exp_earned, 0);
        const totalForumExp = studentForumDone.reduce((sum, f) => sum + (Number(f.exp_awarded) || 0), 0);
        const totalForumsCompleted = studentForumDone.length;
        const totalAssignedForums = allSubjectForums.length;
        const forumCompletionRate = totalAssignedForums > 0 ? Math.round((totalForumsCompleted / totalAssignedForums) * 100) : 0;

        // Consolidated Subject EXP: Assessments EXP + Assignments EXP + Forums EXP + Simulation Bonus EXP
        const subjectTotalExp = asmtExpSum + asgnExpSum + totalForumExp + totalSimulationBonusExp;

        // Curriculum-Wide Mastery Calculations:
        // 1. Task-Normalized Curriculum Mastery (Equal Weight per Coursework):
        //    Evaluates every assigned coursework in the curriculum.
        //    Unaccomplished courseworks contribute 0% towards mastery.
        //    If Fourth completes 4 / 27 tasks with 97% avg -> 14% Curriculum Mastery.
        //    If a student finishes 27 / 27 tasks with 35% avg -> 35% Curriculum Mastery.
        //    If a student finishes 27 / 27 tasks with 95% avg -> 95% Curriculum Mastery.
        const curriculumMastery = totalAssignedTasks > 0
            ? Math.round(totalTaskPctSum / totalAssignedTasks)
            : 0;

        // 2. Point-Weighted Curriculum Mastery:
        const weightedCurriculumMastery = curriculumTotalItems > 0
            ? Math.round((curriculumTotalScore / curriculumTotalItems) * 100)
            : 0;

        // 3. Submitted Work Accuracy (Average on completed/submitted courseworks only):
        const submittedAccuracy = subjectTotalItems > 0
            ? Math.round((subjectTotalScore / subjectTotalItems) * 100)
            : 0;

        // Overall Mastery displayed on the primary KPI card represents True Curriculum Mastery
        const overallAvg = curriculumMastery;
        const asmtAvg = asmtItemsSum > 0 ? Math.round((asmtScoreSum / asmtItemsSum) * 100) : null;
        const asgnAvg = asgnItemsSum > 0 ? Math.round((asgnScoreSum / asgnItemsSum) * 100) : null;

        const excellingTopics = topicResults.filter(t => t.status === 'Excelling');
        const laggingTopics = topicResults.filter(t => t.status === 'Lagging Behind');

        const chartData = {
            labels: topicResults.map(t => t.topic_name),
            scores: topicResults.map(t => t.percentage !== null ? t.percentage : 0),
            colors: topicResults.map(t => {
                if (t.status === 'Excelling') return '#10b981'; // Emerald
                if (t.status === 'Proficient') return '#06b6d4'; // Cyan
                if (t.status === 'Lagging Behind') return '#f43f5e'; // Rose
                return '#cbd5e1'; // Slate (Not Started)
            }),
            borderColors: topicResults.map(t => {
                if (t.status === 'Excelling') return '#059669';
                if (t.status === 'Proficient') return '#0891b2';
                if (t.status === 'Lagging Behind') return '#e11d48';
                return '#94a3b8';
            }),
            statuses: topicResults.map(t => t.status)
        };

        return res.json({
            success: true,
            student: {
                user_id: student.user_id,
                full_name: `${student.first_name} ${student.last_name}${student.suffix ? ' ' + student.suffix : ''}`,
                first_name: student.first_name,
                last_name: student.last_name,
                lrn_number: student.lrn_number || '—',
                grade_level: student.grade_level || 'Grade 11',
                section: student.section || '—',
                strand: student.strand || 'Academic Track',
                profile_pic: student.profile_pic || 'default_avatar.png',
                current_level: student.current_level || 1,
                total_exp: student.total_exp || 0,
                email: student.email,
                class_id: effClassId,
                class_name: student.class_name,
                subject_id: effSubjectId,
                subject_name: student.subject_name,
                subject_code: student.subject_code
            },
            summary: {
                overall_avg: overallAvg,
                curriculum_mastery: curriculumMastery,
                weighted_mastery: weightedCurriculumMastery,
                submitted_accuracy: submittedAccuracy,
                assessment_avg: asmtAvg,
                assessment_count: asmtCompletedCount,
                assignment_avg: asgnAvg,
                assignment_count: asgnCompletedCount,
                total_subject_exp: subjectTotalExp,
                completed_tasks: totalCompletedTasks,
                total_tasks: totalAssignedTasks,
                completion_rate: totalAssignedTasks > 0 ? Math.round((totalCompletedTasks / totalAssignedTasks) * 100) : 0,
                exp_breakdown: {
                    assessments_exp: asmtExpSum,
                    assignments_exp: asgnExpSum,
                    forums_exp: totalForumExp,
                    simulations_bonus_exp: totalSimulationBonusExp
                },
                forums_summary: {
                    completed_count: totalForumsCompleted,
                    total_count: totalAssignedForums,
                    completion_rate: forumCompletionRate,
                    total_forum_exp: totalForumExp
                },
                simulations_summary: {
                    total_submissions: simulationQuizzesList.length,
                    total_bonus_exp: totalSimulationBonusExp
                },
                distribution: {
                    mastery: masteryCount,
                    proficient: proficientCount,
                    approaching: approachingCount,
                    developing: developingCount,
                    unattempted: Math.max(0, totalAssignedTasks - totalCompletedTasks)
                },
                excelling_topics: excellingTopics.map(t => ({ topic_id: t.topic_id, name: t.topic_name, percentage: t.percentage })),
                lagging_topics: laggingTopics.map(t => ({ topic_id: t.topic_id, name: t.topic_name, percentage: t.percentage }))
            },
            topics: topicResults,
            simulation_quizzes: simulationQuizzesList,
            chartData
        });

    } catch (err) {
        console.error('[GET /teacher/api/student/:studentId/scores Error]:', err);
        return res.status(500).json({ success: false, error: 'Internal server error fetching student scores.' });
    }
}

// ── GET /teacher/api/student/:studentId/scores ─────────────────
// Returns granular, topic-categorized performance breakdown across assessments, assignments, EXP, & charts
router.get('/api/student/:studentId/scores', isTeacher, handleGetStudentDetailedScores);

// ── GET /teacher/student/:studentId/scores ─────────────────────
// Direct URL handler: responds with JSON when requested by API, or redirects cleanly to class-view modal trigger
router.get('/student/:studentId/scores', isTeacher, async (req, res) => {
    if (req.xhr || req.query.format === 'json' || req.headers?.accept?.includes('application/json')) {
        return handleGetStudentDetailedScores(req, res);
    }
    try {
        const studentId = parseInt(req.params.studentId, 10);
        const subjectId = parseInt(req.query.subject || req.query.subjectId, 10) || null;
        const teacherId = req.user.user_id;

        // Lookup the student's class taught by this teacher for this subject
        const [rows] = await db.execute(`
            SELECT cs.class_id
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            WHERE cs.student_id = ? AND (c.teacher_id = ? OR ? = 'Admin')
              AND (? IS NULL OR c.subject_id = ?)
            ORDER BY cs.class_id ASC
            LIMIT 1
        `, [studentId, teacherId, req.user.role, subjectId, subjectId]);

        if (rows.length && rows[0].class_id) {
            return res.redirect(`/teacher/class/${rows[0].class_id}?openScores=${studentId}`);
        }

        return res.redirect('/teacher/classes');
    } catch (err) {
        console.error('[GET /teacher/student/:studentId/scores redirect error]:', err);
        return res.redirect('/teacher/classes');
    }
});






// ============================================================
// QUESTION BANK ROUTES — add inside teacher.js
// All routes are already prefixed with /teacher
// ============================================================

// ── isTeacher middleware ──────────────────────────────────────────────────────
// FIX 3: Defined here so the standalone router file works without depending on
// teacher.js scope. If you already import this from a shared middleware file,
// replace with: const { isTeacher } = require('../middleware/auth');
function isTeacher(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.role === 'Teacher') {
        return next();
    }
    return res.status(403).json({ error: 'Access denied: Teachers only.' });
}

// FIX 4: Resolve uploads directory relative to this file's location, not a
// hardcoded absolute path. Adjust the relative segments to match your project
// structure (e.g. if this file is in routes/, go up one level to project root
// then into your uploads folder).
const UPLOADS_DIR = path.join(__dirname, '..', 'profile_pics');

// FIX 2: Use "gemini-1.5-flash-latest" — this model string works across both
// v1beta and v1 API endpoints regardless of which library version is installed.
// "gemini-1.5-flash" (without -latest) returns 404 on older library versions.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// ── HELPER: Sync answer_sequences for Periodic_Sequence questions ─────────────
async function syncAnswerSequences(db, questionId, sequences) {
    await db.execute(
        `DELETE FROM answer_sequences WHERE question_id = ?`,
        [questionId]
    );
    if (!sequences || !sequences.length) return;

    for (const seq of sequences) {
        if (!seq.element_symbol) continue;
        await db.execute(
            `INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order)
             VALUES (?, ?, ?, ?)`,
            [
                questionId,
                String(seq.element_symbol).slice(0, 10),
                parseInt(seq.subscript) || 1,
                parseInt(seq.sort_order) || 1
            ]
        );
    }
}

// ── HELPER: Extract readable text from a learning material file ───────────────
// FIX 1 + 4 + 8: Removed hardcoded path. Uses UPLOADS_DIR. Skips non-file
// material types (video, link, presentation) gracefully instead of crashing.
async function getMaterialContext(material) {
    const { material_type, file_path_or_url, title } = material;

    // URL-based or non-parseable types — just return the title as context
    const urlTypes = ['video', 'link', 'presentation'];
    if (urlTypes.includes(material_type)) {
        return `\nSource material title: "${title}" (${material_type})`;
    }

    // For file-based types: pdf, word, img
    const filePath = path.join(UPLOADS_DIR, file_path_or_url);

    if (!fs.existsSync(filePath)) {
        console.warn(`[WARN] Material file not found: ${filePath}`);
        return `\nSource material title: "${title}"`;
    }

    try {
        const dataBuffer = fs.readFileSync(filePath);

        if (material_type === 'pdf') {
            // FIX 1: pdf-parse is imported and called correctly.
            // The previous crash was caused by the bad file path (ENOENT)
            // reaching pdfParse. Now the path is resolved correctly.
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(dataBuffer);
            return `\nSource material content: "${data.text.substring(0, 3500)}"`;
        }

        if (material_type === 'word') {
            // Word docs are binary — extract raw text best-effort
            const text = dataBuffer.toString('utf8', 0, 3000).replace(/[^\x20-\x7E\n]/g, ' ');
            return `\nSource material content: "${text}"`;
        }

        if (material_type === 'img') {
            // Images can't be read as text — use title as context
            return `\nSource material title: "${title}" (image)`;
        }

        // Generic fallback for any other file type
        return `\nSource material content: "${dataBuffer.toString().substring(0, 3000)}"`;

    } catch (err) {
        console.error(`[WARN] Could not read material file "${filePath}":`, err.message);
        return `\nSource material title: "${title}"`;
    }
}


// ════════════════════════════════════════════════════════════════════════════
// ELEMENTA ARCADE LEVEL MACHINES & TOPIC MAPPING (Imported from helper)
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/question-bank — ELEMENTA QUESTION BANK
// ════════════════════════════════════════════════════════════════════════════
router.get('/question_bank', isTeacher, (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect('/teacher/question-bank' + qs);
});

router.get('/question-bank', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;

        const [questions] = await db.execute(`
            SELECT
                eq.question_id,
                eq.question_code,
                eq.level_number,
                eq.topic_id,
                eq.topic,
                eq.machine_name,
                eq.machine_id,
                eq.prompt,
                eq.prompt AS question_text,
                eq.answer_text,
                eq.steps_json,
                eq.time_limit_s,
                eq.points,
                eq.difficulty,
                eq.is_active,
                eq.teacher_id,
                eq.verification_status,
                eq.rejection_reason,
                eq.verified_at,
                CONCAT(vu.first_name, ' ', vu.last_name) AS verified_by_name,
                CONCAT(tu.first_name, ' ', tu.last_name) AS teacher_name,
                t.topic_name
            FROM elementa_questions eq
            LEFT JOIN topics t ON eq.topic_id = t.topic_id
            LEFT JOIN users vu ON eq.verified_by = vu.user_id
            LEFT JOIN users tu ON eq.teacher_id = tu.user_id
            WHERE eq.is_active = 1 AND (? IS NULL OR eq.sy_id = ?)
            ORDER BY eq.level_number ASC, eq.display_order ASC, eq.question_id DESC`,
            [currentSyId, currentSyId]
        );

        // Quarters + topics (nested, for dropdowns) - scoped to active classes
        const [quartersRaw] = await db.execute(`
            SELECT qt.quarter_id, qt.quarter_number, qt.subject_id,
                   t.topic_id,   t.topic_name
            FROM quarters qt
            JOIN classes c ON qt.subject_id = c.subject_id
            LEFT JOIN topics t ON t.quarter_id = qt.quarter_id
            WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
            ORDER BY qt.quarter_number ASC, t.topic_id ASC`,
            [teacherId, currentSyId, currentSyId]
        );

        const quartersMap = {};
        quartersRaw.forEach(row => {
            if (!quartersMap[row.quarter_id]) {
                quartersMap[row.quarter_id] = {
                    quarter_id: row.quarter_id,
                    quarter_number: row.quarter_number,
                    subject_id: row.subject_id,
                    topics: []
                };
            }
            if (row.topic_id) {
                const already = quartersMap[row.quarter_id].topics.find(t => t.topic_id === row.topic_id);
                if (!already) {
                    quartersMap[row.quarter_id].topics.push({
                        topic_id: row.topic_id,
                        topic_name: row.topic_name
                    });
                }
            }
        });
        const quarters = Object.values(quartersMap);

        const [assessments] = await db.execute(`
            SELECT a.assessment_id, a.assessment_name, a.assessment_type
            FROM assessments a
            WHERE a.teacher_id = ?
            ORDER BY a.assessment_name ASC`,
            [teacherId]
        );

        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_name
            FROM classes c
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            WHERE c.teacher_id = ?
            ORDER BY c.class_name ASC`,
            [teacherId]
        );

        const [materials] = await db.execute(`
            SELECT DISTINCT
                lm.material_id, 
                lm.topic_id, 
                lm.title, 
                lm.material_type, 
                lm.file_path_or_url, 
                lm.created_at,
                COALESCE(t.topic_name, 'General Chemistry') AS topic_name,
                COALESCE(q.quarter_number, 1) AS quarter_number
            FROM learning_materials lm
            LEFT JOIN topics t ON lm.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON q.subject_id = c.subject_id
            WHERE c.teacher_id = ? OR c.teacher_id IS NULL OR ? = 'Admin'
            ORDER BY topic_name ASC, lm.title ASC`,
            [teacherId, req.user.role]
        );

        const totalQuestions = questions.length;
        const approvedCount = questions.filter(q => q.verification_status === 'Approved').length;
        const pendingCount = questions.filter(q => q.verification_status === 'Pending').length;
        const rejectedCount = questions.filter(q => q.verification_status === 'Rejected').length;
        const topicCount = new Set(questions.map(q => q.level_number)).size;
        const machineCount = new Set(questions.map(q => q.machine_name)).size;

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/question_bank', {
            questions,
            quarters,
            assessments,
            classes,
            materials,
            totalQuestions,
            approvedCount,
            pendingCount,
            rejectedCount,
            topicCount,
            machineCount,
            LEVEL_MACHINES,
            LEVEL_TOPIC_MAP,
            user: req.user,
            currentPage: 'question-bank',
            notifications
        });

    } catch (err) {
        console.error('[ERROR] GET /teacher/question-bank:', err);
        res.status(500).send('Internal Server Error');
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/question — CREATE ELEMENTA QUESTION (Admin Approval Required)
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/question', isTeacher, async (req, res) => {
    try {
        const {
            topic_id, level_number, question_code, prompt, question_text,
            answer_text, machine_name, machine_id, time_limit_s, points,
            difficulty, steps_json
        } = req.body;

        const actualPrompt = prompt || question_text;
        if (!actualPrompt) throw new Error('Customer order prompt is required');
        if (!answer_text) throw new Error('Target answer / solution is required');

        const actualLevel = parseInt(level_number, 10) || (topic_id ? TOPIC_LEVEL_MAP[topic_id] : 1) || 1;
        const machineInfo = LEVEL_MACHINES[actualLevel] || { name: machine_name || 'Chemistry Station', id: actualLevel, topic: 'Chemistry' };
        const actualMachineName = machine_name || machineInfo.name;
        const actualMachineId = parseInt(machine_id, 10) || machineInfo.id;
        const actualTopic = machineInfo.topic;
        const actualTopicId = topic_id ? parseInt(topic_id, 10) : (LEVEL_TOPIC_MAP[actualLevel] || null);

        // Auto-generate question code if missing
        const qCode = question_code && question_code.trim() !== ''
            ? question_code.trim()
            : `Q${actualLevel}${String(Date.now()).slice(-3)}`;

        // Process steps_json
        let finalStepsJson = '[]';
        if (typeof steps_json === 'string') {
            try {
                JSON.parse(steps_json);
                finalStepsJson = steps_json;
            } catch (err) {
                finalStepsJson = JSON.stringify([{ type: 'text', answer: answer_text }]);
            }
        } else if (Array.isArray(steps_json)) {
            finalStepsJson = JSON.stringify(steps_json);
        } else {
            finalStepsJson = JSON.stringify([{ type: 'pick_seq', answer: answer_text.split('+'), label: 'Reagent steps' }]);
        }

        const [[maxOrderRow]] = await db.query(
            `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM elementa_questions WHERE level_number = ?`,
            [actualLevel]
        );
        const nextDisplayOrder = Number(maxOrderRow?.next_order) || 1;

        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;

        const [result] = await db.execute(`
            INSERT INTO elementa_questions
                (teacher_id, sy_id, question_code, level_number, topic_id, topic,
                 machine_name, machine_id, prompt, answer_text, steps_json,
                 time_limit_s, points, difficulty, display_order, verification_status, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1)`,
            [
                req.user.user_id,
                currentSyId,
                qCode,
                actualLevel,
                actualTopicId,
                actualTopic,
                actualMachineName,
                actualMachineId,
                actualPrompt,
                answer_text,
                finalStepsJson,
                parseFloat(time_limit_s) || 90.0,
                parseInt(points, 10) || 1,
                difficulty || 'Easy',
                nextDisplayOrder
            ]
        );

        const newQid = result.insertId;

        // Notify Admins about new arcade question pending verification
        try {
            const [adminRows] = await db.query("SELECT user_id FROM users WHERE role = 'Admin'");
            if (adminRows.length > 0) {
                const adminIds = adminRows.map(a => a.user_id);
                await notificationService.dispatch({
                    recipientIds: adminIds,
                    actorId: req.user.user_id,
                    role: 'Admin',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'question_pending_review',
                    title: 'Arcade Question Submitted for Review',
                    message: `${req.user.first_name} ${req.user.last_name} submitted a new Elementa arcade question (${qCode}) for verification.`,
                    targetUrl: '/admin/gaming_question_bank',
                    metadata: { questionId: newQid }
                });
            }
        } catch (notifErr) {
            console.error('[Arcade Question Pending Notification Error]', notifErr.message);
        }

        res.json({ success: true, question_id: newQid, message: 'Question submitted! Awaiting administrator approval.' });
    } catch (e) {
        console.error('[ERROR] POST /api/question:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/question/:qid — UPDATE (Resets to Pending for Admin Approval)
// ════════════════════════════════════════════════════════════════════════════
router.put('/api/question/:qid', isTeacher, async (req, res) => {
    try {
        const qid = req.params.qid;
        const {
            topic_id, level_number, question_code, prompt, question_text,
            answer_text, machine_name, machine_id, time_limit_s, points,
            difficulty, steps_json
        } = req.body;

        const actualPrompt = prompt || question_text;
        if (!actualPrompt) throw new Error('Prompt is required');
        if (!answer_text) throw new Error('Answer is required');

        const actualLevel = parseInt(level_number, 10) || (topic_id ? TOPIC_LEVEL_MAP[topic_id] : 1) || 1;
        const machineInfo = LEVEL_MACHINES[actualLevel] || { name: machine_name || 'Chemistry Station', id: actualLevel, topic: 'Chemistry' };
        const actualMachineName = machine_name || machineInfo.name;
        const actualMachineId = parseInt(machine_id, 10) || machineInfo.id;
        const actualTopic = machineInfo.topic;
        const actualTopicId = topic_id ? parseInt(topic_id, 10) : (LEVEL_TOPIC_MAP[actualLevel] || null);

        let finalStepsJson = null;
        if (steps_json) {
            finalStepsJson = typeof steps_json === 'string' ? steps_json : JSON.stringify(steps_json);
        }

        await db.execute(`
            UPDATE elementa_questions
            SET level_number        = ?,
                topic_id            = ?,
                topic               = ?,
                machine_name        = ?,
                machine_id          = ?,
                prompt              = ?,
                answer_text         = ?,
                steps_json          = COALESCE(?, steps_json),
                time_limit_s        = ?,
                points              = ?,
                difficulty          = ?,
                verification_status = 'Pending',
                rejection_reason    = NULL
            WHERE question_id = ? AND (teacher_id = ? OR ? = 'Admin')`,
            [
                actualLevel,
                actualTopicId,
                actualTopic,
                actualMachineName,
                actualMachineId,
                actualPrompt,
                answer_text,
                finalStepsJson,
                parseFloat(time_limit_s) || 90.0,
                parseInt(points, 10) || 1,
                difficulty || 'Easy',
                qid,
                req.user.user_id,
                req.user.role
            ]
        );

        res.json({ success: true, message: 'Question updated and resubmitted for admin review.' });
    } catch (e) {
        console.error('[ERROR] PUT /api/question:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// DELETE /teacher/api/question/:qid — SINGLE DELETE
// ════════════════════════════════════════════════════════════════════════════
router.delete('/api/question/:qid', isTeacher, async (req, res) => {
    try {
        const qid = req.params.qid;
        await db.execute(
            `UPDATE elementa_questions SET is_active = 0 WHERE question_id = ? AND (teacher_id = ? OR ? = 'Admin')`,
            [qid, req.user.user_id, req.user.role]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('[ERROR] DELETE /api/question:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/questions/bulk-delete
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/questions/bulk-delete', isTeacher, async (req, res) => {
    try {
        const ids = req.body.ids;
        if (!ids || !ids.length) throw new Error('No ids provided');

        const placeholders = ids.map(() => '?').join(',');
        await db.execute(
            `UPDATE elementa_questions SET is_active = 0 WHERE question_id IN (${placeholders}) AND (teacher_id = ? OR ? = 'Admin')`,
            [...ids, req.user.user_id, req.user.role]
        );
        res.json({ success: true, deleted: ids.length });
    } catch (e) {
        console.error('[ERROR] POST /api/questions/bulk-delete:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/question/:qid/link-assessment
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/question/:qid/link-assessment', isTeacher, async (req, res) => {
    try {
        const { assessment_id } = req.body;
        if (!assessment_id) throw new Error('assessment_id is required');

        const [asmtRows] = await db.execute(
            `SELECT topic_id FROM assessments WHERE assessment_id = ? AND teacher_id = ?`,
            [assessment_id, req.user.user_id]
        );
        if (!asmtRows.length) {
            return res.status(404).json({ error: 'Assessment not found or not yours' });
        }

        const topicId = asmtRows[0].topic_id;
        const levelNum = TOPIC_LEVEL_MAP[topicId] || 1;

        await db.execute(
            `UPDATE elementa_questions SET topic_id = ?, level_number = ? WHERE question_id = ? AND (teacher_id = ? OR ? = 'Admin')`,
            [topicId, levelNum, req.params.qid, req.user.user_id, req.user.role]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('[ERROR] POST /api/question/link-assessment:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/question/:qid/cancel-submission
// Resets verification_status from 'Pending' back to 'Rejected' (Cancelled by teacher)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/api/question/:qid/cancel-submission', isTeacher, async (req, res) => {
    try {
        await db.execute(
            `UPDATE elementa_questions SET verification_status = 'Rejected', rejection_reason = 'Cancelled by teacher.'
             WHERE question_id = ? AND (teacher_id = ? OR ? = 'Admin')`,
            [req.params.qid, req.user.user_id, req.user.role]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/question/:qid/revise
// Teacher submits a corrected version of a rejected question -> sets status back to Pending
// ════════════════════════════════════════════════════════════════════════════
router.put('/api/question/:qid/revise', isTeacher, async (req, res) => {
    try {
        const qid = req.params.qid;
        const {
            topic_id, level_number, prompt, question_text,
            answer_text, machine_name, machine_id, time_limit_s, points,
            difficulty, steps_json
        } = req.body;

        const actualPrompt = prompt || question_text;
        if (!actualPrompt) throw new Error('Prompt is required');
        if (!answer_text) throw new Error('Answer is required');

        const actualLevel = parseInt(level_number, 10) || (topic_id ? TOPIC_LEVEL_MAP[topic_id] : 1) || 1;
        const machineInfo = LEVEL_MACHINES[actualLevel] || { name: machine_name || 'Chemistry Station', id: actualLevel, topic: 'Chemistry' };
        const actualMachineName = machine_name || machineInfo.name;
        const actualMachineId = parseInt(machine_id, 10) || machineInfo.id;
        const actualTopic = machineInfo.topic;
        const actualTopicId = topic_id ? parseInt(topic_id, 10) : (LEVEL_TOPIC_MAP[actualLevel] || null);

        let finalStepsJson = null;
        if (steps_json) {
            finalStepsJson = typeof steps_json === 'string' ? steps_json : JSON.stringify(steps_json);
        }

        await db.execute(`
            UPDATE elementa_questions
            SET level_number        = ?,
                topic_id            = ?,
                topic               = ?,
                machine_name        = ?,
                machine_id          = ?,
                prompt              = ?,
                answer_text         = ?,
                steps_json          = COALESCE(?, steps_json),
                time_limit_s        = ?,
                points              = ?,
                difficulty          = ?,
                verification_status = 'Pending',
                rejection_reason    = NULL,
                verified_by         = NULL,
                verified_at         = NULL
            WHERE question_id = ? AND (teacher_id = ? OR ? = 'Admin')`,
            [
                actualLevel,
                actualTopicId,
                actualTopic,
                actualMachineName,
                actualMachineId,
                actualPrompt,
                answer_text,
                finalStepsJson,
                parseFloat(time_limit_s) || 90.0,
                parseInt(points, 10) || 1,
                difficulty || 'Easy',
                qid,
                req.user.user_id,
                req.user.role
            ]
        );

        // Notify admins about the revision
        try {
            const [adminRows] = await db.execute(`SELECT user_id FROM users WHERE role = 'Admin'`);
            if (adminRows.length > 0) {
                const adminIds = adminRows.map(a => a.user_id);
                await notificationService.dispatch({
                    recipientIds: adminIds,
                    actorId: req.user.user_id,
                    role: 'Admin',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'question_pending_review',
                    title: 'Revised Arcade Question Submitted',
                    message: `${req.user.first_name} ${req.user.last_name} submitted a revised Elementa question for review.`,
                    targetUrl: '/admin/gaming_question_bank',
                    metadata: { questionId: qid }
                });
            }
        } catch (notifErr) {
            console.error('[Revised Question Notification Error]', notifErr.message);
        }

        res.json({ success: true, message: 'Question revised and resubmitted for admin review.' });
    } catch (e) {
        console.error('[ERROR] PUT /api/question/revise:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /teacher/api/questions/performance-gaps
// Returns questions ranked by error rate in Elementa Arcade gameplay
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/questions/performance-gaps', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const [rows] = await db.execute(`
            SELECT
                eq.question_id,
                eq.prompt                                                                 AS question_text,
                eq.difficulty,
                eq.machine_name                                                           AS mechanic_type,
                COALESCE(t.topic_name, eq.topic)                                          AS topic_name,
                COUNT(DISTINCT eqh.history_id)                                            AS total_attempts,
                COUNT(DISTINCT CASE WHEN eqh.is_correct = 0 THEN eqh.history_id END)      AS wrong_count,
                COALESCE(
                    COUNT(DISTINCT CASE WHEN eqh.is_correct = 0 THEN eqh.history_id END)
                    / NULLIF(COUNT(DISTINCT eqh.history_id), 0)
                , 0)                                                                       AS error_rate
            FROM elementa_questions eq
            LEFT JOIN topics t                 ON eq.topic_id        = t.topic_id
            LEFT JOIN elementa_question_history eqh ON eqh.question_id = eq.question_id
            WHERE (eq.teacher_id = ? OR eq.teacher_id IS NULL)
              AND eq.verification_status = 'Approved'
              AND eq.is_active = 1
            GROUP BY eq.question_id, eq.prompt, eq.difficulty, eq.machine_name, t.topic_name, eq.topic
            HAVING total_attempts > 0
            ORDER BY error_rate DESC, total_attempts DESC`,
            [teacherId]
        );
        res.json({ questions: rows });
    } catch (e) {
        console.error('[ERROR] GET /api/questions/performance-gaps:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/telemetry/class/:classId
// Aggregated class-level question mastery (Struggling & Mastered lists)
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/telemetry/class/:classId', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const classId = parseInt(req.params.classId, 10);
        if (!classId) return res.status(400).json({ error: 'Invalid class ID' });

        const [cls] = await db.query(
            `SELECT c.class_id, c.class_name, s.subject_name 
             FROM classes c 
             LEFT JOIN subjects s ON c.subject_id = s.subject_id 
             WHERE c.class_id = ? AND (c.teacher_id = ? OR ? = 'Admin')`,
            [classId, teacherId, req.user.role]
        );
        if (!cls.length) return res.status(403).json({ error: 'Access denied to this class.' });

        const [rows] = await db.query(`
            SELECT 
                COALESCE(eq.question_id, ca.question_id) AS question_id,
                COALESCE(eq.question_code, CONCAT('Q', ca.question_id)) AS question_code,
                COALESCE(eq.prompt, ca.question_snapshot) AS question_prompt,
                COALESCE(eq.answer_text, ca.correct_answer) AS correct_answer,
                COALESCE(eq.machine_name, ca.machine_used, 'Arcade Station') AS machine_name,
                COALESCE(eq.level_number, ca.level_number, r.level_number, 1) AS level_number,
                COUNT(DISTINCT ca.attempt_id) AS total_attempts,
                COUNT(DISTINCT CASE WHEN ca.is_correct = 0 THEN ca.attempt_id END) AS wrong_count,
                COUNT(DISTINCT CASE WHEN ca.is_correct = 1 THEN ca.attempt_id END) AS correct_count,
                COUNT(DISTINCT CASE WHEN ca.is_correct = 0 THEN 
                    CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END 
                END) AS students_failed_count,
                COUNT(DISTINCT CASE WHEN ca.is_correct = 1 THEN 
                    CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END 
                END) AS students_passed_count,
                ROUND((COUNT(DISTINCT CASE WHEN ca.is_correct = 0 THEN ca.attempt_id END) / NULLIF(COUNT(DISTINCT ca.attempt_id), 0)) * 100, 1) AS error_rate_pct,
                ROUND((COUNT(DISTINCT CASE WHEN ca.is_correct = 1 THEN ca.attempt_id END) / NULLIF(COUNT(DISTINCT ca.attempt_id), 0)) * 100, 1) AS accuracy_pct,
                MAX(eqr.material_id) AS assigned_material_id,
                MAX(lm.title) AS assigned_material_title,
                MAX(lm.material_type) AS assigned_material_type,
                MAX(eqr.advice_text) AS assigned_advice_text
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs r ON r.run_id = ca.run_id
            JOIN elementa_game_sessions s ON s.session_id = r.session_id
            JOIN class_students cs ON cs.student_id = (CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END)
            LEFT JOIN elementa_questions eq ON (eq.question_id = ca.question_id OR (ca.question_snapshot IS NOT NULL AND eq.prompt = ca.question_snapshot))
            LEFT JOIN elementa_question_remediation eqr ON eqr.question_id = COALESCE(eq.question_id, ca.question_id) AND (eqr.class_id = cs.class_id OR eqr.class_id IS NULL)
            LEFT JOIN learning_materials lm ON lm.material_id = eqr.material_id
            WHERE cs.class_id = ?
            GROUP BY COALESCE(eq.question_id, ca.question_id), question_code, question_prompt, correct_answer, machine_name, level_number
            HAVING total_attempts > 0
        `, [classId]);

        const struggling = [...rows].filter(q => q.wrong_count > 0).sort((a, b) => b.wrong_count - a.wrong_count || b.error_rate_pct - a.error_rate_pct);
        const mastered = [...rows].filter(q => q.correct_count > 0).sort((a, b) => b.accuracy_pct - a.accuracy_pct || b.total_attempts - a.total_attempts);

        const [[stats]] = await db.query(`
            SELECT 
                COUNT(DISTINCT cs.student_id) AS total_enrolled,
                COUNT(DISTINCT CASE WHEN ca.attempt_id IS NOT NULL THEN cs.student_id END) AS active_students,
                COUNT(ca.attempt_id) AS total_attempts,
                SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) AS total_correct,
                ROUND((SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(ca.attempt_id), 0)) * 100, 1) AS class_accuracy
            FROM class_students cs
            LEFT JOIN elementa_game_sessions s ON (s.student_id_p1 = cs.student_id OR s.student_id_p2 = cs.student_id)
            LEFT JOIN elementa_level_runs r ON r.session_id = s.session_id AND (
                (r.player_number = 1 AND s.student_id_p1 = cs.student_id) OR
                (r.player_number = 2 AND s.student_id_p2 = cs.student_id)
            )
            LEFT JOIN elementa_customer_attempts ca ON ca.run_id = r.run_id
            WHERE cs.class_id = ?
        `, [classId]);

        res.json({
            success: true,
            class_info: cls[0],
            stats: stats || {},
            struggling,
            mastered
        });
    } catch (err) {
        console.error('[ERROR] GET /api/telemetry/class/:classId:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/telemetry/class/:classId/students
// Student roster for class with individual scores & accuracy
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/telemetry/class/:classId/students', isTeacher, async (req, res) => {
    try {
        const classId = parseInt(req.params.classId, 10);
        if (!classId) return res.status(400).json({ error: 'Invalid class ID' });

        const [students] = await db.query(`
            SELECT 
                u.user_id,
                u.first_name,
                u.last_name,
                u.lrn_number,
                u.profile_pic,
                COUNT(DISTINCT ca.attempt_id) AS total_attempts,
                SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                SUM(CASE WHEN ca.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
                COALESCE(SUM(ca.points_awarded), 0) AS total_score,
                ROUND((SUM(CASE WHEN ca.is_correct = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(ca.attempt_id), 0)) * 100, 1) AS accuracy_pct,
                MAX(ca.attempted_at) AS last_played
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            LEFT JOIN elementa_game_sessions s ON (s.student_id_p1 = u.user_id OR s.student_id_p2 = u.user_id)
            LEFT JOIN elementa_level_runs r ON r.session_id = s.session_id AND (
                (r.player_number = 1 AND s.student_id_p1 = u.user_id) OR
                (r.player_number = 2 AND s.student_id_p2 = u.user_id)
            )
            LEFT JOIN elementa_customer_attempts ca ON ca.run_id = r.run_id
            WHERE cs.class_id = ?
            GROUP BY u.user_id, u.first_name, u.last_name, u.lrn_number, u.profile_pic
            ORDER BY total_score DESC, accuracy_pct DESC
        `, [classId]);

        res.json({ success: true, students });
    } catch (err) {
        console.error('[ERROR] GET /api/telemetry/class/:classId/students:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/telemetry/student/:studentId
// Deep dive student diagnostic with Bloom's Radar and individual question attempts
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/telemetry/student/:studentId', isTeacher, async (req, res) => {
    try {
        const studentId = parseInt(req.params.studentId, 10);
        if (!studentId) return res.status(400).json({ error: 'Invalid student ID' });

        const [[student]] = await db.query(
            `SELECT user_id, first_name, last_name, lrn_number, profile_pic FROM users WHERE user_id = ?`,
            [studentId]
        );
        if (!student) return res.status(404).json({ error: 'Student not found' });

        const radar = await arcadeAnalyticsService.getStudentRadar(studentId);

        const [attempts] = await db.query(`
            SELECT 
                ca.attempt_id,
                COALESCE(eq.question_code, CONCAT('Q', ca.question_id)) AS question_code,
                COALESCE(eq.prompt, ca.question_snapshot) AS question_prompt,
                ca.machine_used,
                COALESCE(ca.level_number, r.level_number) AS level_number,
                ca.player_answer,
                ca.correct_answer,
                ca.is_correct,
                ca.is_timeout,
                ca.failure_type,
                ca.points_awarded,
                ca.response_time_s,
                ca.attempted_at
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs r ON r.run_id = ca.run_id
            JOIN elementa_game_sessions s ON s.session_id = r.session_id
            LEFT JOIN elementa_questions eq ON (eq.question_id = ca.question_id OR (ca.question_snapshot IS NOT NULL AND eq.prompt = ca.question_snapshot))
            WHERE (s.student_id_p1 = ? OR s.student_id_p2 = ?)
            ORDER BY ca.attempted_at DESC
            LIMIT 50
        `, [studentId, studentId]);

        res.json({
            success: true,
            student,
            radar: radar || { remembering: 0, understanding: 0, applying: 0, analyzing: 0, precision: 0 },
            attempts
        });
    } catch (err) {
        console.error('[ERROR] GET /api/telemetry/student/:studentId:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/telemetry/question/:questionId/struggling-students
// Fetches struggling students for this question in classId, current remediation, and available materials
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/telemetry/question/:questionId/struggling-students', isTeacher, async (req, res) => {
    try {
        const questionId = parseInt(req.params.questionId, 10);
        const classId = parseInt(req.query.classId, 10);
        if (!questionId || isNaN(questionId) || !classId || isNaN(classId)) {
            return res.status(400).json({ error: 'Valid questionId and classId parameters are required.' });
        }

        // 1. Fetch Question Info
        const [[question]] = await db.query(`
            SELECT 
                eq.question_id,
                eq.question_code,
                eq.prompt,
                eq.level_number,
                eq.machine_name,
                t.topic_name,
                eq.topic_id
            FROM elementa_questions eq
            LEFT JOIN topics t ON eq.topic_id = t.topic_id
            WHERE eq.question_id = ?
        `, [questionId]);

        // 2. Fetch Struggling Students in this Class who got this question wrong
        const [students] = await db.query(`
            SELECT DISTINCT 
                u.user_id,
                u.first_name,
                u.last_name,
                u.lrn_number,
                u.profile_pic,
                COUNT(ca.attempt_id) AS wrong_count,
                MAX(ca.attempted_at) AS last_failed_at,
                MAX(ca.player_answer) AS last_answer
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs r ON r.run_id = ca.run_id
            JOIN elementa_game_sessions s ON s.session_id = r.session_id
            JOIN class_students cs ON cs.student_id = (CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END)
            JOIN users u ON u.user_id = cs.student_id
            WHERE cs.class_id = ? 
              AND (ca.question_id = ? OR ca.question_snapshot = ?)
              AND ca.is_correct = 0
            GROUP BY u.user_id, u.first_name, u.last_name, u.lrn_number, u.profile_pic
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [classId, questionId, question ? question.prompt : '']);

        // 3. Fetch currently assigned remediation material (if any)
        const [[currentRemediation]] = await db.query(`
            SELECT 
                eqr.id,
                eqr.material_id,
                eqr.advice_text,
                eqr.assigned_at,
                lm.title AS material_title,
                lm.material_type,
                lm.file_path_or_url,
                t.topic_name
            FROM elementa_question_remediation eqr
            JOIN learning_materials lm ON eqr.material_id = lm.material_id
            LEFT JOIN topics t ON lm.topic_id = t.topic_id
            WHERE eqr.question_id = ? AND (eqr.class_id = ? OR eqr.class_id IS NULL)
            ORDER BY eqr.assigned_at DESC
            LIMIT 1
        `, [questionId, classId]);

        // 4. Fetch available uploaded learning materials
        const [materials] = await db.query(`
            SELECT DISTINCT
                lm.material_id, 
                lm.topic_id, 
                lm.title, 
                lm.material_type, 
                lm.file_path_or_url, 
                lm.created_at,
                COALESCE(t.topic_name, 'General Chemistry') AS topic_name
            FROM learning_materials lm
            LEFT JOIN topics t ON lm.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON q.subject_id = c.subject_id
            WHERE c.teacher_id = ? OR c.teacher_id IS NULL OR ? = 'Admin'
            ORDER BY topic_name ASC, lm.title ASC
        `, [req.user.user_id, req.user.role]);

        res.json({
            success: true,
            question: question || { question_id: questionId, question_code: `Q${questionId}` },
            students,
            current_remediation: currentRemediation || null,
            materials
        });
    } catch (err) {
        console.error('[ERROR] GET /api/telemetry/question/:questionId/struggling-students:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/telemetry/assign-remediation
// Assigns an uploaded learning material to students who missed a question
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/telemetry/assign-remediation', isTeacher, async (req, res) => {
    try {
        const { class_id, question_id, material_id, advice_text } = req.body;
        const classId = parseInt(class_id, 10);
        const questionId = parseInt(question_id, 10);
        const materialId = parseInt(material_id, 10);

        if (!classId || !questionId || !materialId) {
            return res.status(400).json({ error: 'Class, question, and learning material are required.' });
        }

        // Verify class ownership
        const [cls] = await db.query(`
            SELECT class_id, class_name FROM classes WHERE class_id = ? AND (teacher_id = ? OR ? = 'Admin')
        `, [classId, req.user.user_id, req.user.role]);
        if (!cls.length) return res.status(403).json({ error: 'Access denied to this class.' });

        // Verify material
        const [[mat]] = await db.query(`
            SELECT lm.material_id, lm.title, lm.material_type, lm.file_path_or_url, lm.topic_id, t.topic_name
            FROM learning_materials lm
            LEFT JOIN topics t ON lm.topic_id = t.topic_id
            WHERE lm.material_id = ?
        `, [materialId]);
        if (!mat) return res.status(404).json({ error: 'Learning material not found.' });

        // Fetch question info
        const [[qRow]] = await db.query(`
            SELECT question_code, prompt, machine_name FROM elementa_questions WHERE question_id = ?
        `, [questionId]);
        const qCode = qRow ? qRow.question_code : `Q${questionId}`;

        // Save / Update in elementa_question_remediation
        await db.query(`
            DELETE FROM elementa_question_remediation WHERE class_id = ? AND question_id = ?
        `, [classId, questionId]);

        await db.query(`
            INSERT INTO elementa_question_remediation (class_id, question_id, material_id, advice_text, assigned_by)
            VALUES (?, ?, ?, ?, ?)
        `, [classId, questionId, materialId, advice_text || null, req.user.user_id]);

        // Find students who got this question wrong in this class
        const [strugglingStudents] = await db.query(`
            SELECT DISTINCT (CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END) AS student_id
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs r ON r.run_id = ca.run_id
            JOIN elementa_game_sessions s ON s.session_id = r.session_id
            JOIN class_students cs ON cs.student_id = (CASE WHEN r.player_number = 1 THEN s.student_id_p1 ELSE s.student_id_p2 END)
            WHERE cs.class_id = ? 
              AND (ca.question_id = ? OR ca.question_snapshot = ?)
              AND ca.is_correct = 0
        `, [classId, questionId, qRow ? qRow.prompt : '']);

        const studentIds = strugglingStudents.map(s => s.student_id);

        if (studentIds.length > 0) {
            const noteText = advice_text && advice_text.trim()
                ? advice_text.trim()
                : `Your teacher assigned the document "${mat.title}" for you to review because you missed question ${qCode} during arcade gameplay.`;

            const cleanMatUrl = mat.file_path_or_url
                ? (mat.file_path_or_url.startsWith('http')
                    ? mat.file_path_or_url
                    : `/material_uploads/${mat.file_path_or_url.replace(/^(\/?(material_uploads|uploads\/materials)\/)+/, '')}`)
                : '/subjects';

            await notificationService.dispatch({
                recipientIds: studentIds,
                actorId: req.user.user_id,
                role: 'Student',
                category: 'academic',
                priority: 'high',
                eventType: 'arcade_remediation_assigned',
                title: `🎯 Required Review: ${mat.title}`,
                message: noteText,
                targetUrl: cleanMatUrl,
                metadata: {
                    questionId,
                    materialId,
                    classId
                }
            });
        }

        res.json({
            success: true,
            student_count: studentIds.length,
            material_title: mat.title,
            class_name: cls[0].class_name
        });
    } catch (err) {
        console.error('[ERROR] POST /api/telemetry/assign-remediation:', err);
        res.status(500).json({ error: err.message });
    }
});

// Per-question student breakdown from Elementa Arcade gameplay
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/question/:qid/student-performance', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const qid = req.params.qid;
    try {
        const [ownership] = await db.execute(
            `SELECT question_id FROM elementa_questions WHERE question_id = ? AND (teacher_id = ? OR teacher_id IS NULL OR ? = 'Admin')`,
            [qid, teacherId, req.user.role]
        );
        if (!ownership.length) return res.status(403).json({ error: 'Access denied.' });

        const [rows] = await db.execute(`
            SELECT
                c.class_id,
                c.class_name,
                u.user_id,
                u.first_name,
                u.last_name,
                u.lrn_number,
                COALESCE(a.assessment_name, 'Elementa Arcade') AS assessment_name,
                'Arcade' AS assessment_type,
                eqh.is_correct,
                eq.answer_text AS correct_answer,
                eqh.answered_at AS date_recorded
            FROM elementa_question_history eqh
            JOIN elementa_game_sessions egs ON eqh.session_id = egs.session_id
            JOIN users u ON egs.user_id = u.user_id
            JOIN class_students cs ON cs.student_id = u.user_id
            JOIN classes c ON cs.class_id = c.class_id AND c.teacher_id = ?
            JOIN elementa_questions eq ON eqh.question_id = eq.question_id
            LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
            WHERE eqh.question_id = ?
              AND u.role = 'Student'
            ORDER BY eqh.answered_at DESC`,
            [teacherId, qid]
        );

        res.json({ students: rows });
    } catch (e) {
        console.error('[ERROR] GET /api/question/:qid/student-performance:', e.message);
        res.status(500).json({ error: e.message });
    }
});


router.get('/api/question/:qid/remediations', isTeacher, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                rm.rem_id,
                rm.advice_text,
                rm.link_url,
                rm.preview_json,
                rm.created_at,
                lm.title AS material_title,
                lm.material_type,
                lm.file_path_or_url
            FROM remediation_materials rm
            LEFT JOIN learning_materials lm ON rm.material_id = lm.material_id
            WHERE rm.question_id = ?
            ORDER BY rm.created_at DESC`,
            [req.params.qid]
        );
        res.json({ remediations: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/question/:qid/remediation
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/question/:qid/remediation', isTeacher, async (req, res) => {
    try {
        const { advice_text, material_id, link_url, preview_json } = req.body;
        await db.execute(
            `INSERT INTO remediation_materials (question_id, material_id, advice_text, link_url, preview_json)
             VALUES (?, ?, ?, ?, ?)`,
            [req.params.qid, material_id || null, advice_text || null, link_url || null, preview_json ? JSON.stringify(preview_json) : null]
        );

        // Notify struggling students who missed this question via elementa_customer_attempts
        try {
            const [struggling] = await db.query(`
                SELECT DISTINCT 
                    (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) AS student_id,
                    c.class_id
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                JOIN elementa_questions eq ON eca.question_id = eq.question_id
                JOIN topics t ON eq.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                JOIN class_students cs ON c.class_id = cs.class_id AND (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) = cs.student_id
                WHERE eca.question_id = ? AND eca.is_correct = 0
            `, [req.params.qid]);

            if (struggling.length > 0) {
                const studentIds = [...new Set(struggling.map(s => s.student_id).filter(Boolean))];
                const classId = struggling[0].class_id;
                if (studentIds.length > 0) {
                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user.user_id,
                        role: 'Student',
                        category: 'academic',
                        priority: 'high',
                        eventType: 'remediation_assigned',
                        title: 'New Study Guidance Added',
                        message: 'Your teacher posted remedial study material for questions you missed.',
                        targetUrl: `/subjects/open/${classId}`,
                        metadata: { questionId: req.params.qid, materialId: material_id || null }
                    });
                }
            }
        } catch (notifErr) {
            console.error('[Remediation Notification Error]', notifErr.message);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// DELETE /teacher/api/remediation/:remId
// ════════════════════════════════════════════════════════════════════════════
router.delete('/api/remediation/:remId', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM remediation_materials WHERE rem_id = ?`, [req.params.remId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/generate-questions — AI GENERATION via Gemini
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/generate-questions', isTeacher, async (req, res) => {
    try {
        const {
            material_id, topic_id, count,
            difficulty, mechanic_type, input_mode,
            base_exp, time_limit
        } = req.body;

        if (!topic_id) throw new Error('topic_id is required');
        if (!difficulty) throw new Error('difficulty is required');

        const safeCount = Math.min(Math.max(parseInt(count) || 5, 1), 20);

        // 1. Build material context (FIX 1, 4, 8: safe path + type handling)
        let materialContext = '';
        if (material_id) {
            const [matRows] = await db.execute(
                `SELECT title, material_type, file_path_or_url
                 FROM learning_materials WHERE material_id = ?`,
                [material_id]
            );
            if (matRows.length) {
                materialContext = await getMaterialContext(matRows[0]);
            }
        }

        // 2. Fetch topic name for context
        const [topicRows] = await db.execute(
            `SELECT topic_name FROM topics WHERE topic_id = ?`, [topic_id]
        );
        const topicName = topicRows.length ? topicRows[0].topic_name : 'Chemistry';

        // 3. Build prompt (handles all 4 input modes)
        const prompt = `You are a Chemistry teacher creating arcade-style quiz questions.
Topic: ${topicName}${materialContext}
 
Generate exactly ${safeCount} questions with these constraints:
- Difficulty: ${difficulty}
- Mechanic type: ${mechanic_type}
- Input mode: ${input_mode}
 
RULES (follow strictly based on input_mode):
1. "Standard": provide option_a/b/c/d strings, correct_answer = "A"|"B"|"C"|"D", answer_sequences = null.
2. "Periodic_Single": correct_answer = a chemical element symbol (e.g. "Na", "Fe", "O"). All options = null, answer_sequences = null.
3. "Numeric": correct_answer = a numeric string (e.g. "6.022", "18"). All options = null, answer_sequences = null.
4. "Periodic_Sequence": answer_sequences = ordered array of {element_symbol, subscript, sort_order}. correct_answer = null, all options = null.
5. Chemistry-focused questions only. question_text max 150 characters.
6. Return ONLY a valid JSON array, no markdown fences, no extra text.
 
JSON schema for each item:
{
  "question_text": "string",
  "option_a": "string|null",
  "option_b": "string|null",
  "option_c": "string|null",
  "option_d": "string|null",
  "correct_answer": "string|null",
  "answer_sequences": [{"element_symbol":"string","subscript":number,"sort_order":number}]|null,
  "instruction_override": "string|null"
}`;

        // 4. Call Gemini
        // FIX 2: "gemini-1.5-flash-latest" works on both v1beta and v1 API endpoints.
        // "gemini-1.5-flash" (without -latest) returns 404 on older library versions.
        const model = genAI.getGenerativeModel({
            model: 'gemini-1.5-flash-latest',
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.7
            }
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        let generatedQuestions;
        try {
            generatedQuestions = JSON.parse(text);
        } catch (parseErr) {
            throw new Error('AI returned invalid JSON: ' + text.slice(0, 200));
        }

        if (!Array.isArray(generatedQuestions) || !generatedQuestions.length) {
            throw new Error('AI returned empty or non-array response');
        }

        // 5. Insert each question + sequences
        let inserted = 0;
        for (const qItem of generatedQuestions) {
            if (!qItem.question_text) continue;

            const seqArr = Array.isArray(qItem.answer_sequences)
                ? qItem.answer_sequences.filter(s => s && s.element_symbol)
                : [];

            const reqCount = (input_mode === 'Periodic_Sequence' && seqArr.length)
                ? seqArr.length : 1;

            // FIX 5: Sanitize correct_answer to varchar(10) limit for all modes
            let finalCorrect = null;
            if (input_mode === 'Standard') {
                finalCorrect = ['A', 'B', 'C', 'D'].includes(qItem.correct_answer)
                    ? qItem.correct_answer : 'A';
            } else if (input_mode === 'Periodic_Single' || input_mode === 'Numeric') {
                finalCorrect = qItem.correct_answer
                    ? String(qItem.correct_answer).slice(0, 10)
                    : null;
            }
            // Periodic_Sequence → finalCorrect stays null

            const [insertResult] = await db.execute(`
                INSERT INTO question_bank
                    (topic_id, teacher_id, question_text, instruction_override,
                     difficulty, input_mode, mechanic_type, base_exp, time_limit,
                     is_multiple_answer, required_answers_count,
                     option_a, option_b, option_c, option_d, correct_answer,
                     is_ai_generated)
                VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,1)`,
                [
                    topic_id,
                    req.user.user_id,
                    String(qItem.question_text).slice(0, 500),
                    qItem.instruction_override ? String(qItem.instruction_override).slice(0, 500) : null,
                    difficulty,
                    input_mode || 'Standard',
                    mechanic_type || 'standard_mcq',
                    parseInt(base_exp) || 100,
                    parseInt(time_limit) || 30,
                    reqCount,
                    qItem.option_a ? String(qItem.option_a).slice(0, 255) : null,
                    qItem.option_b ? String(qItem.option_b).slice(0, 255) : null,
                    qItem.option_c ? String(qItem.option_c).slice(0, 255) : null,
                    qItem.option_d ? String(qItem.option_d).slice(0, 255) : null,
                    finalCorrect
                ]
            );

            const newQid = insertResult.insertId;

            if (input_mode === 'Periodic_Sequence' && seqArr.length) {
                await syncAnswerSequences(db, newQid, seqArr);
            }

            inserted++;
        }

        res.json({ success: true, inserted });

    } catch (e) {
        console.error('[GEMINI ERROR] POST /api/generate-questions:', e.message);
        res.status(500).json({ error: 'AI Generation Failed: ' + e.message });
    }
});


// ================================================================
// GET /teacher/forums
// Renders the forums page with all required data
// ================================================================
// ── Multer config for reply file attachments ──────────────────────────────
const forumStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir;
        if (file.fieldname === 'banner_image' || file.fieldname === 'banner_file') {
            dir = path.join(__dirname, '../public/forum_banners/uploads');
        } else {
            dir = path.join(__dirname, '../files');
        }
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const forumUpload = multer({
    storage: forumStorage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    fileFilter: (req, file, cb) => {
        if (!file || !file.originalname) return cb(null, true);
        const allowedExt = /jpeg|jpg|png|gif|webp|svg|pdf|doc|docx|ppt|pptx|xls|xlsx|txt|mp4|mov|webm|mp3|wav|ogg|m4a|zip/i;
        const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
        if (allowedExt.test(ext) || allowedExt.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed: ' + file.mimetype));
        }
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/forums — Render the forums page
// ════════════════════════════════════════════════════════════════════════════
router.get('/forums', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;
        const syStartDate = currentSY && currentSY.start_date ? new Date(currentSY.start_date) : null;
        const syEndDate = currentSY && currentSY.end_date ? new Date(currentSY.end_date) : null;

        // 1. Fetch all subjects that belong to this teacher's active classes
        const [subjects] = await db.execute(`
            SELECT DISTINCT s.subject_id, s.subject_name, s.subject_code, s.subject_image
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
            ORDER BY s.subject_name ASC`,
            [teacherId, currentSyId, currentSyId]
        );

        // Fetch active classes for section selection
        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id
            FROM classes c
            WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
            ORDER BY c.class_name ASC`,
            [teacherId, currentSyId, currentSyId]
        );

        const subjectIds = subjects.map(s => s.subject_id);
        if (!subjectIds.length) {
            const notifications = await getTeacherNotifications(db, teacherId);
            return res.render('teacher/forums', {
                user: req.user,
                currentSY,
                allForumsData: [],
                forums: [],
                subjects: [],
                topics: [],
                classes: [],
                enrolledStudents: [],
                notifications,
            });
        }

        const placeholders = subjectIds.map(() => '?').join(',');

        // 2. All curriculum topics for those subjects (with quarter info)
        const [topics] = await db.execute(`
            SELECT t.topic_id, t.topic_name, t.is_locked,
                   q.quarter_id, q.quarter_number, q.subject_id
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id IN (${placeholders})
            ORDER BY q.subject_id, q.quarter_number, t.topic_id ASC`,
            subjectIds
        );

        // 3. All forum threads for this teacher with enriched metadata (scoped to active school year)
        const [forums] = await db.execute(`
            SELECT
                ft.forum_id,
                ft.topic_id,
                ft.subject_id,
                ft.class_id,
                ft.teacher_id,
                ft.title,
                ft.forum_content,
                ft.due_date,
                ft.base_exp,
                ft.post_before_viewing,
                ft.allow_anonymous,
                ft.attachment_path,
                ft.attachment_name,
                ft.is_pinned,
                ft.status,
                ft.resolved_by,
                ft.created_at,
                u.first_name  AS teacher_first,
                u.last_name   AS teacher_last,
                u.profile_pic AS teacher_pic,
                t.topic_name,
                q.quarter_number,
                q.subject_id  AS q_subject_id,
                c.class_name,

                -- Reply count
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ft.forum_id) AS reply_count,

                -- Last activity (most recent reply or post date)
                (SELECT MAX(fr2.created_at) FROM forum_replies fr2 WHERE fr2.topic_id = ft.forum_id) AS last_reply_at,

                -- Completion count (students who marked done)
                (SELECT COUNT(*) FROM student_forum_done sfd WHERE sfd.forum_id = ft.forum_id) AS done_count,

                -- Enrolled students count (scoped to specific class if class_id is set, else all classes of subject in active SY)
                IF(ft.class_id IS NOT NULL,
                    (SELECT COUNT(DISTINCT cs2.student_id) FROM class_students cs2 WHERE cs2.class_id = ft.class_id),
                    (SELECT COUNT(DISTINCT cs.student_id)
                     FROM class_students cs
                     JOIN classes c2 ON cs.class_id = c2.class_id
                     WHERE c2.subject_id = ft.subject_id AND (? IS NULL OR c2.sy_id = ?))
                ) AS enrolled_count

            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON ft.class_id = c.class_id
            WHERE ft.teacher_id = ?
              AND (
                  ft.class_id IN (SELECT class_id FROM classes WHERE teacher_id = ? AND (? IS NULL OR sy_id = ?))
                  OR (ft.class_id IS NULL AND (? IS NULL OR (ft.created_at >= ? AND ft.created_at <= ?)))
              )
            ORDER BY ft.is_pinned DESC, ft.created_at DESC`,
            [
                currentSyId, currentSyId,
                teacherId, teacherId, currentSyId, currentSyId,
                currentSyId, syStartDate, syEndDate
            ]
        );

        // Flatten teacher_name
        forums.forEach(f => {
            f.teacher_name = `${f.teacher_first} ${f.teacher_last}`;
        });

        // 4. All enrolled students in active classes
        const [enrolledStudents] = await db.execute(`
            SELECT DISTINCT
                u.user_id   AS student_id,
                u.first_name,
                u.last_name,
                u.profile_pic
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE c.subject_id IN (${placeholders})
              AND (? IS NULL OR c.sy_id = ?)
              AND u.role = 'Student'
            ORDER BY u.last_name, u.first_name ASC`,
            [...subjectIds, currentSyId, currentSyId]
        );

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/forums', {
            user: req.user,
            currentSY,
            allForumsData: forums,
            forums: forums,
            subjects,
            topics,
            classes,
            enrolledStudents,
            notifications,
        });

    } catch (err) {
        console.error('❌ [GET /teacher/forums]', err);
        res.status(500).send('Error loading forums page.');
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/forums/view/:forumId — Dedicated Teacher Forum View Workspace
// ════════════════════════════════════════════════════════════════════════════
const renderTeacherForumView = async (req, res) => {
    const teacherId = req.user.user_id;
    const forumId = parseInt(req.params.forumId, 10);
    if (isNaN(forumId)) return res.redirect('/teacher/forums?error=Invalid+forum+ID');

    try {
        // 1. Fetch forum details + subject + topic + quarter + teacher info
        const [forumRows] = await db.execute(`
            SELECT ft.*,
                   s.subject_name, s.subject_code, s.subject_image,
                   t.topic_name,
                   q.quarter_number,
                   u.first_name AS teacher_first, u.last_name AS teacher_last, u.profile_pic AS teacher_pic
            FROM forum_topics ft
            JOIN subjects s ON ft.subject_id = s.subject_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.forum_id = ?
              AND (ft.teacher_id = ? OR EXISTS (
                  SELECT 1 FROM classes c WHERE c.subject_id = ft.subject_id AND c.teacher_id = ?
              ))
            LIMIT 1
        `, [forumId, teacherId, teacherId]);

        if (!forumRows.length) {
            return res.redirect('/teacher/forums?error=Forum+not+found+or+access+denied');
        }

        const forum = forumRows[0];
        forum.teacher_name = `${forum.teacher_first} ${forum.teacher_last}`;

        // 2. Fetch enrolled students and their completion status
        const [enrolledStudents] = await db.execute(`
            SELECT DISTINCT
                u.user_id AS student_id,
                u.first_name, u.last_name, u.profile_pic, u.email,
                (SELECT sfd.done_at FROM student_forum_done sfd WHERE sfd.forum_id = ? AND sfd.student_id = u.user_id LIMIT 1) AS done_at,
                EXISTS(SELECT 1 FROM student_forum_done sfd WHERE sfd.forum_id = ? AND sfd.student_id = u.user_id) AS is_done,
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ? AND fr.user_id = u.user_id) AS contributions_count
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE c.subject_id = ? AND u.role = 'Student'
            ORDER BY is_done DESC, u.last_name ASC, u.first_name ASC
        `, [forumId, forumId, forumId, forum.subject_id]);

        const enrolledCount = enrolledStudents.length;
        const doneCount = enrolledStudents.filter(s => s.is_done).length;
        const completionRate = enrolledCount > 0 ? Math.round((doneCount / enrolledCount) * 100) : 0;

        // 3. Fetch root student discussion topics
        const [discussions] = await db.execute(`
            SELECT fr.*,
                   u.first_name, u.last_name, u.profile_pic, u.role, u.top_contributor,
                   (SELECT COUNT(*) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS reply_count,
                   (SELECT MAX(c.created_at) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS last_reply_at,
                   (SELECT CONCAT(u2.first_name, ' ', u2.last_name)
                    FROM forum_replies c2
                    JOIN users u2 ON c2.user_id = u2.user_id
                    WHERE c2.parent_reply_id = fr.reply_id
                    ORDER BY c2.created_at DESC LIMIT 1) AS last_reply_user_name,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS vote_count,
                   (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked,
                   (SELECT COUNT(*) FROM forum_reports rep WHERE rep.reply_id = fr.reply_id AND rep.status = 'pending') AS report_count,
                   EXISTS(SELECT 1 FROM forum_reply_stars frs WHERE frs.reply_id = fr.reply_id AND frs.user_id = ?) AS is_starred
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ? AND fr.parent_reply_id IS NULL
            ORDER BY fr.is_endorsed DESC, fr.created_at DESC
        `, [teacherId, teacherId, forumId]);

        discussions.forEach(d => {
            if (d.is_anonymous && d.role === 'Student') {
                if (d.is_unmasked > 0) {
                    d.author_name = `${d.first_name} ${d.last_name} (Unmasked)`;
                    d.unmasked = true;
                    d.author_pic = d.profile_pic || 'default_avatar.png';
                } else {
                    d.author_name = 'Anonymous Student';
                    d.unmasked = false;
                    d.author_pic = 'default_avatar.png';
                }
            } else {
                d.author_name = `${d.first_name} ${d.last_name}`;
                d.unmasked = false;
                d.author_pic = d.profile_pic || 'default_avatar.png';
            }
        });

        // 4. Calculate total responses across all discussions in forum
        let totalResponsesCount = 0;
        discussions.forEach(d => { totalResponsesCount += (1 + (d.reply_count || 0)); });

        // 5. Total pending moderation flags
        const [[reportSummary]] = await db.execute(`
            SELECT COUNT(*) AS total_pending_reports
            FROM forum_reports rep
            JOIN forum_replies fr ON rep.reply_id = fr.reply_id
            WHERE fr.topic_id = ? AND rep.status = 'pending'
        `, [forumId]);

        // Fetch classes for this subject and teacher (for modal editing)
        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id
            FROM classes c
            WHERE c.subject_id = ? AND c.teacher_id = ?
            ORDER BY c.class_name ASC`,
            [forum.subject_id, teacherId]
        );

        // Fetch curriculum topics for this subject (for modal editing)
        const [topics] = await db.execute(`
            SELECT t.topic_id, t.topic_name, q.quarter_number
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
            ORDER BY q.quarter_number, t.topic_id ASC`,
            [forum.subject_id]
        );

        const notifications = await getTeacherNotifications(db, teacherId);

        res.render('teacher/forumview', {
            user: req.user,
            forum,
            discussions,
            enrolledStudents,
            classes,
            topics,
            stats: {
                enrolled_count: enrolledCount,
                done_count: doneCount,
                completion_rate: completionRate,
                total_topics: discussions.length,
                total_responses: totalResponsesCount,
                pending_reports: reportSummary ? reportSummary.total_pending_reports : 0
            },
            notifications
        });

    } catch (err) {
        console.error('❌ [GET /teacher/forums/view/:forumId]', err);
        res.status(500).send('Error loading teacher forum workspace: ' + err.message);
    }
};

router.get('/forums/view/:forumId', isTeacher, renderTeacherForumView);
router.get('/forumview/:forumId', isTeacher, renderTeacherForumView);


// ════════════════════════════════════════════════════════════════════════════
// HELPER & UPLOAD MIDDLEWARE FOR FORUM WORKSPACE
// ════════════════════════════════════════════════════════════════════════════
function formatMySqlDateTime(dtStr) {
    if (!dtStr || !String(dtStr).trim()) return null;
    const d = new Date(dtStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

const handleForumUpload = (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
        return forumUpload.fields([
            { name: 'attachment', maxCount: 1 },
            { name: 'forum_attachment', maxCount: 1 },
            { name: 'banner_image', maxCount: 1 },
            { name: 'banner_file', maxCount: 1 }
        ])(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.message });
            next();
        });
    }
    next();
};

// ── GET /teacher/api/forum-banner-presets — Return curated chemistry banner presets ──
router.get('/api/forum-banner-presets', isTeacher, (req, res) => {
    try {
        const manifestPath = path.join(__dirname, '../public/forum_banners/presets/presets.json');
        if (fs.existsSync(manifestPath)) {
            const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            return res.json({ success: true, presets: data });
        }
        res.json({ success: true, presets: [] });
    } catch (err) {
        console.error('❌ [GET /api/forum-banner-presets]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/:forumId — Thread detail (forum + replies + completion)
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/:forumId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        // 1. Forum info with all new fields
        const [forumRows] = await db.execute(`
            SELECT
                ft.forum_id, ft.topic_id, ft.subject_id, ft.class_id, ft.teacher_id,
                ft.title, ft.forum_content, ft.due_date, ft.base_exp,
                ft.post_before_viewing, ft.allow_anonymous,
                ft.attachment_path, ft.attachment_name,
                ft.is_pinned, ft.status, ft.resolved_by, ft.created_at,
                u.first_name AS teacher_first, u.last_name AS teacher_last,
                u.profile_pic AS teacher_pic,
                t.topic_name,
                q.quarter_number,
                c.class_name,
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ft.forum_id) AS reply_count,
                (SELECT MAX(fr2.created_at) FROM forum_replies fr2 WHERE fr2.topic_id = ft.forum_id) AS last_reply_at,
                (SELECT COUNT(*) FROM student_forum_done sfd WHERE sfd.forum_id = ft.forum_id) AS done_count
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON ft.class_id = c.class_id
            WHERE ft.forum_id = ? AND (ft.teacher_id = ? OR EXISTS (
                SELECT 1 FROM classes c2 WHERE c2.subject_id = ft.subject_id AND c2.teacher_id = ?
            ))`,
            [forumId, teacherId, teacherId]
        );

        if (!forumRows.length) return res.status(404).json({ error: 'Forum not found or access denied.' });

        const forum = forumRows[0];
        forum.teacher_name = `${forum.teacher_first} ${forum.teacher_last}`;

        // 2. All replies (flat, with author info)
        const [replies] = await db.execute(`
            SELECT
                fr.reply_id, fr.topic_id AS forum_id, fr.user_id, fr.reply_title, fr.is_anonymous,
                fr.is_endorsed, fr.is_accepted, fr.is_locked,
                fr.parent_reply_id, fr.reply_content,
                fr.file_path, fr.file_name, fr.file_type,
                fr.external_link, fr.created_at,
                u.first_name, u.last_name, u.profile_pic,
                u.role AS author_role,
                u.top_contributor,
                (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS vote_count,
                (SELECT EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.user_id = ?)) AS user_voted,
                (SELECT EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.is_teacher = 1)) AS teacher_voted,
                (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.is_endorsed DESC, fr.created_at ASC`,
            [teacherId, teacherId, forumId]
        );

        replies.forEach(r => {
            if (r.is_anonymous && r.author_role === 'Student') {
                if (r.is_unmasked > 0) {
                    r.author_name = `${r.first_name} ${r.last_name} (Unmasked)`;
                    r.unmasked = true;
                } else {
                    r.author_name = 'Anonymous Student';
                    r.profile_pic = 'default_avatar.png';
                    r.unmasked = false;
                }
            } else {
                r.author_name = `${r.first_name} ${r.last_name}`;
                r.is_anonymous = 0;
            }
        });

        // 3. Students who marked as done
        const [doneStudents] = await db.execute(`
            SELECT sfd.student_id, sfd.done_at, sfd.exp_awarded, sfd.time_tier,
                   u.first_name, u.last_name, u.profile_pic
            FROM student_forum_done sfd
            JOIN users u ON sfd.student_id = u.user_id
            WHERE sfd.forum_id = ?`,
            [forumId]
        );

        // 4. All students enrolled in the forum's subject (or class if scoped)
        let enrolledStudents = [];
        if (forum.class_id) {
            const [rows] = await db.execute(`
                SELECT DISTINCT
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.profile_pic
                FROM users u
                JOIN class_students cs ON u.user_id = cs.student_id
                WHERE cs.class_id = ? AND u.role = 'Student'
                ORDER BY u.last_name, u.first_name ASC`,
                [forum.class_id]
            );
            enrolledStudents = rows;
        } else {
            const [rows] = await db.execute(`
                SELECT DISTINCT
                    u.user_id AS student_id,
                    u.first_name, u.last_name, u.profile_pic
                FROM users u
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.subject_id = ? AND u.role = 'Student'
                ORDER BY u.last_name, u.first_name ASC`,
                [forum.subject_id]
            );
            enrolledStudents = rows;
        }

        res.json({ forum, replies, done_students: doneStudents, enrolled_students: enrolledStudents });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/:forumId]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum — Create a new forum thread (with full production fields)
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/forum', isTeacher, handleForumUpload, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const {
            title, forum_content, subject_id, topic_id, class_id,
            due_date, base_exp, post_before_viewing, allow_anonymous, is_pinned,
            banner_choice, banner_preset
        } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
        if (!subject_id) return res.status(400).json({ error: 'subject_id is required.' });

        // Verify teacher owns a class for this subject
        const [chk] = await db.execute(
            `SELECT class_id FROM classes WHERE teacher_id = ? AND subject_id = ? LIMIT 1`,
            [teacherId, subject_id]
        );
        if (!chk.length) return res.status(403).json({ error: 'You do not teach this subject.' });

        // Handle attachment file if present
        let attachment_path = null;
        let attachment_name = null;
        const uploadedFile = req.files ? (req.files.attachment?.[0] || req.files.forum_attachment?.[0]) : null;
        if (uploadedFile) {
            attachment_path = '/files/' + uploadedFile.filename;
            attachment_name = uploadedFile.originalname;
        }

        // Handle forum banner selection (preset vs custom upload vs default)
        let final_banner_image = null;
        const uploadedBanner = req.files ? (req.files.banner_image?.[0] || req.files.banner_file?.[0]) : null;
        if (uploadedBanner) {
            final_banner_image = '/forum_banners/uploads/' + uploadedBanner.filename;
        } else if (banner_choice === 'preset' && banner_preset && banner_preset.trim()) {
            final_banner_image = banner_preset.trim().startsWith('/') ? banner_preset.trim() : ('/forum_banners/presets/' + banner_preset.trim());
        } else if (banner_choice === 'default') {
            final_banner_image = null;
        } else if (banner_preset && banner_preset.trim()) {
            final_banner_image = banner_preset.trim().startsWith('/') ? banner_preset.trim() : ('/forum_banners/presets/' + banner_preset.trim());
        }

        const formattedDueDate = formatMySqlDateTime(due_date);
        const parsedBaseExp = parseInt(base_exp, 10) || 100;
        const parsedTopicId = topic_id && String(topic_id).trim() ? parseInt(topic_id, 10) : null;
        const parsedClassId = class_id && String(class_id).trim() && String(class_id).trim() !== 'all' ? parseInt(class_id, 10) : null;
        const parsedPostBeforeViewing = (post_before_viewing === '1' || post_before_viewing === 1 || post_before_viewing === true || post_before_viewing === 'true') ? 1 : 0;
        const parsedAllowAnonymous = (allow_anonymous === '0' || allow_anonymous === 0 || allow_anonymous === false || allow_anonymous === 'false') ? 0 : 1;
        const parsedIsPinned = (is_pinned === '1' || is_pinned === 1 || is_pinned === true || is_pinned === 'true') ? 1 : 0;

        const [result] = await db.execute(`
            INSERT INTO forum_topics (
                topic_id, subject_id, class_id, teacher_id, title, forum_content,
                due_date, base_exp, post_before_viewing, allow_anonymous,
                attachment_path, attachment_name, is_pinned, banner_image
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                parsedTopicId,
                subject_id,
                parsedClassId,
                teacherId,
                title.trim().slice(0, 255),
                forum_content ? forum_content.trim() : null,
                formattedDueDate,
                parsedBaseExp,
                parsedPostBeforeViewing,
                parsedAllowAnonymous,
                attachment_path,
                attachment_name,
                parsedIsPinned,
                final_banner_image
            ]
        );

        // Return the newly created forum for client-side injection
        const [newForum] = await db.execute(`
            SELECT ft.*, u.first_name AS teacher_first, u.last_name AS teacher_last,
                   u.profile_pic AS teacher_pic,
                   t.topic_name, q.quarter_number,
                   c.class_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON ft.class_id = c.class_id
            WHERE ft.forum_id = ?`,
            [result.insertId]
        );

        if (!newForum || newForum.length === 0) {
            return res.status(500).json({ error: 'Failed to retrieve the created forum.' });
        }

        const forum = newForum[0];
        forum.teacher_name = `${forum.teacher_first} ${forum.teacher_last}`;
        forum.reply_count = 0;
        forum.done_count = 0;
        forum.enrolled_count = 0;
        forum.last_reply_at = null;

        res.json({ success: true, forum });

    } catch (err) {
        console.error('❌ [POST /teacher/api/forum]', err);
        res.status(500).json({ error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/forum/:forumId & POST /teacher/api/forum/:forumId/edit — Update forum
// ════════════════════════════════════════════════════════════════════════════
const handleForumUpdate = async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        const {
            title, forum_content, topic_id, class_id,
            due_date, base_exp, post_before_viewing, allow_anonymous, is_pinned,
            remove_attachment,
            banner_choice, banner_preset, remove_banner
        } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });

        // Check if teacher owns or teaches this forum
        const [currRows] = await db.execute(
            `SELECT * FROM forum_topics WHERE forum_id = ? AND teacher_id = ? LIMIT 1`,
            [forumId, teacherId]
        );
        if (!currRows.length) return res.status(404).json({ error: 'Forum not found or access denied.' });
        const curr = currRows[0];

        // Process fields
        const formattedDueDate = due_date !== undefined ? formatMySqlDateTime(due_date) : curr.due_date;
        const parsedBaseExp = base_exp !== undefined ? (parseInt(base_exp, 10) || 100) : curr.base_exp;
        const parsedTopicId = topic_id !== undefined ? (topic_id && String(topic_id).trim() ? parseInt(topic_id, 10) : null) : curr.topic_id;
        const parsedClassId = class_id !== undefined ? (class_id && String(class_id).trim() && String(class_id).trim() !== 'all' ? parseInt(class_id, 10) : null) : curr.class_id;
        const parsedPostBeforeViewing = post_before_viewing !== undefined
            ? ((post_before_viewing === '1' || post_before_viewing === 1 || post_before_viewing === true || post_before_viewing === 'true') ? 1 : 0)
            : curr.post_before_viewing;
        const parsedAllowAnonymous = allow_anonymous !== undefined
            ? ((allow_anonymous === '0' || allow_anonymous === 0 || allow_anonymous === false || allow_anonymous === 'false') ? 0 : 1)
            : curr.allow_anonymous;
        const parsedIsPinned = is_pinned !== undefined
            ? ((is_pinned === '1' || is_pinned === 1 || is_pinned === true || is_pinned === 'true') ? 1 : 0)
            : curr.is_pinned;

        // Attachment handling
        let attachment_path = curr.attachment_path;
        let attachment_name = curr.attachment_name;
        const uploadedFile = req.files ? (req.files.attachment?.[0] || req.files.forum_attachment?.[0]) : null;
        if (uploadedFile) {
            attachment_path = '/files/' + uploadedFile.filename;
            attachment_name = uploadedFile.originalname;
        } else if (remove_attachment === '1' || remove_attachment === 1 || remove_attachment === true || remove_attachment === 'true') {
            attachment_path = null;
            attachment_name = null;
        }

        // Banner handling (preset vs custom upload vs default/remove)
        let banner_image = curr.banner_image;
        const uploadedBanner = req.files ? (req.files.banner_image?.[0] || req.files.banner_file?.[0]) : null;
        if (uploadedBanner) {
            banner_image = '/forum_banners/uploads/' + uploadedBanner.filename;
        } else if (banner_choice === 'preset' && banner_preset && banner_preset.trim()) {
            banner_image = banner_preset.trim().startsWith('/') ? banner_preset.trim() : ('/forum_banners/presets/' + banner_preset.trim());
        } else if (banner_choice === 'default' || remove_banner === '1' || remove_banner === 1 || remove_banner === true || remove_banner === 'true') {
            banner_image = null;
        } else if (banner_preset && banner_preset.trim() && banner_choice !== 'default') {
            banner_image = banner_preset.trim().startsWith('/') ? banner_preset.trim() : ('/forum_banners/presets/' + banner_preset.trim());
        }

        const [result] = await db.execute(`
            UPDATE forum_topics
            SET title = ?,
                forum_content = ?,
                topic_id = ?,
                class_id = ?,
                due_date = ?,
                base_exp = ?,
                post_before_viewing = ?,
                allow_anonymous = ?,
                attachment_path = ?,
                attachment_name = ?,
                is_pinned = ?,
                banner_image = ?
            WHERE forum_id = ? AND teacher_id = ?`,
            [
                title.trim().slice(0, 255),
                forum_content ? forum_content.trim() : null,
                parsedTopicId,
                parsedClassId,
                formattedDueDate,
                parsedBaseExp,
                parsedPostBeforeViewing,
                parsedAllowAnonymous,
                attachment_path,
                attachment_name,
                parsedIsPinned,
                banner_image,
                forumId,
                teacherId
            ]
        );

        if (!result.affectedRows) return res.status(404).json({ error: 'Forum not found or access denied.' });

        // Retrieve updated forum
        const [updatedRows] = await db.execute(`
            SELECT ft.*, u.first_name AS teacher_first, u.last_name AS teacher_last,
                   t.topic_name, q.quarter_number, c.class_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN classes c ON ft.class_id = c.class_id
            WHERE ft.forum_id = ?`,
            [forumId]
        );

        res.json({ success: true, forum: updatedRows[0] || null });

    } catch (err) {
        console.error('❌ [PUT/POST /teacher/api/forum/:forumId]', err);
        res.status(500).json({ error: err.message });
    }
};

router.put('/api/forum/:forumId', isTeacher, handleForumUpload, handleForumUpdate);
router.post('/api/forum/:forumId/edit', isTeacher, handleForumUpload, handleForumUpdate);


// ════════════════════════════════════════════════════════════════════════════
// DELETE /teacher/api/forum/:forumId — Delete forum (cascades to replies)
// ════════════════════════════════════════════════════════════════════════════
router.delete('/api/forum/:forumId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        const [result] = await db.execute(
            `DELETE FROM forum_topics WHERE forum_id = ? AND teacher_id = ?`,
            [forumId, teacherId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Forum not found or access denied.' });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [DELETE /teacher/api/forum/:forumId]', err);
        res.status(500).json({ error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/forum/:forumId/pin — Toggle pin
// (also used internally by /teacher/api/forum/:fid/pin in existing code)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/api/forum/:forumId/pin', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        const { is_pinned } = req.body;
        if (is_pinned === undefined) return res.status(400).json({ error: 'is_pinned missing.' });

        const [result] = await db.execute(
            `UPDATE forum_topics SET is_pinned = ? WHERE forum_id = ? AND teacher_id = ?`,
            [is_pinned ? 1 : 0, forumId, teacherId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Forum not found or access denied.' });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [PATCH /teacher/api/forum/:forumId/pin]', err);
        res.status(500).json({ error: err.message });
    }
});
// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/forum/:forumId/status — Change thread status (Phase 2)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/api/forum/:forumId/status', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    const { status } = req.body;
    const allowed = ['unresolved', 'solved', 'instructor_verified'];

    if (!status || !allowed.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Allowed: unresolved, solved, instructor_verified.' });
    }

    try {
        const resolvedBy = (status === 'unresolved') ? null : teacherId;
        const [result] = await db.execute(
            `UPDATE forum_topics SET status = ?, resolved_by = ? WHERE forum_id = ? AND teacher_id = ?`,
            [status, resolvedBy, forumId, teacherId]
        );

        if (!result.affectedRows) return res.status(404).json({ error: 'Forum not found or access denied.' });

        res.json({ success: true, status, resolved_by: resolvedBy });
    } catch (err) {
        console.error('❌ [PATCH /teacher/api/forum/:forumId/status]', err);
        res.status(500).json({ error: err.message });
    }
});



// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum/reply — Post a reply (with optional file upload)
// ════════════════════════════════════════════════════════════════════════════
const replyUploadMiddleware = forumUpload.fields([
    { name: 'forum_file', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'reply_file', maxCount: 1 },
    { name: 'attachment', maxCount: 1 }
]);

router.post('/api/forum/reply', isTeacher, replyUploadMiddleware, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        // GINAMIT NATIN ANG forum_id DITO PARA TUMUGMA SA FRONTEND
        const { forum_id, reply_content, parent_reply_id, external_link } = req.body;

        if (!forum_id) return res.status(400).json({ error: 'forum_id is required.' });
        if (!reply_content || !reply_content.trim()) return res.status(400).json({ error: 'Reply content is required.' });

        // Verify teacher owns this forum
        const [chk] = await db.execute(
            `SELECT forum_id FROM forum_topics WHERE forum_id = ? AND teacher_id = ? LIMIT 1`,
            [forum_id, teacherId]
        );
        if (!chk.length) return res.status(403).json({ error: 'You do not own this forum thread.' });

        // Validate parent reply belongs to this forum
        if (parent_reply_id) {
            const [parentChk] = await db.execute(
                `SELECT reply_id FROM forum_replies WHERE reply_id = ? AND topic_id = ? LIMIT 1`,
                [parent_reply_id, forum_id]
            );
            if (!parentChk.length) return res.status(400).json({ error: 'Invalid parent reply.' });
        }

        const file = req.files ? (
            req.files['forum_file']?.[0] ||
            req.files['file']?.[0] ||
            req.files['reply_file']?.[0] ||
            req.files['attachment']?.[0]
        ) : req.file;
        const filePath = file ? file.filename : null;
        const fileName = file ? file.originalname : null;
        const fileType = file ? file.mimetype : null;
        const extLink = external_link && external_link.trim() ? external_link.trim() : null;

        // SIGURADUHIN NA forum_id ANG IPINAPASA SA topic_id COLUMN NG DATABASE
        const [result] = await db.execute(`
            INSERT INTO forum_replies
                (topic_id, user_id, parent_reply_id, reply_content, file_path, file_name, file_type, external_link)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                forum_id, // <--- ITO ANG CRITICAL FIX
                teacherId,
                parent_reply_id || null,
                reply_content.trim(),
                filePath,
                fileName,
                fileType,
                extLink
            ]
        );

        // Dispatch notification to parent reply author or student thread author
        try {
            const senderName = `${req.user.first_name || 'Instructor'} ${req.user.last_name || ''}`.trim();
            const [[topicRow]] = await db.execute(`SELECT title, subject_id, teacher_id FROM forum_topics WHERE forum_id = ? LIMIT 1`, [forum_id]);
            const topicTitle = topicRow ? topicRow.title : 'Discussion Thread';
            const forumSubjectId = topicRow ? topicRow.subject_id : null;
            const studentTargetUrl = `/forums/view/${forum_id}#reply-${result.insertId}`;
            const teacherTargetUrl = `/teacher/forums?forum_id=${forum_id}#forum-${forum_id}`;
            const snippet = reply_content.trim().length > 80 ? reply_content.trim().substring(0, 77) + '...' : reply_content.trim();

            let targetAuthorId = null;
            if (parent_reply_id) {
                const [[parentRow]] = await db.execute(`SELECT user_id FROM forum_replies WHERE reply_id = ? LIMIT 1`, [parent_reply_id]);
                if (parentRow && parentRow.user_id && parentRow.user_id !== teacherId) {
                    targetAuthorId = parentRow.user_id;
                }
            }

            if (targetAuthorId) {
                const [[authorRow]] = await db.execute(`SELECT role FROM users WHERE user_id = ? LIMIT 1`, [targetAuthorId]);
                const recipientRole = authorRow?.role || 'Student';
                await notificationService.dispatch({
                    recipientIds: targetAuthorId,
                    actorId: teacherId,
                    role: recipientRole,
                    category: 'forum',
                    priority: 'high',
                    eventType: 'forum_reply_received',
                    title: `Instructor Reply in "${topicTitle}"`,
                    message: `${senderName}: "${snippet}"`,
                    targetUrl: recipientRole === 'Teacher' ? teacherTargetUrl : studentTargetUrl,
                    metadata: { forumId: forum_id, replyId: result.insertId }
                });
            }

            // Check for @mentions
            const mentionRegex = /@([a-zA-Z0-9._-]+)/g;
            const matches = [];
            let m;
            while ((m = mentionRegex.exec(reply_content)) !== null) {
                matches.push(m[1]);
            }
            const handles = [...new Set(matches)];
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
                `, [handle, handle.replace(/[._]/g, ''), cleanHandle, teacherId, forumSubjectId, topicRow ? topicRow.teacher_id : null, forumSubjectId, forumSubjectId]);

                if (users.length > 0 && users[0].user_id !== targetAuthorId) {
                    const recipientRole = users[0].role || 'Student';
                    await notificationService.dispatch({
                        recipientIds: users[0].user_id,
                        actorId: teacherId,
                        role: recipientRole,
                        category: 'social',
                        priority: 'high',
                        eventType: 'forum_mention',
                        title: `Mentioned by ${senderName}`,
                        message: `Mentioned you in "${topicTitle}": "${snippet}"`,
                        targetUrl: recipientRole === 'Teacher' ? teacherTargetUrl : studentTargetUrl,
                        metadata: { forumId: forum_id, replyId: result.insertId }
                    });
                }
            }
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Teacher Forum Reply]', notifErr.message);
        }

        res.json({ success: true, reply_id: result.insertId });

    } catch (err) {
        console.error('❌ [POST /teacher/api/forum/reply]', err);
        // If multer threw (file type)
        if (err.message && err.message.startsWith('File type not allowed')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// DELETE /teacher/api/forum/reply/:replyId — Delete a reply + its children
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum/reply/:replyId/reveal — Break-glass unmask endpoint
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/forum/reply/:replyId/endorse — Endorse reply (atomic)
// ════════════════════════════════════════════════════════════════════════════

// POST /teacher/api/forum/reply/:replyId/vote — Teacher upvote (+1 / ⭐) (Phase 5)
router.post('/api/forum/reply/:replyId/vote', isTeacher, async (req, res) => {
    const replyId = parseInt(req.params.replyId, 10);
    if (isNaN(replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const teacherId = req.user.user_id;

    try {
        const [[replyRow]] = await db.execute(`
            SELECT fr.reply_id, fr.user_id AS author_id, ft.forum_id
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            WHERE fr.reply_id = ?
        `, [replyId]);

        if (!replyRow) return res.status(404).json({ error: 'Reply not found' });

        if (replyRow.author_id === teacherId) {
            return res.status(403).json({ error: 'You cannot upvote your own insight.' });
        }

        const [existingVote] = await db.execute(
            'SELECT vote_id FROM reply_votes WHERE reply_id = ? AND user_id = ?',
            [replyId, teacherId]
        );

        let voted = false;
        if (existingVote.length > 0) {
            await db.execute('DELETE FROM reply_votes WHERE vote_id = ?', [existingVote[0].vote_id]);
            voted = false;
        } else {
            await db.execute(
                'INSERT INTO reply_votes (reply_id, user_id, is_teacher) VALUES (?, ?, 1)',
                [replyId, teacherId]
            );
            voted = true;
        }

        const [countRows] = await db.execute(
            'SELECT COUNT(*) AS voteCount FROM reply_votes WHERE reply_id = ?',
            [replyId]
        );
        const voteCount = countRows[0].voteCount;

        // Recalculate badge for reply author
        const [upvoteRows] = await db.execute(`
            SELECT COUNT(rv.vote_id) AS totalUpvotes
            FROM forum_replies fr
            JOIN reply_votes rv ON fr.reply_id = rv.reply_id
            WHERE fr.user_id = ?
        `, [replyRow.author_id]);

        const [thresholdRows] = await db.execute(
            "SELECT threshold_value FROM badge_thresholds WHERE badge_key = 'top_contributor_votes'"
        );
        const threshold = thresholdRows.length ? thresholdRows[0].threshold_value : 10;
        const isTop = upvoteRows[0].totalUpvotes >= threshold ? 1 : 0;

        await db.execute(
            'UPDATE users SET top_contributor = ? WHERE user_id = ?',
            [isTop, replyRow.author_id]
        );

        res.json({
            success: true,
            voted,
            vote_count: voteCount,
            is_teacher: true
        });
    } catch (err) {
        console.error('❌ [POST /teacher/api/forum/reply/:replyId/vote]', err);
        res.status(500).json({ error: err.message });
    }
});

router.patch('/api/forum/reply/:replyId/endorse', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const replyId = parseInt(req.params.replyId, 10);
    if (isNaN(replyId)) return res.status(400).json({ error: 'Invalid reply ID.' });

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        // Verify reply belongs to forum owned by this teacher
        const [rows] = await conn.execute(`
            SELECT fr.reply_id, fr.topic_id AS forum_id, fr.user_id AS reply_user_id, fr.is_endorsed, ft.teacher_id, ft.title AS topic_title
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            WHERE fr.reply_id = ?
        `, [replyId]);

        if (!rows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Reply not found.' });
        }

        const target = rows[0];
        if (target.teacher_id !== teacherId) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied. You do not own this forum thread.' });
        }

        // Restrict teachers from endorsing their own replies
        if (target.reply_user_id === teacherId) {
            await conn.rollback();
            return res.status(403).json({ error: 'Teachers cannot endorse their own replies.' });
        }

        const willEndorse = target.is_endorsed ? 0 : 1;

        if (willEndorse === 1) {
            // Find any existing endorsed reply in this forum and revoke its bonus
            const [prevEndorsed] = await conn.execute(`
                SELECT reply_id FROM forum_replies
                WHERE topic_id = ? AND is_endorsed = 1 AND reply_id != ?
            `, [target.forum_id, replyId]);

            for (const prev of prevEndorsed) {
                await forumExpService.revokeEndorsementExp(conn, prev.reply_id);
            }

            // Award endorsement bonus to the new target reply
            await forumExpService.awardEndorsementExp(conn, replyId);
        } else {
            // Un-endorse and revoke bonus
            await forumExpService.revokeEndorsementExp(conn, replyId);
        }

        await conn.commit();

        // Dispatch in-app notification to reply author
        if (willEndorse === 1 && target.reply_user_id && target.reply_user_id !== teacherId) {
            notificationService.dispatch({
                recipientIds: target.reply_user_id,
                actorId: teacherId,
                role: 'Student',
                category: 'forum',
                priority: 'normal',
                eventType: 'reply_endorsed',
                title: '⭐ Reply Endorsed by Instructor',
                message: `Your answer on "${target.topic_title || 'forum discussion'}" was officially endorsed as the solution!`,
                targetUrl: `/forums/view/${target.forum_id}#reply-${replyId}`,
                metadata: { forum_id: target.forum_id, reply_id: replyId }
            }).catch(e => console.error('[Notif] Endorse reply notification error:', e));
        }

        res.json({ success: true, is_endorsed: willEndorse === 1 });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error('❌ [PATCH /teacher/api/forum/reply/:replyId/endorse]', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/api/forum/reply/:replyId/reveal', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { justification } = req.body;
    const replyId = parseInt(req.params.replyId, 10);

    if (!justification || justification.trim().length < 5) {
        return res.status(400).json({ error: 'A justification of at least 5 characters is required to reveal student identity.' });
    }

    try {
        const [rows] = await db.execute(`
            SELECT fr.reply_id, fr.user_id, fr.is_anonymous, ft.teacher_id,
                   u.first_name, u.last_name, u.profile_pic
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.reply_id = ?
        `, [replyId]);

        if (!rows.length) return res.status(404).json({ error: 'Reply not found.' });
        const reply = rows[0];

        if (!reply.is_anonymous) {
            return res.status(400).json({ error: 'This reply is not anonymous.' });
        }

        if (reply.teacher_id !== teacherId) {
            return res.status(403).json({ error: 'Access denied. You do not own this forum thread.' });
        }

        // Insert audit trail log
        await db.execute(`
            INSERT INTO forum_unmask_logs (unmasker_id, unmasker_role, target_reply_id, justification)
            VALUES (?, 'teacher', ?, ?)
        `, [teacherId, replyId, justification.trim()]);

        res.json({
            success: true,
            real_name: `${reply.first_name} ${reply.last_name}`,
            user_id: reply.user_id,
            profile_pic: reply.profile_pic || 'default_avatar.png'
        });

    } catch (err) {
        console.error('❌ [POST /teacher/api/forum/reply/:replyId/reveal]', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/forum/reply/:replyId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { replyId } = req.params;
    try {
        // Allow teacher to delete any reply in their own forums
        const [replyRow] = await db.execute(`
            SELECT fr.reply_id, fr.file_path, fr.is_locked, fr.is_endorsed, ft.teacher_id AS forum_teacher_id
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            WHERE fr.reply_id = ?`,
            [replyId]
        );

        if (!replyRow.length) return res.status(404).json({ error: 'Reply not found.' });
        if (replyRow[0].is_locked || replyRow[0].is_endorsed) {
            return res.status(403).json({ error: 'This reply is locked as an instructor-endorsed answer. Remove endorsement before deleting.' });
        }

        if (!replyRow.length) return res.status(404).json({ error: 'Reply not found.' });
        if (replyRow[0].forum_teacher_id !== teacherId) {
            return res.status(403).json({ error: 'Access denied. This reply belongs to a forum you do not own.' });
        }

        // Delete physical file if it exists
        if (replyRow[0].file_path) {
            const fileFull = path.join(__dirname, '../files', replyRow[0].file_path);
            if (fs.existsSync(fileFull)) fs.unlinkSync(fileFull);
        }

        // CASCADE delete is handled by FK constraint (parent_reply_id ON DELETE CASCADE)
        await db.execute(`DELETE FROM forum_replies WHERE reply_id = ?`, [replyId]);

        res.json({ success: true });

    } catch (err) {
        console.error('❌ [DELETE /teacher/api/forum/reply/:replyId]', err);
        res.status(500).json({ error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/:forumId/topics — Search & Filter Discussion Topics
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/:forumId/topics', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const forumId = parseInt(req.params.forumId, 10);
    const { search = '', filter = 'all' } = req.query;

    if (isNaN(forumId)) return res.status(400).json({ success: false, error: 'Invalid forum ID' });

    try {
        let query = `
            SELECT fr.*,
                   u.first_name, u.last_name, u.profile_pic, u.role, u.top_contributor,
                   (SELECT COUNT(*) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS reply_count,
                   (SELECT MAX(c.created_at) FROM forum_replies c WHERE c.parent_reply_id = fr.reply_id) AS last_reply_at,
                   (SELECT CONCAT(u2.first_name, ' ', u2.last_name)
                    FROM forum_replies c2
                    JOIN users u2 ON c2.user_id = u2.user_id
                    WHERE c2.parent_reply_id = fr.reply_id
                    ORDER BY c2.created_at DESC LIMIT 1) AS last_reply_user_name,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS vote_count,
                   (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked,
                   (SELECT COUNT(*) FROM forum_reports rep WHERE rep.reply_id = fr.reply_id AND rep.status = 'pending') AS report_count,
                   EXISTS(SELECT 1 FROM forum_reply_stars frs WHERE frs.reply_id = fr.reply_id AND frs.user_id = ?) AS is_starred
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ? AND fr.parent_reply_id IS NULL
        `;
        const params = [teacherId, teacherId, forumId];

        if (search.trim()) {
            query += ` AND (fr.reply_title LIKE ? OR fr.reply_content LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s);
        }

        if (filter === 'endorsed') {
            query += ` AND fr.is_endorsed = 1`;
        } else if (filter === 'unresolved') {
            query += ` AND fr.is_endorsed = 0`;
        } else if (filter === 'reported') {
            query += ` AND (SELECT COUNT(*) FROM forum_reports rep WHERE rep.reply_id = fr.reply_id AND rep.status = 'pending') > 0`;
        } else if (filter === 'starred') {
            query += ` AND EXISTS(SELECT 1 FROM forum_reply_stars frs WHERE frs.reply_id = fr.reply_id AND frs.user_id = ?)`;
            params.push(teacherId);
        }

        query += ` ORDER BY fr.is_endorsed DESC, fr.created_at DESC`;

        const [topics] = await db.execute(query, params);

        topics.forEach(d => {
            if (d.is_anonymous && d.role === 'Student') {
                if (d.is_unmasked > 0) {
                    d.author_name = `${d.first_name} ${d.last_name} (Unmasked)`;
                    d.unmasked = true;
                    d.author_pic = d.profile_pic || 'default_avatar.png';
                } else {
                    d.author_name = 'Anonymous Student';
                    d.unmasked = false;
                    d.author_pic = 'default_avatar.png';
                }
            } else {
                d.author_name = `${d.first_name} ${d.last_name}`;
                d.unmasked = false;
                d.author_pic = d.profile_pic || 'default_avatar.png';
            }
        });

        res.json({ success: true, topics });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/:forumId/topics]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/:forumId/roster — Live Cohort Completion Roster
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/:forumId/roster', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const forumId = parseInt(req.params.forumId, 10);
    if (isNaN(forumId)) return res.status(400).json({ success: false, error: 'Invalid forum ID' });

    try {
        const [forumRows] = await db.execute(`
            SELECT subject_id FROM forum_topics WHERE forum_id = ? LIMIT 1
        `, [forumId]);
        if (!forumRows.length) return res.status(404).json({ success: false, error: 'Forum not found' });

        const [enrolledStudents] = await db.execute(`
            SELECT DISTINCT
                u.user_id AS student_id,
                u.first_name, u.last_name, u.profile_pic, u.email,
                (SELECT sfd.done_at FROM student_forum_done sfd WHERE sfd.forum_id = ? AND sfd.student_id = u.user_id LIMIT 1) AS done_at,
                EXISTS(SELECT 1 FROM student_forum_done sfd WHERE sfd.forum_id = ? AND sfd.student_id = u.user_id) AS is_done,
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ? AND fr.user_id = u.user_id) AS contributions_count
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE c.subject_id = ? AND u.role = 'Student'
            ORDER BY is_done DESC, u.last_name ASC, u.first_name ASC
        `, [forumId, forumId, forumId, forumRows[0].subject_id]);

        const enrolledCount = enrolledStudents.length;
        const doneCount = enrolledStudents.filter(s => s.is_done).length;
        const completionRate = enrolledCount > 0 ? Math.round((doneCount / enrolledCount) * 100) : 0;

        res.json({
            success: true,
            enrolledStudents,
            stats: {
                enrolled_count: enrolledCount,
                done_count: doneCount,
                completion_rate: completionRate
            }
        });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/:forumId/roster]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/discussion/:replyId — Thread Reader Data (Tree & Files)
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/discussion/:replyId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const replyId = parseInt(req.params.replyId, 10);
    if (isNaN(replyId)) return res.status(400).json({ success: false, error: 'Invalid reply ID' });

    try {
        const [rootRows] = await db.execute(`
            SELECT fr.*,
                   ft.title AS forum_title,
                   s.subject_name,
                   u.first_name, u.last_name, u.profile_pic, u.role, u.top_contributor,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS like_count,
                   EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.user_id = ?) AS user_liked,
                   (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            JOIN subjects s ON ft.subject_id = s.subject_id
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.reply_id = ?
        `, [teacherId, teacherId, replyId]);

        if (!rootRows.length) return res.status(404).json({ success: false, error: 'Discussion not found' });

        const rootRow = rootRows[0];
        const isAnon = Boolean(rootRow.is_anonymous && rootRow.role === 'Student');
        const isUnmasked = rootRow.is_unmasked > 0;

        const rootTopic = {
            reply_id: rootRow.reply_id,
            topic_id: rootRow.topic_id,
            forum_title: rootRow.forum_title,
            subject_name: rootRow.subject_name,
            reply_title: rootRow.reply_title || rootRow.forum_title,
            reply_content: rootRow.reply_content,
            author_id: rootRow.user_id,
            author_name: isAnon
                ? (isUnmasked ? `${rootRow.first_name} ${rootRow.last_name} (Unmasked)` : 'Anonymous Student')
                : `${rootRow.first_name} ${rootRow.last_name}`,
            author_pic: isAnon
                ? (isUnmasked ? (rootRow.profile_pic || 'default_avatar.png') : 'default_avatar.png')
                : (rootRow.profile_pic || 'default_avatar.png'),
            author_role: rootRow.role,
            is_anonymous: isAnon,
            is_unmasked: isUnmasked,
            can_unmask: isAnon && !isUnmasked,
            is_endorsed: !!rootRow.is_endorsed,
            is_locked: !!rootRow.is_locked,
            created_at: rootRow.created_at,
            file_path: rootRow.file_path,
            file_name: rootRow.file_name,
            file_type: rootRow.file_type,
            external_link: rootRow.external_link,
            like_count: rootRow.like_count || 0,
            user_liked: !!rootRow.user_liked
        };

        // Fetch sub-replies
        const [subRows] = await db.execute(`
            SELECT fr.*,
                   u.first_name, u.last_name, u.profile_pic, u.role, u.top_contributor,
                   (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS like_count,
                   EXISTS(SELECT 1 FROM reply_votes rv WHERE rv.reply_id = fr.reply_id AND rv.user_id = ?) AS user_liked,
                   (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id AND ful.unmasker_id = ?) AS is_unmasked,
                   (SELECT COUNT(*) FROM forum_reports rep WHERE rep.reply_id = fr.reply_id AND rep.status = 'pending') AS report_count
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE (fr.parent_reply_id = ? OR fr.parent_reply_id IN (
                SELECT r2.reply_id FROM forum_replies r2 WHERE r2.parent_reply_id = ?
            ))
            ORDER BY fr.is_endorsed DESC, fr.created_at ASC
        `, [teacherId, teacherId, replyId, replyId]);

        const subReplies = subRows.map(r => {
            const subIsAnon = Boolean(r.is_anonymous && r.role === 'Student');
            const subIsUnmasked = r.is_unmasked > 0;
            return {
                reply_id: r.reply_id,
                parent_reply_id: r.parent_reply_id,
                reply_content: r.reply_content,
                created_at: r.created_at,
                file_path: r.file_path,
                file_name: r.file_name,
                file_type: r.file_type,
                external_link: r.external_link,
                is_endorsed: !!r.is_endorsed,
                is_locked: !!r.is_locked,
                is_anonymous: subIsAnon,
                is_unmasked: subIsUnmasked,
                can_unmask: subIsAnon && !subIsUnmasked,
                user_id: r.user_id,
                user_name: subIsAnon
                    ? (subIsUnmasked ? `${r.first_name} ${r.last_name} (Unmasked)` : 'Anonymous Student')
                    : `${r.first_name} ${r.last_name}`,
                profile_pic: subIsAnon
                    ? (subIsUnmasked ? (r.profile_pic || 'default_avatar.png') : 'default_avatar.png')
                    : (r.profile_pic || 'default_avatar.png'),
                role: r.role,
                like_count: r.like_count || 0,
                user_liked: !!r.user_liked,
                report_count: r.report_count || 0
            };
        });

        // Collect files & media
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

        // Collect distinct contributors
        const contributorMap = new Map();
        if (rootTopic.author_id) {
            contributorMap.set(rootTopic.author_id, {
                user_id: rootTopic.author_id,
                name: rootTopic.author_name,
                avatar: rootTopic.author_pic,
                role: rootTopic.author_role
            });
        }
        subReplies.forEach(r => {
            if (!contributorMap.has(r.user_id)) {
                contributorMap.set(r.user_id, {
                    user_id: r.user_id,
                    name: r.user_name,
                    avatar: r.profile_pic,
                    role: r.role
                });
            }
        });
        const contributors = Array.from(contributorMap.values());

        // Fetch any reports for these replies
        const replyIds = [rootTopic.reply_id, ...subReplies.map(r => r.reply_id)];
        let reports = [];
        if (replyIds.length) {
            const placeholders = replyIds.map(() => '?').join(',');
            const [reportRows] = await db.execute(`
                SELECT rep.*, u.first_name AS reporter_first, u.last_name AS reporter_last
                FROM forum_reports rep
                JOIN users u ON rep.reporter_id = u.user_id
                WHERE rep.reply_id IN (${placeholders})
                ORDER BY rep.created_at DESC
            `, replyIds);
            reports = reportRows.map(rp => ({
                report_id: rp.report_id,
                reply_id: rp.reply_id,
                reason: rp.reason,
                details: rp.details,
                status: rp.status,
                reporter_name: `${rp.reporter_first} ${rp.reporter_last}`,
                created_at: rp.created_at
            }));
        }

        res.json({
            success: true,
            rootTopic,
            subReplies,
            files,
            contributors,
            reports
        });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/discussion/:replyId]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum-discussion-topic — Teacher Creates Discussion Topic
// ════════════════════════════════════════════════════════════════════════════
const handleTeacherDiscussionTopic = (req, res) => {
    forumUpload.fields([
        { name: 'forum_file', maxCount: 1 },
        { name: 'file', maxCount: 1 },
        { name: 'reply_file', maxCount: 1 },
        { name: 'attachment', maxCount: 1 }
    ])(req, res, async (err) => {
        if (err) {
            console.error('❌ [TEACHER DISCUSSION TOPIC] Multer error:', err);
            return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
        }

        const teacherId = req.user.user_id;
        const { forum_id, reply_title, reply_content, external_link } = req.body;
        const title = (reply_title || '').trim();
        const content = (reply_content || '').trim();

        if (!title || !content) {
            return res.status(400).json({ success: false, error: 'Title and content are required.' });
        }

        const safeForumId = parseInt(forum_id, 10);
        if (isNaN(safeForumId)) {
            return res.status(400).json({ success: false, error: 'Valid forum_id is required.' });
        }

        const file = req.files ? (
            req.files['forum_file']?.[0] ||
            req.files['file']?.[0] ||
            req.files['reply_file']?.[0] ||
            req.files['attachment']?.[0]
        ) : req.file;
        const filePath = file ? file.filename : null;
        const fileName = file ? file.originalname : null;
        const fileType = file ? file.mimetype : null;
        const extLink = (external_link || '').trim() || null;

        try {
            // Verify teacher owns the forum or teaches the subject
            const [chk] = await db.execute(`
                SELECT ft.forum_id, ft.title, ft.subject_id
                FROM forum_topics ft
                WHERE ft.forum_id = ?
                  AND (ft.teacher_id = ? OR EXISTS (
                      SELECT 1 FROM classes c WHERE c.subject_id = ft.subject_id AND c.teacher_id = ?
                  ))
                LIMIT 1
            `, [safeForumId, teacherId, teacherId]);

            if (!chk.length) {
                return res.status(403).json({ success: false, error: 'You do not have permission to post in this forum.' });
            }

            const forumRow = chk[0];

            const [result] = await db.execute(`
                INSERT INTO forum_replies
                    (topic_id, user_id, is_anonymous, parent_reply_id, reply_title, reply_content,
                     file_path, file_name, file_type, external_link, created_at)
                VALUES (?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, NOW())
            `, [safeForumId, teacherId, title, content, filePath, fileName, fileType, extLink]);

            // Dispatch notification to enrolled students
            try {
                const [enrolled] = await db.execute(`
                    SELECT DISTINCT cs.student_id
                    FROM class_students cs
                    JOIN classes c ON cs.class_id = c.class_id
                    WHERE c.subject_id = ?
                `, [forumRow.subject_id]);

                const studentIds = enrolled.map(s => s.student_id);
                if (studentIds.length) {
                    const senderName = `${req.user.first_name || 'Prof.'} ${req.user.last_name || ''}`.trim();
                    const snippet = title.length > 70 ? title.substring(0, 67) + '...' : title;
                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: teacherId,
                        role: 'Student',
                        category: 'forum',
                        priority: 'high',
                        eventType: 'forum_topic_created',
                        title: `New Discussion from ${senderName}`,
                        message: `Instructor posted: "${snippet}" in ${forumRow.title}`,
                        targetUrl: `/forums/view/${safeForumId}#reply-${result.insertId}`,
                        metadata: { forumId: safeForumId, replyId: result.insertId }
                    });
                }
            } catch (notifErr) {
                console.error('[Teacher Topic Notification Error]', notifErr.message);
            }

            res.json({ success: true, reply_id: result.insertId });

        } catch (dbErr) {
            console.error('❌ [TEACHER DISCUSSION TOPIC ERROR]', dbErr);
            res.status(500).json({ success: false, error: dbErr.message });
        }
    });
};

router.post('/api/forum-discussion-topic', isTeacher, handleTeacherDiscussionTopic);
router.post('/api/forum/discussion-topic', isTeacher, handleTeacherDiscussionTopic);


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum-subreply — Teacher Nested Reply
// ════════════════════════════════════════════════════════════════════════════
const handleTeacherSubreply = (req, res) => {
    forumUpload.fields([
        { name: 'forum_file', maxCount: 1 },
        { name: 'file', maxCount: 1 },
        { name: 'reply_file', maxCount: 1 },
        { name: 'attachment', maxCount: 1 }
    ])(req, res, async (err) => {
        if (err) {
            console.error('❌ [TEACHER SUBREPLY] Multer error:', err);
            return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
        }

        const teacherId = req.user.user_id;
        const { forum_id, parent_reply_id, reply_content, external_link } = req.body;
        const content = (reply_content || '').trim();

        if (!content) {
            return res.status(400).json({ success: false, error: 'Reply content cannot be empty.' });
        }

        const safeForumId = parseInt(forum_id, 10);
        const safeParentId = parent_reply_id ? parseInt(parent_reply_id, 10) : null;
        if (isNaN(safeForumId)) {
            return res.status(400).json({ success: false, error: 'Valid forum_id is required.' });
        }

        const file = req.files ? (
            req.files['forum_file']?.[0] ||
            req.files['file']?.[0] ||
            req.files['reply_file']?.[0] ||
            req.files['attachment']?.[0]
        ) : req.file;
        const filePath = file ? file.filename : null;
        const fileName = file ? file.originalname : null;
        const fileType = file ? file.mimetype : null;
        const extLink = (external_link || '').trim() || null;

        try {
            // Verify parent reply belongs to this forum if provided
            if (safeParentId) {
                const [parentChk] = await db.execute(
                    `SELECT reply_id, user_id FROM forum_replies WHERE reply_id = ? AND topic_id = ? LIMIT 1`,
                    [safeParentId, safeForumId]
                );
                if (!parentChk.length) return res.status(400).json({ success: false, error: 'Invalid parent reply.' });
            }

            const [result] = await db.execute(`
                INSERT INTO forum_replies
                    (topic_id, user_id, is_anonymous, parent_reply_id, reply_content,
                     file_path, file_name, file_type, external_link, created_at)
                VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, NOW())
            `, [safeForumId, teacherId, safeParentId, content, filePath, fileName, fileType, extLink]);

            // Dispatch notification
            try {
                const senderName = `${req.user.first_name || 'Prof.'} ${req.user.last_name || ''}`.trim();
                const [[topicRow]] = await db.execute(`SELECT title, subject_id FROM forum_topics WHERE forum_id = ? LIMIT 1`, [safeForumId]);
                const topicTitle = topicRow ? topicRow.title : 'Discussion Thread';
                const snippet = content.length > 80 ? content.substring(0, 77) + '...' : content;

                if (safeParentId) {
                    const [[parentRow]] = await db.execute(`SELECT user_id FROM forum_replies WHERE reply_id = ? LIMIT 1`, [safeParentId]);
                    if (parentRow && parentRow.user_id && parentRow.user_id !== teacherId) {
                        const [[authorRow]] = await db.execute(`SELECT role FROM users WHERE user_id = ? LIMIT 1`, [parentRow.user_id]);
                        const recipientRole = authorRow?.role || 'Student';
                        await notificationService.dispatch({
                            recipientIds: parentRow.user_id,
                            actorId: teacherId,
                            role: recipientRole,
                            category: 'forum',
                            priority: 'high',
                            eventType: 'forum_reply_received',
                            title: `Instructor Reply in "${topicTitle}"`,
                            message: `${senderName}: "${snippet}"`,
                            targetUrl: recipientRole === 'Teacher' ? `/teacher/forums/view/${safeForumId}#reply-${result.insertId}` : `/forums/view/${safeForumId}#reply-${result.insertId}`,
                            metadata: { forumId: safeForumId, replyId: result.insertId }
                        });
                    }
                }
            } catch (notifErr) {
                console.error('[Teacher Subreply Notification Error]', notifErr.message);
            }

            res.json({ success: true, reply_id: result.insertId });

        } catch (dbErr) {
            console.error('❌ [TEACHER SUBREPLY ERROR]', dbErr);
            res.status(500).json({ success: false, error: dbErr.message });
        }
    });
};

router.post('/api/forum-subreply', isTeacher, handleTeacherSubreply);
router.post('/api/forum/subreply', isTeacher, handleTeacherSubreply);


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/repository-files — Subject/Topic Learning Materials
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/repository-files', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { subject_id, topic_id } = req.query;

    try {
        let materials = [];
        if (topic_id && !isNaN(topic_id)) {
            const [rows] = await db.execute(`
                SELECT material_id, title, file_path_or_url, material_type
                FROM learning_materials
                WHERE topic_id = ?
                ORDER BY title ASC
            `, [topic_id]);
            materials = rows;
        } else if (subject_id && !isNaN(subject_id)) {
            const [rows] = await db.execute(`
                SELECT lm.material_id, lm.title, lm.file_path_or_url, lm.material_type
                FROM learning_materials lm
                JOIN topics t ON lm.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE q.subject_id = ?
                ORDER BY lm.title ASC
            `, [subject_id]);
            materials = rows;
        } else {
            const [rows] = await db.execute(`
                SELECT lm.material_id, lm.title, lm.file_path_or_url, lm.material_type
                FROM learning_materials lm
                JOIN topics t ON lm.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ORDER BY lm.title ASC
                LIMIT 50
            `, [teacherId]);
            materials = rows;
        }

        res.json({ success: true, materials });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/repository-files]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum-reply/:replyId/star — Teacher Bookmark Discussion
// ════════════════════════════════════════════════════════════════════════════
const handleTeacherStarReply = async (req, res) => {
    const teacherId = req.user.user_id;
    const replyId = parseInt(req.params.replyId, 10);
    if (isNaN(replyId)) return res.status(400).json({ success: false, error: 'Invalid reply ID' });

    try {
        const [existing] = await db.execute(
            'SELECT star_id FROM forum_reply_stars WHERE reply_id = ? AND user_id = ?',
            [replyId, teacherId]
        );

        let is_starred = false;
        if (existing.length > 0) {
            await db.execute('DELETE FROM forum_reply_stars WHERE star_id = ?', [existing[0].star_id]);
            is_starred = false;
        } else {
            await db.execute('INSERT INTO forum_reply_stars (user_id, reply_id, created_at) VALUES (?, ?, NOW())', [teacherId, replyId]);
            is_starred = true;
        }

        res.json({ success: true, is_starred });
    } catch (err) {
        console.error('❌ [POST /teacher/api/forum/reply/:replyId/star]', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

router.post('/api/forum-reply/:replyId/star', isTeacher, handleTeacherStarReply);
router.post('/api/forum/reply/:replyId/star', isTeacher, handleTeacherStarReply);


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum/report/:reportId/status — Moderate / Resolve Report
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/forum/report/:reportId/status', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const reportId = parseInt(req.params.reportId, 10);
    const { status } = req.body;
    const allowed = ['reviewed', 'dismissed', 'actioned'];

    if (isNaN(reportId) || !allowed.includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid report ID or status.' });
    }

    try {
        // Verify teacher owns the forum this report belongs to
        const [chk] = await db.execute(`
            SELECT rep.report_id, ft.teacher_id, ft.subject_id
            FROM forum_reports rep
            JOIN forum_replies fr ON rep.reply_id = fr.reply_id
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            WHERE rep.report_id = ?
              AND (ft.teacher_id = ? OR EXISTS (
                  SELECT 1 FROM classes c WHERE c.subject_id = ft.subject_id AND c.teacher_id = ?
              ))
            LIMIT 1
        `, [reportId, teacherId, teacherId]);

        if (!chk.length) {
            return res.status(403).json({ success: false, error: 'You do not have permission to moderate this report.' });
        }

        await db.execute(`UPDATE forum_reports SET status = ? WHERE report_id = ?`, [status, reportId]);

        res.json({ success: true, status });

    } catch (err) {
        console.error('❌ [POST /teacher/api/forum/report/:reportId/status]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});



// ════════════════════════════════════════════════════════════════════════════
// ANALYSIS PAGE ROUTES
// Entry point: /teacher/analysis/:attemptId  (attemptId = student_scores.score_id)
// ════════════════════════════════════════════════════════════════════════════

// ── Multer for analysis material uploads ────────────────────────────────────
const analysisUploadDir = path.join(__dirname, '../material_uploads');
if (!fs.existsSync(analysisUploadDir)) fs.mkdirSync(analysisUploadDir, { recursive: true });

const analysisUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, analysisUploadDir),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
    }),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => {
        const allowed = /pdf|msword|vnd\.openxmlformats|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument|image\/(png|jpeg|jpg)/;
        cb(null, allowed.test(file.mimetype));
    }
});


// ── GET /teacher/analysis/:attemptId — Main page ───────────────────────────
router.get('/analysis/:attemptId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const attemptId = req.params.attemptId;
    const studentId = req.query.student_id ? parseInt(req.query.student_id, 10) : null;

    try {
        // Check if session is a Versus match in elementa_game_sessions
        const [versusSessionRows] = await db.execute(`
            SELECT 
                egs.*,
                u1.first_name AS p1_first_name, u1.last_name AS p1_last_name, u1.profile_pic AS p1_pic,
                u2.first_name AS p2_first_name, u2.last_name AS p2_last_name, u2.profile_pic AS p2_pic,
                a.assessment_name, a.topic_id, COALESCE(a.total_items, 3) AS assessment_total_items,
                t.topic_name,
                q.quarter_number,
                s.subject_name
            FROM elementa_game_sessions egs
            JOIN users u1 ON egs.student_id_p1 = u1.user_id
            LEFT JOIN users u2 ON egs.student_id_p2 = u2.user_id
            LEFT JOIN assessments a ON egs.assessment_id = a.assessment_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN subjects s ON q.subject_id = s.subject_id
            WHERE egs.session_id = ?
        `, [attemptId]);

        const isVersus = Boolean(
            versusSessionRows.length > 0 &&
            (versusSessionRows[0].play_mode === 'Versus' || (versusSessionRows[0].student_id_p2 && versusSessionRows[0].student_id_p2 > 0))
        );

        let attempt;

        if (isVersus) {
            const vsSess = versusSessionRows[0];

            // Fetch EXP and grade stats for both players
            const [p1ScoreRows] = await db.query('SELECT exp_gained FROM student_scores WHERE assessment_id = ? AND student_id = ? LIMIT 1', [vsSess.assessment_id, vsSess.student_id_p1]);
            const [p2ScoreRows] = await db.query('SELECT exp_gained FROM student_scores WHERE assessment_id = ? AND student_id = ? LIMIT 1', [vsSess.assessment_id, vsSess.student_id_p2]);
            const p1Exp = p1ScoreRows.length ? p1ScoreRows[0].exp_gained : 300;
            const p2Exp = p2ScoreRows.length ? p2ScoreRows[0].exp_gained : 300;

            const [p1GradeRows] = await db.query('SELECT * FROM elementa_student_grades WHERE session_id = ? AND student_id = ? LIMIT 1', [attemptId, vsSess.student_id_p1]);
            const [p2GradeRows] = await db.query('SELECT * FROM elementa_student_grades WHERE session_id = ? AND student_id = ? LIMIT 1', [attemptId, vsSess.student_id_p2]);
            const p1Grade = p1GradeRows.length ? p1GradeRows[0] : {};
            const p2Grade = p2GradeRows.length ? p2GradeRows[0] : {};

            const totalItems = vsSess.assessment_total_items || 3;
            const p1Score = vsSess.final_score_p1 !== null ? vsSess.final_score_p1 : (p1Grade.points_earned || 0);
            const p2Score = vsSess.final_score_p2 !== null ? vsSess.final_score_p2 : (p2Grade.points_earned || 0);

            let winner = vsSess.winner;
            if (!winner || winner === '0') {
                if (p1Score > p2Score) winner = 'P1';
                else if (p2Score > p1Score) winner = 'P2';
                else winner = 'Tie';
            }

            attempt = {
                score_id: vsSess.session_id,
                session_id: vsSess.session_id,
                is_versus: true,
                assessment_id: vsSess.assessment_id,
                assessment_name: vsSess.assessment_name || 'Try DUAL Game',
                assessment_type: '2-Player Versus Battle',
                topic_id: vsSess.topic_id,
                topic_name: vsSess.topic_name || 'Scientific Measurement',
                quarter_number: vsSess.quarter_number || 1,
                subject_name: vsSess.subject_name || 'Chemistry',
                date_recorded: vsSess.ended_at || vsSess.started_at,
                total_items: totalItems,
                total_duration_s: vsSess.total_duration_s,
                winner: winner,

                // Base fallback properties for compatibility
                student_id: vsSess.student_id_p1,
                first_name: vsSess.p1_first_name,
                last_name: vsSess.p1_last_name,
                student_pic: vsSess.p1_pic,
                score_obtained: p1Score,
                exp_gained: p1Exp,

                // Player 1 Details
                p1: {
                    student_id: vsSess.student_id_p1,
                    first_name: vsSess.p1_first_name,
                    last_name: vsSess.p1_last_name,
                    student_pic: vsSess.p1_pic,
                    score: p1Score,
                    exp: p1Exp,
                    accuracy: totalItems > 0 ? Math.round((p1Score / totalItems) * 100) : 0,
                    avg_time_s: p1Grade.avg_response_time_s ? Number(p1Grade.avg_response_time_s).toFixed(1) : null
                },

                // Player 2 Details
                p2: {
                    student_id: vsSess.student_id_p2,
                    first_name: vsSess.p2_first_name,
                    last_name: vsSess.p2_last_name,
                    student_pic: vsSess.p2_pic,
                    score: p2Score,
                    exp: p2Exp,
                    accuracy: totalItems > 0 ? Math.round((p2Score / totalItems) * 100) : 0,
                    avg_time_s: p2Grade.avg_response_time_s ? Number(p2Grade.avg_response_time_s).toFixed(1) : null
                }
            };
        } else {
            // Standard Individual Attempt
            const queryParams = [attemptId];
            let studentCondition = '';
            if (studentId) {
                studentCondition = ' AND esg.student_id = ? ';
                queryParams.push(studentId);
            }
            queryParams.push(teacherId);

            const [attemptRows] = await db.execute(`
                SELECT
                    esg.session_id AS score_id, esg.student_id, esg.assessment_id,
                    esg.points_earned AS score_obtained, esg.points_possible AS total_items,
                    esg.points_earned AS exp_gained, esg.started_at AS date_recorded,
                    u.first_name, u.last_name,
                    u.profile_pic AS student_pic,
                    COALESCE(a.assessment_name, CONCAT('Level ', esg.assessment_number, ': ', esg.level_topic)) AS assessment_name,
                    COALESCE(a.assessment_type, esg.play_mode) AS assessment_type,
                    a.topic_id,
                    COALESCE(t.topic_name, esg.level_topic) AS topic_name,
                    COALESCE(q.quarter_number, 1) AS quarter_number,
                    COALESCE(s.subject_name, 'Chemistry') AS subject_name
                FROM elementa_student_grades esg
                JOIN users u ON esg.student_id = u.user_id
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                LEFT JOIN assessments a ON esg.assessment_id = a.assessment_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                LEFT JOIN subjects s ON q.subject_id = s.subject_id
                WHERE esg.session_id = ? ${studentCondition} AND c.teacher_id = ?
                LIMIT 1`, queryParams);

            if (!attemptRows.length) return res.status(404).send('Attempt not found or access denied.');
            attempt = attemptRows[0];
            attempt.is_versus = false;
            attempt.p1 = {
                student_id: attempt.student_id,
                first_name: attempt.first_name,
                last_name: attempt.last_name,
                student_pic: attempt.student_pic,
                score: attempt.score_obtained,
                exp: attempt.exp_gained,
                accuracy: attempt.total_items > 0 ? Math.round((attempt.score_obtained / attempt.total_items) * 100) : 0,
                avg_time_s: null
            };
            attempt.p2 = null;
        }

        // 2. Item performance — success rate, avg time, option popularity (Feature 1)
        const [questions] = await db.execute(`
            SELECT
                eq.question_id,
                COALESCE(eq.prompt, eca.question_snapshot, 'Arcade Question') AS question_text,
                eq.difficulty,
                'Arcade' AS input_mode,
                eca.machine_used AS mechanic_type,
                NULL AS option_a, NULL AS option_b, NULL AS option_c, NULL AS option_d,
                COALESCE(eq.answer_text, eca.correct_answer) AS correct_answer,
                COUNT(eca.attempt_id)                          AS total_responses,
                SUM(eca.is_correct = 1)                         AS correct_count,
                SUM(eca.is_correct = 0)                         AS wrong_count,
                AVG(eca.response_time_s * 1000)                AS avg_response_ms,
                0 AS pick_a, 0 AS pick_b, 0 AS pick_c, 0 AS pick_d,
                NULL AS rem_id, NULL AS rem_material_id,
                NULL AS rem_advice, NULL AS rem_link_url,
                NULL AS rem_preview_json, NULL AS rem_material_title
            FROM elementa_customer_attempts eca
            JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
            LEFT JOIN elementa_questions eq ON eca.question_id = eq.question_id
            WHERE elr.session_id = ?
            GROUP BY
                eq.question_id, question_text, eq.difficulty, eca.machine_used,
                correct_answer
            ORDER BY SUM(eca.is_correct = 1) / NULLIF(COUNT(eca.attempt_id), 0) ASC`,
            [attemptId]);

        // 3. Student drilldown responses with player_number partitioning (Feature 4)
        const [rawResponses] = await db.execute(`
            SELECT
                eca.attempt_id AS response_id,
                COALESCE(elr.player_number, 1) AS player_number,
                eca.player_answer AS selected_option,
                eca.is_correct,
                (eca.response_time_s * 1000) AS response_time_ms,
                COALESCE(eq.prompt, eca.question_snapshot, 'Arcade Question') AS question_text,
                COALESCE(eq.answer_text, eca.correct_answer) AS correct_answer,
                eq.question_id,
                eca.machine_used,
                NULL AS rem_id, NULL AS rem_material_id,
                NULL AS rem_advice, NULL AS rem_link_url,
                NULL AS interaction_type
            FROM elementa_customer_attempts eca
            JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
            LEFT JOIN elementa_questions eq ON eca.question_id = eq.question_id
            WHERE elr.session_id = ?
            ORDER BY elr.player_number ASC, eca.attempt_id ASC`, [attemptId]);

        let p1_responses = [];
        let p2_responses = [];

        if (isVersus) {
            p1_responses = rawResponses.filter(r => r.player_number === 1);
            p2_responses = rawResponses.filter(r => r.player_number === 2);
        } else {
            p1_responses = rawResponses;
            p2_responses = [];
        }
        const responses = rawResponses;

        // 4. Available materials for picker (Feature 2)
        const [materials] = await db.execute(`
            SELECT material_id, title, material_type
            FROM learning_materials
            WHERE topic_id = ?
            ORDER BY title ASC`, [attempt.topic_id]);

        // 5. Automated insights (Feature 5)
        const insights = [];
        const totalQ = questions.length;
        const failedQ = questions.filter(q => q.total_responses > 0 && (q.correct_count / q.total_responses) < 0.5);
        const noRemQ = questions.filter(q => !q.rem_material_id && !q.rem_advice && !q.rem_link_url);

        if (failedQ.length > 0) {
            insights.push({
                type: 'warn',
                icon: 'triangle-exclamation',
                color: 'amber',
                title: `${failedQ.length} item(s) with high failure rate`,
                message: `Questions: ${failedQ.map((q, i) => '#' + (questions.indexOf(q) + 1)).join(', ')} — majority answered incorrectly. Add remediation materials for these items.`
            });
        }

        if (noRemQ.length > 0) {
            insights.push({
                type: 'warn',
                icon: 'circle-exclamation',
                color: 'amber',
                title: `${noRemQ.length} item(s) have no remediation set`,
                message: `Use the Remediation Suite tab to assign materials or advice for unanswered knowledge gaps.`
            });
        }

        if (isVersus) {
            if (attempt.winner === 'Tie' || attempt.winner === 'TIE') {
                insights.push({
                    type: 'ok',
                    icon: 'handshake',
                    color: 'blue',
                    title: 'Versus Match Draw',
                    message: `Both ${attempt.p1.first_name} and ${attempt.p2.first_name} achieved equal scores (${attempt.p1.score}/${attempt.total_items}).`
                });
            } else {
                const winnerName = attempt.winner === 'P1' ? `${attempt.p1.first_name} ${attempt.p1.last_name}` : `${attempt.p2.first_name} ${attempt.p2.last_name}`;
                insights.push({
                    type: 'ok',
                    icon: 'trophy',
                    color: 'green',
                    title: `${winnerName} Won the Duel`,
                    message: `Match concluded with a victory in ${attempt.total_duration_s ? Math.round(attempt.total_duration_s) + 's' : 'recorded match time'}.`
                });
            }

            // Head-to-Head Speed Telemetry Insight
            if (attempt.p1.avg_time_s && attempt.p2.avg_time_s) {
                const p1Time = parseFloat(attempt.p1.avg_time_s);
                const p2Time = parseFloat(attempt.p2.avg_time_s);
                const fasterName = p1Time < p2Time ? attempt.p1.first_name : attempt.p2.first_name;
                const diff = Math.abs(p1Time - p2Time).toFixed(1);
                insights.push({
                    type: 'info',
                    icon: 'stopwatch',
                    color: 'cyan',
                    title: 'Reaction Speed Telemetry',
                    message: `${fasterName} was faster by an average of ${diff}s per challenge (${attempt.p1.first_name}: ${attempt.p1.avg_time_s}s vs ${attempt.p2.first_name}: ${attempt.p2.avg_time_s}s).`
                });
            }
        } else {
            const accuracy = attempt.total_items > 0 ? (attempt.score_obtained / attempt.total_items) * 100 : 0;
            if (accuracy >= 80) {
                insights.push({
                    type: 'ok',
                    icon: 'trophy',
                    color: 'green',
                    title: 'Strong overall performance',
                    message: `This student scored ${Math.round(accuracy)}% — above the 80% mastery threshold. Keep monitoring for consistency across topics.`
                });
            }
        }

        res.render('teacher/analysis', {
            user: req.user,
            attempt,
            questions,
            responses,
            p1_responses,
            p2_responses,
            materials,
            insights
        });

    } catch (err) {
        console.error('❌ [GET /teacher/analysis/:attemptId]', err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/api/analysis/remediation', isTeacher, async (req, res) => {
    try {
        const { question_id, material_id, link_url, preview_json, advice_text } = req.body;
        if (!question_id) return res.status(400).json({ error: 'question_id required' });

        // Upsert: if rem entry exists for this question, update; otherwise insert
        const [existing] = await db.execute(
            `SELECT rem_id FROM remediation_materials WHERE question_id = ? LIMIT 1`,
            [question_id]
        );

        if (existing.length) {
            await db.execute(`
                UPDATE remediation_materials
                SET material_id  = COALESCE(?, material_id),
                    link_url     = COALESCE(?, link_url),
                    preview_json = COALESCE(?, preview_json),
                    advice_text  = COALESCE(?, advice_text)
                WHERE question_id = ?`,
                [material_id || null, link_url || null, preview_json || null, advice_text || null, question_id]
            );
        } else {
            await db.execute(`
                INSERT INTO remediation_materials (question_id, material_id, link_url, preview_json, advice_text)
                VALUES (?, ?, ?, ?, ?)`,
                [question_id, material_id || null, link_url || null, preview_json || null, advice_text || null]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ [POST /teacher/api/analysis/remediation]', err);
        res.status(500).json({ error: err.message });
    }
});


// ── POST /teacher/api/analysis/bulk-remediation — Apply to whole topic ───────
router.post('/api/analysis/bulk-remediation', isTeacher, async (req, res) => {
    try {
        const { topic_id, material_id, link_url, advice_text } = req.body;
        if (!topic_id) return res.status(400).json({ error: 'topic_id required' });
        if (!material_id && !link_url && !advice_text) return res.status(400).json({ error: 'Nothing to apply' });

        const [qRows] = await db.execute(
            `SELECT question_id FROM elementa_questions WHERE topic_id = ? AND is_active = 1`, [topic_id]
        );

        let count = 0;
        for (const row of qRows) {
            const [existing] = await db.execute(
                `SELECT rem_id FROM remediation_materials WHERE question_id = ? LIMIT 1`,
                [row.question_id]
            );

            if (existing.length) {
                // Only fill columns that are currently NULL (do not overwrite)
                await db.execute(`
                    UPDATE remediation_materials
                    SET material_id = IF(material_id IS NULL AND ? IS NOT NULL, ?, material_id),
                        link_url    = IF(link_url    IS NULL AND ? IS NOT NULL, ?, link_url),
                        advice_text = IF(advice_text IS NULL AND ? IS NOT NULL, ?, advice_text)
                    WHERE question_id = ?`,
                    [material_id, material_id, link_url, link_url, advice_text, advice_text, row.question_id]
                );
            } else {
                await db.execute(`
                    INSERT INTO remediation_materials (question_id, material_id, link_url, advice_text)
                    VALUES (?, ?, ?, ?)`,
                    [row.question_id, material_id || null, link_url || null, advice_text || null]
                );
            }
            count++;
        }

        res.json({ success: true, count });
    } catch (err) {
        console.error('❌ [POST /teacher/api/analysis/bulk-remediation]', err);
        res.status(500).json({ error: err.message });
    }
});


// ── POST /teacher/api/analysis/upload-material — Upload new file as material ─
router.post('/api/analysis/upload-material', isTeacher, analysisUpload.single('file'), async (req, res) => {
    try {
        const { topic_id, title } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        if (!topic_id) return res.status(400).json({ error: 'topic_id required' });

        const mime = req.file.mimetype;
        let material_type = 'pdf';
        if (mime.includes('word')) material_type = 'word';
        else if (mime.includes('presentation') || mime.includes('powerpoint')) material_type = 'presentation';
        else if (mime.includes('image')) material_type = 'img';

        const filePath = req.file.filename;

        const [result] = await db.execute(`
            INSERT INTO learning_materials (topic_id, title, material_type, file_path_or_url, is_locked, uploaded_by)
            VALUES (?, ?, ?, ?, 0, ?)`,
            [topic_id, title || req.file.originalname, material_type, filePath, req.user.user_id]
        );

        res.json({ success: true, material_id: result.insertId });
    } catch (err) {
        console.error('❌ [POST /teacher/api/analysis/upload-material]', err);
        res.status(500).json({ error: err.message });
    }
});


// ── GET /teacher/api/link-preview — Scrape OG metadata for link preview ─────
router.get('/api/link-preview', isTeacher, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
        // Native fetch (Node 18+). For older Node use axios or node-fetch.
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChemistryArcade/1.0)' },
            signal: AbortSignal.timeout(6000)
        });
        const html = await response.text();

        const getMeta = (property) => {
            const regex = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
            const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
            const match = html.match(regex) || html.match(alt);
            return match ? match[1] : null;
        };
        const getTitleTag = () => {
            const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            return match ? match[1].trim() : null;
        };

        res.json({
            title: getMeta('og:title') || getTitleTag() || url,
            description: getMeta('og:description') || getMeta('description') || '',
            thumbnail: getMeta('og:image') || null
        });
    } catch (err) {
        console.error('❌ [GET /teacher/api/link-preview]', err);
        res.status(500).json({ error: 'Could not fetch URL metadata.' });
    }
});


// ── GET /teacher/reports ─────────────────────────────────────────────────────
router.get('/reports', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    let selectedClassId = req.query.class_id;

    try {
        const currentSY = await academicHelper.getCurrentSchoolYear(db);

        // Fetch teacher's classes for the filter dropdown (with subject metadata, quarters, and school year)
        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester,
                   c.sy_id, sy.sy_range, sy.status AS sy_status, sy.is_active AS sy_is_active,
                   COALESCE(GROUP_CONCAT(q.quarter_number ORDER BY q.quarter_number), '1,2') as quarters
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN quarters q ON s.subject_id = q.subject_id
            WHERE c.teacher_id = ?
            GROUP BY c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, c.sy_id, sy.sy_range, sy.status, sy.is_active
            ORDER BY sy.is_active DESC, c.class_id ASC, c.class_name ASC`, [teacherId]);

        // Default to teacher's primary active class in the CURRENT school year if no class is explicitly specified
        if (!selectedClassId && classes.length > 0) {
            const currentSYClass = currentSY ? classes.find(c => c.sy_id === currentSY.sy_id) : null;
            selectedClassId = currentSYClass ? String(currentSYClass.class_id) : String(classes[0].class_id);
        } else if (selectedClassId === 'all') {
            selectedClassId = null; // triggers overview across all classes for DB queries
        }

        // Build a subject-id filter if a class is selected
        let subjectId = null;
        if (selectedClassId) {
            const found = classes.find(c => String(c.class_id) === String(selectedClassId));
            if (found) subjectId = found.subject_id;
        }

        // ── Parallel data fetch ────────────────────────────────────────────
        const [
            [statsRows],
            [studentRows],
            topicRemediationRows,
            [completionRateRows],
            [scoreDistRows],
            [winLossRows],
            [lbHistoryRows],
            [itemAnalysisRows],
            [arcadeRows],
            [arcadeByStudentRows],
            [heatmapTopicRows],
            [heatmapScoreRows],
            [seqErrorRows],
        ] = await Promise.all([

            // Stats summary (Fixed duplicate counting in multi-player matches)
            db.execute(`
                SELECT
                    (SELECT COUNT(DISTINCT cs.student_id)
                     FROM class_students cs
                     JOIN classes c ON cs.class_id = c.class_id
                     WHERE c.teacher_id = ?
                     ${selectedClassId ? 'AND c.class_id = ?' : ''}) AS totalStudents,
                    (SELECT COUNT(DISTINCT egs.session_id)
                     FROM elementa_game_sessions egs
                     JOIN class_students cs ON (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id)
                     JOIN classes c ON cs.class_id = c.class_id
                     WHERE c.teacher_id = ?
                     ${selectedClassId ? 'AND c.class_id = ?' : ''}) AS totalAttempts,
                    (SELECT ROUND(AVG(eca.is_correct) * 100, 1)
                     FROM elementa_customer_attempts eca
                     JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                     JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                     JOIN class_students cs ON (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) = cs.student_id
                     JOIN classes c2 ON cs.class_id = c2.class_id
                     WHERE c2.teacher_id = ?
                     ${selectedClassId ? 'AND c2.class_id = ?' : ''}) AS avgAccuracy,
                    (SELECT AVG(sp.progress_percent)
                     FROM student_progress sp
                     JOIN class_students cs2 ON sp.student_id = cs2.student_id
                     JOIN classes c3 ON cs2.class_id = c3.class_id
                     WHERE c3.teacher_id = ?
                     ${selectedClassId ? 'AND c3.class_id = ?' : ''}) AS avgCompletion`,
                selectedClassId
                    ? [teacherId, selectedClassId, teacherId, selectedClassId, teacherId, selectedClassId, teacherId, selectedClassId]
                    : [teacherId, teacherId, teacherId, teacherId]
            ),

            // Students list (for export cards + picker)
            db.execute(`
                SELECT DISTINCT
                    u.user_id, u.first_name, u.last_name, u.middle_name,
                    u.lrn_number, u.sex, u.strand, u.section, u.grade_level,
                    u.profile_pic, u.current_level,
                    c.class_id, c.class_name, s.subject_code, s.subject_name,
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    COALESCE(u.total_exp, 0) AS total_exp
                FROM users u
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                JOIN subjects s ON c.subject_id = s.subject_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND u.role = 'Student'
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ORDER BY u.last_name, u.first_name, c.class_name`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Restructured Class Topic Remediation Analysis
            computeClassTopicRemediation(db, selectedClassId, teacherId, subjectId),

            // Completion rates per class
            db.execute(`
                SELECT
                    c.class_id, c.class_name,
                    s.subject_name,
                    sy.sy_range,
                    COUNT(DISTINCT cs.student_id) AS student_count,
                    COALESCE(AVG(sp.progress_percent), 0) AS avg_progress
                FROM classes c
                JOIN subjects s ON c.subject_id = s.subject_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                LEFT JOIN class_students cs ON c.class_id = cs.class_id
                LEFT JOIN student_progress sp ON sp.student_id = cs.student_id AND sp.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY c.class_id, c.class_name, s.subject_name, sy.sy_range
                ORDER BY avg_progress ASC`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Score distribution buckets (Unified LMS Submissions + Arcade Simulations)
            db.execute(`
                SELECT
                    CASE
                        WHEN combined.grade_percent BETWEEN 90 AND 100 THEN '90-100'
                        WHEN combined.grade_percent BETWEEN 75 AND 89  THEN '75-89'
                        WHEN combined.grade_percent BETWEEN 60 AND 74  THEN '60-74'
                        WHEN combined.grade_percent BETWEEN 40 AND 59  THEN '40-59'
                        ELSE '0-39'
                    END AS label,
                    COUNT(*) AS count
                FROM (
                    SELECT
                        ROUND((ss.score_obtained / NULLIF(ss.total_possible_score, 0)) * 100) AS grade_percent
                    FROM student_scores ss
                    JOIN class_students cs ON ss.student_id = cs.student_id
                    JOIN classes c ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND ss.total_possible_score > 0
                    ${selectedClassId ? 'AND c.class_id = ?' : ''}

                    UNION ALL

                    SELECT
                        esg.grade_percent
                    FROM elementa_student_grades esg
                    JOIN class_students cs ON esg.student_id = cs.student_id
                    JOIN classes c ON cs.class_id = c.class_id
                    WHERE c.teacher_id = ? AND esg.grade_percent IS NOT NULL
                    ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ) combined
                GROUP BY label
                ORDER BY FIELD(label,'90-100','75-89','60-74','40-59','0-39')`,
                selectedClassId ? [teacherId, selectedClassId, teacherId, selectedClassId] : [teacherId, teacherId]
            ),

            // Win/loss (top winners)
            db.execute(`
                SELECT u.user_id, u.first_name, u.last_name,
                       COUNT(egs.session_id) AS wins
                FROM elementa_game_sessions egs
                JOIN users u ON (
                    (egs.winner = 'P1' AND egs.student_id_p1 = u.user_id) OR
                    (egs.winner = 'P2' AND egs.student_id_p2 = u.user_id)
                )
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ? AND egs.play_mode = 'Versus'
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, u.first_name, u.last_name
                ORDER BY wins DESC
                LIMIT 10`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // EXP growth (sessions over time)
            db.execute(`
                SELECT
                    u.first_name, u.last_name, u.user_id,
                    DATE_FORMAT(egs.started_at, '%Y-%m-%d') AS snap_date,
                    CASE WHEN egs.student_id_p1 = u.user_id THEN egs.final_score_p1 ELSE egs.final_score_p2 END AS total_exp_snapshot
                FROM elementa_game_sessions egs
                JOIN users u ON (egs.student_id_p1 = u.user_id OR egs.student_id_p2 = u.user_id)
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ORDER BY egs.started_at ASC
                LIMIT 500`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Item analysis (failure rate per question — single-counted per student)
            db.execute(`
                SELECT
                    eq.question_id, eq.prompt AS question_text, eq.difficulty,
                    COALESCE(eq.topic, elr.level_topic, 'General Chemistry') AS topic_name,
                    COUNT(eca.attempt_id) AS total,
                    SUM(eca.is_correct = 0) AS wrong
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                JOIN class_students cs ON (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                LEFT JOIN elementa_questions eq ON eca.question_id = eq.question_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY eq.question_id, eq.prompt, eq.difficulty, topic_name
                HAVING COUNT(eca.attempt_id) > 0
                ORDER BY (SUM(eca.is_correct = 0) / COUNT(eca.attempt_id)) DESC
                LIMIT 50`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Arcade utilization aggregate (Distinct session counting)
            db.execute(`
                SELECT
                    COUNT(DISTINCT egs.session_id) AS total,
                    COUNT(DISTINCT CASE WHEN egs.play_mode = 'Solo' THEN egs.session_id END) AS single_mode,
                    COUNT(DISTINCT CASE WHEN egs.play_mode = 'Versus' THEN egs.session_id END) AS duel_mode
                FROM elementa_game_sessions egs
                JOIN class_students cs ON (egs.student_id_p1 = cs.student_id OR egs.student_id_p2 = cs.student_id)
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Arcade utilization per student
            db.execute(`
                SELECT
                    u.user_id, u.first_name, u.last_name,
                    SUM(egs.play_mode = 'Solo')   AS single_sessions,
                    SUM(egs.play_mode = 'Versus') AS duel_sessions,
                    COUNT(egs.session_id) AS total_sessions
                FROM elementa_game_sessions egs
                JOIN users u ON (egs.student_id_p1 = u.user_id OR egs.student_id_p2 = u.user_id)
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, u.first_name, u.last_name
                ORDER BY total_sessions DESC`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Heatmap — topic list
            db.execute(`
                SELECT DISTINCT t.topic_id, t.topic_name
                FROM topics t
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                JOIN classes c ON c.subject_id = s.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ORDER BY t.topic_id ASC
                LIMIT 12`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Heatmap — per-student per-topic accuracy
            db.execute(`
                SELECT
                    u.user_id, u.first_name, u.last_name,
                    t.topic_id,
                    ROUND(AVG(eca.is_correct) * 100) AS accuracy
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                JOIN users u ON (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) = u.user_id
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                JOIN elementa_questions eq ON eca.question_id = eq.question_id
                JOIN topics t ON eq.topic_id = t.topic_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, t.topic_id
                ORDER BY u.last_name, u.first_name`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),

            // Sequence error analysis (Arcade Machine Failure Modes — accurate student matching)
            db.execute(`
                SELECT
                    eca.question_id,
                    COALESCE(eq.prompt, eca.question_snapshot, 'Arcade Question') AS question_text,
                    COALESCE(eq.topic, elr.level_topic, 'General') AS topic_name,
                    eca.machine_used AS element_symbol,
                    1 AS subscript,
                    1 AS sort_order,
                    COUNT(eca.attempt_id) AS total_count,
                    SUM(eca.is_correct = 0) AS wrong_count,
                    ROUND((SUM(eca.is_correct = 0) / COUNT(eca.attempt_id)) * 100) AS error_pct
                FROM elementa_customer_attempts eca
                JOIN elementa_level_runs elr ON eca.run_id = elr.run_id
                JOIN elementa_game_sessions egs ON elr.session_id = egs.session_id
                JOIN class_students cs ON (CASE WHEN elr.player_number = 1 THEN egs.student_id_p1 ELSE egs.student_id_p2 END) = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                LEFT JOIN elementa_questions eq ON eca.question_id = eq.question_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY eca.question_id, question_text, topic_name, eca.machine_used
                HAVING total_count > 0
                ORDER BY wrong_count DESC
                LIMIT 200`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
        ]);

        // ── Post-process stats ────────────────────────────────────────────
        const stats = {
            totalStudents: statsRows[0]?.totalStudents || 0,
            totalAttempts: statsRows[0]?.totalAttempts || 0,
            avgAccuracy: Math.round(statsRows[0]?.avgAccuracy || 0),
            avgCompletion: Math.round(statsRows[0]?.avgCompletion || 0),
        };

        // ── Post-process EXP Growth into Chart.js datasets ───────────────
        const expGrowth = { labels: [], datasets: [] };
        if (lbHistoryRows.length) {
            const dateSet = [...new Set(lbHistoryRows.map(r => r.snap_date))].sort();
            const studentMap = {};
            lbHistoryRows.forEach(r => {
                const key = r.user_id;
                if (!studentMap[key]) studentMap[key] = { name: r.first_name + ' ' + r.last_name, data: {} };
                studentMap[key].data[r.snap_date] = r.total_exp_snapshot;
            });
            expGrowth.labels = dateSet;
            expGrowth.datasets = Object.values(studentMap).slice(0, 6).map(s => ({
                label: s.name,
                data: dateSet.map(d => s.data[d] || null),
                spanGaps: true,
            }));
        }

        // ── Post-process Score Distribution (ensure all buckets present) ──
        const allBuckets = ['90-100', '75-89', '60-74', '40-59', '0-39'];
        const scoreDistribution = allBuckets.map(lbl => {
            const found = scoreDistRows.find(r => r.label === lbl);
            return { label: lbl, count: found ? Number(found.count) : 0 };
        });

        // ── Post-process Heatmap ─────────────────────────────────────────
        const heatmap = { topics: [], rows: [] };
        if (heatmapTopicRows.length && heatmapScoreRows.length) {
            heatmap.topics = heatmapTopicRows.map(t => t.topic_name);
            const topicIds = heatmapTopicRows.map(t => t.topic_id);
            const studentIds = [...new Set(heatmapScoreRows.map(r => r.user_id))];
            const scoreMap = {};
            heatmapScoreRows.forEach(r => {
                if (!scoreMap[r.user_id]) scoreMap[r.user_id] = {};
                scoreMap[r.user_id][r.topic_id] = r.accuracy;
            });
            heatmap.rows = studentIds.map(uid => {
                const row = heatmapScoreRows.find(r => r.user_id === uid);
                return {
                    name: row ? row.first_name + ' ' + row.last_name : uid,
                    scores: topicIds.map(tid => scoreMap[uid]?.[tid] ?? null),
                };
            });
        }

        // ── Post-process Sequence Errors (group by question) ─────────────
        const seqMap = {};
        seqErrorRows.forEach(r => {
            if (!seqMap[r.question_id]) {
                seqMap[r.question_id] = {
                    question_text: r.question_text,
                    topic_name: r.topic_name,
                    total_wrong: 0,
                    elements: [],
                };
            }
            seqMap[r.question_id].total_wrong += Number(r.wrong_count);
            seqMap[r.question_id].elements.push({
                element_symbol: r.element_symbol,
                subscript: r.subscript,
                sort_order: r.sort_order,
                total_count: Number(r.total_count),
                wrong_count: Number(r.wrong_count),
                error_pct: Number(r.error_pct),
            });
        });
        const seqErrors = Object.values(seqMap)
            .filter(q => q.total_wrong > 0)
            .sort((a, b) => b.total_wrong - a.total_wrong)
            .slice(0, 20);

        // ── Attach Cadet Level Titles to studentRows ──────────────────────
        const levelTitles = levelProgressionService.LEVEL_TITLES;
        (studentRows || []).forEach(s => {
            const info = levelTitles[s.current_level || 1];
            s.level_title = info ? info.title : 'Cadet';
        });

        // ── Post-process Arcade Stats ─────────────────────────────────────
        const arcadeStats = {
            total: Number(arcadeRows[0]?.total || 0),
            single: Number(arcadeRows[0]?.single_mode || 0),
            duel: Number(arcadeRows[0]?.duel_mode || 0),
        };

        const notifications = await getTeacherNotifications(db, teacherId);
        const activeSY = currentSY || (await academicHelper.getActiveSchoolYear(db));
        const quarterStatuses = {
            1: academicHelper.isQuarterGradingOpen(activeSY, 1),
            2: academicHelper.isQuarterGradingOpen(activeSY, 2),
            3: academicHelper.isQuarterGradingOpen(activeSY, 3),
            4: academicHelper.isQuarterGradingOpen(activeSY, 4)
        };

        res.render('teacher/reports', {
            user: req.user,
            activeSY,
            currentSY: activeSY,
            quarterStatuses,
            classes,
            selectedClassId: req.query.class_id === 'all' ? 'all' : (selectedClassId || ''),
            stats,
            students: studentRows,
            remediationList: topicRemediationRows,
            topicRemediationList: topicRemediationRows,
            completionRates: completionRateRows,
            scoreDistribution,
            winLoss: winLossRows,
            expGrowth,
            itemAnalysis: itemAnalysisRows,
            arcadeStats,
            arcadeByStudent: arcadeByStudentRows,
            heatmap,
            seqErrors,
            notifications,
        });

    } catch (err) {
        console.error('❌ [GET /teacher/reports]', err);
        res.status(500).send('Internal Server Error — Reports');
    }
});


// ════════════════════════════════════════════════════════════════════════════
// EXPORT ROUTES
// Requires at top of teacher.js:
//   const PDFDocument = require('pdfkit');
//   const ExcelJS     = require('exceljs');
// ════════════════════════════════════════════════════════════════════════════

// ── HELPER: Fetch enrolled students with academic performance & attendance metrics ──
async function getEnrolledStudentsWithFullMetrics(classId, teacherId, userRole = 'Teacher') {
    const isAdmin = userRole === 'Admin';
    const [cls] = await db.query(`
        SELECT c.class_id, c.class_name, c.subject_id, s.subject_name, s.subject_code
        FROM classes c
        JOIN subjects s ON c.subject_id = s.subject_id
        WHERE c.class_id = ? ${isAdmin ? '' : 'AND c.teacher_id = ?'}
    `, isAdmin ? [classId] : [classId, teacherId]);

    if (!cls.length) return { classInfo: null, students: [] };
    const classInfo = cls[0];
    const effSubjectId = classInfo.subject_id;

    const [students] = await db.query(`
        SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name,
               u.sex, u.strand, u.section, u.grade_level,
               COALESCE(att.days_present, 0) AS days_present,
               COALESCE(att.days_late, 0) AS days_late,
               COALESCE(att.days_absent, 0) AS days_absent,
               COALESCE(att.days_excused, 0) AS days_excused,
               COALESCE(att.total_sessions, 0) AS total_sessions
        FROM users u
        JOIN class_students cs ON u.user_id = cs.student_id
        LEFT JOIN (
            SELECT student_id, class_id,
                   COUNT(*) AS total_sessions,
                   SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) AS days_present,
                   SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) AS days_late,
                   SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) AS days_absent,
                   SUM(CASE WHEN status = 'Excused' THEN 1 ELSE 0 END) AS days_excused
            FROM attendance_records
            GROUP BY student_id, class_id
        ) att ON att.student_id = u.user_id AND att.class_id = cs.class_id
        WHERE cs.class_id = ? AND u.role = 'Student'
        ORDER BY u.last_name ASC, u.first_name ASC
    `, [classId]);

    if (!students.length) return { classInfo, students: [] };
    const studentIds = students.map(s => s.user_id);

    // Fetch assigned assessments for curriculum mastery calculation
    const [assessments] = await db.query(`
        SELECT a.assessment_id, a.topic_id, a.assessment_name,
               COALESCE(a.assessment_type, 'Assignment') AS assessment_type,
               COALESCE(NULLIF(a.total_items, 0), 100) AS total_items
        FROM assessments a
        WHERE a.topic_id IN (
            SELECT t.topic_id FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
        )
    `, [effSubjectId]);

    const totalAssignedTasks = assessments.length;

    // Fetch LMS scores
    const [lmsScores] = await db.query(`
        SELECT ss.student_id, ss.assessment_id, ss.score_obtained,
               COALESCE(NULLIF(ss.total_items, 0), NULLIF(ss.total_possible_score, 0), a.total_items, 100) AS total_items,
               COALESCE(ss.exp_gained, 0) AS exp_gained,
               COALESCE(a.assessment_type, 'Assignment') AS assessment_type
        FROM student_scores ss
        JOIN assessments a ON ss.assessment_id = a.assessment_id
        JOIN topics t ON a.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE q.subject_id = ? AND ss.student_id IN (?)
    `, [effSubjectId, studentIds]);

    // Fetch Arcade scores
    const [arcadeScores] = await db.query(`
        SELECT esg.student_id, esg.assessment_id,
               esg.correct_answers AS score_obtained,
               esg.points_possible AS total_items,
               COALESCE(a.assessment_type, 'Assignment') AS assessment_type
        FROM elementa_student_grades esg
        JOIN assessments a ON esg.assessment_id = a.assessment_id
        JOIN topics t ON a.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE q.subject_id = ? AND esg.student_id IN (?) AND esg.run_status = 'Completed'
    `, [effSubjectId, studentIds]);

    // Fetch subject forums
    const [forums] = await db.query(`
        SELECT ft.forum_id
        FROM forum_topics ft
        JOIN topics t ON ft.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE q.subject_id = ?
    `, [effSubjectId]);
    const totalSubjectForums = forums.length;

    const [doneForums] = await db.query(`
        SELECT sfd.student_id, sfd.forum_id, COALESCE(sfd.exp_awarded, 0) AS exp_awarded
        FROM student_forum_done sfd
        JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
        JOIN topics t ON ft.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE q.subject_id = ? AND sfd.student_id IN (?)
    `, [effSubjectId, studentIds]);

    // Fetch simulation bonus exp
    const [simSubmissions] = await db.query(`
        SELECT esqs.student_id, COALESCE(esqs.exp_earned, 0) AS exp_earned
        FROM elementa_simulation_quiz_submissions esqs
        WHERE esqs.student_id IN (?)
    `, [studentIds]);

    // Map scores
    const studentScoreMap = new Map();
    studentIds.forEach(id => studentScoreMap.set(id, new Map()));

    for (const sc of lmsScores) {
        const sMap = studentScoreMap.get(sc.student_id);
        if (!sMap) continue;
        const aid = sc.assessment_id;
        const score = Number(sc.score_obtained) || 0;
        const total = Number(sc.total_items) || 100;
        const pct = total > 0 ? (score / total) * 100 : 0;
        if (!sMap.has(aid) || pct > sMap.get(aid).pct) {
            sMap.set(aid, {
                score_obtained: score,
                total_items: total,
                pct,
                exp_gained: Number(sc.exp_gained) || 0,
                assessment_type: sc.assessment_type
            });
        }
    }

    for (const arc of arcadeScores) {
        const sMap = studentScoreMap.get(arc.student_id);
        if (!sMap) continue;
        const aid = arc.assessment_id;
        const score = Number(arc.score_obtained) || 0;
        const total = Number(arc.total_items) || 1;
        const pct = total > 0 ? (score / total) * 100 : 0;
        if (!sMap.has(aid)) {
            sMap.set(aid, {
                score_obtained: score,
                total_items: total,
                pct,
                exp_gained: 0,
                assessment_type: arc.assessment_type
            });
        } else {
            const existing = sMap.get(aid);
            if (pct > existing.pct) {
                existing.score_obtained = score;
                existing.total_items = total;
                existing.pct = pct;
            }
        }
    }

    const studentForumMap = new Map();
    studentIds.forEach(id => studentForumMap.set(id, { count: 0, exp: 0 }));
    for (const df of doneForums) {
        const fInfo = studentForumMap.get(df.student_id);
        if (fInfo) {
            fInfo.count++;
            fInfo.exp += Number(df.exp_awarded) || 0;
        }
    }

    const studentSimExpMap = new Map();
    studentIds.forEach(id => studentSimExpMap.set(id, 0));
    for (const sim of simSubmissions) {
        const cur = studentSimExpMap.get(sim.student_id) || 0;
        studentSimExpMap.set(sim.student_id, cur + (Number(sim.exp_earned) || 0));
    }

    const enrichedStudents = students.map(s => {
        const sMap = studentScoreMap.get(s.user_id) || new Map();
        let totalTaskPctSum = 0;
        let asmtScoreSum = 0;
        let asmtItemsSum = 0;
        let asmtExpSum = 0;
        let asgnScoreSum = 0;
        let asgnItemsSum = 0;
        let asgnExpSum = 0;
        let completedCount = 0;

        for (const asm of assessments) {
            const sc = sMap.get(asm.assessment_id);
            const isSubmitted = !!sc;
            const score = isSubmitted ? sc.score_obtained : 0;
            const items = isSubmitted ? sc.total_items : asm.total_items;
            const pct = isSubmitted && items > 0 ? (score / items) * 100 : 0;
            const exp = isSubmitted ? sc.exp_gained : 0;

            totalTaskPctSum += pct;

            if (isSubmitted) {
                completedCount++;
                if (asm.assessment_type === 'Assignment') {
                    asgnScoreSum += score;
                    asgnItemsSum += items;
                    asgnExpSum += exp;
                } else {
                    asmtScoreSum += score;
                    asmtItemsSum += items;
                    asmtExpSum += exp;
                }
            }
        }

        const overallMastery = totalAssignedTasks > 0 ? Math.round(totalTaskPctSum / totalAssignedTasks) : 0;
        const asmtAvg = asmtItemsSum > 0 ? Math.round((asmtScoreSum / asmtItemsSum) * 100) : null;
        const asgnAvg = asgnItemsSum > 0 ? Math.round((asgnScoreSum / asgnItemsSum) * 100) : null;

        const forumData = studentForumMap.get(s.user_id) || { count: 0, exp: 0 };
        const simExp = studentSimExpMap.get(s.user_id) || 0;
        const subjectExp = asmtExpSum + asgnExpSum + forumData.exp + simExp;

        const attRate = s.total_sessions > 0
            ? Math.round(((Number(s.days_present) + Number(s.days_late)) / s.total_sessions) * 100)
            : 0;

        return {
            ...s,
            class_name: classInfo.class_name,
            subject_name: classInfo.subject_name,
            overall_mastery: overallMastery,
            assessment_avg: asmtAvg,
            assignment_avg: asgnAvg,
            forums_completed: forumData.count,
            forums_total: totalSubjectForums,
            forum_exp: forumData.exp,
            sim_bonus_exp: simExp,
            subject_exp: subjectExp,
            completed_tasks: completedCount,
            total_tasks: totalAssignedTasks,
            attendance_rate: attRate
        };
    });

    return { classInfo, students: enrichedStudents };
}

// ── HELPER: Filter students by demographics and academic performance metrics ──
function filterStudentPerformanceMetrics(students, query = {}) {
    return students.filter(s => {
        // 1. Sex filter (Male, Female, All)
        if (query.sex && query.sex !== 'all') {
            if (!s.sex || String(s.sex).toLowerCase() !== String(query.sex).toLowerCase()) return false;
        }

        // 2. Overall Mastery bracket
        if (query.mastery_bracket && query.mastery_bracket !== 'all') {
            const m = s.overall_mastery || 0;
            if (query.mastery_bracket === 'mastery' && m < 90) return false;
            if (query.mastery_bracket === 'proficient' && (m < 80 || m >= 90)) return false;
            if (query.mastery_bracket === 'approaching' && (m < 75 || m >= 80)) return false;
            if ((query.mastery_bracket === 'developing' || query.mastery_bracket === 'intervention') && m >= 75) return false;
        }

        // 3. Assessment Average bracket (Failing / Intervention)
        if (query.asmt_bracket && query.asmt_bracket !== 'all') {
            if (query.asmt_bracket === 'intervention') {
                if (s.assessment_avg === null || s.assessment_avg >= 75) return false;
            } else if (query.asmt_bracket === 'passing') {
                if (s.assessment_avg === null || s.assessment_avg < 75) return false;
            } else if (query.asmt_bracket === 'mastery') {
                if (s.assessment_avg === null || s.assessment_avg < 90) return false;
            } else if (query.asmt_bracket === 'unsubmitted') {
                if (s.assessment_avg !== null) return false;
            }
        }

        // 4. Assignment Average bracket
        if (query.asgn_bracket && query.asgn_bracket !== 'all') {
            if (query.asgn_bracket === 'intervention') {
                if (s.assignment_avg === null || s.assignment_avg >= 75) return false;
            } else if (query.asgn_bracket === 'passing') {
                if (s.assignment_avg === null || s.assignment_avg < 75) return false;
            } else if (query.asgn_bracket === 'mastery') {
                if (s.assignment_avg === null || s.assignment_avg < 90) return false;
            }
        }

        // 5. Forums completed status
        if (query.forum_status && query.forum_status !== 'all') {
            if (query.forum_status === 'none' && s.forums_completed > 0) return false;
            if (query.forum_status === 'partial' && (s.forums_completed === 0 || s.forums_completed >= s.forums_total)) return false;
            if (query.forum_status === 'completed' && s.forums_completed < s.forums_total) return false;
        }

        // 6. Subject EXP bracket
        if (query.exp_bracket && query.exp_bracket !== 'all') {
            const exp = s.subject_exp || 0;
            if (query.exp_bracket === 'under_500' && exp >= 500) return false;
            if (query.exp_bracket === '500_to_999' && (exp < 500 || exp >= 1000)) return false;
            if (query.exp_bracket === '1000_plus' && exp < 1000) return false;
        }

        if (query.min_exp && Number(query.min_exp) > 0) {
            if ((s.subject_exp || 0) < Number(query.min_exp)) return false;
        }

        return true;
    });
}

// ── GET /teacher/api/attendance/:classId/conducted-dates ───────────────────
// Returns strictly the dates when attendance was actually conducted by the instructor
router.get('/api/attendance/:classId/conducted-dates', isTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.user.user_id;
        const isAdmin = req.user.role === 'Admin';

        // Support multi-class overview ('all')
        if (classId === 'all') {
            const [dates] = await db.query(`
                SELECT DISTINCT DATE_FORMAT(ar.session_date, '%Y-%m-%d') AS raw_date,
                       DATE_FORMAT(ar.session_date, '%b %d, %Y') AS formatted_date,
                       DAYNAME(ar.session_date) AS day_name,
                       COUNT(ar.attendance_id) AS total_records
                FROM attendance_records ar
                JOIN classes c ON ar.class_id = c.class_id
                WHERE ${isAdmin ? '1=1' : 'c.teacher_id = ?'} AND ar.attendance_method = 'Manual_Teacher'
                GROUP BY DATE(ar.session_date)
                ORDER BY ar.session_date DESC
            `, isAdmin ? [] : [teacherId]);

            return res.json({
                success: true,
                class_id: 'all',
                class_name: 'All Classes',
                dates: dates.map(d => ({
                    date: d.raw_date,
                    label: `${d.formatted_date} (${d.day_name}) — ${d.total_records} marked across classes`,
                    day_name: d.day_name,
                    total_records: d.total_records
                }))
            });
        }

        const [cls] = await db.query(
            isAdmin
                ? "SELECT class_id, class_name FROM classes WHERE class_id = ?"
                : "SELECT class_id, class_name FROM classes WHERE class_id = ? AND teacher_id = ?",
            isAdmin ? [classId] : [classId, teacherId]
        );
        if (!cls.length) return res.status(403).json({ success: false, error: 'Unauthorized class access' });

        const [dates] = await db.query(`
            SELECT DISTINCT session_date,
                   DATE_FORMAT(session_date, '%Y-%m-%d') AS raw_date,
                   DATE_FORMAT(session_date, '%b %d, %Y') AS formatted_date,
                   DAYNAME(session_date) AS day_name,
                   COUNT(attendance_id) AS total_records
            FROM attendance_records
            WHERE class_id = ? AND attendance_method = 'Manual_Teacher'
            GROUP BY session_date
            ORDER BY session_date DESC
        `, [classId]);

        return res.json({
            success: true,
            class_id: classId,
            class_name: cls[0].class_name,
            dates: dates.map(d => ({
                date: d.raw_date,
                label: `${d.formatted_date} (${d.day_name}) — ${d.total_records} marked`,
                day_name: d.day_name,
                total_records: d.total_records
            }))
        });
    } catch (err) {
        console.error('[GET /api/attendance/:classId/conducted-dates Error]:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch conducted attendance dates' });
    }
});

// Helper: formatClockTime for attendance reports
function formatClockTime(dt) {
    if (!dt) return '—';
    try {
        const d = new Date(dt);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString('en-PH', {
            timeZone: 'Asia/Manila',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    } catch (_) {
        return '—';
    }
}

// ── GET /teacher/api/reports/topics-filter-data ──────────────────────────────
// Dynamically provides topics segregated by component (assessments, assignments, forums)
// for the selected class & quarter.
router.get('/api/reports/topics-filter-data', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const isAdmin = req.user.role === 'Admin';
    const classId = req.query.class_id;
    const quarter = req.query.quarter ? parseInt(req.query.quarter, 10) : null;

    if (!classId) {
        return res.status(400).json({ success: false, error: 'Missing class_id parameter' });
    }

    try {
        let subjectIds = [];

        if (classId !== 'all') {
            const parsedClassId = parseInt(classId, 10);
            if (isNaN(parsedClassId)) {
                return res.status(400).json({ success: false, error: 'Invalid class ID' });
            }

            const [clsRows] = await db.query(
                `SELECT subject_id FROM classes WHERE class_id = ? ${isAdmin ? '' : 'AND teacher_id = ?'}`,
                isAdmin ? [parsedClassId] : [parsedClassId, teacherId]
            );

            if (!clsRows.length) {
                return res.status(403).json({ success: false, error: 'Unauthorized class access' });
            }
            subjectIds = [clsRows[0].subject_id];
        } else {
            const [clsRows] = await db.query(
                `SELECT DISTINCT subject_id FROM classes WHERE ${isAdmin ? '1=1' : 'teacher_id = ?'}`,
                isAdmin ? [] : [teacherId]
            );
            subjectIds = clsRows.map(r => r.subject_id);
        }

        if (!subjectIds.length) {
            return res.json({
                success: true,
                assessmentTopics: [],
                assignmentTopics: [],
                forumTopics: []
            });
        }

        const placeholders = subjectIds.map(() => '?').join(',');

        // Fetch available quarters for these subject(s)
        const [quarterRows] = await db.query(
            `SELECT DISTINCT quarter_number FROM quarters WHERE subject_id IN (${placeholders}) ORDER BY quarter_number ASC`,
            subjectIds
        );
        const availableQuarters = quarterRows.map(r => r.quarter_number);

        // If a specific quarter is requested that is not offered by the subject(s), return empty gracefully
        if (quarter && !availableQuarters.includes(quarter)) {
            return res.json({
                success: true,
                availableQuarters,
                assessmentTopics: [],
                assignmentTopics: [],
                forumTopics: []
            });
        }

        // 1. Topics containing Assessments (non-Assignment quizzes, tests, etc.)
        let asmtSql = `
            SELECT DISTINCT t.topic_id, t.topic_name, q.quarter_number
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN assessments a ON a.topic_id = t.topic_id
            WHERE q.subject_id IN (${placeholders}) AND (a.assessment_type != 'Assignment' OR a.assessment_type IS NULL)
        `;
        const asmtParams = [...subjectIds];
        if (quarter) {
            asmtSql += ' AND q.quarter_number = ?';
            asmtParams.push(quarter);
        }
        asmtSql += ' ORDER BY q.quarter_number ASC, t.topic_id ASC';
        const [asmtTopics] = await db.query(asmtSql, asmtParams);

        // 2. Topics containing Assignments
        let asgnSql = `
            SELECT DISTINCT t.topic_id, t.topic_name, q.quarter_number
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN assessments a ON a.topic_id = t.topic_id
            WHERE q.subject_id IN (${placeholders}) AND a.assessment_type = 'Assignment'
        `;
        const asgnParams = [...subjectIds];
        if (quarter) {
            asgnSql += ' AND q.quarter_number = ?';
            asgnParams.push(quarter);
        }
        asgnSql += ' ORDER BY q.quarter_number ASC, t.topic_id ASC';
        const [asgnTopics] = await db.query(asgnSql, asgnParams);

        // 3. Topics containing Discussion Forums
        let forumSql = `
            SELECT DISTINCT t.topic_id, t.topic_name, q.quarter_number
            FROM topics t
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN forum_topics ft ON ft.topic_id = t.topic_id
            WHERE q.subject_id IN (${placeholders})
        `;
        const forumParams = [...subjectIds];
        if (quarter) {
            forumSql += ' AND q.quarter_number = ?';
            forumParams.push(quarter);
        }
        forumSql += ' ORDER BY q.quarter_number ASC, t.topic_id ASC';
        const [forumTopics] = await db.query(forumSql, forumParams);

        // Clean extra whitespace in topic names for clean display in dropdowns
        const cleanTopics = rows => rows.map(r => ({
            topic_id: r.topic_id,
            topic_name: (r.topic_name || '').replace(/\s+/g, ' ').trim(),
            quarter_number: r.quarter_number
        }));

        return res.json({
            success: true,
            availableQuarters,
            assessmentTopics: cleanTopics(asmtTopics),
            assignmentTopics: cleanTopics(asgnTopics),
            forumTopics: cleanTopics(forumTopics)
        });
    } catch (err) {
        console.error('[GET /api/reports/topics-filter-data]', err);
        return res.status(500).json({ success: false, error: 'Database error loading topic filter options' });
    }
});

/**
 * Shared Helper: Compute Student Subject Summary Analytics (100% Class-View View Score parity)
 */
async function computeStudentSubjectSummary(studentId, subjectId) {
    // 1. Fetch all assigned coursework in subject
    const [allTasks] = await db.query(`
        SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.category,
               COALESCE(a.total_items, 10) AS total_items
        FROM assessments a
        JOIN topics t ON a.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE q.subject_id = ?
        ORDER BY q.quarter_number ASC, t.topic_id ASC, a.assessment_id ASC
    `, [subjectId]);

    // 2. Fetch student's submitted coursework scores
    const [lmsScores] = await db.query(`
        SELECT ss.assessment_id, ss.score_obtained, ss.total_possible_score AS total_items,
               ss.exp_gained, ss.feedback, ss.submitted_at, ss.attempt_number
        FROM student_scores ss
        JOIN assessments a ON ss.assessment_id = a.assessment_id
        JOIN topics t ON a.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE ss.student_id = ? AND q.subject_id = ?
        ORDER BY ss.assessment_id ASC, ss.attempt_number DESC, ss.score_id DESC
    `, [studentId, subjectId]);

    // 3. Fetch arcade session grades
    const [arcadeScores] = await db.query(`
        SELECT esg.assessment_id, esg.correct_answers AS score_obtained,
               esg.points_possible AS total_items, esg.points_earned AS exp_gained,
               esg.grade_percent, esg.started_at AS submitted_at
        FROM elementa_student_grades esg
        JOIN assessments a ON esg.assessment_id = a.assessment_id
        JOIN topics t ON a.topic_id = t.topic_id
        JOIN quarters q ON t.quarter_id = q.quarter_id
        WHERE esg.student_id = ? AND q.subject_id = ? AND esg.run_status = 'Completed'
        ORDER BY esg.started_at DESC
    `, [studentId, subjectId]);

    // 4. Fetch subject discussion forums & student completions (scoped by ft.subject_id to match Student Forums page)
    const [allSubjectForums] = await db.query(`
        SELECT ft.forum_id, ft.topic_id, ft.title, ft.base_exp, ft.due_date
        FROM forum_topics ft
        WHERE ft.subject_id = ?
    `, [subjectId]);

    const [studentForumDone] = await db.query(`
        SELECT sfd.forum_id, COALESCE(sfd.exp_awarded, 0) AS exp_awarded, sfd.done_at
        FROM student_forum_done sfd
        JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
        WHERE sfd.student_id = ? AND ft.subject_id = ?
    `, [studentId, subjectId]);

    // 5. Fetch simulation quiz submissions
    const [simSubmissions] = await db.query(`
        SELECT esqs.submission_id, esqs.quiz_id, esqs.simulation_slug,
               esqs.score, esqs.total_questions, esqs.exp_earned, esqs.percentage
        FROM elementa_simulation_quiz_submissions esqs
        WHERE esqs.student_id = ?
    `, [studentId]);

    // Build deduplicated best score map
    const scoreMap = new Map();
    for (const sc of lmsScores) {
        const aid = sc.assessment_id;
        const score = Number(sc.score_obtained) || 0;
        const total = Number(sc.total_items) || 100;
        const pct = total > 0 ? (score / total) * 100 : 0;
        if (!scoreMap.has(aid) || pct > scoreMap.get(aid).pct) {
            scoreMap.set(aid, {
                score_obtained: score,
                total_items: total,
                pct,
                exp_gained: Number(sc.exp_gained) || 0,
                source: 'lms'
            });
        }
    }

    for (const arc of arcadeScores) {
        const aid = arc.assessment_id;
        const score = Number(arc.score_obtained) || 0;
        const total = Number(arc.total_items) || 1;
        const pct = total > 0 ? (score / total) * 100 : 0;
        if (!scoreMap.has(aid)) {
            scoreMap.set(aid, {
                score_obtained: score,
                total_items: total,
                pct,
                exp_gained: 0,
                source: 'arcade'
            });
        } else {
            const existing = scoreMap.get(aid);
            if (pct > existing.pct) {
                existing.score_obtained = score;
                existing.total_items = total;
                existing.pct = pct;
                existing.source = 'arcade';
            }
        }
    }

    let totalAssignedTasks = allTasks.length;
    let totalTaskPctSum = 0;
    let asmtScoreSum = 0, asmtItemsSum = 0, asmtExpSum = 0;
    let asgnScoreSum = 0, asgnItemsSum = 0, asgnExpSum = 0;

    for (const task of allTasks) {
        const sc = scoreMap.get(task.assessment_id);
        const isSubmitted = !!sc;
        const score = isSubmitted ? sc.score_obtained : 0;
        const items = isSubmitted ? sc.total_items : (Number(task.total_items) || 10);
        const pct = isSubmitted && items > 0 ? Math.round((score / items) * 100) : 0;
        const exp = isSubmitted ? sc.exp_gained : 0;

        // Unsubmitted tasks contribute 0%
        totalTaskPctSum += pct;

        if (task.assessment_type === 'Assignment') {
            if (isSubmitted) {
                asgnScoreSum += score;
                asgnItemsSum += items;
                asgnExpSum += exp;
            }
        } else {
            if (isSubmitted) {
                asmtScoreSum += score;
                asmtItemsSum += items;
                asmtExpSum += exp;
            }
        }
    }

    const curriculumMastery = totalAssignedTasks > 0 ? Math.round(totalTaskPctSum / totalAssignedTasks) : 0;
    const asmtAvg = asmtItemsSum > 0 ? Math.round((asmtScoreSum / asmtItemsSum) * 100) : null;
    const asgnAvg = asgnItemsSum > 0 ? Math.round((asgnScoreSum / asgnItemsSum) * 100) : null;

    const totalForumsCompleted = studentForumDone.length;
    const totalForumExp = studentForumDone.reduce((sum, f) => sum + (Number(f.exp_awarded) || 0), 0);
    const totalSimulationBonusExp = simSubmissions.reduce((sum, s) => sum + (Number(s.exp_earned) || 0), 0);

    const subjectTotalExp = asmtExpSum + asgnExpSum + totalForumExp + totalSimulationBonusExp;

    return {
        overallMastery: curriculumMastery,
        asmtAvg,
        asgnAvg,
        forumsCompleted: totalForumsCompleted,
        totalForums: allSubjectForums.length,
        subjectTotalExp
    };
}

/**
 * Shared Helper: Compute Class Topic Remediation Analysis
 * Evaluates curriculum topic vulnerability across Assessments, Assignments, and Forums
 * Scoped to a specific class (or all classes taught by teacher)
 */
async function computeClassTopicRemediation(dbConn, classId, teacherId, subjectId = null) {
    let effectiveClassId = classId;
    let targetSubjectId = subjectId;

    if (effectiveClassId && effectiveClassId !== 'all') {
        const [cRows] = await dbConn.query(
            `SELECT class_id, class_name, subject_id, teacher_id FROM classes WHERE class_id = ?`,
            [effectiveClassId]
        );
        if (cRows.length > 0) {
            targetSubjectId = cRows[0].subject_id;
        }
    }

    // 1. Fetch Active Enrolled Students
    let enrolledStudents = [];
    if (effectiveClassId && effectiveClassId !== 'all') {
        const [sRows] = await dbConn.query(`
            SELECT DISTINCT cs.student_id, u.first_name, u.last_name, u.lrn_number, u.current_level, u.profile_pic
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE cs.class_id = ? AND c.teacher_id = ? AND u.role = 'Student'
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [effectiveClassId, teacherId]);
        enrolledStudents = sRows;
    } else {
        const [sRows] = await dbConn.query(`
            SELECT DISTINCT cs.student_id, u.first_name, u.last_name, u.lrn_number, u.current_level, u.profile_pic
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE c.teacher_id = ? AND u.role = 'Student'
            ${targetSubjectId ? 'AND c.subject_id = ?' : ''}
            ORDER BY u.last_name ASC, u.first_name ASC
        `, targetSubjectId ? [teacherId, targetSubjectId] : [teacherId]);
        enrolledStudents = sRows;
    }

    const totalEnrolled = enrolledStudents.length;
    const studentIds = enrolledStudents.map(s => s.student_id);

    // 2. Fetch Topics for Subject (or all subjects taught by teacher)
    let topicQuery = `
        SELECT t.topic_id, t.topic_name, t.topic_description, q.quarter_number, q.quarter_id, s.subject_id, s.subject_name
        FROM topics t
        JOIN quarters q ON t.quarter_id = q.quarter_id
        JOIN subjects s ON q.subject_id = s.subject_id
    `;
    let topicParams = [];
    if (targetSubjectId) {
        topicQuery += ` WHERE q.subject_id = ? ORDER BY q.quarter_number ASC, t.topic_id ASC`;
        topicParams.push(targetSubjectId);
    } else {
        topicQuery += `
            JOIN classes c ON c.subject_id = s.subject_id
            WHERE c.teacher_id = ?
            GROUP BY t.topic_id, t.topic_name, t.topic_description, q.quarter_number, q.quarter_id, s.subject_id, s.subject_name
            ORDER BY q.quarter_number ASC, t.topic_id ASC
        `;
        topicParams.push(teacherId);
    }
    const [topicRows] = await dbConn.query(topicQuery, topicParams);

    if (topicRows.length === 0) {
        return [];
    }

    const topicIds = topicRows.map(t => t.topic_id);

    // 3. Fetch Coursework Tasks (Assessments and Assignments) under these topics
    const [tasks] = await dbConn.query(`
        SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.topic_id,
               COALESCE(a.total_items, 10) AS total_items, a.is_unlocked
        FROM assessments a
        WHERE a.topic_id IN (?)
        ORDER BY a.topic_id ASC, a.assessment_id ASC
    `, [topicIds]);

    // 4. Fetch Discussion Forums under these topics
    const [forums] = await dbConn.query(`
        SELECT ft.forum_id, ft.topic_id, ft.title, COALESCE(ft.base_exp, 100) AS base_exp
        FROM forum_topics ft
        WHERE ft.topic_id IN (?)
        ORDER BY ft.topic_id ASC, ft.forum_id ASC
    `, [topicIds]);

    // 5. Fetch Student Scores for Enrolled Students
    let lmsScores = [];
    let arcadeScores = [];
    let forumDoneRecords = [];

    if (studentIds.length > 0 && topicIds.length > 0) {
        // LMS Scores
        const [lms] = await dbConn.query(`
            SELECT ss.student_id, ss.assessment_id, ss.score_obtained, ss.total_possible_score, ss.exp_gained
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            WHERE ss.student_id IN (?) AND a.topic_id IN (?)
            ORDER BY ss.assessment_id ASC, ss.score_id DESC
        `, [studentIds, topicIds]);
        lmsScores = lms;

        // Arcade session grades
        const [arc] = await dbConn.query(`
            SELECT esg.student_id, esg.assessment_id, esg.correct_answers AS score_obtained,
                   esg.points_possible AS total_possible_score, esg.points_earned AS exp_gained, esg.grade_percent
            FROM elementa_student_grades esg
            JOIN assessments a ON esg.assessment_id = a.assessment_id
            WHERE esg.student_id IN (?) AND a.topic_id IN (?) AND esg.run_status = 'Completed'
            ORDER BY esg.started_at DESC
        `, [studentIds, topicIds]);
        arcadeScores = arc;

        // Forum completions
        const [fd] = await dbConn.query(`
            SELECT sfd.student_id, sfd.forum_id, sfd.exp_awarded, ft.topic_id
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            WHERE sfd.student_id IN (?) AND ft.topic_id IN (?)
        `, [studentIds, topicIds]);
        forumDoneRecords = fd;
    }

    // 6. Build Task Max Possible Map & Student-Task Score Map
    const taskMaxPossibleMap = new Map();
    for (const sc of lmsScores) {
        const cur = taskMaxPossibleMap.get(sc.assessment_id) || 0;
        const tot = Number(sc.total_possible_score) || 0;
        if (tot > cur) taskMaxPossibleMap.set(sc.assessment_id, tot);
    }
    for (const arc of arcadeScores) {
        const cur = taskMaxPossibleMap.get(arc.assessment_id) || 0;
        const tot = Number(arc.total_possible_score) || 0;
        if (tot > cur) taskMaxPossibleMap.set(arc.assessment_id, tot);
    }

    // Effective maximum possible items for each task (guards against rubric/grading scale mismatch)
    const effectiveTaskItems = new Map();
    for (const t of tasks) {
        const recordedMax = taskMaxPossibleMap.get(t.assessment_id) || 0;
        effectiveTaskItems.set(t.assessment_id, Math.max(Number(t.total_items) || 0, recordedMax, 1));
    }

    // Student-Task Score Map: key = `${studentId}_${assessmentId}`
    const studentScoreMap = new Map();
    for (const sc of lmsScores) {
        const key = `${sc.student_id}_${sc.assessment_id}`;
        const eff = effectiveTaskItems.get(sc.assessment_id) || Number(sc.total_possible_score) || 10;
        const score = Number(sc.score_obtained) || 0;
        const pct = eff > 0 ? (score / eff) * 100 : 0;
        if (!studentScoreMap.has(key) || pct > studentScoreMap.get(key).pct) {
            studentScoreMap.set(key, { score, total: eff, pct, exp: Number(sc.exp_gained) || 0 });
        }
    }
    for (const arc of arcadeScores) {
        const key = `${arc.student_id}_${arc.assessment_id}`;
        const eff = effectiveTaskItems.get(arc.assessment_id) || Number(arc.total_possible_score) || 10;
        const score = Number(arc.score_obtained) || 0;
        const pct = eff > 0 ? (score / eff) * 100 : 0;
        if (!studentScoreMap.has(key) || pct > studentScoreMap.get(key).pct) {
            studentScoreMap.set(key, { score, total: eff, pct, exp: Number(arc.exp_gained) || 0 });
        }
    }

    // Forum Done Map: key = `${studentId}_${forumId}`
    const forumDoneMap = new Map();
    for (const f of forumDoneRecords) {
        forumDoneMap.set(`${f.student_id}_${f.forum_id}`, {
            exp_awarded: Number(f.exp_awarded) || 0
        });
    }

    // 7. Process Each Topic
    const topicRemediationResults = topicRows.map(topic => {
        const tid = topic.topic_id;
        const topicTasks = tasks.filter(t => t.topic_id === tid);
        const topicAsmts = topicTasks.filter(t => t.assessment_type !== 'Assignment');
        const topicAsgns = topicTasks.filter(t => t.assessment_type === 'Assignment');
        const topicForums = forums.filter(f => f.topic_id === tid);

        const totalAsmtItems = topicAsmts.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || Number(a.total_items) || 10), 0);
        const totalAsgnItems = topicAsgns.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || Number(a.total_items) || 10), 0);
        const asmtCount = topicAsmts.length;
        const asgnCount = topicAsgns.length;
        const forumCount = topicForums.length;

        // Class Aggregates
        let classAsmtScoreObtained = 0;
        const classAsmtMaxPossible = totalEnrolled > 0 ? (totalAsmtItems * totalEnrolled) : 0;

        let classAsgnScoreObtained = 0;
        const classAsgnMaxPossible = totalEnrolled > 0 ? (totalAsgnItems * totalEnrolled) : 0;

        let classForumDoneCount = 0;
        const classForumExpected = totalEnrolled > 0 ? (forumCount * totalEnrolled) : 0;

        // Per-student topic evaluation
        const studentBreakdown = enrolledStudents.map(student => {
            const sid = student.student_id;
            let studentAsmtScore = 0;
            let studentAsmtExp = 0;
            let studentAsmtCompleted = 0;
            let studentAsgnScore = 0;
            let studentAsgnExp = 0;
            let studentAsgnCompleted = 0;

            // Assessments
            for (const asmt of topicAsmts) {
                const sc = studentScoreMap.get(`${sid}_${asmt.assessment_id}`);
                if (sc) {
                    studentAsmtScore += sc.score;
                    studentAsmtExp += sc.exp;
                    studentAsmtCompleted++;
                    classAsmtScoreObtained += sc.score;
                }
            }

            // Assignments
            for (const asgn of topicAsgns) {
                const sc = studentScoreMap.get(`${sid}_${asgn.assessment_id}`);
                if (sc) {
                    studentAsgnScore += sc.score;
                    studentAsgnExp += sc.exp;
                    studentAsgnCompleted++;
                    classAsgnScoreObtained += sc.score;
                }
            }

            // Forums
            let studentForumsDone = 0;
            let studentForumExp = 0;
            for (const f of topicForums) {
                const fd = forumDoneMap.get(`${sid}_${f.forum_id}`);
                if (fd) {
                    studentForumsDone++;
                    studentForumExp += fd.exp_awarded;
                    classForumDoneCount++;
                }
            }

            // Student Component Averages (3 Core Topic Pillars)
            const asmtPct = totalAsmtItems > 0 ? Math.round((studentAsmtScore / totalAsmtItems) * 100) : null;
            const asgnPct = totalAsgnItems > 0 ? Math.round((studentAsgnScore / totalAsgnItems) * 100) : null;
            const forumPct = forumCount > 0 ? Math.round((studentForumsDone / forumCount) * 100) : null;

            // Combined Personal Mastery Standing synthesized across available topic pillars
            const activePillars = [];
            if (asmtPct !== null) activePillars.push(asmtPct);
            if (asgnPct !== null) activePillars.push(asgnPct);
            if (forumPct !== null) activePillars.push(forumPct);

            let studentTopicStanding = null;
            if (activePillars.length > 0) {
                studentTopicStanding = Math.round(activePillars.reduce((sum, p) => sum + p, 0) / activePillars.length);
            }

            // At risk condition: overall topic score falls below 75%
            const isAtRisk = studentTopicStanding !== null ? (studentTopicStanding < 75) : false;

            return {
                student_id: sid,
                first_name: student.first_name,
                last_name: student.last_name,
                lrn_number: student.lrn_number,
                current_level: student.current_level,
                asmt_completed: studentAsmtCompleted,
                asmt_count: asmtCount,
                asmt_score: studentAsmtScore,
                asmt_total: totalAsmtItems,
                asmt_pct: asmtPct,
                asgn_completed: studentAsgnCompleted,
                asgn_count: asgnCount,
                asgn_score: studentAsgnScore,
                asgn_total: totalAsgnItems,
                asgn_pct: asgnPct,
                forums_done: studentForumsDone,
                forums_total: forumCount,
                forum_pct: forumPct,
                total_exp_topic: studentAsmtExp + studentAsgnExp + studentForumExp,
                topic_score: studentTopicStanding,
                is_at_risk: isAtRisk
            };
        });

        // Topic-Level Class Metrics
        const atRiskStudents = studentBreakdown.filter(s => s.is_at_risk);
        const noOfStudentsAtRisk = atRiskStudents.length;

        // Class Assessment Avg
        const classAsmtAvg = classAsmtMaxPossible > 0
            ? Math.round((classAsmtScoreObtained / classAsmtMaxPossible) * 100)
            : null;

        // Class Assignment Avg
        const classAsgnAvg = classAsgnMaxPossible > 0
            ? Math.round((classAsgnScoreObtained / classAsgnMaxPossible) * 100)
            : null;

        // Class Forum Completion Percentage
        const classForumCompletionPct = classForumExpected > 0
            ? Math.round((classForumDoneCount / classForumExpected) * 100)
            : null;

        // Overall Class Risk Percentage: ratio of Students at Risk to total active enrolled students
        const overallClassRiskPct = totalEnrolled > 0
            ? Number(((noOfStudentsAtRisk / totalEnrolled) * 100).toFixed(1))
            : 0.0;

        return {
            topic_id: topic.topic_id,
            topic_name: (topic.topic_name || '').replace(/\s+/g, ' ').trim(),
            topic_description: topic.topic_description,
            quarter_number: topic.quarter_number,
            subject_id: topic.subject_id,
            subject_name: topic.subject_name,
            total_enrolled: totalEnrolled,
            total_tasks_count: topicTasks.length,
            asmt_count: topicAsmts.length,
            asgn_count: topicAsgns.length,
            forum_count: forumCount,
            no_of_students_at_risk: noOfStudentsAtRisk,
            class_asmt_avg: classAsmtAvg,
            class_asgn_avg: classAsgnAvg,
            class_forum_completion_pct: classForumCompletionPct,
            overall_class_risk_pct: overallClassRiskPct,
            at_risk_students: atRiskStudents,
            student_breakdown: studentBreakdown
        };
    });

    // 8. Sort Topics: Highest Risk First (descending overall_class_risk_pct, then no_of_students_at_risk DESC)
    topicRemediationResults.sort((a, b) => {
        if (b.overall_class_risk_pct !== a.overall_class_risk_pct) {
            return b.overall_class_risk_pct - a.overall_class_risk_pct;
        }
        return b.no_of_students_at_risk - a.no_of_students_at_risk;
    });

    return topicRemediationResults;
}

/**
 * Simulation Slug to Quarter Mapping for Curriculum Isolation
 */
const SIMULATION_QUARTER_MAP = {
    // Quarter 1: Atomic Structure, Quantum Theory, Isotopes, Measurement, Matter
    'build-an-atom': 1,
    'isotopes-and-atomic-mass': 1,
    'models-of-the-hydrogen-atom': 1,
    'rutherford-scattering': 1,
    'states-of-matter': 1,
    'states-of-matter-basics': 1,
    'density': 1,
    'molecules-and-light': 1,
    'blackbody-spectrum': 1,

    // Quarter 2: Chemical Bonding, Molecular Structure, Compounds, Nomenclature
    'build-a-molecule': 2,
    'molecule-shapes': 2,
    'molecule-shapes-basics': 2,
    'molecule-polarity': 2,
    'atomic-interactions': 2,

    // Quarter 3: Stoichiometry, Chemical Reactions, Mass Conservation
    'balancing-chemical-equations': 3,
    'reactants-products-and-leftovers': 3,

    // Quarter 4: Solutions, Molarity, Concentration, Acid-Base Chemistry
    'acid-base-solutions': 4,
    'concentration': 4,
    'molarity': 4,
    'beers-law-lab': 4
};

/**
 * Shared Helper: Compute Master Class Gradebook & Assessment Summary Data
 * Evaluates comprehensive class standing across Coursework (Written Works, Performance Tasks, Forums),
 * Interactive Simulations (Arcade & Lab Quizzes), Attendance, and DepEd 75% Passing Threshold.
 * Scoped to a specific class (or all classes taught by teacher).
 */
async function computeClassGradebookData(conn, classId, teacherId, options = {}) {
    const dbConn = conn || db;
    const isMultiClass = !classId || classId === 'all';
    const filterQuarter = options.quarter ? parseInt(options.quarter, 10) : null;
    const filterStanding = options.standing || null; // 'passed', 'at_risk', 'incomplete'

    // Configurable Gradebook Weights (Teacher Modal or DepEd Default)
    // Part 1 (LMS Avg = 100%): Assessments + Assignments + Forums + Simulations + Syllabus
    // Part 2 (Final Grade = 100%): LMS Avg + Attendance Percentage
    const rawWeights = options.weights || {};
    const parseWeight = (val, def) => {
        if (val === undefined || val === null || val === '') return def;
        const n = Number(val);
        return (!isNaN(n) && n >= 0 && n <= 100) ? Math.round(n * 100) / 100 : def;
    };
    const weights = {
        asmt: parseWeight(rawWeights.asmt, 30),
        asgn: parseWeight(rawWeights.asgn, 30),
        forum: parseWeight(rawWeights.forum, 10),
        sim: parseWeight(rawWeights.sim, 20),
        syllabus: parseWeight(rawWeights.syllabus, 10),
        lms: parseWeight(rawWeights.lms, 80),
        att: parseWeight(rawWeights.att, 20),
        q1: parseWeight(rawWeights.q1 || rawWeights.w_q1, 50),
        q2: parseWeight(rawWeights.q2 || rawWeights.w_q2, 50),
        q3: parseWeight(rawWeights.q3 || rawWeights.w_q3, 50),
        q4: parseWeight(rawWeights.q4 || rawWeights.w_q4, 50)
    };
    const round1 = (num) => Math.round((Number(num) + Number.EPSILON) * 10) / 10;

    const activeSY = await academicHelper.getCurrentSchoolYear(dbConn);
    const activeSyId = activeSY ? activeSY.sy_id : null;
    const passingThreshold = options.passingThreshold || (activeSY ? Number(activeSY.passing_threshold || 75) : 75.0);

    // 1. Fetch Target Classes
    let classQuery = `
        SELECT c.class_id, c.class_name, c.subject_id, s.subject_name, s.subject_code, s.semester, sy.sy_range,
               COALESCE((SELECT GROUP_CONCAT(DISTINCT q.quarter_number ORDER BY q.quarter_number) FROM quarters q WHERE q.subject_id = c.subject_id), '1,2') AS quarters
        FROM classes c
        JOIN subjects s ON c.subject_id = s.subject_id
        JOIN school_years sy ON c.sy_id = sy.sy_id
        WHERE c.teacher_id = ?
    `;
    const classParams = [teacherId];

    if (!isMultiClass) {
        classQuery += ` AND c.class_id = ?`;
        classParams.push(parseInt(classId, 10));
    } else {
        classQuery += ` AND (? IS NULL OR c.sy_id = ?) ORDER BY c.class_name ASC, s.subject_name ASC`;
        classParams.push(activeSyId, activeSyId);
    }

    const [classRows] = await dbConn.query(classQuery, classParams);
    if (!classRows.length) {
        return {
            isMultiClass,
            weights,
            classes: [],
            consolidatedKpis: {
                totalEnrolled: 0, passedCount: 0, atRiskCount: 0, incompleteCount: 0,
                passingRate: 0, atRiskRate: 0, classLmsMean: null, classArcadeMean: null,
                classFinalMean: null, classAttMean: null
            }
        };
    }

    const processedClasses = [];
    let grandEnrolled = 0;
    let grandPassed = 0;
    let grandAtRisk = 0;
    let grandIncomplete = 0;
    const grandLmsAvgs = [];
    const grandArcadeAvgs = [];
    const grandFinalGrades = [];
    const grandAttRates = [];

    for (const cls of classRows) {
        const curClassId = cls.class_id;
        const curSubjectId = cls.subject_id;
        const validQuarters = String(cls.quarters || '1,2').split(',').map(Number).filter(n => !isNaN(n));

        // Guard against Quarter-vs-Subject mismatch (e.g., Chemistry 1 only covers Q1 & Q2; Chemistry 2 covers Q3 & Q4)
        let effectiveQuarter = filterQuarter;
        if (filterQuarter && !validQuarters.includes(filterQuarter)) {
            if (isMultiClass) {
                // In Multi-Class ("All Classes") mode, skip classes whose subject does not belong to the requested quarter
                continue;
            } else {
                // In Single-Class mode, safely fall back to all valid quarters of this class's subject
                effectiveQuarter = null;
            }
        }
        cls.validQuarters = validQuarters;
        cls.effectiveQuarter = effectiveQuarter;
        cls.effectiveQuarterDesc = effectiveQuarter
            ? `Quarter ${effectiveQuarter}`
            : `All Quarters (${validQuarters.map(q => 'Q' + q).join(' & ')})`;

        // 2. Fetch Active Enrolled Students
        const [enrolledStudents] = await dbConn.query(`
            SELECT DISTINCT cs.student_id, u.user_id, u.first_name, u.middle_name, u.last_name, u.lrn_number,
                   u.sex, u.strand, u.section, u.grade_level, u.current_level, u.total_exp, u.email
            FROM class_students cs
            JOIN users u ON cs.student_id = u.user_id
            WHERE cs.class_id = ? AND u.role = 'Student'
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [curClassId]);

        const totalEnrolled = enrolledStudents.length;
        const studentIds = enrolledStudents.map(s => s.student_id);

        if (totalEnrolled === 0) {
            processedClasses.push({
                classInfo: cls,
                taskCounts: { asmtCount: 0, asgnCount: 0, forumCount: 0, totalTasks: 0 },
                kpis: {
                    totalEnrolled: 0, passedCount: 0, atRiskCount: 0, incompleteCount: 0,
                    passingRate: 0, atRiskRate: 0, classLmsMean: null, classArcadeMean: null,
                    classFinalMean: null, classAttMean: null
                },
                students: []
            });
            continue;
        }

        // 3. Fetch Coursework Tasks Scoped to Class Subject & Effective Quarter
        let taskSql = `
            SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.category,
                   COALESCE(a.total_items, 10) AS total_items, t.topic_id, t.topic_name, q.quarter_number
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
        `;
        const taskParams = [curSubjectId];
        if (effectiveQuarter) {
            taskSql += ` AND q.quarter_number = ?`;
            taskParams.push(effectiveQuarter);
        }
        taskSql += ` ORDER BY q.quarter_number ASC, t.topic_id ASC, a.assessment_id ASC`;

        const [tasks] = await dbConn.query(taskSql, taskParams);
        const taskIds = tasks.map(t => t.assessment_id);

        const topicAsmts = tasks.filter(t => t.assessment_type !== 'Assignment');
        const topicAsgns = tasks.filter(t => t.assessment_type === 'Assignment');

        // 4. Fetch Discussion Forums Scoped to Class Subject (ft.subject_id) & Effective Quarter
        // Includes general subject-level forums (topic_id IS NULL) and prevents cross-subject topic leakage
        const [rawForums] = await dbConn.query(`
            SELECT ft.forum_id, ft.topic_id, ft.title, COALESCE(ft.base_exp, 100) AS base_exp,
                   COALESCE(
                       CASE WHEN q.subject_id = ft.subject_id THEN q.quarter_number ELSE NULL END,
                       (SELECT MIN(q2.quarter_number) FROM quarters q2 WHERE q2.subject_id = ft.subject_id)
                   ) AS quarter_number
            FROM forum_topics ft
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ft.subject_id = ?
            ORDER BY quarter_number ASC, ft.topic_id ASC, ft.forum_id ASC
        `, [curSubjectId]);
        const forums = effectiveQuarter
            ? rawForums.filter(f => Number(f.quarter_number) === effectiveQuarter)
            : rawForums;

        // 5. Fetch Scores for Tasks
        let lmsScores = [];
        let arcadeScores = [];
        let forumDoneRecords = [];
        let simSubmissions = [];

        if (studentIds.length > 0 && taskIds.length > 0) {
            const [lms] = await dbConn.query(`
                SELECT ss.student_id, ss.assessment_id, ss.score_obtained, ss.total_possible_score, ss.exp_gained
                FROM student_scores ss
                WHERE ss.student_id IN (?) AND ss.assessment_id IN (?)
            `, [studentIds, taskIds]);
            lmsScores = lms;

            const [arc] = await dbConn.query(`
                SELECT esg.student_id, esg.assessment_id, esg.correct_answers AS score_obtained,
                       esg.points_possible AS total_possible_score, esg.points_earned AS exp_gained, esg.grade_percent
                FROM elementa_student_grades esg
                WHERE esg.student_id IN (?) AND esg.assessment_id IN (?) AND esg.class_id = ? AND esg.run_status = 'Completed'
            `, [studentIds, taskIds, curClassId]);
            arcadeScores = arc;
        }

        // 6. Fetch Forum Done Records
        if (studentIds.length > 0 && forums.length > 0) {
            const forumIds = forums.map(f => f.forum_id);
            const [fd] = await dbConn.query(`
                SELECT sfd.student_id, sfd.forum_id, sfd.exp_awarded
                FROM student_forum_done sfd
                WHERE sfd.student_id IN (?) AND sfd.forum_id IN (?)
            `, [studentIds, forumIds]);
            forumDoneRecords = fd;
        }

        // 7. Fetch Simulation Laboratory Quiz Submissions (Scoped to Effective Quarter or Class Subject's Valid Quarters)
        if (studentIds.length > 0) {
            const [sims] = await dbConn.query(`
                SELECT esqs.student_id, esqs.quiz_id, esqs.simulation_slug, esqs.score, esqs.total_questions,
                       esqs.percentage, esqs.exp_earned
                FROM elementa_simulation_quiz_submissions esqs
                WHERE esqs.student_id IN (?)
            `, [studentIds]);

            if (effectiveQuarter) {
                simSubmissions = sims.filter(s => SIMULATION_QUARTER_MAP[s.simulation_slug] === effectiveQuarter);
            } else {
                simSubmissions = sims.filter(s => validQuarters.includes(SIMULATION_QUARTER_MAP[s.simulation_slug]));
            }
        }

        // 8. Fetch Attendance Records for this Class
        const [attRecords] = await dbConn.query(`
            SELECT student_id,
                   COUNT(*) AS total_days,
                   SUM(status = 'Present') AS present_days,
                   SUM(status = 'Late') AS late_days,
                   SUM(status = 'Absent') AS absent_days,
                   SUM(status = 'Excused') AS excused_days
            FROM attendance_records
            WHERE class_id = ? AND student_id IN (?)
            GROUP BY student_id
        `, [curClassId, studentIds]);

        const attMap = new Map();
        for (const ar of attRecords) {
            attMap.set(ar.student_id, {
                total_days: Number(ar.total_days || 0),
                present_days: Number(ar.present_days || 0),
                late_days: Number(ar.late_days || 0),
                absent_days: Number(ar.absent_days || 0),
                excused_days: Number(ar.excused_days || 0)
            });
        }

        // 9. Fetch Syllabus Progress
        const [progRows] = await dbConn.query(`
            SELECT student_id, progress_percent
            FROM student_progress
            WHERE subject_id = ? AND student_id IN (?)
        `, [curSubjectId, studentIds]);

        const progMap = new Map();
        for (const pr of progRows) {
            progMap.set(pr.student_id, Number(pr.progress_percent || 0));
        }

        // 10. Compute Effective Total Items Map (guards against rubric/grading scale mismatch)
        const taskMaxPossibleMap = new Map();
        for (const sc of lmsScores) {
            const cur = taskMaxPossibleMap.get(sc.assessment_id) || 0;
            const tot = Number(sc.total_possible_score) || 0;
            if (tot > cur) taskMaxPossibleMap.set(sc.assessment_id, tot);
        }
        for (const arc of arcadeScores) {
            const cur = taskMaxPossibleMap.get(arc.assessment_id) || 0;
            const tot = Number(arc.total_possible_score) || 0;
            if (tot > cur) taskMaxPossibleMap.set(arc.assessment_id, tot);
        }

        const effectiveTaskItems = new Map();
        for (const t of tasks) {
            const recordedMax = taskMaxPossibleMap.get(t.assessment_id) || 0;
            effectiveTaskItems.set(t.assessment_id, Math.max(Number(t.total_items) || 0, recordedMax, 1));
        }

        // Student-Task Score Map: key = `${studentId}_${assessmentId}`
        const studentScoreMap = new Map();
        for (const sc of lmsScores) {
            const key = `${sc.student_id}_${sc.assessment_id}`;
            const eff = Number(sc.total_possible_score) || effectiveTaskItems.get(sc.assessment_id) || 10;
            const score = Number(sc.score_obtained) || 0;
            const pct = eff > 0 ? (score / eff) * 100 : 0;
            if (!studentScoreMap.has(key) || pct > studentScoreMap.get(key).pct) {
                studentScoreMap.set(key, { score, total: eff, pct, exp: Number(sc.exp_gained) || 0, source: 'lms' });
            }
        }
        for (const arc of arcadeScores) {
            const key = `${arc.student_id}_${arc.assessment_id}`;
            const eff = Number(arc.total_possible_score) || effectiveTaskItems.get(arc.assessment_id) || 10;
            const score = Number(arc.score_obtained) || 0;
            const pct = eff > 0 ? (score / eff) * 100 : 0;
            if (!studentScoreMap.has(key) || pct > studentScoreMap.get(key).pct) {
                studentScoreMap.set(key, { score, total: eff, pct, exp: Number(arc.exp_gained) || 0, source: 'arcade' });
            }
        }

        // Forum Map
        const forumDoneMap = new Map();
        for (const f of forumDoneRecords) {
            forumDoneMap.set(`${f.student_id}_${f.forum_id}`, {
                exp: Number(f.exp_awarded) || 0
            });
        }

        // Simulation Submissions Map
        const studentSimMap = new Map();
        for (const sim of simSubmissions) {
            const sid = sim.student_id;
            if (!studentSimMap.has(sid)) studentSimMap.set(sid, []);
            studentSimMap.get(sid).push({
                percentage: Number(sim.percentage || 0),
                exp: Number(sim.exp_earned || 0)
            });
        }

        // Total denominators
        const totalAsmtItems = topicAsmts.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || 10), 0);
        const totalAsgnItems = topicAsgns.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || 10), 0);
        const totalAsmtCount = topicAsmts.length;
        const totalAsgnCount = topicAsgns.length;
        const totalForums = forums.length;

        // 11. Process Each Student
        let classPassed = 0;
        let classAtRisk = 0;
        let classIncomplete = 0;
        const validLmsAvgs = [];
        const validArcadeAvgs = [];
        const validFinalGrades = [];
        const validAttRates = [];

        const studentBreakdown = enrolledStudents.map((st, idx) => {
            const sid = st.student_id;

            // Attendance
            const attData = attMap.get(sid) || { total_days: 0, present_days: 0, late_days: 0, absent_days: 0, excused_days: 0 };
            const attRate = attData.total_days > 0
                ? Math.round(((attData.present_days + attData.late_days) / attData.total_days) * 100)
                : null;
            if (attRate !== null) {
                validAttRates.push(attRate);
                grandAttRates.push(attRate);
            }

            // Assessments (Written Works)
            let studentAsmtScore = 0;
            let studentAsmtSubmittedItems = 0;
            let studentAsmtExp = 0;
            let studentAsmtSubmissions = 0;
            for (const asmt of topicAsmts) {
                const sc = studentScoreMap.get(`${sid}_${asmt.assessment_id}`);
                if (sc) {
                    studentAsmtScore += sc.score;
                    studentAsmtSubmittedItems += sc.total;
                    studentAsmtExp += sc.exp;
                    studentAsmtSubmissions++;
                }
            }

            // Assignments (Performance Tasks)
            let studentAsgnScore = 0;
            let studentAsgnSubmittedItems = 0;
            let studentAsgnExp = 0;
            let studentAsgnSubmissions = 0;
            for (const asgn of topicAsgns) {
                const sc = studentScoreMap.get(`${sid}_${asgn.assessment_id}`);
                if (sc) {
                    studentAsgnScore += sc.score;
                    studentAsgnSubmittedItems += sc.total;
                    studentAsgnExp += sc.exp;
                    studentAsgnSubmissions++;
                }
            }

            // Forums (Class Participation)
            let studentForumsDone = 0;
            let studentForumExp = 0;
            for (const f of forums) {
                const fd = forumDoneMap.get(`${sid}_${f.forum_id}`);
                if (fd) {
                    studentForumsDone++;
                    studentForumExp += fd.exp;
                }
            }

            // Interactive Simulations (Elementa Simulation Lab Quizzes only — avoids double-counting Arcade Assessments)
            const simList = studentSimMap.get(sid) || [];
            const interactivePcts = [];
            let totalSimBonusExp = 0;

            for (const sim of simList) {
                interactivePcts.push(sim.percentage);
                totalSimBonusExp += sim.exp;
            }

            let arcadeAvg = null;
            if (interactivePcts.length > 0) {
                arcadeAvg = Math.round(interactivePcts.reduce((a, b) => a + b, 0) / interactivePcts.length);
                validArcadeAvgs.push(arcadeAvg);
                grandArcadeAvgs.push(arcadeAvg);
            }

            const syllabusProgress = progMap.get(sid) || 0;

            // Determine whether the student has participated in any coursework/simulations in this scope.
            // Students with zero submissions across all pillars are marked INCOMPLETE (not 0%).
            // Active students are evaluated against the FULL curriculum denominator (totalAsmtItems, totalAsgnItems, totalForums)
            // so completing 1/24 assessments is never falsely rewarded as 100%.
            const hasCourseworkActivity = (
                studentAsmtSubmissions > 0 ||
                studentAsgnSubmissions > 0 ||
                studentForumsDone > 0 ||
                interactivePcts.length > 0
            );

            const asmtPct = (hasCourseworkActivity && totalAsmtItems > 0)
                ? Math.round((studentAsmtScore / totalAsmtItems) * 100)
                : null;

            const asgnPct = (hasCourseworkActivity && totalAsgnItems > 0)
                ? Math.round((studentAsgnScore / totalAsgnItems) * 100)
                : null;

            const forumPct = (hasCourseworkActivity && totalForums > 0)
                ? Math.round((studentForumsDone / totalForums) * 100)
                : null;

            // PART 1: LMS Coursework Average (LMS Avg)
            // Direct percentage contribution: Component Grade * (Weight / 100)
            // Includes: Assessments + Assignments + Forums + Simulations + Syllabus Progress
            let lmsAvg = null;
            if (hasCourseworkActivity) {
                const effAsmtPct = asmtPct !== null ? asmtPct : 0;
                const effAsgnPct = asgnPct !== null ? asgnPct : 0;
                const effForumPct = forumPct !== null ? forumPct : 0;
                const effSimPct = arcadeAvg !== null ? arcadeAvg : 0;
                const effSylPct = syllabusProgress || 0;

                const asmtPart = effAsmtPct * (weights.asmt / 100);
                const asgnPart = effAsgnPct * (weights.asgn / 100);
                const forumPart = effForumPct * (weights.forum / 100);
                const simPart = effSimPct * (weights.sim / 100);
                const syllabusPart = effSylPct * (weights.syllabus / 100);

                lmsAvg = round1(asmtPart + asgnPart + forumPart + simPart + syllabusPart);
                validLmsAvgs.push(lmsAvg);
                grandLmsAvgs.push(lmsAvg);
            }

            // PART 2: Composite Final Grade (Legacy Coursework + Attendance)
            let finalGrade = null;
            if (hasCourseworkActivity && lmsAvg !== null) {
                const effAttRate = attRate !== null ? attRate : 0;
                const lmsFinalPart = lmsAvg * (weights.lms / 100);
                const attFinalPart = effAttRate * (weights.att / 100);
                finalGrade = round1(lmsFinalPart + attFinalPart);
            }

            // PART 3: DEPED QUARTERLY GRADE COMPUTATION ENGINE
            const quarterGrades = {};
            for (const qNum of validQuarters) {
                const qAsmts = topicAsmts.filter(a => Number(a.quarter_number) === qNum);
                const qTotalAsmtItems = qAsmts.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || 10), 0);
                let qAsmtScore = 0;
                let qAsmtSubs = 0;
                for (const a of qAsmts) {
                    const sc = studentScoreMap.get(`${sid}_${a.assessment_id}`);
                    if (sc) {
                        qAsmtScore += sc.score;
                        qAsmtSubs++;
                    }
                }

                const qAsgns = topicAsgns.filter(a => Number(a.quarter_number) === qNum);
                const qTotalAsgnItems = qAsgns.reduce((sum, a) => sum + (effectiveTaskItems.get(a.assessment_id) || 10), 0);
                let qAsgnScore = 0;
                let qAsgnSubs = 0;
                for (const a of qAsgns) {
                    const sc = studentScoreMap.get(`${sid}_${a.assessment_id}`);
                    if (sc) {
                        qAsgnScore += sc.score;
                        qAsgnSubs++;
                    }
                }

                const qForums = forums.filter(f => Number(f.quarter_number) === qNum);
                let qForumsDone = 0;
                for (const f of qForums) {
                    if (forumDoneMap.has(`${sid}_${f.forum_id}`)) {
                        qForumsDone++;
                    }
                }

                const qSims = simList.filter(s => SIMULATION_QUARTER_MAP[s.simulation_slug] === qNum);
                let qSimAvg = null;
                if (qSims.length > 0) {
                    qSimAvg = Math.round(qSims.reduce((sum, s) => sum + s.percentage, 0) / qSims.length);
                }

                const qHasActivity = (qAsmtSubs > 0 || qAsgnSubs > 0 || qForumsDone > 0 || qSims.length > 0);
                const qAsmtPct = (qHasActivity && qTotalAsmtItems > 0) ? Math.round((qAsmtScore / qTotalAsmtItems) * 100) : null;
                const qAsgnPct = (qHasActivity && qTotalAsgnItems > 0) ? Math.round((qAsgnScore / qTotalAsgnItems) * 100) : null;
                const qForumPct = (qHasActivity && qForums.length > 0) ? Math.round((qForumsDone / qForums.length) * 100) : null;

                let qLmsAvg = null;
                let qFinalGrade = null;
                if (qHasActivity) {
                    const pAsmt = (qAsmtPct !== null ? qAsmtPct : 0) * (weights.asmt / 100);
                    const pAsgn = (qAsgnPct !== null ? qAsgnPct : 0) * (weights.asgn / 100);
                    const pForum = (qForumPct !== null ? qForumPct : 0) * (weights.forum / 100);
                    const pSim = (qSimAvg !== null ? qSimAvg : 0) * (weights.sim / 100);
                    const pSyl = (syllabusProgress || 0) * (weights.syllabus / 100);
                    qLmsAvg = round1(pAsmt + pAsgn + pForum + pSim + pSyl);

                    const effAtt = attRate !== null ? attRate : 0;
                    qFinalGrade = round1((qLmsAvg * (weights.lms / 100)) + (effAtt * (weights.att / 100)));
                }

                quarterGrades[qNum] = {
                    quarter: qNum,
                    hasActivity: qHasActivity,
                    asmtPct: qAsmtPct,
                    asgnPct: qAsgnPct,
                    forumPct: qForumPct,
                    simPct: qSimAvg,
                    lmsAvg: qLmsAvg,
                    finalGrade: qFinalGrade
                };
            }

            const q1Grade = quarterGrades[1]?.finalGrade ?? null;
            const q2Grade = quarterGrades[2]?.finalGrade ?? null;
            const q3Grade = quarterGrades[3]?.finalGrade ?? null;
            const q4Grade = quarterGrades[4]?.finalGrade ?? null;

            let semestralGrade = null;
            const isSem1 = validQuarters.includes(1) || validQuarters.includes(2);
            const isSem2 = validQuarters.includes(3) || validQuarters.includes(4);

            if (isSem1) {
                const w1 = weights.q1 || 50;
                const w2 = weights.q2 || 50;
                const totW = (w1 + w2) || 100;
                const normW1 = w1 / totW;
                const normW2 = w2 / totW;

                if (q1Grade !== null && q2Grade !== null) {
                    semestralGrade = round1((q1Grade * normW1) + (q2Grade * normW2));
                } else if (q1Grade !== null) {
                    semestralGrade = q1Grade;
                } else if (q2Grade !== null) {
                    semestralGrade = q2Grade;
                }
            } else if (isSem2) {
                const w3 = weights.q3 || 50;
                const w4 = weights.q4 || 50;
                const totW = (w3 + w4) || 100;
                const normW3 = w3 / totW;
                const normW4 = w4 / totW;

                if (q3Grade !== null && q4Grade !== null) {
                    semestralGrade = round1((q3Grade * normW3) + (q4Grade * normW4));
                } else if (q3Grade !== null) {
                    semestralGrade = q3Grade;
                } else if (q4Grade !== null) {
                    semestralGrade = q4Grade;
                }
            }

            // Prerequisite Evaluation against passing threshold
            let chem2Eligibility = {
                status: 'N/A',
                badge: 'N/A',
                code: 'NA',
                color: 'slate',
                message: 'Not applicable'
            };

            const isChem1 = (cls.subject_name && cls.subject_name.toLowerCase().includes('chemistry 1')) || isSem1;
            if (isChem1) {
                if (q1Grade !== null && q2Grade !== null) {
                    if (semestralGrade >= passingThreshold) {
                        chem2Eligibility = {
                            status: 'ELIGIBLE',
                            badge: 'Eligible for Chem 2',
                            code: 'PASSED',
                            color: 'emerald',
                            message: `Passed Chem 1 (Semestral Grade: ${semestralGrade}%, Req: ≥${passingThreshold}%)`
                        };
                    } else {
                        chem2Eligibility = {
                            status: 'INELIGIBLE',
                            badge: 'Prerequisite Failed',
                            code: 'FAILED',
                            color: 'rose',
                            message: `Failed prerequisite (Semestral Grade: ${semestralGrade}%, Req: ≥${passingThreshold}%)`
                        };
                    }
                } else {
                    chem2Eligibility = {
                        status: 'PENDING',
                        badge: 'Pending Quarters',
                        code: 'PENDING',
                        color: 'amber',
                        message: 'Both Q1 and Q2 final grades required'
                    };
                }
            } else if (isSem2) {
                chem2Eligibility = {
                    status: 'CURRENT_CHEM2',
                    badge: 'Chem 2 Enrolled',
                    code: 'ENROLLED',
                    color: 'indigo',
                    message: 'Currently enrolled in Chemistry 2'
                };
            }

            // Effective Final Grade
            const effectiveFinalGrade = (effectiveQuarter && quarterGrades[effectiveQuarter]?.finalGrade !== null)
                ? quarterGrades[effectiveQuarter].finalGrade
                : (semestralGrade !== null ? semestralGrade : finalGrade);

            if (effectiveFinalGrade !== null) {
                validFinalGrades.push(effectiveFinalGrade);
                grandFinalGrades.push(effectiveFinalGrade);
            }

            // Academic Standing: DepEd Threshold & Submission Completeness
            let standing = 'Incomplete';
            if (effectiveFinalGrade !== null) {
                standing = effectiveFinalGrade >= passingThreshold ? 'Passed' : 'At-Risk';
            }

            if (standing === 'Passed') { classPassed++; grandPassed++; }
            else if (standing === 'At-Risk') { classAtRisk++; grandAtRisk++; }
            else { classIncomplete++; grandIncomplete++; }

            const totalExp = studentAsmtExp + studentAsgnExp + studentForumExp + totalSimBonusExp;

            return {
                index: idx + 1,
                student_id: sid,
                user_id: st.user_id,
                lrn_number: st.lrn_number || '—',
                first_name: st.first_name,
                middle_name: st.middle_name,
                last_name: st.last_name,
                full_name: `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`,
                sex: st.sex || '—',
                grade_level: st.grade_level,
                section: st.section,
                strand: st.strand,
                current_level: st.current_level || 1,
                total_exp: totalExp,
                total_platform_exp: st.total_exp || totalExp,

                // Attendance
                attendance: {
                    total_days: attData.total_days,
                    present_days: attData.present_days,
                    late_days: attData.late_days,
                    absent_days: attData.absent_days,
                    excused_days: attData.excused_days,
                    rate: attRate
                },

                // Coursework Components
                asmt: { score: studentAsmtScore, total: totalAsmtItems, submittedItems: studentAsmtSubmittedItems, count: totalAsmtCount, pct: asmtPct, exp: studentAsmtExp, submitted: studentAsmtSubmissions },
                asgn: { score: studentAsgnScore, total: totalAsgnItems, submittedItems: studentAsgnSubmittedItems, count: totalAsgnCount, pct: asgnPct, exp: studentAsgnExp, submitted: studentAsgnSubmissions },
                forum: { completed: studentForumsDone, total: totalForums, pct: forumPct, exp: studentForumExp },

                // DepEd Quarterly & Semestral Breakdown
                quarter_grades: quarterGrades,
                q1_grade: q1Grade,
                q2_grade: q2Grade,
                q3_grade: q3Grade,
                q4_grade: q4Grade,
                semestral_grade: semestralGrade,
                chem2_eligibility: chem2Eligibility,

                // Summary
                lms_avg: lmsAvg,
                arcade_avg: arcadeAvg,
                final_grade: effectiveFinalGrade,
                syllabus_progress: syllabusProgress,
                standing: standing,
                is_passed: standing === 'Passed',
                is_at_risk: standing === 'At-Risk',
                is_incomplete: standing === 'Incomplete'
            };
        });

        // Filter by standing if requested
        let filteredStudents = studentBreakdown;
        if (filterStanding === 'passed') {
            filteredStudents = studentBreakdown.filter(s => s.is_passed);
        } else if (filterStanding === 'at_risk') {
            filteredStudents = studentBreakdown.filter(s => s.is_at_risk);
        } else if (filterStanding === 'incomplete') {
            filteredStudents = studentBreakdown.filter(s => s.is_incomplete);
        }

        grandEnrolled += totalEnrolled;

        const classKpis = {
            totalEnrolled,
            passedCount: classPassed,
            atRiskCount: classAtRisk,
            incompleteCount: classIncomplete,
            passingRate: totalEnrolled > 0 ? Math.round((classPassed / totalEnrolled) * 1000) / 10 : 0,
            atRiskRate: totalEnrolled > 0 ? Math.round((classAtRisk / totalEnrolled) * 1000) / 10 : 0,
            classLmsMean: validLmsAvgs.length > 0 ? round1(validLmsAvgs.reduce((a, b) => a + b, 0) / validLmsAvgs.length) : null,
            classArcadeMean: validArcadeAvgs.length > 0 ? round1(validArcadeAvgs.reduce((a, b) => a + b, 0) / validArcadeAvgs.length) : null,
            classFinalMean: validFinalGrades.length > 0 ? round1(validFinalGrades.reduce((a, b) => a + b, 0) / validFinalGrades.length) : null,
            classAttMean: validAttRates.length > 0 ? round1(validAttRates.reduce((a, b) => a + b, 0) / validAttRates.length) : null
        };

        processedClasses.push({
            classInfo: cls,
            taskCounts: {
                asmtCount: topicAsmts.length,
                asgnCount: topicAsgns.length,
                forumCount: forums.length,
                totalTasks: tasks.length
            },
            kpis: classKpis,
            students: filteredStudents
        });
    }

    const consolidatedKpis = {
        totalEnrolled: grandEnrolled,
        passedCount: grandPassed,
        atRiskCount: grandAtRisk,
        incompleteCount: grandIncomplete,
        passingRate: grandEnrolled > 0 ? Math.round((grandPassed / grandEnrolled) * 1000) / 10 : 0,
        atRiskRate: grandEnrolled > 0 ? Math.round((grandAtRisk / grandEnrolled) * 1000) / 10 : 0,
        classLmsMean: grandLmsAvgs.length > 0 ? round1(grandLmsAvgs.reduce((a, b) => a + b, 0) / grandLmsAvgs.length) : null,
        classArcadeMean: grandArcadeAvgs.length > 0 ? round1(grandArcadeAvgs.reduce((a, b) => a + b, 0) / grandArcadeAvgs.length) : null,
        classFinalMean: grandFinalGrades.length > 0 ? round1(grandFinalGrades.reduce((a, b) => a + b, 0) / grandFinalGrades.length) : null,
        classAttMean: grandAttRates.length > 0 ? round1(grandAttRates.reduce((a, b) => a + b, 0) / grandAttRates.length) : null
    };

    return {
        isMultiClass,
        weights,
        classes: processedClasses,
        consolidatedKpis
    };
}

/**
 * Shared Helper: Fetch Filtered Report Data For A Student in a Class & Subject
 */
async function getStudentFilteredReportData(studentId, classId, subjectId, filters = {}) {
    // 1. Fetch Student demographic details
    const [studentRows] = await db.query(`
        SELECT user_id, first_name, middle_name, last_name, lrn_number,
               grade_level, section, strand, current_level, total_exp, email
        FROM users WHERE user_id = ?
    `, [studentId]);
    const student = studentRows[0] || {};
    const lvlTitle = levelProgressionService.LEVEL_TITLES[student.current_level || 1]?.title || 'Cadet';
    student.level_title = lvlTitle;

    // 2. Attendance Summary
    const [attRows] = await db.query(`
        SELECT
            COUNT(*) AS total_days,
            SUM(status = 'Present') AS present_days,
            SUM(status = 'Late') AS late_days,
            SUM(status = 'Absent') AS absent_days,
            SUM(status = 'Excused') AS excused_days
        FROM attendance_records
        WHERE student_id = ? AND class_id = ?
    `, [studentId, classId]);
    const att = attRows[0] || {};
    const totalDays = Number(att.total_days || 0);
    const presentDays = Number(att.present_days || 0);
    const lateDays = Number(att.late_days || 0);
    const absentDays = Number(att.absent_days || 0);
    const excusedDays = Number(att.excused_days || 0);
    const attRate = totalDays > 0 ? Math.round(((presentDays + lateDays) / totalDays) * 100) : null;

    // 3. Subject Syllabus Progress
    const [progRows] = await db.query(`
        SELECT progress_percent FROM student_progress
        WHERE student_id = ? AND subject_id = ?
    `, [studentId, subjectId]);
    const syllabusProgress = progRows.length ? Number(progRows[0].progress_percent || 0) : 0;

    // 4. Summary Analytics (Class-View View Score parity)
    const summary = await computeStudentSubjectSummary(studentId, subjectId);

    // 5. Component: Assessments
    let assessments = [];
    if (filters.inc_asmt !== '0' && filters.inc_asmt !== false) {
        let sql = `
            SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.category,
                   COALESCE(a.total_items, 10) AS total_items,
                   t.topic_id, t.topic_name, q.quarter_number,
                   ss.score_obtained, ss.total_possible_score, ss.exp_gained,
                   ss.date_recorded, ss.feedback,
                   CASE WHEN ss.score_obtained IS NOT NULL THEN 1 ELSE 0 END AS is_submitted
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN (
                SELECT s1.* FROM student_scores s1
                JOIN (
                    SELECT assessment_id, MAX(score_id) AS max_id
                    FROM student_scores WHERE student_id = ?
                    GROUP BY assessment_id
                ) s2 ON s1.score_id = s2.max_id
            ) ss ON a.assessment_id = ss.assessment_id
            WHERE q.subject_id = ? AND (a.assessment_type != 'Assignment' OR a.assessment_type IS NULL)
        `;
        const params = [studentId, subjectId];

        if (filters.quarter) {
            sql += ' AND q.quarter_number = ?';
            params.push(filters.quarter);
        }
        if (filters.asmt_topic) {
            sql += ' AND t.topic_id = ?';
            params.push(filters.asmt_topic);
        }
        if (filters.asmt_type) {
            sql += ' AND (a.assessment_type = ? OR a.category = ?)';
            params.push(filters.asmt_type, filters.asmt_type);
        }
        sql += ' ORDER BY q.quarter_number ASC, t.topic_id ASC, a.assessment_id ASC';

        const [rows] = await db.query(sql, params);

        assessments = rows.map(r => {
            const isSub = r.is_submitted === 1;
            const score = isSub ? Number(r.score_obtained || 0) : null;
            const items = isSub ? (Number(r.total_possible_score) || Number(r.total_items) || 10) : Number(r.total_items || 10);
            const pct = isSub && items > 0 ? Math.round((score / items) * 100) : null;
            const passed = pct !== null && pct >= 75;

            return {
                quarter_number: r.quarter_number,
                topic_name: (r.topic_name || '').replace(/\s+/g, ' ').trim(),
                assessment_name: r.assessment_name,
                assessment_type: r.assessment_type || 'Quiz',
                score: score,
                total_items: items,
                percentage: pct,
                is_submitted: isSub,
                is_passed: passed,
                status_label: !isSub ? 'Not Yet Taken' : (passed ? 'Passed' : 'Failed'),
                date_recorded: r.date_recorded,
                feedback: r.feedback
            };
        });

        // Apply status filter
        if (filters.asmt_status === 'passed') {
            assessments = assessments.filter(a => a.is_submitted && a.is_passed);
        } else if (filters.asmt_status === 'failed') {
            assessments = assessments.filter(a => a.is_submitted && !a.is_passed);
        } else if (filters.asmt_status === 'not_taken') {
            assessments = assessments.filter(a => !a.is_submitted);
        } else if (filters.asmt_status === 'both') {
            assessments = assessments.filter(a => a.is_submitted);
        }
    }

    // 6. Component: Assignments
    let assignments = [];
    if (filters.inc_asgn !== '0' && filters.inc_asgn !== false) {
        let sql = `
            SELECT a.assessment_id, a.assessment_name, a.assessment_type, a.category,
                   COALESCE(a.total_items, 100) AS total_items, a.is_group_assignment,
                   t.topic_id, t.topic_name, q.quarter_number,
                   ss.score_obtained, ss.total_possible_score, ss.exp_gained,
                   ss.date_recorded, ss.feedback,
                   CASE WHEN ss.score_obtained IS NOT NULL THEN 1 ELSE 0 END AS is_submitted
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN (
                SELECT s1.* FROM student_scores s1
                JOIN (
                    SELECT assessment_id, MAX(score_id) AS max_id
                    FROM student_scores WHERE student_id = ?
                    GROUP BY assessment_id
                ) s2 ON s1.score_id = s2.max_id
            ) ss ON a.assessment_id = ss.assessment_id
            WHERE q.subject_id = ? AND a.assessment_type = 'Assignment'
        `;
        const params = [studentId, subjectId];

        if (filters.quarter) {
            sql += ' AND q.quarter_number = ?';
            params.push(filters.quarter);
        }
        if (filters.asgn_topic) {
            sql += ' AND t.topic_id = ?';
            params.push(filters.asgn_topic);
        }
        if (filters.asgn_mode === 'individual') {
            sql += ' AND (a.is_group_assignment = 0 OR a.is_group_assignment IS NULL)';
        } else if (filters.asgn_mode === 'group') {
            sql += ' AND a.is_group_assignment = 1';
        }
        sql += ' ORDER BY q.quarter_number ASC, t.topic_id ASC, a.assessment_id ASC';

        const [rows] = await db.query(sql, params);
        assignments = rows.map(r => {
            const isSub = r.is_submitted === 1;
            const score = isSub ? Number(r.score_obtained || 0) : null;
            const items = isSub ? (Number(r.total_possible_score) || Number(r.total_items) || 100) : Number(r.total_items || 100);
            const pct = isSub && items > 0 ? Math.round((score / items) * 100) : null;
            const passed = pct !== null && pct >= 75;

            return {
                quarter_number: r.quarter_number,
                topic_name: (r.topic_name || '').replace(/\s+/g, ' ').trim(),
                assignment_name: r.assessment_name,
                mode: r.is_group_assignment ? 'Group' : 'Individual',
                score: score,
                total_items: items,
                percentage: pct,
                is_submitted: isSub,
                status_label: !isSub ? 'Pending' : (passed ? 'Passed' : 'Failed'),
                date_recorded: r.date_recorded,
                feedback: r.feedback
            };
        });
    }

    // 7. Component: Discussion Forums
    let forums = [];
    if (filters.inc_forums !== '0' && filters.inc_forums !== false) {
        let sql = `
            SELECT ft.forum_id, ft.title, ft.base_exp, ft.due_date,
                   t.topic_id,
                   COALESCE(CASE WHEN q.subject_id = ft.subject_id THEN t.topic_name ELSE NULL END, 'General Subject Forum') AS topic_name,
                   COALESCE(
                       CASE WHEN q.subject_id = ft.subject_id THEN q.quarter_number ELSE NULL END,
                       (SELECT MIN(q2.quarter_number) FROM quarters q2 WHERE q2.subject_id = ft.subject_id)
                   ) AS quarter_number,
                   sfd.done_at, sfd.exp_awarded, sfd.time_tier
            FROM forum_topics ft
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN student_forum_done sfd ON ft.forum_id = sfd.forum_id AND sfd.student_id = ?
            WHERE ft.subject_id = ?
        `;
        const params = [studentId, subjectId];

        if (filters.forum_topic) {
            sql += ' AND ft.topic_id = ?';
            params.push(filters.forum_topic);
        }
        if (filters.forum_done === 'done') {
            sql += ' AND sfd.done_at IS NOT NULL';
        } else if (filters.forum_done === 'not_done') {
            sql += ' AND sfd.done_at IS NULL';
        }
        sql += ' ORDER BY quarter_number ASC, ft.topic_id ASC, ft.forum_id ASC';

        const [rawForumRows] = await db.query(sql, params);
        const rows = filters.quarter
            ? rawForumRows.filter(r => Number(r.quarter_number) === Number(filters.quarter))
            : rawForumRows;
        forums = rows.map(r => ({
            quarter_number: r.quarter_number,
            topic_name: (r.topic_name || '').replace(/\s+/g, ' ').trim(),
            title: r.title,
            due_date: r.due_date,
            is_done: r.done_at !== null,
            done_at: r.done_at,
            exp_awarded: Number(r.exp_awarded || 0),
            status_label: r.done_at !== null ? 'Done' : 'Not Done'
        }));
    }

    // 8. Component: Simulation Quizzes
    let simulationQuizzes = [];
    if (filters.inc_sim !== '0' && filters.inc_sim !== false) {
        let sql = `
            SELECT esqs.submission_id, esqs.quiz_id, esqs.simulation_slug,
                   esqs.score, esqs.total_questions, esqs.percentage, esqs.exp_earned,
                   esqs.submitted_at,
                   q.title AS quiz_title, q.total_bonus_exp
            FROM elementa_simulation_quiz_submissions esqs
            JOIN elementa_simulation_custom_quizzes q ON esqs.quiz_id = q.quiz_id
            WHERE esqs.student_id = ?
        `;
        const params = [studentId];

        if (filters.sim_slugs) {
            const slugsArr = Array.isArray(filters.sim_slugs) ? filters.sim_slugs : filters.sim_slugs.split(',').map(s => s.trim()).filter(Boolean);
            if (slugsArr.length > 0) {
                sql += ' AND esqs.simulation_slug IN (?)';
                params.push(slugsArr);
            }
        }
        sql += ' ORDER BY esqs.submitted_at DESC';

        const [rows] = await db.query(sql, params);
        simulationQuizzes = rows.map(r => {
            const score = Number(r.score || 0);
            const total = Number(r.total_questions || 0);
            const pct = r.percentage !== null ? Number(r.percentage) : (total > 0 ? Math.round((score / total) * 100) : 0);
            const passed = pct >= 75;

            return {
                simulation_slug: r.simulation_slug,
                simulation_title: simTitleMap[r.simulation_slug] || r.simulation_slug,
                quiz_title: r.quiz_title,
                score: score,
                total_questions: total,
                percentage: pct,
                is_passed: passed,
                status_label: passed ? 'Passed' : 'Failed',
                exp_earned: Number(r.exp_earned || 0),
                submitted_at: r.submitted_at
            };
        });

        if (filters.sim_status === 'passed') {
            simulationQuizzes = simulationQuizzes.filter(sq => sq.is_passed);
        } else if (filters.sim_status === 'failed') {
            simulationQuizzes = simulationQuizzes.filter(sq => !sq.is_passed);
        }
    }

    return {
        student,
        attendance: {
            total_days: totalDays,
            present_days: presentDays,
            late_days: lateDays,
            absent_days: absentDays,
            excused_days: excusedDays,
            att_rate: attRate
        },
        syllabus_progress: syllabusProgress,
        summary,
        assessments,
        assignments,
        forums,
        simulationQuizzes
    };
}

/**
 * Shared Helper: Render single student report card page onto PDF document
 */
function renderStudentProgressReportCardPage(doc, data, options) {
    const { student, attendance, syllabus_progress, summary, assessments, assignments, forums, simulationQuizzes } = data;
    const { scopeLabel, user, auditRef, filters } = options;

    drawPdfDocumentHeader(doc, {
        title: 'STUDENT PROGRESS REPORT CARD',
        scope: scopeLabel,
        user: user,
        role: 'Teacher',
        classification: 'CONFIDENTIAL — OFFICIAL REPORT',
        auditRef: auditRef
    });

    // ── 1. Student Personal Details Header Card ──
    const infoY = doc.y;
    doc.rect(40, infoY, 515, 66).fill('#f8fafc').stroke('#cbd5e1');

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e1b4b')
       .text(`${student.last_name || '—'}, ${student.first_name || '—'}${student.middle_name ? ' ' + student.middle_name : ''}`, 52, infoY + 8);

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#4338ca')
       .text(`Lv.${student.current_level || 1} (${student.level_title || 'Cadet'})`, 360, infoY + 8, { width: 185, align: 'right' });

    doc.font('Helvetica').fontSize(8).fillColor('#475569')
       .text(`LRN: ${student.lrn_number || '—'}   |   Grade: ${student.grade_level || 'Grade 11'}   |   Section: ${student.section || '—'}   |   Strand: ${student.strand || 'STEM'}`, 52, infoY + 23);

    const attStr = attendance.att_rate !== null
        ? `${attendance.att_rate}% (${attendance.present_days} Present, ${attendance.late_days} Late, ${attendance.absent_days} Absent)`
        : 'No attendance records yet';

    doc.text(`Attendance Rate: ${attStr}   |   Total Platform EXP: ${(student.total_exp || 0).toLocaleString()} EXP`, 52, infoY + 36);
    doc.text(`Email: ${student.email || '—'}`, 52, infoY + 49);

    doc.y = infoY + 72;
    doc.moveDown(0.2);

    // ── 2. Subject Syllabus Progress ──
    const progY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#312E81').text('Subject Syllabus Progress', 40, progY);
    const pct = syllabus_progress || 0;
    const barColor = pct >= 75 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
    const barX = 220;
    const barW = 240;
    doc.rect(barX, progY, barW, 9).fill('#e2e8f0');
    if (pct > 0) doc.rect(barX, progY, barW * (Math.min(100, pct) / 100), 9).fill(barColor);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e293b').text(`${pct}% Completed`, barX + barW + 8, progY);

    doc.y = progY + 16;
    doc.moveDown(0.2);

    // ── 3. Summary Analytics KPI Strip (5 KPI Tiles) ──
    const kpiY = doc.y;
    const kpis = [
        { label: 'OVERALL MASTERY', val: `${summary.overallMastery}%`, col: summary.overallMastery >= 75 ? '#059669' : '#dc2626' },
        { label: 'ASMT AVERAGE', val: summary.asmtAvg !== null ? `${summary.asmtAvg}%` : 'N/A', col: '#0891b2' },
        { label: 'ASGN AVERAGE', val: summary.asgnAvg !== null ? `${summary.asgnAvg}%` : 'N/A', col: '#059669' },
        { label: 'FORUMS COMPLETED', val: `${summary.forumsCompleted} / ${summary.totalForums}`, col: '#7c3aed' },
        { label: 'SUBJECT EXP', val: `+${(summary.subjectTotalExp || 0).toLocaleString()}`, col: '#d97706' }
    ];

    const boxW = 515 / kpis.length;
    kpis.forEach((kpi, idx) => {
        const bx = 40 + (idx * boxW);
        doc.rect(bx, kpiY, boxW - 4, 28).fill('#f1f5f9').stroke('#cbd5e1');
        doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748b').text(kpi.label, bx + 2, kpiY + 4, { width: boxW - 8, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(kpi.col).text(kpi.val, bx + 2, kpiY + 14, { width: boxW - 8, align: 'center' });
    });

    doc.y = kpiY + 34;

    function checkPageOverflow(spaceNeeded = 30) {
        if (doc.y + spaceNeeded > 750) {
            doc.addPage();
            drawPdfDocumentHeader(doc, {
                title: 'STUDENT PROGRESS REPORT CARD',
                scope: `${scopeLabel} (Continuation — ${student.last_name || 'Student'}, ${student.first_name || ''})`,
                user: user,
                role: 'Teacher',
                classification: 'CONFIDENTIAL — OFFICIAL REPORT',
                auditRef: auditRef,
                isContinuation: true
            });
            return true;
        }
        return false;
    }

    // ── 4. Table 1: Assessments Table ──
    if (filters.inc_asmt !== '0' && filters.inc_asmt !== false) {
        checkPageOverflow(50);
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#312E81').text('1. Academic Assessments & Quizzes', 40);
        doc.moveDown(0.2);

        function drawAsmtHeader() {
            const hY = doc.y;
            doc.rect(40, hY, 515, 13).fill('#1e293b');
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            doc.text('Q', 45, hY + 3, { width: 18 });
            doc.text('Topic', 66, hY + 3, { width: 110 });
            doc.text('Assessment Title', 180, hY + 3, { width: 145 });
            doc.text('Type', 330, hY + 3, { width: 65 });
            doc.text('Score', 400, hY + 3, { width: 45 });
            doc.text('%', 450, hY + 3, { width: 35 });
            doc.text('Status', 490, hY + 3, { width: 60 });
            doc.y = hY + 15;
        }

        drawAsmtHeader();

        if (!assessments.length) {
            doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#94a3b8').text('No assessment records match the specified filters.', 40, doc.y + 3, { align: 'center', width: 515 });
            doc.moveDown(0.5);
        } else {
            assessments.forEach((a, i) => {
                if (checkPageOverflow(16)) drawAsmtHeader();
                const y = doc.y;
                doc.rect(40, y, 515, 12).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(7);
                doc.text(`Q${a.quarter_number}`, 45, y + 2, { width: 18 });
                doc.text((a.topic_name || '').substring(0, 22), 66, y + 2, { width: 110 });
                doc.text((a.assessment_name || '').substring(0, 28), 180, y + 2, { width: 145 });
                doc.text(a.assessment_type || 'Quiz', 330, y + 2, { width: 65 });
                doc.text(a.is_submitted ? `${a.score}/${a.total_items}` : '—', 400, y + 2, { width: 45 });
                const pctColor = a.percentage >= 75 ? '#059669' : (a.percentage !== null ? '#dc2626' : '#64748b');
                doc.font('Helvetica-Bold').fillColor(pctColor).text(a.percentage !== null ? `${a.percentage}%` : '—', 450, y + 2, { width: 35 });
                const stColor = a.status_label === 'Passed' ? '#059669' : (a.status_label === 'Failed' ? '#dc2626' : '#64748b');
                doc.fillColor(stColor).text(a.status_label, 490, y + 2, { width: 60 });
                doc.y = y + 12;
            });
        }
    }

    // ── 5. Table 2: Assignments Table ──
    if (filters.inc_asgn !== '0' && filters.inc_asgn !== false) {
        checkPageOverflow(50);
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#065f46').text('2. Academic Coursework & Assignments', 40);
        doc.moveDown(0.2);

        function drawAsgnHeader() {
            const hY = doc.y;
            doc.rect(40, hY, 515, 13).fill('#065f46');
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            doc.text('Q', 45, hY + 3, { width: 18 });
            doc.text('Topic', 66, hY + 3, { width: 110 });
            doc.text('Assignment Title', 180, hY + 3, { width: 145 });
            doc.text('Mode', 330, hY + 3, { width: 65 });
            doc.text('Score', 400, hY + 3, { width: 45 });
            doc.text('%', 450, hY + 3, { width: 35 });
            doc.text('Status', 490, hY + 3, { width: 60 });
            doc.y = hY + 15;
        }

        drawAsgnHeader();

        if (!assignments.length) {
            doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#94a3b8').text('No assignment records match the specified filters.', 40, doc.y + 3, { align: 'center', width: 515 });
            doc.moveDown(0.5);
        } else {
            assignments.forEach((asg, i) => {
                if (checkPageOverflow(16)) drawAsgnHeader();
                const y = doc.y;
                doc.rect(40, y, 515, 12).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(7);
                doc.text(`Q${asg.quarter_number}`, 45, y + 2, { width: 18 });
                doc.text((asg.topic_name || '').substring(0, 22), 66, y + 2, { width: 110 });
                doc.text((asg.assignment_name || '').substring(0, 28), 180, y + 2, { width: 145 });
                doc.text(asg.mode, 330, y + 2, { width: 65 });
                doc.text(asg.is_submitted ? `${asg.score}/${asg.total_items}` : '—', 400, y + 2, { width: 45 });
                const pctColor = asg.percentage >= 75 ? '#059669' : (asg.percentage !== null ? '#dc2626' : '#64748b');
                doc.font('Helvetica-Bold').fillColor(pctColor).text(asg.percentage !== null ? `${asg.percentage}%` : '—', 450, y + 2, { width: 35 });
                const stColor = asg.status_label === 'Passed' ? '#059669' : (asg.status_label === 'Failed' ? '#dc2626' : '#64748b');
                doc.fillColor(stColor).text(asg.status_label, 490, y + 2, { width: 60 });
                doc.y = y + 12;
            });
        }
    }

    // ── 6. Table 3: Discussion Forums Table ──
    if (filters.inc_forums !== '0' && filters.inc_forums !== false) {
        checkPageOverflow(50);
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#4338ca').text('3. Discussion Forums & Class Participation', 40);
        doc.moveDown(0.2);

        function drawForumHeader() {
            const hY = doc.y;
            doc.rect(40, hY, 515, 13).fill('#312e81');
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            doc.text('Q', 45, hY + 3, { width: 18 });
            doc.text('Topic', 66, hY + 3, { width: 110 });
            doc.text('Forum Prompt', 180, hY + 3, { width: 160 });
            doc.text('Due Date', 345, hY + 3, { width: 55 });
            doc.text('Status', 405, hY + 3, { width: 50 });
            doc.text('Completed At', 460, hY + 3, { width: 55 });
            doc.text('EXP', 520, hY + 3, { width: 30 });
            doc.y = hY + 15;
        }

        drawForumHeader();

        if (!forums.length) {
            doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#94a3b8').text('No forum records match the specified filters.', 40, doc.y + 3, { align: 'center', width: 515 });
            doc.moveDown(0.5);
        } else {
            forums.forEach((f, i) => {
                if (checkPageOverflow(16)) drawForumHeader();
                const y = doc.y;
                doc.rect(40, y, 515, 12).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(7);
                doc.text(`Q${f.quarter_number}`, 45, y + 2, { width: 18 });
                doc.text((f.topic_name || '').substring(0, 22), 66, y + 2, { width: 110 });
                doc.text((f.title || '').substring(0, 32), 180, y + 2, { width: 160 });
                doc.text(f.due_date ? new Date(f.due_date).toISOString().slice(5, 10) : '—', 345, y + 2, { width: 55 });
                const stCol = f.is_done ? '#059669' : '#dc2626';
                doc.font('Helvetica-Bold').fillColor(stCol).text(f.status_label, 405, y + 2, { width: 50 });
                doc.font('Helvetica').fillColor('#64748b').text(f.done_at ? new Date(f.done_at).toISOString().slice(5, 10) : '—', 460, y + 2, { width: 55 });
                doc.font('Helvetica-Bold').fillColor('#059669').text(`+${f.exp_awarded}`, 520, y + 2, { width: 30 });
                doc.y = y + 12;
            });
        }
    }

    // ── 7. Table 4: Simulation Quizzes Table ──
    if (filters.inc_sim !== '0' && filters.inc_sim !== false) {
        checkPageOverflow(50);
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#0f766e').text('4. Interactive Simulation Quizzes (Elementa Labs)', 40);
        doc.moveDown(0.2);

        function drawSimHeader() {
            const hY = doc.y;
            doc.rect(40, hY, 515, 13).fill('#0f766e');
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            doc.text('Simulation', 45, hY + 3, { width: 125 });
            doc.text('Quiz Title', 175, hY + 3, { width: 145 });
            doc.text('Questions', 325, hY + 4, { width: 45 });
            doc.text('Score', 375, hY + 4, { width: 40 });
            doc.text('%', 420, hY + 4, { width: 35 });
            doc.text('Status', 460, hY + 4, { width: 45 });
            doc.text('Bonus EXP', 510, hY + 4, { width: 45 });
            doc.y = hY + 15;
        }

        drawSimHeader();

        if (!simulationQuizzes.length) {
            doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#94a3b8').text('No simulation quiz records match the specified filters.', 40, doc.y + 3, { align: 'center', width: 515 });
            doc.moveDown(0.5);
        } else {
            simulationQuizzes.forEach((sq, i) => {
                if (checkPageOverflow(16)) drawSimHeader();
                const y = doc.y;
                doc.rect(40, y, 515, 12).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(7);
                doc.text((sq.simulation_title || sq.simulation_slug).substring(0, 24), 45, y + 2, { width: 125 });
                doc.text((sq.quiz_title || 'Simulation Quiz').substring(0, 28), 175, y + 2, { width: 145 });
                doc.text(String(sq.total_questions), 325, y + 2, { width: 45 });
                doc.text(`${sq.score}/${sq.total_questions}`, 375, y + 2, { width: 40 });
                const pctColor = sq.percentage >= 75 ? '#059669' : '#dc2626';
                doc.font('Helvetica-Bold').fillColor(pctColor).text(`${sq.percentage}%`, 420, y + 2, { width: 35 });
                const stCol = sq.is_passed ? '#059669' : '#dc2626';
                doc.fillColor(stCol).text(sq.status_label, 460, y + 2, { width: 45 });
                doc.fillColor('#059669').text(`+${sq.exp_earned}`, 510, y + 2, { width: 45 });
                doc.y = y + 12;
            });
        }
    }
}

// ── A. Class List & Attendance — PDF ──────────────────────────────────────────
router.get('/reports/export/class-list/pdf', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    let selectedClassId = req.query.class_id || null;
    const exportTab = req.query.export_tab || 'classList';

    try {
        const isAdmin = req.user.role === 'Admin';

        // Fetch all classes assigned to this teacher in deterministic order
        const [allTeacherClasses] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_name
            FROM classes c
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            ${isAdmin ? '' : 'WHERE c.teacher_id = ?'}
            ORDER BY c.class_id ASC, c.class_name ASC
        `, isAdmin ? [] : [teacherId]);

        const isMultiClass = (selectedClassId === 'all' || !selectedClassId);
        let targetClasses = isMultiClass
            ? allTeacherClasses
            : allTeacherClasses.filter(c => String(c.class_id) === String(selectedClassId));

        if (targetClasses.length === 0 && allTeacherClasses.length > 0) {
            targetClasses = allTeacherClasses;
        }

        const auditRef = generateAuditRef(exportTab === 'attendance' ? 'ATT' : 'CLS');

        if (exportTab !== 'attendance') {
            // =========================================================================
            // ── 1. CLASS LIST & PERFORMANCE METRICS (Landscape, Dedicated Page per Class) ─
            // =========================================================================
            const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape', bufferPages: true });
            doc._currentAuditRef = auditRef;

            setExportHttpHeaders(res, `class_list_metrics_${auditRef}.pdf`, 'application/pdf');
            doc.pipe(res);

            // Sub-filters string
            const activeFilters = [];
            if (req.query.sex && req.query.sex !== 'all') activeFilters.push(`Sex: ${req.query.sex}`);
            if (req.query.mastery_bracket && req.query.mastery_bracket !== 'all') {
                const map = { advanced: 'Advanced (≥90%)', proficient: 'Proficient (75–89%)', approaching: 'Approaching (50–74%)', developing: 'Developing (<50%)' };
                activeFilters.push(`Mastery: ${map[req.query.mastery_bracket] || req.query.mastery_bracket}`);
            }
            if (req.query.asmt_bracket && req.query.asmt_bracket !== 'all') {
                const map = { intervention: 'Needs Intervention (<75%)', passing: 'Passing (≥75%)', mastery: 'Mastery Level (≥90%)', unsubmitted: 'Unsubmitted' };
                activeFilters.push(`Assessment: ${map[req.query.asmt_bracket] || req.query.asmt_bracket}`);
            }
            if (req.query.asgn_bracket && req.query.asgn_bracket !== 'all') {
                const map = { intervention: 'Needs Intervention (<75%)', passing: 'Passing (≥75%)', mastery: 'Mastery Level (≥90%)' };
                activeFilters.push(`Assignment: ${map[req.query.asgn_bracket] || req.query.asgn_bracket}`);
            }
            if (req.query.forum_status && req.query.forum_status !== 'all') {
                const map = { completed: 'All Forums Done (100%)', partial: 'In Progress (>0%)', none: 'Not Started (0%)' };
                activeFilters.push(`Forums: ${map[req.query.forum_status] || req.query.forum_status}`);
            }
            if (req.query.exp_bracket && req.query.exp_bracket !== 'all') {
                const map = { '1000_plus': '1000+ EXP', '500_to_999': '500–999 EXP', 'under_500': '<500 EXP' };
                activeFilters.push(`EXP: ${map[req.query.exp_bracket] || req.query.exp_bracket}`);
            }
            const filterSummaryStr = activeFilters.length ? `Filters: ${activeFilters.join(', ')}` : 'All Students';

            const cols = {
                num: 30,
                lrn: 54,
                name: 136,
                sex: 280,
                mastery: 314,
                asmt: 404,
                asgn: 494,
                forum: 578,
                exp: 652,
                att: 724
            };
            const widths = {
                num: 20,
                lrn: 78,
                name: 140,
                sex: 30,
                mastery: 86,
                asmt: 86,
                asgn: 80,
                forum: 70,
                exp: 68,
                att: 56
            };

            function drawTableHeader(yPos) {
                doc.rect(30, yPos, 750, 18).fill('#1e293b');
                doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                doc.text('#', cols.num, yPos + 5, { width: widths.num, align: 'center' });
                doc.text('LRN', cols.lrn, yPos + 5, { width: widths.lrn });
                doc.text('Learner Full Name', cols.name, yPos + 5, { width: widths.name });
                doc.text('Sex', cols.sex, yPos + 5, { width: widths.sex, align: 'center' });
                doc.text('Overall Mastery', cols.mastery, yPos + 5, { width: widths.mastery, align: 'center' });
                doc.text('Assessment Avg', cols.asmt, yPos + 5, { width: widths.asmt, align: 'center' });
                doc.text('Assignment Avg', cols.asgn, yPos + 5, { width: widths.asgn, align: 'center' });
                doc.text('Forums Done', cols.forum, yPos + 5, { width: widths.forum, align: 'center' });
                doc.text('Subject EXP', cols.exp, yPos + 5, { width: widths.exp, align: 'center' });
                doc.text('Attendance', cols.att, yPos + 5, { width: widths.att, align: 'center' });
                doc.y = yPos + 18;
            }

            let isFirstClassPage = true;
            let totalFilteredLearners = 0;

            for (let cIdx = 0; cIdx < targetClasses.length; cIdx++) {
                const clsItem = targetClasses[cIdx];
                if (!isFirstClassPage) {
                    doc.addPage();
                }
                isFirstClassPage = false;

                const metricsResult = await getEnrolledStudentsWithFullMetrics(clsItem.class_id, teacherId, req.user.role);
                const classInfo = metricsResult?.classInfo || clsItem;
                const rawStudents = metricsResult?.students || [];
                const students = filterStudentPerformanceMetrics(rawStudents, req.query);
                totalFilteredLearners += students.length;

                let scopeTitle = classInfo.subject_name
                    ? `${classInfo.subject_name} — Class: ${classInfo.class_name}`
                    : `Class: ${classInfo.class_name}`;
                if (rawStudents.length > 0 && rawStudents[0].grade_level) {
                    scopeTitle += ` (Gr. ${rawStudents[0].grade_level}${rawStudents[0].section ? ' ' + rawStudents[0].section : ''})`;
                }
                if (isMultiClass) {
                    scopeTitle = `[Class ${cIdx + 1} of ${targetClasses.length}] ${scopeTitle}`;
                }
                const filterScopeStr = `${scopeTitle}   •   ${filterSummaryStr}`;

                drawPdfDocumentHeader(doc, {
                    title: 'CLASS LIST & PERFORMANCE METRICS',
                    scope: filterScopeStr,
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — TEACHER COPY',
                    auditRef,
                    layout: 'landscape'
                });

                drawTableHeader(doc.y);

                if (students.length === 0) {
                    doc.moveDown(1.5);
                    doc.rect(30, doc.y, 750, 40).fill('#f8fafc').stroke('#cbd5e1');
                    doc.fillColor('#64748b').fontSize(8.5).font('Helvetica-Bold')
                       .text('No enrolled students matching the selected filter in this class.', 40, doc.y + 14, { width: 730, align: 'center' });
                    doc.moveDown(3);
                } else {
                    students.forEach((s, i) => {
                        if (doc.y > 510) {
                            doc.addPage();
                            drawPdfDocumentHeader(doc, {
                                title: 'CLASS LIST & PERFORMANCE METRICS',
                                scope: filterScopeStr,
                                user: req.user,
                                role: 'Teacher',
                                auditRef,
                                isContinuation: true,
                                layout: 'landscape'
                            });
                            drawTableHeader(doc.y);
                        }

                        const y = doc.y;
                        const bg = i % 2 === 0 ? '#f8fafc' : '#ffffff';
                        doc.rect(30, y, 750, 16).fill(bg);
                        doc.rect(30, y, 750, 16).strokeColor('#f1f5f9').lineWidth(0.5).stroke();

                        doc.fillColor('#1e293b').fontSize(7).font('Helvetica');
                        doc.text(String(i + 1), cols.num, y + 4, { width: widths.num, align: 'center' });
                        doc.text(s.lrn_number || '—', cols.lrn, y + 4, { width: widths.lrn });
                        doc.font('Helvetica-Bold').text(s.full_name || `${s.last_name}, ${s.first_name}`, cols.name, y + 4, { width: widths.name });
                        doc.font('Helvetica').text(s.sex || '—', cols.sex, y + 4, { width: widths.sex, align: 'center' });

                        // Overall Mastery
                        const mastVal = (s.overall_mastery !== null && s.overall_mastery !== undefined) ? s.overall_mastery : 0;
                        doc.font('Helvetica-Bold').fillColor(mastVal >= 75 ? '#15803d' : '#b91c1c')
                           .text(`${mastVal}%`, cols.mastery, y + 4, { width: widths.mastery, align: 'center' });

                        // Assessment Avg
                        if (s.assessment_avg !== null && s.assessment_avg !== undefined) {
                            doc.fillColor(s.assessment_avg >= 75 ? '#15803d' : '#b91c1c')
                               .text(`${s.assessment_avg}%`, cols.asmt, y + 4, { width: widths.asmt, align: 'center' });
                        } else {
                            doc.font('Helvetica').fillColor('#94a3b8').text('No Submissions', cols.asmt, y + 4, { width: widths.asmt, align: 'center' });
                        }

                        // Assignment Avg
                        if (s.assignment_avg !== null && s.assignment_avg !== undefined) {
                            doc.font('Helvetica-Bold').fillColor(s.assignment_avg >= 75 ? '#15803d' : '#b91c1c')
                               .text(`${s.assignment_avg}%`, cols.asgn, y + 4, { width: widths.asgn, align: 'center' });
                        } else {
                            doc.font('Helvetica').fillColor('#94a3b8').text('No Submissions', cols.asgn, y + 4, { width: widths.asgn, align: 'center' });
                        }

                        // Forums Done
                        doc.font('Helvetica').fillColor('#1e293b')
                           .text(`${s.forums_completed || 0} / ${s.total_subject_forums || 0}`, cols.forum, y + 4, { width: widths.forum, align: 'center' });

                        // Subject EXP
                        doc.font('Helvetica-Bold').fillColor('#0284c7')
                           .text(`${(s.subject_exp || 0).toLocaleString()} EXP`, cols.exp, y + 4, { width: widths.exp, align: 'center' });

                        // Attendance Rate
                        const attPercent = s.total_sessions > 0 ? Math.round(((s.days_present + s.days_late) / s.total_sessions) * 100) : 100;
                        doc.font('Helvetica').fillColor('#1e293b')
                           .text(`${attPercent}% (${s.days_present || 0}P)`, cols.att, y + 4, { width: widths.att, align: 'center' });

                        doc.y = y + 16;
                    });

                    if (doc.y > 510) {
                        doc.addPage();
                        drawPdfDocumentHeader(doc, {
                            title: 'CLASS LIST & PERFORMANCE METRICS',
                            scope: filterScopeStr,
                            user: req.user,
                            role: 'Teacher',
                            auditRef,
                            isContinuation: true,
                            layout: 'landscape'
                        });
                    }

                    doc.moveDown(0.6);
                    const sumY = doc.y;
                    doc.rect(30, sumY, 750, 26).fill('#f1f5f9').stroke('#cbd5e1');

                    const avgMastery = students.length > 0
                        ? Math.round(students.reduce((acc, s) => acc + (s.overall_mastery || 0), 0) / students.length)
                        : 0;
                    const interventionCount = students.filter(s => s.assessment_avg !== null && s.assessment_avg < 75).length;
                    const maleCount = students.filter(s => (s.sex || '').toLowerCase() === 'male').length;
                    const femaleCount = students.filter(s => (s.sex || '').toLowerCase() === 'female').length;

                    doc.fillColor('#1e293b').fontSize(7.5).font('Helvetica-Bold')
                       .text(`${clsItem.class_name} Summary:  ${students.length} Filtered Learners`, 40, sumY + 8);

                    doc.font('Helvetica').fontSize(7.5).fillColor('#475569')
                       .text(`Male: ${maleCount}  •  Female: ${femaleCount}  •  Class Mastery Avg: ${avgMastery}%  •  Needs Assessment Intervention: ${interventionCount} students`, 250, sumY + 8, { width: 518, align: 'right' });
                }
            }

            attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — TEACHER COPY');
            doc.end();

            await logActivity(req.user.user_id, 'Teacher', 'EXPORT_CLASS_LIST_PDF',
                `Exported Class List & Metrics PDF (Ref: ${auditRef}, Filtered Learners: ${totalFilteredLearners}, Classes: ${targetClasses.length})`);

        } else {
            // =========================================================================
            // ── 2. ATTENDANCE RECORDS (Portrait, Dedicated Page per Date & Class) ─────
            // =========================================================================
            const filterAttSource = req.query.attendance_source || 'roll_call';
            const filterAttDate = req.query.attendance_date || null;
            const filterSex = req.query.sex && req.query.sex !== 'all' ? req.query.sex : null;

            const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'portrait', bufferPages: true });
            doc._currentAuditRef = auditRef;

            const filenameSuffix = isMultiClass ? 'all_classes' : (filterAttDate ? filterAttDate.replace(/-/g, '') : 'all_dates');
            setExportHttpHeaders(res, `attendance_${filenameSuffix}_${auditRef}.pdf`, 'application/pdf');
            doc.pipe(res);

            let isFirstDocPage = true;
            let totalConductedDatesAcrossClasses = 0;

            for (let cIdx = 0; cIdx < targetClasses.length; cIdx++) {
                const clsItem = targetClasses[cIdx];
                const classScope = clsItem.subject_name
                    ? `${clsItem.subject_name} — Class: ${clsItem.class_name}`
                    : `Class: ${clsItem.class_name}`;

                let dateSql = `
                    SELECT DISTINCT DATE_FORMAT(session_date, '%Y-%m-%d') AS raw_date,
                           DATE_FORMAT(session_date, '%W, %M %e, %Y') AS formatted_date,
                           DATE_FORMAT(session_date, '%W') AS day_name
                    FROM attendance_records
                    WHERE class_id = ? AND attendance_method = 'Manual_Teacher'
                `;
                const dateParams = [clsItem.class_id];
                if (filterAttDate) {
                    dateSql += ` AND DATE_FORMAT(session_date, '%Y-%m-%d') = ?`;
                    dateParams.push(filterAttDate);
                }
                dateSql += ` ORDER BY session_date ASC`;

                const [conductedDates] = await db.execute(dateSql, dateParams);
                totalConductedDatesAcrossClasses += conductedDates.length;

                if (conductedDates.length === 0) {
                    if (!isFirstDocPage) {
                        doc.addPage();
                    }
                    isFirstDocPage = false;

                    const headerScope = isMultiClass
                        ? `[Class ${cIdx + 1} of ${targetClasses.length}] ${classScope} • No Recorded Sessions`
                        : `${classScope} • No Recorded Sessions`;

                    drawPdfDocumentHeader(doc, {
                        title: 'CLASS ATTENDANCE REPORT',
                        scope: headerScope,
                        user: req.user,
                        role: 'Teacher',
                        classification: 'CONFIDENTIAL — TEACHER COPY',
                        auditRef
                    });

                    doc.moveDown(3);
                    doc.rect(30, doc.y, 535, 70).fill('#f8fafc').stroke('#cbd5e1');
                    doc.fillColor('#334155').fontSize(11).font('Helvetica-Bold')
                       .text('No Recorded Attendance Found', 45, doc.y + 16, { width: 505, align: 'center' });
                    doc.fillColor('#64748b').fontSize(8.5).font('Helvetica')
                       .text(filterAttDate
                           ? `No teacher roll call attendance was conducted for ${clsItem.class_name} on ${filterAttDate}.`
                           : `There are currently no attendance sessions recorded by the teacher for ${clsItem.class_name} (${clsItem.subject_name || 'Subject'}).`,
                           45, doc.y + 10, { width: 505, align: 'center' });
                    continue;
                }

                for (let dIdx = 0; dIdx < conductedDates.length; dIdx++) {
                    const dateObj = conductedDates[dIdx];
                    const dateStr = dateObj.raw_date;
                    const formattedDate = dateObj.formatted_date;
                    const dayName = dateObj.day_name;

                    // ── 1. Roll Call Attendance Page (if roll_call or both) ──
                    if (filterAttSource === 'roll_call' || filterAttSource === 'both') {
                        if (!isFirstDocPage) {
                            doc.addPage();
                        }
                        isFirstDocPage = false;

                        const headerScope = isMultiClass
                            ? `[Class ${cIdx + 1} of ${targetClasses.length}] ${classScope} • Session: ${formattedDate}`
                            : `${classScope} • Session: ${formattedDate}`;

                        drawPdfDocumentHeader(doc, {
                            title: 'ROLL CALL ATTENDANCE RECORD',
                            scope: headerScope,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — TEACHER COPY',
                            auditRef
                        });

                        // Sub-banner for date
                        const sessionBannerY = doc.y;
                        doc.rect(30, sessionBannerY, 535, 22).fill('#312e81');
                        doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold')
                           .text(`SESSION DATE: ${formattedDate} (${dayName})`, 40, sessionBannerY + 6, { width: 320 });
                        doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#cbd5e1')
                           .text(`Method: Teacher Roll Call • ${clsItem.class_name}`, 370, sessionBannerY + 6, { width: 185, align: 'right' });
                        doc.y = sessionBannerY + 26;

                        let rollSql = `
                            SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                   ar.status, ar.check_in_time, ar.override_reason
                            FROM users u
                            JOIN class_students cs ON u.user_id = cs.student_id
                            LEFT JOIN attendance_records ar ON ar.student_id = u.user_id
                                  AND ar.class_id = cs.class_id
                                  AND DATE_FORMAT(ar.session_date, '%Y-%m-%d') = ?
                                  AND ar.attendance_method = 'Manual_Teacher'
                            WHERE cs.class_id = ? AND u.role = 'Student'
                        `;
                        const rollParams = [dateStr, clsItem.class_id];
                        if (filterSex) {
                            rollSql += ` AND u.sex = ?`;
                            rollParams.push(filterSex);
                        }
                        rollSql += ` ORDER BY u.last_name ASC, u.first_name ASC`;
                        const [rollStudents] = await db.execute(rollSql, rollParams);

                        const rCols = { num: 30, lrn: 52, name: 130, sex: 275, status: 310, time: 385, remarks: 450 };
                        const rWidths = { num: 18, lrn: 74, name: 140, sex: 30, status: 70, time: 60, remarks: 115 };

                        function drawRollHeader(yPos) {
                            doc.rect(30, yPos, 535, 17).fill('#1e293b');
                            doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                            doc.text('#', rCols.num, yPos + 4, { width: rWidths.num, align: 'center' });
                            doc.text('LRN', rCols.lrn, yPos + 4, { width: rWidths.lrn });
                            doc.text('Learner Full Name', rCols.name, yPos + 4, { width: rWidths.name });
                            doc.text('Sex', rCols.sex, yPos + 4, { width: rWidths.sex, align: 'center' });
                            doc.text('Status', rCols.status, yPos + 4, { width: rWidths.status, align: 'center' });
                            doc.text('Time Marked', rCols.time, yPos + 4, { width: rWidths.time, align: 'center' });
                            doc.text('Remarks / Reason', rCols.remarks, yPos + 4, { width: rWidths.remarks });
                            doc.y = yPos + 17;
                        }

                        drawRollHeader(doc.y);

                        let presCount = 0, lateCount = 0, absCount = 0, excCount = 0;

                        rollStudents.forEach((st, sIdx) => {
                            if (doc.y > 750) {
                                doc.addPage();
                                drawPdfDocumentHeader(doc, {
                                    title: 'ROLL CALL ATTENDANCE RECORD',
                                    scope: headerScope,
                                    user: req.user,
                                    role: 'Teacher',
                                    classification: 'CONFIDENTIAL — TEACHER COPY',
                                    auditRef,
                                    isContinuation: true
                                });
                                drawRollHeader(doc.y);
                            }

                            const ry = doc.y;
                            const rbg = sIdx % 2 === 0 ? '#f8fafc' : '#ffffff';
                            doc.rect(30, ry, 535, 15).fill(rbg);
                            doc.rect(30, ry, 535, 15).strokeColor('#f1f5f9').lineWidth(0.5).stroke();

                            const status = st.status || 'Unrecorded';
                            if (status === 'Present') presCount++;
                            else if (status === 'Late') lateCount++;
                            else if (status === 'Absent') absCount++;
                            else if (status === 'Excused') excCount++;

                            const statusColors = {
                                Present: '#15803d',
                                Late: '#b45309',
                                Absent: '#b91c1c',
                                Excused: '#2563eb',
                                Unrecorded: '#64748b'
                            };
                            const sColor = statusColors[status] || '#64748b';

                            doc.fillColor('#1e293b').fontSize(7).font('Helvetica');
                            doc.text(String(sIdx + 1), rCols.num, ry + 4, { width: rWidths.num, align: 'center' });
                            doc.text(st.lrn_number || '—', rCols.lrn, ry + 4, { width: rWidths.lrn });
                            const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                            doc.font('Helvetica-Bold').text(fullName, rCols.name, ry + 4, { width: rWidths.name });
                            doc.font('Helvetica').text(st.sex || '—', rCols.sex, ry + 4, { width: rWidths.sex, align: 'center' });

                            doc.font('Helvetica-Bold').fillColor(sColor).text(status.toUpperCase(), rCols.status, ry + 4, { width: rWidths.status, align: 'center' });
                            doc.font('Helvetica').fillColor('#475569').text(formatClockTime(st.check_in_time), rCols.time, ry + 4, { width: rWidths.time, align: 'center' });
                            doc.text(st.override_reason || '—', rCols.remarks, ry + 4, { width: rWidths.remarks });

                            doc.y = ry + 15;
                        });

                        if (doc.y > 750) {
                            doc.addPage();
                        }
                        doc.moveDown(0.6);
                        const rSumY = doc.y;
                        doc.rect(30, rSumY, 535, 26).fill('#f1f5f9').stroke('#cbd5e1');

                        const totalRecorded = presCount + lateCount + absCount + excCount;
                        const attRate = totalRecorded > 0 ? Math.round(((presCount + lateCount) / totalRecorded) * 100) : 0;

                        doc.fillColor('#1e293b').fontSize(7.5).font('Helvetica-Bold')
                           .text(`${clsItem.class_name} Roll Call Summary (${rollStudents.length} Students):`, 38, rSumY + 8);

                        doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                           .text(`Present: ${presCount}   •   Late: ${lateCount}   •   Absent: ${absCount}   •   Excused: ${excCount}   •   Rate: ${attRate}%`, 220, rSumY + 8, { width: 335, align: 'right' });
                    }

                    // ── 2. LMS Login Activity Page (if lms or both) ──
                    if (filterAttSource === 'lms' || filterAttSource === 'both') {
                        if (!isFirstDocPage) {
                            doc.addPage();
                        }
                        isFirstDocPage = false;

                        const headerScope = isMultiClass
                            ? `[Class ${cIdx + 1} of ${targetClasses.length}] ${classScope} • Session: ${formattedDate}`
                            : `${classScope} • Session: ${formattedDate}`;

                        drawPdfDocumentHeader(doc, {
                            title: 'LMS PORTAL LOGIN ACTIVITY REPORT',
                            scope: headerScope,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — TEACHER COPY',
                            auditRef
                        });

                        const sessionBannerY = doc.y;
                        doc.rect(30, sessionBannerY, 535, 22).fill('#0f766e');
                        doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold')
                           .text(`ACTIVITY DATE: ${formattedDate} (${dayName})`, 40, sessionBannerY + 6, { width: 320 });
                        doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#ccfbf1')
                           .text(`Method: LMS Login Authentication Logs • ${clsItem.class_name}`, 370, sessionBannerY + 6, { width: 185, align: 'right' });
                        doc.y = sessionBannerY + 26;

                        let lmsSql = `
                            SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                   al.created_at AS first_login,
                                   COUNT(al.log_id) AS login_count
                            FROM users u
                            JOIN class_students cs ON u.user_id = cs.student_id
                            LEFT JOIN activity_logs al ON al.actor_id = u.user_id
                                  AND DATE_FORMAT(al.created_at, '%Y-%m-%d') = ?
                                  AND (al.action = 'LOGIN' OR al.description LIKE '%Logged in%' OR al.action LIKE '%LOGIN%')
                            WHERE cs.class_id = ? AND u.role = 'Student'
                        `;
                        const lmsParams = [dateStr, clsItem.class_id];
                        if (filterSex) {
                            lmsSql += ` AND u.sex = ?`;
                            lmsParams.push(filterSex);
                        }
                        lmsSql += ` GROUP BY u.user_id ORDER BY u.last_name ASC, u.first_name ASC`;
                        const [lmsStudents] = await db.execute(lmsSql, lmsParams);

                        const lCols = { num: 30, lrn: 55, name: 135, sex: 285, status: 325, first: 405, sessions: 480 };
                        const lWidths = { num: 20, lrn: 75, name: 145, sex: 35, status: 75, first: 70, sessions: 80 };

                        function drawLmsHeader(yPos) {
                            doc.rect(30, yPos, 535, 17).fill('#134e4a');
                            doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                            doc.text('#', lCols.num, yPos + 4, { width: lWidths.num, align: 'center' });
                            doc.text('LRN', lCols.lrn, yPos + 4, { width: lWidths.lrn });
                            doc.text('Learner Full Name', lCols.name, yPos + 4, { width: lWidths.name });
                            doc.text('Sex', lCols.sex, yPos + 4, { width: lWidths.sex, align: 'center' });
                            doc.text('LMS Status', lCols.status, yPos + 4, { width: lWidths.status, align: 'center' });
                            doc.text('First Login', lCols.first, yPos + 4, { width: lWidths.first, align: 'center' });
                            doc.text('Total Sessions', lCols.sessions, yPos + 4, { width: lWidths.sessions, align: 'center' });
                            doc.y = yPos + 17;
                        }

                        drawLmsHeader(doc.y);

                        let loggedInCount = 0;

                        lmsStudents.forEach((st, sIdx) => {
                            if (doc.y > 750) {
                                doc.addPage();
                                drawPdfDocumentHeader(doc, {
                                    title: 'LMS PORTAL LOGIN ACTIVITY REPORT',
                                    scope: headerScope,
                                    user: req.user,
                                    role: 'Teacher',
                                    classification: 'CONFIDENTIAL — TEACHER COPY',
                                    auditRef,
                                    isContinuation: true
                                });
                                drawLmsHeader(doc.y);
                            }

                            const ly = doc.y;
                            const lbg = sIdx % 2 === 0 ? '#f0fdfa' : '#ffffff';
                            doc.rect(30, ly, 535, 15).fill(lbg);
                            doc.rect(30, ly, 535, 15).strokeColor('#f1f5f9').lineWidth(0.5).stroke();

                            const hasLogin = Number(st.login_count) > 0;
                            if (hasLogin) loggedInCount++;

                            doc.fillColor('#1e293b').fontSize(7).font('Helvetica');
                            doc.text(String(sIdx + 1), lCols.num, ly + 4, { width: lWidths.num, align: 'center' });
                            doc.text(st.lrn_number || '—', lCols.lrn, ly + 4, { width: lWidths.lrn });
                            const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                            doc.font('Helvetica-Bold').text(fullName, lCols.name, ly + 4, { width: lWidths.name });
                            doc.font('Helvetica').text(st.sex || '—', lCols.sex, ly + 4, { width: lWidths.sex, align: 'center' });

                            if (hasLogin) {
                                doc.font('Helvetica-Bold').fillColor('#047857')
                                   .text('LOGGED IN', lCols.status, ly + 4, { width: lWidths.status, align: 'center' });
                                doc.font('Helvetica').fillColor('#1e293b')
                                   .text(formatClockTime(st.first_login), lCols.first, ly + 4, { width: lWidths.first, align: 'center' });
                                doc.font('Helvetica-Bold').fillColor('#0369a1')
                                   .text(`${st.login_count} session(s)`, lCols.sessions, ly + 4, { width: lWidths.sessions, align: 'center' });
                            } else {
                                doc.font('Helvetica').fillColor('#94a3b8')
                                   .text('NO LOGIN', lCols.status, ly + 4, { width: lWidths.status, align: 'center' });
                                doc.text('—', lCols.first, ly + 4, { width: lWidths.first, align: 'center' });
                                doc.text('0', lCols.sessions, ly + 4, { width: lWidths.sessions, align: 'center' });
                            }

                            doc.y = ly + 15;
                        });

                        if (doc.y > 750) {
                            doc.addPage();
                        }
                        doc.moveDown(0.6);
                        const lSumY = doc.y;
                        doc.rect(30, lSumY, 535, 26).fill('#f1f5f9').stroke('#cbd5e1');

                        const noLoginCount = lmsStudents.length - loggedInCount;
                        const loginPct = lmsStudents.length > 0 ? Math.round((loggedInCount / lmsStudents.length) * 100) : 0;

                        doc.fillColor('#1e293b').fontSize(7.5).font('Helvetica-Bold')
                           .text(`${clsItem.class_name} LMS Engagement (${lmsStudents.length} Students):`, 38, lSumY + 8);

                        doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                           .text(`Active / Logged In: ${loggedInCount}   •   No Login: ${noLoginCount}   •   Engagement Rate: ${loginPct}%`, 220, lSumY + 8, { width: 335, align: 'right' });
                    }
                }
            }

            attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — TEACHER COPY');
            doc.end();

            await logActivity(req.user.user_id, 'Teacher', 'EXPORT_ATTENDANCE_PDF',
                `Exported Attendance PDF (Ref: ${auditRef}, Classes: ${targetClasses.length}, Source: ${filterAttSource})`);
        }

    } catch (err) {
        console.error('❌ [GET /reports/export/class-list/pdf]', err);
        res.status(500).send('PDF generation failed.');
    }
});


// ── A. Class List & Attendance — Excel ────────────────────────────────────────
router.get('/reports/export/class-list/excel', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    let selectedClassId = req.query.class_id || null;
    const exportTab = req.query.export_tab || 'classList';

    try {
        const isAdmin = req.user.role === 'Admin';

        // Fetch all classes assigned to this teacher in deterministic order
        const [allTeacherClasses] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_name
            FROM classes c
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            ${isAdmin ? '' : 'WHERE c.teacher_id = ?'}
            ORDER BY c.class_id ASC, c.class_name ASC
        `, isAdmin ? [] : [teacherId]);

        const isMultiClass = (selectedClassId === 'all' || !selectedClassId);
        let targetClasses = isMultiClass
            ? allTeacherClasses
            : allTeacherClasses.filter(c => String(c.class_id) === String(selectedClassId));

        if (targetClasses.length === 0 && allTeacherClasses.length > 0) {
            targetClasses = allTeacherClasses;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = `${req.user.first_name} ${req.user.last_name}`;
        wb.created = new Date();

        const usedSheetNames = new Set();
        function getUniqueSheetName(baseName) {
            let clean = (baseName || 'Sheet').replace(/[*?:/\\\[\]]/g, '').trim();
            if (clean.length > 31) clean = clean.substring(0, 31).trim();
            if (!clean) clean = 'Sheet';
            if (!usedSheetNames.has(clean.toLowerCase())) {
                usedSheetNames.add(clean.toLowerCase());
                return clean;
            }
            let counter = 2;
            while (true) {
                const suffix = ` (${counter})`;
                const maxLen = 31 - suffix.length;
                const candidate = clean.substring(0, maxLen).trim() + suffix;
                if (!usedSheetNames.has(candidate.toLowerCase())) {
                    usedSheetNames.add(candidate.toLowerCase());
                    return candidate;
                }
                counter++;
            }
        }

        const auditRef = generateAuditRef(exportTab === 'attendance' ? 'ATT' : 'CLS');

        if (exportTab !== 'attendance') {
            // =========================================================================
            // ── 1. CLASS LIST & PERFORMANCE METRICS (Excel, Multi-Sheet per Class) ──
            // =========================================================================
            const activeFilters = [];
            if (req.query.sex && req.query.sex !== 'all') activeFilters.push(`Sex: ${req.query.sex}`);
            if (req.query.mastery_bracket && req.query.mastery_bracket !== 'all') {
                const map = { advanced: 'Advanced (≥90%)', proficient: 'Proficient (75–89%)', approaching: 'Approaching (50–74%)', developing: 'Developing (<50%)' };
                activeFilters.push(`Mastery: ${map[req.query.mastery_bracket] || req.query.mastery_bracket}`);
            }
            if (req.query.asmt_bracket && req.query.asmt_bracket !== 'all') {
                const map = { intervention: 'Needs Intervention (<75%)', passing: 'Passing (≥75%)', mastery: 'Mastery Level (≥90%)', unsubmitted: 'Unsubmitted' };
                activeFilters.push(`Assessment: ${map[req.query.asmt_bracket] || req.query.asmt_bracket}`);
            }
            if (req.query.asgn_bracket && req.query.asgn_bracket !== 'all') {
                const map = { intervention: 'Needs Intervention (<75%)', passing: 'Passing (≥75%)', mastery: 'Mastery Level (≥90%)' };
                activeFilters.push(`Assignment: ${map[req.query.asgn_bracket] || req.query.asgn_bracket}`);
            }
            if (req.query.forum_status && req.query.forum_status !== 'all') {
                const map = { completed: 'All Forums Done (100%)', partial: 'In Progress (>0%)', none: 'Not Started (0%)' };
                activeFilters.push(`Forums: ${map[req.query.forum_status] || req.query.forum_status}`);
            }
            if (req.query.exp_bracket && req.query.exp_bracket !== 'all') {
                const map = { '1000_plus': '1000+ EXP', '500_to_999': '500–999 EXP', 'under_500': '<500 EXP' };
                activeFilters.push(`EXP: ${map[req.query.exp_bracket] || req.query.exp_bracket}`);
            }

            let totalExportedStudents = 0;

            for (let cIdx = 0; cIdx < targetClasses.length; cIdx++) {
                const clsItem = targetClasses[cIdx];
                const metricsResult = await getEnrolledStudentsWithFullMetrics(clsItem.class_id, teacherId, req.user.role);
                const classInfo = (metricsResult && metricsResult.classInfo) ? metricsResult.classInfo : clsItem;
                const rawStudents = (metricsResult && metricsResult.students) ? metricsResult.students : [];
                const students = filterStudentPerformanceMetrics(rawStudents, req.query);
                totalExportedStudents += students.length;

                // Sheet name: single-class mode uses 'Class List & Performance' for test/spec parity
                const sheetName = isMultiClass
                    ? getUniqueSheetName(classInfo.subject_name ? `${classInfo.class_name} - ${classInfo.subject_name}` : classInfo.class_name)
                    : 'Class List & Performance';

                const ws = wb.addWorksheet(sheetName);

                // Build scope label
                let scopeTitle = isMultiClass
                    ? `[Class ${cIdx + 1} of ${targetClasses.length}] ${classInfo.subject_name ? `${classInfo.subject_name} — Class: ${classInfo.class_name}` : `Class: ${classInfo.class_name}`}`
                    : (classInfo.subject_name ? `${classInfo.subject_name} — Class: ${classInfo.class_name}` : `Class: ${classInfo.class_name}`);

                if (rawStudents.length > 0 && rawStudents[0].grade_level) {
                    scopeTitle += ` (Gr. ${rawStudents[0].grade_level}${rawStudents[0].section ? ' ' + rawStudents[0].section : ''})`;
                }
                const scopeDesc = activeFilters.length ? `${scopeTitle} | Filters: ${activeFilters.join(', ')}` : scopeTitle;

                applyExcelMetadataHeader(ws, {
                    title: 'Class List & Academic Performance Report',
                    scope: scopeDesc,
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — TEACHER COPY',
                    auditRef,
                    lastCol: 'Q'
                });

                // Table header row
                const headerRow = ws.addRow([
                    '#', 'LRN Number', 'Last Name', 'First Name', 'Middle Name', 'Sex',
                    'Grade & Section', 'Class / Subject', 'Overall Mastery %', 'Completed Tasks',
                    'Total Tasks', 'Assessment Avg %', 'Assessment Status', 'Assignment Avg %',
                    'Forums Completed', 'Subject EXP', 'Attendance Rate %'
                ]);
                headerRow.eachCell(cell => {
                    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell.border = { bottom: { style: 'thin', color: { argb: 'FF06B6D4' } } };
                });

                students.forEach((s, i) => {
                    const isIntervention = s.assessment_avg !== null && s.assessment_avg < 75;
                    const asmtStatus = s.assessment_avg === null ? 'No Recorded Data' : (isIntervention ? 'Needs Intervention (<75%)' : 'Passing (≥75%)');
                    const taskTotal = s.total_tasks || s.curriculum_total_tasks || 0;
                    const forumPct = s.forums_total > 0 ? Math.round((s.forums_completed / s.forums_total) * 100) : 0;
                    const forumStr = `${s.forums_completed} / ${s.forums_total} (${forumPct}%)`;

                    const row = ws.addRow([
                        i + 1,
                        String(s.lrn_number || '—'),
                        s.last_name || '',
                        s.first_name || '',
                        s.middle_name || '',
                        s.sex || '—',
                        `Grade ${s.grade_level || '11'} - ${s.section || 'General'}`,
                        `${s.class_name || classInfo.class_name} — ${s.subject_name || classInfo.subject_name || 'Chemistry'}`,
                        Number(s.overall_mastery || 0),
                        Number(s.completed_tasks || 0),
                        Number(taskTotal),
                        s.assessment_avg !== null ? Number(s.assessment_avg) : '—',
                        asmtStatus,
                        s.assignment_avg !== null ? Number(s.assignment_avg) : '—',
                        forumStr,
                        Number(s.subject_exp || 0),
                        s.attendance_rate !== null ? Number(s.attendance_rate) : '—'
                    ]);

                    // Format LRN cell as Text to prevent scientific notation
                    row.getCell(2).numFmt = '@';

                    // Zebra striping
                    if (i % 2 === 0) {
                        row.eachCell(cell => {
                            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                        });
                    }

                    // Highlight Assessment Intervention in bold red
                    if (isIntervention) {
                        row.getCell(12).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                        row.getCell(12).font = { bold: true, color: { argb: 'FF991B1B' } };
                        row.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                        row.getCell(13).font = { bold: true, color: { argb: 'FF991B1B' } };
                    }
                });

                // Summary Rows
                ws.addRow([]);
                const avgMastery = students.length > 0
                    ? Math.round(students.reduce((acc, s) => acc + (s.overall_mastery || 0), 0) / students.length)
                    : 0;
                const interventionCount = students.filter(s => s.assessment_avg !== null && s.assessment_avg < 75).length;
                const maleCount = students.filter(s => (s.sex || '').toLowerCase() === 'male').length;
                const femaleCount = students.filter(s => (s.sex || '').toLowerCase() === 'female').length;

                const sumRow1 = ws.addRow(['', '', '', '', '', '', '', 'Total Enrolled Learners:', students.length, '', 'Class Mastery Avg:', `${avgMastery}%`]);
                sumRow1.getCell(8).font = { bold: true, color: { argb: 'FF1E293B' } };
                sumRow1.getCell(9).font = { bold: true, color: { argb: 'FF1E293B' } };
                sumRow1.getCell(11).font = { bold: true, color: { argb: 'FF1E293B' } };
                sumRow1.getCell(12).font = { bold: true, color: { argb: 'FF15803D' } };

                const sumRow2 = ws.addRow(['', '', '', '', '', '', '', 'Gender Breakdown:', `Male: ${maleCount} | Female: ${femaleCount}`, '', 'Needs Assessment Intervention:', `${interventionCount} student(s)`]);
                sumRow2.getCell(8).font = { bold: true, color: { argb: 'FF1E293B' } };
                sumRow2.getCell(9).font = { color: { argb: 'FF475569' } };
                sumRow2.getCell(11).font = { bold: true, color: { argb: 'FF991B1B' } };
                sumRow2.getCell(12).font = { bold: true, color: { argb: 'FF991B1B' } };

                ws.columns = [
                    { width: 5 }, { width: 18 }, { width: 16 }, { width: 16 },
                    { width: 14 }, { width: 8 }, { width: 22 }, { width: 28 },
                    { width: 18 }, { width: 16 }, { width: 14 }, { width: 18 },
                    { width: 26 }, { width: 18 }, { width: 20 }, { width: 14 },
                    { width: 18 }
                ];
            }

            if (wb.worksheets.length === 0) {
                const wsEmpty = wb.addWorksheet('Class List');
                wsEmpty.addRow(['No enrolled classes found for this teacher.']);
            }

            setExportHttpHeaders(res, `class_list_metrics_${auditRef}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            await wb.xlsx.write(res);
            res.end();

            await logActivity(req.user.user_id, 'Teacher', 'EXPORT_CLASS_LIST_EXCEL',
                `Exported Class List & Performance Metrics Excel (Ref: ${auditRef}, Filtered: ${totalExportedStudents} students, Classes: ${targetClasses.length})`);

        } else {
            // =========================================================================
            // ── 2. ATTENDANCE RECORDS (Excel, Multi-Sheet / Date-Separated) ───────────
            // =========================================================================
            const filterAttSource = req.query.attendance_source || 'roll_call'; // 'roll_call' | 'lms' | 'both'
            const filterAttDate = req.query.attendance_date || null;
            const filterSex = req.query.sex && req.query.sex !== 'all' ? req.query.sex : null;

            if (!isMultiClass) {
                // ── SINGLE-CLASS MODE (Preserves strict backward compatibility) ──
                const clsItem = targetClasses[0] || { class_id: selectedClassId, class_name: 'Class', subject_name: 'Chemistry' };
                let dateSql = `
                    SELECT DISTINCT DATE_FORMAT(session_date, '%Y-%m-%d') AS raw_date,
                           DATE_FORMAT(session_date, '%W, %M %e, %Y') AS formatted_date,
                           DATE_FORMAT(session_date, '%W') AS day_name
                    FROM attendance_records
                    WHERE class_id = ? AND attendance_method = 'Manual_Teacher'
                `;
                const dateParams = [clsItem.class_id];
                if (filterAttDate) {
                    dateSql += ` AND DATE_FORMAT(session_date, '%Y-%m-%d') = ?`;
                    dateParams.push(filterAttDate);
                }
                dateSql += ` ORDER BY session_date ASC`;

                const [conductedDates] = await db.execute(dateSql, dateParams);
                const classScope = clsItem.subject_name ? `${clsItem.subject_name} — Class: ${clsItem.class_name}` : `Class: ${clsItem.class_name}`;

                if (conductedDates.length === 0) {
                    const wsEmpty = wb.addWorksheet('Attendance');
                    applyExcelMetadataHeader(wsEmpty, {
                        title: 'Class Attendance Report',
                        scope: `${classScope} | No Recorded Sessions`,
                        user: req.user,
                        role: 'Teacher',
                        classification: 'CONFIDENTIAL — TEACHER COPY',
                        auditRef,
                        lastCol: 'H'
                    });

                    wsEmpty.mergeCells('A7:H8');
                    wsEmpty.getCell('A7').value = filterAttDate
                        ? `No teacher roll call attendance was conducted for this class on ${filterAttDate}. Please select a recorded date.`
                        : 'There are currently no attendance sessions recorded by the teacher for this class.';
                    wsEmpty.getCell('A7').font = { bold: true, color: { argb: 'FF991B1B' } };
                    wsEmpty.getCell('A7').alignment = { horizontal: 'center', vertical: 'middle' };
                    wsEmpty.getCell('A7').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

                    const filenameSuffix = filterAttDate ? filterAttDate.replace(/-/g, '') : 'all_dates';
                    setExportHttpHeaders(res, `attendance_${filenameSuffix}_${auditRef}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    await wb.xlsx.write(res);
                    res.end();
                    return;
                }

                // Sheet 1: Roll Call Attendance
                if (filterAttSource === 'roll_call' || filterAttSource === 'both') {
                    const wsRoll = wb.addWorksheet('Roll Call Attendance');
                    applyExcelMetadataHeader(wsRoll, {
                        title: 'Teacher Roll Call Attendance Report',
                        scope: `${classScope} | Sessions: ${conductedDates.length} recorded day(s)`,
                        user: req.user,
                        role: 'Teacher',
                        classification: 'CONFIDENTIAL — TEACHER COPY',
                        auditRef,
                        lastCol: 'H'
                    });

                    const rHeaderRow = wsRoll.addRow([
                        '#', 'Session Date', 'LRN Number', 'Student Full Name', 'Sex', 'Roll Call Status', 'Time Marked (PST)', 'Remarks / Override Reason'
                    ]);
                    rHeaderRow.eachCell(c => {
                        c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
                        c.alignment = { horizontal: 'center', vertical: 'middle' };
                        c.border = { bottom: { style: 'thin', color: { argb: 'FF06B6D4' } } };
                    });

                    let totalPres = 0, totalLate = 0, totalAbs = 0, totalExc = 0, rowIdx = 1;

                    for (let d of conductedDates) {
                        let rollSql = `
                            SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                   ar.status, ar.check_in_time, ar.override_reason
                            FROM users u
                            JOIN class_students cs ON u.user_id = cs.student_id
                            LEFT JOIN attendance_records ar ON ar.student_id = u.user_id
                                  AND ar.class_id = cs.class_id
                                  AND DATE_FORMAT(ar.session_date, '%Y-%m-%d') = ?
                                  AND ar.attendance_method = 'Manual_Teacher'
                            WHERE cs.class_id = ? AND u.role = 'Student'
                        `;
                        const rollParams = [d.raw_date, clsItem.class_id];
                        if (filterSex) {
                            rollSql += ` AND u.sex = ?`;
                            rollParams.push(filterSex);
                        }
                        rollSql += ` ORDER BY u.last_name, u.first_name`;

                        const [rStudents] = await db.execute(rollSql, rollParams);

                        rStudents.forEach((st) => {
                            const status = st.status || 'Unrecorded';
                            if (status === 'Present') totalPres++;
                            else if (status === 'Late') totalLate++;
                            else if (status === 'Absent') totalAbs++;
                            else if (status === 'Excused') totalExc++;

                            const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                            const timeStr = formatClockTime(st.check_in_time);

                            const rRow = wsRoll.addRow([
                                rowIdx++,
                                `${d.formatted_date} (${d.day_name})`,
                                String(st.lrn_number || '—'),
                                fullName,
                                st.sex || '—',
                                status.toUpperCase(),
                                timeStr,
                                st.override_reason || '—'
                            ]);

                            rRow.getCell(3).numFmt = '@';

                            if (rowIdx % 2 === 0) {
                                rRow.eachCell(cell => {
                                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                                });
                            }

                            const statusCell = rRow.getCell(6);
                            if (status === 'Present') {
                                statusCell.font = { bold: true, color: { argb: 'FF15803D' } };
                            } else if (status === 'Late') {
                                statusCell.font = { bold: true, color: { argb: 'FFB45309' } };
                            } else if (status === 'Absent') {
                                statusCell.font = { bold: true, color: { argb: 'FFB91C1C' } };
                                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                            } else if (status === 'Excused') {
                                statusCell.font = { bold: true, color: { argb: 'FF2563EB' } };
                            }
                        });
                    }

                    wsRoll.addRow([]);
                    const totalMarks = totalPres + totalLate + totalAbs + totalExc;
                    const rollRate = totalMarks > 0 ? Math.round(((totalPres + totalLate) / totalMarks) * 100) : 0;
                    const rSumRow = wsRoll.addRow([
                        '', '', '', 'Cumulative Roll Call Summary:', '',
                        `Present: ${totalPres} | Late: ${totalLate} | Absent: ${totalAbs} | Excused: ${totalExc}`,
                        'Attendance Rate:',
                        `${rollRate}%`
                    ]);
                    rSumRow.getCell(4).font = { bold: true, color: { argb: 'FF1E293B' } };
                    rSumRow.getCell(6).font = { bold: true, color: { argb: 'FF0369A1' } };
                    rSumRow.getCell(7).font = { bold: true, color: { argb: 'FF1E293B' } };
                    rSumRow.getCell(8).font = { bold: true, color: { argb: 'FF15803D' } };

                    wsRoll.columns = [
                        { width: 6 }, { width: 28 }, { width: 18 }, { width: 26 },
                        { width: 8 }, { width: 18 }, { width: 18 }, { width: 30 }
                    ];
                }

                // Sheet 2: LMS Portal Logins
                if (filterAttSource === 'lms' || filterAttSource === 'both') {
                    const wsLms = wb.addWorksheet('LMS Portal Logins');
                    applyExcelMetadataHeader(wsLms, {
                        title: 'LMS Portal Login Activity Report',
                        scope: `${classScope} | Sessions: ${conductedDates.length} recorded day(s)`,
                        user: req.user,
                        role: 'Teacher',
                        classification: 'CONFIDENTIAL — TEACHER COPY',
                        auditRef,
                        lastCol: 'H'
                    });

                    const lHeaderRow = wsLms.addRow([
                        '#', 'Portal Activity Date', 'LRN Number', 'Student Full Name', 'Sex', 'Portal Status', 'First Login (PST)', 'Total Sessions'
                    ]);
                    lHeaderRow.eachCell(c => {
                        c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
                        c.alignment = { horizontal: 'center', vertical: 'middle' };
                        c.border = { bottom: { style: 'thin', color: { argb: 'FF34D399' } } };
                    });

                    let totalLoggedIn = 0, totalRecords = 0, lRowIdx = 1;

                    for (let d of conductedDates) {
                        let lmsSql = `
                            SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                   MIN(al.created_at) AS first_login,
                                   MAX(al.created_at) AS last_login,
                                   COUNT(al.log_id) AS login_count
                            FROM users u
                            JOIN class_students cs ON u.user_id = cs.student_id
                            LEFT JOIN activity_logs al ON al.actor_id = u.user_id
                                  AND (al.action = 'LOGIN' OR al.action = 'LOGIN_SUCCESS' OR al.description LIKE '%Logged in%' OR al.description LIKE '%logged in%' OR al.action LIKE '%LOGIN%')
                                  AND DATE_FORMAT(CONVERT_TZ(al.created_at, '+00:00', '+08:00'), '%Y-%m-%d') = ?
                            WHERE cs.class_id = ? AND u.role = 'Student'
                        `;
                        const lmsParams = [d.raw_date, clsItem.class_id];
                        if (filterSex) {
                            lmsSql += ` AND u.sex = ?`;
                            lmsParams.push(filterSex);
                        }
                        lmsSql += ` GROUP BY u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex
                                    ORDER BY u.last_name, u.first_name`;

                        const [lStudents] = await db.execute(lmsSql, lmsParams);

                        lStudents.forEach((st) => {
                            totalRecords++;
                            const hasLogin = Number(st.login_count) > 0;
                            if (hasLogin) totalLoggedIn++;

                            const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                            const firstLoginStr = formatClockTime(st.first_login);

                            const lRow = wsLms.addRow([
                                lRowIdx++,
                                `${d.formatted_date} (${d.day_name})`,
                                String(st.lrn_number || '—'),
                                fullName,
                                st.sex || '—',
                                hasLogin ? 'LOGGED IN' : 'NO LOGIN RECORDED',
                                firstLoginStr,
                                Number(st.login_count || 0)
                            ]);

                            lRow.getCell(3).numFmt = '@';

                            if (lRowIdx % 2 === 0) {
                                lRow.eachCell(cell => {
                                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
                                });
                            }

                            const pStatusCell = lRow.getCell(6);
                            if (hasLogin) {
                                pStatusCell.font = { bold: true, color: { argb: 'FF047857' } };
                            } else {
                                pStatusCell.font = { color: { argb: 'FF94A3B8' } };
                            }
                        });
                    }

                    wsLms.addRow([]);
                    const engagementRate = totalRecords > 0 ? Math.round((totalLoggedIn / totalRecords) * 100) : 0;
                    const lSumRow = wsLms.addRow([
                        '', '', '', 'Cumulative LMS Portal Summary:', '',
                        `Logged In: ${totalLoggedIn} | No Activity: ${totalRecords - totalLoggedIn}`,
                        'Portal Engagement Rate:',
                        `${engagementRate}%`
                    ]);
                    lSumRow.getCell(4).font = { bold: true, color: { argb: 'FF1E293B' } };
                    lSumRow.getCell(6).font = { bold: true, color: { argb: 'FF065F46' } };
                    lSumRow.getCell(7).font = { bold: true, color: { argb: 'FF1E293B' } };
                    lSumRow.getCell(8).font = { bold: true, color: { argb: 'FF047857' } };

                    wsLms.columns = [
                        { width: 6 }, { width: 28 }, { width: 18 }, { width: 26 },
                        { width: 8 }, { width: 22 }, { width: 18 }, { width: 18 }
                    ];
                }

            } else {
                // ── MULTI-CLASS MODE (Iterate through all targetClasses) ──
                for (let cIdx = 0; cIdx < targetClasses.length; cIdx++) {
                    const clsItem = targetClasses[cIdx];
                    let dateSql = `
                        SELECT DISTINCT DATE_FORMAT(session_date, '%Y-%m-%d') AS raw_date,
                               DATE_FORMAT(session_date, '%W, %M %e, %Y') AS formatted_date,
                               DATE_FORMAT(session_date, '%W') AS day_name
                        FROM attendance_records
                        WHERE class_id = ? AND attendance_method = 'Manual_Teacher'
                    `;
                    const dateParams = [clsItem.class_id];
                    if (filterAttDate) {
                        dateSql += ` AND DATE_FORMAT(session_date, '%Y-%m-%d') = ?`;
                        dateParams.push(filterAttDate);
                    }
                    dateSql += ` ORDER BY session_date ASC`;

                    const [conductedDates] = await db.execute(dateSql, dateParams);
                    const classScope = `[Class ${cIdx + 1} of ${targetClasses.length}] ${clsItem.subject_name ? `${clsItem.subject_name} — Class: ${clsItem.class_name}` : `Class: ${clsItem.class_name}`}`;

                    if (conductedDates.length === 0) {
                        const noticeSheetName = getUniqueSheetName(`${clsItem.class_name} Notice`);
                        const wsEmpty = wb.addWorksheet(noticeSheetName);
                        applyExcelMetadataHeader(wsEmpty, {
                            title: 'Class Attendance Report',
                            scope: `${classScope} | No Recorded Sessions`,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — TEACHER COPY',
                            auditRef,
                            lastCol: 'H'
                        });

                        wsEmpty.mergeCells('A7:H8');
                        wsEmpty.getCell('A7').value = filterAttDate
                            ? `No teacher roll call attendance was conducted for ${clsItem.class_name} on ${filterAttDate}.`
                            : `There are currently no attendance sessions recorded by the teacher for ${clsItem.class_name}.`;
                        wsEmpty.getCell('A7').font = { bold: true, color: { argb: 'FF991B1B' } };
                        wsEmpty.getCell('A7').alignment = { horizontal: 'center', vertical: 'middle' };
                        wsEmpty.getCell('A7').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                        continue;
                    }

                    // Multi-Class Sheet: Roll Call Attendance
                    if (filterAttSource === 'roll_call' || filterAttSource === 'both') {
                        const rollSheetName = getUniqueSheetName(`${clsItem.class_name} Roll Call`);
                        const wsRoll = wb.addWorksheet(rollSheetName);
                        applyExcelMetadataHeader(wsRoll, {
                            title: 'Teacher Roll Call Attendance Report',
                            scope: `${classScope} | Sessions: ${conductedDates.length} recorded day(s)`,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — TEACHER COPY',
                            auditRef,
                            lastCol: 'H'
                        });

                        const rHeaderRow = wsRoll.addRow([
                            '#', 'Session Date', 'LRN Number', 'Student Full Name', 'Sex', 'Roll Call Status', 'Time Marked (PST)', 'Remarks / Override Reason'
                        ]);
                        rHeaderRow.eachCell(c => {
                            c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
                            c.alignment = { horizontal: 'center', vertical: 'middle' };
                            c.border = { bottom: { style: 'thin', color: { argb: 'FF06B6D4' } } };
                        });

                        let totalPres = 0, totalLate = 0, totalAbs = 0, totalExc = 0, rowIdx = 1;

                        for (let d of conductedDates) {
                            let rollSql = `
                                SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                       ar.status, ar.check_in_time, ar.override_reason
                                FROM users u
                                JOIN class_students cs ON u.user_id = cs.student_id
                                LEFT JOIN attendance_records ar ON ar.student_id = u.user_id
                                      AND ar.class_id = cs.class_id
                                      AND DATE_FORMAT(ar.session_date, '%Y-%m-%d') = ?
                                      AND ar.attendance_method = 'Manual_Teacher'
                                WHERE cs.class_id = ? AND u.role = 'Student'
                            `;
                            const rollParams = [d.raw_date, clsItem.class_id];
                            if (filterSex) {
                                rollSql += ` AND u.sex = ?`;
                                rollParams.push(filterSex);
                            }
                            rollSql += ` ORDER BY u.last_name, u.first_name`;

                            const [rStudents] = await db.execute(rollSql, rollParams);

                            rStudents.forEach((st) => {
                                const status = st.status || 'Unrecorded';
                                if (status === 'Present') totalPres++;
                                else if (status === 'Late') totalLate++;
                                else if (status === 'Absent') totalAbs++;
                                else if (status === 'Excused') totalExc++;

                                const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                                const timeStr = formatClockTime(st.check_in_time);

                                const rRow = wsRoll.addRow([
                                    rowIdx++,
                                    `${d.formatted_date} (${d.day_name})`,
                                    String(st.lrn_number || '—'),
                                    fullName,
                                    st.sex || '—',
                                    status.toUpperCase(),
                                    timeStr,
                                    st.override_reason || '—'
                                ]);

                                rRow.getCell(3).numFmt = '@';

                                if (rowIdx % 2 === 0) {
                                    rRow.eachCell(cell => {
                                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                                    });
                                }

                                const statusCell = rRow.getCell(6);
                                if (status === 'Present') {
                                    statusCell.font = { bold: true, color: { argb: 'FF15803D' } };
                                } else if (status === 'Late') {
                                    statusCell.font = { bold: true, color: { argb: 'FFB45309' } };
                                } else if (status === 'Absent') {
                                    statusCell.font = { bold: true, color: { argb: 'FFB91C1C' } };
                                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                                } else if (status === 'Excused') {
                                    statusCell.font = { bold: true, color: { argb: 'FF2563EB' } };
                                }
                            });
                        }

                        wsRoll.addRow([]);
                        const totalMarks = totalPres + totalLate + totalAbs + totalExc;
                        const rollRate = totalMarks > 0 ? Math.round(((totalPres + totalLate) / totalMarks) * 100) : 0;
                        const rSumRow = wsRoll.addRow([
                            '', '', '', `${clsItem.class_name} Cumulative Roll Call:`, '',
                            `Present: ${totalPres} | Late: ${totalLate} | Absent: ${totalAbs} | Excused: ${totalExc}`,
                            'Attendance Rate:',
                            `${rollRate}%`
                        ]);
                        rSumRow.getCell(4).font = { bold: true, color: { argb: 'FF1E293B' } };
                        rSumRow.getCell(6).font = { bold: true, color: { argb: 'FF0369A1' } };
                        rSumRow.getCell(7).font = { bold: true, color: { argb: 'FF1E293B' } };
                        rSumRow.getCell(8).font = { bold: true, color: { argb: 'FF15803D' } };

                        wsRoll.columns = [
                            { width: 6 }, { width: 28 }, { width: 18 }, { width: 26 },
                            { width: 8 }, { width: 18 }, { width: 18 }, { width: 30 }
                        ];
                    }

                    // Multi-Class Sheet: LMS Portal Logins
                    if (filterAttSource === 'lms' || filterAttSource === 'both') {
                        const lmsSheetName = getUniqueSheetName(`${clsItem.class_name} LMS`);
                        const wsLms = wb.addWorksheet(lmsSheetName);
                        applyExcelMetadataHeader(wsLms, {
                            title: 'LMS Portal Login Activity Report',
                            scope: `${classScope} | Sessions: ${conductedDates.length} recorded day(s)`,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — TEACHER COPY',
                            auditRef,
                            lastCol: 'H'
                        });

                        const lHeaderRow = wsLms.addRow([
                            '#', 'Portal Activity Date', 'LRN Number', 'Student Full Name', 'Sex', 'Portal Status', 'First Login (PST)', 'Total Sessions'
                        ]);
                        lHeaderRow.eachCell(c => {
                            c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
                            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
                            c.alignment = { horizontal: 'center', vertical: 'middle' };
                            c.border = { bottom: { style: 'thin', color: { argb: 'FF34D399' } } };
                        });

                        let totalLoggedIn = 0, totalRecords = 0, lRowIdx = 1;

                        for (let d of conductedDates) {
                            let lmsSql = `
                                SELECT u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex,
                                       MIN(al.created_at) AS first_login,
                                       MAX(al.created_at) AS last_login,
                                       COUNT(al.log_id) AS login_count
                                FROM users u
                                JOIN class_students cs ON u.user_id = cs.student_id
                                LEFT JOIN activity_logs al ON al.actor_id = u.user_id
                                      AND (al.action = 'LOGIN' OR al.action = 'LOGIN_SUCCESS' OR al.description LIKE '%Logged in%' OR al.description LIKE '%logged in%' OR al.action LIKE '%LOGIN%')
                                      AND DATE_FORMAT(CONVERT_TZ(al.created_at, '+00:00', '+08:00'), '%Y-%m-%d') = ?
                                WHERE cs.class_id = ? AND u.role = 'Student'
                            `;
                            const lmsParams = [d.raw_date, clsItem.class_id];
                            if (filterSex) {
                                lmsSql += ` AND u.sex = ?`;
                                lmsParams.push(filterSex);
                            }
                            lmsSql += ` GROUP BY u.user_id, u.lrn_number, u.first_name, u.middle_name, u.last_name, u.sex
                                        ORDER BY u.last_name, u.first_name`;

                            const [lStudents] = await db.execute(lmsSql, lmsParams);

                            lStudents.forEach((st) => {
                                totalRecords++;
                                const hasLogin = Number(st.login_count) > 0;
                                if (hasLogin) totalLoggedIn++;

                                const fullName = `${st.last_name}, ${st.first_name}${st.middle_name ? ' ' + st.middle_name[0] + '.' : ''}`;
                                const firstLoginStr = formatClockTime(st.first_login);

                                const lRow = wsLms.addRow([
                                    lRowIdx++,
                                    `${d.formatted_date} (${d.day_name})`,
                                    String(st.lrn_number || '—'),
                                    fullName,
                                    st.sex || '—',
                                    hasLogin ? 'LOGGED IN' : 'NO LOGIN RECORDED',
                                    firstLoginStr,
                                    Number(st.login_count || 0)
                                ]);

                                lRow.getCell(3).numFmt = '@';

                                if (lRowIdx % 2 === 0) {
                                    lRow.eachCell(cell => {
                                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
                                    });
                                }

                                const pStatusCell = lRow.getCell(6);
                                if (hasLogin) {
                                    pStatusCell.font = { bold: true, color: { argb: 'FF047857' } };
                                } else {
                                    pStatusCell.font = { color: { argb: 'FF94A3B8' } };
                                }
                            });
                        }

                        wsLms.addRow([]);
                        const engagementRate = totalRecords > 0 ? Math.round((totalLoggedIn / totalRecords) * 100) : 0;
                        const lSumRow = wsLms.addRow([
                            '', '', '', `${clsItem.class_name} LMS Summary:`, '',
                            `Logged In: ${totalLoggedIn} | No Activity: ${totalRecords - totalLoggedIn}`,
                            'Engagement Rate:',
                            `${engagementRate}%`
                        ]);
                        lSumRow.getCell(4).font = { bold: true, color: { argb: 'FF1E293B' } };
                        lSumRow.getCell(6).font = { bold: true, color: { argb: 'FF065F46' } };
                        lSumRow.getCell(7).font = { bold: true, color: { argb: 'FF1E293B' } };
                        lSumRow.getCell(8).font = { bold: true, color: { argb: 'FF047857' } };

                        wsLms.columns = [
                            { width: 6 }, { width: 28 }, { width: 18 }, { width: 26 },
                            { width: 8 }, { width: 22 }, { width: 18 }, { width: 18 }
                        ];
                    }
                }
            }

            const filenameSuffix = filterAttDate ? filterAttDate.replace(/-/g, '') : 'all_dates';
            setExportHttpHeaders(res, `attendance_${filenameSuffix}_${auditRef}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            await wb.xlsx.write(res);
            res.end();

            await logActivity(req.user.user_id, 'Teacher', 'EXPORT_ATTENDANCE_EXCEL',
                `Exported Attendance Excel (Ref: ${auditRef}, Source: ${filterAttSource}, Classes: ${targetClasses.length})`);
        }

    } catch (err) {
        console.error('❌ [GET /reports/export/class-list/excel]', err);
        res.status(500).send('Excel generation failed.');
    }
});


// ── B. Student Progress Report Card — Individual PDF ─────────────────────────
router.get('/reports/export/report-card/:studentId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const isAdmin = req.user.role === 'Admin';
    const studentId = parseInt(req.params.studentId, 10);
    let selectedClassId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;

    if (isNaN(studentId)) {
        return res.status(400).send('Invalid student ID.');
    }

    try {
        if (!selectedClassId) {
            const [cRows] = await db.query(`
                SELECT c.class_id FROM classes c
                JOIN class_students cs ON c.class_id = cs.class_id
                WHERE cs.student_id = ? ${isAdmin ? '' : 'AND c.teacher_id = ?'}
                LIMIT 1
            `, isAdmin ? [studentId] : [studentId, teacherId]);
            if (cRows.length) selectedClassId = cRows[0].class_id;
        }

        if (!selectedClassId) {
            return res.status(400).send('No authorized class association found for this student.');
        }

        const [classRows] = await db.query(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, sy.sy_range,
                   COALESCE(GROUP_CONCAT(q.quarter_number ORDER BY q.quarter_number), '1,2') as quarters
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN quarters q ON s.subject_id = q.subject_id
            WHERE c.class_id = ? ${isAdmin ? '' : 'AND c.teacher_id = ?'}
            GROUP BY c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, sy.sy_range
        `, isAdmin ? [selectedClassId] : [selectedClassId, teacherId]);

        if (!classRows.length) return res.status(403).send('Unauthorized class access.');
        const cls = classRows[0];
        const classQuarters = (cls.quarters || '1,2').split(',').map(Number);

        // Parse filters
        const filters = {
            quarter: req.query.quarter || '',
            inc_asmt: req.query.inc_asmt !== '0',
            asmt_topic: req.query.asmt_topic || '',
            asmt_type: req.query.asmt_type || '',
            asmt_status: req.query.asmt_status || '',
            inc_asgn: req.query.inc_asgn !== '0',
            asgn_topic: req.query.asgn_topic || '',
            asgn_mode: req.query.asgn_mode || '',
            inc_forums: req.query.inc_forums !== '0',
            forum_topic: req.query.forum_topic || '',
            forum_done: req.query.forum_done || '',
            inc_sim: req.query.inc_sim !== '0',
            sim_slugs: req.query.sim_slugs || '',
            sim_status: req.query.sim_status || ''
        };

        // Quarter validation guardrail: Verify quarter belongs to this subject
        const qNum = filters.quarter ? parseInt(filters.quarter, 10) : null;
        if (qNum && !classQuarters.includes(qNum)) {
            return res.status(400).send(`Invalid Quarter: Class "${cls.class_name} — ${cls.subject_name}" only covers Quarters ${classQuarters.join(' & ')}. Quarter ${qNum} is not part of this subject.`);
        }

        const studentData = await getStudentFilteredReportData(studentId, selectedClassId, cls.subject_id, filters);

        const auditRef = generateAuditRef('REP');
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        doc._currentAuditRef = auditRef;

        const safeStudentName = `${studentData.student.last_name || 'student'}_${studentData.student.first_name || ''}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        setExportHttpHeaders(res, `report_card_${safeStudentName}_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        const quartersLabel = qNum 
            ? `Quarter ${qNum}` 
            : `All Quarters (${classQuarters.map(q => `Q${q}`).join(' & ')})`;
        const scopeLabel = `${cls.class_name} — ${cls.subject_name} (SY ${cls.sy_range})  •  ${quartersLabel}`;

        renderStudentProgressReportCardPage(doc, studentData, {
            scopeLabel,
            user: req.user,
            auditRef,
            filters
        });

        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — OFFICIAL REPORT');
        doc.end();

        await logActivity(req.user.user_id, 'Teacher', 'EXPORT_REPORT_CARD_PDF',
            `Exported Report Card for student ID ${studentId} (${cls.class_name}) (Ref: ${auditRef})`);

    } catch (err) {
        console.error('❌ [GET /reports/export/report-card/:studentId]', err);
        res.status(500).send('PDF generation failed.');
    }
});


// ── C1. Single-Topic Remediation Dossier — PDF ───────────────────────────────
router.get('/reports/export/remediation/topic/:topicId/pdf', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const topicId = parseInt(req.params.topicId, 10);
    const selectedClassId = req.query.class_id && req.query.class_id !== 'all' ? parseInt(req.query.class_id, 10) : null;

    try {
        if (!topicId) {
            return res.status(400).send('Topic ID is required.');
        }

        // 1. Fetch Class and Subject Metadata
        let classInfo = {};
        if (selectedClassId) {
            const [cRows] = await db.query(
                `SELECT c.class_id, c.class_name, c.subject_id, s.subject_name, s.subject_code, sy.sy_range
                 FROM classes c
                 JOIN subjects s ON c.subject_id = s.subject_id
                 JOIN school_years sy ON c.sy_id = sy.sy_id
                 WHERE c.class_id = ? AND c.teacher_id = ?`,
                [selectedClassId, teacherId]
            );
            if (cRows.length > 0) {
                classInfo = cRows[0];
            }
        }

        // 2. Fetch Topic Details
        const [tRows] = await db.query(
            `SELECT t.topic_id, t.topic_name, t.topic_description, q.quarter_number, q.quarter_id, s.subject_id, s.subject_name, s.subject_code
             FROM topics t
             JOIN quarters q ON t.quarter_id = q.quarter_id
             JOIN subjects s ON q.subject_id = s.subject_id
             WHERE t.topic_id = ?`,
            [topicId]
        );
        if (tRows.length === 0) {
            return res.status(404).send('Topic not found.');
        }
        const topicMeta = tRows[0];

        // 3. Compute Topic Remediation Metrics via Helper Engine
        const topicResults = await computeClassTopicRemediation(db, selectedClassId, teacherId, topicMeta.subject_id);
        const topicData = topicResults.find(t => t.topic_id === topicId);

        if (!topicData) {
            return res.status(404).send('Remediation metrics not available for this topic.');
        }

        // 4. Fetch Attached Learning Materials
        const [materials] = await db.query(
            `SELECT material_id, title, material_type, file_path_or_url
             FROM learning_materials
             WHERE topic_id = ?
             ORDER BY title ASC LIMIT 5`,
            [topicId]
        );

        // 5. Initialize PDF Document
        const auditRef = generateAuditRef('REMT');
        const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
        doc._currentAuditRef = auditRef;

        const safeTopicSlug = (topicData.topic_name || 'topic').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
        setExportHttpHeaders(res, `single_topic_remediation_${safeTopicSlug}_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        const scopeLabel = `${topicData.topic_name} (Q${topicData.quarter_number})  •  Class: ${classInfo.class_name || 'All Enrolled Classes'} — ${classInfo.subject_name || topicMeta.subject_name}`;

        drawPdfDocumentHeader(doc, {
            title: 'SINGLE-TOPIC REMEDIATION & INTERVENTION DOSSIER',
            scope: scopeLabel,
            user: req.user,
            role: 'Teacher',
            classification: 'CONFIDENTIAL — ACADEMIC INTERVENTION',
            auditRef
        });

        // 6. Summary KPI Bar (6 Metric Blocks)
        const startY = doc.y + 6;
        const cardW = 82;
        const cardH = 42;
        const cardGap = 6;
        const cards = [
            { label: 'TOTAL ENROLLED', val: String(topicData.total_enrolled), sub: 'Students', color: '#1e293b', bg: '#f8fafc' },
            { label: 'STUDENTS AT RISK', val: String(topicData.no_of_students_at_risk), sub: 'Below 75%', color: '#e11d48', bg: '#fff1f2' },
            { label: 'OVERALL CLASS RISK', val: `${topicData.overall_class_risk_pct}%`, sub: 'Intervention Rate', color: topicData.overall_class_risk_pct >= 50 ? '#be123c' : '#b45309', bg: '#fef2f2' },
            { label: 'ASSESSMENT AVG', val: topicData.class_asmt_avg !== null ? `${topicData.class_asmt_avg}%` : 'N/A', sub: `${topicData.asmt_count} Tasks`, color: '#0369a1', bg: '#f0f9ff' },
            { label: 'ASSIGNMENT AVG', val: topicData.class_asgn_avg !== null ? `${topicData.class_asgn_avg}%` : 'N/A', sub: `${topicData.asgn_count} Tasks`, color: '#047857', bg: '#f0fdf4' },
            { label: 'FORUM COMPLETION', val: topicData.class_forum_completion_pct !== null ? `${topicData.class_forum_completion_pct}%` : 'N/A', sub: `${topicData.forum_count} Forums`, color: '#4338ca', bg: '#eef2ff' }
        ];

        cards.forEach((c, idx) => {
            const cx = 36 + idx * (cardW + cardGap);
            doc.roundedRect(cx, startY, cardW, cardH, 5).fillAndStroke(c.bg, '#e2e8f0');
            doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748b').text(c.label, cx + 4, startY + 5.5, { width: cardW - 8, align: 'center' });
            doc.font('Helvetica-Bold').fontSize(11.5).fillColor(c.color).text(c.val, cx + 4, startY + 15.5, { width: cardW - 8, align: 'center' });
            doc.font('Helvetica').fontSize(6).fillColor('#94a3b8').text(c.sub, cx + 4, startY + 30, { width: cardW - 8, align: 'center' });
        });

        doc.x = 36;
        doc.y = startY + cardH + 16;

        // 7. Section Subtitle
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1e293b').text('DIAGNOSTIC STUDENT ROSTER & TOPIC MASTERY BREAKDOWN', 36, doc.y);
        doc.font('Helvetica').fontSize(6.5).fillColor('#64748b').text('Students classified as "At Risk" fall below the DepEd 75% topic mastery threshold across assessments, assignments, and forums.', 36, doc.y + 2);
        doc.moveDown(0.8);

        // 8. Table Header & Columns
        const cols = {
            name: 36,
            lrn: 176,
            asmt: 260,
            asgn: 326,
            forum: 392,
            score: 452,
            flag: 500
        };

        function drawSingleTopicTableHeader(yPos) {
            doc.rect(36, yPos, 523, 20).fill('#1e1b4b');
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            doc.text('Student Name', cols.name + 5, yPos + 6, { width: 136 });
            doc.text('LRN', cols.lrn, yPos + 6, { width: 80 });
            doc.text('Assessments', cols.asmt, yPos + 6, { width: 62, align: 'center' });
            doc.text('Assignments', cols.asgn, yPos + 6, { width: 62, align: 'center' });
            doc.text('Forums Done', cols.forum, yPos + 6, { width: 56, align: 'center' });
            doc.text('Standing', cols.score, yPos + 6, { width: 44, align: 'center' });
            doc.text('Risk Status', cols.flag, yPos + 6, { width: 55, align: 'center' });
            return yPos + 20;
        }

        let currY = drawSingleTopicTableHeader(doc.y);

        // 9. Table Rows
        const students = topicData.student_breakdown || [];
        students.forEach((st, idx) => {
            if (currY > 745) {
                doc.addPage();
                drawPdfDocumentHeader(doc, {
                    title: 'SINGLE-TOPIC REMEDIATION & INTERVENTION DOSSIER',
                    scope: `${topicData.topic_name} (Continuation)`,
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — ACADEMIC INTERVENTION',
                    auditRef,
                    isContinuation: true
                });
                currY = drawSingleTopicTableHeader(doc.y + 6);
            }

            const rowH = 20;
            const isRisk = st.is_at_risk;
            const rowBg = isRisk ? (idx % 2 === 0 ? '#fff1f2' : '#ffe4e6') : (idx % 2 === 0 ? '#f8fafc' : '#ffffff');
            doc.rect(36, currY, 523, rowH).fill(rowBg);
            doc.rect(36, currY, 523, rowH).strokeColor('#e2e8f0').lineWidth(0.4).stroke();

            // Student Name
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(isRisk ? '#9f1239' : '#1e293b');
            doc.text(`${st.last_name}, ${st.first_name}`, cols.name + 5, currY + 6, { width: 136, ellipsis: true });

            // LRN
            doc.font('Helvetica').fontSize(7).fillColor('#64748b');
            doc.text(String(st.lrn_number || '—'), cols.lrn, currY + 6.5, { width: 80 });

            // Assessments (Completed Assessments / Total Topic Assessments + Topic Assessment %)
            const effAsmtCount = st.asmt_count !== undefined ? st.asmt_count : (topicData.asmt_count || 0);
            const effAsmtDone = st.asmt_completed !== undefined ? st.asmt_completed : 0;
            const asmtText = effAsmtCount > 0
                ? `${effAsmtDone}/${effAsmtCount} (${st.asmt_pct !== null ? st.asmt_pct + '%' : '0%'})`
                : '—';
            doc.text(asmtText, cols.asmt, currY + 6.5, { width: 62, align: 'center' });

            // Assignments (Completed Assignments / Total Topic Assignments + Topic Assignment %)
            const effAsgnCount = st.asgn_count !== undefined ? st.asgn_count : (topicData.asgn_count || 0);
            const effAsgnDone = st.asgn_completed !== undefined ? st.asgn_completed : 0;
            const asgnText = effAsgnCount > 0
                ? `${effAsgnDone}/${effAsgnCount} (${st.asgn_pct !== null ? st.asgn_pct + '%' : '0%'})`
                : '—';
            doc.text(asgnText, cols.asgn, currY + 6.5, { width: 62, align: 'center' });

            // Forum
            const forumText = st.forums_total > 0 ? `${st.forums_done}/${st.forums_total} (${st.forum_pct}%)` : '—';
            doc.text(forumText, cols.forum, currY + 6.5, { width: 56, align: 'center' });

            // Standing %
            const standingText = st.topic_score !== null ? `${st.topic_score}%` : 'N/A';
            doc.font('Helvetica-Bold').fillColor(isRisk ? '#e11d48' : '#059669')
                .text(standingText, cols.score, currY + 6, { width: 44, align: 'center' });

            // Risk Badge
            if (isRisk) {
                doc.roundedRect(cols.flag + 2, currY + 4, 52, 12, 3).fill('#be123c');
                doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#ffffff').text('AT RISK', cols.flag + 2, currY + 7, { width: 52, align: 'center' });
            } else {
                doc.roundedRect(cols.flag + 2, currY + 4, 52, 12, 3).fill('#059669');
                doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#ffffff').text('PROFICIENT', cols.flag + 2, currY + 7, { width: 52, align: 'center' });
            }

            currY += rowH;
        });

        // 10. Recommendations & Action Items
        currY += 16;
        if (currY > 730) {
            doc.addPage();
            currY = 40;
        }

        doc.roundedRect(36, currY, 523, 52, 5).fillAndStroke('#f8fafc', '#cbd5e1');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e293b').text('RECOMMENDED ACTION ITEMS & REMEDIATION RESOURCES', 44, currY + 5);

        let matSummary = materials.length > 0
            ? materials.map(m => `• [${m.material_type.toUpperCase()}] ${m.title}`).join('    ')
            : 'No direct learning materials attached yet. Recommend assigning targeted practice quizzes.';

        doc.font('Helvetica').fontSize(6.5).fillColor('#475569')
            .text(`1. Academic Intervention: Dispatch re-testing or remedial assignments for the ${topicData.no_of_students_at_risk} student(s) identified at risk (<75%).`, 44, currY + 17, { width: 507 })
            .text(`2. Forum Engagement: Encourage students with unsubmitted discussion responses to participate for peer-assisted learning.`, 44, currY + 26, { width: 507 })
            .text(`3. Attached Materials: ${matSummary}`, 44, currY + 35, { width: 507, ellipsis: true });

        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — TEACHER COPY');
        doc.end();

        await logActivity(req.user.user_id, 'Teacher', 'EXPORT_SINGLE_TOPIC_REMEDIATION_PDF',
            `Exported Single-Topic Remediation PDF for Topic ID ${topicId} (${topicData.topic_name}) (Ref: ${auditRef})`);

    } catch (err) {
        console.error('❌ [GET /reports/export/remediation/topic/:topicId/pdf]', err);
        if (!res.headersSent) {
            res.status(500).send('PDF generation failed.');
        }
    }
});


// ── C. Class Remediation & Curriculum Risk Matrix — Batch PDF ────────────────
router.get('/reports/export/remediation/pdf', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const selectedClassId = req.query.class_id && req.query.class_id !== 'all' ? parseInt(req.query.class_id, 10) : null;
    const filterQuarter = req.query.quarter ? parseInt(req.query.quarter, 10) : null;
    const filterRisk = req.query.risk || null;   // 'high' / 'moderate' / 'low' / 'at_risk_only'
    const filterTopic = req.query.topic_id ? parseInt(req.query.topic_id, 10) : null;

    try {
        // 1. Fetch Class and Subject Metadata
        let classInfo = {};
        if (selectedClassId) {
            const [cRows] = await db.query(
                `SELECT c.class_id, c.class_name, c.subject_id, s.subject_name, s.subject_code, sy.sy_range
                 FROM classes c
                 JOIN subjects s ON c.subject_id = s.subject_id
                 JOIN school_years sy ON c.sy_id = sy.sy_id
                 WHERE c.class_id = ? AND c.teacher_id = ?`,
                [selectedClassId, teacherId]
            );
            if (cRows.length > 0) {
                classInfo = cRows[0];
            }
        }

        // 2. Compute Topic Remediation Data via Helper Engine
        let topicResults = await computeClassTopicRemediation(db, selectedClassId, teacherId, classInfo.subject_id);

        // 3. Apply Filters
        if (filterQuarter) {
            topicResults = topicResults.filter(t => t.quarter_number === filterQuarter);
        }
        if (filterTopic) {
            topicResults = topicResults.filter(t => t.topic_id === filterTopic);
        }
        if (filterRisk) {
            if (filterRisk === 'high') {
                topicResults = topicResults.filter(t => t.overall_class_risk_pct >= 50);
            } else if (filterRisk === 'moderate') {
                topicResults = topicResults.filter(t => t.overall_class_risk_pct >= 25 && t.overall_class_risk_pct < 50);
            } else if (filterRisk === 'low') {
                topicResults = topicResults.filter(t => t.overall_class_risk_pct < 25);
            } else if (filterRisk === 'at_risk_only') {
                topicResults = topicResults.filter(t => t.no_of_students_at_risk > 0);
            }
        }

        // 4. Initialize PDF Document
        const auditRef = generateAuditRef('REMB');
        const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
        doc._currentAuditRef = auditRef;

        setExportHttpHeaders(res, `class_remediation_matrix_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        const filterParts = [];
        if (classInfo.class_name) filterParts.push(`Class: ${classInfo.class_name} — ${classInfo.subject_name}`);
        else filterParts.push('All Enrolled Classes');
        if (filterQuarter) filterParts.push(`Quarter ${filterQuarter}`);
        if (filterRisk) filterParts.push(`Risk: ${filterRisk.toUpperCase()}`);
        if (filterTopic) filterParts.push(`Topic ID: ${filterTopic}`);
        const scopeLabel = filterParts.join('  •  ');

        drawPdfDocumentHeader(doc, {
            title: 'CLASS REMEDIATION & CURRICULUM RISK MATRIX',
            scope: scopeLabel,
            user: req.user,
            role: 'Teacher',
            classification: 'CONFIDENTIAL — ACADEMIC INTERVENTION',
            auditRef
        });

        // 5. Summary KPI Bar (6 Metric Blocks)
        const startY = doc.y + 6;
        const cardW = 82;
        const cardH = 42;
        const cardGap = 6;

        const totalTopics = topicResults.length;
        const totalEnrolled = topicResults[0]?.total_enrolled || 0;
        const topicsNeedingRemediation = topicResults.filter(t => t.no_of_students_at_risk > 0).length;
        const highRiskTopics = topicResults.filter(t => t.overall_class_risk_pct >= 50).length;
        const validAsmtAvgs = topicResults.map(t => t.class_asmt_avg).filter(v => v !== null);
        const overallAsmtMean = validAsmtAvgs.length > 0 ? Math.round(validAsmtAvgs.reduce((a, b) => a + b, 0) / validAsmtAvgs.length) : null;
        const overallMeanRisk = totalTopics > 0 ? (topicResults.reduce((sum, t) => sum + t.overall_class_risk_pct, 0) / totalTopics).toFixed(1) : '0.0';

        const cards = [
            { label: 'TOPICS EVALUATED', val: String(totalTopics), sub: 'Curriculum Concepts', color: '#1e293b', bg: '#f8fafc' },
            { label: 'ACTIVE ENROLLED', val: String(totalEnrolled), sub: 'Students in Class', color: '#0369a1', bg: '#f0f9ff' },
            { label: 'TOPICS AT RISK', val: String(topicsNeedingRemediation), sub: `${highRiskTopics} High Risk (>=50%)`, color: '#e11d48', bg: '#fff1f2' },
            { label: 'CLASS RISK MEAN', val: `${overallMeanRisk}%`, sub: 'Curriculum Vulnerability', color: Number(overallMeanRisk) >= 50 ? '#be123c' : '#b45309', bg: '#fef2f2' },
            { label: 'CLASS ASMT MEAN', val: overallAsmtMean !== null ? `${overallAsmtMean}%` : 'N/A', sub: 'Across All Topics', color: '#047857', bg: '#f0fdf4' },
            { label: 'INTERVENTION GOAL', val: '< 25%', sub: 'Target Class Risk', color: '#4338ca', bg: '#eef2ff' }
        ];

        cards.forEach((c, idx) => {
            const cx = 36 + idx * (cardW + cardGap);
            doc.roundedRect(cx, startY, cardW, cardH, 5).fillAndStroke(c.bg, '#e2e8f0');
            doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748b').text(c.label, cx + 4, startY + 5.5, { width: cardW - 8, align: 'center' });
            doc.font('Helvetica-Bold').fontSize(11.5).fillColor(c.color).text(c.val, cx + 4, startY + 15.5, { width: cardW - 8, align: 'center' });
            doc.font('Helvetica').fontSize(6).fillColor('#94a3b8').text(c.sub, cx + 4, startY + 30, { width: cardW - 8, align: 'center' });
        });

        doc.x = 36;
        doc.y = startY + cardH + 16;

        // 6. Section Subtitle
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1e293b').text('CURRICULUM TOPIC VULNERABILITY & INTERVENTION MATRIX', 36, doc.y);
        doc.font('Helvetica').fontSize(6.5).fillColor('#64748b').text('Ranked by Overall Class Risk Percentage (descending). Highlights concepts where class performance falls below the DepEd 75% threshold.', 36, doc.y + 2);
        doc.moveDown(0.8);

        // 7. Table Columns
        const cols = {
            q: 36,
            topic: 56,
            enrolled: 202,
            atRisk: 242,
            asmtAvg: 296,
            asgnAvg: 350,
            forumPct: 404,
            classRisk: 456,
            status: 510
        };

        function drawBatchTableHeader(yPos) {
            doc.rect(36, yPos, 523, 20).fill('#1e1b4b');
            doc.fillColor('#ffffff').fontSize(6.5).font('Helvetica-Bold');
            doc.text('Q', cols.q + 3, yPos + 6, { width: 16 });
            doc.text('Topic Name', cols.topic, yPos + 6, { width: 142 });
            doc.text('Enrolled', cols.enrolled, yPos + 6, { width: 38, align: 'center' });
            doc.text('At Risk', cols.atRisk, yPos + 6, { width: 52, align: 'center' });
            doc.text('Asmt Avg', cols.asmtAvg, yPos + 6, { width: 52, align: 'center' });
            doc.text('Asgn Avg', cols.asgnAvg, yPos + 6, { width: 52, align: 'center' });
            doc.text('Forum %', cols.forumPct, yPos + 6, { width: 50, align: 'center' });
            doc.text('Risk %', cols.classRisk, yPos + 6, { width: 52, align: 'center' });
            doc.text('Status', cols.status, yPos + 6, { width: 45, align: 'center' });
            return yPos + 20;
        }

        let currY = drawBatchTableHeader(doc.y);

        // 8. Table Rows
        topicResults.forEach((t, idx) => {
            if (currY > 745) {
                doc.addPage();
                drawPdfDocumentHeader(doc, {
                    title: 'CLASS REMEDIATION & CURRICULUM RISK MATRIX',
                    scope: `${scopeLabel} (Continuation)`,
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — ACADEMIC INTERVENTION',
                    auditRef,
                    isContinuation: true
                });
                currY = drawBatchTableHeader(doc.y + 6);
            }

            const rowH = 20;
            const isHighRisk = t.overall_class_risk_pct >= 50;
            const isModRisk = t.overall_class_risk_pct >= 25 && t.overall_class_risk_pct < 50;

            const rowBg = isHighRisk
                ? (idx % 2 === 0 ? '#fff1f2' : '#ffe4e6')
                : (isModRisk ? (idx % 2 === 0 ? '#fefce8' : '#fef9c3') : (idx % 2 === 0 ? '#f8fafc' : '#ffffff'));

            doc.rect(36, currY, 523, rowH).fill(rowBg);
            doc.rect(36, currY, 523, rowH).strokeColor('#e2e8f0').lineWidth(0.4).stroke();

            // Quarter
            doc.font('Helvetica-Bold').fontSize(7).fillColor('#4338ca');
            doc.text(`Q${t.quarter_number || 1}`, cols.q + 3, currY + 6.5, { width: 16 });

            // Topic Name
            doc.font('Helvetica-Bold').fontSize(7).fillColor(isHighRisk ? '#9f1239' : '#1e293b');
            doc.text(t.topic_name, cols.topic, currY + 6.5, { width: 142, ellipsis: true });

            // Enrolled
            doc.font('Helvetica').fontSize(7).fillColor('#64748b');
            doc.text(String(t.total_enrolled), cols.enrolled, currY + 6.5, { width: 38, align: 'center' });

            // At Risk
            doc.font('Helvetica-Bold').fontSize(7).fillColor(t.no_of_students_at_risk > 0 ? '#e11d48' : '#059669');
            doc.text(`${t.no_of_students_at_risk} / ${t.total_enrolled}`, cols.atRisk, currY + 6.5, { width: 52, align: 'center' });

            // Asmt Avg
            doc.font('Helvetica').fontSize(7).fillColor(t.class_asmt_avg !== null ? (t.class_asmt_avg >= 75 ? '#059669' : '#e11d48') : '#94a3b8');
            doc.text(t.class_asmt_avg !== null ? `${t.class_asmt_avg}%` : '—', cols.asmtAvg, currY + 6.5, { width: 52, align: 'center' });

            // Asgn Avg
            doc.fillColor(t.class_asgn_avg !== null ? (t.class_asgn_avg >= 75 ? '#059669' : '#e11d48') : '#94a3b8');
            doc.text(t.class_asgn_avg !== null ? `${t.class_asgn_avg}%` : '—', cols.asgnAvg, currY + 6.5, { width: 52, align: 'center' });

            // Forum %
            doc.fillColor(t.class_forum_completion_pct !== null ? (t.class_forum_completion_pct >= 75 ? '#4338ca' : '#b45309') : '#94a3b8');
            doc.text(t.class_forum_completion_pct !== null ? `${t.class_forum_completion_pct}%` : '—', cols.forumPct, currY + 6.5, { width: 50, align: 'center' });

            // Risk %
            doc.font('Helvetica-Bold').fillColor(isHighRisk ? '#be123c' : (isModRisk ? '#b45309' : '#047857'));
            doc.text(`${t.overall_class_risk_pct}%`, cols.classRisk, currY + 6.5, { width: 52, align: 'center' });

            // Status Badge
            const badgeW = 44;
            const badgeH = 12;
            const badgeX = cols.status + (45 - badgeW) / 2;
            const badgeY = currY + 4;

            if (isHighRisk) {
                doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3).fill('#be123c');
                doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#ffffff').text('HIGH RISK', badgeX, badgeY + 3, { width: badgeW, align: 'center' });
            } else if (isModRisk) {
                doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3).fill('#d97706');
                doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#ffffff').text('MODERATE', badgeX, badgeY + 3, { width: badgeW, align: 'center' });
            } else {
                doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3).fill('#059669');
                doc.font('Helvetica-Bold').fontSize(5.5).fillColor('#ffffff').text('LOW RISK', badgeX, badgeY + 3, { width: badgeW, align: 'center' });
            }

            currY += rowH;
        });

        // 9. Teacher Guidance & Prescriptive Recommendations Box
        currY += 16;
        if (currY > 720) {
            doc.addPage();
            currY = 40;
        }

        doc.roundedRect(36, currY, 523, 64, 5).fillAndStroke('#f8fafc', '#cbd5e1');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e293b').text('TEACHER INTERVENTION DIRECTIVES & ACTION PLAN', 44, currY + 6);
        doc.font('Helvetica').fontSize(6.5).fillColor('#475569')
            .text(`1. Targeted Remediation: Topics with Risk % >= 50% indicate systemic class misunderstanding. Schedule synchronous reteaching sessions prior to summative tests.`, 44, currY + 18, { width: 507 })
            .text(`2. Individual Student Dossiers: Use the single-topic PDF button on the Export Hub to print individual diagnostic breakdowns for each concept.`, 44, currY + 28, { width: 507 })
            .text(`3. Task Re-submissions: Open remedial submission windows for unsubmitted assignments and discussion forums to raise baseline topic standing above 75%.`, 44, currY + 38, { width: 507 })
            .text(`4. DepEd Academic Standard: Ensure all at-risk students are given constructive remedial activities in compliance with DepEd Order No. 8, s. 2015.`, 44, currY + 48, { width: 507 });

        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — TEACHER COPY');
        doc.end();

        await logActivity(req.user.user_id, 'Teacher', 'EXPORT_REMEDIATION_BATCH_PDF',
            `Exported Class Remediation Batch PDF (Ref: ${auditRef})`);

    } catch (err) {
        console.error('❌ [GET /reports/export/remediation/pdf]', err);
        if (!res.headersSent) {
            res.status(500).send('PDF generation failed.');
        }
    }
});


// ── D. Consolidated Batch Report Cards — PDF ────────────────────────────────
router.get('/reports/export/report-card-batch/pdf', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const isMultiClass = (req.query.class_id === 'all' || !req.query.class_id || req.query.class_id === '');
    const filterQuarter = req.query.quarter && req.query.quarter !== 'all' ? req.query.quarter : null;

    const filters = {
        quarter: filterQuarter,
        inc_asmt: req.query.inc_asmt === '1',
        asmt_topic: req.query.asmt_topic && req.query.asmt_topic !== 'all' ? req.query.asmt_topic : null,
        asmt_type: req.query.asmt_type && req.query.asmt_type !== 'all' ? req.query.asmt_type : null,
        asmt_status: req.query.asmt_status || 'all',

        inc_asgn: req.query.inc_asgn === '1',
        asgn_topic: req.query.asgn_topic && req.query.asgn_topic !== 'all' ? req.query.asgn_topic : null,
        asgn_mode: req.query.asgn_mode && req.query.asgn_mode !== 'all' ? req.query.asgn_mode : null,

        inc_forums: req.query.inc_forums === '1',
        forum_topic: req.query.forum_topic && req.query.forum_topic !== 'all' ? req.query.forum_topic : null,
        forum_done: req.query.forum_done || 'all',

        inc_sim: req.query.inc_sim === '1',
        sim_slugs: req.query.sim_slugs ? req.query.sim_slugs.split(',').map(s => s.trim()).filter(Boolean) : [],
        sim_status: req.query.sim_status || 'all'
    };

    try {
        const [allTeacherClasses] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, sy.sy_range,
                   COALESCE(GROUP_CONCAT(q.quarter_number ORDER BY q.quarter_number), '1,2') as quarters
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN quarters q ON s.subject_id = q.subject_id
            WHERE c.teacher_id = ?
            GROUP BY c.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, sy.sy_range
            ORDER BY c.class_name ASC, s.subject_name ASC`, [teacherId]);

        if (!allTeacherClasses.length) {
            return res.status(400).send('No active classes found for this teacher.');
        }

        const qNum = filterQuarter ? parseInt(filterQuarter, 10) : null;
        let targetClasses = [];

        if (isMultiClass) {
            if (qNum) {
                targetClasses = allTeacherClasses.filter(c => {
                    const cQuarters = (c.quarters || '').split(',').map(Number);
                    return cQuarters.includes(qNum);
                });
                if (!targetClasses.length) {
                    return res.status(400).send(`None of your classes offer Quarter ${qNum}.`);
                }
            } else {
                targetClasses = allTeacherClasses;
            }
        } else {
            const single = allTeacherClasses.find(c => String(c.class_id) === String(req.query.class_id));
            if (!single) return res.status(403).send('Unauthorized class filter or class not found.');
            
            const classQuarters = (single.quarters || '').split(',').map(Number);
            if (qNum && !classQuarters.includes(qNum)) {
                return res.status(400).send(`Invalid Quarter: Class "${single.class_name} — ${single.subject_name}" only covers Quarters ${classQuarters.join(' & ')}. Quarter ${qNum} does not exist for this subject.`);
            }
            targetClasses = [single];
        }

        const targetClassIds = targetClasses.map(c => c.class_id);
        const placeholders = targetClassIds.map(() => '?').join(',');

        const [enrollments] = await db.query(`
            SELECT u.user_id, u.first_name, u.middle_name, u.last_name, u.lrn_number,
                   u.grade_level, u.section, u.strand, u.current_level, u.total_exp, u.email,
                   cs.class_id, c.class_name, c.subject_id, s.subject_code, s.subject_name, s.semester, sy.sy_range,
                   COALESCE(sp.progress_percent, 0) AS syllabus_progress,
                   (SELECT COALESCE(GROUP_CONCAT(q.quarter_number ORDER BY q.quarter_number), '1,2') FROM quarters q WHERE q.subject_id = c.subject_id) AS quarters
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = c.subject_id
            WHERE cs.class_id IN (${placeholders}) AND u.role = 'Student'
            ORDER BY c.class_name ASC, s.subject_name ASC, u.last_name ASC, u.first_name ASC`,
            targetClassIds
        );

        function formatQuarterScopeLabel(quartersStr, selectedQuarter) {
            if (selectedQuarter) return `Quarter ${selectedQuarter}`;
            const qList = (quartersStr || '').split(',').filter(Boolean);
            if (!qList.length) return 'All Quarters';
            return `All Quarters (${qList.map(x => `Q${x}`).join(' & ')})`;
        }

        const auditRef = generateAuditRef('BAT');
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        doc._currentAuditRef = auditRef;

        const downloadFileName = isMultiClass
            ? `batch_report_cards_all_classes_${auditRef}.pdf`
            : `batch_report_cards_${targetClasses[0].class_name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${auditRef}.pdf`;

        setExportHttpHeaders(res, downloadFileName, 'application/pdf');
        doc.pipe(res);

        const scopeQuarterLabel = isMultiClass
            ? (qNum ? `Quarter ${qNum}` : 'All Quarters (Q1 to Q4)')
            : formatQuarterScopeLabel(targetClasses[0].quarters, qNum);

        const scopeLabel = isMultiClass
            ? `All My Classes (${targetClasses.map(c => `${c.class_name} — ${c.subject_name}`).join(', ')})  •  ${scopeQuarterLabel}`
            : `${targetClasses[0].class_name} — ${targetClasses[0].subject_name} (SY ${targetClasses[0].sy_range})  •  ${scopeQuarterLabel}`;

        // Page 1: Consolidated Class Cover / Roster Summary
        drawPdfDocumentHeader(doc, {
            title: 'CONSOLIDATED CLASS REPORT CARDS',
            scope: scopeLabel,
            user: req.user,
            role: 'Teacher',
            classification: 'CONFIDENTIAL — OFFICIAL REPORT',
            auditRef
        });

        // Overview / Active Filters Strip
        const activeComponents = [];
        if (filters.inc_asmt) activeComponents.push('Assessments' + (filters.asmt_type ? ` (${filters.asmt_type})` : ''));
        if (filters.inc_asgn) activeComponents.push('Assignments' + (filters.asgn_mode ? ` (${filters.asgn_mode})` : ''));
        if (filters.inc_forums) activeComponents.push('Forums' + (filters.forum_done !== 'all' ? ` (${filters.forum_done})` : ''));
        if (filters.inc_sim) activeComponents.push(`Simulations (${filters.sim_slugs.length ? filters.sim_slugs.length + ' selected' : 'All'})`);

        const badgeY = doc.y;
        doc.rect(40, badgeY, 515, 24).fill('#f1f5f9');
        doc.fillColor('#334155').fontSize(8).font('Helvetica-Bold')
           .text(`ENROLLED STUDENTS: ${enrollments.length}   |   CLASSES: ${targetClasses.length}   |   QUARTER: ${scopeQuarterLabel}   |   ACTIVE COMPONENTS: ${activeComponents.length ? activeComponents.join(', ') : 'None selected'}`,
                 45, badgeY + 7, { width: 505, align: 'center' });

        doc.y = badgeY + 32;

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#312E81').text('Class Enrollment Roster & Progress Overview', 40);
        doc.moveDown(0.3);

        function drawRosterHeader() {
            const rY = doc.y;
            doc.rect(40, rY, 515, 15).fill('#1e293b');
            doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
            if (isMultiClass) {
                doc.text('#', 45, rY + 4, { width: 18 });
                doc.text('Student Name', 68, rY + 4, { width: 145 });
                doc.text('Class / Subject', 215, rY + 4, { width: 125 });
                doc.text('LRN', 342, rY + 4, { width: 75 });
                doc.text('Level', 420, rY + 4, { width: 35 });
                doc.text('EXP', 458, rY + 4, { width: 45 });
                doc.text('Syllabus %', 505, rY + 4, { width: 45, align: 'right' });
            } else {
                doc.text('#', 45, rY + 4, { width: 20 });
                doc.text('Student Name', 70, rY + 4, { width: 170 });
                doc.text('LRN', 245, rY + 4, { width: 90 });
                doc.text('Level', 340, rY + 4, { width: 45 });
                doc.text('EXP', 390, rY + 4, { width: 60 });
                doc.text('Syllabus %', 460, rY + 4, { width: 85, align: 'right' });
            }
            doc.y = rY + 18;
        }

        drawRosterHeader();

        doc.font('Helvetica').fontSize(8).fillColor('#1e293b');
        enrollments.forEach((s, idx) => {
            if (doc.y + 16 > 760) {
                doc.addPage();
                drawPdfDocumentHeader(doc, {
                    title: 'CONSOLIDATED CLASS REPORT CARDS',
                    scope: scopeLabel + ' (Enrollment Roster Cont.)',
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — OFFICIAL REPORT',
                    auditRef,
                    isContinuation: true
                });
                drawRosterHeader();
            }
            const rowY = doc.y;
            doc.rect(40, rowY, 515, 14).fill(idx % 2 === 0 ? '#f8fafc' : '#ffffff');
            doc.fillColor('#1e293b');
            if (isMultiClass) {
                doc.text(String(idx + 1), 45, rowY + 3, { width: 18 });
                doc.text(`${s.last_name}, ${s.first_name}${s.middle_name ? ' ' + s.middle_name : ''}`, 68, rowY + 3, { width: 145 });
                doc.text(`${s.class_name} — ${s.subject_name}`, 215, rowY + 3, { width: 125 });
                doc.text(s.lrn_number || '—', 342, rowY + 3, { width: 75 });
                doc.text(`Lv.${s.current_level || 1}`, 420, rowY + 3, { width: 35 });
                doc.fillColor('#059669').text(`+${(s.total_exp || 0).toLocaleString()}`, 458, rowY + 3, { width: 45 });
                doc.fillColor('#312E81').text(`${s.syllabus_progress}%`, 505, rowY + 3, { width: 45, align: 'right' });
            } else {
                doc.text(String(idx + 1), 45, rowY + 3, { width: 20 });
                doc.text(`${s.last_name}, ${s.first_name}${s.middle_name ? ' ' + s.middle_name : ''}`, 70, rowY + 3, { width: 170 });
                doc.text(s.lrn_number || '—', 245, rowY + 3, { width: 90 });
                doc.text(`Lv.${s.current_level || 1}`, 340, rowY + 3, { width: 45 });
                doc.fillColor('#059669').text(`+${(s.total_exp || 0).toLocaleString()}`, 390, rowY + 3, { width: 60 });
                doc.fillColor('#312E81').text(`${s.syllabus_progress}%`, 460, rowY + 3, { width: 85, align: 'right' });
            }
            doc.y = rowY + 14;
        });

        if (!enrollments.length) {
            doc.fontSize(8.5).font('Helvetica-Oblique').fillColor('#94a3b8')
                .text('No students enrolled in the selected class scope.', 40, doc.y + 10, { align: 'center', width: 515 });
        }

        // Generate per-student report cards with STRICT Page Isolation
        for (const student of enrollments) {
            doc.addPage();
            const studentData = await getStudentFilteredReportData(student.user_id, student.class_id, student.subject_id, filters);
            const studentQuarterScope = formatQuarterScopeLabel(student.quarters, qNum);
            const studentScope = `${student.class_name} — ${student.subject_name} (SY ${student.sy_range})  •  ${studentQuarterScope}`;
            renderStudentProgressReportCardPage(doc, studentData, {
                scopeLabel: studentScope,
                user: req.user,
                auditRef,
                filters
            });
        }

        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — OFFICIAL REPORT');
        doc.end();

        await logActivity(req.user.user_id, 'Teacher', 'EXPORT_REPORT_CARD_BATCH_PDF',
            `Exported Batch Report Cards for ${isMultiClass ? 'All Classes' : 'Class ' + targetClasses[0].class_id} (${enrollments.length} enrollments, Ref: ${auditRef})`);

    } catch (err) {
        console.error('❌ [GET /reports/export/report-card-batch/pdf]', err);
        res.status(500).send('Batch PDF generation failed.');
    }
});


// ── E. Master Class Gradebook — Parameter Sanitizer & Route Handlers ─────────
/**
 * Sanitizes and validates query parameters for Master Class Gradebook exports.
 * Strictly enforces positive integer IDs or 'all', quarter [1..4] or null, and standing ('passed', 'at_risk', or null).
 */
function sanitizeGradebookQueryParams(query = {}) {
    let selectedClassId = 'all';
    if (query.class_id !== undefined && query.class_id !== null && query.class_id !== '') {
        const strVal = String(query.class_id).trim();
        if (strVal !== 'all') {
            const parsed = parseInt(strVal, 10);
            if (!isNaN(parsed) && parsed > 0) {
                selectedClassId = parsed;
            }
        }
    }

    let filterQuarter = null;
    if (query.quarter !== undefined && query.quarter !== null && query.quarter !== '') {
        const q = parseInt(String(query.quarter).trim(), 10);
        if ([1, 2, 3, 4].includes(q)) {
            filterQuarter = q;
        }
    }

    let filterStanding = null;
    if (query.standing) {
        const s = String(query.standing).trim().toLowerCase();
        if (s === 'passed' || s === 'at_risk' || s === 'incomplete') {
            filterStanding = s;
        }
    }

    const parseWeightParam = (val, def) => {
        if (val === undefined || val === null || val === '') return def;
        const n = Number(val);
        return (!isNaN(n) && n >= 0 && n <= 100) ? Math.round(n * 100) / 100 : def;
    };

    const weights = {
        asmt: parseWeightParam(query.w_asmt, 30),
        asgn: parseWeightParam(query.w_asgn, 30),
        forum: parseWeightParam(query.w_forum, 10),
        sim: parseWeightParam(query.w_sim, 20),
        syllabus: parseWeightParam(query.w_syllabus, 10),
        lms: parseWeightParam(query.w_lms, 80),
        att: parseWeightParam(query.w_att, 20),
        q1: parseWeightParam(query.w_q1, 50),
        q2: parseWeightParam(query.w_q2, 50),
        q3: parseWeightParam(query.w_q3, 50),
        q4: parseWeightParam(query.w_q4, 50)
    };

    return { selectedClassId, filterQuarter, filterStanding, weights };
}

// ── E. Master Class Gradebook — Excel ────────────────────────────────────────
router.get('/reports/export/gradebook/excel', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { selectedClassId, filterQuarter, filterStanding, weights } = sanitizeGradebookQueryParams(req.query);

    try {
        const gradebookData = await computeClassGradebookData(db, selectedClassId, teacherId, {
            quarter: filterQuarter,
            standing: filterStanding,
            weights
        });

        if (!gradebookData.classes || gradebookData.classes.length === 0) {
            if (selectedClassId !== 'all') {
                return res.status(403).send('Unauthorized or non-existent class selection.');
            }
            return res.status(404).send('No active classes found for gradebook export.');
        }

        const auditRef = generateAuditRef('GBK');
        const wb = new ExcelJS.Workbook();
        wb.creator = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Teacher';
        wb.created = new Date();
        wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

        const usedSheetNames = new Set();
        function getUniqueSheetName(baseName) {
            let clean = (baseName || 'Sheet').replace(/[*?:/\\\[\]]/g, '').trim();
            if (clean.length > 31) clean = clean.substring(0, 31).trim();
            if (!clean) clean = 'Sheet';
            if (!usedSheetNames.has(clean.toLowerCase())) {
                usedSheetNames.add(clean.toLowerCase());
                return clean;
            }
            let counter = 2;
            while (true) {
                const suffix = ` (${counter})`;
                const trimmed = clean.substring(0, 31 - suffix.length).trim() + suffix;
                if (!usedSheetNames.has(trimmed.toLowerCase())) {
                    usedSheetNames.add(trimmed.toLowerCase());
                    return trimmed;
                }
                counter++;
            }
        }

        // Descriptive scope strings
        let quarterDesc = 'All Quarters (Full SY)';
        let quarterFileSlug = 'All_Quarters';
        if (filterQuarter) {
            quarterDesc = `Quarter ${filterQuarter}`;
            quarterFileSlug = `Q${filterQuarter}`;
        }

        let standingDesc = 'All Academic Standings';
        let standingFileSlug = 'All';
        if (filterStanding === 'passed') {
            standingDesc = 'Passed Only (>=75%)';
            standingFileSlug = 'Passed';
        } else if (filterStanding === 'at_risk') {
            standingDesc = 'At-Risk Only (<75%)';
            standingFileSlug = 'AtRisk';
        } else if (filterStanding === 'incomplete') {
            standingDesc = 'Incomplete Only';
            standingFileSlug = 'Incomplete';
        }

        // Shared Sheet Renderer
        function buildGradebookWorksheet(ws, {
            title = 'Master Class Gradebook & Assessment Summary',
            scopeText,
            kpis,
            students,
            isConsolidated = false
        }) {
            const lastCol = isConsolidated ? 'R' : 'Q';

            applyExcelMetadataHeader(ws, {
                title,
                scope: scopeText,
                user: req.user,
                role: 'Teacher',
                classification: 'CONFIDENTIAL — OFFICIAL GRADEBOOK',
                auditRef,
                lastCol
            });

            // ── KPI Summary Block (Rows 7-8) ─────────────────────────
            // Distribute 6 KPI Cards across Columns
            if (isConsolidated) {
                // 18 Columns: A to R (3 cols per card)
                ws.mergeCells('A7:C7'); ws.mergeCells('A8:C8');
                ws.mergeCells('D7:F7'); ws.mergeCells('D8:F8');
                ws.mergeCells('G7:I7'); ws.mergeCells('G8:I8');
                ws.mergeCells('J7:L7'); ws.mergeCells('J8:L8');
                ws.mergeCells('M7:O7'); ws.mergeCells('M8:O8');
                ws.mergeCells('P7:R7'); ws.mergeCells('P8:R8');
            } else {
                // 17 Columns: A to Q (2 + 3 + 3 + 3 + 3 + 3)
                ws.mergeCells('A7:B7'); ws.mergeCells('A8:B8');
                ws.mergeCells('C7:E7'); ws.mergeCells('C8:E8');
                ws.mergeCells('F7:H7'); ws.mergeCells('F8:H8');
                ws.mergeCells('I7:K7'); ws.mergeCells('I8:K8');
                ws.mergeCells('L7:N7'); ws.mergeCells('L8:N8');
                ws.mergeCells('O7:Q7'); ws.mergeCells('O8:Q8');
            }

            const kpiLabels = isConsolidated ? [
                { cell: 'A7', text: 'TOTAL ENROLLED' },
                { cell: 'D7', text: 'PASSING RATE (>=75%)' },
                { cell: 'G7', text: 'STUDENTS AT RISK (<75%)' },
                { cell: 'J7', text: 'CLASS LMS MEAN' },
                { cell: 'M7', text: 'SIMULATION MASTERY MEAN' },
                { cell: 'P7', text: 'COMPOSITE CLASS GRADE' }
            ] : [
                { cell: 'A7', text: 'TOTAL ENROLLED' },
                { cell: 'C7', text: 'PASSING RATE (>=75%)' },
                { cell: 'F7', text: 'STUDENTS AT RISK (<75%)' },
                { cell: 'I7', text: 'CLASS LMS MEAN' },
                { cell: 'L7', text: 'SIMULATION MASTERY MEAN' },
                { cell: 'O7', text: 'COMPOSITE CLASS GRADE' }
            ];

            const kpiValues = isConsolidated ? [
                { cell: 'A8', text: `${kpis.totalEnrolled} Students`, color: 'FF0F172A' },
                { cell: 'D8', text: `${kpis.passingRate}% (${kpis.passedCount}/${kpis.totalEnrolled})`, color: 'FF15803D' },
                { cell: 'G8', text: `${kpis.atRiskRate}% (${kpis.atRiskCount}/${kpis.totalEnrolled})`, color: 'FFB91C1C' },
                { cell: 'J8', text: kpis.classLmsMean !== null ? `${kpis.classLmsMean}%` : '—', color: 'FF0F172A' },
                { cell: 'M8', text: kpis.classArcadeMean !== null ? `${kpis.classArcadeMean}%` : '—', color: 'FF0F172A' },
                { cell: 'P8', text: kpis.classFinalMean !== null ? `${kpis.classFinalMean}%` : '—', color: 'FF1E1B4B' }
            ] : [
                { cell: 'A8', text: `${kpis.totalEnrolled} Students`, color: 'FF0F172A' },
                { cell: 'C8', text: `${kpis.passingRate}% (${kpis.passedCount}/${kpis.totalEnrolled})`, color: 'FF15803D' },
                { cell: 'F8', text: `${kpis.atRiskRate}% (${kpis.atRiskCount}/${kpis.totalEnrolled})`, color: 'FFB91C1C' },
                { cell: 'I8', text: kpis.classLmsMean !== null ? `${kpis.classLmsMean}%` : '—', color: 'FF0F172A' },
                { cell: 'L8', text: kpis.classArcadeMean !== null ? `${kpis.classArcadeMean}%` : '—', color: 'FF0F172A' },
                { cell: 'O8', text: kpis.classFinalMean !== null ? `${kpis.classFinalMean}%` : '—', color: 'FF1E1B4B' }
            ];

            ws.getRow(7).height = 18;
            ws.getRow(8).height = 24;

            kpiLabels.forEach(k => {
                const c = ws.getCell(k.cell);
                c.value = k.text;
                c.font = { bold: true, size: 8, color: { argb: 'FF475569' } };
                c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                c.alignment = { horizontal: 'center', vertical: 'middle' };
                c.border = {
                    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                };
            });

            kpiValues.forEach(k => {
                const c = ws.getCell(k.cell);
                c.value = k.text;
                c.font = { bold: true, size: 12, color: { argb: k.color } };
                c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
                c.alignment = { horizontal: 'center', vertical: 'middle' };
                c.border = {
                    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    bottom: { style: 'medium', color: { argb: 'FFCBD5E1' } }
                };
            });

            // Row 9: Blank spacer
            ws.addRow([]);

            // ── Table Header (Row 10) ────────────────────────────────
            const headerTitles = isConsolidated ? [
                '#', 'LRN Number', 'Last Name', 'First Name', 'Class / Subject', 'Sex',
                'Attendance Rate', 'Written Works (Asmt %)', 'Performance Tasks (Asgn %)', 'Participation (Forum %)',
                'LMS Coursework Avg', 'Simulation Mastery %', 'Total EXP',
                'Q1 Final %', 'Q2 Final %', 'Semestral Final %', 'Academic Standing', 'Chem 2 Prerequisite Status'
            ] : [
                '#', 'LRN Number', 'Last Name', 'First Name', 'Sex',
                'Attendance Rate', 'Written Works (Asmt %)', 'Performance Tasks (Asgn %)', 'Participation (Forum %)',
                'LMS Coursework Avg', 'Simulation Mastery %', 'Total EXP',
                'Q1 Final %', 'Q2 Final %', 'Semestral Final %', 'Academic Standing', 'Chem 2 Prerequisite Status'
            ];

            const headerRow = ws.addRow(headerTitles);
            headerRow.height = 28;
            headerRow.eachCell(cell => {
                cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'medium', color: { argb: 'FF06B6D4' } },
                    bottom: { style: 'medium', color: { argb: 'FF06B6D4' } },
                    left: { style: 'thin', color: { argb: 'FF312E81' } },
                    right: { style: 'thin', color: { argb: 'FF312E81' } }
                };
            });

            // ── Data Rows ────────────────────────────────────────────
            if (students.length === 0) {
                const emptyRow = ws.addRow(['No student records match the specified filters.']);
                ws.mergeCells(`A11:${lastCol}11`);
                emptyRow.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
                emptyRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
                emptyRow.height = 24;
            } else {
                students.forEach((s, idx) => {
                    const asmtCellStr = (s.asmt && s.asmt.pct !== null)
                        ? `${s.asmt.submitted}/${s.asmt.count} (${s.asmt.pct}%)`
                        : (s.asmt && s.asmt.count > 0 ? `0/${s.asmt.count} (—)` : '—');
                    const asgnCellStr = (s.asgn && s.asgn.pct !== null)
                        ? `${s.asgn.submitted}/${s.asgn.count} (${s.asgn.pct}%)`
                        : (s.asgn && s.asgn.count > 0 ? `0/${s.asgn.count} (—)` : '—');
                    const forumCellStr = (s.forum && s.forum.pct !== null)
                        ? `${s.forum.completed}/${s.forum.total} (${s.forum.pct}%)`
                        : (s.forum && s.forum.total > 0 ? `0/${s.forum.total} (—)` : '—');
                    const simCellStr = s.arcade_avg !== null
                        ? `${s.arcade_avg}%`
                        : (!s.is_incomplete && (gradebookData.weights?.sim || 0) > 0 ? '0%' : '—');

                    const q1Str = s.q1_grade !== null ? `${s.q1_grade}%` : '—';
                    const q2Str = s.q2_grade !== null ? `${s.q2_grade}%` : '—';
                    const semStr = s.semestral_grade !== null ? `${s.semestral_grade}%` : (s.final_grade !== null ? `${s.final_grade}%` : '—');
                    const chem2Badge = s.chem2_eligibility ? (s.chem2_eligibility.badge || s.chem2_eligibility.status || '—') : '—';

                    const rowData = isConsolidated ? [
                        idx + 1,
                        String(s.lrn_number || '—'),
                        s.last_name || '',
                        s.first_name || '',
                        s.class_display || '',
                        s.sex || '—',
                        s.attendance && s.attendance.rate !== null ? `${s.attendance.rate}%` : '—',
                        asmtCellStr,
                        asgnCellStr,
                        forumCellStr,
                        s.lms_avg !== null ? `${s.lms_avg}%` : '—',
                        simCellStr,
                        Number(s.total_exp || 0),
                        q1Str,
                        q2Str,
                        semStr,
                        s.standing,
                        chem2Badge
                    ] : [
                        idx + 1,
                        String(s.lrn_number || '—'),
                        s.last_name || '',
                        s.first_name || '',
                        s.sex || '—',
                        s.attendance && s.attendance.rate !== null ? `${s.attendance.rate}%` : '—',
                        asmtCellStr,
                        asgnCellStr,
                        forumCellStr,
                        s.lms_avg !== null ? `${s.lms_avg}%` : '—',
                        simCellStr,
                        Number(s.total_exp || 0),
                        q1Str,
                        q2Str,
                        semStr,
                        s.standing,
                        chem2Badge
                    ];

                    const row = ws.addRow(rowData);
                    row.height = 20;

                    // Formatting
                    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
                    row.getCell(2).numFmt = '@';
                    row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
                    row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle' };
                    row.getCell(4).alignment = { horizontal: 'left', vertical: 'middle' };

                    const expColIdx = isConsolidated ? 13 : 12;
                    const lmsAvgColIdx = isConsolidated ? 11 : 10;
                    const q1ColIdx = isConsolidated ? 14 : 13;
                    const q2ColIdx = isConsolidated ? 15 : 14;
                    const semGradeColIdx = isConsolidated ? 16 : 15;
                    const standingColIdx = isConsolidated ? 17 : 16;
                    const chem2ColIdx = isConsolidated ? 18 : 17;

                    if (isConsolidated) {
                        row.getCell(5).alignment = { horizontal: 'left', vertical: 'middle' }; // Class
                        row.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' }; // Sex
                        row.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' }; // Att
                        row.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' }; // Asmt
                        row.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' }; // Asgn
                        row.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' }; // Forum
                        row.getCell(11).alignment = { horizontal: 'center', vertical: 'middle' }; // LMS Avg
                        row.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' }; // Arcade Avg
                    } else {
                        row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' }; // Sex
                        row.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' }; // Att
                        row.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' }; // Asmt
                        row.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' }; // Asgn
                        row.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' }; // Forum
                        row.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' }; // LMS Avg
                        row.getCell(11).alignment = { horizontal: 'center', vertical: 'middle' }; // Arcade Avg
                    }

                    row.getCell(lmsAvgColIdx).font = { bold: true };
                    row.getCell(expColIdx).numFmt = '#,##0';
                    row.getCell(expColIdx).alignment = { horizontal: 'right', vertical: 'middle' };
                    row.getCell(q1ColIdx).alignment = { horizontal: 'center', vertical: 'middle' };
                    row.getCell(q2ColIdx).alignment = { horizontal: 'center', vertical: 'middle' };
                    row.getCell(semGradeColIdx).font = { bold: true, color: { argb: 'FF1E1B4B' } };
                    row.getCell(semGradeColIdx).alignment = { horizontal: 'center', vertical: 'middle' };

                    // Zebra striping
                    const isEven = (idx % 2 === 0);
                    row.eachCell((cell, colNum) => {
                        cell.border = {
                            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                        };
                        if (isEven && colNum !== standingColIdx && colNum !== chem2ColIdx) {
                            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                        }
                    });

                    // Standing badge
                    const statusCell = row.getCell(standingColIdx);
                    statusCell.alignment = { horizontal: 'center', vertical: 'middle' };
                    if (s.standing === 'Passed') {
                        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
                        statusCell.font = { bold: true, color: { argb: 'FF15803D' }, size: 9 };
                    } else if (s.standing === 'At-Risk') {
                        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                        statusCell.font = { bold: true, color: { argb: 'FFB91C1C' }, size: 9 };
                    } else {
                        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                        statusCell.font = { italic: true, color: { argb: 'FF64748B' }, size: 9 };
                    }

                    // Chem 2 Prerequisite Status badge
                    const chem2Cell = row.getCell(chem2ColIdx);
                    chem2Cell.alignment = { horizontal: 'center', vertical: 'middle' };
                    if (s.chem2_eligibility && (s.chem2_eligibility.code === 'PASSED' || s.chem2_eligibility.status === 'ELIGIBLE')) {
                        chem2Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
                        chem2Cell.font = { bold: true, color: { argb: 'FF15803D' }, size: 9 };
                    } else if (s.chem2_eligibility && (s.chem2_eligibility.code === 'FAILED' || s.chem2_eligibility.status === 'INELIGIBLE')) {
                        chem2Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                        chem2Cell.font = { bold: true, color: { argb: 'FFB91C1C' }, size: 9 };
                    } else if (s.chem2_eligibility && (s.chem2_eligibility.code === 'PENDING' || s.chem2_eligibility.status === 'PENDING')) {
                        chem2Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
                        chem2Cell.font = { bold: true, color: { argb: 'FFB45309' }, size: 9 };
                    } else if (s.chem2_eligibility && (s.chem2_eligibility.code === 'ENROLLED' || s.chem2_eligibility.status === 'CURRENT_CHEM2')) {
                        chem2Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
                        chem2Cell.font = { bold: true, color: { argb: 'FF3730A3' }, size: 9 };
                    } else {
                        chem2Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                        chem2Cell.font = { italic: true, color: { argb: 'FF64748B' }, size: 9 };
                    }
                });

                // ── Footer Rows ──────────────────────────────────────────
                ws.addRow([]); // Blank spacer

                // Footer Row 1: Class Means
                const sumRow1 = ws.addRow([]);
                sumRow1.height = 22;
                if (isConsolidated) {
                    ws.mergeCells(`A${sumRow1.number}:E${sumRow1.number}`);
                    sumRow1.getCell(1).value = 'Consolidated Class Performance Means:';
                    sumRow1.getCell(1).font = { bold: true, color: { argb: 'FF1E1B4B' }, size: 9.5 };
                    sumRow1.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
                    sumRow1.getCell(7).value = kpis.classAttMean !== null ? `${kpis.classAttMean}%` : '—';
                    sumRow1.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(7).font = { bold: true };
                    sumRow1.getCell(11).value = kpis.classLmsMean !== null ? `${kpis.classLmsMean}%` : '—';
                    sumRow1.getCell(11).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(11).font = { bold: true };
                    sumRow1.getCell(12).value = kpis.classArcadeMean !== null ? `${kpis.classArcadeMean}%` : '—';
                    sumRow1.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(12).font = { bold: true };
                    sumRow1.getCell(16).value = kpis.classFinalMean !== null ? `${kpis.classFinalMean}%` : '—';
                    sumRow1.getCell(16).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(16).font = { bold: true, color: { argb: 'FF1E1B4B' } };
                    sumRow1.getCell(16).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
                    sumRow1.getCell(17).value = `${kpis.passingRate}% Passing`;
                    sumRow1.getCell(17).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(17).font = { bold: true, color: { argb: 'FF15803D' } };
                } else {
                    ws.mergeCells(`A${sumRow1.number}:D${sumRow1.number}`);
                    sumRow1.getCell(1).value = 'Class Performance Means:';
                    sumRow1.getCell(1).font = { bold: true, color: { argb: 'FF1E1B4B' }, size: 9.5 };
                    sumRow1.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
                    sumRow1.getCell(6).value = kpis.classAttMean !== null ? `${kpis.classAttMean}%` : '—';
                    sumRow1.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(6).font = { bold: true };
                    sumRow1.getCell(10).value = kpis.classLmsMean !== null ? `${kpis.classLmsMean}%` : '—';
                    sumRow1.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(10).font = { bold: true };
                    sumRow1.getCell(11).value = kpis.classArcadeMean !== null ? `${kpis.classArcadeMean}%` : '—';
                    sumRow1.getCell(11).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(11).font = { bold: true };
                    sumRow1.getCell(15).value = kpis.classFinalMean !== null ? `${kpis.classFinalMean}%` : '—';
                    sumRow1.getCell(15).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(15).font = { bold: true, color: { argb: 'FF1E1B4B' } };
                    sumRow1.getCell(15).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
                    sumRow1.getCell(16).value = `${kpis.passingRate}% Passing`;
                    sumRow1.getCell(16).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow1.getCell(16).font = { bold: true, color: { argb: 'FF15803D' } };
                }

                // Footer Row 2: DepEd Roster Totals
                const sumRow2 = ws.addRow([]);
                sumRow2.height = 22;
                if (isConsolidated) {
                    ws.mergeCells(`A${sumRow2.number}:E${sumRow2.number}`);
                    sumRow2.getCell(1).value = 'DepEd Academic Standing Breakdown:';
                    sumRow2.getCell(1).font = { bold: true, color: { argb: 'FF1E1B4B' }, size: 9.5 };
                    sumRow2.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };

                    ws.mergeCells(`F${sumRow2.number}:I${sumRow2.number}`);
                    sumRow2.getCell(6).value = `Passed: ${kpis.passedCount} (${kpis.passingRate}%)`;
                    sumRow2.getCell(6).font = { bold: true, color: { argb: 'FF15803D' } };
                    sumRow2.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };

                    ws.mergeCells(`J${sumRow2.number}:M${sumRow2.number}`);
                    sumRow2.getCell(10).value = `At-Risk: ${kpis.atRiskCount} (${kpis.atRiskRate}%)`;
                    sumRow2.getCell(10).font = { bold: true, color: { argb: 'FFB91C1C' } };
                    sumRow2.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

                    ws.mergeCells(`N${sumRow2.number}:R${sumRow2.number}`);
                    sumRow2.getCell(14).value = `Total Enrolled: ${kpis.totalEnrolled} Students`;
                    sumRow2.getCell(14).font = { bold: true, color: { argb: 'FF1E293B' } };
                    sumRow2.getCell(14).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(14).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                } else {
                    ws.mergeCells(`A${sumRow2.number}:D${sumRow2.number}`);
                    sumRow2.getCell(1).value = 'DepEd Academic Standing Breakdown:';
                    sumRow2.getCell(1).font = { bold: true, color: { argb: 'FF1E1B4B' }, size: 9.5 };
                    sumRow2.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };

                    ws.mergeCells(`E${sumRow2.number}:H${sumRow2.number}`);
                    sumRow2.getCell(5).value = `Passed: ${kpis.passedCount} (${kpis.passingRate}%)`;
                    sumRow2.getCell(5).font = { bold: true, color: { argb: 'FF15803D' } };
                    sumRow2.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };

                    ws.mergeCells(`I${sumRow2.number}:L${sumRow2.number}`);
                    sumRow2.getCell(9).value = `At-Risk: ${kpis.atRiskCount} (${kpis.atRiskRate}%)`;
                    sumRow2.getCell(9).font = { bold: true, color: { argb: 'FFB91C1C' } };
                    sumRow2.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

                    ws.mergeCells(`M${sumRow2.number}:Q${sumRow2.number}`);
                    sumRow2.getCell(13).value = `Total Enrolled: ${kpis.totalEnrolled} Students`;
                    sumRow2.getCell(13).font = { bold: true, color: { argb: 'FF1E293B' } };
                    sumRow2.getCell(13).alignment = { horizontal: 'center', vertical: 'middle' };
                    sumRow2.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                }
            }

            // Column Widths
            if (isConsolidated) {
                ws.columns = [
                    { width: 6 },   // #
                    { width: 17 },  // LRN Number
                    { width: 16 },  // Last Name
                    { width: 16 },  // First Name
                    { width: 24 },  // Class / Subject
                    { width: 8 },   // Sex
                    { width: 16 },  // Attendance Rate
                    { width: 18 },  // Written Works
                    { width: 18 },  // Performance Tasks
                    { width: 16 },  // Participation
                    { width: 18 },  // LMS Coursework Avg
                    { width: 18 },  // Simulation Mastery %
                    { width: 14 },  // Total EXP
                    { width: 14 },  // Q1 Final %
                    { width: 14 },  // Q2 Final %
                    { width: 18 },  // Semestral Final %
                    { width: 18 },  // Academic Standing
                    { width: 22 }   // Chem 2 Prerequisite Status
                ];
            } else {
                ws.columns = [
                    { width: 6 },   // #
                    { width: 17 },  // LRN Number
                    { width: 18 },  // Last Name
                    { width: 18 },  // First Name
                    { width: 8 },   // Sex
                    { width: 16 },  // Attendance Rate
                    { width: 18 },  // Written Works
                    { width: 18 },  // Performance Tasks
                    { width: 16 },  // Participation
                    { width: 18 },  // LMS Coursework Avg
                    { width: 18 },  // Simulation Mastery %
                    { width: 14 },  // Total EXP
                    { width: 14 },  // Q1 Final %
                    { width: 14 },  // Q2 Final %
                    { width: 18 },  // Semestral Final %
                    { width: 18 },  // Academic Standing
                    { width: 22 }   // Chem 2 Prerequisite Status
                ];
            }
        }

        // Multi-Class vs Single-Class Generation
        const isMulti = gradebookData.isMultiClass || gradebookData.classes.length > 1;

        if (isMulti) {
            // Tab 1: Consolidated Roster
            const wsConsolidated = wb.addWorksheet(getUniqueSheetName('Consolidated Roster'));
            const allConsolidatedStudents = [];
            for (const cItem of gradebookData.classes) {
                for (const st of cItem.students) {
                    allConsolidatedStudents.push({
                        ...st,
                        class_display: `${cItem.classInfo.class_name} — ${cItem.classInfo.subject_code || cItem.classInfo.subject_name}`
                    });
                }
            }
            allConsolidatedStudents.sort((a, b) => {
                const ln = (a.last_name || '').localeCompare(b.last_name || '');
                if (ln !== 0) return ln;
                return (a.first_name || '').localeCompare(b.first_name || '');
            });

            const syRange = gradebookData.classes[0].classInfo.sy_range || '2025-2026';
            const multiScopeText = `All Classes (${gradebookData.classes.length} Sections) • SY ${syRange} • ${quarterDesc} • Filters: ${standingDesc}`;

            buildGradebookWorksheet(wsConsolidated, {
                title: 'Master Consolidated Gradebook & Assessment Summary',
                scopeText: multiScopeText,
                kpis: gradebookData.consolidatedKpis,
                students: allConsolidatedStudents,
                isConsolidated: true
            });

            // Individual Tabs per class
            for (const cItem of gradebookData.classes) {
                const sheetName = getUniqueSheetName(`${cItem.classInfo.class_name}`);
                const wsClass = wb.addWorksheet(sheetName);
                const effQDesc = cItem.classInfo.effectiveQuarterDesc || quarterDesc;
                const classScopeText = `Class: ${cItem.classInfo.class_name} — ${cItem.classInfo.subject_name} (SY ${cItem.classInfo.sy_range || '2025-2026'}) • ${effQDesc} • Filters: ${standingDesc}`;

                buildGradebookWorksheet(wsClass, {
                    title: `Master Gradebook: ${cItem.classInfo.class_name}`,
                    scopeText: classScopeText,
                    kpis: cItem.kpis,
                    students: cItem.students,
                    isConsolidated: false
                });
            }
        } else {
            // Single Class Mode
            const cItem = gradebookData.classes[0];
            const sheetName = getUniqueSheetName(`${cItem.classInfo.class_name} Gradebook`);
            const wsClass = wb.addWorksheet(sheetName);
            const effQDesc = cItem.classInfo.effectiveQuarterDesc || quarterDesc;
            const classScopeText = `Class: ${cItem.classInfo.class_name} — ${cItem.classInfo.subject_name} (SY ${cItem.classInfo.sy_range || '2025-2026'}) • ${effQDesc} • Filters: ${standingDesc}`;

            buildGradebookWorksheet(wsClass, {
                title: `Master Class Gradebook & Assessment Summary`,
                scopeText: classScopeText,
                kpis: cItem.kpis,
                students: cItem.students,
                isConsolidated: false
            });
        }

        // Filename and Delivery
        const rawClsName = (gradebookData.classes[0] && gradebookData.classes[0].classInfo && gradebookData.classes[0].classInfo.class_name) || 'Class';
        const clsSlug = rawClsName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
        let filename;
        if (isMulti) {
            filename = `master_gradebook_All_Classes_${quarterFileSlug}_${standingFileSlug}_${auditRef}.xlsx`;
        } else {
            filename = `master_gradebook_${clsSlug}_${quarterFileSlug}_${standingFileSlug}_${auditRef}.xlsx`;
        }

        setExportHttpHeaders(res, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await wb.xlsx.write(res);
        res.end();

        try {
            const logScope = isMulti ? `All Classes (${gradebookData.classes.length})` : rawClsName;
            await logActivity(teacherId, 'Teacher', 'EXPORT_GRADEBOOK_EXCEL',
                `Exported Master Gradebook Excel for ${logScope} (${quarterDesc}, Standing: ${standingDesc}, Ref: ${auditRef})`);
        } catch (logErr) {
            console.warn('[ActivityLog Warning]', logErr.message);
        }

    } catch (err) {
        console.error('❌ [GET /reports/export/gradebook/excel]', err);
        if (!res.headersSent) {
            res.status(500).send('Master Class Gradebook Excel generation failed.');
        } else {
            res.end();
        }
    }
});


// ── F. Master Class Gradebook — PDF ──────────────────────────────────────────
router.get('/reports/export/gradebook/pdf', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { selectedClassId, filterQuarter, filterStanding, weights } = sanitizeGradebookQueryParams(req.query);

    try {
        const gradebookData = await computeClassGradebookData(db, selectedClassId, teacherId, {
            quarter: filterQuarter,
            standing: filterStanding,
            weights
        });

        if (!gradebookData.classes || gradebookData.classes.length === 0) {
            if (selectedClassId !== 'all') {
                return res.status(403).send('Unauthorized or non-existent class selection.');
            }
            return res.status(404).send('No active classes found for gradebook PDF export.');
        }

        const activeWeights = gradebookData.weights || weights;
        const lmsWeightParts = [];
        if (activeWeights.asmt > 0) lmsWeightParts.push(`${activeWeights.asmt}% Asmt`);
        if (activeWeights.asgn > 0) lmsWeightParts.push(`${activeWeights.asgn}% Asgn`);
        if (activeWeights.forum > 0) lmsWeightParts.push(`${activeWeights.forum}% Frm`);
        if (activeWeights.sim > 0) lmsWeightParts.push(`${activeWeights.sim}% Sim`);
        if (activeWeights.syllabus > 0) lmsWeightParts.push(`${activeWeights.syllabus}% Syl`);
        const lmsWeightSub = `${activeWeights.asmt}/${activeWeights.asgn}/${activeWeights.forum}/${activeWeights.sim}/${activeWeights.syllabus}% Weights`;
        const lmsWeightFormulaStr = lmsWeightParts.join(' + ') || 'Coursework Avg';

        const finalWeightParts = [];
        if (activeWeights.lms > 0) finalWeightParts.push(`${activeWeights.lms}% LMS Avg`);
        if (activeWeights.att > 0) finalWeightParts.push(`${activeWeights.att}% Attendance`);
        const finalWeightSub = `${activeWeights.lms}% LMS + ${activeWeights.att}% Att`;
        const finalWeightFormulaStr = finalWeightParts.join(' + ') || '100% LMS Avg';

        const auditRef = generateAuditRef('GBK');
        const isMulti = gradebookData.isMultiClass || gradebookData.classes.length > 1;

        // Descriptive scope strings
        let quarterDesc = 'All Quarters (Full SY)';
        let quarterFileSlug = 'All_Quarters';
        if (filterQuarter) {
            quarterDesc = `Quarter ${filterQuarter}`;
            quarterFileSlug = `Q${filterQuarter}`;
        }

        let standingDesc = 'All Students';
        let standingFileSlug = 'All';
        if (filterStanding === 'passed') {
            standingDesc = 'Passed Only (>= 75%)';
            standingFileSlug = 'Passed';
        } else if (filterStanding === 'at_risk') {
            standingDesc = 'At-Risk Only (<75%)';
            standingFileSlug = 'AtRisk';
        } else if (filterStanding === 'incomplete') {
            standingDesc = 'Incomplete Only';
            standingFileSlug = 'Incomplete';
        }

        // Initialize Landscape A4 PDFKit Document (841.89 x 595.28 pt, 36pt margins -> 770pt printable width)
        const doc = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin: 36,
            bufferPages: true
        });
        doc._currentAuditRef = auditRef;

        const rawClsName = (gradebookData.classes[0] && gradebookData.classes[0].classInfo && gradebookData.classes[0].classInfo.class_name) || 'Class';
        const clsSlug = rawClsName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
        let filename;
        if (isMulti) {
            filename = `master_gradebook_All_Classes_${quarterFileSlug}_${standingFileSlug}_${auditRef}.pdf`;
        } else {
            filename = `master_gradebook_${clsSlug}_${quarterFileSlug}_${standingFileSlug}_${auditRef}.pdf`;
        }

        setExportHttpHeaders(res, filename, 'application/pdf');
        doc.on('error', (pdfErr) => {
            console.error('❌ [PDFKit Stream Error]', pdfErr);
        });
        doc.pipe(res);

        // Column layout: 15 columns totaling 770pt with DepEd Quarterly & Prerequisite Eligibility
        const COLS = [
            { id: 'num',      title: '#',                 width: 18,  align: 'center' },
            { id: 'lrn',      title: 'LRN Number',        width: 65,  align: 'left' },
            { id: 'name',     title: 'Student Full Name', width: 105, align: 'left' },
            { id: 'sex',      title: 'Sex',               width: 22,  align: 'center' },
            { id: 'att',      title: 'Att.',              width: 36,  align: 'center' },
            { id: 'asmt',     title: 'Written Works',     width: 50,  align: 'center' },
            { id: 'asgn',     title: 'Perf. Tasks',       width: 50,  align: 'center' },
            { id: 'forum',    title: 'Forums',            width: 40,  align: 'center' },
            { id: 'sim',      title: 'Sims',              width: 40,  align: 'center' },
            { id: 'lms',      title: 'LMS Avg',           width: 48,  align: 'center' },
            { id: 'q1',       title: 'Q1 Grade',          width: 46,  align: 'center' },
            { id: 'q2',       title: 'Q2 Grade',          width: 46,  align: 'center' },
            { id: 'sem',      title: 'Sem. Grade',        width: 52,  align: 'center' },
            { id: 'standing', title: 'Standing',          width: 54,  align: 'center' },
            { id: 'chem2',    title: 'Chem 2 Status',     width: 98,  align: 'center' }
        ];

        function drawGradebookTableHeader(startY) {
            const hH = 22;
            doc.rect(36, startY, 770, hH).fill('#1e1b4b');
            doc.rect(36, startY + hH - 1.5, 770, 1.5).fill('#06b6d4');

            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
            let curX = 36;
            for (const col of COLS) {
                const pad = col.align === 'left' ? 5 : 0;
                doc.text(col.title, curX + pad, startY + 7, {
                    width: col.width - (pad * 2),
                    align: col.align
                });
                curX += col.width;
            }
            return startY + hH;
        }

        function drawKpiCardsBar(startY, kpis) {
            const cardW = 121;
            const cardH = 42;
            const gap = 8.8;
            const cards = [
                { label: 'TOTAL ENROLLED', val: `${kpis.totalEnrolled}`, sub: 'Active Students', valColor: '#0f172a' },
                { label: 'PASSING RATE (>= 75%)', val: `${kpis.passingRate}%`, sub: `${kpis.passedCount}/${kpis.totalEnrolled} Students`, valColor: '#059669' },
                { label: 'STUDENTS AT RISK (<75%)', val: `${kpis.atRiskRate}%`, sub: `${kpis.atRiskCount}/${kpis.totalEnrolled} In Danger`, valColor: '#dc2626' },
                { label: 'CLASS LMS MEAN', val: kpis.classLmsMean !== null ? `${kpis.classLmsMean}%` : '—', sub: lmsWeightSub, valColor: '#0f172a' },
                { label: 'SIMULATION MASTERY', val: kpis.classArcadeMean !== null ? `${kpis.classArcadeMean}%` : '—', sub: 'Labs & Games', valColor: '#0f172a' },
                { label: 'COMPOSITE CLASS GRADE', val: kpis.classFinalMean !== null ? `${kpis.classFinalMean}%` : '—', sub: finalWeightSub, valColor: '#1e1b4b' }
            ];

            let curX = 36;
            for (const card of cards) {
                doc.roundedRect(curX, startY, cardW, cardH, 5).fillAndStroke('#f8fafc', '#cbd5e1');
                doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#64748b')
                   .text(card.label, curX + 3, startY + 5, { width: cardW - 6, align: 'center' });
                doc.fontSize(12).font('Helvetica-Bold').fillColor(card.valColor)
                   .text(card.val, curX + 3, startY + 15.5, { width: cardW - 6, align: 'center' });
                doc.fontSize(6).font('Helvetica').fillColor('#64748b')
                   .text(card.sub, curX + 2, startY + 30.5, { width: cardW - 4, align: 'center' });
                curX += cardW + gap;
            }

            return startY + cardH + 14;
        }

        // Render each class in the dossier
        for (let cIdx = 0; cIdx < gradebookData.classes.length; cIdx++) {
            const classObj = gradebookData.classes[cIdx];
            const cls = classObj.classInfo;
            const kpis = classObj.kpis;
            const students = classObj.students;

            if (cIdx > 0) {
                doc.addPage();
            }

            const effQDesc = cls.effectiveQuarterDesc || quarterDesc;
            const scopeText = `Class: ${cls.class_name} — ${cls.subject_name} (SY ${cls.sy_range || '2025-2026'}) • ${effQDesc} • Filters: ${standingDesc}`;

            // Draw Header
            let curY = drawPdfDocumentHeader(doc, {
                title: isMulti ? `MASTER CLASS GRADEBOOK: ${cls.class_name.toUpperCase()}` : 'MASTER CLASS GRADEBOOK & ASSESSMENT SUMMARY',
                scope: scopeText,
                user: req.user,
                role: 'Teacher',
                classification: 'CONFIDENTIAL — OFFICIAL GRADEBOOK',
                auditRef,
                layout: 'landscape'
            });

            // Draw KPI Cards Bar (with comfortable top breathing room)
            curY = drawKpiCardsBar(curY + 6, kpis);

            // Draw Table Header
            curY = drawGradebookTableHeader(curY);

            // Render Students Rows
            if (students.length === 0) {
                doc.rect(36, curY, 770, 28).fill('#f8fafc').stroke('#e2e8f0');
                doc.fontSize(8).font('Helvetica-Oblique').fillColor('#64748b')
                   .text('No active student records match the specified filters for this class section.', 36, curY + 10, { width: 770, align: 'center' });
                curY += 34;
            } else {
                const rowH = 20;
                for (let sIdx = 0; sIdx < students.length; sIdx++) {
                    const s = students[sIdx];

                    // Check page break (max printable Y is ~525)
                    if (curY + rowH > 520) {
                        doc.addPage();
                        curY = drawPdfDocumentHeader(doc, {
                            title: `MASTER CLASS GRADEBOOK: ${cls.class_name.toUpperCase()} (CONT.)`,
                            scope: scopeText,
                            user: req.user,
                            role: 'Teacher',
                            classification: 'CONFIDENTIAL — OFFICIAL GRADEBOOK',
                            auditRef,
                            isContinuation: true,
                            layout: 'landscape'
                        });
                        curY = drawGradebookTableHeader(curY + 8);
                    }

                    // Background & Border
                    doc.rect(36, curY, 770, rowH).fill(sIdx % 2 === 0 ? '#f8fafc' : '#ffffff');
                    doc.rect(36, curY, 770, rowH).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

                    let cellX = 36;
                    const textOffsetY = curY + 6;

                    // 1. #
                    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
                       .text(String(sIdx + 1), cellX, textOffsetY, { width: COLS[0].width, align: 'center' });
                    cellX += COLS[0].width;

                    // 2. LRN Number
                    doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b')
                       .text(s.lrn_number || '—', cellX + 3, textOffsetY, { width: COLS[1].width - 6, align: 'left' });
                    cellX += COLS[1].width;

                    // 3. Student Full Name
                    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0f172a')
                       .text(s.full_name || `${s.last_name}, ${s.first_name}`, cellX + 3, textOffsetY, { width: COLS[2].width - 6, align: 'left', lineBreak: false });
                    cellX += COLS[2].width;

                    // 4. Sex
                    doc.font('Helvetica').fontSize(7.5).fillColor('#475569')
                       .text(s.sex || '—', cellX, textOffsetY, { width: COLS[3].width, align: 'center' });
                    cellX += COLS[3].width;

                    // 5. Attendance Rate
                    const attRateStr = (s.attendance && s.attendance.rate !== null) ? `${s.attendance.rate}%` : '—';
                    doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                       .text(attRateStr, cellX, textOffsetY, { width: COLS[4].width, align: 'center' });
                    cellX += COLS[4].width;

                    // 6. Assessments (Written Works %)
                    const asmtStr = (s.asmt && s.asmt.pct !== null)
                        ? `${s.asmt.pct}%`
                        : (s.asmt && s.asmt.count > 0 ? `0%` : '—');
                    doc.font('Helvetica').fontSize(7.2).fillColor('#334155')
                       .text(asmtStr, cellX, textOffsetY, { width: COLS[5].width, align: 'center' });
                    cellX += COLS[5].width;

                    // 7. Assignments (Performance Tasks %)
                    const asgnStr = (s.asgn && s.asgn.pct !== null)
                        ? `${s.asgn.pct}%`
                        : (s.asgn && s.asgn.count > 0 ? `0%` : '—');
                    doc.font('Helvetica').fontSize(7.2).fillColor('#334155')
                       .text(asgnStr, cellX, textOffsetY, { width: COLS[6].width, align: 'center' });
                    cellX += COLS[6].width;

                    // 8. Forums
                    const forumStr = (s.forum && s.forum.pct !== null)
                        ? `${s.forum.pct}%`
                        : (s.forum && s.forum.total > 0 ? `0%` : '—');
                    doc.font('Helvetica').fontSize(7.2).fillColor('#334155')
                       .text(forumStr, cellX, textOffsetY, { width: COLS[7].width, align: 'center' });
                    cellX += COLS[7].width;

                    // 9. Simulation Mastery %
                    const simStr = s.arcade_avg !== null
                        ? `${s.arcade_avg}%`
                        : (!s.is_incomplete && activeWeights.sim > 0 ? '0%' : '—');
                    doc.font('Helvetica').fontSize(7.2).fillColor('#334155')
                       .text(simStr, cellX, textOffsetY, { width: COLS[8].width, align: 'center' });
                    cellX += COLS[8].width;

                    // 10. LMS Coursework Avg
                    const lmsAvgStr = s.lms_avg !== null ? `${s.lms_avg}%` : '—';
                    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e1b4b')
                       .text(lmsAvgStr, cellX, textOffsetY, { width: COLS[9].width, align: 'center' });
                    cellX += COLS[9].width;

                    // 11. Q1 Final Grade
                    const q1Str = s.q1_grade !== null ? `${s.q1_grade}%` : '—';
                    doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                       .text(q1Str, cellX, textOffsetY, { width: COLS[10].width, align: 'center' });
                    cellX += COLS[10].width;

                    // 12. Q2 Final Grade
                    const q2Str = s.q2_grade !== null ? `${s.q2_grade}%` : '—';
                    doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                       .text(q2Str, cellX, textOffsetY, { width: COLS[11].width, align: 'center' });
                    cellX += COLS[11].width;

                    // 13. Semestral Final Grade
                    const semGradeVal = s.semestral_grade !== null ? s.semestral_grade : s.final_grade;
                    const semStr = semGradeVal !== null ? `${semGradeVal}%` : '—';
                    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a')
                       .text(semStr, cellX, textOffsetY - 0.5, { width: COLS[12].width, align: 'center' });
                    cellX += COLS[12].width;

                    // 14. Academic Standing (Badge Pill)
                    const badgeW = 46;
                    const badgeH = 12.5;
                    const badgeX = cellX + 4;
                    const badgeY = curY + 3.75;

                    let badgeBg = '#f1f5f9';
                    let badgeColor = '#64748b';
                    if (s.standing === 'Passed') {
                        badgeBg = '#dcfce7';
                        badgeColor = '#15803d';
                    } else if (s.standing === 'At-Risk') {
                        badgeBg = '#fee2e2';
                        badgeColor = '#b91c1c';
                    } else if (s.standing === 'Incomplete') {
                        badgeBg = '#f1f5f9';
                        badgeColor = '#475569';
                    }

                    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 2.5).fill(badgeBg);
                    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(badgeColor)
                       .text(s.standing.toUpperCase(), badgeX, badgeY + 3, { width: badgeW, align: 'center' });
                    cellX += COLS[13].width;

                    // 15. Chem 2 Prerequisite Status (Badge Pill)
                    const cBadgeW = 90;
                    const cBadgeH = 12.5;
                    const cBadgeX = cellX + 4;
                    const cBadgeY = curY + 3.75;

                    let cBg = '#f1f5f9';
                    let cColor = '#64748b';
                    let cLabel = 'N/A';
                    if (s.chem2_eligibility) {
                        cLabel = s.chem2_eligibility.badge || s.chem2_eligibility.status || 'N/A';
                        if (s.chem2_eligibility.code === 'PASSED' || s.chem2_eligibility.status === 'ELIGIBLE') {
                            cBg = '#dcfce7';
                            cColor = '#15803d';
                        } else if (s.chem2_eligibility.code === 'FAILED' || s.chem2_eligibility.status === 'INELIGIBLE') {
                            cBg = '#fee2e2';
                            cColor = '#b91c1c';
                        } else if (s.chem2_eligibility.code === 'PENDING' || s.chem2_eligibility.status === 'PENDING') {
                            cBg = '#fef3c7';
                            cColor = '#b45309';
                        } else if (s.chem2_eligibility.code === 'ENROLLED' || s.chem2_eligibility.status === 'CURRENT_CHEM2') {
                            cBg = '#e0e7ff';
                            cColor = '#3730a3';
                        }
                    }

                    doc.roundedRect(cBadgeX, cBadgeY, cBadgeW, cBadgeH, 2.5).fill(cBg);
                    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(cColor)
                       .text(cLabel.toUpperCase(), cBadgeX, cBadgeY + 3, { width: cBadgeW, align: 'center' });

                    curY += rowH;
                }
            }

            // Summary Footer Box for this class
            if (curY + 62 > 525) {
                doc.addPage();
                curY = drawPdfDocumentHeader(doc, {
                    title: `MASTER CLASS GRADEBOOK: ${cls.class_name.toUpperCase()} (SUMMARY)`,
                    scope: scopeText,
                    user: req.user,
                    role: 'Teacher',
                    classification: 'CONFIDENTIAL — OFFICIAL GRADEBOOK',
                    auditRef,
                    isContinuation: true,
                    layout: 'landscape'
                }) + 10;
            } else {
                curY += 14;
            }

            // Class Performance Summary Bar
            doc.roundedRect(36, curY, 770, 26, 4).fillAndStroke('#f1f5f9', '#cbd5e1');
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e1b4b')
               .text(`CLASS PERFORMANCE SUMMARY: Total Enrolled: ${kpis.totalEnrolled} Students   |   Passed (>= 75%): ${kpis.passedCount} (${kpis.passingRate}%)   |   At-Risk (<75%): ${kpis.atRiskCount} (${kpis.atRiskRate}%)   |   Incomplete: ${kpis.incompleteCount}`,
                     44, curY + 8.5, { width: 500, align: 'left' });

            const summaryMeans = `LMS Mean: ${kpis.classLmsMean !== null ? kpis.classLmsMean + '%' : '—'}   |   Sim Mastery: ${kpis.classArcadeMean !== null ? kpis.classArcadeMean + '%' : '—'}   |   Composite: ${kpis.classFinalMean !== null ? kpis.classFinalMean + '%' : '—'}`;
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0284c7')
               .text(summaryMeans, 550, curY + 8.5, { width: 248, align: 'right' });

            curY += 36;

            // Authentication & Sign-off Block
            const authY = curY;
            doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#64748b')
               .text(`Grading Scale & Standard: Computed in accordance with DepEd Order No. 8, s. 2015 (75% Minimum Passing Mastery Threshold). Active Weighting: LMS Avg = ${lmsWeightFormulaStr}; Final Grade = ${finalWeightFormulaStr}; Semestral = ${activeWeights.q1 || 50}% Q1 + ${activeWeights.q2 || 50}% Q2. All assessments and coursework have been validated through Elementa LMS and verified by teacher roll call records.`, 36, authY, { width: 540, lineGap: 1.5 });

            doc.moveTo(600, authY + 18).lineTo(780, authY + 18).strokeColor('#94a3b8').lineWidth(0.75).stroke();
            const teacherName = req.user ? `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() : 'Instructor';
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0f172a')
               .text(teacherName, 600, authY + 21, { width: 180, align: 'center' });
            doc.fontSize(6.5).font('Helvetica').fillColor('#64748b')
               .text('Subject Instructor / Academic Department', 600, authY + 30.5, { width: 180, align: 'center' });
        }

        // Attach standardized footers to all buffered pages
        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — OFFICIAL GRADEBOOK');
        doc.end();

        try {
            const rawClsName = (gradebookData.classes[0] && gradebookData.classes[0].classInfo && gradebookData.classes[0].classInfo.class_name) || 'Class';
            const logScope = isMulti ? `All Classes (${gradebookData.classes.length})` : rawClsName;
            await logActivity(teacherId, 'Teacher', 'EXPORT_GRADEBOOK_PDF',
                `Exported Master Gradebook PDF for ${logScope} (${quarterDesc}, Standing: ${standingDesc}, Ref: ${auditRef})`);
        } catch (logErr) {
            console.warn('[ActivityLog Warning]', logErr.message);
        }

    } catch (err) {
        console.error('❌ [GET /reports/export/gradebook/pdf]', err);
        if (!res.headersSent) {
            res.status(500).send('Master Class Gradebook PDF generation failed.');
        } else {
            res.end();
        }
    }
});

// ============================================================
// GAME CONFIGURATION ROUTES
// Drop these routes into teacher.js BEFORE module.exports = router
//
// These routes use YOUR existing conventions:
//   - isTeacher middleware (Passport: req.isAuthenticated + req.user)
//   - req.user.user_id  (not req.session.user)
//   - db.execute()      (prepared statements, not db.query)
//   - multer already imported at top of teacher.js
//   - path, fs already imported at top of teacher.js
// ============================================================

// ── Multer: question main media (image/video, 50MB) ──────────
const questionMediaStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/question_media');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = `qmedia_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    }
});

const questionMediaFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only image (jpg, png, gif, webp) and video (mp4, webm) files are allowed.'));
};

const uploadQuestionMedia = multer({
    storage: questionMediaStorage,
    fileFilter: questionMediaFilter,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Multer: choice images A/B/C/D (image only, 5MB) ─────────
const choiceImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/choice_images');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = `choice_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    }
});

const choiceImageFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only image files (jpg, png, gif, webp) are allowed for choices.'));
};

const uploadChoiceImage = multer({
    storage: choiceImageStorage,
    fileFilter: choiceImageFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});


// ============================================================
// GET /teacher/assessment/create?topic_id=&quarter_id=
// New assessment — blank configuration page
// MUST be registered BEFORE /:assessment_id/configure
// ============================================================
router.get('/assessment/create', isTeacher, async (req, res) => {
    try {
        const { topic_id, quarter_id } = req.query;

        if (!topic_id || !quarter_id) {
            return res.status(400).send('topic_id and quarter_id are required.');
        }

        const [[topic]] = await db.execute(
            'SELECT topic_id, topic_name, topic_description, topic_objectives FROM topics WHERE topic_id = ?',
            [topic_id]
        );
        if (!topic) {
            return res.status(404).render('404', {
                title: 'Topic Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Teacher',
                requestedPath: req.originalUrl,
                customMessage: 'The selected chemistry topic could not be found in the curriculum registry.'
            });
        }

        const [[quarter]] = await db.execute(
            'SELECT quarter_id, quarter_number FROM quarters WHERE quarter_id = ?',
            [quarter_id]
        );
        if (!quarter) {
            return res.status(404).render('404', {
                title: 'Quarter Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Teacher',
                requestedPath: req.originalUrl,
                customMessage: 'The selected grading quarter record could not be found.'
            });
        }

        const pageData = {
            assessment: {
                assessment_id: null,
                topic_id: parseInt(topic_id),
                quarter_id: parseInt(quarter_id),
                assessment_name: '',
                assessment_type: 'Quiz',
                total_items: 1,
                duration_minutes: 30,
                timer_type: 'Global',
                is_unlocked: 0,
                due_date: null,
                teacher_id: req.user.user_id   // ← Passport: req.user
            },
            topic,
            quarter,
            questions: []
        };

        const notifications = await getTeacherNotifications(db, req.user.user_id);
        res.render('teacher/game_configuration', { pageData, user: req.user, notifications });

    } catch (err) {
        console.error('[GET /assessment/create]', err);
        res.status(500).send('Server error loading configuration page.');
    }
});


// ============================================================
// GET /teacher/assessment/:assessment_id/configure
// Edit existing assessment — loads all questions + sequences via SSOT (elementa_questions)
// ============================================================
router.get('/assessment/:assessment_id/configure', isTeacher, async (req, res) => {
    try {
        const { assessment_id } = req.params;
        const teacher_id = req.user.user_id;   // ← Passport: req.user

        // Fetch assessment — must belong to this teacher (or user is Admin)
        const isAdmin = req.user && req.user.role === 'Admin';
        const [[assessment]] = await db.execute(
            isAdmin
                ? `SELECT * FROM assessments WHERE assessment_id = ?`
                : `SELECT * FROM assessments WHERE assessment_id = ? AND teacher_id = ?`,
            isAdmin ? [assessment_id] : [assessment_id, teacher_id]
        );
        if (!assessment) {
            return res.status(404).render('404', {
                title: 'Assessment Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Teacher',
                requestedPath: req.originalUrl,
                customMessage: 'The requested assessment could not be found or you do not have permission to configure it.'
            });
        }

        const [[topic]] = await db.execute(
            'SELECT topic_id, topic_name, topic_description, topic_objectives FROM topics WHERE topic_id = ?',
            [assessment.topic_id]
        );

        const [[quarter]] = await db.execute(
            'SELECT quarter_id, quarter_number FROM quarters WHERE quarter_id = ?',
            [assessment.quarter_id]
        );

        // All questions linked to this assessment via elementa_assessment_questions & elementa_questions
        const [aqRows] = await db.execute(
            `SELECT eaq.eaq_id AS aq_id, eaq.question_id, eaq.sort_order,
                    eq.question_code, eq.machine_name, eq.machine_id,
                    eq.prompt AS question_text, eq.prompt,
                    eq.answer_text AS correct_answer, eq.answer_text,
                    eq.steps_json,
                    eq.time_limit_s AS time_limit, eq.difficulty,
                    COALESCE(eaq.custom_points, eq.points, 1) AS points,
                    eq.is_active, eq.teacher_id,
                    'Standard' AS input_mode
             FROM elementa_assessment_questions eaq
             JOIN elementa_questions eq ON eaq.question_id = eq.question_id
             WHERE eaq.assessment_id = ?
             ORDER BY eaq.sort_order ASC`,
            [assessment_id]
        );

        const questions = aqRows.map((row) => {
            let steps = [];
            try {
                steps = typeof row.steps_json === 'string' ? JSON.parse(row.steps_json) : (row.steps_json || []);
            } catch (_) { }
            return {
                ...row,
                steps_json: steps,
                answer_sequences: Array.isArray(steps) ? steps : []
            };
        });

        const pageData = { assessment, topic, quarter, questions };
        const notifications = await getTeacherNotifications(db, req.user.user_id);
        res.render('teacher/game_configuration', { pageData, user: req.user, notifications });

    } catch (err) {
        console.error('[GET /assessment/:id/configure]', err);
        res.status(500).send('Server error loading assessment.');
    }
});


// ============================================================
// POST /teacher/assessment/upload-media
// Called immediately when teacher selects a question media file
// Returns { success, media_path, media_type }
// ============================================================
router.post('/assessment/upload-media', isTeacher, (req, res) => {
    uploadQuestionMedia.single('media')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, error: 'File exceeds the 50MB limit.' });
            }
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file received.' });
        }

        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const ext = path.extname(req.file.filename).toLowerCase();
        const mediaType = imageExts.includes(ext) ? 'image' : 'video';
        const mediaPath = `/uploads/question_media/${req.file.filename}`;

        res.json({ success: true, media_path: mediaPath, media_type: mediaType });
    });
});


// ============================================================
// POST /teacher/assessment/upload-choice-image
// Called when teacher uploads an image for choice A/B/C/D
// Returns { success, image_path }
// ============================================================
router.post('/assessment/upload-choice-image', isTeacher, (req, res) => {
    uploadChoiceImage.single('choice_image')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, error: 'File exceeds the 5MB limit.' });
            }
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file received.' });
        }
        const imagePath = `/uploads/choice_images/${req.file.filename}`;
        res.json({ success: true, image_path: imagePath });
    });
});


// ============================================================
// POST /teacher/assessment/save
// Full atomic save: assessment + elementa_questions + elementa_assessment_questions
// Payload: { assessment, questions[], deletedQuestionIds[] }
// ============================================================
router.post('/assessment/save', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const teacher_id = req.user.user_id;   // ← Passport: req.user
        const { assessment, questions, deletedQuestionIds } = req.body;

        // ── STEP 1: Ownership check for edits (Admin bypasses) ─────────────────
        const isUserAdmin = req.user && req.user.role === 'Admin';
        if (assessment.assessment_id && !isUserAdmin) {
            const [[existing]] = await conn.execute(
                'SELECT teacher_id FROM assessments WHERE assessment_id = ?',
                [assessment.assessment_id]
            );
            if (!existing) {
                await conn.rollback();
                return res.status(404).json({ success: false, error: 'Assessment not found.' });
            }
            if (parseInt(existing.teacher_id) !== parseInt(teacher_id)) {
                await conn.rollback();
                return res.status(403).json({ success: false, error: 'Access denied.' });
            }
        }

        // ── STEP 2: Upsert assessment ──────────────────────────
        const isNewAssessment = !assessment.assessment_id;
        let assessment_id = assessment.assessment_id || null;

        const assessmentFields = {
            quarter_id: assessment.quarter_id,
            topic_id: assessment.topic_id,
            assessment_name: assessment.assessment_name,
            assessment_type: assessment.assessment_type,
            total_items: parseInt(assessment.total_items) || (questions ? questions.length : 1),
            duration_minutes: parseInt(assessment.duration_minutes) || 30,
            timer_type: assessment.timer_type,
            is_unlocked: assessment.is_unlocked ? 1 : 0,
            due_date: assessment.due_date || null,
            teacher_id
        };

        if (!assessment_id) {
            const [insertResult] = await conn.execute(
                `INSERT INTO assessments
                 (quarter_id, topic_id, assessment_name, assessment_type, total_items,
                  duration_minutes, timer_type, is_unlocked, due_date, teacher_id,
                  sound_bg, sound_correct, sound_wrong, sound_result_pass, sound_result_fail,
                  speech_enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    assessmentFields.quarter_id,
                    assessmentFields.topic_id,
                    assessmentFields.assessment_name,
                    assessmentFields.assessment_type,
                    assessmentFields.total_items,
                    assessmentFields.duration_minutes,
                    assessmentFields.timer_type,
                    assessmentFields.is_unlocked,
                    assessmentFields.due_date,
                    assessmentFields.teacher_id,
                    assessment.sound_bg || '',
                    assessment.sound_correct || '',
                    assessment.sound_wrong || '',
                    assessment.sound_result_pass || '',
                    assessment.sound_result_fail || '',
                    assessment.speech_enabled ? 1 : 0
                ]
            );
            assessment_id = insertResult.insertId;
        } else {
            await conn.execute(
                `UPDATE assessments
                 SET quarter_id = ?, topic_id = ?, assessment_name = ?,
                     assessment_type = ?, total_items = ?, duration_minutes = ?,
                     timer_type = ?, is_unlocked = ?, due_date = ?,
                     sound_bg = ?, sound_correct = ?, sound_wrong = ?,
                     sound_result_pass = ?, sound_result_fail = ?,
                     speech_enabled = ?
                 WHERE assessment_id = ?`,
                [
                    assessmentFields.quarter_id,
                    assessmentFields.topic_id,
                    assessmentFields.assessment_name,
                    assessmentFields.assessment_type,
                    assessmentFields.total_items,
                    assessmentFields.duration_minutes,
                    assessmentFields.timer_type,
                    assessmentFields.is_unlocked,
                    assessmentFields.due_date,
                    assessment.sound_bg || '',
                    assessment.sound_correct || '',
                    assessment.sound_wrong || '',
                    assessment.sound_result_pass || '',
                    assessment.sound_result_fail || '',
                    assessment.speech_enabled ? 1 : 0,
                    assessment_id
                ]
            );
        }

        // ── STEP 3: Delete removed questions from junction ──────────────────
        if (Array.isArray(deletedQuestionIds) && deletedQuestionIds.length > 0) {
            for (const qid of deletedQuestionIds) {
                await conn.execute(
                    'DELETE FROM elementa_assessment_questions WHERE assessment_id = ? AND question_id = ?',
                    [assessment_id, qid]
                );
            }
        }

        // ── STEP 4: Upsert each question into elementa_questions & elementa_assessment_questions ──
        const savedQuestions = [];

        for (const q of (questions || [])) {
            let question_id = q.question_id ? parseInt(q.question_id) : null;
            const stepsData = q.steps_json || q.answer_sequences || [];
            const stepsStr = typeof stepsData === 'string' ? stepsData : JSON.stringify(stepsData);
            const promptText = q.question_text || q.prompt || '';
            const answerText = q.correct_answer || q.answer_text || '';
            const timeLimit = parseInt(q.time_limit) || parseInt(q.time_limit_s) || 30;
            const pointsVal = parseInt(q.points) || 1;
            const diffVal = q.difficulty || 'Easy';
            const machineName = q.machine_name || 'PrecisionMeasurement';
            const machineId = parseInt(q.machine_id) || 1;
            const sortOrder = parseInt(q.sort_order) || 1;

            if (!question_id) {
                // INSERT new question into elementa_questions
                const qCode = 'Q_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
                const levelNum = (assessmentFields.topic_id && TOPIC_LEVEL_MAP[assessmentFields.topic_id]) || 1;
                const topicLabel = (LEVEL_MACHINES[levelNum] && LEVEL_MACHINES[levelNum].topic) || 'Chemistry';
                const [qInsert] = await conn.execute(
                    `INSERT INTO elementa_questions
                     (topic_id, level_number, topic, teacher_id, question_code, prompt, answer_text, steps_json,
                      time_limit_s, points, difficulty, machine_name, machine_id, display_order, verification_status, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Approved', 1)`,
                    [
                        assessmentFields.topic_id || null,
                        levelNum,
                        topicLabel,
                        teacher_id,
                        qCode,
                        promptText,
                        answerText,
                        stepsStr,
                        timeLimit,
                        pointsVal,
                        diffVal,
                        machineName,
                        machineId,
                        sortOrder
                    ]
                );
                question_id = qInsert.insertId;
            } else {
                // UPDATE existing question in elementa_questions
                await conn.execute(
                    `UPDATE elementa_questions
                     SET prompt = ?, answer_text = ?, steps_json = ?,
                         time_limit_s = ?, points = ?, difficulty = ?
                     WHERE question_id = ? AND (teacher_id = ? OR ? = 1)`,
                    [
                        promptText,
                        answerText,
                        stepsStr,
                        timeLimit,
                        pointsVal,
                        diffVal,
                        question_id,
                        teacher_id,
                        isUserAdmin ? 1 : 0
                    ]
                );
            }

            // Upsert junction elementa_assessment_questions
            const [existingEaq] = await conn.execute(
                'SELECT eaq_id FROM elementa_assessment_questions WHERE assessment_id = ? AND question_id = ?',
                [assessment_id, question_id]
            );

            let aq_id = null;
            if (existingEaq.length === 0) {
                const [eaqInsert] = await conn.execute(
                    `INSERT INTO elementa_assessment_questions
                     (assessment_id, question_id, sort_order, custom_points)
                     VALUES (?, ?, ?, ?)`,
                    [assessment_id, question_id, sortOrder, pointsVal]
                );
                aq_id = eaqInsert.insertId;
            } else {
                aq_id = existingEaq[0].eaq_id;
                await conn.execute(
                    `UPDATE elementa_assessment_questions
                     SET sort_order = ?, custom_points = ?
                     WHERE eaq_id = ?`,
                    [sortOrder, pointsVal, aq_id]
                );
            }

            savedQuestions.push({
                original_index: parseInt(q._index),
                aq_id,
                question_id
            });
        }

        // Ensure assessment selection mode is manual for configured assessments
        await conn.execute(
            `UPDATE assessments SET question_selection_mode = 'manual' WHERE assessment_id = ?`,
            [assessment_id]
        );

        await conn.commit();

        // Dispatch in-app notification if new assessment or published
        if (isNewAssessment && assessmentFields.is_unlocked) {
            try {
                const [students] = await db.query(`
                    SELECT DISTINCT cs.student_id, c.subject_id
                    FROM topics t
                    JOIN quarters q ON t.quarter_id = q.quarter_id
                    JOIN classes c ON q.subject_id = c.subject_id
                    JOIN class_students cs ON c.class_id = cs.class_id
                    WHERE t.topic_id = ?
                `, [assessmentFields.topic_id]);

                if (students.length > 0) {
                    const studentIds = [...new Set(students.map(s => s.student_id))];
                    const subjectId = students[0].subject_id;
                    const dueStr = assessmentFields.due_date ? ` (Due: ${new Date(assessmentFields.due_date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '';

                    await notificationService.dispatch({
                        recipientIds: studentIds,
                        actorId: req.user.user_id,
                        role: 'Student',
                        category: 'assessment',
                        priority: 'high',
                        eventType: 'assessment_published',
                        title: `New Assessment: ${assessmentFields.assessment_name}`,
                        message: `A new ${assessmentFields.assessment_type || 'Arcade'} assessment is now live${dueStr}.`,
                        targetUrl: `/subjects/open/${subjectId}?tab=assessments&assessment_id=${assessment_id}#asgn-card-${assessment_id}`,
                        metadata: { assessmentId: assessment_id, subjectId }
                    });
                }
            } catch (notifErr) {
                console.error('[Notification Dispatch Error on Assessment Save]', notifErr.message);
            }
        }

        res.json({ success: true, assessment_id, savedQuestions });

    } catch (err) {
        await conn.rollback();
        console.error('[POST /assessment/save]', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
    }
});


// ============================================================
// DELETE /teacher/api/assessment/:aid/full
// Full deletion of an assessment cascading only to active tables
// ============================================================
router.delete('/api/assessment/:aid/full', isTeacher, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();
        const aid = req.params.aid;
        const teacher_id = req.user.user_id;
        const isUserAdmin = req.user && req.user.role === 'Admin';

        // Ownership check
        const [[existing]] = await conn.execute(
            'SELECT teacher_id FROM assessments WHERE assessment_id = ?', [aid]
        );
        if (!existing) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Assessment not found.' });
        }
        if (!isUserAdmin && parseInt(existing.teacher_id) !== parseInt(teacher_id)) {
            await conn.rollback();
            return res.status(403).json({ success: false, error: 'Access denied.' });
        }

        // Unlink arcade game sessions
        await conn.execute('UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id = ?', [aid]).catch(() => { });
        // Cascade only to active tables
        await conn.execute('DELETE FROM elementa_assessment_questions WHERE assessment_id = ?', [aid]).catch(() => { });
        await conn.execute('DELETE FROM elementa_assessment_tickets WHERE assessment_id = ?', [aid]).catch(() => { });
        await conn.execute('DELETE FROM student_scores WHERE assessment_id = ?', [aid]).catch(() => { });

        // Delete the assessment itself
        await conn.execute('DELETE FROM assessments WHERE assessment_id = ?', [aid]);

        await conn.commit();
        res.json({ success: true });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error('[DELETE /api/assessment/:aid/full]', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});



// ============================================================
// POST /teacher/api/subject/:subjectId/image
// Upload / replace the cover image for a subject.
// Teacher must own at least one class for that subject.
// Returns { success, filename } so the EJS thumbnail updates
// immediately without a page reload.
// ============================================================
router.post('/api/subject/:subjectId/image', isTeacher, (req, res) => {
    subjectImgUpload.single('image')(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ success: false, error: uploadErr.message });
        if (!req.file) return res.status(400).json({ success: false, error: 'No image file received.' });

        try {
            const subjectId = req.params.subjectId;

            // Ownership check — teacher must teach this subject
            const [[ownership]] = await db.execute(
                `SELECT c.class_id FROM classes c WHERE c.subject_id = ? AND c.teacher_id = ? LIMIT 1`,
                [subjectId, req.user.user_id]
            );
            if (!ownership) {
                fs.unlink(req.file.path, () => { });
                return res.status(403).json({ success: false, error: 'You do not teach this subject.' });
            }

            // Fetch old image filename to delete it after update
            const [[subjectRow]] = await db.execute(
                `SELECT subject_image FROM subjects WHERE subject_id = ?`, [subjectId]
            );

            // Persist new filename
            await db.execute(
                `UPDATE subjects SET subject_image = ? WHERE subject_id = ?`,
                [req.file.filename, subjectId]
            );

            // Delete old file (skip default placeholder)
            if (subjectRow && subjectRow.subject_image &&
                subjectRow.subject_image !== 'default_subject.png') {
                const oldPath = path.join(__dirname, '..', 'public', 'profile_uploads', subjectRow.subject_image);
                fs.unlink(oldPath, () => { });
            }

            res.json({ success: true, filename: req.file.filename });
        } catch (e) {
            fs.unlink(req.file.path, () => { });
            console.error('[SUBJECT IMAGE]', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
});

// ============================================================
// TEACHER PROFILE — View & Update
// ============================================================
router.get('/profile', isTeacher, async (req, res) => {
    try {
        const [[user]] = await db.execute(
            `SELECT user_id, first_name, middle_name, last_name, suffix,
                    email, faculty_id, department,
                    sex, birthdate, mobile_number,
                    city_town, home_address,
                    profile_pic, self_description,
                    current_level, total_exp, created_at
             FROM users WHERE user_id = ?`, [req.user.user_id]
        );

        const notifications = await getTeacherNotifications(db, req.user.user_id);

        res.render('teacher/profile', {
            user,
            notifications: notifications || [],
            updated: req.query.updated === '1'
        });
    } catch (err) {
        console.error('[ERROR] GET /teacher/profile', err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/profile/update', isTeacher, profileUpload.single('profile_pic'), async (req, res) => {
    const {
        first_name, middle_name, last_name, suffix,
        mobile_number, city_town, home_address, self_description
    } = req.body;

    // Only allow fields that teachers actually have
    try {
        // Handle profile photo upload if a new file was submitted
        if (req.file) {
            // Delete the old photo if it's not the default
            const [[current]] = await db.execute(
                `SELECT profile_pic FROM users WHERE user_id = ?`, [req.user.user_id]
            );
            if (current && current.profile_pic && current.profile_pic !== 'default_avatar.png') {
                const oldPath = path.join(__dirname, '..', 'public', 'profile_uploads', current.profile_pic);
                fs.unlink(oldPath, () => { });
            }
            await db.execute(
                `UPDATE users SET profile_pic = ? WHERE user_id = ? AND role = 'Teacher'`,
                [req.file.filename, req.user.user_id]
            );
        }

        await db.execute(`
            UPDATE users SET
                first_name      = ?,
                middle_name     = ?,
                last_name       = ?,
                suffix          = ?,
                mobile_number   = ?,
                city_town       = ?,
                home_address    = ?,
                self_description = ?
            WHERE user_id = ? AND role = 'Teacher'`,
            [
                first_name,
                middle_name || null,
                last_name,
                suffix || null,
                mobile_number || null,
                city_town || null,
                home_address || null,
                self_description || null,
                req.user.user_id
            ]
        );
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({
                success: true,
                profile_pic: req.file ? req.file.filename : null
            });
        }
        res.redirect('/teacher/profile?updated=1');
    } catch (err) {
        console.error('[ERROR] POST /teacher/profile/update', err);
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(500).json({ success: false, error: 'Update failed.' });
        }
        res.status(500).send('Update failed.');
    }
});

// For teacher profile page — classes tab
router.get('/api/class-roster-list', isTeacher, async (req, res) => {
    try {
        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name,
                   s.subject_name, s.subject_code,
                   sy.sy_range,
                   COUNT(cs.student_id) AS student_count
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            LEFT JOIN class_students cs ON c.class_id = cs.class_id
            WHERE c.teacher_id = ?
            GROUP BY c.class_id
            ORDER BY c.class_id DESC`, [req.user.user_id]
        );
        res.json({ classes });
    } catch (err) {
        console.error('[ERROR] GET /teacher/api/class-roster-list', err);
        res.status(500).json({ classes: [] });
    }
});

// ============================================================================
// ENTERPRISE GRADING & SUBMISSION SUITE ENDPOINTS
// ============================================================================

const { batchMessageLimiter } = require('../utils/rateLimiter');

// Setup Audio Note Multer Storage
const audioNoteStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../material_uploads/audio_notes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, 'voice-' + Date.now() + path.extname(file.originalname || '.webm'));
    }
});
const uploadAudioNote = multer({
    storage: audioNoteStorage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// 1. GET /teacher/grading-workspace/:aid or /teacher/grading/workspace/:aid — Fast Grading SPA UI
router.get(['/grading-workspace/:aid', '/grading/workspace/:aid'], isTeacher, async (req, res) => {
    try {
        const [assessments] = await db.query(
            `SELECT * FROM assessments WHERE assessment_id = ?`,
            [req.params.aid]
        );
        if (!assessments.length) {
            return res.status(404).render('404', {
                title: 'Assessment Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Teacher',
                requestedPath: req.originalUrl,
                customMessage: 'The requested assessment for this grading workspace could not be found.'
            });
        }

        const activeSY = await academicHelper.getActiveSchoolYear(db);
        const qInfo = await academicHelper.resolveAssessmentQuarter(db, { assessmentId: req.params.aid });
        const gradingStatus = academicHelper.isQuarterGradingOpen(activeSY, qInfo.quarterNumber);

        res.render('teacher/grading_workspace', {
            user: req.user,
            assessment: assessments[0],
            activeSY,
            quarterNumber: qInfo.quarterNumber,
            gradingStatus
        });
    } catch (err) {
        console.error('[GET /teacher/grading-workspace/:aid]', err);
        res.status(500).send('Error loading grading workspace');
    }
});

// 2. GET /teacher/api/grading/:aid/submissions — Headless submissions list for SPA (Only actually submitted students)
router.get('/api/grading/:aid/submissions', isTeacher, async (req, res) => {
    try {
        const aid = req.params.aid;

        // Fetch assessment and subject info
        const [[asmt]] = await db.query(`
            SELECT a.*, q.subject_id 
            FROM assessments a 
            JOIN topics t ON a.topic_id = t.topic_id 
            JOIN quarters q ON t.quarter_id = q.quarter_id 
            WHERE a.assessment_id = ?
        `, [aid]);

        if (!asmt) {
            return res.status(404).json({ success: false, error: 'Assessment not found' });
        }

        const activeSY = await academicHelper.getActiveSchoolYear(db);
        const qInfo = await academicHelper.resolveAssessmentQuarter(db, { assessmentId: aid });
        const gradingStatus = academicHelper.isQuarterGradingOpen(activeSY, qInfo.quarterNumber);

        if (!asmt) {
            return res.status(404).json({ success: false, error: 'Assessment not found' });
        }

        // Query ONLY records that represent actual student submissions
        const [rawSubmissions] = await db.query(`
            SELECT ss.*, u.first_name, u.last_name, u.email, u.profile_pic,
                   COALESCE(ss.file_path, (SELECT CONCAT('/material_uploads/', original_filename) FROM submission_receipts sr WHERE sr.score_id = ss.score_id LIMIT 1)) AS file_path,
                   COALESCE(ss.original_filename, (SELECT original_filename FROM submission_receipts sr WHERE sr.score_id = ss.score_id LIMIT 1)) AS original_filename,
                   sr.sha256_hash, sr.file_size_bytes, sr.server_timestamp AS receipt_timestamp,
                   sg.group_name,
                   sub_u.first_name AS submitted_by_first, sub_u.last_name AS submitted_by_last
            FROM student_scores ss
            JOIN users u ON ss.student_id = u.user_id
            LEFT JOIN submission_receipts sr ON ss.score_id = sr.score_id
            LEFT JOIN student_groups sg ON ss.group_id = sg.group_id
            LEFT JOIN users sub_u ON ss.submitted_by_user_id = sub_u.user_id
            WHERE ss.assessment_id = ?
              AND (ss.file_path IS NOT NULL OR sr.sha256_hash IS NOT NULL OR ss.submitted_at IS NOT NULL)
            ORDER BY ss.date_recorded DESC, ss.score_id DESC
        `, [aid]);

        // Fetch rubric criteria if any
        const [rubrics] = await db.query(`SELECT rubric_id FROM rubrics WHERE assessment_id = ?`, [aid]);
        let criteria = [];
        if (rubrics.length) {
            const [rows] = await db.query(
                `SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC`,
                [rubrics[0].rubric_id]
            );
            criteria = rows;
        }

        const isGroup = !!(asmt.is_group_assignment == 1 || asmt.is_group_assignment === true);
        const isOnePerGroup = isGroup && (asmt.group_submission_mode === 'one_per_group' || asmt.group_grading_mode === 'shared_grade' || asmt.group_grading_mode === 'group');

        const compiledList = [];

        if (isGroup && isOnePerGroup) {
            // For group assignments where only one member submits on behalf of the group:
            // Only that specific student who made the submission should appear in the panel, along with their group number.
            const groupsMap = new Map();
            for (const sub of rawSubmissions) {
                const gid = sub.group_id || ('student_' + sub.student_id);
                if (!groupsMap.has(gid)) {
                    groupsMap.set(gid, []);
                }
                groupsMap.get(gid).push(sub);
            }

            for (const [gid, subs] of groupsMap.entries()) {
                // Find the specific student who actually made the submission
                let submitterSub = subs.find(s => s.submitted_by_user_id && s.student_id === s.submitted_by_user_id && s.file_path);
                if (!submitterSub) {
                    submitterSub = subs.find(s => s.file_path) || subs[0];
                }

                // If submitted_by_user_id points to another member in the group, pick their info
                let submitterStudentId = submitterSub.student_id;
                let submitterFirstName = submitterSub.first_name;
                let submitterLastName = submitterSub.last_name;
                let submitterEmail = submitterSub.email;
                let submitterProfilePic = submitterSub.profile_pic;

                if (submitterSub.submitted_by_user_id && submitterSub.submitted_by_user_id !== submitterSub.student_id) {
                    const foundSubmitter = subs.find(s => s.student_id === submitterSub.submitted_by_user_id);
                    if (foundSubmitter) {
                        submitterSub = foundSubmitter;
                        submitterStudentId = foundSubmitter.student_id;
                        submitterFirstName = foundSubmitter.first_name;
                        submitterLastName = foundSubmitter.last_name;
                        submitterEmail = foundSubmitter.email;
                        submitterProfilePic = foundSubmitter.profile_pic;
                    }
                }

                // Fetch group members for shared credit
                let groupMembers = [];
                if (submitterSub.group_id) {
                    const [mems] = await db.query(`
                        SELECT gm.group_id, gm.student_id, u.first_name, u.last_name, u.email, u.profile_pic
                        FROM group_members gm
                        JOIN users u ON gm.student_id = u.user_id
                        WHERE gm.group_id = ?
                        ORDER BY u.last_name ASC, u.first_name ASC
                    `, [submitterSub.group_id]);
                    groupMembers = mems;
                }

                // Fetch rubric criteria scores
                const scoreIds = subs.map(s => s.score_id).filter(Boolean);
                let rubricCriteria = criteria.map(c => ({ ...c, points_awarded: 0, criterion_feedback: '' }));
                if (scoreIds.length > 0) {
                    const [awarded] = await db.query(
                        `SELECT criterion_id, points_awarded, criterion_feedback FROM submission_rubric_scores WHERE score_id IN (?)`,
                        [scoreIds]
                    );
                    const awardedMap = new Map(awarded.map(a => [a.criterion_id, a]));
                    rubricCriteria = criteria.map(c => {
                        const aw = awardedMap.get(c.criterion_id);
                        return {
                            ...c,
                            points_awarded: aw ? aw.points_awarded : 0,
                            criterion_feedback: aw ? (aw.criterion_feedback || '') : ''
                        };
                    });
                }

                const scoreVal = (submitterSub.score_obtained !== null && submitterSub.score_obtained !== undefined)
                    ? submitterSub.score_obtained
                    : (subs.find(s => s.score_obtained !== null && s.score_obtained !== undefined)?.score_obtained ?? null);

                const feedbackVal = submitterSub.feedback || (subs.find(s => s.feedback)?.feedback ?? '');

                compiledList.push({
                    is_group_submission: true,
                    submission_type: 'group',
                    group_id: submitterSub.group_id,
                    group_name: submitterSub.group_name || 'Group',
                    student_id: submitterStudentId,
                    first_name: submitterFirstName,
                    last_name: submitterLastName,
                    email: submitterEmail,
                    profile_pic: submitterProfilePic,
                    score_id: submitterSub.score_id,
                    assessment_id: Number(aid),
                    score_obtained: scoreVal,
                    feedback: feedbackVal,
                    file_path: submitterSub.file_path,
                    original_filename: submitterSub.original_filename,
                    sha256_hash: submitterSub.sha256_hash,
                    receipt_timestamp: submitterSub.receipt_timestamp,
                    file_size_bytes: submitterSub.file_size_bytes,
                    attempt_number: submitterSub.attempt_number || 1,
                    is_submitted: true,
                    group_members: groupMembers,
                    all_attempts: [submitterSub],
                    rubric_criteria: rubricCriteria
                });
            }
        } else {
            // Individual submissions (or group assignments where each member submits individually)
            const studentMap = new Map();
            for (const sub of rawSubmissions) {
                if (!studentMap.has(sub.student_id)) {
                    studentMap.set(sub.student_id, []);
                }
                studentMap.get(sub.student_id).push(sub);
            }

            for (const [studentId, attempts] of studentMap.entries()) {
                const latest = attempts[0];
                let groupMembers = [];
                if (latest.group_id) {
                    const [mems] = await db.query(`
                        SELECT gm.group_id, gm.student_id, u.first_name, u.last_name, u.email, u.profile_pic
                        FROM group_members gm
                        JOIN users u ON gm.student_id = u.user_id
                        WHERE gm.group_id = ?
                        ORDER BY u.last_name ASC, u.first_name ASC
                    `, [latest.group_id]);
                    groupMembers = mems;
                }

                // Fetch rubric criteria scores
                const [awarded] = await db.query(
                    `SELECT criterion_id, points_awarded, criterion_feedback FROM submission_rubric_scores WHERE score_id = ?`,
                    [latest.score_id]
                );
                const awardedMap = new Map(awarded.map(a => [a.criterion_id, a]));
                const rubricCriteria = criteria.map(c => {
                    const aw = awardedMap.get(c.criterion_id);
                    return {
                        ...c,
                        points_awarded: aw ? aw.points_awarded : 0,
                        criterion_feedback: aw ? (aw.criterion_feedback || '') : ''
                    };
                });

                compiledList.push({
                    is_group_submission: isGroup,
                    submission_type: isGroup ? 'group' : 'individual',
                    group_id: latest.group_id || null,
                    group_name: latest.group_name || null,
                    student_id: latest.student_id,
                    first_name: latest.first_name,
                    last_name: latest.last_name,
                    email: latest.email,
                    profile_pic: latest.profile_pic,
                    score_id: latest.score_id,
                    assessment_id: Number(aid),
                    score_obtained: latest.score_obtained,
                    feedback: latest.feedback || '',
                    file_path: latest.file_path,
                    original_filename: latest.original_filename,
                    sha256_hash: latest.sha256_hash,
                    receipt_timestamp: latest.receipt_timestamp,
                    file_size_bytes: latest.file_size_bytes,
                    attempt_number: latest.attempt_number || 1,
                    is_submitted: true,
                    group_members: groupMembers,
                    all_attempts: attempts,
                    rubric_criteria: rubricCriteria
                });
            }
        }

        // Students who did not submit are NOT included, as requested
        res.json({
            success: true,
            submissions: compiledList,
            assessment: asmt,
            gradingStatus,
            quarterNumber: qInfo.quarterNumber
        });
    } catch (err) {
        console.error('[GET /teacher/api/grading/:aid/submissions]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. POST /teacher/api/grading/:scoreId/audio-note — 60-Second Voice Memo Upload
router.post('/api/grading/:scoreId/audio-note', isTeacher, uploadAudioNote.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded' });

        let scoreId = req.params.scoreId;
        const filename = req.file.filename;
        const duration = parseInt(req.body.duration) || 0;
        const { student_id, assessment_id } = req.body;

        // Check quarter grading deadline
        const activeSY = await academicHelper.getActiveSchoolYear(db);
        const qInfo = await academicHelper.resolveAssessmentQuarter(db, { assessmentId, scoreId });
        const gradingCheck = academicHelper.isQuarterGradingOpen(activeSY, qInfo.quarterNumber);
        if (!gradingCheck.isAllowed) {
            return res.status(403).json({
                success: false,
                error: `Grading Locked: ${gradingCheck.message}`,
                gradingStatus: gradingCheck
            });
        }

        if (scoreId === 'new' || scoreId === '0' || !scoreId) {
            if (student_id && assessment_id) {
                const [existing] = await db.query(
                    `SELECT score_id FROM student_scores WHERE student_id = ? AND assessment_id = ? ORDER BY score_id DESC LIMIT 1`,
                    [student_id, assessment_id]
                );
                if (existing.length > 0) {
                    scoreId = existing[0].score_id;
                } else {
                    const [[asmtRow]] = await db.query(`SELECT max_score FROM assessments WHERE assessment_id = ?`, [assessment_id]);
                    const maxScore = asmtRow ? (asmtRow.max_score || 100) : 100;
                    const [ins] = await db.query(
                        `INSERT INTO student_scores (student_id, assessment_id, score_obtained, feedback, date_recorded, total_items, total_possible_score)
                         VALUES (?, ?, 0, '', NOW(), ?, ?)`,
                        [student_id, assessment_id, maxScore, maxScore]
                    );
                    scoreId = ins.insertId;
                }
            } else {
                return res.status(400).json({ success: false, error: 'Missing student_id or assessment_id for new score record' });
            }
        }

        await db.query(`
            UPDATE student_scores 
            SET voice_note_path = ?, voice_note_duration_sec = ?
            WHERE score_id = ?
        `, [filename, duration, scoreId]);

        // Dispatch Audio Note notification to Student
        try {
            const [ssRows] = await db.query(`
                SELECT ss.student_id, ss.assessment_id, ss.group_id, a.assessment_name, a.is_group_assignment, a.group_grading_mode, a.group_submission_mode, q.subject_id
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE ss.score_id = ?
            `, [scoreId]);

            if (ssRows.length > 0) {
                const { student_id: sid, assessment_id: aid, group_id: gid, assessment_name, is_group_assignment, group_grading_mode, group_submission_mode, subject_id } = ssRows[0];
                await notificationService.dispatch({
                    recipientIds: sid,
                    actorId: req.user.user_id,
                    role: 'Student',
                    category: 'assessment',
                    priority: 'normal',
                    eventType: 'audio_feedback_added',
                    title: `Voice Feedback: ${assessment_name}`,
                    message: `Your instructor added an audio critique (${duration}s). Click to listen.`,
                    targetUrl: `/subjects/open/${subject_id}?tab=assessments&assessment_id=${aid}#asgn-card-${aid}`,
                    metadata: { scoreId, assessmentId: aid }
                });

                // Propagate audio note to group members if shared group assignment
                if (is_group_assignment && (group_grading_mode === 'shared_grade' || group_grading_mode === 'group' || group_submission_mode === 'one_per_group')) {
                    let targetGrpId = gid || req.body.group_id;
                    if (!targetGrpId) {
                        const [[grpLookup]] = await db.query(
                            `SELECT group_id FROM group_members WHERE student_id = ? LIMIT 1`,
                            [sid]
                        );
                        if (grpLookup) targetGrpId = grpLookup.group_id;
                    }
                    if (targetGrpId) {
                        await db.query(`
                            UPDATE student_scores
                            SET voice_note_path = ?, voice_note_duration_sec = ?
                            WHERE assessment_id = ? AND group_id = ? AND score_id != ?
                        `, [filename, duration, aid, targetGrpId, scoreId]);

                        const [peerMembers] = await db.query(
                            `SELECT student_id FROM group_members WHERE group_id = ? AND student_id != ?`,
                            [targetGrpId, sid]
                        );
                        for (const pm of peerMembers) {
                            try {
                                await notificationService.dispatch({
                                    recipientIds: pm.student_id,
                                    actorId: req.user.user_id,
                                    role: 'Student',
                                    category: 'assessment',
                                    priority: 'normal',
                                    eventType: 'audio_feedback_added',
                                    title: `Group Voice Feedback: ${assessment_name}`,
                                    message: `Your instructor added an audio critique (${duration}s) for your group. Click to listen.`,
                                    targetUrl: `/subjects/open/${subject_id}?tab=assessments&assessment_id=${aid}#asgn-card-${aid}`,
                                    metadata: { scoreId, assessmentId: aid }
                                });
                            } catch (_) { }
                        }
                    }
                }
            }
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Audio Note]', notifErr);
        }

        res.json({ success: true, voice_note_path: filename, duration, score_id: scoreId });
    } catch (err) {
        console.error('[POST /teacher/api/grading/:scoreId/audio-note]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3b. POST /teacher/api/grading/:scoreId/save — Save Score, Feedback & Rubric Criteria
router.post('/api/grading/:scoreId/save', isTeacher, async (req, res) => {
    try {
        let scoreId = req.params.scoreId;
        const { score, feedback, rubric_scores, student_id, assessment_id, group_id, is_group_submission } = req.body;

        let targetStudentId = student_id;
        if (!targetStudentId && group_id) {
            const [[firstMem]] = await db.query(`SELECT student_id FROM group_members WHERE group_id = ? ORDER BY student_id ASC LIMIT 1`, [group_id]);
            if (firstMem) targetStudentId = firstMem.student_id;
        }

        // Check quarter grading deadline
        const activeSY = await academicHelper.getActiveSchoolYear(db);
        const qInfo = await academicHelper.resolveAssessmentQuarter(db, { assessmentId, scoreId });
        const gradingCheck = academicHelper.isQuarterGradingOpen(activeSY, qInfo.quarterNumber);
        if (!gradingCheck.isAllowed) {
            return res.status(403).json({
                success: false,
                error: `Grading Locked: ${gradingCheck.message}`,
                gradingStatus: gradingCheck
            });
        }

        if (scoreId === 'new' || scoreId === '0' || !scoreId) {
            if (targetStudentId && assessment_id) {
                const [existing] = await db.query(
                    `SELECT score_id FROM student_scores WHERE student_id = ? AND assessment_id = ? ORDER BY score_id DESC LIMIT 1`,
                    [targetStudentId, assessment_id]
                );
                if (existing.length > 0) {
                    scoreId = existing[0].score_id;
                } else {
                    const [[asmtRow]] = await db.query(`SELECT max_score FROM assessments WHERE assessment_id = ?`, [assessment_id]);
                    const maxScore = asmtRow ? (asmtRow.max_score || 100) : 100;
                    const [ins] = await db.query(
                        `INSERT INTO student_scores (student_id, assessment_id, score_obtained, feedback, date_recorded, total_items, total_possible_score, group_id)
                         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
                        [targetStudentId, assessment_id, score !== undefined && score !== null ? Number(score) : 0, feedback || '', maxScore, maxScore, group_id || null]
                    );
                    scoreId = ins.insertId;
                }
            } else {
                return res.status(400).json({ success: false, error: 'student_id or group_id and assessment_id required for new score record' });
            }
        }

        await db.query(`
            UPDATE student_scores 
            SET score_obtained = ?, feedback = ?, date_recorded = NOW()
            WHERE score_id = ?
        `, [score !== undefined && score !== null ? Number(score) : 0, feedback || '', scoreId]);

        if (rubric_scores && Array.isArray(rubric_scores)) {
            for (const r of rubric_scores) {
                if (r.criterion_id) {
                    await db.query(`
                        INSERT INTO submission_rubric_scores (score_id, criterion_id, points_awarded, criterion_feedback)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE points_awarded = VALUES(points_awarded), criterion_feedback = VALUES(criterion_feedback)
                    `, [scoreId, r.criterion_id, Number(r.points_awarded) || 0, r.criterion_feedback || '']);
                }
            }
        }

        // Fetch score and assessment info
        const [[scoreRow]] = await db.query(`
            SELECT ss.score_id, ss.student_id, ss.assessment_id, ss.group_id, ss.total_items,
                   a.assessment_name, a.is_group_assignment, a.group_grading_mode, a.group_submission_mode, q.subject_id
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ss.score_id = ?
        `, [scoreId]);

        if (scoreRow) {
            const finalScore = score !== undefined && score !== null ? Number(score) : 0;

            // Dispatch notification to current student
            try {
                await notificationService.dispatch({
                    recipientIds: scoreRow.student_id,
                    actorId: req.user.user_id,
                    role: 'Student',
                    category: 'assessment',
                    priority: 'high',
                    eventType: 'grade_released',
                    title: `Grade Released: ${scoreRow.assessment_name}`,
                    message: `Score: ${finalScore} pts. Click to view rubric evaluation and feedback.`,
                    targetUrl: `/subjects/open/${scoreRow.subject_id}?tab=assessments&assessment_id=${scoreRow.assessment_id}#asgn-card-${scoreRow.assessment_id}`,
                    metadata: { scoreId, assessmentId: scoreRow.assessment_id, score: finalScore }
                });
            } catch (notifErr) {
                console.error('[Notification Dispatch Error on Grade Save]', notifErr);
            }

            // If group assignment with shared grade, propagate to all group members
            if (scoreRow.is_group_assignment && (scoreRow.group_grading_mode === 'shared_grade' || scoreRow.group_grading_mode === 'group' || scoreRow.group_submission_mode === 'one_per_group' || is_group_submission)) {
                let effectiveGroupId = scoreRow.group_id || group_id;
                if (!effectiveGroupId) {
                    const [[grpLookup]] = await db.query(`
                        SELECT gm.group_id
                        FROM group_members gm
                        JOIN student_groups sg ON gm.group_id = sg.group_id
                        WHERE gm.student_id = ? AND (sg.group_set_id = (SELECT group_set_id FROM assessments WHERE assessment_id = ?) OR sg.group_set_id IN (
                            SELECT gs.group_set_id FROM group_sets gs 
                            JOIN classes c ON gs.class_id = c.class_id 
                            WHERE c.subject_id = ?
                        ))
                        LIMIT 1
                    `, [scoreRow.student_id, scoreRow.assessment_id, scoreRow.subject_id]);
                    if (grpLookup) {
                        effectiveGroupId = grpLookup.group_id;
                        await db.query(`UPDATE student_scores SET group_id = ? WHERE score_id = ?`, [effectiveGroupId, scoreId]);
                    }
                }

                if (effectiveGroupId) {
                    const [members] = await db.query(
                        `SELECT student_id FROM group_members WHERE group_id = ?`,
                        [effectiveGroupId]
                    );

                    for (const m of members) {
                        if (m.student_id !== scoreRow.student_id) {
                            const [[existingPeer]] = await db.query(
                                `SELECT score_id FROM student_scores WHERE student_id = ? AND assessment_id = ? LIMIT 1`,
                                [m.student_id, scoreRow.assessment_id]
                            );

                            let peerScoreId;
                            if (existingPeer) {
                                peerScoreId = existingPeer.score_id;
                                await db.query(
                                    `UPDATE student_scores SET score_obtained = ?, feedback = ?, date_recorded = NOW(), group_id = ?,
                                            submitted_by_user_id = COALESCE(submitted_by_user_id, ?),
                                            file_path = COALESCE(file_path, ?),
                                            original_filename = COALESCE(original_filename, ?),
                                            file_size_bytes = CASE WHEN file_size_bytes > 0 THEN file_size_bytes ELSE ? END
                                     WHERE score_id = ?`,
                                    [finalScore, feedback || '', effectiveGroupId, scoreRow.submitted_by_user_id || scoreRow.student_id, scoreRow.file_path, scoreRow.original_filename, scoreRow.file_size_bytes || 0, peerScoreId]
                                );
                            } else {
                                const [insPeer] = await db.query(
                                    `INSERT INTO student_scores (student_id, assessment_id, score_obtained, total_items, total_possible_score, feedback, date_recorded, group_id, submitted_at, submitted_by_user_id, file_path, original_filename, file_size_bytes)
                                     VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), ?, ?, ?, ?)`,
                                    [m.student_id, scoreRow.assessment_id, finalScore, scoreRow.total_items || 100, scoreRow.total_items || 100, feedback || '', effectiveGroupId, scoreRow.submitted_by_user_id || scoreRow.student_id, scoreRow.file_path, scoreRow.original_filename, scoreRow.file_size_bytes || 0]
                                );
                                peerScoreId = insPeer.insertId;
                            }

                            // Replicate rubric criteria
                            if (rubric_scores && Array.isArray(rubric_scores)) {
                                for (const r of rubric_scores) {
                                    if (r.criterion_id) {
                                        await db.query(`
                                            INSERT INTO submission_rubric_scores (score_id, criterion_id, points_awarded, criterion_feedback)
                                            VALUES (?, ?, ?, ?)
                                            ON DUPLICATE KEY UPDATE points_awarded = VALUES(points_awarded), criterion_feedback = VALUES(criterion_feedback)
                                        `, [peerScoreId, r.criterion_id, Number(r.points_awarded) || 0, r.criterion_feedback || '']);
                                    }
                                }
                            }

                            // Recalculate peer student progress
                            try {
                                await recalculateProgress(m.student_id, scoreRow.subject_id);
                            } catch (progErr) {
                                console.warn('[Progress Recalculate Error for Peer]', progErr);
                            }

                            // Dispatch notification to peer
                            try {
                                await notificationService.dispatch({
                                    recipientIds: m.student_id,
                                    actorId: req.user.user_id,
                                    role: 'Student',
                                    category: 'assessment',
                                    priority: 'high',
                                    eventType: 'grade_released',
                                    title: `Group Grade: ${scoreRow.assessment_name}`,
                                    message: `Your team received ${finalScore} pts. Click to view rubric evaluation and feedback.`,
                                    targetUrl: `/subjects/open/${scoreRow.subject_id}?tab=assessments&assessment_id=${scoreRow.assessment_id}#asgn-card-${scoreRow.assessment_id}`,
                                    metadata: { scoreId: peerScoreId, assessmentId: scoreRow.assessment_id, score: finalScore }
                                });
                            } catch (_) { }
                        }
                    }
                }
            }
        }

        res.json({ success: true, score_id: scoreId, message: 'Grade and rubric evaluation saved.' });
    } catch (err) {
        console.error('[POST /teacher/api/grading/:scoreId/save]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Comment Bank CRUD
router.get('/api/comment-bank', isTeacher, async (req, res) => {
    try {
        const [snippets] = await db.query(`
            SELECT * FROM comment_bank_snippets 
            WHERE teacher_id IS NULL OR teacher_id = ?
            ORDER BY usage_count DESC, created_at DESC
        `, [req.user.user_id]);

        res.json({ success: true, snippets });
    } catch (err) {
        console.error('[GET /teacher/api/comment-bank]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/comment-bank', isTeacher, async (req, res) => {
    try {
        const { shortcut, expanded_text, category } = req.body;
        if (!shortcut || !expanded_text) {
            return res.status(400).json({ success: false, error: 'Shortcut and text are required' });
        }

        const [result] = await db.query(`
            INSERT INTO comment_bank_snippets (teacher_id, shortcut, expanded_text, category)
            VALUES (?, ?, ?, ?)
        `, [req.user.user_id, shortcut.toLowerCase().trim(), expanded_text.trim(), category || 'General']);

        res.json({ success: true, snippet_id: result.insertId });
    } catch (err) {
        console.error('[POST /teacher/api/comment-bank]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/api/comment-bank/:id', isTeacher, async (req, res) => {
    try {
        await db.query(`
            DELETE FROM comment_bank_snippets WHERE snippet_id = ? AND teacher_id = ?
        `, [req.params.id, req.user.user_id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[DELETE /teacher/api/comment-bank/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/comment-bank/:id/use', isTeacher, async (req, res) => {
    try {
        await db.query(`UPDATE comment_bank_snippets SET usage_count = usage_count + 1 WHERE snippet_id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 5. Smart Batch Actions: Filter Cohorts & Dispatch
router.get('/api/assessment/:aid/students-filter', isTeacher, async (req, res) => {
    try {
        const aid = req.params.aid;
        const condition = req.query.status || 'unsubmitted';

        let query = '';
        let params = [];

        if (condition === 'unsubmitted') {
            query = `
                SELECT u.user_id, u.first_name, u.last_name, u.email
                FROM users u
                WHERE u.role = 'Student'
                  AND u.user_id NOT IN (SELECT student_id FROM student_scores WHERE assessment_id = ?)
            `;
            params = [aid];
        } else if (condition === 'below_cutoff') {
            query = `
                SELECT u.user_id, u.first_name, u.last_name, u.email, ss.score_obtained, ss.total_items
                FROM student_scores ss
                JOIN users u ON ss.student_id = u.user_id
                WHERE ss.assessment_id = ? AND (ss.score_obtained / ss.total_items) < 0.75
            `;
            params = [aid];
        } else if (condition === 'grace_period') {
            query = `
                SELECT u.user_id, u.first_name, u.last_name, u.email, ss.is_grace_period, ss.grace_minutes_used
                FROM student_scores ss
                JOIN users u ON ss.student_id = u.user_id
                WHERE ss.assessment_id = ? AND ss.is_grace_period = 1
            `;
            params = [aid];
        } else {
            query = `SELECT u.user_id, u.first_name, u.last_name, u.email FROM users u WHERE u.role = 'Student'`;
        }

        const [students] = await db.query(query, params);
        res.json({ success: true, count: students.length, students });
    } catch (err) {
        console.error('[GET /api/assessment/:aid/students-filter]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/assessment/:aid/batch-message', isTeacher, async (req, res) => {
    try {
        const { condition, subject, body } = req.body;
        const aid = req.params.aid;

        // Fetch matching cohort
        const [students] = await db.query(`
            SELECT u.user_id FROM users u
            WHERE u.role = 'Student'
              ${condition === 'unsubmitted' ? 'AND u.user_id NOT IN (SELECT student_id FROM student_scores WHERE assessment_id = ?)' : ''}
        `, condition === 'unsubmitted' ? [aid] : []);

        if (!students.length) {
            return res.json({ success: true, dispatchedCount: 0 });
        }

        // Apply Sliding-Window Dispatch Rate Limiter
        const limitCheck = batchMessageLimiter.check(`teacher_${req.user.user_id}`, students.length);
        if (!limitCheck.allowed) {
            return res.status(429).json({
                success: false,
                error: `Dispatch rate limit exceeded. Please wait ${limitCheck.retryAfterSec} seconds before sending more batch messages.`
            });
        }

        // Insert into private_messages in bulk
        const studentIds = students.map(s => s.user_id);
        for (const s of students) {
            await db.query(`
                INSERT INTO private_messages (sender_id, receiver_id, message_text)
                VALUES (?, ?, ?)
            `, [req.user.user_id, s.user_id, `[${subject}]\n${body}`]);
        }

        // Dispatch in-app notification to all targeted students in batch
        try {
            const senderName = `${req.user.first_name || 'Instructor'} ${req.user.last_name || ''}`.trim();
            const previewText = body.length > 80 ? body.substring(0, 77) + '...' : body;
            await notificationService.dispatch({
                recipientIds: studentIds,
                actorId: req.user.user_id,
                role: 'Student',
                category: 'social',
                priority: 'high',
                eventType: 'direct_message_received',
                title: `${subject || 'Announcement from ' + senderName}`,
                message: previewText,
                targetUrl: `/messages?userId=${req.user.user_id}`,
                metadata: { senderId: req.user.user_id, assessmentId: aid }
            });
        } catch (notifErr) {
            console.error('[Notification Dispatch Error on Batch Message]', notifErr.message);
        }

        res.json({ success: true, dispatchedCount: students.length });
    } catch (err) {
        console.error('[POST /api/assessment/:aid/batch-message]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/assessment/:aid/batch-zero', isTeacher, async (req, res) => {
    try {
        const aid = req.params.aid;

        // Check quarter grading deadline
        const activeSY = await academicHelper.getActiveSchoolYear(db);
        const qInfo = await academicHelper.resolveAssessmentQuarter(db, { assessmentId: aid });
        const gradingCheck = academicHelper.isQuarterGradingOpen(activeSY, qInfo.quarterNumber);
        if (!gradingCheck.isAllowed) {
            return res.status(403).json({
                success: false,
                error: `Grading Locked: ${gradingCheck.message}`,
                gradingStatus: gradingCheck
            });
        }

        const [[asmt]] = await db.query(`SELECT total_items FROM assessments WHERE assessment_id = ?`, [aid]);
        const totalItems = asmt ? asmt.total_items : 10;

        const [unsubmitted] = await db.query(`
            SELECT u.user_id FROM users u
            WHERE u.role = 'Student'
              AND u.user_id NOT IN (SELECT student_id FROM student_scores WHERE assessment_id = ?)
        `, [aid]);

        for (const s of unsubmitted) {
            await db.query(`
                INSERT INTO student_scores (student_id, assessment_id, score_obtained, total_items, total_possible_score)
                VALUES (?, ?, 0, ?, ?)
            `, [s.user_id, aid, totalItems, totalItems]);
        }

        res.json({ success: true, affectedCount: unsubmitted.length });
    } catch (err) {
        console.error('[POST /api/assessment/:aid/batch-zero]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ELEMENTA ARCADE TELEMETRY & PEDAGOGICAL COGNITIVE ANALYTICS
// ============================================================

router.get('/arcade-telemetry', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        const currentSyId = currentSY ? currentSY.sy_id : null;

        // Fetch classes taught by this teacher for active school year
        const [classes] = await db.query(
            `SELECT c.class_id, c.class_name, s.subject_name 
             FROM classes c
             LEFT JOIN subjects s ON s.subject_id = c.subject_id
             WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?)
             ORDER BY c.class_name ASC`,
            [teacherId, currentSyId, currentSyId]
        );

        const selectedClassId = req.query.class_id ? parseInt(req.query.class_id, 10) : (classes[0] ? classes[0].class_id : null);

        // Fetch analytics components
        const heatmap = await arcadeAnalyticsService.getPeriodicTableHeatmap();
        const scatter = await arcadeAnalyticsService.getSpeedAccuracyDistribution(selectedClassId);
        const riskList = await arcadeAnalyticsService.getEarlyWarningRiskList(selectedClassId);

        // Fetch complete 118 periodic table elements for the matrix
        const [elementsList] = await db.query(
            `SELECT atomic_number, element_symbol, element_name, group_col, period_row, category 
             FROM elementa_periodic_table_buttons 
             ORDER BY atomic_number ASC`
        );

        // Fetch recent arcade sessions for this class or general within active cohort
        let sessionSql = `
            SELECT s.session_id, s.started_at AS played_at, s.play_mode AS game_mode, s.final_score_p1 AS final_score, s.final_score_p2, s.cabinet_id,
                   s.winner,
                   u.user_id, u.first_name, u.last_name, u.lrn_number, u.profile_pic,
                   u2.user_id AS p2_user_id, u2.first_name AS p2_first_name, u2.last_name AS p2_last_name, u2.lrn_number AS p2_lrn_number, u2.profile_pic AS p2_profile_pic,
                   COUNT(r.run_id) AS total_runs
            FROM elementa_game_sessions s
            JOIN users u ON u.user_id = s.student_id_p1
            LEFT JOIN users u2 ON u2.user_id = s.student_id_p2
            LEFT JOIN elementa_level_runs r ON r.session_id = s.session_id
        `;
        const sessionParams = [];
        if (selectedClassId) {
            sessionSql += ` JOIN class_students cs ON (cs.student_id = u.user_id OR cs.student_id = u2.user_id) WHERE cs.class_id = ? `;
            sessionParams.push(selectedClassId);
        } else {
            sessionSql += ` JOIN class_students cs ON (cs.student_id = u.user_id OR cs.student_id = u2.user_id)
                            JOIN classes c ON cs.class_id = c.class_id
                            WHERE c.teacher_id = ? AND (? IS NULL OR c.sy_id = ?) `;
            sessionParams.push(teacherId, currentSyId, currentSyId);
        }
        sessionSql += ` GROUP BY s.session_id ORDER BY s.started_at DESC LIMIT 50`;

        const [recentSessions] = await db.query(sessionSql, sessionParams);


        // Fetch learning materials that teacher can assign for remediation
        const [materials] = await db.query(
            `SELECT material_id, title, material_type, file_path_or_url
             FROM learning_materials
             ORDER BY title ASC LIMIT 50`
        );

        let notifications = [];
        try {
            notifications = await getTeacherNotifications(db, teacherId);
        } catch (nErr) {
            console.warn('[arcade_telemetry] Notifications fetch fallback:', nErr.message);
        }

        let kiosks = [];
        try {
            const [kRows] = await db.query(
                `SELECT k.*, 
                        gs.student_id_p1, gs.student_id_p2, gs.play_mode,
                        CONCAT(COALESCE(u1.first_name, ''), ' ', COALESCE(u1.last_name, '')) AS student_name_p1,
                        CONCAT(COALESCE(u2.first_name, ''), ' ', COALESCE(u2.last_name, '')) AS student_name_p2,
                        a.assessment_name, lr.level_number
                 FROM elementa_kiosk_status k
                 LEFT JOIN elementa_game_sessions gs ON gs.session_id = k.active_session_id
                 LEFT JOIN users u1 ON u1.user_id = gs.student_id_p1
                 LEFT JOIN users u2 ON u2.user_id = gs.student_id_p2
                 LEFT JOIN assessments a ON a.assessment_id = gs.assessment_id
                 LEFT JOIN elementa_level_runs lr ON lr.session_id = gs.session_id AND lr.run_status = 'In_Progress'
                 ORDER BY k.last_heartbeat DESC`
            );
            kiosks = kRows || [];
        } catch (kErr) {
            console.warn('[arcade_telemetry] Kiosks query fallback:', kErr.message);
        }

        res.render('teacher/arcade_telemetry', {
            user: req.user,
            classes,
            selectedClassId,
            heatmap,
            scatter,
            riskList,
            recentSessions,
            materials,
            notifications,
            kiosks,
            elements: elementsList || []
        });
    } catch (err) {
        console.error('❌ [GET /teacher/arcade-telemetry]', err);
        res.status(500).send('Internal Server Error: ' + err.message);
    }
});

// Replay timeline API for step-by-step modal
router.get('/api/arcade/replay/:sessionId', isTeacher, async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const replay = await arcadeAnalyticsService.getSessionReplay(sessionId);
        if (!replay) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        res.json({ success: true, replay });
    } catch (err) {
        console.error('❌ [GET /teacher/api/arcade/replay/:sessionId]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 1-Click Targeted Remediation Assignment API
router.post('/api/arcade/assign-remediation', isTeacher, async (req, res) => {
    try {
        const { student_id, material_id, custom_note, machine_name } = req.body;
        if (!student_id) {
            return res.status(400).json({ success: false, error: 'Student ID required' });
        }

        let materialTitle = 'Chemistry Mastery Module';
        let targetUrl = '/student/materials';

        if (material_id) {
            const [[mat]] = await db.query(`SELECT title, material_type, file_path_or_url FROM learning_materials WHERE material_id = ?`, [material_id]);
            if (mat) {
                materialTitle = mat.title;
                if (mat.file_path_or_url) targetUrl = mat.file_path_or_url;
            }
        }

        const noteText = custom_note || `Targeted practice assigned based on your Elementa Arcade telemetry at ${machine_name || 'Laboratory Station'}.`;

        await notificationService.dispatch({
            recipientIds: [student_id],
            actorId: req.user.user_id,
            role: 'Student',
            category: 'academic',
            priority: 'high',
            eventType: 'arcade_remediation_assigned',
            title: `🎯 Recommended Study: ${materialTitle}`,
            message: noteText,
            targetUrl
        });

        res.json({ success: true, message: 'Remediation dispatched to student successfully!' });
    } catch (err) {
        console.error('❌ [POST /teacher/api/arcade/assign-remediation]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router._computeStudentSubjectSummary = computeStudentSubjectSummary;
router._computeClassTopicRemediation = computeClassTopicRemediation;
router._computeClassGradebookData = computeClassGradebookData;
router._getStudentFilteredReportData = getStudentFilteredReportData;
router._renderStudentProgressReportCardPage = renderStudentProgressReportCardPage;
router._verifyClassOwnership = verifyClassOwnership;
router._assertActiveClass = assertActiveClass;

module.exports = router;