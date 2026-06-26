const express = require('express');
const router = express.Router();
const db = require('../db'); 
const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ExcelJS     = require('exceljs');


// MIDDLEWARE: Proteksyon para tanging Guro lang ang makapasok
function isTeacher(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'Teacher') {
        return next();
    }
    res.status(403).send("Access Denied: Teachers Only");
}

// ============================================================
// SHARED PDF HEADER HELPER
// Draws the standard Mabini College branded header on every PDF.
// Call at the start of every exported PDF document.
// ============================================================
function drawPdfHeader(doc, title, subtitle, teacher) {
    const pageW  = 595;
    const logoW  = 60;
    const logoH  = 60;
    const logoL  = '../assets/mabini_logo1.png';   // left corner logo
    const logoR  = '../assets/mabini_logo2.png';   // right corner logo
    const logoY  = 14;

    // ── Background band ──────────────────────────────────────
    doc.rect(0, 0, pageW, 90).fill('#0d1a2e');

    // ── Thin accent line at bottom of header ─────────────────
    doc.rect(0, 90, pageW, 3)
       .fillOpacity(1)
       .fill('#06b6d4');   // cyan accent

    // ── Left logo ────────────────────────────────────────────
    try {
        const logoLeftPath  = require('path').join(__dirname, '..', 'public', 'assets', 'mabini_logo1.png');
        const logoRightPath = require('path').join(__dirname, '..', 'public', 'assets', 'mabini_logo2.png');
        doc.image(logoLeftPath,  24, logoY, { width: logoW, height: logoH, fit: [logoW, logoH], align: 'center', valign: 'center' });
        doc.image(logoRightPath, pageW - logoW - 24, logoY, { width: logoW, height: logoH, fit: [logoW, logoH], align: 'center', valign: 'center' });
    } catch (_) {
        // Logos optional — skip gracefully if not found
    }

    // ── Center text block ─────────────────────────────────────
    doc.fillColor('#ffffff')
       .fontSize(15)
       .font('Helvetica-Bold')
       .text('MABINI COLLEGE', 0, 16, { align: 'center', width: pageW });

    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#94d6f0')
       .text('Elementa Chemistry Arcade LMS', 0, 34, { align: 'center', width: pageW });

    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#e0f2fe')
       .text(title, 0, 50, { align: 'center', width: pageW });

    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#7dd3fc')
       .text(subtitle, 0, 65, { align: 'center', width: pageW });

    // ── Meta line below header ────────────────────────────────
    doc.moveDown(0);
    const metaY = 100;
    doc.rect(0, 93, pageW, 20).fill('#f0f9ff');
    doc.fontSize(7.5)
       .font('Helvetica')
       .fillColor('#475569')
       .text(
           `Generated: ${new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' })}   |   Teacher: ${teacher}   |   Mabini College — Academic Report`,
           0, 98, { align: 'center', width: pageW }
       );

    // Move cursor below the full header block
    doc.y = 122;
}

// Helper: draw a thin divider line
function pdfDivider(doc, color = '#e2e8f0') {
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor(color).lineWidth(0.5).stroke();
    doc.moveDown(0.4);
}

// Helper: add page footer with page number
function addPageNumbers(doc) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(7).fillColor('#94a3b8').font('Helvetica')
           .text(`Page ${i - range.start + 1} of ${range.count}   |   CONFIDENTIAL — For institutional use only`,
                 40, 822, { align: 'center', width: 515 });
    }
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
        const ext  = path.extname(file.originalname).toLowerCase();
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
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'video/ogg'
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`File type not allowed: ${file.mimetype}`));
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


// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER — fetches notifications for any teacher page
// Call: const notifications = await getTeacherNotifications(db, teacherId);
// ─────────────────────────────────────────────────────────────────────────────
async function getTeacherNotifications(db, teacherId) {
    try {
        const [notifications] = await db.query(`
            SELECT * FROM (

                SELECT
                    'forum_reply' AS notif_type,
                    fr.reply_id AS ref_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                    u.profile_pic AS actor_pic,
                    CONCAT('replied on "', ft.title, '"') AS message,
                    fr.created_at AS notif_time,
                    ft.forum_id AS link_id,
                    NULL AS class_id
                FROM forum_replies fr
                JOIN forum_topics ft ON fr.topic_id = ft.forum_id
                JOIN users u ON fr.user_id = u.user_id
                WHERE ft.teacher_id = ? AND fr.user_id != ?

                UNION ALL

                SELECT
                    'private_message' AS notif_type,
                    pm.message_id AS ref_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                    u.profile_pic AS actor_pic,
                    CONCAT('sent you a message: "', LEFT(pm.message_text, 40), '..."') AS message,
                    pm.sent_at AS notif_time,
                    pm.sender_id AS link_id,
                    NULL AS class_id
                FROM private_messages pm
                JOIN users u ON pm.sender_id = u.user_id
                WHERE pm.receiver_id = ?

                UNION ALL

                SELECT
                    'struggling_student' AS notif_type,
                    u.user_id AS ref_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                    u.profile_pic AS actor_pic,
                    CONCAT('is struggling in ', s.subject_name, ' (', sp.progress_percent, '%)') AS message,
                    sp.last_accessed AS notif_time,
                    c.class_id AS link_id,
                    c.class_id AS class_id
                FROM student_progress sp
                JOIN users u ON sp.student_id = u.user_id
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND sp.progress_percent < 50

                UNION ALL

                SELECT
                    'pending_question' AS notif_type,
                    qb.question_id AS ref_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                    u.profile_pic AS actor_pic,
                    CONCAT('submitted a question for review: "', LEFT(qb.question_text, 40), '..."') AS message,
                    qb.verified_at AS notif_time,
                    qb.question_id AS link_id,
                    NULL AS class_id
                FROM question_bank qb
                JOIN users u ON qb.teacher_id = u.user_id
                WHERE qb.verification_status = 'Pending' AND qb.teacher_id = ?

                UNION ALL

                SELECT
                    'upcoming_deadline' AS notif_type,
                    a.assessment_id AS ref_id,
                    a.assessment_name AS actor_name,
                    NULL AS actor_pic,
                    CONCAT(a.assessment_name, ' is due on ', DATE_FORMAT(a.due_date, '%b %d')) AS message,
                    a.due_date AS notif_time,
                    c.class_id AS link_id,
                    c.class_id AS class_id
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND a.due_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 3 DAY)

            ) AS all_notifications
            ORDER BY notif_time DESC
            LIMIT 30
        `, [teacherId, teacherId, teacherId, teacherId, teacherId, teacherId]);
        return notifications;
    } catch (err) {
        console.error('[getTeacherNotifications Error]', err);
        return [];
    }
}


router.get('/dashboard', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;

    try {
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
        ] = await Promise.all([
            db.query(`
                SELECT c.*, s.subject_name, s.subject_code, s.subject_image,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count
                FROM classes c JOIN subjects s ON c.subject_id = s.subject_id
                WHERE c.teacher_id = ?`, [teacherId]),

            db.query(`
                SELECT 
                    (SELECT COUNT(DISTINCT student_id) FROM class_students cs JOIN classes c ON cs.class_id = c.class_id WHERE c.teacher_id = ?) as totalStudents,
                    (SELECT COUNT(*) FROM student_scores ss 
                     JOIN assessments a ON ss.assessment_id = a.assessment_id 
                     JOIN topics t ON a.topic_id = t.topic_id 
                     JOIN quarters q ON t.quarter_id = q.quarter_id 
                     JOIN classes c ON q.subject_id = c.subject_id 
                     WHERE c.teacher_id = ?) as totalAttempts`,
                [teacherId, teacherId]),

            db.query(`
                SELECT ss.*, u.first_name, u.last_name, u.profile_pic as student_pic, 
                       a.assessment_name, a.total_items, t.topic_name, s.subject_name
                FROM student_scores ss 
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id 
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                WHERE c.teacher_id = ? 
                ORDER BY ss.date_recorded DESC LIMIT 5`, [teacherId]),

            db.query(`
                SELECT ft.*, t.topic_name, q.subject_id
                FROM forum_topics ft 
                LEFT JOIN topics t ON ft.topic_id = t.topic_id
                LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE ft.teacher_id = ? 
                ORDER BY ft.created_at DESC`, [teacherId]),

            db.query(`
            SELECT 
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
            WHERE c.teacher_id = ? AND a.due_date >= CURDATE()
            ORDER BY a.due_date ASC
            LIMIT 5
        `, [teacherId]),

            db.query(`
                SELECT u.first_name, u.last_name, u.profile_pic, sp.progress_percent, s.subject_name, s.subject_id
                FROM student_progress sp 
                JOIN users u ON sp.student_id = u.user_id
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND sp.progress_percent < 50 
                GROUP BY u.user_id, s.subject_id`, [teacherId]),

            db.query(`SELECT * FROM announcements WHERE teacher_id = ? ORDER BY created_at DESC LIMIT 3`, [teacherId]),

            db.query(`SELECT * FROM forum_topics WHERE teacher_id = ? AND is_pinned = 1`, [teacherId]),

            db.query(`
                SELECT ev.*, s.subject_name 
                FROM calendar_events ev
                JOIN subjects s ON ev.subject_id = s.subject_id
                WHERE ev.teacher_id = ? 
                ORDER BY ev.event_date ASC`, [teacherId]),

            db.query(`
                SELECT u.first_name, u.last_name, u.profile_pic, SUM(ss.score_obtained) as total_points
                FROM student_scores ss
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN classes c ON a.topic_id IN (SELECT topic_id FROM topics WHERE quarter_id IN (SELECT quarter_id FROM quarters WHERE subject_id = c.subject_id))
                WHERE c.teacher_id = ?
                GROUP BY u.user_id ORDER BY total_points DESC LIMIT 5`, [teacherId]),

            db.query(`
                SELECT AVG((ss.score_obtained / a.total_items) * 100) as avg_accuracy
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?`, [teacherId]),

            /* NEW: Subject Assessment Completion Stats for bar chart */
            db.query(`
                SELECT
                    s.subject_id,
                    s.subject_name,
                    s.subject_code,
                    COUNT(DISTINCT a.assessment_id) AS total_assessments,
                    COUNT(DISTINCT cs.student_id) AS total_students,
                    COUNT(DISTINCT ss.student_id) AS students_completed,
                    ROUND(
                        (COUNT(DISTINCT ss.student_id) / NULLIF(COUNT(DISTINCT cs.student_id), 0)) * 100
                    , 1) AS completion_percent
                FROM subjects s
                JOIN classes c ON s.subject_id = c.subject_id
                JOIN quarters q ON s.subject_id = q.subject_id
                JOIN topics t ON q.quarter_id = t.quarter_id
                JOIN assessments a ON t.topic_id = a.topic_id
                LEFT JOIN class_students cs ON c.class_id = cs.class_id
                LEFT JOIN student_scores ss ON a.assessment_id = ss.assessment_id
                    AND ss.student_id IN (SELECT student_id FROM class_students WHERE class_id = c.class_id)
                WHERE c.teacher_id = ?
                GROUP BY s.subject_id, s.subject_name, s.subject_code
                ORDER BY completion_percent ASC`, [teacherId]),
        ]);

        const notifications = await getTeacherNotifications(db, teacherId);

        res.render('teacher/dashboard', {
            user: req.user,
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
            notifications,
        });

    } catch (err) {
        console.error("❌ Teacher Dashboard Error:", err);
        res.status(500).send("Problem loading dashboard.");
    }
});


// ============================================================
// CLASS VIEW ROUTE (full detail: quarters / topics / analytics)
// ============================================================

router.get('/class/:classId', isTeacher, async (req, res) => {
    console.log(`[GET] /class/${req.params.classId}`);
    try {
        const classId   = req.params.classId;
        const teacherId = req.user.user_id;

        const [classData] = await db.execute(`
            SELECT c.*, s.*, sy.sy_range
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE c.class_id = ? AND c.teacher_id = ?`, [classId, teacherId]);

        if (!classData.length) return res.status(404).send('Class not found');
        console.log('[DEBUG] subject_image:', classData[0].subject_image);

        const subjectId = classData[0].subject_id;

        const [students] = await db.execute(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.middle_name,
                u.profile_pic, u.lrn_number, u.grade_level, u.section,
                u.current_level, u.flagged_assessment_id,
                COALESCE((
                    SELECT SUM(ss.exp_gained)
                    FROM student_scores ss
                    JOIN assessments a ON ss.assessment_id = a.assessment_id
                    JOIN topics t      ON a.topic_id      = t.topic_id
                    JOIN quarters qt   ON t.quarter_id    = qt.quarter_id
                    WHERE ss.student_id = u.user_id
                      AND qt.subject_id = ?
                ), 0) AS total_exp,
                sp.progress_percent,
                sp.last_accessed
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            LEFT JOIN student_progress sp
                   ON u.user_id = sp.student_id AND sp.subject_id = ?
            WHERE cs.class_id = ? AND u.role = 'Student'
            ORDER BY u.last_name ASC`,
            [subjectId, subjectId, classId]
        );

        const [quarters] = await db.execute(
            `SELECT * FROM quarters WHERE subject_id = ? ORDER BY quarter_number ASC`,
            [subjectId]
        );

        for (const q of quarters) {
            const [topics] = await db.execute(
                `SELECT * FROM topics WHERE quarter_id = ? ORDER BY topic_id ASC`,
                [q.quarter_id]
            );
            for (const t of topics) {
                const [[mats], [asms], [anns], [frms]] = await Promise.all([
                    db.execute(`SELECT * FROM learning_materials WHERE topic_id = ?`, [t.topic_id]),
                    db.execute(`SELECT * FROM assessments WHERE topic_id = ? ORDER BY assessment_id ASC`, [t.topic_id]),
                    db.execute(`SELECT * FROM announcements WHERE topic_id = ? ORDER BY created_at DESC`, [t.topic_id]),
                    db.execute(`SELECT * FROM forum_topics WHERE topic_id = ? ORDER BY is_pinned DESC, created_at DESC`, [t.topic_id]),
                ]);
                t.materials     = mats;
                t.assessments   = asms;
                t.announcements = anns;
                t.forums        = frms;
            }
            q.topics = topics;
        }

        const [scores] = await db.execute(`
            SELECT ss.score_id, ss.score_obtained, ss.total_items,
                ss.exp_gained, ss.date_recorded,
                a.assessment_id, a.assessment_name, a.assessment_type,
                qt.quarter_id, qt.quarter_number,
                u.user_id, u.first_name, u.last_name, u.profile_pic
            FROM student_scores ss
            JOIN assessments a      ON ss.assessment_id = a.assessment_id
            JOIN topics t           ON a.topic_id       = t.topic_id
            JOIN quarters qt        ON t.quarter_id     = qt.quarter_id
            JOIN users u            ON ss.student_id    = u.user_id
            JOIN class_students cs  ON u.user_id        = cs.student_id
            WHERE cs.class_id = ? AND qt.subject_id = ?
            ORDER BY ss.date_recorded DESC`,
            [classId, subjectId]
        );

        const [competitiveMatches] = await db.execute(`
            SELECT cm.match_id, cm.p1_score, cm.p2_score,
                cm.winner_id, cm.match_date, cm.p1_id, cm.p2_id,
                a.assessment_name,
                u1.first_name AS p1_first, u1.last_name AS p1_last,
                u2.first_name AS p2_first, u2.last_name AS p2_last
            FROM competitive_matches cm
            JOIN assessments a  ON cm.assessment_id = a.assessment_id
            JOIN users u1       ON cm.p1_id         = u1.user_id
            JOIN users u2       ON cm.p2_id         = u2.user_id
            JOIN topics t       ON a.topic_id       = t.topic_id
            JOIN quarters qt    ON t.quarter_id     = qt.quarter_id
            WHERE qt.subject_id = ?
              AND (
                cm.p1_id IN (SELECT student_id FROM class_students WHERE class_id = ?)
                OR
                cm.p2_id IN (SELECT student_id FROM class_students WHERE class_id = ?)
              )
            ORDER BY cm.match_date DESC`,
            [subjectId, classId, classId]
        );

        const [leaderboardHistory] = await db.execute(`
            SELECT lh.history_id, lh.rank_achieved,
                lh.total_exp_snapshot, lh.awarded_date,
                u.first_name, u.last_name, u.profile_pic
            FROM leaderboard_history lh
            JOIN users u ON lh.student_id = u.user_id
            WHERE lh.subject_id = ?
            ORDER BY lh.awarded_date DESC LIMIT 100`,
            [subjectId]
        );

        const [activeSessions] = await db.execute(`
            SELECT acs.session_id, acs.player_mode,
                acs.current_item_index, acs.accumulated_score,
                acs.session_status, acs.start_time,
                u.first_name, u.last_name, u.profile_pic,
                a.assessment_name, a.total_items
            FROM active_sessions acs
            JOIN users u        ON acs.student_id    = u.user_id
            JOIN assessments a  ON acs.assessment_id = a.assessment_id
            JOIN class_students cs ON u.user_id      = cs.student_id
            WHERE cs.class_id = ? AND acs.session_status = 'Ongoing'
            ORDER BY acs.start_time ASC`,
            [classId]
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

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/class-view', {
            user:               req.user,
            classInfo:          { class_name: classData[0].class_name, class_id: Number(classId) },
            subject:            classData[0],
            schoolYear:         { sy_range: classData[0].sy_range },
            students:           students           || [],
            quarters:           quarters           || [],
            scores:             scores             || [],
            competitiveMatches: competitiveMatches || [],
            leaderboardHistory: leaderboardHistory || [],
            activeSessions:     activeSessions     || [],
            forumDoneMap,
            calendarEvents:     calendarEvents     || [],
            notifications,
        });

    } catch (err) {
        console.error('[ERROR] GET /class/:classId', err);
        res.status(500).send('Internal Server Error');
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
        await db.execute(`UPDATE topics SET is_locked = ? WHERE topic_id = ?`, [is_locked, req.params.tid]);
        res.json({ success: true });
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
        await db.execute(`UPDATE assessments SET is_unlocked = ? WHERE assessment_id = ?`, [is_unlocked, req.params.aid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/announcement/:aid/priority', isTeacher, async (req, res) => {
    try {
        const { is_priority } = req.body;
        if (is_priority === undefined) throw new Error('is_priority missing');
        await db.execute(`UPDATE announcements SET is_priority = ? WHERE announcement_id = ?`, [is_priority, req.params.aid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: PATCH /api/forum/:id/pin is defined below with ownership validation.


// ============================================================
// TOPIC — POST / PUT / DELETE
// ============================================================

router.post('/api/topic', isTeacher, async (req, res) => {
    try {
        const { quarter_id, topic_name, theme_id } = req.body;
        if (!quarter_id) throw new Error('quarter_id missing');
        if (!topic_name) throw new Error('topic_name missing');
        await db.execute(
            `INSERT INTO topics (quarter_id, topic_name, theme_id, is_locked) VALUES (?, ?, ?, 1)`,
            [quarter_id, topic_name, theme_id || 'default_lab']
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/topic/:tid', isTeacher, async (req, res) => {
    try {
        const { topic_name, theme_id } = req.body;
        if (!topic_name) throw new Error('topic_name missing');
        await db.execute(
            `UPDATE topics SET topic_name = ?, theme_id = ? WHERE topic_id = ?`,
            [topic_name, theme_id || 'default_lab', req.params.tid]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            if (!topic_id)      throw new Error('topic_id is required');
            if (!title)         throw new Error('title is required');
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

            await db.execute(
                `INSERT INTO learning_materials (topic_id, title, material_type, file_path_or_url, is_locked) VALUES (?, ?, ?, ?, ?)`,
                [topic_id, title, material_type, savedPath, is_locked === '1' || is_locked === 1 ? 1 : 0]
            );
            res.json({ success: true, file_path_or_url: savedPath });
        } catch (e) {
            if (req.file) fs.unlink(req.file.path, () => {});
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
                    fs.unlink(oldFile, () => {});
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
            if (req.file) fs.unlink(req.file.path, () => {});
            console.error('[MATERIAL PUT]', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
});

router.delete('/api/material/:mid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM learning_materials WHERE material_id = ?`, [req.params.mid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// ASSESSMENTS — POST / PUT / DELETE
// ============================================================

router.post('/api/assessment', isTeacher, async (req, res) => {
    try {
        const { topic_id, quarter_id, assessment_name, assessment_type, total_items, duration_minutes, timer_type, due_date } = req.body;
        if (!topic_id || !assessment_name || !assessment_type || !total_items) throw new Error('Missing required fields');
        await db.execute(
            `INSERT INTO assessments (quarter_id, topic_id, assessment_name, assessment_type, total_items, duration_minutes, timer_type, is_unlocked, due_date, teacher_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [quarter_id || null, topic_id, assessment_name, assessment_type, Number(total_items), Number(duration_minutes) || 30, timer_type || 'Global', due_date || null, req.user.user_id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/assessment/:aid', isTeacher, async (req, res) => {
    try {
        const { assessment_name, assessment_type, total_items, duration_minutes, timer_type, due_date } = req.body;
        if (!assessment_name) throw new Error('assessment_name missing');
        await db.execute(
            `UPDATE assessments SET assessment_name = ?, assessment_type = ?, total_items = ?, duration_minutes = ?, timer_type = ?, due_date = ? WHERE assessment_id = ?`,
            [assessment_name, assessment_type, Number(total_items), Number(duration_minutes) || 30, timer_type || 'Global', due_date || null, req.params.aid]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/assessment/:aid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE sr FROM student_responses sr JOIN student_scores ss ON sr.score_id = ss.score_id WHERE ss.assessment_id = ?`, [req.params.aid]);
        await db.execute(`DELETE FROM student_scores      WHERE assessment_id = ?`, [req.params.aid]);
        await db.execute(`DELETE FROM active_sessions     WHERE assessment_id = ?`, [req.params.aid]);
        await db.execute(`DELETE FROM competitive_matches WHERE assessment_id = ?`, [req.params.aid]);
        await db.execute(`DELETE FROM assessments         WHERE assessment_id = ?`, [req.params.aid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// ANNOUNCEMENTS — POST / PUT / DELETE
// ============================================================

router.post('/api/announcement', isTeacher, async (req, res) => {
    try {
        const { topic_id, class_id, title, content, is_priority } = req.body;
        if (!class_id || !title || !content) throw new Error('Missing required fields');
        await db.execute(
            `INSERT INTO announcements (class_id, teacher_id, title, content, is_priority, topic_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [class_id, req.user.user_id, title, content, is_priority ? 1 : 0, topic_id || null]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/announcement/:aid', isTeacher, async (req, res) => {
    try {
        const { title, content, is_priority } = req.body;
        if (!title || !content) throw new Error('Missing required fields');
        await db.execute(
            `UPDATE announcements SET title = ?, content = ?, is_priority = ? WHERE announcement_id = ?`,
            [title, content, is_priority ? 1 : 0, req.params.aid]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/announcement/:aid', isTeacher, async (req, res) => {
    try {
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
        const [questions] = await db.execute(`
            SELECT qb.question_id, qb.question_text, qb.difficulty,
                COUNT(sr.response_id) AS total_responses,
                SUM(sr.is_correct = 1) AS correct_count,
                SUM(sr.is_correct = 0) AS wrong_count,
                AVG(sr.response_time_ms) AS avg_response_ms,
                ROUND(AVG(sr.is_correct), 4) AS correct_rate
            FROM question_bank qb
            JOIN student_responses sr ON sr.question_id = qb.question_id
            JOIN student_scores ss    ON sr.score_id    = ss.score_id
            WHERE ss.assessment_id = ?
            GROUP BY qb.question_id, qb.question_text, qb.difficulty
            ORDER BY correct_rate ASC`,
            [req.params.assessmentId]
        );
        res.json({ questions });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/live-sessions/:classId', isTeacher, async (req, res) => {
    try {
        const [sessions] = await db.execute(`
            SELECT acs.session_id, acs.player_mode, acs.current_item_index,
                acs.accumulated_score, acs.session_status, acs.start_time,
                u.first_name, u.last_name, u.profile_pic,
                a.assessment_name, a.total_items
            FROM active_sessions acs
            JOIN users u           ON acs.student_id    = u.user_id
            JOIN assessments a     ON acs.assessment_id = a.assessment_id
            JOIN class_students cs ON u.user_id         = cs.student_id
            WHERE cs.class_id = ? AND acs.session_status = 'Ongoing'
            ORDER BY acs.start_time ASC`,
            [req.params.classId]
        );
        res.json({ sessions });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    try {
        await db.query(`
            INSERT INTO calendar_events 
            (teacher_id, subject_id, event_title, event_description, event_type, 
             event_date, duration_type, start_date, end_date, duration_minutes, is_repeatable, repeat_cycle) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [teacherId, subject_id, event_title, event_description, event_type, event_date, duration_type,
             start_date || null, end_date || null, duration_minutes || null,
             is_repeatable === 'on' ? 1 : 0, is_repeatable === 'on' ? repeat_cycle : null]
        );
        res.redirect('/teacher/dashboard');
    } catch (err) {
        console.error("❌ Error adding event:", err);
        res.status(500).send("Failed to save event.");
    }
});

router.post('/api/calendar-event', isTeacher, async (req, res) => {
    try {
        const { subject_id, event_title, event_type, event_date, duration_type,
                start_date, end_date, duration_minutes, event_location, event_description,
                is_repeatable, repeat_cycle } = req.body;
        if (!event_title) throw new Error('event_title missing');
        if (!event_date)  throw new Error('event_date missing');
        await db.execute(
            `INSERT INTO calendar_events (subject_id, teacher_id, event_title, event_type, event_date, duration_type, start_date, end_date, duration_minutes, event_location, event_description, is_repeatable, repeat_cycle)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [subject_id, req.user.user_id, event_title, event_type || 'Material', event_date,
             duration_type || 'None', start_date || null, end_date || null, duration_minutes || null,
             event_location || 'TBA', event_description || null, is_repeatable ? 1 : 0, repeat_cycle || 'None']
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/calendar-event/:eid', isTeacher, async (req, res) => {
    try {
        const { event_title, event_type, event_date, duration_type, start_date, end_date,
                duration_minutes, event_location, event_description, is_repeatable, repeat_cycle } = req.body;
        if (!event_title) throw new Error('event_title missing');
        await db.execute(
            `UPDATE calendar_events SET event_title=?, event_type=?, event_date=?, duration_type=?,
             start_date=?, end_date=?, duration_minutes=?, event_location=?, event_description=?,
             is_repeatable=?, repeat_cycle=? WHERE event_id=?`,
            [event_title, event_type, event_date, duration_type || 'None', start_date || null,
             end_date || null, duration_minutes || null, event_location || 'TBA',
             event_description || null, is_repeatable ? 1 : 0, repeat_cycle || 'None', req.params.eid]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/calendar-event/:eid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM calendar_events WHERE event_id = ?`, [req.params.eid]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// MESSAGES
// ============================================================

router.get('/api/forum-replies/:forumId', isTeacher, async (req, res) => {
    try {
        const [replies] = await db.execute(`
            SELECT fr.*, u.first_name, u.last_name, u.profile_pic
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.created_at ASC`, [req.params.forumId]);
        res.json({ replies });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/messages/:studentId', isTeacher, async (req, res) => {
    try {
        const teacherId = req.user.user_id;
        const studentId = req.params.studentId;
        const [messages] = await db.execute(`
            SELECT * FROM private_messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY sent_at ASC LIMIT 100`,
            [teacherId, studentId, studentId, teacherId]);
        res.json({ messages });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/messages', isTeacher, async (req, res) => {
    try {
        const { receiver_id, message_text } = req.body;
        if (!receiver_id)          throw new Error('receiver_id missing');
        if (!message_text?.trim()) throw new Error('Empty message');
        await db.execute(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text) VALUES (?, ?, ?)`,
            [req.user.user_id, receiver_id, message_text.trim()]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


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

        const [schoolYears] = await db.execute(
            `SELECT sy_id, sy_range, is_active
             FROM school_years
             ORDER BY sy_id DESC`
        );

        const [classes] = await db.execute(`
            SELECT
                c.class_id,
                c.class_name,
                c.subject_id,
                c.sy_id,
                sy.sy_range,
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
                sy.sy_range, sy.is_active,
                s.subject_name, s.subject_code, s.subject_image,
                s.semester, s.enrollment_code
            ORDER BY sy.is_active DESC, sy.sy_id DESC, c.class_name ASC`,
            [teacherId]
        );

        console.log(`[DEBUG] ${classes.length} classes found for teacher ${teacherId}`);

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/class_list', {
            user:        req.user,
            classes:     classes     || [],
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

        const classId   = req.params.classId;
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
                COALESCE((
                    SELECT SUM(ss2.exp_gained)
                    FROM student_scores ss2
                    JOIN assessments a2  ON ss2.assessment_id = a2.assessment_id
                    JOIN topics t2       ON a2.topic_id       = t2.topic_id
                    JOIN quarters qt2    ON t2.quarter_id     = qt2.quarter_id
                    WHERE ss2.student_id = u.user_id
                      AND qt2.subject_id = ?
                ), 0) AS total_exp,
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
            [subjectId, classId, subjectId]
        );

        // Leaderboard history per student (last 5 snapshots each)
        const studentIds = students.map(s => s.user_id);
        let lbRows = [];
        if (studentIds.length) {
            const placeholders = studentIds.map(() => '?').join(',');
            const [lbData] = await db.execute(
                `SELECT lh.student_id, lh.rank_achieved,
                        lh.total_exp_snapshot, lh.awarded_date
                 FROM leaderboard_history lh
                 WHERE lh.student_id IN (${placeholders})
                   AND lh.subject_id = ?
                 ORDER BY lh.awarded_date DESC`,
                [...studentIds, subjectId]
            );
            lbRows = lbData;
        }

        // Assessment scores per student for this subject
        let scoreRows = [];
        if (studentIds.length) {
            const placeholders = studentIds.map(() => '?').join(',');
            const [scData] = await db.execute(
                `SELECT
                     ss.student_id,
                     ss.score_obtained,
                     ss.total_items,
                     ss.exp_gained,
                     ss.date_recorded,
                     a.assessment_name,
                     a.assessment_type
                 FROM student_scores ss
                 JOIN assessments a  ON ss.assessment_id = a.assessment_id
                 JOIN topics t       ON a.topic_id       = t.topic_id
                 JOIN quarters qt    ON t.quarter_id     = qt.quarter_id
                 WHERE ss.student_id IN (${placeholders})
                   AND qt.subject_id = ?
                 ORDER BY ss.date_recorded DESC`,
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
const UPLOADS_DIR = path.join(__dirname,'..','profile_pics');
 
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
                parseInt(seq.subscript)  || 1,
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
// GET /teacher/api/question/:qid/answer-sequence
// Fetch existing sequences for a question (used by modal edit loader)
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/question/:qid/answer-sequence', isTeacher, async (req, res) => {
    try {
        const [sequences] = await db.execute(
            `SELECT element_symbol, subscript, sort_order
             FROM answer_sequences
             WHERE question_id = ?
             ORDER BY sort_order ASC`,
            [req.params.qid]
        );
        res.json({ sequences });
    } catch (e) {
        console.error('[ERROR] GET /api/question/answer-sequence:', e.message);
        res.status(500).json({ error: e.message });
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/question-bank
// ════════════════════════════════════════════════════════════════════════════
router.get('/question-bank', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const [questions] = await db.execute(`
            SELECT
                qb.question_id,
                qb.topic_id,
                qb.question_text,
                qb.instruction_override,
                qb.difficulty,
                qb.input_mode,
                qb.mechanic_type,
                qb.base_exp,
                qb.time_limit,
                qb.points,
                qb.numeric_tolerance,
                qb.media_path,
                qb.media_type,
                qb.is_multiple_answer,
                qb.required_answers_count,
                qb.option_a,
                qb.option_b,
                qb.option_c,
                qb.option_d,
                qb.correct_answer,
                IFNULL(qb.is_ai_generated, 0)               AS is_ai_generated,
                IFNULL(qb.verification_status, 'Pending')   AS verification_status,
                qb.rejection_reason,
                qb.verified_at,
                CONCAT(vu.first_name, ' ', vu.last_name)    AS verified_by_name,
                t.topic_name
            FROM question_bank qb
            LEFT JOIN topics t  ON qb.topic_id   = t.topic_id
            LEFT JOIN users  vu ON qb.verified_by = vu.user_id
            WHERE qb.teacher_id = ?
            ORDER BY qb.question_id DESC`,
            [teacherId]
        );
 
        // Fetch answer_sequences for all Periodic_Sequence questions in one query
        const periodicQids = questions
            .filter(q => q.input_mode === 'Periodic_Sequence')
            .map(q => q.question_id);
 
        if (periodicQids.length) {
            const placeholders = periodicQids.map(() => '?').join(',');
            const [seqRows] = await db.execute(
                `SELECT question_id, element_symbol, subscript, sort_order
                 FROM answer_sequences
                 WHERE question_id IN (${placeholders})
                 ORDER BY question_id ASC, sort_order ASC`,
                periodicQids
            );
            const seqMap = {};
            seqRows.forEach(row => {
                if (!seqMap[row.question_id]) seqMap[row.question_id] = [];
                seqMap[row.question_id].push(row);
            });
            questions.forEach(q => { q.answer_sequences = seqMap[q.question_id] || []; });
        } else {
            questions.forEach(q => { q.answer_sequences = []; });
        }
 
        // Quarters + topics (nested, for dropdowns)
        const [quartersRaw] = await db.execute(`
            SELECT qt.quarter_id, qt.quarter_number, qt.subject_id,
                   t.topic_id,   t.topic_name
            FROM quarters qt
            JOIN classes c ON qt.subject_id = c.subject_id
            LEFT JOIN topics t ON t.quarter_id = qt.quarter_id
            WHERE c.teacher_id = ?
            ORDER BY qt.quarter_number ASC, t.topic_id ASC`,
            [teacherId]
        );
 
        const quartersMap = {};
        quartersRaw.forEach(row => {
            if (!quartersMap[row.quarter_id]) {
                quartersMap[row.quarter_id] = {
                    quarter_id:     row.quarter_id,
                    quarter_number: row.quarter_number,
                    subject_id:     row.subject_id,
                    topics: []
                };
            }
            if (row.topic_id) {
                const already = quartersMap[row.quarter_id].topics.find(t => t.topic_id === row.topic_id);
                if (!already) {
                    quartersMap[row.quarter_id].topics.push({
                        topic_id:   row.topic_id,
                        topic_name: row.topic_name
                    });
                }
            }
        });
        const quarters = Object.values(quartersMap);
 
        const [materials] = await db.execute(`
            SELECT lm.material_id, lm.title, lm.material_type,
                   lm.file_path_or_url, t.topic_name
            FROM learning_materials lm
            JOIN topics t    ON lm.topic_id   = t.topic_id
            JOIN quarters qt ON t.quarter_id  = qt.quarter_id
            JOIN classes c   ON qt.subject_id = c.subject_id
            WHERE c.teacher_id = ?
            ORDER BY lm.title ASC`,
            [teacherId]
        );
 
        const [assessments] = await db.execute(`
            SELECT a.assessment_id, a.assessment_name, a.assessment_type
            FROM assessments a
            WHERE a.teacher_id = ?
            ORDER BY a.assessment_name ASC`,
            [teacherId]
        );
 
        const totalQuestions = questions.length;
        const aiGenCount     = questions.filter(q => q.is_ai_generated == 1).length;
        const topicCount     = new Set(questions.map(q => q.topic_id)).size;
        const mechanicCount  = new Set(questions.map(q => q.mechanic_type)).size;
 
        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/question_bank', {
            questions,
            quarters,
            assessments,
            materials,
            totalQuestions,
            aiGenCount,
            topicCount,
            mechanicCount,
            user: req.user,
            currentPage: 'question-bank',
            notifications,
        });
 
    } catch (err) {
        console.error('[ERROR] GET /teacher/question-bank:', err);
        res.status(500).send('Internal Server Error');
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/question — CREATE
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/question', isTeacher, async (req, res) => {
    try {
        const {
            topic_id, question_text, instruction_override,
            difficulty, input_mode, mechanic_type,
            option_a, option_b, option_c, option_d, correct_answer,
            is_multiple_answer, base_exp, time_limit,
            answer_sequences
        } = req.body;
 
        if (!topic_id)      throw new Error('topic_id is required');
        if (!question_text) throw new Error('question_text is required');
        if (!difficulty)    throw new Error('difficulty is required');
        if (!mechanic_type) throw new Error('mechanic_type is required');
        if (!input_mode)    throw new Error('input_mode is required');
 
        const reqCount = (input_mode === 'Periodic_Sequence' && Array.isArray(answer_sequences))
            ? answer_sequences.filter(s => s.element_symbol).length
            : 1;
 
        const { points, numeric_tolerance, media_path, media_type } = req.body;
        const [result] = await db.execute(`
            INSERT INTO question_bank
                (topic_id, teacher_id, question_text, instruction_override,
                 difficulty, input_mode, mechanic_type, base_exp, time_limit,
                 points, numeric_tolerance, media_path, media_type,
                 is_multiple_answer, required_answers_count,
                 option_a, option_b, option_c, option_d, correct_answer,
                 is_ai_generated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
            [
                topic_id, req.user.user_id, question_text,
                instruction_override || null, difficulty, input_mode,
                mechanic_type,
                parseInt(base_exp)    || 100,
                parseInt(time_limit)  || 30,
                parseInt(points)      || 1,
                parseFloat(numeric_tolerance) || 0,
                media_path || null,
                media_type || null,
                is_multiple_answer ? 1 : 0,
                reqCount,
                option_a || null, option_b || null,
                option_c || null, option_d || null,
                correct_answer ? String(correct_answer).slice(0, 10) : null
            ]
        );
 
        const newQid = result.insertId;
 
        if (input_mode === 'Periodic_Sequence') {
            await syncAnswerSequences(db, newQid, answer_sequences || []);
        }
 
        res.json({ success: true, question_id: newQid });
    } catch (e) {
        console.error('[ERROR] POST /api/question:', e.message);
        res.status(500).json({ error: e.message });
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/question/:qid — UPDATE FULL
// ════════════════════════════════════════════════════════════════════════════
router.put('/api/question/:qid', isTeacher, async (req, res) => {
    try {
        const {
            topic_id, question_text, instruction_override,
            difficulty, input_mode, mechanic_type,
            option_a, option_b, option_c, option_d, correct_answer,
            is_multiple_answer, base_exp, time_limit,
            answer_sequences
        } = req.body;
 
        if (!question_text) throw new Error('question_text is required');
        if (!difficulty)    throw new Error('difficulty is required');
        if (!mechanic_type) throw new Error('mechanic_type is required');
        if (!input_mode)    throw new Error('input_mode is required');
 
        const { points, numeric_tolerance, media_path, media_type } = req.body;
        await db.execute(`
            UPDATE question_bank
            SET topic_id             = ?,
                question_text        = ?,
                instruction_override = ?,
                difficulty           = ?,
                input_mode           = ?,
                mechanic_type        = ?,
                base_exp             = ?,
                time_limit           = ?,
                points               = ?,
                numeric_tolerance    = ?,
                media_path           = ?,
                media_type           = ?,
                is_multiple_answer   = ?,
                option_a             = ?,
                option_b             = ?,
                option_c             = ?,
                option_d             = ?,
                correct_answer       = ?
            WHERE question_id = ? AND teacher_id = ?`,
            [
                topic_id || null, question_text,
                instruction_override || null, difficulty,
                input_mode, mechanic_type,
                parseInt(base_exp)    || 100,
                parseInt(time_limit)  || 30,
                parseInt(points)      || 1,
                parseFloat(numeric_tolerance) || 0,
                media_path || null,
                media_type || null,
                is_multiple_answer ? 1 : 0,
                option_a || null, option_b || null,
                option_c || null, option_d || null,
                correct_answer ? String(correct_answer).slice(0, 10) : null,
                req.params.qid, req.user.user_id
            ]
        );
 
        if (input_mode === 'Periodic_Sequence') {
            await syncAnswerSequences(db, req.params.qid, answer_sequences || []);
        } else {
            // Clean up ghost sequences if input_mode changed away from Periodic_Sequence
            await db.execute(
                `DELETE FROM answer_sequences WHERE question_id = ?`,
                [req.params.qid]
            );
        }
 
        res.json({ success: true });
    } catch (e) {
        console.error('[ERROR] PUT /api/question:', e.message);
        res.status(500).json({ error: e.message });
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/question/:qid/arcade — ARCADE SETTINGS ONLY
// ════════════════════════════════════════════════════════════════════════════
router.patch('/api/question/:qid/arcade', isTeacher, async (req, res) => {
    try {
        const { base_exp, time_limit, mechanic_type, input_mode, is_multiple_answer } = req.body;
        await db.execute(`
            UPDATE question_bank
            SET base_exp           = ?,
                time_limit         = ?,
                mechanic_type      = ?,
                input_mode         = ?,
                is_multiple_answer = ?
            WHERE question_id = ? AND teacher_id = ?`,
            [
                parseInt(base_exp)   || 100,
                parseInt(time_limit) || 30,
                mechanic_type  || 'standard_mcq',
                input_mode     || 'Standard',
                is_multiple_answer ? 1 : 0,
                req.params.qid, req.user.user_id
            ]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('[ERROR] PATCH /api/question/arcade:', e.message);
        res.status(500).json({ error: e.message });
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// DELETE /teacher/api/question/:qid — SINGLE DELETE
// ════════════════════════════════════════════════════════════════════════════
router.delete('/api/question/:qid', isTeacher, async (req, res) => {
    try {
        await db.execute(`DELETE FROM answer_sequences  WHERE question_id = ?`, [req.params.qid]);
        await db.execute(`DELETE FROM student_responses WHERE question_id = ?`, [req.params.qid]);
        await db.execute(
            `DELETE FROM question_bank WHERE question_id = ? AND teacher_id = ?`,
            [req.params.qid, req.user.user_id]
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
        await db.execute(`DELETE FROM answer_sequences  WHERE question_id IN (${placeholders})`, ids);
        await db.execute(`DELETE FROM student_responses WHERE question_id IN (${placeholders})`, ids);
        await db.execute(
            `DELETE FROM question_bank WHERE question_id IN (${placeholders}) AND teacher_id = ?`,
            [...ids, req.user.user_id]
        );
        res.json({ success: true, deleted: ids.length });
    } catch (e) {
        console.error('[ERROR] POST /api/questions/bulk-delete:', e.message);
        res.status(500).json({ error: e.message });
    }
});
 
 
// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/questions/bulk-approve — clear AI flag (mark as reviewed)
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/questions/bulk-approve', isTeacher, async (req, res) => {
    try {
        const ids = req.body.ids;
        if (!ids || !ids.length) throw new Error('No ids provided');
 
        const placeholders = ids.map(() => '?').join(',');
        await db.execute(
            `UPDATE question_bank SET is_ai_generated = 0
             WHERE question_id IN (${placeholders}) AND teacher_id = ?`,
            [...ids, req.user.user_id]
        );
        res.json({ success: true, approved: ids.length });
    } catch (e) {
        console.error('[ERROR] POST /api/questions/bulk-approve:', e.message);
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
 
        await db.execute(
            `UPDATE question_bank SET topic_id = ? WHERE question_id = ? AND teacher_id = ?`,
            [asmtRows[0].topic_id, req.params.qid, req.user.user_id]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('[ERROR] POST /api/question/link-assessment:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PATCH /teacher/api/question/:qid/cancel-submission
// Resets verification_status from 'Pending' back to a cancelled state (re-use Rejected label)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/api/question/:qid/cancel-submission', isTeacher, async (req, res) => {
    try {
        await db.execute(
            `UPDATE question_bank SET verification_status = 'Rejected', rejection_reason = 'Cancelled by teacher.'
             WHERE question_id = ? AND teacher_id = ?`,
            [req.params.qid, req.user.user_id]
        );
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/question/:qid/revise
// Teacher submits a corrected version of a rejected question → sets status back to Pending
// ════════════════════════════════════════════════════════════════════════════
router.put('/api/question/:qid/revise', isTeacher, async (req, res) => {
    try {
        const {
            topic_id, question_text, instruction_override,
            difficulty, input_mode, mechanic_type,
            option_a, option_b, option_c, option_d, correct_answer,
            base_exp, time_limit, answer_sequences
        } = req.body;

        if (!question_text) throw new Error('question_text is required');
        if (!difficulty)    throw new Error('difficulty is required');

        await db.execute(`
            UPDATE question_bank
            SET topic_id             = ?,
                question_text        = ?,
                instruction_override = ?,
                difficulty           = ?,
                input_mode           = ?,
                mechanic_type        = ?,
                base_exp             = ?,
                time_limit           = ?,
                option_a             = ?,
                option_b             = ?,
                option_c             = ?,
                option_d             = ?,
                correct_answer       = ?,
                verification_status  = 'Pending',
                rejection_reason     = NULL,
                verified_by          = NULL,
                verified_at          = NULL
            WHERE question_id = ? AND teacher_id = ?`,
            [
                topic_id || null, question_text,
                instruction_override || null, difficulty,
                input_mode || 'Standard', mechanic_type || 'standard_mcq',
                parseInt(base_exp) || 100, parseInt(time_limit) || 30,
                option_a || null, option_b || null,
                option_c || null, option_d || null,
                correct_answer ? String(correct_answer).slice(0, 10) : null,
                req.params.qid, req.user.user_id
            ]
        );

        if (input_mode === 'Periodic_Sequence') {
            await syncAnswerSequences(db, req.params.qid, answer_sequences || []);
        } else {
            await db.execute(`DELETE FROM answer_sequences WHERE question_id = ?`, [req.params.qid]);
        }

        res.json({ success: true });
    } catch(e) {
        console.error('[ERROR] PUT /api/question/revise:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/questions/performance-gaps
// Returns all questions this teacher owns, ranked by error rate (wrong/total attempts)
// Bug fix: uses DISTINCT student_id per question to avoid duplicate counting
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/questions/performance-gaps', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const [rows] = await db.execute(`
            SELECT
                qb.question_id,
                qb.question_text,
                qb.difficulty,
                qb.mechanic_type,
                t.topic_name,
                COUNT(DISTINCT sr.response_id)                                            AS total_attempts,
                COUNT(DISTINCT CASE WHEN sr.is_correct = 0 THEN sr.response_id END)      AS wrong_count,
                COALESCE(
                    COUNT(DISTINCT CASE WHEN sr.is_correct = 0 THEN sr.response_id END)
                    / NULLIF(COUNT(DISTINCT sr.response_id), 0)
                , 0)                                                                       AS error_rate
            FROM question_bank qb
            LEFT JOIN topics t         ON qb.topic_id        = t.topic_id
            LEFT JOIN student_responses sr ON sr.question_id = qb.question_id
            LEFT JOIN student_scores ss    ON sr.score_id    = ss.score_id
            WHERE qb.teacher_id = ?
              AND qb.verification_status = 'Approved'
            GROUP BY qb.question_id, qb.question_text, qb.difficulty, qb.mechanic_type, t.topic_name
            HAVING total_attempts > 0
            ORDER BY error_rate DESC, total_attempts DESC`,
            [teacherId]
        );
        res.json({ questions: rows });
    } catch(e) {
        console.error('[ERROR] GET /api/questions/performance-gaps:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/question/:qid/student-performance
// Per-question student breakdown, grouped by class/section
// Bug fix: JOIN on DISTINCT student_id ensures a student in 2 subjects is not double-counted
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/question/:qid/student-performance', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const qid       = req.params.qid;
    try {
        // Verify question belongs to this teacher
        const [ownership] = await db.execute(
            `SELECT question_id FROM question_bank WHERE question_id = ? AND teacher_id = ?`,
            [qid, teacherId]
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
                a.assessment_name,
                a.assessment_type,
                sr.selected_option,
                sr.is_correct,
                qb.correct_answer,
                ss.date_recorded
            FROM student_responses sr
            JOIN student_scores   ss  ON sr.score_id      = ss.score_id
            JOIN users            u   ON ss.student_id    = u.user_id
            JOIN assessments      a   ON ss.assessment_id = a.assessment_id
            JOIN question_bank    qb  ON sr.question_id   = qb.question_id
            JOIN class_students   cs  ON cs.student_id    = u.user_id
            JOIN classes          c   ON cs.class_id      = c.class_id
                                     AND c.teacher_id     = ?
            WHERE sr.question_id = ?
              AND u.role = 'Student'
            GROUP BY c.class_id, u.user_id, ss.score_id, sr.response_id
            ORDER BY c.class_name ASC, u.last_name ASC, u.first_name ASC`,
            [teacherId, qid]
        );

        // Group by class
        const classMap = {};
        rows.forEach(row => {
            if (!classMap[row.class_id]) {
                classMap[row.class_id] = {
                    class_id:      row.class_id,
                    class_name:    row.class_name,
                    correct_count: 0,
                    wrong_count:   0,
                    responses:     []
                };
            }
            const cls = classMap[row.class_id];
            if (row.is_correct) cls.correct_count++; else cls.wrong_count++;
            cls.responses.push({
                user_id:         row.user_id,
                first_name:      row.first_name,
                last_name:       row.last_name,
                lrn_number:      row.lrn_number,
                assessment_name: row.assessment_name,
                assessment_type: row.assessment_type,
                selected_option: row.selected_option,
                correct_answer:  row.correct_answer,
                is_correct:      row.is_correct,
                date_recorded:   row.date_recorded
            });
        });

        res.json({ classes: Object.values(classMap) });
    } catch(e) {
        console.error('[ERROR] GET /api/question/student-performance:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/question/:qid/remediations
// ════════════════════════════════════════════════════════════════════════════
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
    } catch(e) {
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
        res.json({ success: true });
    } catch(e) {
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
    } catch(e) {
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
 
        if (!topic_id)  throw new Error('topic_id is required');
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
 
        const result   = await model.generateContent(prompt);
        const response = await result.response;
        const text     = response.text();
 
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
                finalCorrect = ['A','B','C','D'].includes(qItem.correct_answer)
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
                    input_mode    || 'Standard',
                    mechanic_type || 'standard_mcq',
                    parseInt(base_exp)   || 100,
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
        const dir = path.join(__dirname, '../files');
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
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter: (req, file, cb) => {
        // Allow common safe file types
        const allowed = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', // <--- Idagdag mo ito rito
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm',
            'application/zip',
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('File type not allowed: ' + file.mimetype));
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/forums — Render the forums page
// ════════════════════════════════════════════════════════════════════════════
router.get('/forums', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        // 1. Fetch all subjects that belong to this teacher's classes
        const [subjects] = await db.execute(`
            SELECT DISTINCT s.subject_id, s.subject_name, s.subject_code
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            WHERE c.teacher_id = ?
            ORDER BY s.subject_name ASC`,
            [teacherId]
        );

        const subjectIds = subjects.map(s => s.subject_id);
        if (!subjectIds.length) {
            const notifications = await getTeacherNotifications(db, teacherId);
            return res.render('teacher/forums', {
                user: req.user,
                allForumsData: [],
                forums: [],
                subjects: [],
                topics: [],
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

        // 3. All forum threads for this teacher with enriched metadata
        const [forums] = await db.execute(`
            SELECT
                ft.forum_id,
                ft.topic_id,
                ft.subject_id,
                ft.teacher_id,
                ft.title,
                ft.forum_content,
                ft.is_pinned,
                ft.created_at,
                u.first_name  AS teacher_first,
                u.last_name   AS teacher_last,
                u.profile_pic AS teacher_pic,
                t.topic_name,
                q.quarter_number,
                q.subject_id  AS q_subject_id,

                -- Reply count
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ft.forum_id) AS reply_count,

                -- Last activity (most recent reply or post date)
                (SELECT MAX(fr2.created_at) FROM forum_replies fr2 WHERE fr2.topic_id = ft.forum_id) AS last_reply_at,

                -- Completion count (students who marked done)
                (SELECT COUNT(*) FROM student_forum_done sfd WHERE sfd.forum_id = ft.forum_id) AS done_count,

                -- Enrolled students count (all students in classes linked to this forum's subject)
                (SELECT COUNT(DISTINCT cs.student_id)
                 FROM class_students cs
                 JOIN classes c ON cs.class_id = c.class_id
                 WHERE c.subject_id = ft.subject_id) AS enrolled_count

            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ft.teacher_id = ?
            ORDER BY ft.is_pinned DESC, ft.created_at DESC`,
            [teacherId]
        );

        // Flatten teacher_name
        forums.forEach(f => {
            f.teacher_name = `${f.teacher_first} ${f.teacher_last}`;
        });

        // 4. All enrolled students (for completion tracker in thread view)
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
              AND u.role = 'Student'
            ORDER BY u.last_name, u.first_name ASC`,
            subjectIds
        );

        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/forums', {
            user: req.user,
            allForumsData: forums,
            forums: forums,
            subjects,
            topics,
            enrolledStudents,
            notifications,
        });

    } catch (err) {
        console.error('❌ [GET /teacher/forums]', err);
        res.status(500).send('Error loading forums page.');
    }
});


// ════════════════════════════════════════════════════════════════════════════
// GET /teacher/api/forum/:forumId — Thread detail (forum + replies + completion)
// ════════════════════════════════════════════════════════════════════════════
router.get('/api/forum/:forumId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        // 1. Forum info
        const [forumRows] = await db.execute(`
            SELECT
                ft.forum_id, ft.topic_id, ft.subject_id, ft.teacher_id,
                ft.title, ft.forum_content, ft.is_pinned, ft.created_at,
                u.first_name AS teacher_first, u.last_name AS teacher_last,
                u.profile_pic AS teacher_pic,
                t.topic_name,
                q.quarter_number,
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ft.forum_id) AS reply_count,
                (SELECT MAX(fr2.created_at) FROM forum_replies fr2 WHERE fr2.topic_id = ft.forum_id) AS last_reply_at,
                (SELECT COUNT(*) FROM student_forum_done sfd WHERE sfd.forum_id = ft.forum_id) AS done_count
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ft.forum_id = ? AND ft.teacher_id = ?`,
            [forumId, teacherId]
        );

        if (!forumRows.length) return res.status(404).json({ error: 'Forum not found or access denied.' });

        const forum = forumRows[0];
        forum.teacher_name = `${forum.teacher_first} ${forum.teacher_last}`;

        // 2. All replies (flat, with author info)
        const [replies] = await db.execute(`
            SELECT
                fr.reply_id, fr.topic_id AS forum_id, fr.user_id,
                fr.parent_reply_id, fr.reply_content,
                fr.file_path, fr.file_name, fr.file_type,
                fr.external_link, fr.created_at,
                u.first_name, u.last_name, u.profile_pic,
                u.role AS author_role
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.created_at ASC`,
            [forumId]
        );

        replies.forEach(r => {
            r.author_name = `${r.first_name} ${r.last_name}`;
        });

        // 3. Students who marked as done
        const [doneStudents] = await db.execute(`
            SELECT sfd.student_id, sfd.done_at,
                   u.first_name, u.last_name, u.profile_pic
            FROM student_forum_done sfd
            JOIN users u ON sfd.student_id = u.user_id
            WHERE sfd.forum_id = ?`,
            [forumId]
        );

        // 4. All students enrolled in the forum's subject
        const [enrolledStudents] = await db.execute(`
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

        res.json({ forum, replies, done_students: doneStudents, enrolled_students: enrolledStudents });

    } catch (err) {
        console.error('❌ [GET /teacher/api/forum/:forumId]', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /teacher/api/forum — Create a new forum thread
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/forum', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    try {
        const { title, forum_content, subject_id, topic_id, is_pinned } = req.body;

        if (!title || !title.trim())      return res.status(400).json({ error: 'Title is required.' });
        if (!subject_id)                  return res.status(400).json({ error: 'subject_id is required.' });

        // Verify teacher owns a class for this subject
        const [chk] = await db.execute(
            `SELECT class_id FROM classes WHERE teacher_id = ? AND subject_id = ? LIMIT 1`,
            [teacherId, subject_id]
        );
        if (!chk.length) return res.status(403).json({ error: 'You do not teach this subject.' });

        const [result] = await db.execute(`
            INSERT INTO forum_topics (topic_id, subject_id, teacher_id, title, forum_content, is_pinned)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                topic_id   || null,
                subject_id,
                teacherId,
                title.trim().slice(0, 255),
                forum_content ? forum_content.trim() : null,
                is_pinned ? 1 : 0
            ]
        );

        // Return the newly created forum for client-side injection
        const [newForum] = await db.execute(`
            SELECT ft.*, u.first_name AS teacher_first, u.last_name AS teacher_last,
                   u.profile_pic AS teacher_pic,
                   t.topic_name, q.quarter_number
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ft.forum_id = ?`,
            [result.insertId]
        );

        if (!newForum || newForum.length === 0) {
            return res.status(500).json({ error: 'Failed to retrieve the created forum.' });
        }

        const forum = newForum[0];
        forum.teacher_name    = `${forum.teacher_first} ${forum.teacher_last}`;
        forum.reply_count     = 0;
        forum.done_count      = 0;
        forum.enrolled_count  = 0;
        forum.last_reply_at   = null;

        res.json({ success: true, forum });

    } catch (err) {
        console.error('❌ [POST /teacher/api/forum]', err);
        res.status(500).json({ error: err.message });
    }
});


// ════════════════════════════════════════════════════════════════════════════
// PUT /teacher/api/forum/:forumId — Edit forum title / content / topic
// ════════════════════════════════════════════════════════════════════════════
router.put('/api/forum/:forumId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { forumId } = req.params;
    try {
        const { title, forum_content, topic_id } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });

        const [result] = await db.execute(`
            UPDATE forum_topics
            SET title = ?, forum_content = ?, topic_id = ?
            WHERE forum_id = ? AND teacher_id = ?`,
            [
                title.trim().slice(0, 255),
                forum_content ? forum_content.trim() : null,
                topic_id || null,
                forumId,
                teacherId
            ]
        );

        if (!result.affectedRows) return res.status(404).json({ error: 'Forum not found or access denied.' });
        res.json({ success: true });

    } catch (err) {
        console.error('❌ [PUT /teacher/api/forum/:forumId]', err);
        res.status(500).json({ error: err.message });
    }
});


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
// POST /teacher/api/forum/reply — Post a reply (with optional file upload)
// ════════════════════════════════════════════════════════════════════════════
router.post('/api/forum/reply', isTeacher, forumUpload.single('reply_file'), async (req, res) => {
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

        const file       = req.file;
        const filePath   = file ? file.filename : null;
        const fileName   = file ? file.originalname : null;
        const fileType   = file ? file.mimetype : null;
        const extLink    = external_link && external_link.trim() ? external_link.trim() : null;

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
router.delete('/api/forum/reply/:replyId', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;
    const { replyId } = req.params;
    try {
        // Allow teacher to delete any reply in their own forums
        const [replyRow] = await db.execute(`
            SELECT fr.reply_id, fr.file_path, ft.teacher_id AS forum_teacher_id
            FROM forum_replies fr
            JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            WHERE fr.reply_id = ?`,
            [replyId]
        );

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
// ANALYSIS PAGE ROUTES
// Entry point: /teacher/analysis/:attemptId  (attemptId = student_scores.score_id)
// ════════════════════════════════════════════════════════════════════════════

// ── Multer for analysis material uploads ────────────────────────────────────
const analysisUploadDir = path.join(__dirname, '../material_uploads');
if (!fs.existsSync(analysisUploadDir)) fs.mkdirSync(analysisUploadDir, { recursive: true });

const analysisUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, analysisUploadDir),
        filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
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

    try {
        // 1. Fetch the attempt row + metadata
        const [attemptRows] = await db.execute(`
            SELECT
                ss.score_id, ss.student_id, ss.assessment_id,
                ss.score_obtained, ss.total_items, ss.exp_gained, ss.date_recorded,
                u.first_name, u.last_name,
                u.profile_pic AS student_pic,
                a.assessment_name, a.assessment_type, a.topic_id,
                t.topic_name,
                q.quarter_number,
                s.subject_name
            FROM student_scores ss
            JOIN users       u  ON ss.student_id    = u.user_id
            JOIN assessments a  ON ss.assessment_id = a.assessment_id
            JOIN topics      t  ON a.topic_id       = t.topic_id
            JOIN quarters    q  ON t.quarter_id     = q.quarter_id
            JOIN subjects    s  ON q.subject_id     = s.subject_id
            JOIN classes     c  ON s.subject_id     = c.subject_id
            WHERE ss.score_id = ? AND c.teacher_id = ?
            LIMIT 1`, [attemptId, teacherId]);

        if (!attemptRows.length) return res.status(404).send('Attempt not found or access denied.');
        const attempt = attemptRows[0];

        // 2. Item performance — success rate, avg time, option popularity (Feature 1)
        const [questions] = await db.execute(`
            SELECT
                qb.question_id,
                qb.question_text,
                qb.difficulty,
                qb.input_mode,
                qb.mechanic_type,
                qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                qb.correct_answer,
                COUNT(sr.response_id)                          AS total_responses,
                SUM(sr.is_correct = 1)                         AS correct_count,
                SUM(sr.is_correct = 0)                         AS wrong_count,
                AVG(sr.response_time_ms)                       AS avg_response_ms,
                SUM(sr.selected_option = 'A')                  AS pick_a,
                SUM(sr.selected_option = 'B')                  AS pick_b,
                SUM(sr.selected_option = 'C')                  AS pick_c,
                SUM(sr.selected_option = 'D')                  AS pick_d,
                rm.rem_id, rm.material_id AS rem_material_id,
                rm.advice_text AS rem_advice,
                rm.link_url    AS rem_link_url,
                rm.preview_json AS rem_preview_json,
                lm.title       AS rem_material_title
            FROM question_bank qb
            JOIN student_responses sr ON sr.question_id = qb.question_id
            JOIN student_scores    ss ON sr.score_id    = ss.score_id
            LEFT JOIN remediation_materials rm ON rm.question_id = qb.question_id
            LEFT JOIN learning_materials    lm ON lm.material_id = rm.material_id
            WHERE ss.score_id = ?
            GROUP BY
                qb.question_id, qb.question_text, qb.difficulty, qb.input_mode,
                qb.mechanic_type, qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                qb.correct_answer,
                rm.rem_id, rm.material_id, rm.advice_text, rm.link_url,
                rm.preview_json, lm.title
            ORDER BY SUM(sr.is_correct = 1) / NULLIF(COUNT(sr.response_id), 0) ASC`,
            [attemptId]);

        // 3. Student drilldown responses (Feature 4)
        const [responses] = await db.execute(`
            SELECT
                sr.response_id, sr.selected_option, sr.is_correct, sr.response_time_ms,
                qb.question_text, qb.correct_answer, qb.question_id,
                rm.rem_id, rm.material_id AS rem_material_id,
                rm.advice_text AS rem_advice,
                rm.link_url    AS rem_link_url,
                smi.interaction_type
            FROM student_responses sr
            JOIN student_scores   ss  ON sr.score_id    = ss.score_id
            JOIN question_bank    qb  ON sr.question_id = qb.question_id
            LEFT JOIN remediation_materials  rm  ON rm.question_id = qb.question_id
            LEFT JOIN student_material_interactions smi
                   ON smi.material_id = rm.material_id
                  AND smi.student_id  = ss.student_id
            WHERE sr.score_id = ?
            ORDER BY sr.response_id ASC`, [attemptId]);

        // 4. Available materials for picker (Feature 2)
        const [materials] = await db.execute(`
            SELECT material_id, title, material_type
            FROM learning_materials
            WHERE topic_id = ?
            ORDER BY title ASC`, [attempt.topic_id]);

        // 5. Automated insights (Feature 5)
        const insights = [];
        const totalQ   = questions.length;
        const failedQ  = questions.filter(q => q.total_responses > 0 && (q.correct_count / q.total_responses) < 0.5);
        const noRemQ   = questions.filter(q => !q.rem_material_id && !q.rem_advice && !q.rem_link_url);

        if (failedQ.length > 0) {
            insights.push({
                type:    'warn',
                icon:    'triangle-exclamation',
                color:   'amber',
                title:   `${failedQ.length} item(s) with high failure rate`,
                message: `Questions: ${failedQ.map((q, i) => '#' + (questions.indexOf(q) + 1)).join(', ')} — majority of students answered incorrectly. Add remediation materials for these items.`
            });
        }

        if (noRemQ.length > 0) {
            insights.push({
                type:    'warn',
                icon:    'circle-exclamation',
                color:   'amber',
                title:   `${noRemQ.length} item(s) have no remediation set`,
                message: `Use the Remediation Suite tab to assign materials or advice for unanswered knowledge gaps.`
            });
        }

        // Input mode speed insight
        const arcadeModes   = ['Periodic_Single', 'Periodic_Sequence'];
        const arcadeQ       = questions.filter(q => arcadeModes.includes(q.input_mode));
        const standardQ     = questions.filter(q => q.input_mode === 'Standard');
        if (arcadeQ.length && standardQ.length) {
            const avgArcade   = arcadeQ.reduce((s, q) => s + (Number(q.avg_response_ms) || 0), 0) / arcadeQ.length;
            const avgStandard = standardQ.reduce((s, q) => s + (Number(q.avg_response_ms) || 0), 0) / standardQ.length;
            if (avgArcade > avgStandard * 1.4) {
                insights.push({
                    type:    'info',
                    icon:    'gamepad',
                    color:   'blue',
                    title:   'Slower on Arcade / Periodic mode',
                    message: `Students averaged ${(avgArcade / 1000).toFixed(1)}s on Arcade-type items vs ${(avgStandard / 1000).toFixed(1)}s on Standard MCQ. Consider more arcade-style drills.`
                });
            }
        }

        const accuracy = attempt.total_items > 0 ? (attempt.score_obtained / attempt.total_items) * 100 : 0;
        if (accuracy >= 80) {
            insights.push({
                type:    'ok',
                icon:    'trophy',
                color:   'green',
                title:   'Strong overall performance',
                message: `This student scored ${Math.round(accuracy)}% — above the 80% mastery threshold. Keep monitoring for consistency across topics.`
            });
        }

        res.render('teacher/analysis', {
            user: req.user,
            attempt,
            questions,
            responses,
            materials,
            insights
        });

    } catch (err) {
        console.error('❌ [GET /teacher/analysis/:attemptId]', err);
        res.status(500).send('Internal Server Error');
    }
});


// ── POST /teacher/api/analysis/remediation — Save/upsert per-item intervention ──
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
            `SELECT question_id FROM question_bank WHERE topic_id = ?`, [topic_id]
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
        if (mime.includes('word'))          material_type = 'word';
        else if (mime.includes('presentation') || mime.includes('powerpoint')) material_type = 'presentation';
        else if (mime.includes('image'))    material_type = 'img';

        const filePath = req.file.filename;

        const [result] = await db.execute(`
            INSERT INTO learning_materials (topic_id, title, material_type, file_path_or_url, is_locked)
            VALUES (?, ?, ?, ?, 0)`,
            [topic_id, title || req.file.originalname, material_type, filePath]
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
            const alt   = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
            const match = html.match(regex) || html.match(alt);
            return match ? match[1] : null;
        };
        const getTitleTag = () => {
            const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            return match ? match[1].trim() : null;
        };

        res.json({
            title:       getMeta('og:title')       || getTitleTag() || url,
            description: getMeta('og:description') || getMeta('description') || '',
            thumbnail:   getMeta('og:image')        || null
        });
    } catch (err) {
        console.error('❌ [GET /teacher/api/link-preview]', err);
        res.status(500).json({ error: 'Could not fetch URL metadata.' });
    }
});


// ── GET /teacher/reports ─────────────────────────────────────────────────────
router.get('/reports', isTeacher, async (req, res) => {
    const teacherId      = req.user.user_id;
    const selectedClassId = req.query.class_id || null;
 
    try {
        // Fetch teacher's classes for the filter dropdown
        const [classes] = await db.execute(`
            SELECT c.class_id, c.class_name, c.subject_id, s.subject_name
            FROM classes c
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE c.teacher_id = ?
            ORDER BY c.class_name ASC`, [teacherId]);
 
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
            [remRows],
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
 
            // Stats summary
            db.execute(`
                SELECT
                    (SELECT COUNT(DISTINCT cs.student_id)
                     FROM class_students cs
                     JOIN classes c ON cs.class_id = c.class_id
                     WHERE c.teacher_id = ?
                     ${selectedClassId ? 'AND c.class_id = ?' : ''}) AS totalStudents,
                    (SELECT COUNT(*)
                     FROM student_scores ss
                     JOIN assessments a ON ss.assessment_id = a.assessment_id
                     JOIN topics t ON a.topic_id = t.topic_id
                     JOIN quarters q ON t.quarter_id = q.quarter_id
                     JOIN classes c ON q.subject_id = c.subject_id
                     WHERE c.teacher_id = ?
                     ${selectedClassId ? 'AND c.class_id = ?' : ''}) AS totalAttempts,
                    (SELECT AVG((ss2.score_obtained / a2.total_items) * 100)
                     FROM student_scores ss2
                     JOIN assessments a2 ON ss2.assessment_id = a2.assessment_id
                     JOIN topics t2 ON a2.topic_id = t2.topic_id
                     JOIN quarters q2 ON t2.quarter_id = q2.quarter_id
                     JOIN classes c2 ON q2.subject_id = c2.subject_id
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
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    COALESCE(u.total_exp, 0) AS total_exp
                FROM users u
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND u.role = 'Student'
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ORDER BY u.last_name, u.first_name`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Remediation list (students + topics with wrong answers)
            db.execute(`
                SELECT
                    u.first_name, u.last_name,
                    t.topic_name,
                    COUNT(sr.response_id) AS wrong_count
                FROM student_responses sr
                JOIN student_scores ss ON sr.score_id = ss.score_id
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND sr.is_correct = 0
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, t.topic_id
                ORDER BY wrong_count DESC
                LIMIT 100`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
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
 
            // Score distribution buckets
            db.execute(`
                SELECT
                    CASE
                        WHEN ROUND((ss.score_obtained / a.total_items) * 100) BETWEEN 90 AND 100 THEN '90-100'
                        WHEN ROUND((ss.score_obtained / a.total_items) * 100) BETWEEN 75 AND 89  THEN '75-89'
                        WHEN ROUND((ss.score_obtained / a.total_items) * 100) BETWEEN 60 AND 74  THEN '60-74'
                        WHEN ROUND((ss.score_obtained / a.total_items) * 100) BETWEEN 40 AND 59  THEN '40-59'
                        ELSE '0-39'
                    END AS label,
                    COUNT(*) AS count
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY label
                ORDER BY FIELD(label,'90-100','75-89','60-74','40-59','0-39')`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Win/loss (top winners)
            db.execute(`
                SELECT u.user_id, u.first_name, u.last_name,
                       COUNT(cm.match_id) AS wins
                FROM competitive_matches cm
                JOIN users u ON cm.winner_id = u.user_id
                JOIN assessments a ON cm.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, u.first_name, u.last_name
                ORDER BY wins DESC
                LIMIT 10`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // EXP growth (leaderboard_history over time)
            db.execute(`
                SELECT
                    u.first_name, u.last_name, u.user_id,
                    DATE_FORMAT(lh.awarded_date, '%Y-%m-%d') AS snap_date,
                    lh.total_exp_snapshot
                FROM leaderboard_history lh
                JOIN users u ON lh.student_id = u.user_id
                JOIN subjects s ON lh.subject_id = s.subject_id
                JOIN classes c ON c.subject_id = s.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                ORDER BY lh.awarded_date ASC
                LIMIT 500`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Item analysis (failure rate per question)
            db.execute(`
                SELECT
                    qb.question_id, qb.question_text, qb.difficulty,
                    t.topic_name,
                    COUNT(sr.response_id) AS total,
                    SUM(sr.is_correct = 0) AS wrong
                FROM question_bank qb
                JOIN student_responses sr ON sr.question_id = qb.question_id
                JOIN student_scores ss ON sr.score_id = ss.score_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY qb.question_id, qb.question_text, qb.difficulty, t.topic_name
                HAVING COUNT(sr.response_id) > 0
                ORDER BY (SUM(sr.is_correct = 0) / COUNT(sr.response_id)) DESC
                LIMIT 50`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Arcade utilization aggregate
            db.execute(`
                SELECT
                    SUM(1) AS total,
                    SUM(player_mode = 'Single') AS single_mode,
                    SUM(player_mode = 'Duel') AS duel_mode
                FROM active_sessions acs
                JOIN users u ON acs.student_id = u.user_id
                JOIN class_students cs ON u.user_id = cs.student_id
                JOIN classes c ON cs.class_id = c.class_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Arcade utilization per student
            db.execute(`
                SELECT
                    u.user_id, u.first_name, u.last_name,
                    SUM(acs.player_mode = 'Single') AS single_sessions,
                    SUM(acs.player_mode = 'Duel')   AS duel_sessions,
                    COUNT(acs.session_id) AS total_sessions
                FROM active_sessions acs
                JOIN users u ON acs.student_id = u.user_id
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
                    ROUND(AVG(sr.is_correct) * 100) AS accuracy
                FROM student_responses sr
                JOIN student_scores ss ON sr.score_id = ss.score_id
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY u.user_id, t.topic_id
                ORDER BY u.last_name, u.first_name`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
 
            // Sequence error analysis
            db.execute(`
                SELECT
                    qb.question_id, qb.question_text,
                    t.topic_name,
                    ans.element_symbol, ans.subscript, ans.sort_order,
                    COUNT(sr.response_id) AS total_count,
                    SUM(sr.is_correct = 0) AS wrong_count,
                    ROUND((SUM(sr.is_correct = 0) / COUNT(sr.response_id)) * 100) AS error_pct
                FROM answer_sequences ans
                JOIN question_bank qb ON ans.question_id = qb.question_id
                JOIN student_responses sr ON sr.question_id = qb.question_id
                JOIN student_scores ss ON sr.score_id = ss.score_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ?
                  AND qb.input_mode IN ('Periodic_Sequence','Periodic_Single')
                ${selectedClassId ? 'AND c.class_id = ?' : ''}
                GROUP BY qb.question_id, qb.question_text, t.topic_name, ans.element_symbol, ans.subscript, ans.sort_order
                HAVING total_count > 0
                ORDER BY qb.question_id, error_pct DESC
                LIMIT 200`,
                selectedClassId ? [teacherId, selectedClassId] : [teacherId]
            ),
        ]);
 
        // ── Post-process stats ────────────────────────────────────────────
        const stats = {
            totalStudents: statsRows[0]?.totalStudents || 0,
            totalAttempts: statsRows[0]?.totalAttempts || 0,
            avgAccuracy:   Math.round(statsRows[0]?.avgAccuracy || 0),
            avgCompletion: Math.round(statsRows[0]?.avgCompletion || 0),
        };
 
        // ── Post-process EXP Growth into Chart.js datasets ───────────────
        const expGrowth = { labels: [], datasets: [] };
        if (lbHistoryRows.length) {
            const dateSet   = [...new Set(lbHistoryRows.map(r => r.snap_date))].sort();
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
            const topicIds  = heatmapTopicRows.map(t => t.topic_id);
            const studentIds = [...new Set(heatmapScoreRows.map(r => r.user_id))];
            const scoreMap   = {};
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
                    topic_name:    r.topic_name,
                    total_wrong:   0,
                    elements:      [],
                };
            }
            seqMap[r.question_id].total_wrong += Number(r.wrong_count);
            seqMap[r.question_id].elements.push({
                element_symbol: r.element_symbol,
                subscript:      r.subscript,
                sort_order:     r.sort_order,
                total_count:    Number(r.total_count),
                wrong_count:    Number(r.wrong_count),
                error_pct:      Number(r.error_pct),
            });
        });
        const seqErrors = Object.values(seqMap)
            .filter(q => q.total_wrong > 0)
            .sort((a, b) => b.total_wrong - a.total_wrong)
            .slice(0, 20);
 
        // ── Post-process Arcade Stats ─────────────────────────────────────
        const arcadeStats = {
            total:  Number(arcadeRows[0]?.total  || 0),
            single: Number(arcadeRows[0]?.single_mode || 0),
            duel:   Number(arcadeRows[0]?.duel_mode   || 0),
        };
 
        const notifications = await getTeacherNotifications(db, teacherId);
        res.render('teacher/reports', {
            user:            req.user,
            classes,
            selectedClassId: selectedClassId || '',
            stats,
            students:        studentRows,
            remediationList: remRows,
            completionRates: completionRateRows,
            scoreDistribution,
            winLoss:         winLossRows,
            expGrowth,
            itemAnalysis:    itemAnalysisRows,
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
 
// ── A. Class List — PDF ──────────────────────────────────────────────────────
router.get('/reports/export/class-list/pdf', isTeacher, async (req, res) => {
    const teacherId       = req.user.user_id;
    const selectedClassId = req.query.class_id    || null;
    const filterQuarter   = req.query.quarter     || null;   // 1/2/3/4
    const filterStrand    = req.query.strand      || null;
    const filterSection   = req.query.section     || null;
    const filterGrade     = req.query.grade_level || null;
    const filterSex = req.query.sex || null;

    try {
        let whereClauses = ['c.teacher_id = ?', "u.role = 'Student'"];
        let params       = [teacherId];

        if (selectedClassId) { whereClauses.push('c.class_id = ?');     params.push(selectedClassId); }
        if (filterStrand)    { whereClauses.push('u.strand = ?');        params.push(filterStrand); }
        if (filterSection)   { whereClauses.push('u.section = ?');       params.push(filterSection); }
        if (filterGrade)     { whereClauses.push('u.grade_level = ?');   params.push(filterGrade); }
        if (req.query.sex)   { whereClauses.push('u.sex = ?');           params.push(req.query.sex); }

        const [students] = await db.execute(`
            SELECT u.lrn_number, u.first_name, u.middle_name, u.last_name,
                   u.sex, u.strand, u.section, u.grade_level,
                   c.class_name, s.subject_name
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY c.class_name, u.last_name, u.first_name`, params
        );

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="class-list.pdf"');
        doc.pipe(res);

        // Active filters summary
        const filterParts = [];
        if (selectedClassId) filterParts.push(`Class ID: ${selectedClassId}`);
        if (filterStrand)    filterParts.push(`Strand: ${filterStrand}`);
        if (filterSection)   filterParts.push(`Section: ${filterSection}`);
        if (filterGrade)     filterParts.push(`Grade: ${filterGrade}`);
        const filterLabel = filterParts.length ? filterParts.join('  •  ') : 'All Classes';

        drawPdfHeader(doc, 'CLASS LIST REPORT', filterLabel, `${req.user.first_name} ${req.user.last_name}`);

        // ── Table header ─────────────────────────────────────
        const cols = { num: 40, lrn: 58, name: 140, sex: 292, strand: 318, section: 418, grade: 486 };
        const tableTop = doc.y;

        doc.rect(40, tableTop, 515, 16).fill('#312E81');
        doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
        doc.text('#',       cols.num,  tableTop + 4, { width: 16 });
        doc.text('LRN',     cols.lrn,  tableTop + 4, { width: 80 });
        doc.text('Full Name',cols.name, tableTop + 4, { width: 148 });
        doc.text('Sex',     cols.sex,  tableTop + 4, { width: 24 });
        doc.text('Strand',  cols.strand,tableTop + 4, { width: 96 });
        doc.text('Section', cols.section,tableTop+4, { width: 64 });
        doc.text('Grade',   cols.grade, tableTop + 4, { width: 50 });
        doc.y = tableTop + 18;

        // ── Table rows ────────────────────────────────────────
        doc.font('Helvetica').fontSize(7.5);
        students.forEach((s, i) => {
            if (doc.y > 790) {
                doc.addPage();
                drawPdfHeader(doc, 'CLASS LIST REPORT', filterLabel, `${req.user.first_name} ${req.user.last_name}`);
                // Re-draw table header on new page
                const nt = doc.y;
                doc.rect(40, nt, 515, 16).fill('#312E81');
                doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                doc.text('#',       cols.num,  nt + 4, { width: 16 });
                doc.text('LRN',     cols.lrn,  nt + 4, { width: 80 });
                doc.text('Full Name',cols.name, nt + 4, { width: 148 });
                doc.text('Sex',     cols.sex,  nt + 4, { width: 24 });
                doc.text('Strand',  cols.strand,nt + 4, { width: 96 });
                doc.text('Section', cols.section,nt+4, { width: 64 });
                doc.text('Grade',   cols.grade, nt + 4, { width: 50 });
                doc.y = nt + 18;
                doc.font('Helvetica').fontSize(7.5);
            }
            const y  = doc.y;
            const bg = i % 2 === 0 ? '#f8fafc' : '#ffffff';
            doc.rect(40, y, 515, 14).fill(bg);
            const fullName = `${s.last_name}, ${s.first_name}${s.middle_name ? ' ' + s.middle_name[0] + '.' : ''}`;
            doc.fillColor('#1e293b');
            doc.text(String(i + 1),        cols.num,    y + 2, { width: 16 });
            doc.text(s.lrn_number || '—',  cols.lrn,    y + 2, { width: 80 });
            doc.text(fullName,             cols.name,   y + 2, { width: 148 });
            doc.text(s.sex || '—',         cols.sex,    y + 2, { width: 24 });
            doc.text(s.strand || '—',      cols.strand, y + 2, { width: 96 });
            doc.text(s.section || '—',     cols.section,y + 2, { width: 64 });
            doc.text(s.grade_level || '—', cols.grade,  y + 2, { width: 50 });
            doc.y = y + 14;
        });

        doc.moveDown(0.8);
        pdfDivider(doc);
        doc.fontSize(8).fillColor('#64748b')
           .text(`Total Students: ${students.length}`, 40, doc.y, { align: 'right', width: 515 });

        addPageNumbers(doc);
        doc.end();

    } catch (err) {
        console.error('❌ [GET /reports/export/class-list/pdf]', err);
        res.status(500).send('PDF generation failed.');
    }
});
 
 
// ── A. Class List — Excel ────────────────────────────────────────────────────
router.get('/reports/export/class-list/excel', isTeacher, async (req, res) => {
    const teacherId       = req.user.user_id;
    const selectedClassId = req.query.class_id    || null;
    const filterStrand    = req.query.strand      || null;
    const filterSection   = req.query.section     || null;
    const filterGrade     = req.query.grade_level || null;

    try {
        let whereClauses = ['c.teacher_id = ?', "u.role = 'Student'"];
        let params       = [teacherId];

        if (selectedClassId) { whereClauses.push('c.class_id = ?');     params.push(selectedClassId); }
        if (filterStrand)    { whereClauses.push('u.strand = ?');        params.push(filterStrand); }
        if (filterSection)   { whereClauses.push('u.section = ?');       params.push(filterSection); }
        if (filterGrade)     { whereClauses.push('u.grade_level = ?');   params.push(filterGrade); }

        const [students] = await db.execute(`
            SELECT u.lrn_number, u.first_name, u.middle_name, u.last_name,
                   u.sex, u.strand, u.section, u.grade_level, c.class_name, s.subject_name
            FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY c.class_name, u.last_name, u.first_name`, params
        );

        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = `${req.user.first_name} ${req.user.last_name}`;
        wb.created = new Date();
        const ws = wb.addWorksheet('Class List');

        // Title rows
        ws.mergeCells('A1:J1');
        ws.getCell('A1').value = 'MABINI COLLEGE — Elementa Chemistry Arcade LMS';
        ws.getCell('A1').font  = { bold: true, size: 13, color: { argb: 'FF312E81' } };
        ws.getCell('A1').alignment = { horizontal: 'center' };

        ws.mergeCells('A2:J2');
        ws.getCell('A2').value = `Class List Report — Generated ${new Date().toLocaleDateString('en-PH')}   |   Teacher: ${req.user.first_name} ${req.user.last_name}`;
        ws.getCell('A2').font  = { size: 10, color: { argb: 'FF64748b' } };
        ws.getCell('A2').alignment = { horizontal: 'center' };

        // Active filter row
        const filterParts = [];
        if (selectedClassId) filterParts.push(`Class filter applied`);
        if (filterStrand)    filterParts.push(`Strand: ${filterStrand}`);
        if (filterSection)   filterParts.push(`Section: ${filterSection}`);
        if (filterGrade)     filterParts.push(`Grade Level: ${filterGrade}`);
        ws.mergeCells('A3:J3');
        ws.getCell('A3').value = filterParts.length ? `Filters: ${filterParts.join(' | ')}` : 'Filters: None (All classes)';
        ws.getCell('A3').font  = { italic: true, size: 9, color: { argb: 'FF0369a1' } };
        ws.getCell('A3').alignment = { horizontal: 'center' };

        ws.addRow([]);

        // Header row
        const headerRow = ws.addRow(['#', 'LRN Number', 'Last Name', 'First Name', 'Middle Name', 'Sex', 'Grade Level', 'Strand', 'Section', 'Class / Subject']);
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF312E81' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border    = { bottom: { style: 'thin', color: { argb: 'FF06b6d4' } } };
        });

        // Data rows
        students.forEach((s, i) => {
            const row = ws.addRow([
                i + 1, s.lrn_number || '', s.last_name, s.first_name,
                s.middle_name || '', s.sex || '', s.grade_level || '',
                s.strand || '', s.section || '', `${s.class_name} — ${s.subject_name}`,
            ]);
            if (i % 2 === 0) {
                row.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F9FF' } };
                });
            }
        });

        // Summary row
        ws.addRow([]);
        const sumRow = ws.addRow(['', '', '', '', '', '', '', '', 'Total Students:', students.length]);
        sumRow.getCell(9).font = { bold: true, color: { argb: 'FF312E81' } };
        sumRow.getCell(10).font = { bold: true, color: { argb: 'FF312E81' } };

        ws.columns = [
            { width: 5 }, { width: 16 }, { width: 18 }, { width: 18 },
            { width: 16 }, { width: 8 }, { width: 12 }, { width: 22 },
            { width: 14 }, { width: 30 },
        ];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="class-list.xlsx"');
        await wb.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('❌ [GET /reports/export/class-list/excel]', err);
        res.status(500).send('Excel generation failed.');
    }
});
 
 
// ── B. Student Progress Report Card — Individual PDF ─────────────────────────
router.get('/reports/export/report-card/:studentId', isTeacher, async (req, res) => {
    const teacherId       = req.user.user_id;
    const studentId       = req.params.studentId;
    const selectedClassId = req.query.class_id      || null;
    const filterQuarter   = req.query.quarter        || null;   // '1','2','3','4'
    const filterType      = req.query.type           || null;   // Pre-Test/Post-Test/Quiz/Competitive

    try {
        const [access] = await db.execute(`
            SELECT u.user_id FROM users u
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            WHERE c.teacher_id = ? AND u.user_id = ? LIMIT 1`,
            [teacherId, studentId]
        );
        if (!access.length) return res.status(403).send('Access denied.');

        // Build score query with optional filters
        let scoreClauses = ['ss.student_id = ?'];
        let scoreParams  = [studentId];
        if (filterQuarter) { scoreClauses.push('q.quarter_number = ?'); scoreParams.push(filterQuarter); }
        if (filterType)    { scoreClauses.push('a.assessment_type = ?'); scoreParams.push(filterType); }
        if (selectedClassId) {
            scoreClauses.push('q.subject_id IN (SELECT subject_id FROM classes WHERE class_id = ?)');
            scoreParams.push(selectedClassId);
        }

        const [[studentRows], [scoreRows], [progressRows]] = await Promise.all([
            db.execute(`SELECT * FROM users WHERE user_id = ?`, [studentId]),
            db.execute(`
                SELECT ss.score_obtained, ss.total_items, ss.exp_gained, ss.date_recorded,
                       a.assessment_name, a.assessment_type,
                       t.topic_name, q.quarter_number
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id
                JOIN quarters q ON t.quarter_id = q.quarter_id
                WHERE ${scoreClauses.join(' AND ')}
                ORDER BY q.quarter_number ASC, ss.date_recorded DESC`, scoreParams),
            db.execute(`
                SELECT sp.progress_percent, sp.last_accessed, s.subject_name
                FROM student_progress sp
                JOIN subjects s ON sp.subject_id = s.subject_id
                WHERE sp.student_id = ?`, [studentId]),
        ]);

        const student = studentRows[0];
        if (!student) return res.status(404).send('Student not found.');

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="report-card-${student.last_name}.pdf"`);
        doc.pipe(res);

        // Active filter summary
        const filterParts = [];
        if (filterQuarter) filterParts.push(`Quarter ${filterQuarter}`);
        if (filterType)    filterParts.push(`Type: ${filterType}`);
        const filterLabel = filterParts.length ? filterParts.join('  •  ') : 'All Quarters & Types';

        drawPdfHeader(doc, 'STUDENT PROGRESS REPORT CARD', filterLabel, `${req.user.first_name} ${req.user.last_name}`);

        // ── Student info block ────────────────────────────────
        const infoY = doc.y;
        doc.rect(40, infoY, 515, 52).fill('#f0f9ff').stroke('#bae6fd');
        doc.fillColor('#0c4a6e').fontSize(13).font('Helvetica-Bold')
           .text(`${student.last_name}, ${student.first_name}${student.middle_name ? ' ' + student.middle_name : ''}`,
                 52, infoY + 8, { width: 490 });
        doc.fontSize(8).font('Helvetica').fillColor('#475569');
        doc.text(`LRN: ${student.lrn_number || '—'}   |   Grade: ${student.grade_level || '—'}   |   Section: ${student.section || '—'}   |   Strand: ${student.strand || '—'}`,
                 52, infoY + 26);
        doc.text(`Level: ${student.current_level || 1}   |   Email: ${student.email || '—'}`,
                 52, infoY + 38);
        doc.y = infoY + 60;
        doc.moveDown(0.4);

        // ── Subject Progress ──────────────────────────────────
        if (progressRows.length) {
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#312E81').text('Subject Progress', 40);
            doc.moveDown(0.3);
            progressRows.forEach(p => {
                const pct = p.progress_percent || 0;
                const barColor = pct >= 75 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
                doc.fontSize(8).font('Helvetica').fillColor('#1e293b')
                   .text(`${p.subject_name}`, 52, doc.y);
                const barY  = doc.y - 1;
                const barX  = 200;
                const barW  = 260;
                doc.rect(barX, barY, barW, 9).fill('#e2e8f0');
                doc.rect(barX, barY, barW * (pct / 100), 9).fill(barColor);
                doc.fillColor('#1e293b').text(`${pct}%`, barX + barW + 8, barY);
                doc.moveDown(0.5);
            });
            doc.moveDown(0.3);
            pdfDivider(doc);
        }

        // ── Assessment Scores table ───────────────────────────
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#312E81').text('Assessment Scores', 40);
        doc.moveDown(0.4);

        const sc = { q: 40, topic: 62, name: 185, type: 330, score: 400, pct: 450, exp: 508 };
        const hY = doc.y;
        doc.rect(40, hY, 515, 15).fill('#1e293b');
        doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
        doc.text('Q',          sc.q,    hY + 4, { width: 20 });
        doc.text('Topic',      sc.topic, hY + 4, { width: 120 });
        doc.text('Assessment', sc.name,  hY + 4, { width: 142 });
        doc.text('Type',       sc.type,  hY + 4, { width: 66 });
        doc.text('Score',      sc.score, hY + 4, { width: 46 });
        doc.text('%',          sc.pct,   hY + 4, { width: 46 });
        doc.text('EXP',        sc.exp,   hY + 4, { width: 46 });
        doc.y = hY + 17;

        doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b');
        let totalExp = 0;
        scoreRows.forEach((s, i) => {
            if (doc.y > 790) {
                doc.addPage();
                drawPdfHeader(doc, 'STUDENT PROGRESS REPORT CARD', filterLabel, `${req.user.first_name} ${req.user.last_name}`);
                const nt = doc.y;
                doc.rect(40, nt, 515, 15).fill('#1e293b');
                doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
                doc.text('Q', sc.q, nt+4, {width:20}); doc.text('Topic', sc.topic, nt+4, {width:120});
                doc.text('Assessment', sc.name, nt+4, {width:142}); doc.text('Type', sc.type, nt+4, {width:66});
                doc.text('Score', sc.score, nt+4, {width:46}); doc.text('%', sc.pct, nt+4, {width:46});
                doc.text('EXP', sc.exp, nt+4, {width:46});
                doc.y = nt + 17; doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b');
            }
            const y   = doc.y;
            const pct = s.total_items > 0 ? Math.round((s.score_obtained / s.total_items) * 100) : 0;
            const pctColor = pct >= 80 ? '#059669' : pct >= 60 ? '#d97706' : '#dc2626';
            doc.rect(40, y, 515, 13).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
            doc.fillColor('#1e293b');
            doc.text(`Q${s.quarter_number}`, sc.q,    y + 2, { width: 20 });
            doc.text(s.topic_name,           sc.topic, y + 2, { width: 120 });
            doc.text(s.assessment_name,      sc.name,  y + 2, { width: 142 });
            doc.text(s.assessment_type,      sc.type,  y + 2, { width: 66 });
            doc.text(`${s.score_obtained}/${s.total_items}`, sc.score, y + 2, { width: 46 });
            doc.fillColor(pctColor).text(`${pct}%`, sc.pct, y + 2, { width: 46 });
            doc.fillColor('#059669').text(`+${s.exp_gained}`, sc.exp, y + 2, { width: 46 });
            doc.y = y + 13;
            totalExp += (s.exp_gained || 0);
        });

        if (!scoreRows.length) {
            doc.fontSize(8.5).fillColor('#94a3b8').font('Helvetica')
               .text('No assessment records found for the selected filters.', 40, doc.y + 8, { align: 'center', width: 515 });
            doc.moveDown();
        }

        doc.moveDown(0.6);
        pdfDivider(doc);
        doc.fontSize(8).fillColor('#64748b')
           .text(`Total Assessments: ${scoreRows.length}   |   Total EXP Earned: ${totalExp}`,
                 40, doc.y, { align: 'right', width: 515 });

        addPageNumbers(doc);
        doc.end();

    } catch (err) {
        console.error('❌ [GET /reports/export/report-card/:studentId]', err);
        res.status(500).send('PDF generation failed.');
    }
});
 
 
// ── C. Remediation List — PDF ────────────────────────────────────────────────
router.get('/reports/export/remediation/pdf', isTeacher, async (req, res) => {
    const teacherId       = req.user.user_id;
    const selectedClassId = req.query.class_id  || null;
    const filterQuarter   = req.query.quarter   || null;
    const filterRisk      = req.query.risk       || null;   // 'high'/'moderate'/'low'
    const filterTopic     = req.query.topic_id   || null;

    try {
        let whereClauses = ['c.teacher_id = ?', 'sr.is_correct = 0'];
        let params       = [teacherId];

        if (selectedClassId) { whereClauses.push('c.class_id = ?');       params.push(selectedClassId); }
        if (filterQuarter)   { whereClauses.push('q.quarter_number = ?'); params.push(filterQuarter); }
        if (filterTopic)     { whereClauses.push('t.topic_id = ?');        params.push(filterTopic); }

        const [rows] = await db.execute(`
            SELECT
                u.first_name, u.last_name, u.lrn_number,
                t.topic_name, q.quarter_number,
                COUNT(sr.response_id) AS wrong_count,
                GROUP_CONCAT(DISTINCT qb.question_text ORDER BY qb.question_id SEPARATOR ' | ') AS questions
            FROM student_responses sr
            JOIN student_scores ss ON sr.score_id = ss.score_id
            JOIN users u ON ss.student_id = u.user_id
            JOIN question_bank qb ON sr.question_id = qb.question_id
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN classes c ON q.subject_id = c.subject_id
            WHERE ${whereClauses.join(' AND ')}
            GROUP BY u.user_id, t.topic_id
            ORDER BY u.last_name, wrong_count DESC`, params
        );

        // Apply risk filter in JS (after aggregation)
        const filtered = filterRisk ? rows.filter(r => {
            if (filterRisk === 'high')     return r.wrong_count >= 5;
            if (filterRisk === 'moderate') return r.wrong_count >= 3 && r.wrong_count < 5;
            if (filterRisk === 'low')      return r.wrong_count < 3;
            return true;
        }) : rows;

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="remediation-list.pdf"');
        doc.pipe(res);

        const filterParts = [];
        if (selectedClassId) filterParts.push(`Class filter applied`);
        if (filterQuarter)   filterParts.push(`Quarter ${filterQuarter}`);
        if (filterRisk)      filterParts.push(`Risk: ${filterRisk.charAt(0).toUpperCase() + filterRisk.slice(1)}`);
        if (filterTopic)     filterParts.push(`Topic filter applied`);
        const filterLabel = filterParts.length ? filterParts.join('  •  ') : 'All Students & Topics';

        drawPdfHeader(doc, 'REMEDIATION LIST REPORT', filterLabel, `${req.user.first_name} ${req.user.last_name}`);

        // ── Table header ─────────────────────────────────────
        const cols = { name: 40, lrn: 188, q: 288, topic: 308, wrong: 420, flag: 456 };
        const hY   = doc.y;
        doc.rect(40, hY, 515, 15).fill('#312E81');
        doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
        doc.text('Student',    cols.name,  hY + 4, { width: 145 });
        doc.text('LRN',        cols.lrn,   hY + 4, { width: 95 });
        doc.text('Q',          cols.q,     hY + 4, { width: 18 });
        doc.text('Topic',      cols.topic, hY + 4, { width: 108 });
        doc.text('Wrong',      cols.wrong, hY + 4, { width: 32 });
        doc.text('Risk Flag',  cols.flag,  hY + 4, { width: 68 });
        doc.y = hY + 17;

        doc.font('Helvetica').fontSize(7.5);
        filtered.forEach((r, i) => {
            if (doc.y > 790) {
                doc.addPage();
                drawPdfHeader(doc, 'REMEDIATION LIST REPORT', filterLabel, `${req.user.first_name} ${req.user.last_name}`);
                const nt = doc.y;
                doc.rect(40, nt, 515, 15).fill('#312E81');
                doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                doc.text('Student', cols.name,nt+4,{width:145}); doc.text('LRN',cols.lrn,nt+4,{width:95});
                doc.text('Q',cols.q,nt+4,{width:18}); doc.text('Topic',cols.topic,nt+4,{width:108});
                doc.text('Wrong',cols.wrong,nt+4,{width:32}); doc.text('Risk Flag',cols.flag,nt+4,{width:68});
                doc.y = nt + 17; doc.font('Helvetica').fontSize(7.5);
            }
            const y    = doc.y;
            const flag = r.wrong_count >= 5 ? 'HIGH RISK' : r.wrong_count >= 3 ? 'Moderate' : 'Low';
            const flagColor = r.wrong_count >= 5 ? '#b91c1c' : r.wrong_count >= 3 ? '#a16207' : '#15803d';
            const flagBg    = r.wrong_count >= 5 ? '#fee2e2' : r.wrong_count >= 3 ? '#fef9c3' : '#dcfce7';
            const rowBg     = i % 2 === 0 ? '#faf5ff' : '#ffffff';
            doc.rect(40, y, 515, 14).fill(rowBg);
            doc.fillColor('#1e293b');
            doc.text(`${r.last_name}, ${r.first_name}`, cols.name,  y + 2, { width: 145 });
            doc.text(r.lrn_number || '—',               cols.lrn,   y + 2, { width: 95 });
            doc.text(`Q${r.quarter_number}`,             cols.q,     y + 2, { width: 18 });
            doc.text(r.topic_name,                       cols.topic, y + 2, { width: 108 });
            doc.fillColor('#b91c1c').text(String(r.wrong_count), cols.wrong, y + 2, { width: 32 });
            // Flag badge
            doc.rect(cols.flag, y + 1, 66, 12).fill(flagBg);
            doc.fillColor(flagColor).text(flag, cols.flag + 2, y + 3, { width: 62 });
            doc.y = y + 14;
        });

        doc.moveDown(0.8);
        pdfDivider(doc);
        const highRisk = filtered.filter(r => r.wrong_count >= 5).length;
        doc.fontSize(8).fillColor('#64748b')
           .text(`Total Entries: ${filtered.length}   |   High Risk: ${highRisk}   |   Generated from ${rows.length} total records`,
                 40, doc.y, { align: 'right', width: 515 });

        addPageNumbers(doc);
        doc.end();

    } catch (err) {
        console.error('❌ [GET /reports/export/remediation/pdf]', err);
        res.status(500).send('PDF generation failed.');
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
        const ext  = path.extname(file.originalname).toLowerCase();
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
    storage   : questionMediaStorage,
    fileFilter: questionMediaFilter,
    limits    : { fileSize: 50 * 1024 * 1024 }
});

// ── Multer: choice images A/B/C/D (image only, 5MB) ─────────
const choiceImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/choice_images');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
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
    storage   : choiceImageStorage,
    fileFilter: choiceImageFilter,
    limits    : { fileSize: 5 * 1024 * 1024 }
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
            'SELECT topic_id, topic_name, theme_id FROM topics WHERE topic_id = ?',
            [topic_id]
        );
        if (!topic) return res.status(404).send('Topic not found.');

        const [[quarter]] = await db.execute(
            'SELECT quarter_id, quarter_number FROM quarters WHERE quarter_id = ?',
            [quarter_id]
        );
        if (!quarter) return res.status(404).send('Quarter not found.');

        const pageData = {
            assessment: {
                assessment_id   : null,
                topic_id        : parseInt(topic_id),
                quarter_id      : parseInt(quarter_id),
                assessment_name : '',
                assessment_type : 'Quiz',
                total_items     : 1,
                duration_minutes: 30,
                timer_type      : 'Global',
                is_unlocked     : 0,
                due_date        : null,
                teacher_id      : req.user.user_id   // ← Passport: req.user
            },
            topic,
            quarter,
            questions: []
        };

        res.render('teacher/game_configuration', { pageData, user: req.user });

    } catch (err) {
        console.error('[GET /assessment/create]', err);
        res.status(500).send('Server error loading configuration page.');
    }
});


// ============================================================
// GET /teacher/assessment/:assessment_id/configure
// Edit existing assessment — loads all questions + sequences
// ============================================================
router.get('/assessment/:assessment_id/configure', isTeacher, async (req, res) => {
    try {
        const { assessment_id } = req.params;
        const teacher_id = req.user.user_id;   // ← Passport: req.user

        // Fetch assessment — must belong to this teacher
        const [[assessment]] = await db.execute(
            `SELECT * FROM assessments
             WHERE assessment_id = ? AND teacher_id = ?`,
            [assessment_id, teacher_id]
        );
        if (!assessment) return res.status(404).send('Assessment not found or access denied.');

        const [[topic]] = await db.execute(
            'SELECT topic_id, topic_name, theme_id FROM topics WHERE topic_id = ?',
            [assessment.topic_id]
        );

        const [[quarter]] = await db.execute(
            'SELECT quarter_id, quarter_number FROM quarters WHERE quarter_id = ?',
            [assessment.quarter_id]
        );

        // All questions linked to this assessment, in slide order
        const [aqRows] = await db.execute(
            `SELECT aq.aq_id, aq.question_id, aq.sort_order, aq.selected_bg_key,
                    qb.question_text, qb.instruction_override,
                    qb.media_path, qb.media_type,
                    qb.input_mode, qb.difficulty, qb.mechanic_type,
                    qb.base_exp, qb.points, qb.time_limit,
                    qb.is_multiple_answer, qb.required_answers_count,
                    qb.option_a, qb.option_a_image,
                    qb.option_b, qb.option_b_image,
                    qb.option_c, qb.option_c_image,
                    qb.option_d, qb.option_d_image,
                    qb.correct_answer,
                    qb.numeric_answer, qb.numeric_tolerance,
                    qb.is_ai_generated
             FROM assessment_questions aq
             JOIN question_bank qb ON aq.question_id = qb.question_id
             WHERE aq.assessment_id = ?
             ORDER BY aq.sort_order ASC`,
            [assessment_id]
        );

        // Fetch answer_sequences for each question
        const questions = await Promise.all(aqRows.map(async (row) => {
            const [seqRows] = await db.execute(
                `SELECT answer_id, element_symbol, subscript, sort_order
                 FROM answer_sequences
                 WHERE question_id = ?
                 ORDER BY sort_order ASC`,
                [row.question_id]
            );
            return { ...row, answer_sequences: seqRows };
        }));

        const pageData = { assessment, topic, quarter, questions };
        res.render('teacher/game_configuration', { pageData, user: req.user });

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
        const ext       = path.extname(req.file.filename).toLowerCase();
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
// Full atomic save: assessment + all questions + junctions
// Payload: { assessment, questions[], deletedQuestionIds[] }
// ============================================================
router.post('/assessment/save', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const teacher_id = req.user.user_id;   // ← Passport: req.user
        const { assessment, questions, deletedQuestionIds } = req.body;

        // ── STEP 1: Ownership check for edits ─────────────────
        if (assessment.assessment_id) {
            const [[existing]] = await conn.execute(
                'SELECT teacher_id FROM assessments WHERE assessment_id = ?',
                [assessment.assessment_id]
            );
            if (!existing) {
                await conn.rollback();
                return res.status(404).json({ success: false, error: 'Assessment not found.' });
            }
            // parseInt on both sides — DB returns int, session may give string
            if (parseInt(existing.teacher_id) !== parseInt(teacher_id)) {
                await conn.rollback();
                return res.status(403).json({ success: false, error: 'Access denied.' });
            }
        }

        // ── STEP 2: Upsert assessment ──────────────────────────
        let assessment_id = assessment.assessment_id || null;

        const assessmentFields = {
            quarter_id      : assessment.quarter_id,
            topic_id        : assessment.topic_id,
            assessment_name : assessment.assessment_name,
            assessment_type : assessment.assessment_type,
            total_items     : parseInt(assessment.total_items),
            duration_minutes: parseInt(assessment.duration_minutes) || 30,
            timer_type      : assessment.timer_type,
            is_unlocked     : assessment.is_unlocked ? 1 : 0,
            due_date        : assessment.due_date || null,
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
                    assessment.sound_bg           || '',
                    assessment.sound_correct      || '',
                    assessment.sound_wrong        || '',
                    assessment.sound_result_pass  || '',
                    assessment.sound_result_fail  || '',
                    assessment.speech_enabled     ? 1 : 0
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
                    assessment.sound_bg           || '',
                    assessment.sound_correct      || '',
                    assessment.sound_wrong        || '',
                    assessment.sound_result_pass  || '',
                    assessment.sound_result_fail  || '',
                    assessment.speech_enabled     ? 1 : 0,
                    assessment_id
                ]
            );
        }

        // ── STEP 3: Delete removed questions ──────────────────
        if (Array.isArray(deletedQuestionIds) && deletedQuestionIds.length > 0) {
            for (const qid of deletedQuestionIds) {
                // Delete in correct FK order (no CASCADE assumption)
                await conn.execute(
                    'DELETE FROM answer_sequences WHERE question_id = ?', [qid]
                );
                await conn.execute(
                    'DELETE FROM assessment_questions WHERE question_id = ?', [qid]
                );
                await conn.execute(
                    'DELETE FROM question_bank WHERE question_id = ? AND teacher_id = ?',
                    [qid, teacher_id]
                );
            }
        }

        // ── STEP 4 + 5 + 6: Upsert each question ──────────────
        const savedQuestions = [];

        for (const q of (questions || [])) {

            let question_id = q.question_id ? parseInt(q.question_id) : null;

            if (!question_id) {
                // INSERT new question
                const [qInsert] = await conn.execute(
                    `INSERT INTO question_bank
                     (topic_id, teacher_id, question_text, instruction_override,
                      media_path, media_type, input_mode, difficulty, mechanic_type,
                      base_exp, points, time_limit, is_multiple_answer,
                      required_answers_count, option_a, option_a_image,
                      option_b, option_b_image, option_c, option_c_image,
                      option_d, option_d_image, correct_answer,
                      numeric_answer, numeric_tolerance, is_ai_generated)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
                    [
                        assessment.topic_id,
                        teacher_id,
                        q.question_text   || '',
                        q.instruction_override || null,
                        q.media_path      || null,
                        q.media_type      || null,
                        q.input_mode      || 'Standard',
                        q.difficulty      || 'Easy',
                        q.mechanic_type   || 'standard_mcq',
                        parseInt(q.base_exp)  || 100,
                        parseInt(q.points)    || 1,
                        parseInt(q.time_limit)|| 10,
                        q.is_multiple_answer  ? 1 : 0,
                        parseInt(q.required_answers_count) || 1,
                        q.option_a        || null,
                        q.option_a_image  || null,
                        q.option_b        || null,
                        q.option_b_image  || null,
                        q.option_c        || null,
                        q.option_c_image  || null,
                        q.option_d        || null,
                        q.option_d_image  || null,
                        q.correct_answer  || null,
                        (q.numeric_answer !== undefined && q.numeric_answer !== '' && q.numeric_answer !== null)
                            ? parseFloat(q.numeric_answer) : null,
                        parseFloat(q.numeric_tolerance) || 0
                    ]
                );
                question_id = qInsert.insertId;

            } else {
                // UPDATE existing question
                await conn.execute(
                    `UPDATE question_bank
                     SET topic_id = ?, question_text = ?, instruction_override = ?,
                         media_path = ?, media_type = ?, input_mode = ?,
                         difficulty = ?, mechanic_type = ?, base_exp = ?, points = ?,
                         time_limit = ?, is_multiple_answer = ?, required_answers_count = ?,
                         option_a = ?, option_a_image = ?, option_b = ?, option_b_image = ?,
                         option_c = ?, option_c_image = ?, option_d = ?, option_d_image = ?,
                         correct_answer = ?, numeric_answer = ?, numeric_tolerance = ?
                     WHERE question_id = ? AND teacher_id = ?`,
                    [
                        assessment.topic_id,
                        q.question_text   || '',
                        q.instruction_override || null,
                        q.media_path      || null,
                        q.media_type      || null,
                        q.input_mode      || 'Standard',
                        q.difficulty      || 'Easy',
                        q.mechanic_type   || 'standard_mcq',
                        parseInt(q.base_exp)  || 100,
                        parseInt(q.points)    || 1,
                        parseInt(q.time_limit)|| 10,
                        q.is_multiple_answer  ? 1 : 0,
                        parseInt(q.required_answers_count) || 1,
                        q.option_a        || null,
                        q.option_a_image  || null,
                        q.option_b        || null,
                        q.option_b_image  || null,
                        q.option_c        || null,
                        q.option_c_image  || null,
                        q.option_d        || null,
                        q.option_d_image  || null,
                        q.correct_answer  || null,
                        (q.numeric_answer !== undefined && q.numeric_answer !== '' && q.numeric_answer !== null)
                            ? parseFloat(q.numeric_answer) : null,
                        parseFloat(q.numeric_tolerance) || 0,
                        question_id,
                        teacher_id
                    ]
                );
            }

            // ── STEP 5: answer_sequences ───────────────────────
            // Always wipe + re-insert for clean state
            await conn.execute(
                'DELETE FROM answer_sequences WHERE question_id = ?', [question_id]
            );

            if (['Periodic_Single', 'Periodic_Sequence'].includes(q.input_mode)) {
                if (Array.isArray(q.answer_sequences) && q.answer_sequences.length > 0) {
                    for (const seq of q.answer_sequences) {
                        if (!seq.element_symbol) continue;
                        await conn.execute(
                            `INSERT INTO answer_sequences
                             (question_id, element_symbol, subscript, sort_order)
                             VALUES (?, ?, ?, ?)`,
                            [
                                question_id,
                                String(seq.element_symbol).slice(0, 10),
                                parseInt(seq.subscript)  || 1,
                                parseInt(seq.sort_order) || 1
                            ]
                        );
                    }
                }
            }

            // ── STEP 6: assessment_questions junction ──────────
            const aq_id = q.aq_id ? parseInt(q.aq_id) : null;

            if (!aq_id) {
                const [aqInsert] = await conn.execute(
                    `INSERT INTO assessment_questions
                     (assessment_id, question_id, sort_order, selected_bg_key)
                     VALUES (?, ?, ?, ?)`,
                    [
                        assessment_id,
                        question_id,
                        parseInt(q.sort_order) || 1,
                        q.selected_bg_key || null
                    ]
                );
                savedQuestions.push({
                    original_index : parseInt(q._index),
                    aq_id          : aqInsert.insertId,
                    question_id
                });
            } else {
                await conn.execute(
                    `UPDATE assessment_questions
                     SET sort_order = ?, selected_bg_key = ?
                     WHERE aq_id = ?`,
                    [parseInt(q.sort_order) || 1, q.selected_bg_key || null, aq_id]
                );
                savedQuestions.push({
                    original_index : parseInt(q._index),
                    aq_id,
                    question_id
                });
            }
        }

        await conn.commit();

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
// PATCH /teacher/api/assessment/:aid/game-config-delete
// Full deletion of an assessment including questions and junctions
// Extends your existing DELETE /api/assessment/:aid
// Call this from your assessment list page delete button instead
// ============================================================
router.delete('/api/assessment/:aid/full', isTeacher, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const aid        = req.params.aid;
        const teacher_id = req.user.user_id;

        // Ownership check
        const [[existing]] = await conn.execute(
            'SELECT teacher_id FROM assessments WHERE assessment_id = ?', [aid]
        );
        if (!existing) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Assessment not found.' });
        }
        if (parseInt(existing.teacher_id) !== parseInt(teacher_id)) {
            await conn.rollback();
            return res.status(403).json({ success: false, error: 'Access denied.' });
        }

        // Get all question_ids linked to this assessment
        const [linkedQs] = await conn.execute(
            'SELECT question_id FROM assessment_questions WHERE assessment_id = ?', [aid]
        );
        const qids = linkedQs.map(r => r.question_id);

        // Delete game data first (FK order)
        await conn.execute('DELETE FROM student_responses sr WHERE sr.score_id IN (SELECT score_id FROM student_scores WHERE assessment_id = ?)', [aid]);
        await conn.execute('DELETE FROM student_scores      WHERE assessment_id = ?', [aid]);
        await conn.execute('DELETE FROM active_sessions     WHERE assessment_id = ?', [aid]);
        await conn.execute('DELETE FROM competitive_matches WHERE assessment_id = ?', [aid]);

        // Delete question data
        if (qids.length > 0) {
            const ph = qids.map(() => '?').join(',');
            await conn.execute(`DELETE FROM answer_sequences   WHERE question_id IN (${ph})`, qids);
            await conn.execute(`DELETE FROM student_responses  WHERE question_id IN (${ph})`, qids);
            await conn.execute(`DELETE FROM assessment_questions WHERE assessment_id = ?`, [aid]);
            await conn.execute(`DELETE FROM question_bank      WHERE question_id IN (${ph}) AND teacher_id = ?`, [...qids, teacher_id]);
        }

        // Delete the assessment itself
        await conn.execute('DELETE FROM assessments WHERE assessment_id = ?', [aid]);

        await conn.commit();
        res.json({ success: true });

    } catch (err) {
        await conn.rollback();
        console.error('[DELETE /api/assessment/:aid/full]', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        conn.release();
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
                fs.unlink(req.file.path, () => {});
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
                fs.unlink(oldPath, () => {});
            }

            res.json({ success: true, filename: req.file.filename });
        } catch (e) {
            fs.unlink(req.file.path, () => {});
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
                fs.unlink(oldPath, () => {});
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
                middle_name     || null,
                last_name,
                suffix          || null,
                mobile_number   || null,
                city_town       || null,
                home_address    || null,
                self_description|| null,
                req.user.user_id
            ]
        );
        res.redirect('/teacher/profile?updated=1');
    } catch (err) {
        console.error('[ERROR] POST /teacher/profile/update', err);
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


module.exports = router;