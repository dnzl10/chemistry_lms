const express    = require('express');
const router     = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
router.use(ensureAuthenticated);
const db         = require('../db');
const bcrypt     = require('bcrypt');
const crypto     = require('crypto');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { drawPdfLetterhead } = require('../utils/pdfLetterhead'); // adjust relative path
const { dispatchAnnouncementWebhook } = require('../utils/webhookDispatcher');
const {
    generateAuditRef,
    drawPdfDocumentHeader,
    attachPdfFooters,
    applyExcelMetadataHeader,
    setExportHttpHeaders
} = require('../utils/reportHeaderHelper');
const ExcelJS = require('exceljs');
const arcadeAnalyticsService = require('../services/arcadeAnalyticsService');
const topicScheduleService = require('../services/topicScheduleService');
const academicHelper = require('../utils/academicHelper');
const gradebookHelper = require('../utils/gradebookHelper');

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.role === 'Admin') {
        return next();
    }
    return res.redirect('/login');
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTER — Profile picture  (saved to public/profile_uploads/)
// ─────────────────────────────────────────────────────────────────────────────
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../profile_pics');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext    = path.extname(file.originalname).toLowerCase();
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
        cb(null, unique);
    }
});
const uploadProfile = multer({
    storage: profileStorage,
    limits : { fileSize: 20 * 1024 * 1024 },  // 20 MB      // 2 MB
    fileFilter: (req, file, cb) => {
        if (/jpg|jpeg|png|webp|gif/.test(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed (jpg, jpeg, png, webp, gif).'));
        }
    }
});

// MULTER — Excel bulk uploads (memory only, no disk write)
const uploadBulk = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB 
    fileFilter: (req, file, cb) => {
        if (/xlsx|xls/.test(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx or .xls files are allowed.'));
        }
    }
});

// MULTER — Announcement Attachments (PDF, Images, Word documents)
const announcementStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'announcement_uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function generateQRToken()     { return crypto.randomBytes(32).toString('hex'); }
function generateInviteToken() { return crypto.randomBytes(24).toString('hex'); }

async function logActivity(actorId, actorRole, action, description) {
    try {
        await db.query(
            `INSERT INTO activity_logs (actor_id, actor_role, action, description) VALUES (?, ?, ?, ?)`,
            [actorId, actorRole, action, description]
        );
    } catch (_) { /* non-fatal — never crash a route because of a log failure */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        const [[studentRow]]  = await db.query(`
            SELECT COUNT(DISTINCT cs.student_id) AS cnt 
            FROM class_students cs 
            JOIN classes c ON c.class_id = cs.class_id 
            WHERE c.sy_id = ?
        `, [selectedSY.sy_id]);
        const [[teacherRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Teacher'`);
        const [[adminRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Admin'`);
        const [[subjRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM subjects`);
        const [[assessRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE sy_id = ?`, [selectedSY.sy_id]);
        const [[qbRow]]       = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND sy_id = ?`, [selectedSY.sy_id]);
        const [[pendInvRow]]  = await db.query(
            `SELECT COUNT(*) AS cnt FROM account_invitations WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())`
        );

        const stats = {
            totalStudents   : studentRow ? studentRow.cnt : 0,
            totalTeachers   : teacherRow ? teacherRow.cnt : 0,
            totalAdmins     : adminRow ? adminRow.cnt : 0,
            totalSubjects   : subjRow ? subjRow.cnt : 0,
            totalAssessments: assessRow ? assessRow.cnt : 0,
            totalQuestions  : qbRow ? qbRow.cnt : 0,
            pendingInvites  : pendInvRow ? pendInvRow.cnt : 0,
        };

        const [[classCountRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM classes WHERE sy_id = ?`, [selectedSY.sy_id]);
        const [[enrollCountRow]] = await db.query(`
            SELECT COUNT(DISTINCT cs.student_id) AS cnt 
            FROM class_students cs 
            JOIN classes c ON c.class_id = cs.class_id 
            WHERE c.sy_id = ?
        `, [selectedSY.sy_id]);
        const activeSY = {
            sy_id: selectedSY.sy_id,
            sy_range: selectedSY.sy_range,
            classCount: classCountRow ? classCountRow.cnt : 0,
            enrolledCount: enrollCountRow ? enrollCountRow.cnt : 0
        };

        const [[expInvRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM account_invitations WHERE is_used = 0 AND expires_at < NOW()`);
        const [[flagRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE flagged_assessment_id IS NOT NULL`);
        const [[lockedPDRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE is_unlocked = 0 AND due_date IS NOT NULL AND due_date < NOW() AND sy_id = ?`, [selectedSY.sy_id]);
        const [[overdueRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM calendar_events WHERE event_type = 'Deadline' AND event_date < CURDATE() AND event_date >= ? AND event_date <= ?`, [selectedSY.start_date, selectedSY.end_date]);

        const alerts = {
            expiredInvites  : expInvRow ? expInvRow.cnt : 0,
            flaggedStudents : flagRow ? flagRow.cnt : 0,
            lockedPastDue   : lockedPDRow ? lockedPDRow.cnt : 0,
            overdueDeadlines: overdueRow ? overdueRow.cnt : 0,
            total           : (expInvRow ? expInvRow.cnt : 0) + (flagRow ? flagRow.cnt : 0) + (lockedPDRow ? lockedPDRow.cnt : 0) + (overdueRow ? overdueRow.cnt : 0),
        };

        const [activeSessions] = await db.query(`
            SELECT gs.session_id, gs.play_mode AS player_mode, gs.highest_level_reached AS current_item_index,
                   gs.final_score_p1 AS accumulated_score, gs.started_at AS start_time,
                   COALESCE(a.assessment_name, CONCAT('Arcade Campaign Level ', gs.highest_level_reached)) AS assessment_name,
                   10 AS total_items,
                   CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM elementa_game_sessions gs
            JOIN users u ON u.user_id = gs.student_id_p1
            LEFT JOIN assessments a ON a.assessment_id = gs.assessment_id
            WHERE gs.session_status = 'Ongoing'
            ORDER BY gs.started_at DESC
        `);

        const [chartRows] = await db.query(`
            SELECT DATE(started_at) AS day, COUNT(*) AS total
            FROM elementa_game_sessions
            WHERE started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY DATE(started_at)
            ORDER BY day ASC
        `);

        const labels = [], counts = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key   = d.toISOString().slice(0, 10);
            const label = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
            labels.push(label);
            const found = chartRows.find(r => new Date(r.day).toISOString().slice(0, 10) === key);
            counts.push(found ? found.total : 0);
        }

        const [[preTestRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions gs JOIN assessments a ON a.assessment_id = gs.assessment_id WHERE a.assessment_type = 'Pre-Test'    AND gs.started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND a.sy_id = ?`, [selectedSY.sy_id]);
        const [[postTestRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions gs JOIN assessments a ON a.assessment_id = gs.assessment_id WHERE a.assessment_type = 'Post-Test'   AND gs.started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND a.sy_id = ?`, [selectedSY.sy_id]);
        const [[quizRow]]        = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions gs JOIN assessments a ON a.assessment_id = gs.assessment_id WHERE a.assessment_type = 'Quiz'        AND gs.started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND a.sy_id = ?`, [selectedSY.sy_id]);
        const [[competitiveRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions gs WHERE gs.play_mode = 'Versus' AND gs.started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);

        const chartData = { labels, counts, preTestCount: preTestRow ? preTestRow.cnt : 0, postTestCount: postTestRow ? postTestRow.cnt : 0, quizCount: quizRow ? quizRow.cnt : 0, competitiveCount: competitiveRow ? competitiveRow.cnt : 0 };

        const [topStudents]     = await db.query(`
            SELECT u.user_id, u.first_name, u.last_name, u.profile_pic, u.current_level, u.total_exp 
            FROM users u 
            JOIN class_students cs ON cs.student_id = u.user_id
            JOIN classes c ON c.class_id = cs.class_id AND c.sy_id = ?
            WHERE u.role = 'Student' 
            GROUP BY u.user_id
            ORDER BY u.total_exp DESC 
            LIMIT 10
        `, [selectedSY.sy_id]);
        const [recentLogs]      = await db.query(`SELECT al.log_id, al.actor_role, al.action, al.description, al.created_at, CONCAT(u.first_name,' ',u.last_name) AS actor_name FROM activity_logs al LEFT JOIN users u ON u.user_id = al.actor_id ORDER BY al.created_at DESC LIMIT 15`);
        const [recentUsers]     = await db.query(`SELECT user_id, first_name, last_name, role, profile_pic, created_at FROM users ORDER BY created_at DESC LIMIT 5`);
        const [upcomingEvents]     = await db.query(`SELECT ce.event_id, ce.event_title, ce.event_type, ce.event_date, ce.event_location, ce.duration_type, ce.start_date, ce.end_date, ce.duration_minutes, s.subject_name FROM calendar_events ce LEFT JOIN subjects s ON s.subject_id = ce.subject_id WHERE ce.event_date >= CURDATE() AND ce.event_date <= ? ORDER BY ce.event_date ASC LIMIT 5`, [selectedSY.end_date]);
        const [allUpcomingEvents]  = await db.query(`SELECT ce.event_id, ce.event_title, ce.event_type, ce.event_date, ce.event_location, ce.event_description, ce.duration_type, ce.start_date, ce.end_date, ce.duration_minutes, ce.is_repeatable, ce.repeat_cycle, s.subject_name FROM calendar_events ce LEFT JOIN subjects s ON s.subject_id = ce.subject_id WHERE ce.event_date >= CURDATE() AND ce.event_date <= ? ORDER BY ce.event_date ASC`, [selectedSY.end_date]);
        const [[topicsRow]]        = await db.query(`SELECT COUNT(*) AS cnt FROM forum_topics ft LEFT JOIN classes c ON c.class_id = ft.class_id WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)`, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);
        const [[repliesRow]]       = await db.query(`SELECT COUNT(*) AS cnt FROM forum_replies fr JOIN forum_topics ft ON ft.forum_id = fr.topic_id LEFT JOIN classes c ON c.class_id = ft.class_id WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)`, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);
        const [latestReplies]      = await db.query(`SELECT fr.reply_id, fr.reply_content, fr.created_at, CONCAT(u.first_name,' ',u.last_name) AS user_name, ft.title AS forum_title FROM forum_replies fr JOIN users u ON u.user_id = fr.user_id JOIN forum_topics ft ON ft.forum_id = fr.topic_id LEFT JOIN classes c ON c.class_id = ft.class_id WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?) ORDER BY fr.created_at DESC LIMIT 3`, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);
        const forumStats           = { totalTopics: topicsRow ? topicsRow.cnt : 0, totalReplies: repliesRow ? repliesRow.cnt : 0, latestReplies };
        const [[totalMatchRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE play_mode = 'Versus'`);
        const [[todayMatchRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE play_mode = 'Versus' AND DATE(started_at) = CURDATE()`);
        const [topWinnerRows]   = await db.query(`
            SELECT u.first_name, u.last_name, COUNT(*) AS win_count
            FROM elementa_game_sessions gs
            JOIN users u ON u.user_id = (CASE WHEN gs.winner = 'P1' THEN gs.student_id_p1 WHEN gs.winner = 'P2' THEN gs.student_id_p2 ELSE NULL END)
            WHERE gs.play_mode = 'Versus' AND gs.winner IN ('P1', 'P2')
            GROUP BY u.user_id
            ORDER BY win_count DESC
            LIMIT 1
        `);
        const matchStats        = { totalMatches: totalMatchRow.cnt, todayMatches: todayMatchRow.cnt, topWinner: topWinnerRows[0] || null };

        res.render('admin/dashboard', {
            user: req.user, stats, activeSY, alerts, activeSessions,
            chartData, topStudents, recentLogs, recentUsers, upcomingEvents, allUpcomingEvents, forumStats, matchStats,
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY
        });

    } catch (err) {
        console.error('[Admin Dashboard Error]', err);
        res.status(500).send('Server error loading admin dashboard: ' + err.message);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/notifications
// Returns all admin notification data as JSON — consumed by the notification
// panel on every admin page via fetch(). Reusable across all pages.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/notifications', requireAdmin, async (req, res) => {
    try {
        // 1. Expired invitations
        const [expiredInvites] = await db.query(`
            SELECT invitation_id, email, role, expires_at
            FROM account_invitations
            WHERE is_used = 0 AND expires_at < NOW()
            ORDER BY expires_at DESC LIMIT 10
        `);

        // 2. Flagged students
        const [flaggedStudents] = await db.query(`
            SELECT u.user_id, CONCAT(u.first_name,' ',u.last_name) AS full_name,
                   u.profile_pic, a.assessment_name
            FROM users u
            LEFT JOIN assessments a ON a.assessment_id = u.flagged_assessment_id
            WHERE u.flagged_assessment_id IS NOT NULL
            ORDER BY u.user_id DESC LIMIT 10
        `);

        // 3. Assessments locked but past due date
        const [lockedPastDue] = await db.query(`
            SELECT a.assessment_id, a.assessment_name, a.due_date,
                   s.subject_name
            FROM assessments a
            JOIN topics t  ON t.topic_id   = a.topic_id
            JOIN quarters q ON q.quarter_id = t.quarter_id
            JOIN subjects s ON s.subject_id = q.subject_id
            WHERE a.is_unlocked = 0 AND a.due_date IS NOT NULL AND a.due_date < NOW()
            ORDER BY a.due_date DESC LIMIT 10
        `);

        // 4. Overdue calendar deadlines
        const [overdueDeadlines] = await db.query(`
            SELECT ce.event_id, ce.event_title, ce.event_date, s.subject_name
            FROM calendar_events ce
            LEFT JOIN subjects s ON s.subject_id = ce.subject_id
            WHERE ce.event_type = 'Deadline' AND ce.event_date < CURDATE()
            ORDER BY ce.event_date DESC LIMIT 10
        `);

        // 5. Pending (unused, not-yet-expired) invitations
        const [pendingInvites] = await db.query(`
            SELECT invitation_id, email, role, expires_at, created_at
            FROM account_invitations
            WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC LIMIT 10
        `);

        // 6. Arcade questions pending approval
        const [pendingQuestions] = await db.query(`
            SELECT eq.question_id, eq.prompt AS question_text,
                   COALESCE(s.subject_name, 'Chemistry') AS subject_name
            FROM elementa_questions eq
            LEFT JOIN topics t   ON t.topic_id   = eq.topic_id
            LEFT JOIN quarters q ON q.quarter_id = t.quarter_id
            LEFT JOIN subjects s ON s.subject_id = q.subject_id
            WHERE eq.is_active = 1 AND eq.verification_status = 'Pending'
            ORDER BY eq.question_id DESC LIMIT 10
        `);

        // 7. Active game sessions right now (Elementa Arcade Sessions)
        const [activeSessions] = await db.query(`
            SELECT s.session_id, s.play_mode AS player_mode, s.started_at AS start_time,
                   CONCAT(u.first_name,' ',u.last_name) AS student_name,
                   COALESCE(a.assessment_name, 'Arcade Session') AS assessment_name
            FROM elementa_game_sessions s
            LEFT JOIN users u ON u.user_id = s.student_id_p1
            LEFT JOIN assessments a ON a.assessment_id = s.assessment_id
            WHERE s.session_status = 'Ongoing'
            ORDER BY s.started_at DESC LIMIT 10
        `);

        // 8. New user registrations in last 24 hours
        const [newUsers] = await db.query(`
            SELECT user_id, CONCAT(first_name,' ',last_name) AS full_name,
                   role, profile_pic, created_at
            FROM users
            WHERE created_at >= NOW() - INTERVAL 24 HOUR
            ORDER BY created_at DESC LIMIT 10
        `);

        // 9. Enterprise Persistent Notifications for Admin
        const [persistentNotifs] = await db.query(`
            SELECT notification_id, title, message, target_url, priority, category, event_type, created_at, is_read
            FROM notifications
            WHERE (role = 'Admin' OR user_id = ?) AND is_dismissed = 0
            ORDER BY created_at DESC LIMIT 15
        `, [req.user ? req.user.user_id : 0]);

        const unreadPersistentCount = persistentNotifs.filter(p => !p.is_read).length;

        const total = expiredInvites.length + flaggedStudents.length +
                      lockedPastDue.length + overdueDeadlines.length +
                      pendingQuestions.length + unreadPersistentCount;

        return res.json({
            success: true,
            total,
            expiredInvites,
            flaggedStudents,
            lockedPastDue,
            overdueDeadlines,
            pendingInvites,
            pendingQuestions,
            activeSessions,
            newUsers,
            persistentNotifs,
        });

    } catch (err) {
        console.error('[Notifications Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ██╗   ██╗ █████╗  ██████╗
// ██║   ██║██╔══██╗██╔════╝
// ██║   ██║███████║██║
// ██║   ██║██╔══██║██║
// ╚██████╔╝██║  ██║╚██████╗
//  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
// USER & ACCESS CONTROL — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TRANSPORTER — Unified (Resend HTTP REST API on Port 443 + SMTP Fallback)
// ─────────────────────────────────────────────────────────────────────────────
const emailService = require('../services/emailService');
function createTransporter() {
    return emailService.createTransporter();
}
 
// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/user_access_control
// Renders the full UAC page.
// EJS expects: user, users, flaggedUsers, invitations, uacStats
// REQ#7 — invitations is filtered to is_used = 0 ONLY (no Used records sent).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user_access_control', requireAdmin, async (req, res) => {
    try {
        // ── Resolve School Year Context (Default to Current, support ?sy_id=) ──
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        // ── Confirmed users with School-Year-Scoped Enrollment ─────────────────
        const [users] = await db.query(`
            SELECT
                user_id, email,
                first_name, first_name_phonetic,
                middle_name, middle_name_phonetic,
                last_name, last_name_phonetic,
                alternative_name, suffix, role,
                sex, birthdate,
                grade_level, section, strand, department,
                lrn_number, faculty_id,
                google_id, qr_code_token,
                current_level, total_exp,
                is_ready_for_arcade, flagged_assessment_id,
                profile_pic, pic_description,
                self_description, interests,
                mobile_number, home_address, city_town,
                is_active, is_suspended,
                created_at,
                (
                    SELECT GROUP_CONCAT(DISTINCT cur_c.class_name ORDER BY cur_c.class_name SEPARATOR ', ')
                    FROM class_students cs
                    JOIN classes cur_c ON cur_c.class_id = cs.class_id
                    WHERE cs.student_id = users.user_id AND cs.sy_id = ?
                ) AS enrolled_classes_sy,
                (
                    SELECT COUNT(*)
                    FROM class_students cs
                    WHERE cs.student_id = users.user_id AND cs.sy_id = ?
                ) AS enrolled_count_sy
            FROM users
            WHERE users.role IN ('Admin', 'Teacher')
               OR (users.role = 'Student' AND users.user_id IN (
                   SELECT cs.student_id FROM class_students cs WHERE cs.sy_id = ?
               ))
            ORDER BY role ASC, last_name ASC, first_name ASC
        `, [selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id]);
 
        // ── Flagged students ──────────────────────────────────────────────────
        const [flaggedUsers] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.email,
                u.profile_pic, u.grade_level, u.section,
                u.current_level, u.total_exp,
                u.flagged_assessment_id,
                a.assessment_name
            FROM users u
            LEFT JOIN assessments a ON a.assessment_id = u.flagged_assessment_id
            WHERE u.flagged_assessment_id IS NOT NULL
              AND (
                  u.role IN ('Admin', 'Teacher')
                  OR u.user_id IN (SELECT cs.student_id FROM class_students cs WHERE cs.sy_id = ?)
              )
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [selectedSY.sy_id]);
 
        // ── REQ#7 — Only pending (unconfirmed, not-used) invitations ─────────
        const [invitations] = await db.query(`
            SELECT invitation_id, email, role, token, is_used, expires_at, created_at
            FROM account_invitations
            WHERE is_used = 0
            ORDER BY created_at DESC
        `);
 
        // ── KPI stats ─────────────────────────────────────────────────────────
        const [[sRow]] = await db.query(
            `SELECT COUNT(DISTINCT cs.student_id) AS cnt FROM class_students cs WHERE cs.sy_id = ?`,
            [selectedSY.sy_id]
        );
        const [[tRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Teacher'`);
        const [[aRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Admin'`);
        const [[pRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM account_invitations
             WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())`
        );
 
        const uacStats = {
            totalStudents   : sRow ? sRow.cnt : 0,
            enrolledStudents: sRow ? sRow.cnt : 0,
            totalTeachers   : tRow.cnt,
            totalAdmins     : aRow.cnt,
            pendingInvites  : pRow.cnt,
        };
 
        // ── Available Classes for Enrollment (Scoped to selectedSY) ───────────
        const [classesList] = await db.query(`
            SELECT 
                c.class_id,
                c.class_name,
                c.teacher_id,
                c.subject_id,
                s.subject_name,
                s.subject_code,
                s.semester,
                c.sy_id,
                sy.sy_range,
                sy.is_active AS sy_is_active,
                c.max_capacity,
                c.enrolled_count,
                COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                u.first_name AS teacher_first,
                u.last_name AS teacher_last,
                u.faculty_id AS teacher_faculty_id,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS enrolled_count_actual
            FROM classes c
            LEFT JOIN users u ON c.teacher_id = u.user_id
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE c.sy_id = ?
            ORDER BY c.class_name ASC, s.subject_name ASC
        `, [selectedSY.sy_id]);

        // ── Available Subjects for Enrollment ────────────────────────────────
        const [subjectsList] = await db.query(`
            SELECT subject_id, subject_name, subject_code
            FROM subjects
            ORDER BY subject_name ASC
        `);

        const currentSchoolYear = selectedSY;

        // ── Maps for client-side duplicate verification (LRN & Faculty ID) ───
        const [usersWithFid] = await db.query(
            `SELECT faculty_id, CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE faculty_id IS NOT NULL AND faculty_id != ''`
        );
        const existingFacultyIdsMap = {};
        usersWithFid.forEach(u => { if (u.faculty_id) existingFacultyIdsMap[u.faculty_id.trim()] = u.full_name; });

        const [pendingWithFid] = await db.query(
            `SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role IN ('Teacher', 'Admin') AND prefill_data LIKE '%facultyId%'`
        );
        const pendingFacultyIdsMap = {};
        pendingWithFid.forEach(p => {
            try {
                const parsed = JSON.parse(p.prefill_data);
                if (parsed.facultyId) pendingFacultyIdsMap[parsed.facultyId.trim()] = p.email;
            } catch (_) {}
        });

        const [usersWithLrn] = await db.query(
            `SELECT lrn_number, CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE lrn_number IS NOT NULL AND lrn_number != ''`
        );
        const existingLrnsMap = {};
        usersWithLrn.forEach(u => { if (u.lrn_number) existingLrnsMap[u.lrn_number.trim()] = u.full_name; });

        const [pendingWithLrn] = await db.query(
            `SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role = 'Student' AND prefill_data LIKE '%lrn%'`
        );
        const pendingLrnsMap = {};
        pendingWithLrn.forEach(p => {
            try {
                const parsed = JSON.parse(p.prefill_data);
                if (parsed.lrn) pendingLrnsMap[parsed.lrn.trim()] = p.email;
            } catch (_) {}
        });

        res.render('admin/user_access_control', {
            user: req.user,
            users,
            flaggedUsers,
            invitations,
            uacStats,
            classesList,
            subjectsList,
            currentSchoolYear,
            selectedSY,
            currentSY,
            activeSY: currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY,
            existingFacultyIdsMap,
            pendingFacultyIdsMap,
            existingLrnsMap,
            pendingLrnsMap
        });
 
    } catch (err) {
        console.error('[UAC GET Error]', err);
        res.status(500).send('Server error loading User & Access Control: ' + err.message);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/users/:id/toggle-status
// Toggles the is_active or is_suspended status of a user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/users/:id/toggle-status', requireAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { action } = req.body; // 'suspend', 'activate_suspension', 'deactivate', 'activate'

        const [[user]] = await db.query('SELECT first_name, last_name, is_suspended, is_active FROM users WHERE user_id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        let sql = '';
        let params = [];
        let logAction = '';
        let logDesc = '';

        if (action === 'suspend') {
            sql = 'UPDATE users SET is_suspended = 1 WHERE user_id = ?';
            params = [userId];
            logAction = 'SUSPEND';
            logDesc = `Suspended user: ${user.first_name} ${user.last_name}`;
        } else if (action === 'activate_suspension') {
            sql = 'UPDATE users SET is_suspended = 0 WHERE user_id = ?';
            params = [userId];
            logAction = 'ACTIVATE';
            logDesc = `Lifted suspension for user: ${user.first_name} ${user.last_name}`;
        } else if (action === 'deactivate') {
            sql = 'UPDATE users SET is_active = 0 WHERE user_id = ?';
            params = [userId];
            logAction = 'LOCK';
            logDesc = `Deactivated user account: ${user.first_name} ${user.last_name}`;
        } else if (action === 'activate') {
            sql = 'UPDATE users SET is_active = 1 WHERE user_id = ?';
            params = [userId];
            logAction = 'ACTIVATE';
            logDesc = `Activated user account: ${user.first_name} ${user.last_name}`;
        } else {
            return res.status(400).json({ success: false, message: 'Invalid action' });
        }

        await db.query(sql, params);
        await logActivity(req.user.user_id, 'Admin', logAction, logDesc);

        res.json({ success: true, message: logDesc });
    } catch (err) {
        console.error('[Toggle Status Error]', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE CHECK
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/uac/check-dup?type=email|lrn|faculty_id&value=...
// Real-time duplicate detection used by the invite modal onblur handlers.
// Checks BOTH the users table AND pending account_invitations.
// Returns: { exists: true|false }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/uac/check-dup', requireAdmin, async (req, res) => {
    try {
        const { type, value } = req.query;
        if (!type || !value) return res.json({ exists: false });
 
        let exists = false;
 
        if (type === 'email') {
            const cleanVal = value.trim().toLowerCase();
            // Check in confirmed users
            const [[userRow]] = await db.query(
                `SELECT user_id FROM users WHERE email = ?`, [cleanVal]
            );
            // Check in pending invitations (is_used = 0)
            const [[invRow]] = await db.query(
                `SELECT invitation_id FROM account_invitations WHERE email = ? AND is_used = 0`, [cleanVal]
            );
            exists = !!(userRow || invRow);
 
        } else if (type === 'lrn') {
            const cleanVal = value.trim();
            const [[row]] = await db.query(
                `SELECT user_id FROM users WHERE lrn_number = ?`, [cleanVal]
            );
            exists = !!row;
 
        } else if (type === 'faculty_id') {
            const cleanVal = value.trim();
            const [[row]] = await db.query(
                `SELECT user_id FROM users WHERE faculty_id = ?`, [cleanVal]
            );
            exists = !!row;
        }
 
        return res.json({ exists });
 
    } catch (err) {
        console.error('[UAC Check Dup Error]', err);
        return res.json({ exists: false });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// INVITATION — MANUAL INVITE (from modal)
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/invite
// REQ#2 — Invitation-first flow. No password. Sends email with registration link.
// The user is stored in account_invitations (NOT users table yet).
// Body (JSON): { role, email, firstName, middleName, lastName, suffix, sex,
//               birthdate, expiryHours, lrn, gradeLevel, section, strand,
//               interests, facultyId, department }
// Returns: { success: true, token } | { success: false, message, duplicate? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/invite', requireAdmin, async (req, res) => {
    try {
        const {
            role, email, firstName, middleName, lastName, suffix,
            sex, birthdate, expiryHours,
            lrn, gradeLevel, section, strand, interests,
            facultyId, department, classId, schoolYear,
            teacherSubjectId, teacherSubjectIds, teacherClassIds
        } = req.body;

        // ── Required field validation ─────────────────────────────────────────
        if (!email || !email.trim())
            return res.json({ success: false, message: 'Email address is required.' });
        if (!role || !['Admin', 'Teacher', 'Student'].includes(role))
            return res.json({ success: false, message: 'Invalid role selected.' });

        const cleanEmail = email.trim().toLowerCase();

        // REQ#6 — Duplicate checks before inserting anything
        const [[existingUser]] = await db.query(
            `SELECT user_id FROM users WHERE email = ?`, [cleanEmail]
        );
        if (existingUser)
            return res.json({ success: false, duplicate: true, message: `"${cleanEmail}" is already a registered user.` });

        const [[existingInv]] = await db.query(
            `SELECT invitation_id FROM account_invitations WHERE email = ? AND is_used = 0`,
            [cleanEmail]
        );
        if (existingInv)
            return res.json({ success: false, duplicate: true, message: `A pending invitation for "${cleanEmail}" already exists. Revoke it first to re-invite.` });

        // REQ#4 / REQ#6 — LRN uniqueness and format for Students
        if (role === 'Student' && lrn && lrn.trim()) {
            if (!/^\d{12}$/.test(lrn.trim()))
                return res.json({ success: false, message: 'LRN must be exactly 12 digits.' });
            const [[lrnEx]] = await db.query(
                `SELECT user_id FROM users WHERE lrn_number = ?`, [lrn.trim()]
            );
            if (lrnEx)
                return res.json({ success: false, duplicate: true, message: `LRN "${lrn.trim()}" is already used by another student.` });
        }

        // ── Class Enrollment, Capacity & Timeline Verification for Students ──
        let enrolledClass = null;
        if (role === 'Student') {
            if (!classId) {
                return res.json({ success: false, message: 'Please select a class / section to enroll the student into.' });
            }

            const windowCheck = await academicHelper.checkClassEnrollmentOpen(db, classId);
            if (!windowCheck.isOpen) {
                return res.json({
                    success: false,
                    message: windowCheck.message
                });
            }

            const cls = windowCheck.cls;

            // Check capacity: cannot enroll if class is already full
            if (cls.max_capacity !== null && cls.current_enrolled >= cls.max_capacity) {
                return res.json({
                    success: false,
                    message: `Class "${cls.class_name} - ${cls.subject_name || 'Subject'}" is already at full capacity (${cls.current_enrolled}/${cls.max_capacity}). Cannot enroll student.`
                });
            }

            // Prerequisite Gate: Enforce Chemistry 1 passing prerequisite for Chemistry 2
            let existingStudent = null;
            if (cleanEmail) {
                const [[u]] = await db.query(`SELECT user_id FROM users WHERE email = ? AND role = 'Student'`, [cleanEmail]);
                existingStudent = u;
            }
            if (!existingStudent && lrn) {
                const [[u]] = await db.query(`SELECT user_id FROM users WHERE lrn_number = ? AND role = 'Student'`, [lrn.trim()]);
                existingStudent = u;
            }

            const prereqCheck = await academicHelper.checkStudentPrerequisite(db, existingStudent ? existingStudent.user_id : null, cls.subject_id);
            if (!prereqCheck.eligible) {
                return res.json({
                    success: false,
                    message: `Cannot enroll student into "${cls.class_name}": ${prereqCheck.reason}`
                });
            }

            enrolledClass = cls;
        }

        // Faculty ID uniqueness & validation for Teacher/Admin
        if (role === 'Teacher') {
            if (!facultyId || !facultyId.trim()) {
                return res.json({ success: false, message: 'Faculty ID is required for teachers and must be unique.' });
            }
        }

        if ((role === 'Teacher' || role === 'Admin') && facultyId && facultyId.trim()) {
            const cleanFid = facultyId.trim();
            const [[fidEx]] = await db.query(
                `SELECT user_id FROM users WHERE faculty_id = ?`, [cleanFid]
            );
            if (fidEx)
                return res.json({ success: false, duplicate: true, message: `Faculty ID "${cleanFid}" is already in use by another account.` });

            const [pendingWithFid] = await db.query(
                `SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role IN ('Teacher', 'Admin') AND prefill_data LIKE ?`,
                [`%${cleanFid}%`]
            );
            const matchingFid = pendingWithFid.find(p => {
                try { return JSON.parse(p.prefill_data).facultyId === cleanFid; } catch (_) { return false; }
            });
            if (matchingFid)
                return res.json({ success: false, duplicate: true, message: `Faculty ID "${cleanFid}" is already reserved in a pending invitation for "${matchingFid.email}".` });
        }

        // Teacher Subjects & Classes Assignment & Conflict Replacement (Option 1)
        let assignedTeacherClasses = [];
        let assignedSubjectNames = '';
        let assignedSubjectIds = [];
        if (role === 'Teacher') {
            const normalizedClassIds = Array.isArray(teacherClassIds) 
                ? teacherClassIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
                : [];
            if (normalizedClassIds.length === 0) {
                return res.json({ success: false, message: 'Please assign at least one class / section for the teacher to handle.' });
            }

            const [clsRows] = await db.query(
                `SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id,
                        s.subject_name, s.subject_code,
                        CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name
                 FROM classes c
                 LEFT JOIN users u ON c.teacher_id = u.user_id
                 LEFT JOIN subjects s ON c.subject_id = s.subject_id
                 WHERE c.class_id IN (?)`,
                [normalizedClassIds]
            );
            assignedTeacherClasses = clsRows;

            const distinctSubjMap = {};
            assignedTeacherClasses.forEach(c => {
                if (c.subject_id && !distinctSubjMap[c.subject_id]) {
                    distinctSubjMap[c.subject_id] = c.subject_name;
                }
            });
            assignedSubjectIds = Object.keys(distinctSubjMap).map(Number);
            assignedSubjectNames = Object.values(distinctSubjMap).join(', ');

            // Free assigned sections so the previous teacher is replaced
            for (const cls of assignedTeacherClasses) {
                if (cls.teacher_id) {
                    await logActivity(req.user.user_id, 'Admin', 'REPLACE_CLASS_TEACHER',
                        `Replaced existing teacher "${cls.teacher_name}" (User ID: ${cls.teacher_id}) on course "${cls.subject_name}" - section "${cls.class_name}" with pending invite for "${cleanEmail}"`);
                    await db.query('UPDATE classes SET teacher_id = NULL WHERE class_id = ?', [cls.class_id]);
                }
            }
        }

        // Build invitation token and expiry
        const token    = generateInviteToken();
        let expiresAt  = null;
        if (expiryHours && !isNaN(parseInt(expiryHours))) {
            expiresAt = new Date(Date.now() + parseInt(expiryHours) * 3600 * 1000);
        }

        const finalSection    = enrolledClass ? enrolledClass.class_name : (section ? section.trim() : null);
        const finalTrack      = (role === 'Student') ? 'Academic Track' : null;
        const finalClassId    = enrolledClass ? enrolledClass.class_id : null;
        const finalSubjectId  = enrolledClass ? enrolledClass.subject_id : null;
        const finalCourseName = enrolledClass ? enrolledClass.subject_name : null;
        const finalSyId       = enrolledClass ? enrolledClass.sy_id : null;

        // Build prefill_data JSON — all admin-supplied and class enrollment fields stored
        const prefillData = JSON.stringify({
            firstName   : firstName   ? firstName.trim()   : null,
            middleName  : middleName  ? middleName.trim()  : null,
            lastName    : lastName    ? lastName.trim()    : null,
            suffix      : suffix      ? suffix.trim()      : null,
            sex         : sex         ? sex.trim()         : null,
            birthdate   : birthdate   || null,
            lrn         : (role === 'Student' && lrn)        ? lrn.trim()      : null,
            gradeLevel  : (role === 'Student' && gradeLevel) ? gradeLevel      : null,
            section     : finalSection,
            strand      : finalTrack,
            classId     : finalClassId,
            subjectId   : (role === 'Teacher' && assignedSubjectIds.length > 0) ? assignedSubjectIds[0] : finalSubjectId,
            subjectIds  : (role === 'Teacher' && assignedSubjectIds.length > 0) ? assignedSubjectIds : null,
            classIds    : (role === 'Teacher' && assignedTeacherClasses.length > 0) ? assignedTeacherClasses.map(c => c.class_id) : null,
            courseName  : (role === 'Teacher' && assignedSubjectNames) ? assignedSubjectNames : finalCourseName,
            syId        : finalSyId,
            schoolYear  : schoolYear ? schoolYear.trim() : null,
            interests   : (role === 'Student' && interests)  ? interests.trim(): null,
            facultyId   : ((role === 'Teacher'||role==='Admin') && facultyId)  ? facultyId.trim()  : null,
            department  : ((role === 'Teacher'||role==='Admin') && department) ? department.trim() : null,
        });

        // Delete any old used/expired record for this email (UNIQUE constraint)
        await db.query(
            `DELETE FROM account_invitations WHERE email = ? AND role IN ('Admin', 'Teacher', 'Student')`,
            [cleanEmail]
        );

        await db.query(
            `INSERT INTO account_invitations (email, role, token, expires_at, prefill_data) VALUES (?, ?, ?, ?, ?)`,
            [cleanEmail, role, token, expiresAt, prefillData]
        );

        // ── Build registration link ───────────────────────────────────────────
        const baseUrl   = process.env.APP_URL || 'http://localhost:3000';
        const regLink   = `${baseUrl}/setup-profile?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
        const fNamePart = firstName ? firstName.trim() : '';
        const lNamePart = lastName ? lastName.trim() : '';
        const fullName  = [fNamePart, lNamePart].filter(Boolean).join(' ') || 'New User';

        // ── Build role-specific info block for email body ─────────────────────
        let roleInfoHtml = '';
        if (role === 'Student') {
            roleInfoHtml = `
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>LRN:</b></td><td style="padding:4px 8px;font-size:13px;">${lrn || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Grade:</b></td><td style="padding:4px 8px;font-size:13px;">${gradeLevel || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Class / Section:</b></td><td style="padding:4px 8px;font-size:13px;">${finalSection || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Course / Subject:</b></td><td style="padding:4px 8px;font-size:13px;">${finalCourseName || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Track:</b></td><td style="padding:4px 8px;font-size:13px;">Academic Track</td></tr>
            `;
        } else if (role === 'Teacher') {
            const sectionsBySubject = {};
            assignedTeacherClasses.forEach(c => {
                const sName = c.subject_name || 'General';
                if (!sectionsBySubject[sName]) sectionsBySubject[sName] = [];
                sectionsBySubject[sName].push(c.class_name);
            });
            const formattedTeachingLoad = Object.entries(sectionsBySubject).map(([sName, secs]) => {
                return `<b>${sName}:</b> ${secs.join(', ')}`;
            }).join('<br>');

            roleInfoHtml = `
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Faculty ID:</b></td><td style="padding:4px 8px;font-size:13px;">${facultyId || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Department:</b></td><td style="padding:4px 8px;font-size:13px;">${department || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;vertical-align:top;"><b>Assigned Teaching Load:</b></td><td style="padding:4px 8px;font-size:13px;">${formattedTeachingLoad || '—'}</td></tr>
            `;
        } else if (role === 'Admin') {
            roleInfoHtml = `
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Faculty ID:</b></td><td style="padding:4px 8px;font-size:13px;">${facultyId || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Department:</b></td><td style="padding:4px 8px;font-size:13px;">${department || '—'}</td></tr>
            `;
        }
 
        const expiryText = expiresAt
            ? `This link expires on <b>${expiresAt.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}</b>.`
            : 'This invitation link does not expire.';
 
        const mailOptions = {
            from   : `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`,
            to     : cleanEmail,
            subject: `You're invited to Chemistry Arcade LMS as a ${role}`,
            html   : `
                <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                    <div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);padding:28px 32px;">
                        <h1 style="color:white;margin:0;font-size:22px;font-weight:900;letter-spacing:-0.5px;">⚗️ Chemistry Arcade LMS</h1>
                        <p style="color:#c7d2fe;margin:6px 0 0;font-size:13px;">Secure Account Invitation</p>
                    </div>
                    <div style="padding:28px 32px;background:white;">
                        <p style="font-size:15px;color:#1e293b;">Hello <b>${fullName}</b>,</p>
                        <p style="font-size:14px;color:#475569;line-height:1.6;">
                            You have been invited to join <b>Chemistry Arcade LMS</b> as a <b style="color:#4f46e5;">${role}</b>.
                            Click the button below to complete your registration, set your password, and link your Google account.
                        </p>
                        <table style="margin:16px 0;background:#f8fafc;border-radius:10px;padding:12px 16px;border:1px solid #e2e8f0;width:100%;">
                            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Name:</b></td><td style="padding:4px 8px;font-size:13px;">${fullName}</td></tr>
                            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Role:</b></td><td style="padding:4px 8px;font-size:13px;">${role}</td></tr>
                            ${roleInfoHtml}
                        </table>
                        <div style="text-align:center;margin:28px 0;">
                            <a href="${regLink}"
                               style="background:linear-gradient(135deg,#4f46e5,#06b6d4);color:white;padding:14px 32px;
                                      text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">
                                ✉️ Complete Registration
                            </a>
                        </div>
                        <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:16px;">
                            ${expiryText}<br>
                            If you did not expect this invitation, you can safely ignore this email.
                        </p>
                    </div>
                </div>
            `,
        };
 
        let emailDelivered = true;
        let emailDeliveryErr = null;
        try {
            await createTransporter().sendMail(mailOptions);
            await logActivity(req.user.user_id, 'Admin', 'SEND_INVITATION',
                `Sent ${role} invitation to: ${cleanEmail}`);
        } catch (mailErr) {
            console.error('[UAC Invite Mail Error]', mailErr.message);
            emailDelivered = false;
            emailDeliveryErr = mailErr.message;
        }

        return res.json({
            success: true,
            token,
            regLink,
            emailSent: emailDelivered,
            warning: emailDelivered ? null : `Invitation created, but email could not be sent: ${emailDeliveryErr}. You can copy the registration link manually.`
        });
 
    } catch (err) {
        console.error('[UAC Invite Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// INVITATION — QUICK INVITE (from Invitations tab form)
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/invitations
// Generate a quick invite token for an email + role (no pre-fill data).
// Body (JSON): { email, role, expiryHours }
// Returns: { success: true, token } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/invitations', requireAdmin, async (req, res) => {
    try {
        const { email, role, expiryHours } = req.body;
 
        if (!email || !email.trim()) return res.json({ success: false, message: 'Email is required.' });
        if (!role  || !['Teacher', 'Student', 'Admin'].includes(role))
            return res.json({ success: false, message: 'Role must be Student, Teacher, or Admin.' });
 
        const cleanEmail = email.trim().toLowerCase();
 
        // Block re-invite if a valid pending token exists
        const [[activePending]] = await db.query(
            `SELECT invitation_id FROM account_invitations
             WHERE email = ? AND is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())`,
            [cleanEmail]
        );
        if (activePending)
            return res.json({
                success: false,
                message: 'A valid pending invitation already exists for this email. Revoke it first.',
            });
 
        const token   = generateInviteToken();
        let expiresAt = null;
        if (expiryHours && !isNaN(parseInt(expiryHours))) {
            expiresAt = new Date(Date.now() + parseInt(expiryHours) * 3600 * 1000);
        }
 
        // Remove any old used/expired record (UNIQUE constraint on email)
        // Only delete old real invitation records, not reset tokens
        await db.query(
            `DELETE FROM account_invitations WHERE email = ? AND role IN ('Admin', 'Teacher', 'Student')`,
            [cleanEmail]
        );
 
        await db.query(
            `INSERT INTO account_invitations (email, role, token, expires_at) VALUES (?, ?, ?, ?)`,
            [cleanEmail, role, token, expiresAt]
        );
 
        // Also send email for the quick invite
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        const regLink = `${baseUrl}/setup-profile?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
        const expiryText = expiresAt
            ? `This link expires on <b>${expiresAt.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}</b>.`
            : 'This invitation link does not expire.';
 
        const mailOptions = {
            from   : `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`,
            to     : cleanEmail,
            subject: `You're invited to Chemistry Arcade LMS as a ${role}`,
            html   : `
                <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                    <div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);padding:28px 32px;">
                        <h1 style="color:white;margin:0;font-size:22px;font-weight:900;">⚗️ Chemistry Arcade LMS</h1>
                        <p style="color:#c7d2fe;margin:6px 0 0;font-size:13px;">Secure Account Invitation</p>
                    </div>
                    <div style="padding:28px 32px;background:white;">
                        <p style="font-size:14px;color:#475569;line-height:1.6;">
                            You have been invited to join <b>Chemistry Arcade LMS</b> as a <b style="color:#4f46e5;">${role}</b>.
                            Click the button below to complete your registration and set your password.
                        </p>
                        <div style="text-align:center;margin:28px 0;">
                            <a href="${regLink}"
                               style="background:linear-gradient(135deg,#4f46e5,#06b6d4);color:white;padding:14px 32px;
                                      text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">
                                ✉️ Complete Registration
                            </a>
                        </div>
                        <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:16px;">${expiryText}</p>
                    </div>
                </div>
            `,
        };
 
        try { await createTransporter().sendMail(mailOptions); } catch (mailErr) {
            console.warn('[Quick Invite Email Error]', mailErr.message);
            // Non-fatal — token was created, admin can copy link manually
        }
 
        await logActivity(req.user.user_id, 'Admin', 'GENERATE_INVITE',
            `Generated ${role} quick invite for: ${cleanEmail}`);
 
        return res.json({ success: true, token });
 
    } catch (err) {
        console.error('[Quick Invite Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/uac/invitations/clean-expired
// Hard-delete all expired unused invitation records.
// Returns: { success: true, count: N }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/uac/invitations/clean-expired', requireAdmin, async (req, res) => {
    try {
        const [result] = await db.query(
            `DELETE FROM account_invitations
             WHERE is_used = 0 AND expires_at IS NOT NULL AND expires_at < NOW()`
        );
 
        await logActivity(req.user.user_id, 'Admin', 'CLEAN_INVITATIONS',
            `Cleaned ${result.affectedRows} expired invitation(s)`);
 
        return res.json({ success: true, count: result.affectedRows });
 
    } catch (err) {
        console.error('[Clean Invites Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/uac/invitations/:id
// Revoke (soft-mark as used) a specific pending invitation.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/uac/invitations/:id', requireAdmin, async (req, res) => {
    try {
        const invId = parseInt(req.params.id, 10);
        if (isNaN(invId)) return res.json({ success: false, message: 'Invalid invitation ID.' });
 
        const [[inv]] = await db.query(
            `SELECT email, role FROM account_invitations WHERE invitation_id = ?`, [invId]
        );
        if (!inv) return res.json({ success: false, message: 'Invitation not found.' });
 
        // Soft-revoke: mark as used so the audit trail is preserved
        await db.query(
            `UPDATE account_invitations SET is_used = 1 WHERE invitation_id = ?`, [invId]
        );
 
        await logActivity(req.user.user_id, 'Admin', 'REVOKE_INVITE',
            `Revoked ${inv.role} invitation for: ${inv.email}`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[Revoke Invite Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — EDIT (REQ#1)
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/users/:id
// Update any confirmed user's profile. Supports profile pic upload.
// Body: multipart/form-data (all user fields + optional profile_pic file)
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/users/:id', requireAdmin, uploadProfile.single('profile_pic'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        const [[existingUser]] = await db.query(
            `SELECT user_id, email, role, profile_pic, lrn_number, faculty_id FROM users WHERE user_id = ?`,
            [userId]
        );
        if (!existingUser) return res.json({ success: false, message: 'User not found.' });
 
        const {
            first_name, middle_name, last_name,
            first_name_phonetic, middle_name_phonetic, last_name_phonetic,
            alternative_name, suffix, sex, birthdate, email,
            mobile_number, city_town, home_address,
            self_description, interests, pic_description,
            // Role-specific
            lrn_number, grade_level, section, strand,
            faculty_id, department,
        } = req.body;
 
        // ── Required fields ────────────────────────────────────────────────────
        if (!first_name || !first_name.trim()) return res.json({ success: false, message: 'First name is required.' });
        if (!last_name  || !last_name.trim())  return res.json({ success: false, message: 'Last name is required.' });
        if (!email      || !email.trim())      return res.json({ success: false, message: 'Email is required.' });
 
        const cleanEmail = email.trim().toLowerCase();
        const role       = existingUser.role; // role is not changed via edit
 
        // ── REQ#4 — LRN validation for Student ────────────────────────────────
        if (role === 'Student' && lrn_number && lrn_number.trim()) {
            if (!/^\d{12}$/.test(lrn_number.trim()))
                return res.json({ success: false, message: 'LRN must be exactly 12 digits.' });
        }
 
        // ── REQ#6 — Unique email (exclude self) ───────────────────────────────
        const [[emailConflict]] = await db.query(
            `SELECT user_id FROM users WHERE email = ? AND user_id <> ?`,
            [cleanEmail, userId]
        );
        if (emailConflict)
            return res.json({ success: false, message: `Email "${cleanEmail}" is already in use by another account.` });
 
        // ── REQ#6 — Unique LRN (exclude self) ────────────────────────────────
        if (role === 'Student' && lrn_number && lrn_number.trim()) {
            const [[lrnConflict]] = await db.query(
                `SELECT user_id FROM users WHERE lrn_number = ? AND user_id <> ?`,
                [lrn_number.trim(), userId]
            );
            if (lrnConflict)
                return res.json({ success: false, message: `LRN "${lrn_number.trim()}" is already used by another student.` });
        }
 
        // ── REQ#6 — Unique Faculty ID (exclude self) ──────────────────────────
        if ((role === 'Teacher' || role === 'Admin') && faculty_id && faculty_id.trim()) {
            const [[fidConflict]] = await db.query(
                `SELECT user_id FROM users WHERE faculty_id = ? AND user_id <> ?`,
                [faculty_id.trim(), userId]
            );
            if (fidConflict)
                return res.json({ success: false, message: `Faculty ID "${faculty_id.trim()}" is already in use.` });
        }
 
        // ── Profile picture ────────────────────────────────────────────────────
        let profilePicFilename = existingUser.profile_pic;
        if (req.file) {
            // Delete old picture if it isn't the default
            if (existingUser.profile_pic && existingUser.profile_pic !== 'default_avatar.png') {
                const oldPath = path.join(__dirname, '../profile_pics', existingUser.profile_pic);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            profilePicFilename = req.file.filename;
        }
 
        await db.query(`
            UPDATE users SET
                first_name = ?, middle_name = ?, last_name = ?,
                first_name_phonetic = ?, middle_name_phonetic = ?, last_name_phonetic = ?,
                alternative_name = ?, suffix = ?,
                sex = ?, birthdate = ?,
                email = ?, mobile_number = ?,
                city_town = ?, home_address = ?,
                self_description = ?, interests = ?,
                pic_description = ?, profile_pic = ?,
                lrn_number = ?, grade_level = ?, section = ?, strand = ?,
                faculty_id = ?, department = ?
            WHERE user_id = ?
        `, [
            first_name.trim(),
            middle_name        ? middle_name.trim()        : null,
            last_name.trim(),
            first_name_phonetic ? first_name_phonetic.trim() : null,
            middle_name_phonetic ? middle_name_phonetic.trim() : null,
            last_name_phonetic  ? last_name_phonetic.trim()  : null,
            alternative_name   ? alternative_name.trim()   : null,
            suffix             ? suffix.trim()             : null,
            sex                ? sex.trim()                : null,
            birthdate          ? birthdate                 : null,
            cleanEmail,
            mobile_number      ? mobile_number.trim()      : null,
            city_town          ? city_town.trim()          : null,
            home_address       ? home_address.trim()       : null,
            self_description   ? self_description.trim()   : null,
            interests          ? interests.trim()          : null,
            pic_description    ? pic_description.trim()    : null,
            profilePicFilename,
            // Student fields
            (role === 'Student' && lrn_number && lrn_number.trim()) ? lrn_number.trim() : null,
            (role === 'Student' && grade_level) ? grade_level : null,
            (role === 'Student' && section && section.trim()) ? section.trim() : null,
            (role === 'Student' && strand  && strand.trim())  ? strand.trim()  : null,
            // Staff fields
            ((role === 'Teacher' || role === 'Admin') && faculty_id   && faculty_id.trim())   ? faculty_id.trim()  : null,
            ((role === 'Teacher' || role === 'Admin') && department    && department.trim())   ? department.trim()  : null,
            userId,
        ]);
 
        await logActivity(req.user.user_id, 'Admin', 'EDIT_USER',
            `Updated user profile: ${first_name.trim()} ${last_name.trim()} (ID: ${userId})`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Edit User Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — DELETE
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/uac/users/:id
// Permanently delete a confirmed user and all their associated data.
// Blocks self-deletion.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/uac/users/:id', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        // Prevent self-deletion
        if (userId === req.user.user_id)
            return res.json({ success: false, message: 'You cannot delete your own admin account.' });
 
        const [[target]] = await db.query(
            `SELECT user_id, first_name, last_name, role, profile_pic FROM users WHERE user_id = ?`,
            [userId]
        );
        if (!target) return res.json({ success: false, message: 'User not found.' });
 
        // ── Delete in FK-safe order ────────────────────────────────────────────
 
        // Elementa Arcade Sessions & Tickets & Questions
        try {
            await db.query(`UPDATE elementa_game_sessions SET student_id_p1 = NULL WHERE student_id_p1 = ?`, [userId]);
            await db.query(`UPDATE elementa_game_sessions SET student_id_p2 = NULL WHERE student_id_p2 = ?`, [userId]);
            await db.query(`DELETE FROM elementa_assessment_tickets WHERE student_id = ?`, [userId]);
            await db.query(`DELETE FROM elementa_leaderboard WHERE student_id = ?`, [userId]);
            await db.query(`UPDATE elementa_questions SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
        } catch (_) {}

        // Legacy scores and responses (guarded)
        try {
            const [scoreRows] = await db.query(
                `SELECT score_id FROM student_scores WHERE student_id = ?`, [userId]
            );
            const scoreIds = scoreRows.map(r => r.score_id);
            if (scoreIds.length) {
                await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
            }
            await db.query(`DELETE FROM student_scores WHERE student_id = ?`, [userId]);
            await db.query(`DELETE FROM active_sessions WHERE student_id = ?`, [userId]);
            await db.query(`DELETE FROM competitive_matches WHERE p1_id = ? OR p2_id = ? OR winner_id = ?`, [userId, userId, userId]);
            await db.query(`DELETE FROM leaderboard_history WHERE student_id = ?`, [userId]);
        } catch (_) {}
 
        // Class enrollments
        await db.query(`DELETE FROM class_students WHERE student_id = ?`, [userId]);
 
        // Student progress
        await db.query(`DELETE FROM student_progress WHERE student_id = ?`, [userId]);
 
        // Material interactions
        await db.query(`DELETE FROM student_material_interactions WHERE student_id = ?`, [userId]);
 
        // Forum replies (cascade will handle children via FK)
        await db.query(`DELETE FROM forum_replies WHERE user_id = ?`, [userId]);
 
        // Student forum done
        await db.query(`DELETE FROM student_forum_done WHERE student_id = ?`, [userId]);
 
        // Private messages
        await db.query(`DELETE FROM private_messages WHERE sender_id = ? OR receiver_id = ?`, [userId, userId]);
 
        // Announcements posted by this user
        await db.query(`DELETE FROM announcements WHERE teacher_id = ?`, [userId]);
 
        // Forum topics created by this user (forum_replies cascade via FK)
        await db.query(`UPDATE forum_topics SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
 
        // Assessments created by this teacher (SET NULL on teacher_id)
        await db.query(`UPDATE assessments SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
 
        // Question bank (SET creator to NULL or keep — questions belong to the system)
        try {
            await db.query(`UPDATE question_bank SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
        } catch (_) {}
 
        // Classes where this teacher was assigned
        await db.query(`UPDATE classes SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
 
        // Calendar events
        await db.query(`DELETE FROM calendar_events WHERE teacher_id = ?`, [userId]);
 
        // Activity logs — keep logs but anonymise actor
        await db.query(`UPDATE activity_logs SET actor_id = NULL WHERE actor_id = ?`, [userId]);
 
        // Delete profile picture file (if not default)
        if (target.profile_pic && target.profile_pic !== 'default_avatar.png') {
            const picPath = path.join(__dirname, '../profile_pics', target.profile_pic);
            if (fs.existsSync(picPath)) fs.unlinkSync(picPath);
        }
 
        // Finally delete the user row
        await db.query(`DELETE FROM users WHERE user_id = ?`, [userId]);
 
        await logActivity(req.user.user_id, 'Admin', 'DELETE_USER',
            `Permanently deleted user: ${target.first_name} ${target.last_name} (${target.role}, ID: ${userId})`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Delete User Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — RESET PASSWORD (REQ#5)
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/users/:id/reset-password
// REQ#5 — Sends a password-reset email. Admin never sees or sets the new password.
// The reset link points to /reset-password?token=...
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        const [[user]] = await db.query(
            `SELECT user_id, email, first_name, last_name, role FROM users WHERE user_id = ?`, [userId]
        );
        if (!user) return res.json({ success: false, message: 'User not found.' });
 
        // Generate a one-time reset token (stored in account_invitations reusing
        // the is_used flow — or you can use a dedicated reset_tokens table if you
        // add one later. For now we embed it in the invite table with role='Student'
        // and a short 1-hour expiry, purely as a token store.)
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt  = new Date(Date.now() + 3600 * 1000); // 1 hour
 
        // Store reset token — reuse account_invitations as a token store.
        // We mark the email with a special token and short expiry.
        // Use INSERT ... ON DUPLICATE KEY UPDATE so this is atomic — covers both:
        //   (a) a prior __RESET__ row for this email, and
        //   (b) a real pending invitation row for this email (different role),
        // both of which would cause ER_DUP_ENTRY on the email UNIQUE KEY.
        await db.query(
            `INSERT INTO account_invitations (email, role, token, expires_at, is_used)
             VALUES (?, '__RESET__', ?, ?, 0)
             ON DUPLICATE KEY UPDATE
               role       = '__RESET__',
               token      = VALUES(token),
               expires_at = VALUES(expires_at),
               is_used    = 0`,
            [user.email, resetToken, expiresAt]
        );
 
        const baseUrl   = process.env.APP_URL || 'http://localhost:3000';
        const resetLink = `${baseUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;
        const fullName  = `${user.first_name} ${user.last_name}`;
 
        const mailOptions = {
            from   : `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`,
            to     : user.email,
            subject: 'Password Reset Request — Chemistry Arcade LMS',
            html   : `
                <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                    <div style="background:linear-gradient(135deg,#10b981,#06b6d4);padding:28px 32px;">
                        <h1 style="color:white;margin:0;font-size:22px;font-weight:900;">🔑 Password Reset</h1>
                        <p style="color:#d1fae5;margin:6px 0 0;font-size:13px;">Chemistry Arcade LMS</p>
                    </div>
                    <div style="padding:28px 32px;background:white;">
                        <p style="font-size:15px;color:#1e293b;">Hello <b>${fullName}</b>,</p>
                        <p style="font-size:14px;color:#475569;line-height:1.6;">
                            An administrator has requested a password reset for your account.
                            Click the button below to set a new password. This link expires in <b>1 hour</b>.
                        </p>
                        <div style="text-align:center;margin:28px 0;">
                            <a href="${resetLink}"
                               style="background:linear-gradient(135deg,#10b981,#06b6d4);color:white;padding:14px 32px;
                                      text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">
                                🔒 Reset My Password
                            </a>
                        </div>
                        <p style="font-size:12px;color:#94a3b8;text-align:center;">
                            If you did not request this, you can safely ignore this email.<br>
                            This link will expire in 1 hour.
                        </p>
                    </div>
                </div>
            `,
        };
 
        await createTransporter().sendMail(mailOptions);
 
        await logActivity(req.user.user_id, 'Admin', 'RESET_PASSWORD',
            `Sent password reset link to: ${user.email} (ID: ${userId})`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Reset Password Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — RESET QR TOKEN
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/users/:id/reset-qr
// Regenerates the QR code token for a user. Old token immediately invalidated.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/users/:id/reset-qr', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        const [[user]] = await db.query(
            `SELECT user_id, first_name, last_name FROM users WHERE user_id = ?`, [userId]
        );
        if (!user) return res.json({ success: false, message: 'User not found.' });
 
        let newToken, conflict;
        // Ensure uniqueness in the rare event of a collision
        do {
            newToken = generateQRToken();
            [[conflict]] = await db.query(
                `SELECT user_id FROM users WHERE qr_code_token = ?`, [newToken]
            );
        } while (conflict);
 
        await db.query(
            `UPDATE users SET qr_code_token = ? WHERE user_id = ?`, [newToken, userId]
        );
 
        await logActivity(req.user.user_id, 'Admin', 'RESET_QR',
            `Reset QR token for: ${user.first_name} ${user.last_name} (ID: ${userId})`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Reset QR Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — UNLINK GOOGLE
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/users/:id/unlink-google
// Removes google_id from the user. Account still accessible via email + password.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/users/:id/unlink-google', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        const [[user]] = await db.query(
            `SELECT user_id, first_name, last_name, google_id FROM users WHERE user_id = ?`, [userId]
        );
        if (!user) return res.json({ success: false, message: 'User not found.' });
        if (!user.google_id)
            return res.json({ success: false, message: 'This user does not have a linked Google account.' });
 
        await db.query(`UPDATE users SET google_id = NULL WHERE user_id = ?`, [userId]);
 
        await logActivity(req.user.user_id, 'Admin', 'UNLINK_GOOGLE',
            `Unlinked Google account for: ${user.first_name} ${user.last_name} (ID: ${userId})`);
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Unlink Google Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// USER — UNFLAG STUDENT
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/users/:id/unflag
// Clears flagged_assessment_id for a student and re-enables arcade access.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/users/:id/unflag', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.json({ success: false, message: 'Invalid user ID.' });
 
        const [[user]] = await db.query(
            `SELECT user_id, first_name, last_name, flagged_assessment_id FROM users WHERE user_id = ?`,
            [userId]
        );
        if (!user) return res.json({ success: false, message: 'User not found.' });
        if (!user.flagged_assessment_id)
            return res.json({ success: false, message: 'This user is not currently flagged.' });
 
        await db.query(
            `UPDATE users SET flagged_assessment_id = NULL WHERE user_id = ?`, [userId]
        );
 
        await logActivity(req.user.user_id, 'Admin', 'UNFLAG_STUDENT',
            `Unflagged student: ${user.first_name} ${user.last_name} (ID: ${userId}), was flagged on assessment ID ${user.flagged_assessment_id}`);

        // T-11: Notify Teacher(s) that student security flag was cleared by Admin
        try {
            const [clsRows] = await db.query(
                `SELECT DISTINCT c.teacher_id, c.class_id
                 FROM class_students cs
                 JOIN classes c ON cs.class_id = c.class_id
                 WHERE cs.student_id = ? AND c.teacher_id IS NOT NULL`,
                [userId]
            );
            for (const cRow of clsRows) {
                await notificationService.dispatch({
                    recipientIds: cRow.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'integrity',
                    priority: 'normal',
                    eventType: 'student_unflagged_by_admin',
                    title: 'Student Security Flag Cleared',
                    message: `Administrator cleared the assessment security flag for ${user.first_name} ${user.last_name}.`,
                    targetUrl: `/teacher/class/${cRow.class_id}?tab=students`,
                    metadata: { studentId: userId, classId: cRow.class_id }
                });
            }
        } catch (unflagNotifErr) {
            console.error('[UAC Unflag Teacher Notification Error]', unflagNotifErr.message);
        }
 
        return res.json({ success: true });
 
    } catch (err) {
        console.error('[UAC Unflag Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// BULK IMPORT — INVITATION-FIRST (REQ#2)
// ═══════════════════════════════════════════════════════════════════════════════
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/uac/bulk-import
// Parse Excel and send one invitation email per valid row.
// Users are NEVER inserted into users table here — they appear only after
// completing registration via the emailed link.
// Body (FormData): file, type (student|teacher)
// Returns: { success: true, created, skipped, errors, log[] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/uac/bulk-import', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        const type = req.body.type === 'teacher' ? 'teacher' : 'student';
        const role = type === 'teacher' ? 'Teacher' : 'Student';

        let rows = [];
        if (type === 'student' && req.body.students_json) {
            try {
                rows = JSON.parse(req.body.students_json);
            } catch (_) {
                rows = [];
            }
        } else if (type === 'teacher' && req.body.teachers_json) {
            try {
                rows = JSON.parse(req.body.teachers_json);
            } catch (_) {
                rows = [];
            }
        }
        if (rows.length === 0 && req.file) {
            const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        }

        if (!rows || rows.length === 0)
            return res.json({ success: false, message: 'The uploaded file or payload contains no data rows.' });

        const maxRows = type === 'student' ? 500 : 200;
        if (rows.length > maxRows)
            return res.json({ success: false, message: `Maximum ${maxRows} rows per import for ${role}.` });

        let created = 0, skipped = 0, errors = 0;
        const log = [];
        const passedRows = [];
        const failedRows = [];
        const transporter = createTransporter();

        // ── Pre-fetch Active School Year and Classes for Student Validation ──
        let activeSY = null;
        let allClasses = [];
        // Pre-fetch Classes for both Student & Teacher bulk import
        const [clsRows] = await db.query(`
            SELECT 
                c.class_id, c.class_name, c.teacher_id, c.subject_id, c.sy_id,
                c.max_capacity,
                COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                s.subject_name, s.subject_code, s.semester,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                u.first_name AS teacher_first, u.last_name AS teacher_last,
                u.faculty_id AS teacher_faculty_id,
                sy.sy_range, sy.is_active AS sy_is_active,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
            FROM classes c
            LEFT JOIN users u ON u.user_id = c.teacher_id
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
        `);
        allClasses = clsRows;

        if (type === 'student') {
            const [[syRow]] = await db.query(
                `SELECT sy_id, sy_range, is_active FROM school_years WHERE is_active = 1 LIMIT 1`
            );
            activeSY = syRow || null;

            // allClasses already pre-fetched above
        }

        // Track allocations within this batch to prevent capacity overflow and duplicate entries
        const batchCapacityTracker = {};
        const seenEmailsInBatch    = new Set();
        const seenLrnsInBatch      = new Set();

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const rawRow = rows[rowIdx];
            // Normalise keys: lowercase, strip asterisks, parentheticals, spaces to underscores
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                const normKey = String(k)
                    .replace('*', '')
                    .replace(/\(.*\)/, '')
                    .trim()
                    .toLowerCase()
                    .replace(/[\s-]+/g, '_');
                if (Array.isArray(v)) {
                    row[normKey] = v;
                } else if (typeof v === 'object' && v !== null) {
                    row[normKey] = v;
                } else {
                    row[normKey] = String(v !== undefined && v !== null ? v : '').trim();
                }
            }

            const cleanEmail = (row.email || '').trim().toLowerCase();
            const firstName  = (row.first_name || '').trim();
            const lastName   = (row.last_name || '').trim();
            const fullName   = [firstName, lastName].filter(Boolean).join(' ') || (cleanEmail || `Row #${rowIdx + 1}`);

            // 1. Validate required basic fields
            if (!firstName || !lastName || !cleanEmail) {
                const reason = `Missing required field(s): ${!firstName ? 'First Name, ' : ''}${!lastName ? 'Last Name, ' : ''}${!cleanEmail ? 'Email' : ''}`.replace(/,\s*$/, '');
                log.push({ ok: false, msg: `Row #${rowIdx + 1} (${fullName}): ${reason}` });
                failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail || '(no email)', reason });
                skipped++;
                continue;
            }

            const roleLabel = type === 'teacher' ? 'Teacher' : 'Student';

            // 2. Validate email format
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
                const reason = `Invalid email address format: "${cleanEmail}".`;
                log.push({ ok: false, msg: `${roleLabel} "${fullName}": ${reason}` });
                failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                skipped++;
                continue;
            }

            // 3. Check duplicate email in current batch
            if (seenEmailsInBatch.has(cleanEmail)) {
                const reason = `Duplicate email "${cleanEmail}" detected across multiple rows in this import batch.`;
                log.push({ ok: false, msg: `${roleLabel} "${fullName}": ${reason}` });
                failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                skipped++;
                continue;
            }

            try {
                // 4. Check duplicate in users table
                const [[existUser]] = await db.query(
                    `SELECT user_id, first_name, last_name FROM users WHERE email = ?`, [cleanEmail]
                );
                if (existUser) {
                    const reason = `Email "${cleanEmail}" is already registered to user "${existUser.first_name} ${existUser.last_name}".`;
                    log.push({ ok: false, msg: `${roleLabel} "${fullName}": ${reason}` });
                    failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                    skipped++;
                    continue;
                }

                // 5. Check duplicate in pending invitations
                const [[existInv]] = await db.query(
                    `SELECT invitation_id FROM account_invitations WHERE email = ? AND is_used = 0`,
                    [cleanEmail]
                );
                if (existInv) {
                    const reason = `A pending invitation already exists for "${cleanEmail}".`;
                    log.push({ ok: false, msg: `${roleLabel} "${fullName}": ${reason}` });
                    failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                    skipped++;
                    continue;
                }

                // ── STUDENT-SPECIFIC VALIDATION & ENROLLMENT RULES ────────────
                let targetClass = null;
                let cleanLrn = null;
                let finalTrack = 'Academic Track';

                if (type === 'student') {
                    const rawLrn = String(row.lrn_number || row.lrn || row.learner_reference_number || '').trim();
                    cleanLrn = rawLrn.replace(/\D/g, '');

                    // Rule A: LRN is mandatory and must strictly meet 12-digit requirement
                    if (!rawLrn) {
                        const reason = 'LRN is required. Please provide a 12-digit Learner Reference Number.';
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }
                    if (!/^\d{12}$/.test(rawLrn)) {
                        const reason = `Invalid LRN "${rawLrn}". DepEd LRN must be exactly 12 numeric digits (got ${rawLrn.length} character${rawLrn.length === 1 ? '' : 's'}).`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Check duplicate LRN within this batch
                    if (seenLrnsInBatch.has(cleanLrn)) {
                        const reason = `Duplicate LRN "${cleanLrn}" detected across multiple rows in this import batch.`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Check duplicate LRN in users table
                    const [[lrnEx]] = await db.query(
                        `SELECT user_id, first_name, last_name FROM users WHERE lrn_number = ?`, [cleanLrn]
                    );
                    if (lrnEx) {
                        const reason = `LRN "${cleanLrn}" is already registered to student "${lrnEx.first_name} ${lrnEx.last_name}".`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Check duplicate LRN in pending invitations
                    const [pendingWithLrn] = await db.query(
                        `SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role = 'Student' AND prefill_data LIKE ?`,
                        [`%${cleanLrn}%`]
                    );
                    const matchingInv = pendingWithLrn.find(p => {
                        try { return JSON.parse(p.prefill_data).lrn === cleanLrn; } catch (_) { return false; }
                    });
                    if (matchingInv) {
                        const reason = `LRN "${cleanLrn}" is already reserved in a pending invitation for "${matchingInv.email}".`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule B: Target Class Pinpointing via Section, Teacher, and Subject
                    const targetSection = (row.section || row.class || row.class_name || req.body.default_section || '').trim();
                    const targetTeacher = (row.teacher || row.teacher_name || row.instructor || req.body.default_teacher || '').trim();
                    const targetSubject = (row.subject || row.subject_name || row.course || req.body.default_subject || '').trim();

                    if (!targetSection) {
                        const reason = 'No section specified. Student must be assigned to an enrolled section.';
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Step 1: Match by Section Name
                    let matches = allClasses.filter(c => 
                        c.class_name.trim().toLowerCase() === targetSection.toLowerCase()
                    );

                    // Step 2: Pinpoint using Teacher Name if provided
                    if (targetTeacher && matches.length > 0) {
                        const tNorm = targetTeacher.trim().toLowerCase();
                        const teacherMatches = matches.filter(c => {
                            const full = (c.teacher_name || '').toLowerCase().trim();
                            const last = (c.teacher_last || '').toLowerCase().trim();
                            const fac  = (c.teacher_faculty_id || '').toLowerCase().trim();
                            const uid  = String(c.teacher_id || '');
                            return full.includes(tNorm) || tNorm.includes(last) || fac === tNorm || uid === tNorm;
                        });
                        if (teacherMatches.length > 0) {
                            matches = teacherMatches;
                        }
                    }

                    // Step 3: Pinpoint using Subject Name / Code if provided
                    if (targetSubject && matches.length > 0) {
                        const sNorm = targetSubject.trim().toLowerCase();
                        const subjectMatches = matches.filter(c => {
                            const sName = (c.subject_name || '').toLowerCase().trim();
                            const sCode = (c.subject_code || '').toLowerCase().trim();
                            const sid   = String(c.subject_id || '');
                            return sName.includes(sNorm) || sCode === sNorm || sid === sNorm;
                        });
                        if (subjectMatches.length > 0) {
                            matches = subjectMatches;
                        }
                    }

                    // Step 4: Validate Section Uniqueness / Disambiguation
                    if (matches.length === 0) {
                        const reason = `Target class not found: Section "${targetSection}" ${targetTeacher ? 'with Teacher "' + targetTeacher + '"' : ''} ${targetSubject ? 'under Subject "' + targetSubject + '"' : ''} does not exist in the system.`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    if (matches.length > 1) {
                        const subjectList = matches.map(m => `"${m.subject_name}" (Teacher: ${m.teacher_name || 'Unassigned'})`).join(', ');
                        const reason = `Ambiguous section "${targetSection}". Duplicate sections exist across subjects: ${subjectList}. Please include the "Teacher" column (e.g., "${matches[0].teacher_name}") or Subject to pinpoint the exact class.`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    targetClass = matches[0];

                    // Rule C: Standard Enrollment Rule 1 — Strictly Current Active School Year
                    if (!activeSY) {
                        const reason = 'Enrollment failed: No active School Year is currently configured in the system.';
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }
                    if (targetClass.sy_id !== activeSY.sy_id || !targetClass.sy_is_active) {
                        const reason = `Enrollment failed: Section "${targetClass.class_name}" (${targetClass.subject_name}) is registered under School Year "${targetClass.sy_range || 'Inactive'}", not the current active School Year ("${activeSY.sy_range}"). Enrollment is strictly prohibited for past or future school years.`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule D: Standard Enrollment Rule 2 — Enrollment Time Window (Sem 1 / Sem 2)
                    const now = new Date();
                    const semLabel = (targetClass.semester == 2 || targetClass.semester === '2' || targetClass.semester === '2nd Semester') ? '2nd Semester' : '1st Semester';
                    if (targetClass.enrollment_start && now < new Date(targetClass.enrollment_start)) {
                        const openStr = new Date(targetClass.enrollment_start).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        const reason = `Enrollment failed: Enrollment for section "${targetClass.class_name}" (${targetClass.subject_name || 'Subject'} - ${semLabel}) has not started yet (Opens on ${openStr}).`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }
                    if (targetClass.enrollment_end && now > new Date(targetClass.enrollment_end)) {
                        const closeStr = new Date(targetClass.enrollment_end).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        const reason = `Enrollment failed: Enrollment period for section "${targetClass.class_name}" (${targetClass.subject_name || 'Subject'} - ${semLabel}) has ended (Closed on ${closeStr}). Students cannot be enrolled after the enrollment period has closed.`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule E: Standard Enrollment Rule 3 — Maximum Capacity Enforcement
                    const queuedCount = batchCapacityTracker[targetClass.class_id] || 0;
                    const projectedTotal = targetClass.current_enrolled + queuedCount + 1;
                    if (targetClass.max_capacity !== null && targetClass.max_capacity !== undefined) {
                        if (projectedTotal > targetClass.max_capacity) {
                            const reason = `Enrollment failed: Section "${targetClass.class_name}" (${targetClass.subject_name}) has reached its maximum capacity (${targetClass.current_enrolled} currently enrolled + ${queuedCount} in this batch / max ${targetClass.max_capacity}). Adding this student would exceed capacity.`;
                            log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                            failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                            skipped++;
                            continue;
                        }
                    }

                    // Rule F: Standard Enrollment Rule 4 — Chemistry 1 Prerequisite for Chemistry 2
                    let studentUser = null;
                    if (cleanEmail) {
                        const [[u]] = await db.query(`SELECT user_id FROM users WHERE email = ? AND role = 'Student'`, [cleanEmail]);
                        studentUser = u;
                    }
                    if (!studentUser && cleanLrn) {
                        const [[u]] = await db.query(`SELECT user_id FROM users WHERE lrn_number = ? AND role = 'Student'`, [cleanLrn]);
                        studentUser = u;
                    }

                    const prereqCheck = await academicHelper.checkStudentPrerequisite(
                        db,
                        studentUser ? studentUser.user_id : null,
                        targetClass.subject_id,
                        activeSY
                    );
                    if (!prereqCheck.eligible) {
                        const reason = `Enrollment failed: Student "${fullName}" does not meet prerequisite for section "${targetClass.class_name}" (${targetClass.subject_name || 'Chemistry 2'}). ${prereqCheck.reason}`;
                        log.push({ ok: false, msg: `Student "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Preset Track column default to "Academic Track"
                    finalTrack = (row.track || row.strand || 'Academic Track').trim() || 'Academic Track';

                    // Reserve capacity & uniqueness in this batch
                    batchCapacityTracker[targetClass.class_id] = queuedCount + 1;
                    seenEmailsInBatch.add(cleanEmail);
                    // LRN already registered in seenLrnsInBatch above
                }

                // ── TEACHER-SPECIFIC VALIDATION & TEACHING LOAD ASSIGNMENT ───
                let assignedTeacherClasses = [];
                let cleanFacultyId = '';
                if (type === 'teacher') {
                    cleanFacultyId = String(row.faculty_id || row.facultyid || '').trim();

                    // Rule 1: Faculty ID is mandatory for teachers
                    if (!cleanFacultyId) {
                        const reason = 'Faculty ID is required for teachers and must be unique.';
                        log.push({ ok: false, msg: `Teacher "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 2: Check duplicate Faculty ID within current batch
                    if (seenLrnsInBatch.has(cleanFacultyId)) {
                        const reason = `Duplicate Faculty ID "${cleanFacultyId}" detected across multiple rows in this import batch.`;
                        log.push({ ok: false, msg: `Teacher "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 3: Check duplicate Faculty ID in users table
                    const [[fidEx]] = await db.query(
                        `SELECT user_id, first_name, last_name FROM users WHERE faculty_id = ?`, [cleanFacultyId]
                    );
                    if (fidEx) {
                        const reason = `Faculty ID "${cleanFacultyId}" is already registered to "${fidEx.first_name} ${fidEx.last_name}".`;
                        log.push({ ok: false, msg: `Teacher "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 4: Check duplicate Faculty ID in pending invitations
                    const [pendingWithFid] = await db.query(
                        `SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role IN ('Teacher', 'Admin') AND prefill_data LIKE ?`,
                        [`%${cleanFacultyId}%`]
                    );
                    const matchingFid = pendingWithFid.find(p => {
                        try { return JSON.parse(p.prefill_data).facultyId === cleanFacultyId; } catch (_) { return false; }
                    });
                    if (matchingFid) {
                        const reason = `Faculty ID "${cleanFacultyId}" is already reserved in a pending invitation for "${matchingFid.email}".`;
                        log.push({ ok: false, msg: `Teacher "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 5: Resolve Assigned Classes / Teaching Load
                    let targetClassIds = [];
                    if (Array.isArray(row.class_ids) && row.class_ids.length > 0) {
                        targetClassIds = row.class_ids.map(Number).filter(n => !isNaN(n) && n > 0);
                    } else if (Array.isArray(rawRow.class_ids) && rawRow.class_ids.length > 0) {
                        targetClassIds = rawRow.class_ids.map(Number).filter(n => !isNaN(n) && n > 0);
                    } else if (Array.isArray(row.classids) && row.classids.length > 0) {
                        targetClassIds = row.classids.map(Number).filter(n => !isNaN(n) && n > 0);
                    } else if (typeof row.class_ids === 'string' && row.class_ids.trim()) {
                        targetClassIds = row.class_ids.split(/[;,]/).map(t => parseInt(t.trim(), 10)).filter(n => !isNaN(n) && n > 0);
                    }

                    // Fallback to text parsing if no IDs resolved yet
                    if (targetClassIds.length === 0) {
                        const rawClassesText = String(row.assigned_classes || rawRow.assigned_classes || row.classes || row.sections || '').trim();
                        if (rawClassesText && allClasses.length > 0) {
                            // Support subject-scoped format: "Chemistry 1: Atom, Molecule; Chemistry 2: Atom"
                            const subjectBlocks = rawClassesText.split(';').map(b => b.trim()).filter(Boolean);
                            subjectBlocks.forEach(block => {
                                if (block.includes(':')) {
                                    const parts = block.split(':');
                                    const subjPart = parts[0].trim().toLowerCase();
                                    const secParts = parts[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                                    secParts.forEach(secName => {
                                        const match = allClasses.find(c => 
                                            (c.subject_name.toLowerCase().includes(subjPart) || (c.subject_code && c.subject_code.toLowerCase().includes(subjPart))) &&
                                            c.class_name.toLowerCase().trim() === secName
                                        ) || allClasses.find(c => c.class_name.toLowerCase().trim() === secName);
                                        if (match && !targetClassIds.includes(match.class_id)) {
                                            targetClassIds.push(match.class_id);
                                        }
                                    });
                                } else {
                                    const secTokens = block.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                                    secTokens.forEach(secName => {
                                        const numId = parseInt(secName, 10);
                                        if (!isNaN(numId) && allClasses.some(c => c.class_id === numId)) {
                                            if (!targetClassIds.includes(numId)) targetClassIds.push(numId);
                                            return;
                                        }
                                        const match = allClasses.find(c => c.class_name.toLowerCase().trim() === secName);
                                        if (match && !targetClassIds.includes(match.class_id)) {
                                            targetClassIds.push(match.class_id);
                                        }
                                    });
                                }
                            });
                        }
                    }

                    // Fallback to batch preset if provided in request body
                    if (targetClassIds.length === 0 && req.body.default_classes) {
                        try {
                            const defs = typeof req.body.default_classes === 'string' ? JSON.parse(req.body.default_classes) : req.body.default_classes;
                            if (Array.isArray(defs)) {
                                targetClassIds = defs.map(Number).filter(n => !isNaN(n) && n > 0);
                            }
                        } catch (_) {}
                    }

                    if (targetClassIds.length === 0) {
                        const reason = 'Teacher must be assigned to at least one class / section.';
                        log.push({ ok: false, msg: `Teacher "${fullName}" (${cleanEmail}): ${reason}` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Query class & subject details for target class IDs
                    const [matchedClsRows] = await db.query(
                        `SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id,
                                s.subject_name, s.subject_code,
                                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name
                         FROM classes c
                         LEFT JOIN users u ON c.teacher_id = u.user_id
                         LEFT JOIN subjects s ON c.subject_id = s.subject_id
                         WHERE c.class_id IN (?)`,
                        [targetClassIds]
                    );
                    assignedTeacherClasses = matchedClsRows;

                    // Unlink previous teachers if conflict replacement confirmed
                    for (const cls of assignedTeacherClasses) {
                        if (cls.teacher_id) {
                            await logActivity(req.user.user_id, 'Admin', 'REPLACE_CLASS_TEACHER',
                                `Replaced existing teacher "${cls.teacher_name}" (User ID: ${cls.teacher_id}) on course "${cls.subject_name}" - section "${cls.class_name}" with bulk invite for "${cleanEmail}"`);
                            await db.query('UPDATE classes SET teacher_id = NULL WHERE class_id = ?', [cls.class_id]);
                        }
                    }

                    seenLrnsInBatch.add(cleanFacultyId);
                    seenEmailsInBatch.add(cleanEmail);
                }

                // Generate invitation token
                const token     = generateInviteToken();
                const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

                // Remove any old unconfirmed invitation record for this email
                await db.query(
                    `DELETE FROM account_invitations WHERE email = ? AND role IN ('Admin', 'Teacher', 'Student')`,
                    [cleanEmail]
                );

                // Build rich prefill data JSON
                const bulkPrefill = JSON.stringify({
                    firstName   : firstName   || null,
                    middleName  : row.middle_name || null,
                    lastName    : lastName    || null,
                    suffix      : row.suffix      || null,
                    sex         : row.sex         || null,
                    birthdate   : row.birthdate   || null,
                    lrn         : type === 'student' ? cleanLrn : null,
                    gradeLevel  : type === 'student' ? (row.grade_level || 'Grade 11') : null,
                    section     : type === 'student' ? (targetClass ? targetClass.class_name : (row.section || null)) : null,
                    classId     : type === 'student' ? (targetClass ? targetClass.class_id : null) : null,
                    subjectId   : type === 'student' ? (targetClass ? targetClass.subject_id : null) : null,
                    courseName  : type === 'student' ? (targetClass ? targetClass.subject_name : null) : null,
                    teacherId   : type === 'student' ? (targetClass ? targetClass.teacher_id : null) : null,
                    teacherName : type === 'student' ? (targetClass ? targetClass.teacher_name : null) : null,
                    syId        : type === 'student' ? (targetClass ? targetClass.sy_id : null) : null,
                    track       : type === 'student' ? finalTrack : null,
                    strand      : type === 'student' ? finalTrack : null,
                    interests   : row.interests   || null,
                    facultyId   : type === 'teacher' ? cleanFacultyId : null,
                    department  : type === 'teacher' ? (row.department || null) : null,
                    classIds    : type === 'teacher' ? assignedTeacherClasses.map(c => c.class_id) : null,
                    subjectIds  : type === 'teacher' ? [...new Set(assignedTeacherClasses.map(c => c.subject_id))] : null,
                    courseName  : type === 'teacher' ? [...new Set(assignedTeacherClasses.map(c => c.subject_name))].join(', ') : null,
                    mobileNumber: row.mobile_number || null,
                    cityTown    : row.city_town     || null,
                });

                await db.query(
                    `INSERT INTO account_invitations (email, role, token, expires_at, prefill_data) VALUES (?, ?, ?, ?, ?)`,
                    [cleanEmail, role, token, expiresAt, bulkPrefill]
                );

                // Send invitation email
                const baseUrl  = process.env.APP_URL || 'http://localhost:3000';
                const regLink  = `${baseUrl}/setup-profile?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

                let emailClassInfo = '';
                if (type === 'student' && targetClass) {
                    emailClassInfo = `
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>LRN:</b></td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">${cleanLrn}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Section:</b></td><td style="padding:4px 8px;font-size:13px;font-weight:bold;">${targetClass.class_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Subject:</b></td><td style="padding:4px 8px;font-size:13px;">${targetClass.subject_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Teacher:</b></td><td style="padding:4px 8px;font-size:13px;">${targetClass.teacher_name || 'Assigned Faculty'}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Track:</b></td><td style="padding:4px 8px;font-size:13px;">${finalTrack}</td></tr>
                    `;
                } else if (type === 'teacher' && assignedTeacherClasses.length > 0) {
                    const sectionsBySubj = {};
                    assignedTeacherClasses.forEach(c => {
                        const sName = c.subject_name || 'General';
                        if (!sectionsBySubj[sName]) sectionsBySubj[sName] = [];
                        sectionsBySubj[sName].push(c.class_name);
                    });
                    const loadHtml = Object.entries(sectionsBySubj).map(([sName, secs]) => `<b>${sName}:</b> ${secs.join(', ')}`).join('<br>');
                    emailClassInfo = `
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Faculty ID:</b></td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">${cleanFacultyId}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Department:</b></td><td style="padding:4px 8px;font-size:13px;">${row.department || 'Science Department'}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;vertical-align:top;"><b>Assigned Load:</b></td><td style="padding:4px 8px;font-size:13px;">${loadHtml}</td></tr>
                    `;
                }

                const mailOptions = {
                    from   : `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`,
                    to     : cleanEmail,
                    subject: `You're invited to Chemistry Arcade LMS as a ${role}`,
                    html   : `
                        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                            <div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);padding:24px 28px;">
                                <h1 style="color:white;margin:0;font-size:20px;font-weight:900;">⚗️ Chemistry Arcade LMS</h1>
                                <p style="color:#c7d2fe;margin:4px 0 0;font-size:12px;">Official Registration &amp; Enrollment Invitation</p>
                            </div>
                            <div style="padding:24px 28px;background:white;">
                                <p style="font-size:15px;color:#1e293b;">Hello <b>${fullName}</b>,</p>
                                <p style="font-size:14px;color:#475569;line-height:1.6;">
                                    You have been officially invited and enrolled into <b>Chemistry Arcade LMS</b> as a <b style="color:#4f46e5;">${role}</b>.
                                    Click the button below to complete your registration, link your Google account, and set your password.
                                </p>
                                <table style="margin:16px 0;background:#f8fafc;border-radius:10px;padding:12px 16px;border:1px solid #e2e8f0;width:100%;">
                                    <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Role:</b></td><td style="padding:4px 8px;font-size:13px;">${role}</td></tr>
                                    ${emailClassInfo}
                                </table>
                                <div style="text-align:center;margin:24px 0;">
                                    <a href="${regLink}" style="background:linear-gradient(135deg,#4f46e5,#06b6d4);color:white;padding:12px 28px;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;display:inline-block;">
                                        ✉️ Complete Registration &amp; Enrollment
                                    </a>
                                </div>
                                <p style="font-size:11px;color:#94a3b8;text-align:center;">This invitation link expires in 7 days.</p>
                            </div>
                        </div>
                    `,
                };

                try {
                    await transporter.sendMail(mailOptions);
                } catch (mailErr) {
                    console.warn(`[Bulk Import Mail Warn for ${cleanEmail}]:`, mailErr.message);
                }

                const successMsg = type === 'student' && targetClass
                    ? `✔ Successfully enrolled & invited: ${fullName} (${cleanEmail}) → Section: ${targetClass.class_name} (${targetClass.subject_name}), Teacher: ${targetClass.teacher_name || 'Unassigned'}, Track: ${finalTrack}`
                    : `✔ Successfully assigned & invited: ${fullName} (${cleanEmail}) → Faculty ID: ${cleanFacultyId}, Classes: ${assignedTeacherClasses.map(c => c.class_name).join(', ')}`;

                log.push({ ok: true, msg: successMsg });
                passedRows.push({
                    row: rowIdx + 1,
                    name: fullName,
                    email: cleanEmail,
                    lrn: cleanLrn,
                    faculty_id: cleanFacultyId,
                    department: row.department || 'Science Department',
                    assigned_load: assignedTeacherClasses.map(c => `${c.subject_name || 'Subject'}: ${c.class_name}`).join(', '),
                    section: targetClass ? targetClass.class_name : (row.section || ''),
                    subject: targetClass ? targetClass.subject_name : '',
                    teacher: targetClass ? targetClass.teacher_name : '',
                    track: finalTrack,
                });
                created++;

            } catch (rowErr) {
                const reason = `Server error processing row: ${rowErr.message}`;
                log.push({ ok: false, msg: `Row #${rowIdx + 1} (${cleanEmail}): ${reason}` });
                failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                errors++;
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'BULK_INVITE',
            `Bulk imported & enrolled ${created} ${role}(s) — rejected/skipped: ${skipped}, errors: ${errors}`);

        return res.json({ 
            success: true, 
            created, 
            skipped, 
            errors, 
            log, 
            details: { 
                totalRows: rows.length, 
                passedCount: created, 
                failedCount: skipped + errors, 
                passedRows, 
                failedRows 
            } 
        });

    } catch (err) {
        console.error('[UAC Bulk Import Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BULK TEMPLATE DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/uac/bulk-template?type=student|teacher
// Download a pre-filled Excel template. Columns match what bulk-import expects.
// Includes Teacher column, Track renamed from Strand, and Subject column.
// Returns: .xlsx file download
// ─────────────────────────────────────────────────────────────────────────────
router.get('/uac/bulk-template', requireAdmin, async (req, res) => {
    try {
        const type = req.query.type === 'teacher' ? 'teacher' : 'student';

        const studentHeaders = [
            'first_name*',
            'middle_name',
            'last_name*',
            'suffix',
            'email*',
            'lrn_number*',
            'grade_level',
            'subject*',
            'section*',
            'teacher*',
            'track',
            'sex',
            'birthdate(YYYY-MM-DD)',
            'mobile_number',
            'city_town',
            'self_description',
            'interests',
        ];

        const teacherHeaders = [
            'first_name*',
            'middle_name',
            'last_name*',
            'suffix',
            'email*',
            'faculty_id*',
            'department',
            'assigned_classes',
            'sex',
            'birthdate(YYYY-MM-DD)',
            'mobile_number',
            'city_town',
        ];

        const headers = type === 'teacher' ? teacherHeaders : studentHeaders;

        let sampleSubject = (req.query.subject || '').trim() || 'Chemistry 1';
        let sampleSection = (req.query.section || '').trim() || 'Atom';
        let sampleTeacher = (req.query.teacher || '').trim() || 'Denzel Villaflores';

        // If a classId was provided, look up class to prefill realistic template values
        if (req.query.classId) {
            const [[cRow]] = await db.query(`
                SELECT c.class_name, s.subject_name, CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name
                FROM classes c
                LEFT JOIN subjects s ON c.subject_id = s.subject_id
                LEFT JOIN users u ON c.teacher_id = u.user_id
                WHERE c.class_id = ?
            `, [req.query.classId]);
            if (cRow) {
                sampleSection = cRow.class_name || sampleSection;
                sampleSubject = cRow.subject_name || sampleSubject;
                sampleTeacher = (cRow.teacher_name || '').trim() || sampleTeacher;
            }
        }

        const sampleStudent1 = [
            'Juan', 'Santos', 'Dela Cruz', 'Jr.',
            'juan.delacruz@gmail.com',
            '123456789012', 'Grade 11', sampleSubject, sampleSection, sampleTeacher, 'Academic Track',
            'Male', '2007-05-14', '+63 912 345 6789', 'Batangas City',
            'Passionate about chemical synthesis and arcade games.', 'Gaming, Science',
        ];

        const sampleStudent2 = [
            'Maria', 'Clara', 'Reyes', '',
            'maria.reyes@gmail.com',
            '987654321098', 'Grade 11', sampleSubject, sampleSection, sampleTeacher, 'Academic Track',
            'Female', '2007-08-20', '+63 918 765 4321', 'Batangas City',
            'Interested in biochemistry and laboratory experiments.', 'Reading, Chemistry',
        ];

        const sampleTeacher1 = [
            'Maria', '', 'Santos', '',
            'teacher.santos@gmail.com',
            'FAC-101', 'Science Department',
            'Chemistry 1: Atom, Molecule; Chemistry 2: Atom',
            'Female', '1990-03-22', '+63 917 000 0000', 'Batangas City',
        ];

        const sampleTeacher2 = [
            'Roberto', 'M.', 'Dela Cruz', '',
            'teacher.delacruz@gmail.com',
            'FAC-102', 'Science Department',
            'Chemistry 1: Molecule',
            'Male', '1988-11-15', '+63 918 111 2222', 'Batangas City',
        ];

        const sheetData = type === 'teacher' 
            ? [headers, sampleTeacher1, sampleTeacher2] 
            : [headers, sampleStudent1, sampleStudent2];

        const ws = XLSX.utils.aoa_to_sheet(sheetData);

        // Set column widths for comfortable editing in Excel
        ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 4, 18) }));

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, `${type}_template`);

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="uac_${type}_bulk_template.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);

    } catch (err) {
        console.error('[Bulk Template Error]', err);
        res.status(500).send('Error generating template: ' + err.message);
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  █████╗  ██████╗ █████╗ ██████╗ ███████╗███╗   ███╗██╗ ██████╗
// ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝████╗ ████║██║██╔════╝
// ███████║██║     ███████║██║  ██║█████╗  ██╔████╔██║██║██║
// ██╔══██║██║     ██╔══██║██║  ██║██╔══╝  ██║╚██╔╝██║██║██║
// ██║  ██║╚██████╗██║  ██║██████╔╝███████╗██║ ╚═╝ ██║██║╚██████╗
// ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝ ╚═════╝
// ACADEMIC MANAGEMENT — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/academic_management
// Renders the Academic Management page.
// EJS expects: user, schoolYears, activeSY, subjects, teachers, amStats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/academic_management', requireAdmin, async (req, res) => {
    try {
        // ── Resolve School Year Context (Default to Current, support ?sy_id=) ──
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        // Show only 2 latest in the card; all go to the "past SY" modal
        const schoolYears     = allSchoolYears.slice(0, 2);
        const pastSchoolYears = allSchoolYears;

        // ── Selected school year with class/enroll counts ─────────────────────
        const [[classCountRow]]  = await db.query(
            `SELECT COUNT(*) AS cnt FROM classes WHERE sy_id = ?`, [selectedSY.sy_id]
        );
        const [[enrollCountRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM class_students WHERE sy_id = ?`, [selectedSY.sy_id]
        );
        const activeSY = {
            ...selectedSY,
            classCount   : classCountRow ? classCountRow.cnt : 0,
            enrolledCount: enrollCountRow ? enrollCountRow.cnt : 0,
        };

        // ── Subjects with quarter/topic counts ────────────────────────────────
        const [subjects] = await db.query(`
            SELECT
                s.subject_id, s.subject_name, s.subject_code, s.subject_image,
                s.description, s.semester, s.enrollment_code,
                COUNT(DISTINCT q.quarter_id) AS quarterCount,
                COUNT(DISTINCT t.topic_id)   AS topicCount
            FROM subjects s
            LEFT JOIN quarters q ON q.subject_id = s.subject_id
            LEFT JOIN topics   t ON t.quarter_id  = q.quarter_id
            GROUP BY s.subject_id
            ORDER BY s.subject_name ASC
        `);

        // ── All teachers (for Add Class dropdown) ─────────────────────────────
        const [teachers] = await db.query(
            `SELECT user_id, first_name, last_name FROM users WHERE role = 'Teacher' ORDER BY last_name ASC, first_name ASC`
        );

        // ── KPI stat cards (totalClasses scoped to selectedSY) ────────────────
        const [[subjRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM subjects`);
        const [[quarRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM quarters`);
        const [[topicRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM topics`);

        const amStats = {
            totalSubjects : subjRow.cnt,
            totalQuarters : quarRow.cnt,
            totalTopics   : topicRow.cnt,
            totalClasses  : classCountRow ? classCountRow.cnt : 0,
        };

        res.render('admin/academic_management', {
            user          : req.user,
            schoolYears,
            pastSchoolYears,
            activeSY,
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY,
            subjects,
            teachers,
            amStats,
        });

    } catch (err) {
        console.error('[AM GET Error]', err);
        res.status(500).send('Server error loading Academic Management: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL YEARS (COMPREHENSIVE ARCHITECTURE)
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/school-years/:id
// Returns full school year record as JSON.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/school-years/:id', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });

        const [[sy]] = await db.query(`SELECT * FROM school_years WHERE sy_id = ?`, [syId]);
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        return res.json({ success: true, schoolYear: sy });
    } catch (err) {
        console.error('[AM Get SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years
// Create a new school year with 4 full sections.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years', requireAdmin, async (req, res) => {
    try {
        const {
            sy_range,
            sy_code,
            start_date,
            end_date,
            status = 'Draft',
            is_active,

            // Section 2: Semestral & Quarterly Timeline
            sem1_start_date,
            sem1_end_date,
            q1_start_date,
            q1_end_date,
            q1_grade_deadline,
            q2_start_date,
            q2_end_date,
            q2_grade_deadline,

            sem2_start_date,
            sem2_end_date,
            q3_start_date,
            q3_end_date,
            q3_grade_deadline,
            q4_start_date,
            q4_end_date,
            q4_grade_deadline,

            // Section 3: Enrollment & Access Controls
            sem1_enrollment_start,
            sem1_enrollment_end,
            sem2_enrollment_start,
            sem2_enrollment_end,
            enforce_prerequisite = 1,
            passing_threshold = 75.00,

            // Section 4: Content Rollover & Retention
            source_sy_id,
            rollover_materials = 1,
            rollover_assessments = 0,
            rollover_question_bank = 0,
            rollover_announcements = 0,
            default_rollover_visibility = 'visible',

            // Section 5: Student Lifecycle & Governance (Single-Year Chemistry 1 & 2)
            archive_outgoing_cohort = 1,
            archive_graduating = null // backward compatibility fallback
        } = req.body;

        // 1. Validate Timeline & Formats
        const validation = academicHelper.validateSchoolYearTimeline(req.body);
        if (!validation.valid) {
            return res.json({ success: false, message: validation.message });
        }

        const cleanRange = sy_range.trim();
        const cleanCode  = sy_code ? sy_code.trim() : `SY${cleanRange.slice(2, 4)}-${cleanRange.slice(7, 9)}`;

        // 2. Check duplicate
        const [[existing]] = await db.query(
            `SELECT sy_id FROM school_years WHERE sy_range = ?`, [cleanRange]
        );
        if (existing) {
            return res.json({ success: false, message: `School year "${cleanRange}" already exists.` });
        }

        // 3. Determine active state & status (canonical: Current, Draft, Archive)
        const activeFlag = (is_active === 1 || is_active === true || is_active === '1' || status === 'Current' || status === 'Active') ? 1 : 0;
        const finalStatus = activeFlag === 1 ? 'Current' : academicHelper.normalizeSchoolYearStatus(status, 0);

        // Atomically deactivate others if this SY is active/Current
        if (activeFlag === 1) {
            await db.query(`UPDATE school_years SET is_active = 0, status = 'Archive' WHERE is_active = 1 OR status = 'Current'`);
        }

        // 4. Insert row
        const [insertResult] = await db.query(`
            INSERT INTO school_years (
                sy_range, sy_code, start_date, end_date, status, is_active,
                sem1_start_date, sem1_end_date, sem1_enrollment_start, sem1_enrollment_end,
                q1_start_date, q1_end_date, q1_grade_deadline,
                q2_start_date, q2_end_date, q2_grade_deadline,
                sem2_start_date, sem2_end_date, sem2_enrollment_start, sem2_enrollment_end,
                q3_start_date, q3_end_date, q3_grade_deadline,
                q4_start_date, q4_end_date, q4_grade_deadline,
                enforce_prerequisite, passing_threshold,
                source_sy_id, rollover_materials, rollover_assessments,
                rollover_question_bank, rollover_announcements, default_rollover_visibility
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?, ?
            )
        `, [
            cleanRange,
            cleanCode,
            start_date || null,
            end_date || null,
            finalStatus,
            activeFlag,
            sem1_start_date || null,
            sem1_end_date || null,
            sem1_enrollment_start || null,
            sem1_enrollment_end || null,
            q1_start_date || null,
            q1_end_date || null,
            q1_grade_deadline || null,
            q2_start_date || null,
            q2_end_date || null,
            q2_grade_deadline || null,
            sem2_start_date || null,
            sem2_end_date || null,
            sem2_enrollment_start || null,
            sem2_enrollment_end || null,
            q3_start_date || null,
            q3_end_date || null,
            q3_grade_deadline || null,
            q4_start_date || null,
            q4_end_date || null,
            q4_grade_deadline || null,
            Number(enforce_prerequisite) === 1 ? 1 : 0,
            Number(passing_threshold) || 75.00,
            source_sy_id ? parseInt(source_sy_id, 10) : null,
            Number(rollover_materials) === 1 ? 1 : 0,
            Number(rollover_assessments) === 1 ? 1 : 0,
            Number(rollover_question_bank) === 1 ? 1 : 0,
            0, // rollover_announcements permanently 0 (announcements/forums cannot be reused)
            default_rollover_visibility === 'hidden' ? 'hidden' : 'visible'
        ]);

        const newSyId = insertResult.insertId;

        // Execute Course Content Rollover if a source SY is selected
        let rolloverSummary = null;
        if (source_sy_id) {
            try {
                rolloverSummary = await academicHelper.executeContentRollover(db, {
                    sourceSyId: parseInt(source_sy_id, 10),
                    targetSyId: newSyId,
                    rolloverMaterials: Number(rollover_materials) === 1,
                    rolloverAssessments: Number(rollover_assessments) === 1,
                    rolloverQuestionBank: Number(rollover_question_bank) === 1,
                    rolloverAnnouncements: false, // Announcements & forums are cohort-specific and never rolled over
                    defaultVisibility: default_rollover_visibility,
                    adminUserId: req.user.user_id
                });
                await logActivity(req.user.user_id, 'Admin', 'ROLLOVER_SCHOOL_YEAR',
                    `Rolled over ${rolloverSummary.classesCloned} class sections, set ${rolloverSummary.materialsUpdated} materials visibility to ${default_rollover_visibility} from SY ${source_sy_id} to ${newSyId}`);
            } catch (rolloverErr) {
                console.error('[Rollover Execution Warning]', rolloverErr);
            }
        }

        // Execute Student Lifecycle & Outgoing Cohort Archival if this SY is active/Current
        let lifecycleSummary = null;
        if (activeFlag === 1) {
            let archivedOutgoing = 0;
            const shouldArchive = (archive_outgoing_cohort !== undefined && archive_outgoing_cohort !== null)
                ? (Number(archive_outgoing_cohort) === 1)
                : (Number(archive_graduating) === 1);

            if (shouldArchive) {
                try {
                    const archRes = await academicHelper.archiveOutgoingCohort(db, {
                        adminUserId: req.user.user_id,
                        sessionStore: req.sessionStore
                    });
                    archivedOutgoing = archRes.count;
                    if (archivedOutgoing > 0) {
                        await logActivity(req.user.user_id, 'Admin', 'ARCHIVE_OUTGOING_COHORT',
                            `Archived and deactivated ${archivedOutgoing} outgoing Chemistry students upon activating new SY ${cleanRange}. Records and transcripts preserved.`);
                    }
                } catch (e) {
                    console.error('[Auto Archive Outgoing Cohort Error]', e);
                }
            }

            lifecycleSummary = { archivedOutgoing };
        }

        await logActivity(req.user.user_id, 'Admin', 'CREATE_SCHOOL_YEAR',
            `Created school year: ${cleanRange} (${cleanCode}) [Status: ${finalStatus}]`);

        let successMsg = `School year ${cleanRange} created successfully!`;
        if (rolloverSummary) successMsg += ` (${rolloverSummary.classesCloned} sections rolled over with clean rosters)`;
        if (lifecycleSummary?.archivedOutgoing > 0) successMsg += ` [${lifecycleSummary.archivedOutgoing} outgoing Chemistry students archived]`;

        return res.json({
            success: true,
            sy_id: newSyId,
            rollover: rolloverSummary,
            lifecycle: lifecycleSummary,
            message: successMsg
        });

    } catch (err) {
        console.error('[AM Create SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/school-years/:id/rollover-preview
// Preview what content will be transferred/reset from a source school year.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/school-years/:id/rollover-preview', requireAdmin, async (req, res) => {
    try {
        const sourceSyId = parseInt(req.params.id, 10);
        if (isNaN(sourceSyId)) return res.json({ success: false, message: 'Invalid source school year ID.' });

        const preview = await academicHelper.previewContentRollover(db, sourceSyId);
        return res.json(preview);
    } catch (err) {
        console.error('[Rollover Preview Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id/rollover
// Manual trigger for course content rollover from source to target school year.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id/rollover', requireAdmin, async (req, res) => {
    try {
        const targetSyId = parseInt(req.params.id, 10);
        const {
            source_sy_id,
            rollover_materials = 1,
            rollover_assessments = 0,
            rollover_question_bank = 0,
            rollover_announcements = 0,
            default_rollover_visibility = 'visible'
        } = req.body;

        if (isNaN(targetSyId) || !source_sy_id) {
            return res.json({ success: false, message: 'Both source and target school year IDs are required.' });
        }

        const result = await academicHelper.executeContentRollover(db, {
            sourceSyId: parseInt(source_sy_id, 10),
            targetSyId,
            rolloverMaterials: Number(rollover_materials) === 1,
            rolloverAssessments: Number(rollover_assessments) === 1,
            rolloverQuestionBank: Number(rollover_question_bank) === 1,
            rolloverAnnouncements: false, // Announcements & forums are cohort-specific and never rolled over
            defaultVisibility: default_rollover_visibility,
            adminUserId: req.user.user_id
        });

        await logActivity(req.user.user_id, 'Admin', 'ROLLOVER_SCHOOL_YEAR',
            `Executed rollover: ${result.classesCloned} classes cloned, ${result.materialsUpdated} materials updated.`);

        return res.json({ success: true, ...result, message: 'Course content rollover completed successfully!' });
    } catch (err) {
        console.error('[Manual Rollover Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id
// Edit an existing school year's comprehensive parameters.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });

        const [[sy]] = await db.query(`SELECT * FROM school_years WHERE sy_id = ?`, [syId]);
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        const {
            sy_range,
            sy_code,
            start_date,
            end_date,
            status,
            is_active,

            sem1_start_date,
            sem1_end_date,
            q1_start_date,
            q1_end_date,
            q1_grade_deadline,
            q2_start_date,
            q2_end_date,
            q2_grade_deadline,

            sem2_start_date,
            sem2_end_date,
            q3_start_date,
            q3_end_date,
            q3_grade_deadline,
            q4_start_date,
            q4_end_date,
            q4_grade_deadline,

            sem1_enrollment_start,
            sem1_enrollment_end,
            sem2_enrollment_start,
            sem2_enrollment_end,
            enforce_prerequisite,
            passing_threshold
        } = req.body;

        // Timeline validation
        const validation = academicHelper.validateSchoolYearTimeline(req.body);
        if (!validation.valid) {
            return res.json({ success: false, message: validation.message });
        }

        const cleanRange = sy_range.trim();
        const cleanCode  = sy_code ? sy_code.trim() : (sy.sy_code || `SY${cleanRange.slice(2, 4)}-${cleanRange.slice(7, 9)}`);

        // Check duplicate range with another record
        const [[conflict]] = await db.query(
            `SELECT sy_id FROM school_years WHERE sy_range = ? AND sy_id <> ?`, [cleanRange, syId]
        );
        if (conflict) {
            return res.json({ success: false, message: `School year "${cleanRange}" already exists.` });
        }

        // Check active / status transition (canonical: Current, Draft, Archive)
        let activeFlag = sy.is_active;
        let finalStatus = academicHelper.normalizeSchoolYearStatus(status || sy.status, activeFlag);
        if (is_active !== undefined || status !== undefined) {
            activeFlag = (is_active === 1 || is_active === true || is_active === '1' || status === 'Current' || status === 'Active') ? 1 : 0;
            finalStatus = activeFlag === 1 ? 'Current' : academicHelper.normalizeSchoolYearStatus(status || sy.status, 0);
        }

        if (activeFlag === 1 && !sy.is_active) {
            // Atomically archive other active/Current years
            await db.query(`UPDATE school_years SET is_active = 0, status = 'Archive' WHERE sy_id <> ? AND (is_active = 1 OR status = 'Current')`, [syId]);
        }

        await db.query(`
            UPDATE school_years SET
                sy_range = ?,
                sy_code = ?,
                start_date = ?,
                end_date = ?,
                status = ?,
                is_active = ?,
                sem1_start_date = ?,
                sem1_end_date = ?,
                sem1_enrollment_start = ?,
                sem1_enrollment_end = ?,
                q1_start_date = ?,
                q1_end_date = ?,
                q1_grade_deadline = ?,
                q2_start_date = ?,
                q2_end_date = ?,
                q2_grade_deadline = ?,
                sem2_start_date = ?,
                sem2_end_date = ?,
                sem2_enrollment_start = ?,
                sem2_enrollment_end = ?,
                q3_start_date = ?,
                q3_end_date = ?,
                q3_grade_deadline = ?,
                q4_start_date = ?,
                q4_end_date = ?,
                q4_grade_deadline = ?,
                enforce_prerequisite = ?,
                passing_threshold = ?
            WHERE sy_id = ?
        `, [
            cleanRange,
            cleanCode,
            start_date || null,
            end_date || null,
            finalStatus,
            activeFlag,
            sem1_start_date || null,
            sem1_end_date || null,
            sem1_enrollment_start || null,
            sem1_enrollment_end || null,
            q1_start_date || null,
            q1_end_date || null,
            q1_grade_deadline || null,
            q2_start_date || null,
            q2_end_date || null,
            q2_grade_deadline || null,
            sem2_start_date || null,
            sem2_end_date || null,
            sem2_enrollment_start || null,
            sem2_enrollment_end || null,
            q3_start_date || null,
            q3_end_date || null,
            q3_grade_deadline || null,
            q4_start_date || null,
            q4_end_date || null,
            q4_grade_deadline || null,
            enforce_prerequisite !== undefined ? (Number(enforce_prerequisite) === 1 ? 1 : 0) : sy.enforce_prerequisite,
            passing_threshold !== undefined ? (Number(passing_threshold) || 75.00) : sy.passing_threshold,
            syId
        ]);

        // Cascade updated enrollment windows to classes associated with this school year
        await db.query(`
            UPDATE classes c
            JOIN subjects s ON s.subject_id = c.subject_id
            SET 
                c.enrollment_start = IF(s.semester = 2, ?, ?),
                c.enrollment_end   = IF(s.semester = 2, ?, ?)
            WHERE c.sy_id = ?
        `, [
            sem2_enrollment_start || null,
            sem1_enrollment_start || null,
            sem2_enrollment_end || null,
            sem1_enrollment_end || null,
            syId
        ]);

        await logActivity(req.user.user_id, 'Admin', 'EDIT_SCHOOL_YEAR',
            `Updated school year ID ${syId} → ${cleanRange} (${cleanCode}) [Status: ${finalStatus}]`);

        return res.json({ success: true, message: `School year ${cleanRange} updated successfully!` });

    } catch (err) {
        console.error('[AM Edit SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id/activate
// Set a school year as the Current active one (atomically sets others to Archive while preserving Drafts).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id/activate', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });

        const [[sy]] = await db.query(
            `SELECT sy_id, sy_range, sy_code FROM school_years WHERE sy_id = ?`, [syId]
        );
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        // Deactivate & Archive all others (preserve Draft status for unlaunched future years)
        await db.query(`UPDATE school_years SET is_active = 0, status = IF(status = 'Draft', 'Draft', 'Archive') WHERE sy_id <> ?`, [syId]);
        // Activate target as Current
        await db.query(`UPDATE school_years SET is_active = 1, status = 'Current' WHERE sy_id = ?`, [syId]);

        await logActivity(req.user.user_id, 'Admin', 'ACTIVATE_SCHOOL_YEAR',
            `Activated school year as Current: ${sy.sy_range} (${sy.sy_code || 'SY'})`);

        return res.json({ success: true, message: `School year ${sy.sy_range} is now Current (Active).` });

    } catch (err) {
        console.error('[AM Activate SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id/status
// Set school year status: 'Draft' | 'Current' | 'Archive'
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id/status', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        const { status } = req.body;
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });
        
        const canonicalStatus = academicHelper.normalizeSchoolYearStatus(status, 0);

        const [[sy]] = await db.query(`SELECT sy_id, sy_range, is_active FROM school_years WHERE sy_id = ?`, [syId]);
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        if (canonicalStatus === 'Current' || status === 'Active') {
            await db.query(`UPDATE school_years SET is_active = 0, status = IF(status = 'Draft', 'Draft', 'Archive') WHERE sy_id <> ?`, [syId]);
            await db.query(`UPDATE school_years SET is_active = 1, status = 'Current' WHERE sy_id = ?`, [syId]);
        } else {
            // Cannot un-activate active SY to Draft/Archive without setting another to Current first
            if (sy.is_active && canonicalStatus !== 'Current') {
                return res.json({ success: false, message: 'Cannot deactivate the currently running school year directly. Set another school year to Current first.' });
            }
            await db.query(`UPDATE school_years SET status = ?, is_active = 0 WHERE sy_id = ?`, [canonicalStatus, syId]);
        }

        await logActivity(req.user.user_id, 'Admin', 'CHANGE_SY_STATUS',
            `Changed status of school year ID ${syId} (${sy.sy_range}) to ${canonicalStatus}`);

        return res.json({ success: true, message: `Status updated to ${canonicalStatus}.` });
    } catch (err) {
        console.error('[AM Change SY Status Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/school-years/:id
// Delete a school year and all linked classes/enrollments.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/school-years/:id', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });

        const [[sy]] = await db.query(
            `SELECT sy_id, sy_range, is_active FROM school_years WHERE sy_id = ?`, [syId]
        );
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        // Block deleting the active school year
        if (sy.is_active)
            return res.json({ success: false, message: 'Cannot delete the currently active school year. Activate another one first.' });

        // Delete class_students and classes linked to this SY first (FK constraints)
        await db.query(`DELETE FROM class_students WHERE sy_id = ?`, [syId]);
        await db.query(`DELETE FROM classes WHERE sy_id = ?`, [syId]);
        await db.query(`DELETE FROM school_years WHERE sy_id = ?`, [syId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_SCHOOL_YEAR',
            `Deleted school year: ${sy.sy_range}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT ACCOUNT LIFECYCLE & DEACTIVATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/lifecycle/cohort-summary
// Fetches real-time student cohort breakdown (Grade 11, Grade 12, Active, Inactive, Dormant).
// Query: { sy_id } (optional)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/lifecycle/cohort-summary', requireAdmin, async (req, res) => {
    try {
        let activeSyId = req.query.sy_id ? parseInt(req.query.sy_id, 10) : null;
        if (!activeSyId) {
            const currentSY = await academicHelper.getCurrentSchoolYear(db);
            activeSyId = currentSY ? currentSY.sy_id : null;
        }

        const preview = await academicHelper.previewCohortTransition(db, { activeSyId });
        return res.json(preview);
    } catch (err) {
        console.error('[Lifecycle Summary Error]', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/grading-lock/override
// Grants an emergency 48-hour grade encoding extension for a specified quarter.
// Body: { sy_id, quarter_number, extension_hours = 48, reason }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/grading-lock/override', requireAdmin, async (req, res) => {
    try {
        let { sy_id, quarter_number, extension_hours = 48, reason } = req.body;
        const qNum = parseInt(quarter_number, 10);
        if (isNaN(qNum) || qNum < 1 || qNum > 4) {
            return res.status(400).json({ success: false, message: 'Valid quarter number (1-4) is required.' });
        }

        let syId = sy_id ? parseInt(sy_id, 10) : null;
        if (!syId) {
            const currentSY = await academicHelper.getCurrentSchoolYear(db);
            syId = currentSY ? currentSY.sy_id : null;
        }

        if (!syId) {
            return res.status(404).json({ success: false, message: 'Active school year not found.' });
        }

        const hours = parseInt(extension_hours, 10) || 48;
        const newDeadline = new Date(Date.now() + hours * 60 * 60 * 1000);

        const colName = `q${qNum}_grade_deadline`;
        await db.query(`UPDATE school_years SET ${colName} = ? WHERE sy_id = ?`, [newDeadline, syId]);

        const deadlineStr = newDeadline.toLocaleString('en-PH', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        await logActivity(req.user.user_id, 'Admin', 'ADMIN_GRADING_OVERRIDE',
            `Extended Quarter ${qNum} grade encoding deadline by ${hours} hours to ${deadlineStr} for SY ID ${syId}. Reason: ${reason || 'Administrative Extension'}`);

        return res.json({
            success: true,
            sy_id: syId,
            quarter_number: qNum,
            new_deadline: newDeadline,
            message: `Quarter ${qNum} grade encoding deadline extended to ${deadlineStr} (${hours} hours). Instructors may now edit assignments and grades.`
        });
    } catch (err) {
        console.error('[Grading Lock Override Error]', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});
router.post(['/lifecycle/archive-outgoing', '/lifecycle/archive-graduating'], requireAdmin, async (req, res) => {
    try {
        const result = await academicHelper.archiveOutgoingCohort(db, {
            adminUserId: req.user.user_id,
            sessionStore: req.sessionStore
        });

        if (result.count > 0) {
            await logActivity(req.user.user_id, 'Admin', 'ARCHIVE_OUTGOING_COHORT',
                `Archived and deactivated ${result.count} outgoing Chemistry student accounts. Transcripts and grades preserved.`);
        }

        return res.json(result);
    } catch (err) {
        console.error('[Archive Outgoing Error]', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/lifecycle/enforce-dormancy
// Deactivates student accounts that have ZERO section enrollments for the running school year.
// Body: { sy_id } (optional, defaults to active school year)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/lifecycle/enforce-dormancy', requireAdmin, async (req, res) => {
    try {
        let activeSyId = req.body.sy_id ? parseInt(req.body.sy_id, 10) : null;
        if (!activeSyId) {
            const currentSY = await academicHelper.getCurrentSchoolYear(db);
            activeSyId = currentSY ? currentSY.sy_id : null;
        }

        if (!activeSyId) {
            return res.json({ success: false, message: 'No active school year found to evaluate dormancy.' });
        }

        const result = await academicHelper.scanAndEnforceDormancy(db, {
            activeSyId,
            adminUserId: req.user.user_id,
            sessionStore: req.sessionStore
        });

        if (result.count > 0) {
            await logActivity(req.user.user_id, 'Admin', 'ENFORCE_DORMANCY',
                `Deactivated ${result.count} dormant unassigned student accounts for school year ID ${activeSyId}.`);
        }

        return res.json(result);
    } catch (err) {
        console.error('[Enforce Dormancy Error]', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/lifecycle/reactivate-student
// Reinstates an archived student account (sets is_active = 1).
// Body: { student_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/lifecycle/reactivate-student', requireAdmin, async (req, res) => {
    try {
        const studentId = parseInt(req.body.student_id, 10);
        if (!studentId || isNaN(studentId)) {
            return res.status(400).json({ success: false, message: 'Valid student ID is required.' });
        }

        const result = await academicHelper.reactivateStudentAccount(db, {
            studentId,
            adminUserId: req.user.user_id
        });

        await logActivity(req.user.user_id, 'Admin', 'REACTIVATE_STUDENT',
            `Reactivated student account: ${result.name} (User ID: ${result.studentId})`);

        return res.json(result);
    } catch (err) {
        console.error('[Reactivate Student Error]', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUBJECTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/subjects
// Create a new subject. Auto-generates enrollment_code if blank.
// Body: { subject_name, subject_code, semester, enrollment_code, description }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/subjects', requireAdmin, async (req, res) => {
    try {
        let { subject_name, subject_code, semester, enrollment_code, description } = req.body;

        if (!subject_name || !subject_name.trim())
            return res.json({ success: false, message: 'Subject name is required.' });

        subject_name    = subject_name.trim();
        subject_code    = subject_code    ? subject_code.trim()    : null;
        enrollment_code = enrollment_code ? enrollment_code.trim() : null;
        description     = description     ? description.trim()     : null;
        semester        = parseInt(semester, 10) || 1;

        // Auto-generate enrollment code if not provided
        if (!enrollment_code) {
            enrollment_code = crypto.randomBytes(4).toString('hex').toUpperCase();
        }

        // Check subject_code uniqueness
        if (subject_code) {
            const [[codeEx]] = await db.query(
                `SELECT subject_id FROM subjects WHERE subject_code = ?`, [subject_code]
            );
            if (codeEx)
                return res.json({ success: false, message: `Subject code "${subject_code}" is already in use.` });
        }

        const [result] = await db.query(
            `INSERT INTO subjects (subject_name, subject_code, semester, enrollment_code, description)
             VALUES (?, ?, ?, ?, ?)`,
            [subject_name, subject_code, semester, enrollment_code, description]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_SUBJECT',
            `Created subject: ${subject_name} (code: ${subject_code || 'none'})`);

        return res.json({ success: true, subject_id: result.insertId });

    } catch (err) {
        console.error('[AM Create Subject Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/subjects/:id
// Edit an existing subject.
// Body: { subject_name, subject_code, semester, enrollment_code, description }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/subjects/:id', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        let { subject_name, subject_code, semester, enrollment_code, description } = req.body;

        if (!subject_name || !subject_name.trim())
            return res.json({ success: false, message: 'Subject name is required.' });

        subject_name    = subject_name.trim();
        subject_code    = subject_code    ? subject_code.trim()    : null;
        enrollment_code = enrollment_code ? enrollment_code.trim() : null;
        description     = description     ? description.trim()     : null;
        semester        = parseInt(semester, 10) || 1;

        const [[subj]] = await db.query(`SELECT subject_id FROM subjects WHERE subject_id = ?`, [subjectId]);
        if (!subj) return res.json({ success: false, message: 'Subject not found.' });

        // Check code conflict against other records
        if (subject_code) {
            const [[codeEx]] = await db.query(
                `SELECT subject_id FROM subjects WHERE subject_code = ? AND subject_id <> ?`,
                [subject_code, subjectId]
            );
            if (codeEx)
                return res.json({ success: false, message: `Subject code "${subject_code}" is already in use.` });
        }

        await db.query(
            `UPDATE subjects SET subject_name = ?, subject_code = ?, semester = ?, enrollment_code = ?, description = ?
             WHERE subject_id = ?`,
            [subject_name, subject_code, semester, enrollment_code, description, subjectId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_SUBJECT',
            `Updated subject ID ${subjectId}: ${subject_name}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Edit Subject Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/subjects/:id
// Delete a subject and all its quarters/topics/assessments (cascade via FK).
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/subjects/:id', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        const [[subj]] = await db.query(
            `SELECT subject_id, subject_name FROM subjects WHERE subject_id = ?`, [subjectId]
        );
        if (!subj) return res.json({ success: false, message: 'Subject not found.' });

        // Delete dependent records in correct FK order:
        // student_responses → student_scores → active_sessions → assessments
        // → answer_sequences, remediation_materials → question_bank
        // → student_material_interactions → learning_materials
        // → announcements → topics → quarters → classes → subjects

        // Get all topic IDs for this subject
        const [topicRows] = await db.query(`
            SELECT t.topic_id FROM topics t
            JOIN quarters q ON q.quarter_id = t.quarter_id
            WHERE q.subject_id = ?
        `, [subjectId]);
        const topicIds = topicRows.map(r => r.topic_id);

        // Get all assessment IDs for this subject (via topics)
        const [assessRows] = topicIds.length
            ? await db.query(`SELECT assessment_id FROM assessments WHERE topic_id IN (?)`, [topicIds])
            : [[]];
        const assessIds = assessRows.map(r => r.assessment_id);

        // Get all score IDs for these assessments
        const [scoreRows] = assessIds.length
            ? await db.query(`SELECT score_id FROM student_scores WHERE assessment_id IN (?)`, [assessIds])
            : [[]];
        const scoreIds = scoreRows.map(r => r.score_id);

        // Delete / unlink dependent assessment records
        if (assessIds.length) {
            await db.query(`UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id IN (?)`, [assessIds]);
            await db.query(`DELETE FROM elementa_assessment_questions WHERE assessment_id IN (?)`, [assessIds]);
            await db.query(`DELETE FROM elementa_assessment_tickets WHERE assessment_id IN (?)`, [assessIds]);
        }
        try {
            if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
            if (assessIds.length) await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
            if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
            if (assessIds.length) await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
        } catch (_) {}
        if (assessIds.length) await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);

        // Get all question IDs for topics in this subject
        if (topicIds.length) {
            // Unlink arcade questions from topics in this subject
            try {
                await db.query(`UPDATE elementa_questions SET topic_id = NULL WHERE topic_id IN (?)`, [topicIds]);
            } catch (_) {}

            // Legacy question bank (guarded)
            try {
                const [qRows] = await db.query(
                    `SELECT question_id FROM question_bank WHERE topic_id IN (?)`, [topicIds]
                );
                const qIds = qRows.map(r => r.question_id);
                if (qIds.length) {
                    await db.query(`DELETE FROM answer_sequences WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM remediation_materials WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM student_responses WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM question_bank WHERE question_id IN (?)`, [qIds]);
                }
            } catch (_) {}

            // Get material IDs
            const [matRows] = await db.query(
                `SELECT material_id FROM learning_materials WHERE topic_id IN (?)`, [topicIds]
            );
            const matIds = matRows.map(r => r.material_id);
            if (matIds.length) {
                await db.query(`DELETE FROM student_material_interactions WHERE material_id IN (?)`, [matIds]);
                await db.query(`DELETE FROM remediation_materials WHERE material_id IN (?)`, [matIds]);
                await db.query(`DELETE FROM learning_materials WHERE material_id IN (?)`, [matIds]);
            }

            // Forum topics (forum_replies cascade via FK)
            await db.query(`DELETE FROM forum_topics WHERE topic_id IN (?)`, [topicIds]);
        }

        // Delete classes and enrollments for this subject
        const [classRows] = await db.query(`SELECT class_id FROM classes WHERE subject_id = ?`, [subjectId]);
        const classIds    = classRows.map(r => r.class_id);
        if (classIds.length) {
            await db.query(`DELETE FROM class_students WHERE class_id IN (?)`, [classIds]);
            await db.query(`DELETE FROM announcements WHERE class_id IN (?)`, [classIds]);
            await db.query(`DELETE FROM classes WHERE class_id IN (?)`, [classIds]);
        }

        // Other subject-level records
        await db.query(`DELETE FROM announcements WHERE class_id IS NULL AND teacher_id IN (SELECT user_id FROM users WHERE role='Teacher')`);
        await db.query(`DELETE FROM student_progress WHERE subject_id = ?`, [subjectId]);
        try {
            await db.query(`DELETE FROM leaderboard_history WHERE subject_id = ?`, [subjectId]);
        } catch (_) {}
        await db.query(`DELETE FROM calendar_events WHERE subject_id = ?`, [subjectId]);

        // Now delete the FK chain: topics → quarters → subject
        if (topicIds.length) await db.query(`DELETE FROM topics WHERE topic_id IN (?)`, [topicIds]);
        await db.query(`DELETE FROM quarters WHERE subject_id = ?`, [subjectId]);
        await db.query(`DELETE FROM subjects WHERE subject_id = ?`, [subjectId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_SUBJECT',
            `Deleted subject: ${subj.subject_name} (ID: ${subjectId})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Subject Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// QUARTERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/quarters
// Return all quarters (with their topics) for a given subject.
// Returns: { success: true, quarters: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/quarters', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        await topicScheduleService.evaluateNow();

        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const targetSyId = syContext?.selectedSY?.sy_id;

        const [quarters] = await db.query(
            `SELECT quarter_id, quarter_number, is_locked
             FROM quarters WHERE subject_id = ? ORDER BY quarter_number ASC`,
            [subjectId]
        );

        // Attach topics (with schedule & materials) to each quarter
        for (const q of quarters) {
            const [topics] = await db.query(
                `SELECT topic_id, quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked,
                        DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') AS auto_unlock_at,
                        DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') AS auto_lock_at
                 FROM topics WHERE quarter_id = ? ORDER BY topic_id ASC`,
                [q.quarter_id]
            );
            for (const t of topics) {
                const [mats] = await db.query(
                    `SELECT material_id, topic_id, sy_id, title, material_type, file_path_or_url, is_locked, uploaded_by
                     FROM learning_materials
                     WHERE topic_id = ? ${targetSyId ? 'AND (sy_id = ? OR sy_id IS NULL)' : ''}
                     ORDER BY material_id ASC`,
                    targetSyId ? [t.topic_id, targetSyId] : [t.topic_id]
                );
                t.materials = mats;
            }
            q.topics = topics;
        }

        return res.json({ success: true, quarters });

    } catch (err) {
        console.error('[AM Get Quarters Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/subjects/:id/quarters
// Add a new quarter to a subject.
// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/subjects/:id/quarters
// Add a new quarter to a subject with its topics.
// Body: { quarter_number, topics: [ { topic_name, topic_description, topic_objectives, video_url } ] }
// Returns: { success: true, quarter_id, topics_count } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/subjects/:id/quarters', requireAdmin, async (req, res) => {
    try {
        const subjectId     = parseInt(req.params.id, 10);
        const quarterNumber = parseInt(req.body.quarter_number, 10);
        let rawTopics       = req.body.topics;

        if (isNaN(subjectId))     return res.json({ success: false, message: 'Invalid subject ID.' });
        if (isNaN(quarterNumber) || quarterNumber < 1 || quarterNumber > 4)
            return res.json({ success: false, message: 'Quarter number must be 1–4.' });

        const [[subj]] = await db.query(`SELECT subject_id, subject_name FROM subjects WHERE subject_id = ?`, [subjectId]);
        if (!subj) return res.json({ success: false, message: 'Subject not found.' });

        // Prevent duplicate quarter numbers for same subject
        const [[dup]] = await db.query(
            `SELECT quarter_id FROM quarters WHERE subject_id = ? AND quarter_number = ?`,
            [subjectId, quarterNumber]
        );
        if (dup)
            return res.json({ success: false, message: `Quarter ${quarterNumber} already exists for this subject.` });

        // Enforce that topics cannot be empty upon creation
        if (!rawTopics || !Array.isArray(rawTopics) || rawTopics.length === 0) {
            return res.json({ success: false, message: 'A quarter cannot be created empty. At least one topic is required.' });
        }

        const validatedTopics = [];
        for (let i = 0; i < rawTopics.length; i++) {
            const t = rawTopics[i];
            const name = (t.topic_name || '').trim();
            const desc = (t.topic_description || '').trim();
            const obj  = (t.topic_objectives || '').trim();
            const video = (t.video_url || '').trim();

            if (!name) return res.json({ success: false, message: `Topic #${i + 1}: Name is required.` });
            if (!desc) return res.json({ success: false, message: `Topic #${i + 1}: Description is required.` });
            if (!obj)  return res.json({ success: false, message: `Topic #${i + 1}: Objectives are required.` });
            if (!video) return res.json({ success: false, message: `Topic #${i + 1}: Video URL is required.` });

            validatedTopics.push({ name, desc, obj, video });
        }

        // Insert Quarter
        const [qResult] = await db.query(
            `INSERT INTO quarters (subject_id, quarter_number, is_locked) VALUES (?, ?, 1)`,
            [subjectId, quarterNumber]
        );
        const newQuarterId = qResult.insertId;

        // Insert all defined topics for this quarter
        for (const t of validatedTopics) {
            await db.query(
                `INSERT INTO topics (quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked) VALUES (?, ?, ?, ?, ?, 1)`,
                [newQuarterId, t.name, t.desc, t.obj, t.video]
            );
        }

        await logActivity(req.user.user_id, 'Admin', 'CREATE_QUARTER',
            `Added Quarter ${quarterNumber} with ${validatedTopics.length} topic(s) to subject ID ${subjectId} (${subj.subject_name || ''})`);

        return res.json({ success: true, quarter_id: newQuarterId, topics_count: validatedTopics.length });

    } catch (err) {
        console.error('[AM Create Quarter Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/quarters/:id/toggle-lock
// Lock or unlock a quarter.
// Body: { is_locked: 0 | 1 }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/quarters/:id/toggle-lock', requireAdmin, async (req, res) => {
    try {
        const quarterId = parseInt(req.params.id, 10);
        const isLocked  = parseInt(req.body.is_locked, 10);

        if (isNaN(quarterId))             return res.json({ success: false, message: 'Invalid quarter ID.' });
        if (isLocked !== 0 && isLocked !== 1)
            return res.json({ success: false, message: 'is_locked must be 0 or 1.' });

        const [[q]] = await db.query(`SELECT quarter_id, quarter_number, subject_id FROM quarters WHERE quarter_id = ?`, [quarterId]);
        if (!q) return res.json({ success: false, message: 'Quarter not found.' });

        await db.query(`UPDATE quarters SET is_locked = ? WHERE quarter_id = ?`, [isLocked, quarterId]);

        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_QUARTER_LOCK',
            `Quarter ID ${quarterId} set to ${isLocked ? 'locked' : 'unlocked'}`);

        // T-30: Notify Teachers of Quarter Lock/Unlock
        try {
            const [clsRows] = await db.query(
                `SELECT DISTINCT c.teacher_id, c.class_id, s.subject_name
                 FROM classes c
                 JOIN subjects s ON c.subject_id = s.subject_id
                 WHERE c.subject_id = ? AND c.teacher_id IS NOT NULL`,
                [q.subject_id]
            );
            for (const cRow of clsRows) {
                await notificationService.dispatch({
                    recipientIds: cRow.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'curriculum_lock_changed',
                    title: `Curriculum ${isLocked ? 'Locked' : 'Unlocked'} by Admin`,
                    message: `Administrator ${isLocked ? 'locked' : 'unlocked'} Quarter ${q.quarter_number} in ${cRow.subject_name}.`,
                    targetUrl: `/teacher/class/${cRow.class_id}?tab=content`,
                    metadata: { quarterId, isLocked, classId: cRow.class_id }
                });
            }
        } catch (qLockNotifErr) {
            console.error('[Quarter Lock Notification Error]', qLockNotifErr.message);
        }

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Toggle Quarter Lock Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/quarters/:id
// Delete a quarter and all its topics, assessments, questions, and materials.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/quarters/:id', requireAdmin, async (req, res) => {
    try {
        const quarterId = parseInt(req.params.id, 10);
        if (isNaN(quarterId)) return res.json({ success: false, message: 'Invalid quarter ID.' });

        const [[q]] = await db.query(
            `SELECT quarter_id, quarter_number, subject_id FROM quarters WHERE quarter_id = ?`, [quarterId]
        );
        if (!q) return res.json({ success: false, message: 'Quarter not found.' });

        // Get all topic IDs under this quarter
        const [topicRows] = await db.query(
            `SELECT topic_id FROM topics WHERE quarter_id = ?`, [quarterId]
        );
        const topicIds = topicRows.map(r => r.topic_id);

        if (topicIds.length) {
            // Assessments under these topics
            const [assessRows] = await db.query(
                `SELECT assessment_id FROM assessments WHERE topic_id IN (?)`, [topicIds]
            );
            const assessIds = assessRows.map(r => r.assessment_id);

            if (assessIds.length) {
                await db.query(`UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id IN (?)`, [assessIds]);
                await db.query(`DELETE FROM elementa_assessment_questions WHERE assessment_id IN (?)`, [assessIds]);
                await db.query(`DELETE FROM elementa_assessment_tickets WHERE assessment_id IN (?)`, [assessIds]);
                try {
                    const [scoreRows] = await db.query(
                        `SELECT score_id FROM student_scores WHERE assessment_id IN (?)`, [assessIds]
                    );
                    const scoreIds = scoreRows.map(r => r.score_id);
                    if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
                    await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
                    if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
                    await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
                } catch (_) {}
                await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);
            }

            // Arcade Questions - unlink from deleted topics
            try {
                await db.query(`UPDATE elementa_questions SET topic_id = NULL WHERE topic_id IN (?)`, [topicIds]);
            } catch (_) {}

            // Legacy Questions (guarded)
            try {
                const [qRows] = await db.query(
                    `SELECT question_id FROM question_bank WHERE topic_id IN (?)`, [topicIds]
                );
                const qIds = qRows.map(r => r.question_id);
                if (qIds.length) {
                    await db.query(`DELETE FROM answer_sequences WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM remediation_materials WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM student_responses WHERE question_id IN (?)`, [qIds]);
                    await db.query(`DELETE FROM question_bank WHERE question_id IN (?)`, [qIds]);
                }
            } catch (_) {}

            // Materials
            const [matRows] = await db.query(
                `SELECT material_id FROM learning_materials WHERE topic_id IN (?)`, [topicIds]
            );
            const matIds = matRows.map(r => r.material_id);
            if (matIds.length) {
                await db.query(`DELETE FROM student_material_interactions WHERE material_id IN (?)`, [matIds]);
                await db.query(`DELETE FROM remediation_materials WHERE material_id IN (?)`, [matIds]);
                await db.query(`DELETE FROM learning_materials WHERE material_id IN (?)`, [matIds]);
            }

            // Forum topics (forum_replies and student_forum_done cascade)
            await db.query(`DELETE FROM forum_topics WHERE topic_id IN (?)`, [topicIds]);
            await db.query(`DELETE FROM topics WHERE topic_id IN (?)`, [topicIds]);
        }

        await db.query(`DELETE FROM quarters WHERE quarter_id = ?`, [quarterId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_QUARTER',
            `Deleted Quarter ${q.quarter_number} (ID: ${quarterId}) from subject ID ${q.subject_id}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Quarter Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// TOPICS
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeAdminScheduleDateTime(rawVal) {
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/quarters/:id/topics
// Add a new topic to a quarter.
// Body: { topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at }
// Returns: { success: true, topic_id } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/quarters/:id/topics', requireAdmin, async (req, res) => {
    try {
        const quarterId = parseInt(req.params.id, 10);
        if (isNaN(quarterId)) return res.json({ success: false, message: 'Invalid quarter ID.' });

        let { topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at } = req.body;
        if (!topic_name || !topic_name.trim())
            return res.json({ success: false, message: 'Topic name is required.' });
        if (!topic_description || !topic_description.trim())
            return res.json({ success: false, message: 'Topic description is required.' });
        if (!topic_objectives || !topic_objectives.trim())
            return res.json({ success: false, message: 'Topic objectives are required.' });
        if (!video_url || !video_url.trim())
            return res.json({ success: false, message: 'Video URL is required.' });

        topic_name = topic_name.trim();
        topic_description = topic_description.trim();
        topic_objectives = topic_objectives.trim();
        video_url = video_url.trim();

        const sched = topicScheduleService.prepareTopicSchedulePayload({
            is_locked,
            auto_unlock_at,
            auto_lock_at,
            fallbackLocked: 1
        });

        const [[q]] = await db.query(`SELECT quarter_id FROM quarters WHERE quarter_id = ?`, [quarterId]);
        if (!q) return res.json({ success: false, message: 'Quarter not found.' });

        const [result] = await db.query(
            `INSERT INTO topics (quarter_id, topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [quarterId, topic_name, topic_description, topic_objectives, video_url, sched.is_locked, sched.auto_unlock_at, sched.auto_lock_at]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_TOPIC',
            `Added topic "${topic_name}" to quarter ID ${quarterId}`);

        return res.json({
            success: true,
            topic_id: result.insertId,
            is_locked: sched.is_locked,
            auto_unlock_at: sched.auto_unlock_at,
            auto_lock_at: sched.auto_lock_at
        });

    } catch (err) {
        console.error('[AM Create Topic Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/topics/:id
// Edit an existing topic's metadata and schedule.
// Body: { topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at }
// Returns: { success: true, topic_id } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/topics/:id', requireAdmin, async (req, res) => {
    try {
        const topicId = parseInt(req.params.id, 10);
        if (isNaN(topicId)) return res.json({ success: false, message: 'Invalid topic ID.' });

        let { topic_name, topic_description, topic_objectives, video_url, is_locked, auto_unlock_at, auto_lock_at } = req.body;
        if (!topic_name || !topic_name.trim())
            return res.json({ success: false, message: 'Topic name is required.' });
        if (!topic_description || !topic_description.trim())
            return res.json({ success: false, message: 'Topic description is required.' });
        if (!topic_objectives || !topic_objectives.trim())
            return res.json({ success: false, message: 'Topic objectives are required.' });
        if (!video_url || !video_url.trim())
            return res.json({ success: false, message: 'Video URL is required.' });

        topic_name = topic_name.trim();
        topic_description = topic_description.trim();
        topic_objectives = topic_objectives.trim();
        video_url = video_url.trim();

        const [[t]] = await db.query(
            `SELECT topic_id, is_locked,
                    DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') AS auto_unlock_at,
                    DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') AS auto_lock_at
             FROM topics WHERE topic_id = ?`,
            [topicId]
        );
        if (!t) return res.json({ success: false, message: 'Topic not found.' });

        const sched = topicScheduleService.prepareTopicSchedulePayload({
            is_locked: is_locked !== undefined ? is_locked : t.is_locked,
            auto_unlock_at: auto_unlock_at !== undefined ? auto_unlock_at : t.auto_unlock_at,
            auto_lock_at: auto_lock_at !== undefined ? auto_lock_at : t.auto_lock_at,
            fallbackLocked: Number(t.is_locked)
        });

        await db.query(
            `UPDATE topics
             SET topic_name = ?, topic_description = ?, topic_objectives = ?, video_url = ?,
                 is_locked = ?, auto_unlock_at = ?, auto_lock_at = ?
             WHERE topic_id = ?`,
            [topic_name, topic_description, topic_objectives, video_url, sched.is_locked, sched.auto_unlock_at, sched.auto_lock_at, topicId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_TOPIC',
            `Updated topic ID ${topicId}: "${topic_name}"`);

        return res.json({
            success: true,
            topic_id: topicId,
            is_locked: sched.is_locked,
            auto_unlock_at: sched.auto_unlock_at,
            auto_lock_at: sched.auto_lock_at
        });

    } catch (err) {
        console.error('[AM Edit Topic Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/topics/:id/toggle-lock
// Lock or unlock a topic.
// Body: { is_locked: 0 | 1 }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/topics/:id/toggle-lock', requireAdmin, async (req, res) => {
    try {
        const topicId  = parseInt(req.params.id, 10);
        const isLocked = parseInt(req.body.is_locked, 10);

        if (isNaN(topicId))                       return res.json({ success: false, message: 'Invalid topic ID.' });
        if (isLocked !== 0 && isLocked !== 1)
            return res.json({ success: false, message: 'is_locked must be 0 or 1.' });

        const [[t]] = await db.query(
            `SELECT t.topic_id, t.topic_name, q.subject_id
             FROM topics t
             JOIN quarters q ON t.quarter_id = q.quarter_id
             WHERE t.topic_id = ?`,
            [topicId]
        );
        if (!t) return res.json({ success: false, message: 'Topic not found.' });

        const nowManila = topicScheduleService.getManilaDateTimeString();
        if (isLocked === 0) {
            await db.query(
                `UPDATE topics
                 SET is_locked = 0,
                     auto_unlock_at = CASE WHEN auto_unlock_at IS NOT NULL AND DATE_FORMAT(auto_unlock_at, '%Y-%m-%d %H:%i:%s') <= ? THEN NULL ELSE auto_unlock_at END
                 WHERE topic_id = ?`,
                [nowManila, topicId]
            );
        } else {
            await db.query(
                `UPDATE topics
                 SET is_locked = 1,
                     auto_lock_at = CASE WHEN auto_lock_at IS NOT NULL AND DATE_FORMAT(auto_lock_at, '%Y-%m-%d %H:%i:%s') <= ? THEN NULL ELSE auto_lock_at END
                 WHERE topic_id = ?`,
                [nowManila, topicId]
            );
        }

        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_TOPIC_LOCK',
            `Topic ID ${topicId} set to ${isLocked ? 'locked' : 'unlocked'}`);

        // T-30: Notify Teachers of Topic Lock/Unlock
        try {
            const [clsRows] = await db.query(
                `SELECT DISTINCT c.teacher_id, c.class_id, s.subject_name
                 FROM classes c
                 JOIN subjects s ON c.subject_id = s.subject_id
                 WHERE c.subject_id = ? AND c.teacher_id IS NOT NULL`,
                [t.subject_id]
            );
            for (const cRow of clsRows) {
                await notificationService.dispatch({
                    recipientIds: cRow.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'curriculum_lock_changed',
                    title: `Curriculum ${isLocked ? 'Locked' : 'Unlocked'} by Admin`,
                    message: `Administrator ${isLocked ? 'locked' : 'unlocked'} topic "${t.topic_name}" in ${cRow.subject_name}.`,
                    targetUrl: `/teacher/class/${cRow.class_id}?tab=content`,
                    metadata: { topicId, isLocked, classId: cRow.class_id }
                });
            }
        } catch (tLockNotifErr) {
            console.error('[Topic Lock Notification Error]', tLockNotifErr.message);
        }

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Toggle Topic Lock Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/topics/:id
// Delete a topic and all linked assessments, questions, and materials.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/topics/:id', requireAdmin, async (req, res) => {
    try {
        const topicId = parseInt(req.params.id, 10);
        if (isNaN(topicId)) return res.json({ success: false, message: 'Invalid topic ID.' });

        const [[t]] = await db.query(
            `SELECT topic_id, topic_name FROM topics WHERE topic_id = ?`, [topicId]
        );
        if (!t) return res.json({ success: false, message: 'Topic not found.' });

        // Assessments
        const [assessRows] = await db.query(
            `SELECT assessment_id FROM assessments WHERE topic_id = ?`, [topicId]
        );
        const assessIds = assessRows.map(r => r.assessment_id);
        if (assessIds.length) {
            await db.query(`UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id IN (?)`, [assessIds]);
            await db.query(`DELETE FROM elementa_assessment_questions WHERE assessment_id IN (?)`, [assessIds]);
            await db.query(`DELETE FROM elementa_assessment_tickets WHERE assessment_id IN (?)`, [assessIds]);
            try {
                const [scoreRows] = await db.query(
                    `SELECT score_id FROM student_scores WHERE assessment_id IN (?)`, [assessIds]
                );
                const scoreIds = scoreRows.map(r => r.score_id);
                if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
                await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
                if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
                await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
            } catch (_) {}
            await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);
        }

        // Arcade Questions - unlink from deleted topic
        try {
            await db.query(`UPDATE elementa_questions SET topic_id = NULL WHERE topic_id = ?`, [topicId]);
        } catch (_) {}

        // Legacy Questions (guarded)
        try {
            const [qRows] = await db.query(`SELECT question_id FROM question_bank WHERE topic_id = ?`, [topicId]);
            const qIds    = qRows.map(r => r.question_id);
            if (qIds.length) {
                await db.query(`DELETE FROM answer_sequences WHERE question_id IN (?)`, [qIds]);
                await db.query(`DELETE FROM remediation_materials WHERE question_id IN (?)`, [qIds]);
                await db.query(`DELETE FROM student_responses WHERE question_id IN (?)`, [qIds]);
                await db.query(`DELETE FROM question_bank WHERE question_id IN (?)`, [qIds]);
            }
        } catch (_) {}

        // Materials
        const [matRows] = await db.query(`SELECT material_id FROM learning_materials WHERE topic_id = ?`, [topicId]);
        const matIds    = matRows.map(r => r.material_id);
        if (matIds.length) {
            await db.query(`DELETE FROM student_material_interactions WHERE material_id IN (?)`, [matIds]);
            await db.query(`DELETE FROM remediation_materials WHERE material_id IN (?)`, [matIds]);
            await db.query(`DELETE FROM learning_materials WHERE material_id IN (?)`, [matIds]);
        }

        // Forum topics (replies + student_forum_done cascade via FK)
        await db.query(`DELETE FROM forum_topics WHERE topic_id = ?`, [topicId]);
        await db.query(`DELETE FROM topics WHERE topic_id = ?`, [topicId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_TOPIC',
            `Deleted topic "${t.topic_name}" (ID: ${topicId})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Topic Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// CLASSES
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/classes
// Return all classes for a given subject with teacher name, SY, and student count.
// Returns: { success: true, classes: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/classes', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        // Resolve School Year Context (Current live SY or ?sy_id=)
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const targetSY  = syContext.selectedSY;

        const [classes] = await db.query(`
            SELECT
                c.class_id, c.class_name, c.teacher_id, c.sy_id, c.max_capacity,
                COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                s.semester,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                sy.sy_range,
                COUNT(cs.student_id) AS student_count
            FROM classes c
            LEFT JOIN subjects s      ON s.subject_id  = c.subject_id
            LEFT JOIN users u         ON u.user_id     = c.teacher_id
            LEFT JOIN school_years sy ON sy.sy_id      = c.sy_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            WHERE c.subject_id = ? AND c.sy_id = ?
            GROUP BY c.class_id
            ORDER BY c.class_name ASC
        `, [subjectId, targetSY.sy_id]);

        return res.json({
            success: true,
            classes,
            activeSY: targetSY,
            selectedSY: targetSY,
            isHistoricalSY: syContext.isHistoricalSY,
            isDraftSY: syContext.isDraftSY
        });

    } catch (err) {
        console.error('[AM Get Classes Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/classes
// Create a new class.
// Body: { class_name, teacher_id, sy_id, subject_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/classes', requireAdmin, async (req, res) => {
    try {
        let { class_name, teacher_id, sy_id, subject_id } = req.body;

        if (!class_name || !class_name.trim())
            return res.json({ success: false, message: 'Class name is required.' });
        if (!subject_id) return res.json({ success: false, message: 'Subject ID is required.' });

        class_name = class_name.trim();
        subject_id = parseInt(subject_id, 10);
        teacher_id = teacher_id ? parseInt(teacher_id, 10) : null;
        sy_id      = sy_id      ? parseInt(sy_id, 10)      : null;

        if (isNaN(subject_id)) return res.json({ success: false, message: 'Invalid subject ID.' });

        // Validate teacher exists and is a Teacher
        if (teacher_id) {
            const [[teacher]] = await db.query(
                `SELECT user_id FROM users WHERE user_id = ? AND role = 'Teacher'`, [teacher_id]
            );
            if (!teacher) return res.json({ success: false, message: 'Selected teacher not found.' });
        }

        // Always use the currently active school year
        const [[activeSY]] = await db.query(
            `SELECT sy_id FROM school_years WHERE is_active = 1 LIMIT 1`
        );
        if (!activeSY)
            return res.json({ success: false, message: 'No active school year found. Please set an active school year first before creating a class.' });

        sy_id = activeSY.sy_id;

        // Inherit enrollment_start and enrollment_end from school year based on subject semester
        const [[subjectRow]] = await db.query(
            `SELECT semester FROM subjects WHERE subject_id = ?`, [subject_id]
        );
        const [[syRow]] = await db.query(
            `SELECT sem1_enrollment_start, sem1_enrollment_end, sem2_enrollment_start, sem2_enrollment_end FROM school_years WHERE sy_id = ?`, [sy_id]
        );
        let classEnrollStart = null;
        let classEnrollEnd = null;
        if (syRow) {
            const isSem2 = subjectRow && (subjectRow.semester == 2 || subjectRow.semester === '2' || subjectRow.semester === '2nd Semester');
            classEnrollStart = isSem2 ? syRow.sem2_enrollment_start : syRow.sem1_enrollment_start;
            classEnrollEnd   = isSem2 ? syRow.sem2_enrollment_end   : syRow.sem1_enrollment_end;
        }

        const [result] = await db.query(
            `INSERT INTO classes (class_name, teacher_id, subject_id, sy_id, enrollment_start, enrollment_end) VALUES (?, ?, ?, ?, ?, ?)`,
            [class_name, teacher_id, subject_id, sy_id, classEnrollStart, classEnrollEnd]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_CLASS',
            `Created class "${class_name}" for subject ID ${subject_id}`);

        // T-29: Notify assigned Teacher of new class
        if (teacher_id) {
            try {
                await notificationService.dispatch({
                    recipientIds: teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'high',
                    eventType: 'class_assigned_to_teacher',
                    title: `New Class Assigned: ${class_name}`,
                    message: `Administrator assigned you as the instructor for section ${class_name}.`,
                    targetUrl: `/teacher/class/${result.insertId}`,
                    metadata: { classId: result.insertId, subjectId: subject_id }
                });
            } catch (clsNotifErr) {
                console.error('[Create Class Teacher Notification Error]', clsNotifErr.message);
            }
        }

        return res.json({ success: true, class_id: result.insertId });

    } catch (err) {
        console.error('[AM Create Class Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/classes/:id
// Edit an existing class (class_name, teacher_id, sy_id).
// Body: { class_name, teacher_id, sy_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/classes/:id', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        let { class_name, teacher_id, sy_id } = req.body;
        if (!class_name || !class_name.trim())
            return res.json({ success: false, message: 'Class name is required.' });

        class_name = class_name.trim();
        teacher_id = teacher_id ? parseInt(teacher_id, 10) : null;
        sy_id      = sy_id      ? parseInt(sy_id, 10)      : null;

        const [[cls]] = await db.query(`SELECT class_id, teacher_id AS prev_teacher_id FROM classes WHERE class_id = ?`, [classId]);
        if (!cls) return res.json({ success: false, message: 'Class not found.' });

        await db.query(
            `UPDATE classes SET class_name = ?, teacher_id = ?, sy_id = ? WHERE class_id = ?`,
            [class_name, teacher_id, sy_id, classId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS',
            `Updated class ID ${classId}: "${class_name}"`);

        // T-29: Notify newly assigned Teacher if teacher_id changed
        if (teacher_id && teacher_id !== cls.prev_teacher_id) {
            try {
                await notificationService.dispatch({
                    recipientIds: teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'high',
                    eventType: 'class_assigned_to_teacher',
                    title: `New Class Assigned: ${class_name}`,
                    message: `Administrator assigned you as the instructor for section ${class_name}.`,
                    targetUrl: `/teacher/class/${classId}`,
                    metadata: { classId }
                });
            } catch (editClsNotifErr) {
                console.error('[Edit Class Teacher Notification Error]', editClsNotifErr.message);
            }
        }

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Edit Class Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/classes/:id
// Delete a class and unenroll all students from it.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/classes/:id', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        const [[cls]] = await db.query(
            `SELECT class_id, class_name FROM classes WHERE class_id = ?`, [classId]
        );
        if (!cls) return res.json({ success: false, message: 'Class not found.' });

        await db.query(`DELETE FROM class_students WHERE class_id = ?`, [classId]);
        await db.query(`DELETE FROM announcements WHERE class_id = ?`, [classId]);
        await db.query(`DELETE FROM classes WHERE class_id = ?`, [classId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_CLASS',
            `Deleted class "${cls.class_name}" (ID: ${classId})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Class Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENROLLMENT CONFIGURATION (SETTINGS & WHITELIST) - ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

// 1. GET Class Config (Settings & Whitelist)
router.get('/am/classes/:id/config', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        const [[cls]] = await db.query(
            'SELECT max_capacity, enrollment_start, enrollment_end, enrolled_count FROM classes WHERE class_id = ?',
            [classId]
        );
        if (!cls) return res.json({ success: false, message: 'Class not found.' });

        const [whitelists] = await db.query(
            'SELECT * FROM class_whitelists WHERE class_id = ? ORDER BY created_at DESC',
            [classId]
        );

        return res.json({ success: true, settings: cls, whitelists });
    } catch (err) {
        console.error('[AM Get Class Config Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// 2. POST Class Settings
router.post('/am/classes/:id/settings', requireAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        let { enrollment_start, enrollment_end, max_capacity } = req.body;

        if (enrollment_start && enrollment_end && new Date(enrollment_start) >= new Date(enrollment_end)) {
            return res.json({ success: false, message: 'Start date must be before end date.' });
        }

        await conn.beginTransaction();
        const [[cls]] = await conn.query('SELECT enrolled_count FROM classes WHERE class_id = ? FOR UPDATE', [classId]);
        if (!cls) throw new Error("Class not found.");

        if (max_capacity !== '' && max_capacity !== null && max_capacity !== undefined) {
            max_capacity = Number(max_capacity);
            if (max_capacity < 0) {
                await conn.rollback();
                return res.json({ success: false, message: "Capacity cannot be negative." });
            }
            if (max_capacity < cls.enrolled_count) {
                await conn.rollback();
                return res.json({ success: false, message: `Capacity cannot be lower than the current enrolled count (${cls.enrolled_count}).` });
            }
        } else {
            max_capacity = null;
        }

        await conn.query(
            'UPDATE classes SET enrollment_start = ?, enrollment_end = ?, max_capacity = ? WHERE class_id = ?',
            [enrollment_start || null, enrollment_end || null, max_capacity, classId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS', `Updated Enrollment Config for Class ID ${classId}`);
        await conn.commit();
        res.json({ success: true, message: "Settings updated successfully." });
    } catch (err) {
        await conn.rollback();
        console.error('[AM Class Settings Error]', err);
        res.json({ success: false, message: err.message });
    } finally {
        conn.release();
    }
});

// 3. POST Whitelist Upload
router.post('/am/classes/:id/whitelist/upload', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });

        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        const newEntries = [];
        for (const rawRow of rows) {
            // Normalise keys
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) row[k.trim().toLowerCase()] = String(v).trim();
            
            let email = row.email;
            let student_name = row.name || row.student_name || null;

            if (email) {
                email = email.toLowerCase();
                // Anti-Injection sanitization
                if (email.match(/^[=+\-@]/) || (student_name && student_name.match(/^[=+\-@]/))) continue;
                if (email.includes('@')) newEntries.push({ email, student_name });
            }
        }

        if (newEntries.length === 0) return res.json({ success: false, message: "No valid entries found." });

        const expirationDate = req.body.expirationDate;
        if (!expirationDate) return res.json({ success: false, message: "Invitation Expiration Date is required." });

        try {
            const { addedCount, invalidEmails } = await processWhitelistEntries(db, classId, newEntries, expirationDate);
            await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS', `Uploaded whitelist (${addedCount} entries) for Class ID ${classId}`);
            res.json({ 
                success: true, 
                message: `Successfully sent enrollment invitations to ${addedCount} valid students.`,
                invalidEmails 
            });
        } catch (err) {
            console.error('[AM Whitelist Helper Error]', err);
            return res.json({ success: false, message: err.message });
        }
    } catch (err) {
        console.error('[AM Whitelist Upload Error]', err);
        res.json({ success: false, message: err.message });
    }
});

// 4. POST Whitelist Manual Add
router.post('/am/classes/:id/whitelist/add', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        let { email, student_name, expirationDate } = req.body;
        if (!email) return res.json({ success: false, message: "Email is required." });
        if (!expirationDate) return res.json({ success: false, message: "Expiration Date is required." });
        
        email = email.trim().toLowerCase();
        
        if (email.match(/^[=+\-@]/) || (student_name && student_name.match(/^[=+\-@]/))) {
            return res.json({ success: false, message: "Invalid characters detected." });
        }

        try {
            const { addedCount, invalidEmails } = await processWhitelistEntries(db, classId, [{ email, student_name }], expirationDate);
            if (invalidEmails.length > 0) {
                return res.json({ success: false, message: "Student is not a registered user." });
            }
            if (addedCount === 0) {
                return res.json({ success: false, message: "Student is already in the whitelist." });
            }
            await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS', `Added ${email} to whitelist for Class ID ${classId}`);
            res.json({ success: true, message: "Invitation sent successfully." });
        } catch (err) {
            return res.json({ success: false, message: err.message });
        }
    } catch (err) {
        console.error('[AM Whitelist Add Error]', err);
        res.json({ success: false, message: err.message });
    }
});

// 5. DELETE Whitelist Manual Remove
router.delete('/am/classes/:id/whitelist/remove', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        const { email } = req.body;
        if (!email) return res.json({ success: false, message: "Email is required." });

        await db.query('DELETE FROM class_whitelists WHERE class_id = ? AND email = ?', [classId, email]);
        
        await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS', `Removed ${email} from whitelist for Class ID ${classId}`);
        res.json({ success: true, message: "Student removed from whitelist." });
    } catch (err) {
        console.error('[AM Whitelist Remove Error]', err);
        res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/classes/:id/students
// Return all students enrolled in a specific class with timeframe and class info.
// Returns: { success: true, students: [...], classInfo, isEnrollmentOpen, timeframeStatus, timeframeMessage }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/classes/:id/students', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        const [[classInfo]] = await db.query(`
            SELECT c.class_id, c.class_name, c.subject_id, c.sy_id, c.max_capacity,
                   COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                   COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                   c.enrolled_count,
                   s.subject_name, s.subject_code, s.semester, sy.sy_range,
                   CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name
            FROM classes c
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            LEFT JOIN users u ON u.user_id = c.teacher_id
            WHERE c.class_id = ?
        `, [classId]);

        if (!classInfo) return res.json({ success: false, message: 'Class not found.' });

        const now = new Date();
        let isEnrollmentOpen = true;
        let timeframeStatus = 'open';
        let timeframeMessage = 'Enrollment window is active';

        if (classInfo.enrollment_start && now < new Date(classInfo.enrollment_start)) {
            isEnrollmentOpen = false;
            timeframeStatus = 'not_started';
            const startStr = new Date(classInfo.enrollment_start).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
            timeframeMessage = `Enrollment opens on ${startStr}`;
        } else if (classInfo.enrollment_end && now > new Date(classInfo.enrollment_end)) {
            isEnrollmentOpen = false;
            timeframeStatus = 'closed';
            const endStr = new Date(classInfo.enrollment_end).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
            timeframeMessage = `Enrollment closed on ${endStr}`;
        } else if (classInfo.enrollment_end) {
            const endStr = new Date(classInfo.enrollment_end).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
            timeframeMessage = `Enrollment active until ${endStr}`;
        }

        const [students] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.email,
                u.lrn_number, u.grade_level, u.section, u.profile_pic,
                u.current_level, u.total_exp
            FROM class_students cs
            JOIN users u ON u.user_id = cs.student_id
            WHERE cs.class_id = ?
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [classId]);

        return res.json({
            success: true,
            students,
            classInfo,
            isEnrollmentOpen,
            timeframeStatus,
            timeframeMessage
        });

    } catch (err) {
        console.error('[AM Get Class Students Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/classes/:id/unenroll
// Un-enroll one or multiple students from a class with timeframe verification.
// Body: { student_ids: number[], force: boolean }
// Returns: { success: true, unEnrolledCount } | { success: false, outsideWindow: true, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/classes/:id/unenroll', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

        const rawStudentIds = req.body.student_ids;
        const studentIds = (Array.isArray(rawStudentIds) ? rawStudentIds : [rawStudentIds])
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);

        if (studentIds.length === 0) {
            return res.json({ success: false, message: 'Please select at least one student to un-enroll.' });
        }

        const [[cls]] = await db.query(`
            SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id,
                   COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                   COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                   s.subject_name, s.semester
            FROM classes c
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            WHERE c.class_id = ?
        `, [classId]);

        if (!cls) return res.json({ success: false, message: 'Class not found.' });

        const now = new Date();
        let isOutsideTimeframe = false;
        let timeframeStatus = 'open';
        let timeframeMessage = '';

        if (cls.enrollment_start && now < new Date(cls.enrollment_start)) {
            isOutsideTimeframe = true;
            timeframeStatus = 'not_started';
            timeframeMessage = `Enrollment has not started yet (scheduled to open on ${new Date(cls.enrollment_start).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}).`;
        } else if (cls.enrollment_end && now > new Date(cls.enrollment_end)) {
            isOutsideTimeframe = true;
            timeframeStatus = 'closed';
            timeframeMessage = `Enrollment closed on ${new Date(cls.enrollment_end).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}.`;
        }

        const force = req.body.force === true || req.body.force === 'true';

        if (isOutsideTimeframe && !force) {
            return res.json({
                success: false,
                outsideWindow: true,
                timeframeStatus,
                timeframeMessage,
                message: `Un-enrollment is being attempted outside the designated enrollment timeframe for section "${cls.class_name}". ${timeframeMessage}`
            });
        }

        // Fetch student names for audit logging
        const [studentRows] = await db.query(
            'SELECT user_id, CONCAT(first_name, " ", last_name) AS full_name, email FROM users WHERE user_id IN (?)',
            [studentIds]
        );
        const studentNames = studentRows.map(s => s.full_name).join(', ') || `${studentIds.length} student(s)`;

        // Perform un-enrollment
        const [delResult] = await db.query(
            'DELETE FROM class_students WHERE class_id = ? AND student_id IN (?)',
            [classId, studentIds]
        );

        // Update class enrolled_count
        await db.query(`
            UPDATE classes 
            SET enrolled_count = (SELECT COUNT(*) FROM class_students WHERE class_id = ?) 
            WHERE class_id = ?
        `, [classId, classId]);

        // Audit Log
        const timeframeNote = isOutsideTimeframe ? ' [Bypassed Inactive Enrollment Window with Admin Confirmation]' : '';
        await logActivity(
            req.user.user_id,
            'Admin',
            'UNENROLL_STUDENT',
            `Un-enrolled ${delResult.affectedRows} student(s) (${studentNames}) from class "${cls.class_name}" (${cls.subject_name || 'Subject'})${timeframeNote}`
        );

        // T-25: Notify Class Teacher of Admin Unenrollment
        if (cls.teacher_id && delResult.affectedRows > 0) {
            try {
                await notificationService.dispatch({
                    recipientIds: cls.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'roster_updated_by_admin',
                    title: `Class Roster Updated: ${cls.class_name}`,
                    message: `Administrator unenrolled ${delResult.affectedRows} student(s) (${studentNames}) from ${cls.class_name}.`,
                    targetUrl: `/teacher/class/${classId}?tab=students`,
                    metadata: { classId, action: 'unenroll', count: delResult.affectedRows }
                });
            } catch (uNotifErr) {
                console.error('[Unenroll Teacher Notification Error]', uNotifErr.message);
            }
        }

        return res.json({
            success: true,
            unEnrolledCount: delResult.affectedRows,
            message: `Successfully un-enrolled ${delResult.affectedRows} student(s) from ${cls.class_name}.`
        });

    } catch (err) {
        console.error('[AM Un-enroll Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/migrate/targets
// Returns available subjects and classes for student migration.
// Query: ?source_class_id=X
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/migrate/targets', requireAdmin, async (req, res) => {
    try {
        const sourceClassId = req.query.source_class_id ? parseInt(req.query.source_class_id, 10) : null;

        const [subjects] = await db.query(`
            SELECT subject_id, subject_name, subject_code 
            FROM subjects 
            ORDER BY subject_name ASC
        `);

        const [classes] = await db.query(`
            SELECT 
                c.class_id, c.class_name, c.subject_id, c.sy_id,
                c.max_capacity,
                COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                s.subject_name, s.subject_code, s.semester, sy.sy_range,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
            FROM classes c
            JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            LEFT JOIN users u ON u.user_id = c.teacher_id
            ORDER BY s.subject_name ASC, c.class_name ASC
        `);

        const availableClasses = sourceClassId 
            ? classes.filter(c => c.class_id !== sourceClassId)
            : classes;

        return res.json({
            success: true,
            subjects,
            classes: availableClasses
        });
    } catch (err) {
        console.error('[AM Get Migrate Targets Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/classes/:id/migrate/preview
// Verifies target class capacity, timeframe, and duplicate enrollments before migration.
// Body: { target_class_id: number, student_ids: number[] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/classes/:id/migrate/preview', requireAdmin, async (req, res) => {
    try {
        const sourceClassId = parseInt(req.params.id, 10);
        const targetClassId = parseInt(req.body.target_class_id, 10);

        if (isNaN(sourceClassId) || isNaN(targetClassId)) {
            return res.json({ success: false, message: 'Invalid class parameters.' });
        }

        const rawStudentIds = req.body.student_ids;
        const studentIds = (Array.isArray(rawStudentIds) ? rawStudentIds : [rawStudentIds])
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);

        if (studentIds.length === 0) {
            return res.json({ success: false, message: 'No students selected for migration.' });
        }

        const [[targetClass]] = await db.query(`
            SELECT 
                c.class_id, c.class_name, c.subject_id, c.sy_id,
                c.max_capacity,
                COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                s.subject_name, s.subject_code, s.semester,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
            FROM classes c
            JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            LEFT JOIN users u ON u.user_id = c.teacher_id
            WHERE c.class_id = ?
        `, [targetClassId]);

        if (!targetClass) return res.json({ success: false, message: 'Target class not found.' });

        // Check already enrolled in target class
        const [alreadyEnrolledRows] = await db.query(`
            SELECT cs.student_id, CONCAT(u.first_name, ' ', u.last_name) AS full_name
            FROM class_students cs
            JOIN users u ON u.user_id = cs.student_id
            WHERE cs.class_id = ? AND cs.student_id IN (?)
        `, [targetClassId, studentIds]);

        const alreadyEnrolledIds = alreadyEnrolledRows.map(r => r.student_id);
        const newEnrollmentCount = studentIds.length - alreadyEnrolledIds.length;
        const currentEnrolled = targetClass.current_enrolled || 0;
        const projectedEnrolled = currentEnrolled + newEnrollmentCount;
        const maxCapacity = targetClass.max_capacity;
        const willExceedCapacity = (maxCapacity !== null && maxCapacity !== undefined && maxCapacity > 0)
            ? projectedEnrolled > maxCapacity
            : false;

        // Check timeframe
        const now = new Date();
        let isOutsideTimeframe = false;
        let timeframeStatus = 'open';
        let timeframeMessage = 'Enrollment window is active';

        if (targetClass.enrollment_start && now < new Date(targetClass.enrollment_start)) {
            isOutsideTimeframe = true;
            timeframeStatus = 'not_started';
            timeframeMessage = `Enrollment opens on ${new Date(targetClass.enrollment_start).toLocaleDateString('en-PH')}`;
        } else if (targetClass.enrollment_end && now > new Date(targetClass.enrollment_end)) {
            isOutsideTimeframe = true;
            timeframeStatus = 'closed';
            timeframeMessage = `Enrollment closed on ${new Date(targetClass.enrollment_end).toLocaleDateString('en-PH')}`;
        }

        // Check Chemistry 1 prerequisite for target class
        const prerequisiteFailures = [];
        for (const sId of studentIds) {
            const prereqCheck = await academicHelper.checkStudentPrerequisite(db, sId, targetClass.subject_id);
            if (!prereqCheck.eligible) {
                const [[sUser]] = await db.query(`SELECT CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE user_id = ?`, [sId]);
                prerequisiteFailures.push({
                    studentId: sId,
                    name: sUser ? sUser.full_name : `Student #${sId}`,
                    reason: prereqCheck.reason
                });
            }
        }

        return res.json({
            success: true,
            targetClass,
            totalMigrating: studentIds.length,
            newEnrollmentCount,
            alreadyEnrolledCount: alreadyEnrolledIds.length,
            alreadyEnrolledStudents: alreadyEnrolledRows.map(r => r.full_name),
            currentEnrolled,
            maxCapacity,
            projectedEnrolled,
            willExceedCapacity,
            isOutsideTimeframe,
            timeframeStatus,
            timeframeMessage,
            hasPrerequisiteFailures: prerequisiteFailures.length > 0,
            prerequisiteFailures
        });

    } catch (err) {
        console.error('[AM Migrate Preview Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/classes/:id/migrate
// Executes student migration from source class to target class.
// Body: { target_class_id: number, student_ids: number[], remove_from_source: boolean, force: boolean }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/classes/:id/migrate', requireAdmin, async (req, res) => {
    try {
        const sourceClassId = parseInt(req.params.id, 10);
        const targetClassId = parseInt(req.body.target_class_id, 10);

        if (isNaN(sourceClassId) || isNaN(targetClassId)) {
            return res.json({ success: false, message: 'Invalid class IDs.' });
        }
        if (sourceClassId === targetClassId) {
            return res.json({ success: false, message: 'Source and target class cannot be the same.' });
        }

        const rawStudentIds = req.body.student_ids;
        const studentIds = (Array.isArray(rawStudentIds) ? rawStudentIds : [rawStudentIds])
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);

        if (studentIds.length === 0) {
            return res.json({ success: false, message: 'No students selected for migration.' });
        }

        const removeFromSource = req.body.remove_from_source === true || req.body.remove_from_source === 'true';
        const force = req.body.force === true || req.body.force === 'true';

        // Fetch source and target class details
        const [[sourceClass]] = await db.query(`
            SELECT c.class_id, c.class_name, c.teacher_id, s.subject_name
            FROM classes c
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            WHERE c.class_id = ?
        `, [sourceClassId]);

        const [[targetClass]] = await db.query(`
            SELECT c.class_id, c.class_name, c.teacher_id, c.sy_id, c.max_capacity,
                   COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
                   COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
                   s.subject_name, s.semester,
                   (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
            FROM classes c
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            WHERE c.class_id = ?
        `, [targetClassId]);

        if (!sourceClass || !targetClass) {
            return res.json({ success: false, message: 'Source or target class not found.' });
        }

        // Check already enrolled in target
        const [existingRows] = await db.query(
            'SELECT student_id FROM class_students WHERE class_id = ? AND student_id IN (?)',
            [targetClassId, studentIds]
        );
        const existingSet = new Set(existingRows.map(r => r.student_id));
        const toInsert = studentIds.filter(id => !existingSet.has(id));

        const now = new Date();
        const isOutsideTimeframe = (targetClass.enrollment_start && now < new Date(targetClass.enrollment_start)) ||
                                   (targetClass.enrollment_end && now > new Date(targetClass.enrollment_end));
        const willExceedCapacity = (targetClass.max_capacity !== null && targetClass.max_capacity > 0)
            ? (targetClass.current_enrolled + toInsert.length) > targetClass.max_capacity
            : false;

        if ((isOutsideTimeframe || willExceedCapacity) && !force) {
            return res.json({
                success: false,
                requiresConfirmation: true,
                isOutsideTimeframe,
                willExceedCapacity,
                message: 'Migration warnings require confirmation.'
            });
        }

        // Prerequisite Gate: Strict enforcement for Chemistry 2
        const eligibleStudentIds = [];
        const blockedStudents = [];
        for (const sId of toInsert) {
            const prereqCheck = await academicHelper.checkStudentPrerequisite(db, sId, targetClass.subject_id);
            if (prereqCheck.eligible) {
                eligibleStudentIds.push(sId);
            } else {
                const [[sUser]] = await db.query(`SELECT CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE user_id = ?`, [sId]);
                blockedStudents.push({
                    studentId: sId,
                    name: sUser ? sUser.full_name : `Student #${sId}`,
                    reason: prereqCheck.reason
                });
            }
        }

        if (eligibleStudentIds.length === 0 && blockedStudents.length > 0) {
            return res.json({
                success: false,
                message: `Migration blocked: None of the selected students meet the Chemistry 1 prerequisite for ${targetClass.subject_name}. ${blockedStudents[0].reason}`
            });
        }

        // Insert new enrollments into target class (only eligible students)
        if (eligibleStudentIds.length > 0) {
            const values = eligibleStudentIds.map(sid => [targetClassId, sid, targetClass.sy_id || null]);
            await db.query('INSERT INTO class_students (class_id, student_id, sy_id) VALUES ?', [values]);
        }

        // If remove_from_source is checked (Move / Transfer), only remove eligible students that migrated
        if (removeFromSource && eligibleStudentIds.length > 0) {
            await db.query(
                'DELETE FROM class_students WHERE class_id = ? AND student_id IN (?)',
                [sourceClassId, eligibleStudentIds]
            );
        }

        // Update enrolled_count on both classes
        await db.query(`
            UPDATE classes 
            SET enrolled_count = (SELECT COUNT(*) FROM class_students WHERE class_id = ?) 
            WHERE class_id = ?
        `, [targetClassId, targetClassId]);

        if (removeFromSource) {
            await db.query(`
                UPDATE classes 
                SET enrolled_count = (SELECT COUNT(*) FROM class_students WHERE class_id = ?) 
                WHERE class_id = ?
            `, [sourceClassId, sourceClassId]);
        }

        // Audit Logging
        const modeLabel = removeFromSource ? 'Moved / Transferred' : 'Advanced / Course Transitioned';
        await logActivity(
            req.user.user_id,
            'Admin',
            'MIGRATE_STUDENTS',
            `${modeLabel} ${toInsert.length} student(s) from "${sourceClass.subject_name} — ${sourceClass.class_name}" to "${targetClass.subject_name} — ${targetClass.class_name}" (${existingSet.size} already enrolled were preserved).`
        );

        // T-25: Notify Target & Source Class Teachers of Admin Roster Migration
        try {
            if (targetClass.teacher_id && toInsert.length > 0) {
                await notificationService.dispatch({
                    recipientIds: targetClass.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'roster_updated_by_admin',
                    title: `Class Roster Updated: ${targetClass.class_name}`,
                    message: `Administrator migrated ${toInsert.length} student(s) into ${targetClass.class_name} (${targetClass.subject_name || 'Course'}).`,
                    targetUrl: `/teacher/class/${targetClassId}?tab=students`,
                    metadata: { classId: targetClassId, action: 'migrate_in', count: toInsert.length }
                });
            }
            if (removeFromSource && sourceClass.teacher_id && studentIds.length > 0) {
                await notificationService.dispatch({
                    recipientIds: sourceClass.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'roster_updated_by_admin',
                    title: `Class Roster Updated: ${sourceClass.class_name}`,
                    message: `Administrator transferred ${studentIds.length} student(s) out of ${sourceClass.class_name} to ${targetClass.class_name}.`,
                    targetUrl: `/teacher/class/${sourceClassId}?tab=students`,
                    metadata: { classId: sourceClassId, action: 'migrate_out', count: studentIds.length }
                });
            }
        } catch (migNotifErr) {
            console.error('[Migrate Teacher Notification Error]', migNotifErr.message);
        }

        return res.json({
            success: true,
            migratedCount: toInsert.length,
            alreadyEnrolledCount: existingSet.size,
            removeFromSource,
            message: `Successfully migrated ${toInsert.length} student(s) to ${targetClass.subject_name} — ${targetClass.class_name}.${existingSet.size > 0 ? ` (${existingSet.size} already enrolled were kept)` : ''}`
        });

    } catch (err) {
        console.error('[AM Migrate Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT PROGRESS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/progress?class_id=&sy_id=
// Return student progress for a subject, strictly scoped to selected School Year,
// optionally filtered by class.
// Returns: { success: true, progress: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/progress', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        const classId   = req.query.class_id ? parseInt(req.query.class_id, 10) : null;

        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        // Resolve School Year Context (Current live SY or ?sy_id=)
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const targetSY  = syContext.selectedSY;

        let query, params;

        if (classId && !isNaN(classId)) {
            // Filter by specific class: only enrolled students in that class AND ensure class belongs to targetSY
            query = `
                SELECT
                    u.user_id, u.first_name, u.last_name, u.profile_pic,
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    sp.last_accessed
                FROM class_students cs
                JOIN classes c ON c.class_id = cs.class_id
                JOIN users u ON u.user_id = cs.student_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = ?
                WHERE cs.class_id = ? AND c.sy_id = ?
                ORDER BY progress_percent DESC, u.last_name ASC, u.first_name ASC
            `;
            params = [subjectId, classId, targetSY.sy_id];
        } else {
            // All students enrolled in any class for this subject strictly within targetSY!
            query = `
                SELECT DISTINCT
                    u.user_id, u.first_name, u.last_name, u.profile_pic,
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    sp.last_accessed
                FROM class_students cs
                JOIN classes c ON c.class_id = cs.class_id
                JOIN users u ON u.user_id = cs.student_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = ?
                WHERE c.subject_id = ? AND c.sy_id = ?
                ORDER BY progress_percent DESC, u.last_name ASC, u.first_name ASC
            `;
            params = [subjectId, subjectId, targetSY.sy_id];
        }

        const [progress] = await db.query(query, params);

        return res.json({
            success: true,
            progress,
            selectedSY: targetSY,
            isHistoricalSY: syContext.isHistoricalSY,
            isDraftSY: syContext.isDraftSY
        });

    } catch (err) {
        console.error('[AM Get Progress Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/announcements?sy_id=
// Return all announcements for a subject, strictly scoped to the selected School Year.
// Announcements from past school years (e.g. 2025-2026) are NEVER displayed in 2026-2027.
// Returns: { success: true, announcements: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/announcements', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        // Resolve School Year Context (Current live SY or ?sy_id=)
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const targetSY  = syContext.selectedSY;

        // Announcements strictly scoped to this subject and selected targetSY
        const [announcements] = await db.query(`
            SELECT
                a.announcement_id, a.title, a.content, a.is_priority, a.is_critical, a.scope, a.due_date,
                a.attachment_url, a.attachment_name, a.attachment_type, a.created_at,
                a.class_id, a.teacher_id, a.sy_id, a.subject_id,
                c.class_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
            FROM announcements a
            LEFT JOIN classes c ON c.class_id = a.class_id
            LEFT JOIN users u   ON u.user_id   = a.teacher_id
            WHERE (
                (c.subject_id = ? AND c.sy_id = ?)
                OR (a.class_id IS NULL AND a.subject_id = ? AND a.sy_id = ?)
                OR (a.class_id IS NULL AND a.subject_id IS NULL AND a.scope = 'global' AND a.sy_id = ?)
            )
            ORDER BY a.is_critical DESC, a.is_priority DESC, a.created_at DESC
        `, [subjectId, targetSY.sy_id, subjectId, targetSY.sy_id, targetSY.sy_id]);

        return res.json({
            success: true,
            announcements,
            selectedSY: targetSY,
            isHistoricalSY: syContext.isHistoricalSY,
            isDraftSY: syContext.isDraftSY
        });

    } catch (err) {
        console.error('[AM Get Announcements Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/announcements
// Create a new announcement for a subject/class, strictly stamped with current/selected SY.
// Body: { title, content, class_id, subject_id, is_priority, teacher_id, sy_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/announcements', requireAdmin, async (req, res) => {
    try {
        let { title, content, class_id, subject_id, is_priority, is_critical, due_date, forward_webhook, teacher_id, sy_id } = req.body;

        if (!title   || !title.trim())   return res.json({ success: false, message: 'Title is required.' });
        if (!content || !content.trim()) return res.json({ success: false, message: 'Content is required.' });

        title       = title.trim();
        content     = content.trim();
        class_id    = class_id   ? parseInt(class_id, 10)   : null;
        subject_id  = subject_id ? parseInt(subject_id, 10) : null;
        teacher_id  = teacher_id ? parseInt(teacher_id, 10) : req.user.user_id;
        is_priority = is_priority ? 1 : 0;
        is_critical = is_critical ? 1 : 0;

        // Resolve School Year Context
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, sy_id || req.query.sy_id);
        const targetSY  = syContext.selectedSY;

        let className = '';
        let targetSyId = targetSY.sy_id;
        let targetSubjId = subject_id;

        // If a class_id is given, validate it belongs to the subject and inherit sy_id
        if (class_id && subject_id) {
            const [[cls]] = await db.query(
                `SELECT class_id, class_name, sy_id, subject_id FROM classes WHERE class_id = ? AND subject_id = ?`,
                [class_id, subject_id]
            );
            if (!cls)
                return res.json({ success: false, message: 'Selected class does not belong to this subject.' });
            className = cls.class_name;
            if (cls.sy_id) targetSyId = cls.sy_id;
            targetSubjId = cls.subject_id;
        }

        const [result] = await db.query(
            `INSERT INTO announcements (class_id, teacher_id, sy_id, subject_id, title, content, is_priority, is_critical, due_date) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [class_id, teacher_id, targetSyId, targetSubjId, title, content, is_priority, is_critical, due_date || null]
        );

        if (forward_webhook) {
            const authorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Administrator';
            dispatchAnnouncementWebhook({
                announcement: {
                    title,
                    content,
                    is_critical: Boolean(is_critical),
                    due_date: due_date || null,
                    scope: class_id ? 'class' : 'subject'
                },
                classId: class_id,
                authorName,
                className: className || 'Subject Broadcast'
            }).catch(e => console.error('[Admin Webhook Dispatch Warning]:', e.message));
        }

        await logActivity(req.user.user_id, 'Admin', 'CREATE_ANNOUNCEMENT',
            `Posted announcement "${title}" for subject ID ${subject_id} in SY ${targetSyId}`);

        // T-28: Notify affected Teacher(s) of Admin Class/Subject Announcement
        try {
            let affectedClasses = [];
            if (class_id) {
                const [rows] = await db.query(
                    `SELECT class_id, class_name, teacher_id FROM classes WHERE class_id = ? AND teacher_id IS NOT NULL`,
                    [class_id]
                );
                affectedClasses = rows;
            } else if (subject_id) {
                const [rows] = await db.query(
                    `SELECT class_id, class_name, teacher_id FROM classes WHERE subject_id = ? AND sy_id = ? AND teacher_id IS NOT NULL`,
                    [subject_id, targetSyId]
                );
                affectedClasses = rows;
            }
            for (const ac of affectedClasses) {
                if (ac.teacher_id === req.user.user_id) continue;
                await notificationService.dispatch({
                    recipientIds: ac.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'system',
                    priority: is_critical ? 'urgent' : (is_priority ? 'high' : 'normal'),
                    eventType: 'admin_class_announcement',
                    title: `Admin Announcement: ${title}`,
                    message: `Admin posted an announcement for ${ac.class_name || 'your subject'}: ${content.substring(0, 100)}`,
                    targetUrl: `/teacher/class/${ac.class_id}?tab=announcements`,
                    metadata: { announcementId: result.insertId, classId: ac.class_id }
                });
            }
        } catch (annNotifErr) {
            console.error('[Admin Announcement Teacher Notification Error]', annNotifErr.message);
        }

        return res.json({ success: true, announcement_id: result.insertId, sy_id: targetSyId });

    } catch (err) {
        console.error('[AM Create Announcement Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/api/broadcast/global
// System-Wide Emergency / Campus Broadcast
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/broadcast/global', requireAdmin, announcementUpload.single('attachment'), async (req, res) => {
    try {
        const { title, content, is_critical, due_date, forward_webhook, sy_id } = req.body;
        if (!title || !title.trim() || !content || !content.trim()) {
            return res.status(400).json({ success: false, message: 'Title and content are required.' });
        }

        // Resolve School Year Context
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, sy_id || req.query.sy_id);
        const targetSY  = syContext.selectedSY;

        let attachment_url = null;
        let attachment_name = null;
        let attachment_type = null;

        if (req.file) {
            attachment_url = '/announcement_uploads/' + req.file.filename;
            attachment_name = req.file.originalname;
            attachment_type = req.file.mimetype.startsWith('image/') ? 'image' : (req.file.mimetype === 'application/pdf' ? 'pdf' : 'document');
        }

        const [result] = await db.query(
            `INSERT INTO announcements (class_id, scope, teacher_id, sy_id, title, content, is_priority, is_critical, due_date, attachment_url, attachment_name, attachment_type)
             VALUES (NULL, 'global', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            [
                req.user.user_id,
                targetSY.sy_id,
                title.trim(),
                content.trim(),
                is_critical ? 1 : 0,
                due_date || null,
                attachment_url,
                attachment_name,
                attachment_type
            ]
        );

        if (forward_webhook) {
            const authorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'System Administrator';
            dispatchAnnouncementWebhook({
                announcement: {
                    title: title.trim(),
                    content: content.trim(),
                    is_critical: Boolean(is_critical),
                    due_date: due_date || null,
                    scope: 'global',
                    attachment_url
                },
                classId: null,
                authorName,
                className: 'Global Campus Broadcast'
            }).catch(e => console.error('[Global Webhook Dispatch Warning]:', e.message));
        }

        await logActivity(req.user.user_id, 'Admin', 'GLOBAL_BROADCAST',
            `Published global broadcast: "${title}" (Critical: ${Boolean(is_critical)})`);

        // T-27: Dispatch Global Broadcast Notification to all Teachers and Students
        try {
            const [teachers] = await db.query(`SELECT user_id FROM users WHERE role = 'Teacher'`);
            if (teachers.length > 0) {
                await notificationService.dispatch({
                    recipientIds: teachers.map(t => t.user_id),
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'system',
                    priority: is_critical ? 'urgent' : 'high',
                    eventType: 'global_broadcast',
                    title: (is_critical ? '🚨 Urgent Broadcast: ' : 'Campus Broadcast: ') + title.trim(),
                    message: content.trim().substring(0, 140),
                    targetUrl: '/teacher/dashboard',
                    metadata: { announcementId: result.insertId, isCritical: Boolean(is_critical) }
                });
            }
            const [students] = await db.query(`SELECT user_id FROM users WHERE role = 'Student'`);
            if (students.length > 0) {
                await notificationService.dispatch({
                    recipientIds: students.map(s => s.user_id),
                    actorId: req.user.user_id,
                    role: 'Student',
                    category: 'system',
                    priority: is_critical ? 'urgent' : 'high',
                    eventType: 'global_broadcast',
                    title: (is_critical ? '🚨 Urgent Broadcast: ' : 'Campus Broadcast: ') + title.trim(),
                    message: content.trim().substring(0, 140),
                    targetUrl: '/dashboard',
                    metadata: { announcementId: result.insertId, isCritical: Boolean(is_critical) }
                });
            }
        } catch (gbNotifErr) {
            console.error('[Global Broadcast Notification Error]', gbNotifErr.message);
        }

        res.json({ success: true, announcement_id: result.insertId, attachment_url, attachment_name });
    } catch (err) {
        console.error('[Global Broadcast Error]:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK CONFIGURATION MANAGEMENT (Discord / Telegram)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/webhooks', requireAdmin, async (req, res) => {
    try {
        const [configs] = await db.query(`
            SELECT w.*, c.class_name 
            FROM webhook_configs w
            LEFT JOIN classes c ON w.class_id = c.class_id
            ORDER BY w.created_at DESC
        `);
        res.json({ success: true, configs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/webhooks', requireAdmin, async (req, res) => {
    try {
        const { scope, class_id, platform, webhook_url } = req.body;
        if (!platform || !webhook_url) {
            return res.status(400).json({ success: false, message: 'Platform and Webhook URL are required.' });
        }
        await db.query(
            `INSERT INTO webhook_configs (scope, class_id, platform, webhook_url, is_active)
             VALUES (?, ?, ?, ?, 1)`,
            [scope || 'global', class_id || null, platform, webhook_url.trim()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/api/webhooks/:id', requireAdmin, async (req, res) => {
    try {
        await db.query(`DELETE FROM webhook_configs WHERE config_id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/announcements/:id
// Delete an announcement.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/announcements/:id', requireAdmin, async (req, res) => {
    try {
        const annId = parseInt(req.params.id, 10);
        if (isNaN(annId)) return res.json({ success: false, message: 'Invalid announcement ID.' });

        const [[ann]] = await db.query(
            `SELECT announcement_id, title, attachment_url FROM announcements WHERE announcement_id = ?`, [annId]
        );
        if (!ann) return res.json({ success: false, message: 'Announcement not found.' });

        if (ann.attachment_url) {
            const filePath = path.join(__dirname, '..', 'public', ann.attachment_url.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (fErr) { console.warn('[Admin Unlink Attachment Warning]:', fErr.message); }
            }
        }

        await db.query(`DELETE FROM announcements WHERE announcement_id = ?`, [annId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_ANNOUNCEMENT',
            `Deleted announcement "${ann.title}" (ID: ${annId})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Announcement Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ARCADE CONFIG — LEADERBOARD HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/leaderboard
// Return leaderboard snapshot history for a subject.
// Returns: { success: true, history: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/leaderboard', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        const [history] = await db.query(`
            SELECT
                el.lb_id AS history_id,
                RANK() OVER (ORDER BY el.best_score_total DESC, el.best_level_reached DESC) AS rank_achieved,
                el.best_score_total AS total_exp_snapshot,
                el.last_played_at AS awarded_date,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM elementa_leaderboard el
            JOIN users u ON u.user_id = el.student_id
            ORDER BY el.best_score_total DESC, el.best_level_reached DESC
            LIMIT 50
        `);

        return res.json({ success: true, history });

    } catch (err) {
        console.error('[AM Get Leaderboard Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/leaderboard/:id
// Delete a leaderboard history entry.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/leaderboard/:id', requireAdmin, async (req, res) => {
    try {
        const histId = parseInt(req.params.id, 10);
        if (isNaN(histId)) return res.json({ success: false, message: 'Invalid history ID.' });

        const [[entry]] = await db.query(
            `SELECT lb_id FROM elementa_leaderboard WHERE lb_id = ?`, [histId]
        );
        if (entry) {
            await db.query(`DELETE FROM elementa_leaderboard WHERE lb_id = ?`, [histId]);
        }
        try {
            await db.query(`DELETE FROM leaderboard_history WHERE history_id = ?`, [histId]);
        } catch (_) {}

        await logActivity(req.user.user_id, 'Admin', 'DELETE_LEADERBOARD_ENTRY',
            `Deleted leaderboard history entry ID ${histId}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Leaderboard Entry Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BULK IMPORT — SUBJECTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/bulk-subjects
// Parse an uploaded Excel file and batch-create subjects.
// Excel columns: subject_name*, subject_code, semester, enrollment_code, description
// Returns: { success: true, created, skipped, errors, log[] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/bulk-subjects', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (rows.length === 0)
            return res.json({ success: false, message: 'The uploaded file contains no data rows.' });

        if (rows.length > 200)
            return res.json({ success: false, message: 'Maximum 200 subjects per import.' });

        let created = 0, skipped = 0, errors = 0;
        const log   = [];

        for (const rawRow of rows) {
            // Normalise keys (strip asterisks)
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                row[k.replace('*', '').trim()] = String(v).trim();
            }

            const { subject_name } = row;
            if (!subject_name) {
                log.push({ ok: false, msg: 'Skipped — missing subject_name.' });
                skipped++;
                continue;
            }

            try {
                // Skip if name already exists
                const [[existing]] = await db.query(
                    `SELECT subject_id FROM subjects WHERE subject_name = ?`, [subject_name]
                );
                if (existing) {
                    log.push({ ok: false, msg: `Skipped — subject already exists: "${subject_name}"` });
                    skipped++;
                    continue;
                }

                const subject_code    = row.subject_code    || null;
                const semester        = parseInt(row.semester, 10) || 1;
                const description     = row.description     || null;
                let   enrollment_code = row.enrollment_code || null;

                if (!enrollment_code) {
                    enrollment_code = crypto.randomBytes(4).toString('hex').toUpperCase();
                }

                // Check code conflict
                if (subject_code) {
                    const [[codeEx]] = await db.query(
                        `SELECT subject_id FROM subjects WHERE subject_code = ?`, [subject_code]
                    );
                    if (codeEx) {
                        log.push({ ok: false, msg: `Skipped — subject_code "${subject_code}" already in use.` });
                        skipped++;
                        continue;
                    }
                }

                await db.query(
                    `INSERT INTO subjects (subject_name, subject_code, semester, enrollment_code, description)
                     VALUES (?, ?, ?, ?, ?)`,
                    [subject_name, subject_code, semester, enrollment_code, description]
                );

                log.push({ ok: true, msg: `✔ Created: ${subject_name}` });
                created++;

            } catch (rowErr) {
                log.push({ ok: false, msg: `Error for "${subject_name}": ${rowErr.message}` });
                errors++;
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'BULK_IMPORT_SUBJECTS',
            `Bulk imported ${created} subject(s) — skipped: ${skipped}, errors: ${errors}`);

        return res.json({ success: true, created, skipped, errors, log });

    } catch (err) {
        console.error('[AM Bulk Subjects Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BULK ENROLL — STUDENTS INTO CLASS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/bulk-enroll
// Parse an uploaded Excel file and batch-enroll students into a class.
// Excel columns: lrn_number OR email (at least one is required per row)
// Body (FormData): file, class_id
// Returns: { success: true, enrolled, skipped, errors, log[] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/bulk-enroll', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });

        const classId = parseInt(req.body.class_id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'A valid class must be selected.' });

        // Enforce School Year & Class Enrollment Window
        const windowCheck = await academicHelper.checkClassEnrollmentOpen(db, classId);
        if (!windowCheck.isOpen) {
            return res.json({ success: false, message: windowCheck.message });
        }
        const cls = windowCheck.cls;

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (rows.length === 0)
            return res.json({ success: false, message: 'The uploaded file contains no data rows.' });

        let enrolled = 0, skipped = 0, errors = 0;
        const log    = [];

        for (const rawRow of rows) {
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                row[k.trim()] = String(v).trim();
            }

            const lrn   = row.lrn_number || null;
            const email = row.email      ? row.email.toLowerCase() : null;

            if (!lrn && !email) {
                log.push({ ok: false, msg: 'Skipped — row has no lrn_number or email.' });
                skipped++;
                continue;
            }

            try {
                // Find the student by LRN or email — must have google_id (fully registered)
                let student = null;
                if (lrn) {
                    const [[s]] = await db.query(
                        `SELECT user_id, google_id FROM users WHERE lrn_number = ? AND role = 'Student'`, [lrn]
                    );
                    student = s;
                }
                if (!student && email) {
                    const [[s]] = await db.query(
                        `SELECT user_id, google_id FROM users WHERE email = ? AND role = 'Student'`, [email]
                    );
                    student = s;
                }

                if (!student) {
                    log.push({ ok: false, msg: `Not found in system: ${lrn || email}` });
                    skipped++;
                    continue;
                }

                // Safety check: student must have a google_id (has completed registration)
                if (!student.google_id) {
                    log.push({ ok: false, msg: `⚠ Skipped — student "${lrn || email}" has not completed registration (no Google account linked). They cannot be enrolled yet.` });
                    skipped++;
                    continue;
                }

                // Check already enrolled in this class
                const [[alreadyIn]] = await db.query(
                    `SELECT class_id FROM class_students WHERE class_id = ? AND student_id = ?`,
                    [classId, student.user_id]
                );
                if (alreadyIn) {
                    log.push({ ok: false, msg: `Already enrolled: ${lrn || email}` });
                    skipped++;
                    continue;
                }

                // Prerequisite Gate: Chemistry 1 passing mark required for Chemistry 2
                const prereqCheck = await academicHelper.checkStudentPrerequisite(db, student.user_id, cls.subject_id);
                if (!prereqCheck.eligible) {
                    log.push({ ok: false, msg: `⚠ Skipped: ${lrn || email} — ${prereqCheck.reason}` });
                    skipped++;
                    continue;
                }

                await db.query(
                    `INSERT INTO class_students (class_id, student_id, sy_id) VALUES (?, ?, ?)`,
                    [classId, student.user_id, cls.sy_id]
                );

                log.push({ ok: true, msg: `✔ Enrolled: ${lrn || email}` });
                enrolled++;

            } catch (rowErr) {
                log.push({ ok: false, msg: `Error for ${lrn || email}: ${rowErr.message}` });
                errors++;
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'BULK_ENROLL',
            `Bulk enrolled ${enrolled} student(s) into class "${cls.class_name}" (ID: ${classId}) — skipped: ${skipped}, errors: ${errors}`);

        // T-25: Notify Class Teacher of Bulk Enrollment
        if (cls.teacher_id && enrolled > 0) {
            try {
                await notificationService.dispatch({
                    recipientIds: cls.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'roster_updated_by_admin',
                    title: `Class Roster Updated: ${cls.class_name}`,
                    message: `Administrator bulk-enrolled ${enrolled} student(s) into ${cls.class_name}.`,
                    targetUrl: `/teacher/class/${classId}?tab=students`,
                    metadata: { classId, action: 'bulk_enroll', count: enrolled }
                });
            } catch (beNotifErr) {
                console.error('[Bulk Enroll Teacher Notification Error]', beNotifErr.message);
            }
        }

        return res.json({ success: true, enrolled, skipped, errors, log });

    } catch (err) {
        console.error('[AM Bulk Enroll Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BULK TEMPLATES — DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/bulk-template?type=subject|enroll
// Download a pre-filled Excel template for academic bulk operations.
// Returns: .xlsx file download
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/bulk-template', requireAdmin, (req, res) => {
    const type = req.query.type === 'enroll' ? 'enroll' : 'subject';

    let headers, sample, sheetName;

    if (type === 'subject') {
        headers   = ['subject_name*', 'subject_code', 'semester', 'enrollment_code', 'description'];
        sample    = ['General Chemistry 1', 'GEN-CHEM-1', '1', '', 'Introductory chemistry course'];
        sheetName = 'subject_template';
    } else {
        headers   = ['lrn_number', 'email'];
        sample    = ['123456789012', 'student@example.com'];
        sheetName = 'enroll_template';
    }

    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="am_${type}_template.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});



// ═══════════════════════════════════════════════════════════════════════════════
//  ██████╗  ██████╗ ██████╗
// ██╔════╝ ██╔═══██╗██╔══██╗
// ██║  ███╗██║   ██║██████╔╝
// ██║   ██║██║▄▄ ██║██╔══██╗
// ╚██████╔╝╚██████╔╝██████╔╝
//  ╚═════╝  ╚══▀▀═╝ ╚═════╝
// GAMING & Q-BANK COMMAND CENTER — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
//  GAMING & Q-BANK COMMAND CENTER — ALL ROUTES (UPDATED)
// ═══════════════════════════════════════════════════════════════════════════════

const {
    LEVEL_MACHINES,
    TOPIC_LEVEL_MAP,
    LEVEL_TOPIC_MAP,
    resolveLevelFromTopicName,
    resolveLevelForTopicId,
    resolveTopicIdForLevel
} = require('../utils/elementaTopicLevelHelper');

const VALID_INPUT_MODES    = ['Standard', 'Periodic_Single', 'Periodic_Sequence', 'Numeric'];
const VALID_MECHANIC_TYPES = [
    'standard_mcq', 'weight_scale', 'radar_scan', 'conveyor_belt',
    'flick_sort', 'shield_calibrate', 'electric_link', 'cipher_crack',
];
const VALID_DIFFICULTIES   = ['Easy', 'Average', 'Difficult'];
const VALID_ASM_TYPES      = ['Pre-Test', 'Post-Test', 'Quiz', 'Competitive'];
const VALID_TIMER_TYPES    = ['Global', 'PerItem'];

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE LOADER
// ═══════════════════════════════════════════════════════════════════════════════

router.get(['/gaming_question_bank', '/gaming_qbank'], requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        const [[aTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE sy_id = ?`, [selectedSY.sy_id]);
        const [[qTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND sy_id = ?`, [selectedSY.sy_id]);
        const [[mTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM button_mappings`);
        const [[rTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM remediation_materials`);

        const gqStats = {
            totalAssessments : aTot ? aTot.cnt : 0,
            totalQuestions   : qTot ? qTot.cnt : 0,
            totalMappings    : mTot ? mTot.cnt : 0,
            totalRemediation : rTot ? rTot.cnt : 0,
        };

        const [assessments] = await db.query(`
            SELECT
                a.assessment_id, a.assessment_name, a.assessment_type,
                a.total_items, a.duration_minutes, a.timer_type,
                a.is_unlocked, a.start_date, a.due_date, a.competitive_enabled,
                a.question_selection_mode, a.speech_enabled,
                a.quarter_id, a.topic_id, a.teacher_id, a.sy_id,
                t.topic_name,
                q.quarter_number, q.quarter_id,
                s.subject_id, s.subject_name,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS creator_name,
                u.role AS creator_role,
                COUNT(DISTINCT egs.session_id) AS attempt_count,
                (SELECT COUNT(*) FROM elementa_assessment_questions eaq WHERE eaq.assessment_id = a.assessment_id) AS manual_item_count
            FROM assessments a
            LEFT JOIN topics   t  ON t.topic_id   = a.topic_id
            LEFT JOIN quarters q  ON q.quarter_id  = t.quarter_id
            LEFT JOIN subjects s  ON s.subject_id  = q.subject_id
            LEFT JOIN users    u  ON u.user_id     = a.teacher_id
            LEFT JOIN elementa_game_sessions egs ON egs.assessment_id = a.assessment_id
            WHERE a.sy_id = ?
            GROUP BY a.assessment_id
            ORDER BY a.assessment_id DESC
        `, [selectedSY.sy_id]);

        // Load arcade challenges exclusively from elementa_questions for the Question Bank tab
        const [questions] = await db.query(`
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
                tu.role AS teacher_role,
                t.topic_name,
                s.subject_name
            FROM elementa_questions eq
            LEFT JOIN topics t ON eq.topic_id = t.topic_id
            LEFT JOIN quarters q ON t.quarter_id = q.quarter_id
            LEFT JOIN subjects s ON q.subject_id = s.subject_id
            LEFT JOIN users vu ON eq.verified_by = vu.user_id
            LEFT JOIN users tu ON eq.teacher_id = tu.user_id
            WHERE eq.is_active = 1 AND eq.sy_id = ?
            ORDER BY eq.level_number ASC, eq.question_id DESC
        `, [selectedSY.sy_id]);

        const [buttonMappings] = await db.query(
            `SELECT mapping_id, button_pin, element_symbol, player_side
             FROM button_mappings ORDER BY player_side ASC, button_pin ASC`
        );

        const [topics] = await db.query(`
            SELECT
                t.topic_id, t.topic_name, t.topic_description, t.topic_objectives, t.video_url, t.is_locked,
                q.quarter_number, q.quarter_id,
                s.subject_name, s.subject_id
            FROM topics t
            JOIN quarters q ON q.quarter_id = t.quarter_id
            JOIN subjects s ON s.subject_id  = q.subject_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, t.topic_id ASC
        `);

        const [materials] = await db.query(
            `SELECT material_id, title, material_type, topic_id
             FROM learning_materials WHERE sy_id = ? ORDER BY title ASC`,
            [selectedSY.sy_id]
        );

        const [remediationList] = await db.query(`
            SELECT
                rm.rem_id, rm.question_id, rm.material_id,
                rm.advice_text, rm.link_url, rm.created_at,
                LEFT(COALESCE(eq.prompt, 'Arcade Question'), 60) AS question_text,
                lm.title AS material_title
            FROM remediation_materials rm
            LEFT JOIN elementa_questions eq ON eq.question_id = rm.question_id
            LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
            ORDER BY rm.created_at DESC
            LIMIT 200
        `);

        const [pendingQuestions] = await db.query(`
            SELECT
                eq.question_id,
                eq.prompt AS question_text,
                COALESCE(eq.difficulty, 'Easy') AS difficulty,
                'Standard' AS input_mode,
                eq.machine_name AS mechanic_type,
                eq.points AS base_exp,
                eq.verification_status,
                eq.verified_at,
                eq.rejection_reason,
                0 AS is_ai_generated,
                eq.topic_id,
                COALESCE(t.topic_name, eq.topic) AS topic_name,
                CONCAT(teacher.first_name, ' ', teacher.last_name) AS teacher_name,
                CONCAT(verifier.first_name, ' ', verifier.last_name) AS verified_by_name
            FROM elementa_questions eq
            LEFT JOIN topics t ON t.topic_id = eq.topic_id
            LEFT JOIN users teacher  ON teacher.user_id  = eq.teacher_id
            LEFT JOIN users verifier ON verifier.user_id = eq.verified_by
            WHERE eq.is_active = 1 AND eq.sy_id = ?
            ORDER BY
                FIELD(eq.verification_status, 'Pending', 'Approved', 'Rejected'),
                eq.question_id DESC
        `, [selectedSY.sy_id]);

        const [interactionLog] = await db.query(`
            SELECT
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                lm.title AS material_title
            FROM student_material_interactions smi
            JOIN users u ON u.user_id = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            ORDER BY smi.interacted_at DESC
            LIMIT 200
        `);

        const [subjectsList] = await db.query(`
            SELECT DISTINCT s.subject_id, s.subject_name, s.subject_code
            FROM subjects s
            ORDER BY s.subject_name ASC
        `);
        const [quartersList] = await db.query(`
            SELECT q.quarter_id, q.quarter_number, q.subject_id
            FROM quarters q
            ORDER BY q.subject_id ASC, q.quarter_number ASC
        `);

        const [teachersList] = await db.query(`
            SELECT user_id, first_name, last_name, role, email
            FROM users
            WHERE role IN ('Teacher', 'Admin')
            ORDER BY role ASC, first_name ASC
        `);

        res.render('admin/gaming_qbank', {
            user: req.user,
            gqStats,
            assessments,
            questions,
            buttonMappings,
            topics,
            materials,
            remediationList,
            interactionLog,
            pendingQuestions,
            subjectsList,
            quartersList,
            teachersList,
            LEVEL_MACHINES,
            LEVEL_TOPIC_MAP,
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY
        });

    } catch (err) {
        console.error('[GQB GET Error]', err);
        res.status(500).send('Server error loading Gaming & Q-Bank: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — ASSESSMENTS (Two-Tier Management & Global System Capabilities)
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/gqb/assessments/:id
// Returns complete assessment record including manual question selections and points.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gqb/assessments/:id', requireAdmin, async (req, res) => {
    try {
        const asmId = parseInt(req.params.id, 10);
        if (isNaN(asmId)) return res.json({ success: false, message: 'Invalid assessment ID.' });

        const [[asm]] = await db.query(`
            SELECT a.*, t.topic_name, q.quarter_number, q.quarter_id, s.subject_id, s.subject_name
            FROM assessments a
            LEFT JOIN topics t ON t.topic_id = a.topic_id
            LEFT JOIN quarters q ON q.quarter_id = t.quarter_id
            LEFT JOIN subjects s ON s.subject_id = q.subject_id
            WHERE a.assessment_id = ?
        `, [asmId]);

        if (!asm) return res.json({ success: false, message: 'Assessment not found.' });

        const [manualQuestions] = await db.query(`
            SELECT eaq.eaq_id, eaq.question_id, eaq.sort_order, eaq.custom_points,
                   eq.question_code, eq.machine_name, eq.prompt, eq.answer_text,
                   COALESCE(eq.difficulty, 'Easy') AS difficulty, eq.points AS base_points, eq.time_limit_s
            FROM elementa_assessment_questions eaq
            JOIN elementa_questions eq ON eq.question_id = eaq.question_id
            WHERE eaq.assessment_id = ?
            ORDER BY eaq.sort_order ASC
        `, [asmId]);

        asm.manual_questions = manualQuestions || [];
        return res.json({ success: true, assessment: asm });
    } catch (err) {
        console.error('[GQB Get Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/gqb/topics/:topic_id/questions-pool
// Returns available verified questions for a topic with pool shortage count.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gqb/topics/:topic_id/questions-pool', requireAdmin, async (req, res) => {
    try {
        const topicId = parseInt(req.params.topic_id, 10);
        if (isNaN(topicId)) return res.json({ success: false, message: 'Invalid topic ID.' });

        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const targetSyId = syContext?.selectedSY?.sy_id;

        const levelNumber = await resolveLevelForTopicId(db, topicId);

        const [questions] = await db.query(`
            SELECT question_id, question_code, level_number, topic, machine_name,
                   prompt, answer_text, time_limit_s, points,
                   COALESCE(difficulty, 'Easy') AS difficulty
            FROM elementa_questions
            WHERE (topic_id = ? OR (level_number IS NOT NULL AND level_number = ?))
              AND is_active = 1 AND verification_status = 'Approved'
              AND sy_id = ?
            ORDER BY display_order ASC, question_id ASC
        `, [topicId, levelNumber, targetSyId]);

        return res.json({
            success: true,
            topic_id: topicId,
            level_number: levelNumber,
            count: questions.length,
            questions
        });
    } catch (err) {
        console.error('[GQB Topic Questions Pool Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/gqb/assessments
// Create assessment with random/manual mode, dates, competitive mode, and question junctions.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/gqb/assessments', requireAdmin, async (req, res) => {
    try {
        let {
            assessment_name, assessment_type, topic_id, total_items, duration_minutes,
            timer_type, is_unlocked, start_date, due_date, competitive_enabled,
            question_selection_mode = 'random', selected_questions = []
        } = req.body;

        topic_id = parseInt(topic_id, 10);
        if (!topic_id || isNaN(topic_id)) return res.json({ success: false, message: 'A valid topic is required.' });
        if (!VALID_ASM_TYPES.includes(assessment_type)) return res.json({ success: false, message: `assessment_type must be one of: ${VALID_ASM_TYPES.join(', ')}.` });
        if (!VALID_TIMER_TYPES.includes(timer_type)) return res.json({ success: false, message: `timer_type must be Global or PerItem.` });

        total_items      = parseInt(total_items, 10)      || 10;
        duration_minutes = parseInt(duration_minutes, 10) || 30;
        is_unlocked      = (is_unlocked === 1 || is_unlocked === '1' || is_unlocked === true) ? 1 : 0;
        competitive_enabled = (competitive_enabled === 1 || competitive_enabled === '1' || competitive_enabled === true || assessment_type === 'Competitive') ? 1 : 0;
        const qMode = question_selection_mode === 'manual' ? 'manual' : 'random';

        if (total_items < 1 || total_items > 200) return res.json({ success: false, message: 'total_items must be between 1 and 200.' });
        if (duration_minutes < 1 || duration_minutes > 180) return res.json({ success: false, message: 'duration_minutes must be between 1 and 180.' });

        const [[topic]] = await db.query(`SELECT topic_id, quarter_id FROM topics WHERE topic_id = ?`, [topic_id]);
        if (!topic) return res.json({ success: false, message: 'Selected topic does not exist.' });

        if (qMode === 'manual' && (!Array.isArray(selected_questions) || selected_questions.length === 0)) {
            return res.json({ success: false, message: 'Manual selection mode requires at least one question selected.' });
        }

        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.body.sy_id);
        const targetSyId = (syContext && syContext.selectedSY) ? syContext.selectedSY.sy_id : null;

        const effectiveTotalItems = qMode === 'manual' ? selected_questions.length : total_items;

        const [result] = await db.query(`
            INSERT INTO assessments (
                sy_id, quarter_id, topic_id, assessment_name, assessment_type,
                total_items, duration_minutes, timer_type, is_unlocked,
                start_date, due_date, competitive_enabled, question_selection_mode, teacher_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            targetSyId, topic.quarter_id, topic_id,
            assessment_name ? assessment_name.trim().substring(0, 100) : null,
            assessment_type, effectiveTotalItems, duration_minutes, timer_type,
            is_unlocked, start_date || null, due_date || null,
            competitive_enabled, qMode, req.user.user_id
        ]);

        const newAssessmentId = result.insertId;

        // If manual mode, persist selected questions into elementa_assessment_questions
        if (qMode === 'manual' && Array.isArray(selected_questions) && selected_questions.length > 0) {
            for (let i = 0; i < selected_questions.length; i++) {
                const sq = selected_questions[i];
                await db.query(`
                    INSERT INTO elementa_assessment_questions (assessment_id, question_id, sort_order, custom_points)
                    VALUES (?, ?, ?, ?)
                `, [newAssessmentId, parseInt(sq.question_id, 10), i + 1, parseInt(sq.custom_points, 10) || 1]);
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'CREATE_ASSESSMENT', `Created assessment: "${assessment_name || 'Unnamed'}" (ID: ${newAssessmentId}, Mode: ${qMode})`);
        return res.json({ success: true, assessment_id: newAssessmentId });

    } catch (err) {
        console.error('[GQB Create Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/gqb/assessments/:id
// Update assessment settings, dates, competitive flag, and manual question list.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/gqb/assessments/:id', requireAdmin, async (req, res) => {
    try {
        const asmId = parseInt(req.params.id, 10);
        if (isNaN(asmId)) return res.json({ success: false, message: 'Invalid assessment ID.' });

        let {
            assessment_name, assessment_type, topic_id, total_items, duration_minutes,
            timer_type, is_unlocked, start_date, due_date, competitive_enabled,
            question_selection_mode = 'random', selected_questions = []
        } = req.body;

        topic_id = topic_id ? parseInt(topic_id, 10) : null;
        if (assessment_type && !VALID_ASM_TYPES.includes(assessment_type)) return res.json({ success: false, message: `Invalid assessment_type.` });
        if (timer_type && !VALID_TIMER_TYPES.includes(timer_type)) return res.json({ success: false, message: `Invalid timer_type.` });

        total_items      = parseInt(total_items, 10)      || 10;
        duration_minutes = parseInt(duration_minutes, 10) || 30;
        is_unlocked      = (is_unlocked === 1 || is_unlocked === '1' || is_unlocked === true) ? 1 : 0;
        competitive_enabled = (competitive_enabled === 1 || competitive_enabled === '1' || competitive_enabled === true || assessment_type === 'Competitive') ? 1 : 0;
        const qMode = question_selection_mode === 'manual' ? 'manual' : 'random';

        const [[asm]] = await db.query(`SELECT assessment_id FROM assessments WHERE assessment_id = ?`, [asmId]);
        if (!asm) return res.json({ success: false, message: 'Assessment not found.' });

        let quarter_id = null;
        if (topic_id) {
            const [[t]] = await db.query(`SELECT quarter_id FROM topics WHERE topic_id = ?`, [topic_id]);
            if (!t) return res.json({ success: false, message: 'Selected topic not found.' });
            quarter_id = t.quarter_id;
        }

        const effectiveTotalItems = (qMode === 'manual' && Array.isArray(selected_questions) && selected_questions.length > 0)
            ? selected_questions.length
            : total_items;

        await db.query(`
            UPDATE assessments
            SET assessment_name = ?, assessment_type = ?, topic_id = ?,
                quarter_id = COALESCE(?, quarter_id), total_items = ?, duration_minutes = ?,
                timer_type = ?, is_unlocked = ?, start_date = ?, due_date = ?,
                competitive_enabled = ?, question_selection_mode = ?
            WHERE assessment_id = ?
        `, [
            assessment_name ? assessment_name.trim().substring(0, 100) : null,
            assessment_type || 'Quiz', topic_id || null, quarter_id,
            effectiveTotalItems, duration_minutes, timer_type || 'Global',
            is_unlocked, start_date || null, due_date || null,
            competitive_enabled, qMode, asmId
        ]);

        // Sync manual questions
        if (qMode === 'manual' && Array.isArray(selected_questions)) {
            await db.query(`DELETE FROM elementa_assessment_questions WHERE assessment_id = ?`, [asmId]);
            for (let i = 0; i < selected_questions.length; i++) {
                const sq = selected_questions[i];
                await db.query(`
                    INSERT INTO elementa_assessment_questions (assessment_id, question_id, sort_order, custom_points)
                    VALUES (?, ?, ?, ?)
                `, [asmId, parseInt(sq.question_id, 10), i + 1, parseInt(sq.custom_points, 10) || 1]);
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'EDIT_ASSESSMENT', `Updated assessment ID ${asmId} (Mode: ${qMode})`);
        return res.json({ success: true, assessment_id: asmId });

    } catch (err) {
        console.error('[GQB Edit Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.post('/gqb/assessments/:id/toggle-lock', requireAdmin, async (req, res) => {
    try {
        const asmId = parseInt(req.params.id, 10);
        if (isNaN(asmId)) return res.json({ success: false, message: 'Invalid assessment ID.' });

        const [[asm]] = await db.query(`SELECT assessment_id, is_unlocked, assessment_name FROM assessments WHERE assessment_id = ?`, [asmId]);
        if (!asm) return res.json({ success: false, message: 'Assessment not found.' });

        const newVal = asm.is_unlocked ? 0 : 1;
        await db.query(`UPDATE assessments SET is_unlocked = ? WHERE assessment_id = ?`, [newVal, asmId]);
        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_ASSESSMENT_LOCK', `Assessment "${asm.assessment_name}" set to ${newVal ? 'unlocked' : 'locked'}`);
        return res.json({ success: true, is_unlocked: newVal });

    } catch (err) {
        console.error('[GQB Toggle Lock Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.delete('/gqb/assessments/:id', requireAdmin, async (req, res) => {
    try {
        const asmId = parseInt(req.params.id, 10);
        if (isNaN(asmId)) return res.json({ success: false, message: 'Invalid assessment ID.' });

        const [[asm]] = await db.query(`SELECT assessment_id, assessment_name FROM assessments WHERE assessment_id = ?`, [asmId]);
        if (!asm) return res.json({ success: false, message: 'Assessment not found.' });

        await db.query(`UPDATE elementa_game_sessions SET assessment_id = NULL WHERE assessment_id = ?`, [asmId]);
        await db.query(`DELETE FROM elementa_assessment_questions WHERE assessment_id = ?`, [asmId]);
        await db.query(`DELETE FROM elementa_assessment_tickets WHERE assessment_id = ?`, [asmId]);
        try {
            const [scoreRows] = await db.query(`SELECT score_id FROM student_scores WHERE assessment_id = ?`, [asmId]);
            const scoreIds = scoreRows.map(r => r.score_id);
            if (scoreIds.length) {
                await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
                await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
            }
            await db.query(`DELETE FROM active_sessions WHERE assessment_id = ?`, [asmId]);
            await db.query(`DELETE FROM competitive_matches WHERE assessment_id = ?`, [asmId]);
        } catch (_) {}
        await db.query(`DELETE FROM assessments WHERE assessment_id = ?`, [asmId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_ASSESSMENT', `Deleted assessment "${asm.assessment_name}" (ID: ${asmId})`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Delete Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ARCADE LAB QUESTION BANK (elementa_questions)
// Admin-created / edited questions are auto-approved for Godot arcade sessions.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/questions', requireAdmin, async (req, res) => {
    try {
        const result = await _upsertElementaQuestion(req, null);
        return res.json(result);
    } catch (err) {
        console.error('[GQB Create Arcade Question Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.put('/gqb/questions/:id', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });
        const result = await _upsertElementaQuestion(req, qId);
        return res.json(result);
    } catch (err) {
        console.error('[GQB Edit Arcade Question Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

async function _upsertElementaQuestion(req, qId) {
    const {
        topic_id, level_number, question_code, prompt, question_text,
        answer_text, machine_name, machine_id, time_limit_s, points,
        difficulty, steps_json, verification_status, teacher_id
    } = req.body;

    const actualPrompt = prompt || question_text;
    if (!actualPrompt || !actualPrompt.trim()) {
        return { success: false, message: 'Challenge prompt / customer narrative is required.' };
    }
    if (!answer_text || !String(answer_text).trim()) {
        return { success: false, message: 'Target answer / solution is required.' };
    }

    const actualLevel = parseInt(level_number, 10) || (topic_id ? await resolveLevelForTopicId(db, topic_id) : 1) || 1;
    const machineInfo = LEVEL_MACHINES[actualLevel] || { name: machine_name || 'Chemistry Station', id: actualLevel, topic: 'Chemistry' };
    const actualMachineName = machine_name || machineInfo.name;
    const actualMachineId = parseInt(machine_id, 10) || machineInfo.id;
    const actualTopic = machineInfo.topic;
    const actualTopicId = topic_id ? parseInt(topic_id, 10) : (await resolveTopicIdForLevel(db, actualLevel));

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
        finalStepsJson = JSON.stringify([{ type: 'pick_seq', answer: String(answer_text).split('+'), label: 'Reagent steps' }]);
    }

    const targetDifficulty = ['Easy', 'Average', 'Difficult'].includes(difficulty) ? difficulty : 'Easy';
    const targetPoints = Math.max(1, Math.min(100, parseInt(points, 10) || 1));
    const targetTime = Math.max(5, Math.min(600, parseFloat(time_limit_s) || 90.0));
    const targetStatus = verification_status || 'Approved';

    let questionId;
    if (!qId) {
        const creatorId = teacher_id ? parseInt(teacher_id, 10) : req.user.user_id;
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.body.sy_id || req.query.sy_id);
        const targetSyId = syContext?.selectedSY?.sy_id || null;
        const [[maxOrderRow]] = await db.query(
            `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM elementa_questions WHERE level_number = ?`,
            [actualLevel]
        );
        const nextDisplayOrder = Number(maxOrderRow?.next_order) || 1;
        const [result] = await db.query(`
            INSERT INTO elementa_questions
                (sy_id, teacher_id, question_code, level_number, topic_id, topic,
                 machine_name, machine_id, prompt, answer_text, steps_json,
                 time_limit_s, points, difficulty, display_order, verification_status, verified_by, verified_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)
        `, [
            targetSyId,
            creatorId,
            qCode,
            actualLevel,
            actualTopicId,
            actualTopic,
            actualMachineName,
            actualMachineId,
            actualPrompt.trim(),
            String(answer_text).trim(),
            finalStepsJson,
            targetTime,
            targetPoints,
            targetDifficulty,
            nextDisplayOrder,
            targetStatus,
            req.user.user_id
        ]);
        questionId = result.insertId;
        await logActivity(req.user.user_id, 'Admin', 'CREATE_ARCADE_QUESTION', `Created arcade question ${qCode} (Level ${actualLevel}: ${actualMachineName})`);
    } else {
        await db.query(`
            UPDATE elementa_questions
            SET level_number        = ?,
                topic_id            = ?,
                topic               = ?,
                machine_name        = ?,
                machine_id          = ?,
                prompt              = ?,
                answer_text         = ?,
                steps_json          = ?,
                time_limit_s        = ?,
                points              = ?,
                difficulty          = ?,
                verification_status = ?,
                verified_by         = ?,
                verified_at         = NOW()
            WHERE question_id = ?
        `, [
            actualLevel,
            actualTopicId,
            actualTopic,
            actualMachineName,
            actualMachineId,
            actualPrompt.trim(),
            String(answer_text).trim(),
            finalStepsJson,
            targetTime,
            targetPoints,
            targetDifficulty,
            targetStatus,
            req.user.user_id,
            qId
        ]);
        questionId = qId;
        await logActivity(req.user.user_id, 'Admin', 'EDIT_ARCADE_QUESTION', `Updated arcade question ID ${qId} (${qCode})`);
    }

    return { success: true, question_id: questionId, question_code: qCode };
}

router.delete('/gqb/questions/:id', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });

        const [[q]] = await db.query(`SELECT question_id, question_code, prompt FROM elementa_questions WHERE question_id = ?`, [qId]);
        if (!q) return res.json({ success: false, message: 'Question not found.' });

        await db.query(`UPDATE elementa_questions SET is_active = 0 WHERE question_id = ?`, [qId]);
        await logActivity(req.user.user_id, 'Admin', 'DELETE_ARCADE_QUESTION', `Deactivated arcade question ID ${qId} (${q.question_code || ''})`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Delete Arcade Question Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.post('/gqb/questions/bulk-delete', requireAdmin, async (req, res) => {
    try {
        const ids = req.body.ids;
        if (!ids || !Array.isArray(ids) || !ids.length) {
            return res.json({ success: false, message: 'No question IDs provided.' });
        }
        const placeholders = ids.map(() => '?').join(',');
        await db.query(`UPDATE elementa_questions SET is_active = 0 WHERE question_id IN (${placeholders})`, ids);
        await logActivity(req.user.user_id, 'Admin', 'BULK_DELETE_ARCADE_QUESTIONS', `Deactivated ${ids.length} arcade questions`);
        return res.json({ success: true, count: ids.length });
    } catch (err) {
        console.error('[GQB Bulk Delete Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.post('/gqb/questions/bulk-approve', requireAdmin, async (req, res) => {
    try {
        const ids = req.body.ids;
        if (!ids || !Array.isArray(ids) || !ids.length) {
            return res.json({ success: false, message: 'No question IDs provided.' });
        }
        const placeholders = ids.map(() => '?').join(',');
        const [authorRows] = await db.query(
            `SELECT teacher_id, COUNT(*) AS cnt
             FROM elementa_questions
             WHERE question_id IN (${placeholders}) AND teacher_id IS NOT NULL AND verification_status != 'Approved'
             GROUP BY teacher_id`,
            ids
        );
        await db.query(`
            UPDATE elementa_questions 
            SET verification_status = 'Approved', verified_by = ?, verified_at = NOW(), rejection_reason = NULL 
            WHERE question_id IN (${placeholders})
        `, [req.user.user_id, ...ids]);
        await logActivity(req.user.user_id, 'Admin', 'BULK_APPROVE_ARCADE_QUESTIONS', `Approved ${ids.length} arcade questions`);

        // T-16: Notify Teacher(s) of Bulk Question Approval
        try {
            for (const row of authorRows) {
                await notificationService.dispatch({
                    recipientIds: row.teacher_id,
                    actorId: req.user.user_id,
                    role: 'Teacher',
                    category: 'academic',
                    priority: 'normal',
                    eventType: 'question_bulk_approved',
                    title: 'Arcade Questions Approved',
                    message: `Admin approved ${row.cnt} of your submitted Arcade question(s).`,
                    targetUrl: '/teacher/question-bank?tab=status&sub=approved',
                    metadata: { count: row.cnt }
                });
            }
        } catch (bulkAppNotifErr) {
            console.error('[Bulk Approve Question Notification Error]', bulkAppNotifErr.message);
        }

        return res.json({ success: true, count: ids.length });
    } catch (err) {
        console.error('[GQB Bulk Approve Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — HARDWARE MAPPER
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/mappings', requireAdmin, async (req, res) => {
    try {
        const button_pin     = parseInt(req.body.button_pin, 10);
        const element_symbol = req.body.element_symbol ? req.body.element_symbol.trim().substring(0, 10) : null;
        const player_side    = parseInt(req.body.player_side, 10);

        if (isNaN(button_pin) || button_pin < 0 || button_pin > 40) return res.json({ success: false, message: 'button_pin must be 0–40 (GPIO range).' });
        if (!element_symbol) return res.json({ success: false, message: 'element_symbol is required.' });
        if (player_side !== 1 && player_side !== 2) return res.json({ success: false, message: 'player_side must be 1 or 2.' });

        const [[dup]] = await db.query(`SELECT mapping_id FROM button_mappings WHERE button_pin = ? AND player_side = ?`, [button_pin, player_side]);
        if (dup) return res.json({ success: false, message: `GPIO ${button_pin} is already mapped for Player ${player_side}.` });

        const [result] = await db.query(`INSERT INTO button_mappings (button_pin, element_symbol, player_side) VALUES (?, ?, ?)`, [button_pin, element_symbol, player_side]);
        await logActivity(req.user.user_id, 'Admin', 'CREATE_BUTTON_MAPPING', `Mapped GPIO ${button_pin} → "${element_symbol}" (P${player_side})`);
        return res.json({ success: true, mapping_id: result.insertId });

    } catch (err) {
        console.error('[GQB Create Mapping Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.put('/gqb/mappings/:id', requireAdmin, async (req, res) => {
    try {
        const mapId = parseInt(req.params.id, 10);
        if (isNaN(mapId)) return res.json({ success: false, message: 'Invalid mapping ID.' });

        const button_pin     = parseInt(req.body.button_pin, 10);
        const element_symbol = req.body.element_symbol ? req.body.element_symbol.trim().substring(0, 10) : null;
        const player_side    = parseInt(req.body.player_side, 10);

        if (isNaN(button_pin) || button_pin < 0 || button_pin > 40) return res.json({ success: false, message: 'button_pin must be 0–40.' });
        if (!element_symbol) return res.json({ success: false, message: 'element_symbol is required.' });
        if (player_side !== 1 && player_side !== 2) return res.json({ success: false, message: 'player_side must be 1 or 2.' });

        const [[existing]] = await db.query(`SELECT mapping_id FROM button_mappings WHERE mapping_id = ?`, [mapId]);
        if (!existing) return res.json({ success: false, message: 'Mapping not found.' });

        const [[dupConflict]] = await db.query(`SELECT mapping_id FROM button_mappings WHERE button_pin = ? AND player_side = ? AND mapping_id <> ?`, [button_pin, player_side, mapId]);
        if (dupConflict) return res.json({ success: false, message: `GPIO ${button_pin} is already mapped for Player ${player_side}.` });

        await db.query(`UPDATE button_mappings SET button_pin=?, element_symbol=?, player_side=? WHERE mapping_id=?`, [button_pin, element_symbol, player_side, mapId]);
        await logActivity(req.user.user_id, 'Admin', 'EDIT_BUTTON_MAPPING', `Updated mapping ID ${mapId}: GPIO ${button_pin} → "${element_symbol}" (P${player_side})`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Edit Mapping Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.delete('/gqb/mappings/:id', requireAdmin, async (req, res) => {
    try {
        const mapId = parseInt(req.params.id, 10);
        if (isNaN(mapId)) return res.json({ success: false, message: 'Invalid mapping ID.' });

        const [[m]] = await db.query(`SELECT mapping_id, element_symbol, player_side FROM button_mappings WHERE mapping_id = ?`, [mapId]);
        if (!m) return res.json({ success: false, message: 'Mapping not found.' });

        await db.query(`DELETE FROM button_mappings WHERE mapping_id = ?`, [mapId]);
        await logActivity(req.user.user_id, 'Admin', 'DELETE_BUTTON_MAPPING', `Deleted mapping ID ${mapId}: "${m.element_symbol}" (P${m.player_side})`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Delete Mapping Error]', err);
        return res.json({ success: false, message: err.message });
    }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — REMEDIATION MATERIALS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/gqb/remediation/:question_id', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.question_id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });
        const [[rem]] = await db.query(`SELECT rem_id, question_id, material_id, advice_text, link_url, preview_json FROM remediation_materials WHERE question_id = ?`, [qId]);
        return res.json({ success: true, remediation: rem || null });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
});

router.post('/gqb/remediation', requireAdmin, async (req, res) => {
    try { return res.json(await _upsertRemediation(req, null)); }
    catch (err) { return res.json({ success: false, message: err.message }); }
});

router.put('/gqb/remediation/:id', requireAdmin, async (req, res) => {
    try {
        const remId = parseInt(req.params.id, 10);
        if (isNaN(remId)) return res.json({ success: false, message: 'Invalid remediation ID.' });
        return res.json(await _upsertRemediation(req, remId));
    } catch (err) { return res.json({ success: false, message: err.message }); }
});

async function _upsertRemediation(req, remId) {
    const { question_id, material_id, advice_text, link_url } = req.body;
    const cleanQId   = parseInt(question_id, 10);
    const cleanMatId = material_id ? parseInt(material_id, 10) : null;
    if (!cleanQId || isNaN(cleanQId)) return { success: false, message: 'A valid question_id is required.' };

    let [[q]] = await db.query(`SELECT question_id FROM elementa_questions WHERE question_id = ?`, [cleanQId]);
    if (!q) {
        try {
            const [[legacyQ]] = await db.query(`SELECT question_id FROM question_bank WHERE question_id = ?`, [cleanQId]);
            q = legacyQ;
        } catch (_) {}
    }
    if (!q) return { success: false, message: `Question ID ${cleanQId} not found.` };

    if (cleanMatId) {
        const [[m]] = await db.query(`SELECT material_id FROM learning_materials WHERE material_id = ?`, [cleanMatId]);
        if (!m) return { success: false, message: `Learning material ID ${cleanMatId} not found.` };
    }

    const cleanAdvice = advice_text ? advice_text.trim().substring(0, 1000) : null;
    const cleanLink   = link_url    ? link_url.trim().substring(0, 2000)    : null;

    if (!cleanMatId && !cleanAdvice && !cleanLink)
        return { success: false, message: 'Provide at least one of: learning material, advice text, or external link.' };

    if (!remId) {
        const [[existing]] = await db.query(`SELECT rem_id FROM remediation_materials WHERE question_id = ?`, [cleanQId]);
        if (existing) return { success: false, message: 'This question already has a remediation entry. Edit the existing one instead.' };

        const [result] = await db.query(`INSERT INTO remediation_materials (question_id, material_id, advice_text, link_url) VALUES (?, ?, ?, ?)`, [cleanQId, cleanMatId, cleanAdvice, cleanLink]);
        await logActivity(req.user.user_id, 'Admin', 'CREATE_REMEDIATION', `Created remediation for question ID ${cleanQId}`);
        return { success: true, rem_id: result.insertId };
    } else {
        const [[rem]] = await db.query(`SELECT rem_id FROM remediation_materials WHERE rem_id = ?`, [remId]);
        if (!rem) return { success: false, message: 'Remediation entry not found.' };
        await db.query(`UPDATE remediation_materials SET question_id=?, material_id=?, advice_text=?, link_url=? WHERE rem_id=?`, [cleanQId, cleanMatId, cleanAdvice, cleanLink, remId]);
        await logActivity(req.user.user_id, 'Admin', 'EDIT_REMEDIATION', `Updated remediation ID ${remId}`);
        return { success: true };
    }
}

router.delete('/gqb/remediation/:id', requireAdmin, async (req, res) => {
    try {
        const remId = parseInt(req.params.id, 10);
        if (isNaN(remId)) return res.json({ success: false, message: 'Invalid remediation ID.' });
        const [[rem]] = await db.query(`SELECT rem_id, question_id FROM remediation_materials WHERE rem_id = ?`, [remId]);
        if (!rem) return res.json({ success: false, message: 'Remediation entry not found.' });
        await db.query(`DELETE FROM remediation_materials WHERE rem_id = ?`, [remId]);
        await logActivity(req.user.user_id, 'Admin', 'DELETE_REMEDIATION', `Deleted remediation ID ${remId}`);
        return res.json({ success: true });
    } catch (err) { return res.json({ success: false, message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — QUESTION VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/questions/:id/approve', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });

        // Check elementa_questions first
        const [[eq]] = await db.query(`SELECT question_id, prompt, verification_status, teacher_id FROM elementa_questions WHERE question_id = ?`, [qId]);
        if (eq) {
            if (eq.verification_status === 'Approved') return res.json({ success: false, message: 'Question is already approved.' });
            await db.query(`UPDATE elementa_questions SET verification_status='Approved', verified_by=?, verified_at=NOW(), rejection_reason=NULL WHERE question_id=?`, [req.user.user_id, qId]);
            await logActivity(req.user.user_id, 'Admin', 'APPROVE_QUESTION', `Approved Elementa question ID ${qId}`);

            if (eq.teacher_id) {
                try {
                    const notificationService = require('../services/notificationService');
                    await notificationService.dispatch({
                        recipientIds: eq.teacher_id,
                        actorId: req.user.user_id,
                        role: 'Teacher',
                        category: 'academic',
                        priority: 'normal',
                        eventType: 'question_approved',
                        title: 'Arcade Question Approved',
                        message: `Your submitted question "${(eq.prompt || '').substring(0, 50)}..." was approved for the Arcade Game.`,
                        targetUrl: `/teacher/question-bank?tab=status&sub=approved&q=${qId}`,
                        metadata: { questionId: qId }
                    });
                } catch (notifErr) {
                    console.error('[Elementa Question Approval Notification Error]', notifErr.message);
                }
            }
            return res.json({ success: true });
        }

        // Legacy question_bank fallback (guarded)
        try {
            const [[q]] = await db.query(`SELECT question_id, question_text, verification_status, teacher_id FROM question_bank WHERE question_id = ?`, [qId]);
            if (!q) return res.json({ success: false, message: 'Question not found.' });
            if (q.verification_status === 'Approved') return res.json({ success: false, message: 'Question is already approved.' });
            await db.query(`UPDATE question_bank SET verification_status='Approved', verified_by=?, verified_at=NOW(), rejection_reason=NULL WHERE question_id=?`, [req.user.user_id, qId]);
            await logActivity(req.user.user_id, 'Admin', 'APPROVE_QUESTION', `Approved question ID ${qId}`);
            
            // Notify Author Teacher
            if (q.teacher_id) {
                try {
                    const notificationService = require('../services/notificationService');
                    await notificationService.dispatch({
                        recipientIds: q.teacher_id,
                        actorId: req.user.user_id,
                        role: 'Teacher',
                        category: 'academic',
                        priority: 'normal',
                        eventType: 'question_approved',
                        title: 'Question Approved',
                        message: `Your submitted question "${q.question_text ? q.question_text.substring(0, 50) + '...' : ''}" was approved for the Question Bank.`,
                        targetUrl: `/teacher/question-bank?tab=status&sub=approved&q=${qId}`,
                        metadata: { questionId: qId }
                    });
                } catch (notifErr) {
                    console.error('[Question Approval Notification Error]', notifErr.message);
                }
            }
            return res.json({ success: true });
        } catch (_) {
            return res.json({ success: false, message: 'Question not found.' });
        }
    } catch (err) { return res.json({ success: false, message: err.message }); }
});

router.post('/gqb/questions/:id/reject', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });
        const rejection_reason = req.body.rejection_reason ? req.body.rejection_reason.trim() : '';
        if (!rejection_reason) return res.json({ success: false, message: 'A rejection reason is required.' });

        // Check elementa_questions first
        const [[eq]] = await db.query(`SELECT question_id, prompt, verification_status, teacher_id FROM elementa_questions WHERE question_id = ?`, [qId]);
        if (eq) {
            if (eq.verification_status === 'Rejected') return res.json({ success: false, message: 'Question is already rejected.' });
            await db.query(`UPDATE elementa_questions SET verification_status='Rejected', verified_by=?, verified_at=NOW(), rejection_reason=? WHERE question_id=?`, [req.user.user_id, rejection_reason.substring(0, 1000), qId]);
            await logActivity(req.user.user_id, 'Admin', 'REJECT_QUESTION', `Rejected Elementa question ID ${qId}`);

            if (eq.teacher_id) {
                try {
                    const notificationService = require('../services/notificationService');
                    await notificationService.dispatch({
                        recipientIds: eq.teacher_id,
                        actorId: req.user.user_id,
                        role: 'Teacher',
                        category: 'academic',
                        priority: 'high',
                        eventType: 'question_rejected',
                        title: 'Arcade Question Needs Revision',
                        message: `Your submitted question was rejected: ${rejection_reason}`,
                        targetUrl: `/teacher/question-bank?tab=status&sub=rejected&q=${qId}`,
                        metadata: { questionId: qId, reason: rejection_reason }
                    });
                } catch (notifErr) {
                    console.error('[Elementa Question Rejection Notification Error]', notifErr.message);
                }
            }
            return res.json({ success: true });
        }

        // Legacy question_bank fallback (guarded)
        try {
            const [[q]] = await db.query(`SELECT question_id, question_text, verification_status, teacher_id FROM question_bank WHERE question_id = ?`, [qId]);
            if (!q) return res.json({ success: false, message: 'Question not found.' });
            if (q.verification_status === 'Rejected') return res.json({ success: false, message: 'Question is already rejected.' });
            await db.query(`UPDATE question_bank SET verification_status='Rejected', verified_by=?, verified_at=NOW(), rejection_reason=? WHERE question_id=?`, [req.user.user_id, rejection_reason.substring(0, 1000), qId]);
            await logActivity(req.user.user_id, 'Admin', 'REJECT_QUESTION', `Rejected question ID ${qId}`);

            // Notify Author Teacher
            if (q.teacher_id) {
                try {
                    const notificationService = require('../services/notificationService');
                    await notificationService.dispatch({
                        recipientIds: q.teacher_id,
                        actorId: req.user.user_id,
                        role: 'Teacher',
                        category: 'academic',
                        priority: 'high',
                        eventType: 'question_rejected',
                        title: 'Question Needs Revision',
                        message: `Your submitted question was rejected: ${rejection_reason}`,
                        targetUrl: `/teacher/question-bank?tab=status&sub=rejected&q=${qId}`,
                        metadata: { questionId: qId, reason: rejection_reason }
                    });
                } catch (notifErr) {
                    console.error('[Question Rejection Notification Error]', notifErr.message);
                }
            }

            return res.json({ success: true });
        } catch (_) {
            return res.json({ success: false, message: 'Question not found.' });
        }
    } catch (err) { return res.json({ success: false, message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — BULK EXCEL ENGINE (UPDATED)
// All admin-imported questions are auto-approved.
// Checks: completeness, enum validity, topic existence, duplicate question text,
//         mode-specific answer format, numeric fields.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/questions/preflight', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (rows.length === 0) return res.json({ success: false, message: 'The uploaded file contains no data rows.' });
        if (rows.length > 500) return res.json({ success: false, message: 'Maximum 500 rows per upload.' });

        const [validTopics]  = await db.query(`SELECT topic_id FROM topics`);
        const topicIdSet     = new Set(validTopics.map(t => t.topic_id));
        const [validSymbols] = await db.query(`SELECT DISTINCT element_symbol FROM button_mappings`);
        const symbolSet      = new Set(validSymbols.map(s => s.element_symbol));

        // Collect existing question texts for duplicate detection
        const [existingQs]   = await db.query(`SELECT LOWER(TRIM(prompt)) AS qt FROM elementa_questions`);
        const existingTexts  = new Set(existingQs.map(q => q.qt));

        // Track texts within this upload for intra-batch duplicates
        const batchTexts = new Set();

        // REQUIRED columns per mode
        const REQUIRED_ALWAYS = ['question_text', 'topic_id', 'difficulty', 'input_mode', 'mechanic_type'];

        const validatedRows = rows.map((rawRow, idx) => {
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                row[k.replace('*', '').trim()] = String(v).trim();
            }

            const result = {
                row           : idx + 2,
                question_text : row.question_text || '',
                input_mode    : row.input_mode    || '',
                mechanic_type : row.mechanic_type || '',
                ok            : true,
                error         : null,
            };

            // ── Check 1: Required columns present and non-empty ───────────────
            for (const col of REQUIRED_ALWAYS) {
                if (!row[col]) return { ...result, ok: false, error: `Missing required column: "${col}".` };
            }

            // ── Check 2: question_text length ─────────────────────────────────
            if (row.question_text.length > 1000) return { ...result, ok: false, error: 'question_text exceeds 1000 characters.' };

            // ── Check 3: Duplicate question text (vs DB) ──────────────────────
            const qLower = row.question_text.toLowerCase().trim();
            if (existingTexts.has(qLower)) return { ...result, ok: false, error: 'Duplicate: this question text already exists in the database.' };

            // ── Check 4: Intra-batch duplicate ────────────────────────────────
            if (batchTexts.has(qLower)) return { ...result, ok: false, error: 'Duplicate: this question text appears more than once in this file.' };
            batchTexts.add(qLower);

            // ── Check 5: Enum values ──────────────────────────────────────────
            if (!VALID_INPUT_MODES.includes(row.input_mode)) return { ...result, ok: false, error: `Invalid input_mode "${row.input_mode}". Must be: ${VALID_INPUT_MODES.join(', ')}.` };
            if (!VALID_MECHANIC_TYPES.includes(row.mechanic_type)) return { ...result, ok: false, error: `Invalid mechanic_type "${row.mechanic_type}".` };
            if (!VALID_DIFFICULTIES.includes(row.difficulty)) return { ...result, ok: false, error: `Invalid difficulty "${row.difficulty}". Must be: Easy, Average, Difficult.` };

            // ── Check 6: topic_id existence ───────────────────────────────────
            const topicId = parseInt(row.topic_id, 10);
            if (!topicId || isNaN(topicId) || !topicIdSet.has(topicId)) return { ...result, ok: false, error: `topic_id "${row.topic_id}" does not exist.` };

            // ── Check 7: Mode-specific answer completeness ────────────────────
            if (row.input_mode === 'Standard') {
                if (!['A','B','C','D'].includes(row.correct_answer))
                    return { ...result, ok: false, error: `Standard mode: correct_answer must be A, B, C, or D (got "${row.correct_answer}").` };
                if (!row.option_a || !row.option_b || !row.option_c || !row.option_d)
                    return { ...result, ok: false, error: 'Standard mode: all four options (option_a, option_b, option_c, option_d) are required.' };

            } else if (row.input_mode === 'Periodic_Single') {
                if (!row.element_symbol)
                    return { ...result, ok: false, error: 'Periodic_Single: element_symbol column is required.' };
                if (!symbolSet.has(row.element_symbol))
                    return { ...result, ok: false, error: `Periodic_Single: symbol "${row.element_symbol}" not found in button_mappings.` };

            } else if (row.input_mode === 'Numeric') {
                if (row.numeric_answer === '' || isNaN(Number(row.numeric_answer)))
                    return { ...result, ok: false, error: `Numeric: numeric_answer must be a pure number (got "${row.numeric_answer}").` };
                if (row.numeric_tolerance !== '' && isNaN(Number(row.numeric_tolerance)))
                    return { ...result, ok: false, error: `Numeric: numeric_tolerance must be a number or empty.` };

            } else if (row.input_mode === 'Periodic_Sequence') {
                const seqStr = row.sequence || '';
                if (!seqStr) return { ...result, ok: false, error: 'Periodic_Sequence: sequence column is required. Format: Symbol:Subscript,Symbol:Subscript (e.g. H:2,O:1).' };
                const pairs = seqStr.split(',').map(p => p.trim()).filter(Boolean);
                if (pairs.length === 0) return { ...result, ok: false, error: 'Periodic_Sequence: sequence has no valid entries.' };
                for (const pair of pairs) {
                    const parts = pair.split(':');
                    if (parts.length !== 2 || !parts[0].trim() || isNaN(parseInt(parts[1], 10)))
                        return { ...result, ok: false, error: `Periodic_Sequence: invalid entry "${pair}". Must be Symbol:Subscript (e.g. H:2).` };
                }
            }

            // ── Check 8: base_exp and time_limit are valid numbers if provided ─
            if (row.base_exp && isNaN(Number(row.base_exp))) return { ...result, ok: false, error: 'base_exp must be a number.' };
            if (row.time_limit && isNaN(Number(row.time_limit))) return { ...result, ok: false, error: 'time_limit must be a number.' };

            return result;
        });

        return res.json({ success: true, rows: validatedRows });

    } catch (err) {
        console.error('[GQB Preflight Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.post('/gqb/questions/bulk-import', requireAdmin, uploadBulk.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });

        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.body.sy_id || req.query.sy_id);
        const targetSyId = syContext?.selectedSY?.sy_id || null;

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (rows.length === 0) return res.json({ success: false, message: 'No data rows found.' });
        if (rows.length > 500) return res.json({ success: false, message: 'Maximum 500 rows per import.' });

        const [validTopics] = await db.query(`SELECT topic_id, quarter_id FROM topics`);
        const topicMap      = {};
        validTopics.forEach(t => { topicMap[t.topic_id] = t; });

        const [validSymbols] = await db.query(`SELECT DISTINCT element_symbol FROM button_mappings`);
        const symbolSet      = new Set(validSymbols.map(s => s.element_symbol));

        const [existingQs]   = await db.query(`SELECT LOWER(TRIM(prompt)) AS qt FROM elementa_questions`);
        const existingTexts  = new Set(existingQs.map(q => q.qt));

        const batchTexts = new Set();
        const REQUIRED_ALWAYS = ['question_text', 'topic_id', 'difficulty', 'input_mode', 'mechanic_type'];

        let created = 0, skipped = 0, errors = 0;
        const log = [];

        for (const rawRow of rows) {
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                row[k.replace('*', '').trim()] = String(v).trim();
            }

            const qText = row.question_text || '';
            if (!qText) { log.push({ ok: false, msg: 'Row skipped — missing question_text.' }); skipped++; continue; }

            // Required column checks
            let rowError = null;
            for (const col of REQUIRED_ALWAYS) {
                if (!row[col]) { rowError = `Missing required column: "${col}".`; break; }
            }
            if (rowError) { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": ${rowError}` }); errors++; continue; }

            // Enum validation
            if (!VALID_INPUT_MODES.includes(row.input_mode))    { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": invalid input_mode.` }); errors++; continue; }
            if (!VALID_MECHANIC_TYPES.includes(row.mechanic_type)) { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": invalid mechanic_type.` }); errors++; continue; }
            if (!VALID_DIFFICULTIES.includes(row.difficulty))   { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": invalid difficulty.` }); errors++; continue; }

            // Topic existence
            const topicId = parseInt(row.topic_id, 10);
            if (!topicId || isNaN(topicId) || !topicMap[topicId]) { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": topic_id "${row.topic_id}" not found.` }); errors++; continue; }

            // Duplicate check
            const qLower = qText.toLowerCase().trim();
            if (existingTexts.has(qLower)) { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": duplicate question text (already in DB).` }); skipped++; continue; }
            if (batchTexts.has(qLower))    { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": duplicate within this file.` }); skipped++; continue; }
            batchTexts.add(qLower);

            // Mode-specific answer validation
            let cleanCorrect   = null;
            let cleanNumAnswer = null;
            let cleanNumTol    = 0;
            let seqPairs       = [];
            let modeError      = null;

            if (row.input_mode === 'Standard') {
                if (!['A','B','C','D'].includes(row.correct_answer)) { modeError = `Standard correct_answer must be A/B/C/D.`; }
                else if (!row.option_a || !row.option_b || !row.option_c || !row.option_d) { modeError = 'All four options are required for Standard mode.'; }
                else cleanCorrect = row.correct_answer;

            } else if (row.input_mode === 'Periodic_Single') {
                if (!row.element_symbol || !symbolSet.has(row.element_symbol)) { modeError = `Periodic_Single symbol "${row.element_symbol}" not in button_mappings.`; }
                // Answer goes to answer_sequences

            } else if (row.input_mode === 'Numeric') {
                if (row.numeric_answer === '' || isNaN(Number(row.numeric_answer))) { modeError = 'Numeric: numeric_answer must be a number.'; }
                else {
                    cleanNumAnswer = parseFloat(row.numeric_answer);
                    cleanNumTol    = isNaN(parseFloat(row.numeric_tolerance)) ? 0 : Math.abs(parseFloat(row.numeric_tolerance));
                }

            } else if (row.input_mode === 'Periodic_Sequence') {
                const seqStr = row.sequence || '';
                if (!seqStr) { modeError = 'Periodic_Sequence: sequence column is required.'; }
                else {
                    const pairs = seqStr.split(',').map(p => p.trim()).filter(Boolean);
                    let seqOk = true;
                    for (const pair of pairs) {
                        const parts = pair.split(':');
                        if (parts.length !== 2 || !parts[0].trim() || isNaN(parseInt(parts[1], 10))) {
                            modeError = `Invalid sequence entry "${pair}".`; seqOk = false; break;
                        }
                        seqPairs.push({ symbol: parts[0].trim(), subscript: parseInt(parts[1], 10) });
                    }
                    if (seqOk && seqPairs.length === 0) modeError = 'Periodic_Sequence has no valid entries.';
                }
            }

            if (modeError) { log.push({ ok: false, msg: `Row "${qText.substring(0,40)}": ${modeError}` }); errors++; continue; }

            // INSERT (auto-approved since admin is importing)
            try {
                const baseExp   = Math.max(10, Math.min(9999, parseInt(row.base_exp, 10) || 100));
                const timeLimit = Math.max(5,  Math.min(300,  parseInt(row.time_limit, 10) || 10));

                const [result] = await db.query(`
                    INSERT INTO elementa_questions
                        (sy_id, topic_id, topic, teacher_id, prompt,
                         machine_name, difficulty, base_score, time_limit_s,
                         answer_text, is_active, verification_status, verified_by, verified_at)
                    VALUES (?, ?, (SELECT topic_name FROM topics WHERE topic_id = ?), ?, ?, ?, ?, ?, ?, ?, 1, 'Approved', ?, NOW())
                `, [
                    targetSyId,
                    topicId,
                    topicId,
                    req.user.user_id,
                    qText.substring(0, 1000),
                    row.input_mode || 'Standard',
                    row.difficulty || 'Medium',
                    baseExp,
                    timeLimit,
                    cleanCorrect || cleanNumAnswer || 'A',
                    req.user.user_id
                ]);

                const newQId = result.insertId;
                existingTexts.add(qLower); // prevent duplicates within this batch vs DB

                // Legacy inserts (guarded)
                try {
                    await db.query(`
                        INSERT INTO question_bank
                            (question_id, topic_id, teacher_id, question_text, instruction_override,
                             difficulty, input_mode, mechanic_type, base_exp, time_limit,
                             is_multiple_answer, required_answers_count,
                             option_a, option_b, option_c, option_d,
                             correct_answer, numeric_answer, numeric_tolerance,
                             is_ai_generated, verification_status, verified_by, verified_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                    `, [
                        newQId,
                        topicId,
                        req.user.user_id,
                        qText.substring(0, 1000),
                        row.instruction_override ? row.instruction_override.substring(0, 500) : null,
                        row.difficulty,
                        row.input_mode,
                        row.mechanic_type,
                        baseExp,
                        timeLimit,
                        row.is_multiple_answer === '1' || row.is_multiple_answer === 'true' ? 1 : 0,
                        Math.max(1, parseInt(row.required_answers_count, 10) || 1),
                        row.option_a ? row.option_a.substring(0, 255) : null,
                        row.option_b ? row.option_b.substring(0, 255) : null,
                        row.option_c ? row.option_c.substring(0, 255) : null,
                        row.option_d ? row.option_d.substring(0, 255) : null,
                        cleanCorrect  ? cleanCorrect.substring(0, 10) : null,
                        cleanNumAnswer,
                        cleanNumTol,
                        row.is_ai_generated === '1' || row.is_ai_generated === 'true' ? 1 : 0,
                        'Approved',
                        req.user.user_id,
                    ]);

                    if (row.input_mode === 'Periodic_Sequence' && seqPairs.length) {
                        for (let i = 0; i < seqPairs.length; i++) {
                            await db.query(`INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order) VALUES (?,?,?,?)`,
                                [newQId, seqPairs[i].symbol, seqPairs[i].subscript, i + 1]);
                        }
                    }

                    if (row.input_mode === 'Periodic_Single' && row.element_symbol) {
                        await db.query(`INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order) VALUES (?,?,?,?)`,
                            [newQId, row.element_symbol, 1, 1]);
                    }
                } catch (_) {}

                log.push({ ok: true, msg: `✔ Created Q#${newQId}: "${qText.substring(0, 50)}" [Auto-Approved]` });
                created++;

            } catch (rowErr) {
                log.push({ ok: false, msg: `Error inserting "${qText.substring(0, 40)}": ${rowErr.message}` });
                errors++;
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'BULK_IMPORT_QUESTIONS',
            `Bulk imported ${created} question(s) — skipped: ${skipped}, errors: ${errors} [All auto-approved]`);

        return res.json({ success: true, created, skipped, errors, log });

    } catch (err) {
        console.error('[GQB Bulk Import Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.get('/gqb/questions/template', requireAdmin, (req, res) => {
    const headers = [
        'question_text*',
        'instruction_override',
        'topic_id*',
        'difficulty*',              // Easy | Average | Difficult
        'input_mode*',              // Standard | Periodic_Single | Periodic_Sequence | Numeric
        'mechanic_type*',           // standard_mcq | weight_scale | radar_scan | conveyor_belt | flick_sort | shield_calibrate | electric_link | cipher_crack
        'base_exp',                 // default 100
        'time_limit',               // seconds, default 10
        'is_multiple_answer',       // 0 or 1 (Standard only)
        'required_answers_count',
        'option_a',                 // Standard mode only
        'option_b',
        'option_c',
        'option_d',
        'correct_answer',           // Standard only: A/B/C/D
        'element_symbol',           // Periodic_Single only: must match button_mappings
        'sequence',                 // Periodic_Sequence only: H:2,O:1
        'numeric_answer',           // Numeric only: pure number
        'numeric_tolerance',        // Numeric only: tolerance (e.g. 0.01), optional
        'is_ai_generated',          // 0 or 1
    ];

    const sampleStandard = [
        'What is the chemical symbol for Gold?', '', '1', 'Easy', 'Standard', 'standard_mcq',
        '100', '10', '0', '1', 'Au', 'Ag', 'Fe', 'Cu', 'A', '', '', '', '', '0',
    ];
    const samplePeriodicSingle = [
        'Press the element button for Hydrogen.', '', '1', 'Average', 'Periodic_Single', 'radar_scan',
        '150', '8', '0', '1', '', '', '', '', '', 'H', '', '', '', '0',
    ];
    const samplePeriodicSeq = [
        'Build the chemical formula for Water.', '', '1', 'Difficult', 'Periodic_Sequence', 'conveyor_belt',
        '200', '15', '0', '1', '', '', '', '', '', '', 'H:2,O:1', '', '', '0',
    ];
    const sampleNumeric = [
        "What is Avogadro's number (approximate)?", 'Enter in scientific notation value only', '1', 'Difficult', 'Numeric', 'cipher_crack',
        '200', '20', '0', '1', '', '', '', '', '', '', '', '6.022e23', '0.001', '0',
    ];
    const notesRow = [
        '--- NOTES (delete before uploading) ---',
        '', 'topic_id must exist in topics table.',
        'difficulty: Easy | Average | Difficult',
        'input_mode: Standard | Periodic_Single | Periodic_Sequence | Numeric',
        'mechanic_type: standard_mcq | weight_scale | radar_scan | conveyor_belt | flick_sort | shield_calibrate | electric_link | cipher_crack',
        '', '', '', '',
        'Standard: fill option_a-d + correct_answer (A/B/C/D)',
        'Periodic_Single: fill element_symbol column only',
        'Periodic_Sequence: fill sequence column as H:2,O:1',
        'Numeric: fill numeric_answer + optional numeric_tolerance',
        '', '', '', '', '', '',
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, sampleStandard, samplePeriodicSingle, samplePeriodicSeq, sampleNumeric, [], notesRow]);
    ws['!cols'] = headers.map(() => ({ wch: 28 }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'question_bank_template');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="gqb_question_bank_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});


// ═══════════════════════════════════════════════════════════════════════════════
// ██████╗ ███████╗███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗███████╗███████╗
// ██╔══██╗██╔════╝██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝██╔════╝██╔════╝
// ██████╔╝█████╗  ███████╗██║   ██║██║   ██║██████╔╝██║     █████╗  ███████╗
// ██╔══██╗██╔══╝  ╚════██║██║   ██║██║   ██║██╔══██╗██║     ██╔══╝  ╚════██║
// ██║  ██║███████╗███████║╚██████╔╝╚██████╔╝██║  ██║╚██████╗███████╗███████║
// ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝
// RESOURCES & ENGAGEMENT — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// MULTER — Material file uploads (disk storage → public/uploads/materials/)
// Add this block ONCE near the top of admin.js alongside the other multer defs.
// ─────────────────────────────────────────────────────────────────────────────
const materialStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../material_uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext    = path.extname(file.originalname).toLowerCase();
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, unique);
    },
});
const uploadMaterial = multer({
    storage: materialStorage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: (req, file, cb) => {
        const allowed = /pdf|doc|docx|ppt|pptx|xls|xlsx|jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv/i;
        if (allowed.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type.'));
        }
    },
});


// ═══════════════════════════════════════════════════════════════════════════════
// PAGE LOADER
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/resources_engagement
// Renders the Resources & Engagement page.
// EJS expects: user, reStats, quarters (with topics+materials),
//   allTopics, forums (with replies), interactionLog, activityFeed,
//   studentProgress, leaderboard, leaderboardHistory
// ─────────────────────────────────────────────────────────────────────────────
router.get('/resources_engagement', requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        // ── KPI stats ──────────────────────────────────────────────────────────
        const [[mRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM learning_materials WHERE sy_id = ?`, [selectedSY.sy_id]);
        const [[fRow]] = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM forum_topics ft
            LEFT JOIN classes c ON c.class_id = ft.class_id
            WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);
        const [[iRow]] = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM student_material_interactions smi
            WHERE (smi.interacted_at >= ? AND smi.interacted_at <= ?)
               OR smi.student_id IN (
                   SELECT cs.student_id FROM class_students cs
                   JOIN classes c ON c.class_id = cs.class_id
                   WHERE c.sy_id = ?
               )
        `, [selectedSY.start_date, selectedSY.end_date, selectedSY.sy_id]);
        const [[sRow]] = await db.query(`
            SELECT COUNT(DISTINCT cs.student_id) AS cnt
            FROM class_students cs
            JOIN classes c ON c.class_id = cs.class_id
            WHERE c.sy_id = ?
        `, [selectedSY.sy_id]);

        const reStats = {
            totalMaterials    : mRow ? mRow.cnt : 0,
            totalForums       : fRow ? fRow.cnt : 0,
            totalInteractions : iRow ? iRow.cnt : 0,
            totalStudents     : sRow ? sRow.cnt : 0,
        };

        // ── All topics flat list for dropdowns ────────────────────────────────
        const [allTopics] = await db.query(`
            SELECT
                t.topic_id, t.topic_name, t.topic_description, t.topic_objectives, t.video_url,
                q.quarter_number, q.quarter_id,
                s.subject_name, s.subject_id
            FROM topics t
            JOIN quarters q ON q.quarter_id = t.quarter_id
            JOIN subjects s ON s.subject_id  = q.subject_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, t.topic_id ASC
        `);

        // ── Quarters → Topics → Materials (for accordion) ────────────────────
        const [rawQuarters] = await db.query(`
            SELECT DISTINCT
                q.quarter_id, q.quarter_number, q.is_locked,
                s.subject_id, s.subject_name,
                COUNT(DISTINCT t.topic_id) AS topicCount
            FROM quarters q
            JOIN subjects s ON s.subject_id = q.subject_id
            LEFT JOIN topics t ON t.quarter_id = q.quarter_id
            GROUP BY q.quarter_id, s.subject_id, s.subject_name
            ORDER BY s.subject_name ASC, q.quarter_number ASC
        `);

        // Fetch topics per quarter with their materials
        const quarters = [];
        for (const q of rawQuarters) {
            const [topicsInQ] = await db.query(`
                SELECT topic_id, topic_name FROM topics
                WHERE quarter_id = ? ORDER BY topic_id ASC
            `, [q.quarter_id]);

            const topicsWithMats = [];
            for (const t of topicsInQ) {
                const [materials] = await db.query(`
                    SELECT 
                        lm.material_id, lm.title, lm.material_type, lm.file_path_or_url, lm.is_locked, lm.topic_id,
                        lm.created_at, lm.uploaded_by,
                        COALESCE(
                            CONCAT(u.first_name, ' ', u.last_name),
                            CONCAT(tu.first_name, ' ', tu.last_name),
                            'System Administrator'
                        ) AS uploader_name,
                        COALESCE(u.role, tu.role, 'Admin') AS uploader_role
                    FROM learning_materials lm
                    LEFT JOIN users u ON u.user_id = lm.uploaded_by
                    LEFT JOIN topics t ON t.topic_id = lm.topic_id
                    LEFT JOIN quarters q ON q.quarter_id = t.quarter_id
                    LEFT JOIN classes c ON c.subject_id = q.subject_id
                    LEFT JOIN users tu ON tu.user_id = c.teacher_id
                    WHERE lm.topic_id = ? AND lm.sy_id = ?
                    GROUP BY lm.material_id
                    ORDER BY lm.created_at DESC, lm.material_id DESC
                `, [t.topic_id, selectedSY.sy_id]);
                topicsWithMats.push({ ...t, materials });
            }

            quarters.push({
                ...q,
                subject_id  : q.subject_id,
                subject_name: q.subject_name,
                topicCount  : topicsInQ.length,
                topics      : topicsWithMats,
            });
        }

        // ── Forums with reply counts + replies (for drill-down) ───────────────
        const [rawForums] = await db.query(`
            SELECT
                ft.forum_id, ft.topic_id, ft.is_pinned,
                ft.title, ft.forum_content, ft.created_at,
                ft.subject_id, ft.teacher_id,
                ft.status,
                t.topic_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                COUNT(DISTINCT fr.reply_id) AS reply_count
            FROM forum_topics ft
            LEFT JOIN classes c ON c.class_id = ft.class_id
            LEFT JOIN topics t  ON t.topic_id  = ft.topic_id
            LEFT JOIN users u   ON u.user_id    = ft.teacher_id
            LEFT JOIN forum_replies fr ON fr.topic_id = ft.forum_id
            WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)
            GROUP BY ft.forum_id
            ORDER BY ft.is_pinned DESC, ft.created_at DESC
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);

        // Attach top 30 replies per forum with endorsement, vote count, unmask status
        const forums = [];
        for (const f of rawForums) {
            const [replies] = await db.query(`
                SELECT
                    fr.reply_id, fr.reply_title, fr.reply_content, fr.created_at, fr.parent_reply_id,
                    fr.is_anonymous, fr.is_endorsed,
                    (SELECT COUNT(*) FROM reply_votes rv WHERE rv.reply_id = fr.reply_id) AS vote_count,
                    (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id) AS is_unmasked,
                    CASE WHEN fr.is_anonymous = 1 AND u.role = 'Student' THEN
                        (CASE WHEN (SELECT COUNT(*) FROM forum_unmask_logs ful WHERE ful.target_reply_id = fr.reply_id) > 0
                              THEN CONCAT(u.first_name, ' ', u.last_name, ' (Unmasked)')
                              ELSE 'Anonymous Student' END)
                         ELSE CONCAT(u.first_name, ' ', u.last_name) END AS user_name
                FROM forum_replies fr
                LEFT JOIN users u ON u.user_id = fr.user_id
                WHERE fr.topic_id = ?
                ORDER BY fr.is_endorsed DESC, fr.created_at ASC
                LIMIT 30
            `, [f.forum_id]);
            forums.push({ ...f, replies });
        }

        // ── Material interaction log (Pillar 3) ───────────────────────────────
        const [interactionLog] = await db.query(`
            SELECT
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                lm.title AS material_title
            FROM student_material_interactions smi
            JOIN users u  ON u.user_id    = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            WHERE (smi.interacted_at >= ? AND smi.interacted_at <= ?)
               OR smi.student_id IN (
                   SELECT cs.student_id FROM class_students cs
                   JOIN classes c ON c.class_id = cs.class_id
                   WHERE c.sy_id = ?
               )
            ORDER BY smi.interacted_at DESC, smi.interaction_id DESC
            LIMIT 100
        `, [selectedSY.start_date, selectedSY.end_date, selectedSY.sy_id]);

        // ── Game Interaction Log (Arcade Game Sessions) ───────────────────────
        const [gameInteractionLog] = await db.query(`
            SELECT
                gs.session_id, gs.play_mode, gs.session_status, gs.started_at, gs.ended_at,
                gs.total_duration_s, gs.final_score_p1, gs.final_score_p2,
                gs.highest_level_reached, gs.cabinet_id, gs.winner,
                gs.student_id_p1, gs.student_id_p2,
                CONCAT(u1.first_name, ' ', u1.last_name) AS student_name_p1,
                u1.profile_pic AS profile_pic_p1,
                u1.lrn_number AS lrn_p1,
                CONCAT(u2.first_name, ' ', u2.last_name) AS student_name_p2,
                u2.profile_pic AS profile_pic_p2,
                u2.lrn_number AS lrn_p2,
                a.assessment_name AS assessment_title
            FROM elementa_game_sessions gs
            LEFT JOIN users u1 ON u1.user_id = gs.student_id_p1
            LEFT JOIN users u2 ON u2.user_id = gs.student_id_p2
            LEFT JOIN assessments a ON a.assessment_id = gs.assessment_id
            WHERE (gs.started_at >= ? AND gs.started_at <= ?)
               OR a.sy_id = ?
               OR gs.class_id IN (SELECT class_id FROM classes WHERE sy_id = ?)
            ORDER BY gs.started_at DESC, gs.session_id DESC
            LIMIT 50
        `, [selectedSY.start_date, selectedSY.end_date, selectedSY.sy_id, selectedSY.sy_id]);

        // ── Activity Audit Feed (Pillar 3 sidebar fallback) ───────────────────
        const [activityFeed] = await db.query(`
            SELECT log_id, actor_id, actor_role, action, description, created_at
            FROM activity_logs
            ORDER BY created_at DESC
            LIMIT 50
        `);

        // ── Engagement Milestone Logic: Calculate student interaction percentages (Materials vs Games)
        const [[{ totalUnlockedMaterials = 1 } = {}]] = await db.query(`
            SELECT COUNT(*) AS totalUnlockedMaterials FROM learning_materials WHERE is_locked = 0 AND sy_id = ?
        `, [selectedSY.sy_id]);
        const [[{ totalArcadeAssessmentsPlayed = 1 } = {}]] = await db.query(`
            SELECT COUNT(DISTINCT assessment_id) AS totalArcadeAssessmentsPlayed FROM elementa_game_sessions WHERE assessment_id IS NOT NULL
        `);
        const [[{ maxCohortSessions = 10 } = {}]] = await db.query(`
            SELECT MAX(cnt) AS maxCohortSessions FROM (
                SELECT COUNT(*) AS cnt FROM elementa_game_sessions GROUP BY student_id_p1
            ) t
        `);

        const denomMat = Math.max(1, totalUnlockedMaterials || 1);
        const denomGameAsmt = Math.max(1, totalArcadeAssessmentsPlayed || 1);
        const targetCohortSessions = Math.max(10, maxCohortSessions || 10);

        const [rawMilestoneStudents] = await db.query(`
            SELECT 
                u.user_id, u.first_name, u.last_name, u.profile_pic, u.lrn_number,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.class_name SEPARATOR ', ')
                    FROM class_students cs
                    JOIN classes c ON c.class_id = cs.class_id
                    WHERE cs.student_id = u.user_id AND c.sy_id = ?
                ) AS class_names,
                COALESCE(m.mats_distinct, 0) AS mats_distinct,
                COALESCE(m.mats_total, 0) AS mats_total,
                COALESCE(g.games_total, 0) AS games_total,
                COALESCE(g.games_distinct, 0) AS games_distinct
            FROM users u
            JOIN class_students cs_flt ON cs_flt.student_id = u.user_id
            JOIN classes c_flt ON c_flt.class_id = cs_flt.class_id AND c_flt.sy_id = ?
            LEFT JOIN (
                SELECT student_id, COUNT(DISTINCT material_id) AS mats_distinct, COUNT(*) AS mats_total
                FROM student_material_interactions
                WHERE interacted_at >= ? AND interacted_at <= ?
                GROUP BY student_id
            ) m ON m.student_id = u.user_id
            LEFT JOIN (
                SELECT student_id, COUNT(session_id) AS games_total, COUNT(DISTINCT assessment_id) AS games_distinct
                FROM (
                    SELECT session_id, student_id_p1 AS student_id, assessment_id FROM elementa_game_sessions WHERE student_id_p1 IS NOT NULL AND started_at >= ? AND started_at <= ?
                    UNION ALL
                    SELECT session_id, student_id_p2 AS student_id, assessment_id FROM elementa_game_sessions WHERE student_id_p2 IS NOT NULL AND started_at >= ? AND started_at <= ?
                ) all_gs
                GROUP BY student_id
            ) g ON g.student_id = u.user_id
            WHERE u.role = 'Student'
            GROUP BY u.user_id
        `, [selectedSY.sy_id, selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date, selectedSY.start_date, selectedSY.end_date, selectedSY.start_date, selectedSY.end_date]);

        // Helper function for dynamic milestone message based on student performance
        function generateStudentMilestoneMessage(matPercent, gamePercent, placement) {
            const highestPercent = Math.max(matPercent, gamePercent);

            if (placement === 1 && highestPercent > 0) {
                return `This student is consistently active and has interacted with either learning materials (${matPercent}%) or games (${gamePercent}%), making them an outstanding student for this week.`;
            }

            if (highestPercent >= 75) {
                return `This student is highly active and has interacted with either learning materials (${matPercent}%) or games (${gamePercent}%), demonstrating remarkable commitment this week.`;
            }

            if (highestPercent >= 50) {
                return `This student is steadily engaged and has interacted with either learning materials (${matPercent}%) or games (${gamePercent}%), showing commendable progress this week.`;
            }

            if (highestPercent >= 20) {
                return `This student is building momentum and has interacted with either learning materials (${matPercent}%) or games (${gamePercent}%), showing steady participation this week.`;
            }

            if (highestPercent > 0) {
                return `This student has initiated preliminary activity with either learning materials (${matPercent}%) or games (${gamePercent}%), with opportunity for further growth this week.`;
            }

            return `This student has not yet engaged with either learning materials (0%) or games (0%) this week and may need guided academic follow-up.`;
        }

        const sortedMilestoneStudents = rawMilestoneStudents.map(s => {
            const matPercent = Math.min(100, Math.round((s.mats_distinct / denomMat) * 100));
            const gameCoverage = s.games_distinct / denomGameAsmt;
            const gameVolume = Math.min(1, s.games_total / targetCohortSessions);
            const gamePercent = Math.min(100, Math.round(((gameCoverage * 0.6) + (gameVolume * 0.4)) * 100));
            const highestPercent = Math.max(matPercent, gamePercent);
            const dominantChannel = gamePercent > matPercent ? 'games' : (matPercent > gamePercent ? 'materials' : 'balanced');
            const totalInteractions = (s.mats_total || 0) + (s.games_total || 0);

            return {
                ...s,
                matPercent,
                gamePercent,
                highestPercent,
                dominantChannel,
                totalInteractions
            };
        }).sort((a, b) => {
            if (b.highestPercent !== a.highestPercent) return b.highestPercent - a.highestPercent;
            return b.totalInteractions - a.totalInteractions;
        });

        const engagementMilestones = sortedMilestoneStudents.map((s, idx) => {
            const placement = idx + 1;
            const milestoneMessage = generateStudentMilestoneMessage(s.matPercent, s.gamePercent, placement);
            return {
                ...s,
                placement,
                milestoneMessage
            };
        });

        const topEngagedStudent = engagementMilestones.find(s => s.highestPercent > 0) || (engagementMilestones[0] || null);

        // ── Student progress for engagement milestones (Pillar 3 legacy fallback)
        const [studentProgress] = await db.query(`
            SELECT
                sp.progress_percent, sp.last_accessed,
                u.user_id, u.first_name, u.last_name, u.profile_pic,
                s.subject_name
            FROM student_progress sp
            JOIN users    u ON u.user_id    = sp.student_id
            JOIN subjects s ON s.subject_id = sp.subject_id
            ORDER BY sp.progress_percent DESC
            LIMIT 30
        `);

        // ── Pillar 4: Progress & Rewards (General-to-Specific Data) ───────────
        // Tier 1: Overall subjects overview & status
        const [subjects] = await db.query(`
            SELECT s.subject_id, s.subject_name, s.subject_code,
                   COUNT(DISTINCT c.class_id) AS class_count,
                   COUNT(DISTINCT cs.student_id) AS student_count
            FROM subjects s
            LEFT JOIN classes c ON c.subject_id = s.subject_id AND c.sy_id = ?
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            GROUP BY s.subject_id
            ORDER BY s.subject_name ASC
        `, [selectedSY.sy_id]);

        const [subjectGameStats] = await db.query(`
            SELECT 
                q.subject_id,
                COUNT(DISTINCT gs.session_id) AS total_game_sessions,
                COALESCE(MAX(gs.highest_level_reached), 1) AS highest_level_reached,
                COALESCE(MAX(GREATEST(COALESCE(gs.final_score_p1, 0), COALESCE(gs.final_score_p2, 0))), 0) AS highest_game_score,
                COALESCE(ROUND(AVG(NULLIF(gs.highest_level_reached, 0)), 1), 1) AS avg_level_reached,
                COUNT(DISTINCT CASE WHEN gs.student_id_p1 IS NOT NULL THEN gs.student_id_p1 ELSE gs.student_id_p2 END) AS active_players_count
            FROM elementa_game_sessions gs
            JOIN assessments a ON a.assessment_id = gs.assessment_id
            JOIN topics t ON t.topic_id = a.topic_id
            JOIN quarters q ON q.quarter_id = t.quarter_id
            WHERE a.sy_id = ?
            GROUP BY q.subject_id
        `, [selectedSY.sy_id]);

        const subjMap = {};
        subjectGameStats.forEach(stat => {
            subjMap[stat.subject_id] = stat;
        });

        const subjectsOverview = subjects.map(s => {
            const stat = subjMap[s.subject_id] || {};
            return {
                ...s,
                total_game_sessions: Number(stat.total_game_sessions || 0),
                highest_level_reached: Number(stat.highest_level_reached || 1),
                highest_game_score: Number(stat.highest_game_score || 0),
                avg_level_reached: parseFloat(stat.avg_level_reached || 1),
                active_players_count: Number(stat.active_players_count || 0)
            };
        });

        // Tier 2: Per-class breakdown under those subjects
        const [classesBreakdownRaw] = await db.query(`
            SELECT 
                c.class_id, c.class_name, c.subject_id,
                s.subject_name, s.subject_code,
                CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                COUNT(DISTINCT cs.student_id) AS student_count,
                COUNT(DISTINCT gs.session_id) AS total_game_sessions,
                COALESCE(MAX(gs.highest_level_reached), 1) AS highest_level_reached,
                COALESCE(MAX(GREATEST(COALESCE(gs.final_score_p1, 0), COALESCE(gs.final_score_p2, 0))), 0) AS highest_game_score,
                COALESCE(ROUND(AVG(NULLIF(gs.highest_level_reached, 0)), 1), 1) AS avg_level_reached,
                COUNT(DISTINCT CASE 
                    WHEN gs.session_id IS NOT NULL AND (gs.student_id_p1 = cs.student_id OR gs.student_id_p2 = cs.student_id)
                    THEN cs.student_id 
                    ELSE NULL 
                END) AS active_players_count
            FROM classes c
            JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN users t ON t.user_id = c.teacher_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN elementa_game_sessions gs ON (
                (gs.class_id = c.class_id)
                OR (gs.class_id IS NULL AND (gs.student_id_p1 = cs.student_id OR gs.student_id_p2 = cs.student_id))
            )
            WHERE c.sy_id = ?
            GROUP BY c.class_id
            ORDER BY s.subject_name ASC, c.class_name ASC
        `, [selectedSY.sy_id]);

        const classesBreakdown = classesBreakdownRaw.map(c => ({
            ...c,
            student_count: Number(c.student_count || 0),
            total_game_sessions: Number(c.total_game_sessions || 0),
            highest_level_reached: Number(c.highest_level_reached || 1),
            highest_game_score: Number(c.highest_game_score || 0),
            avg_level_reached: parseFloat(c.avg_level_reached || 1),
            active_players_count: Number(c.active_players_count || 0)
        }));

        // Tier 3: Detailed student-specific data (Highest Level Reached instead of EXP)
        const [studentGameLeaderboardRaw] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.profile_pic, u.lrn_number,
                (SELECT GROUP_CONCAT(DISTINCT c2.class_name SEPARATOR ', ')
                 FROM class_students cs2
                 JOIN classes c2 ON c2.class_id = cs2.class_id
                 WHERE cs2.student_id = u.user_id AND c2.sy_id = ?) AS class_names,
                (SELECT GROUP_CONCAT(DISTINCT s2.subject_name SEPARATOR ', ')
                 FROM class_students cs3
                 JOIN classes c3 ON c3.class_id = cs3.class_id
                 JOIN subjects s2 ON s2.subject_id = c3.subject_id
                 WHERE cs3.student_id = u.user_id AND c3.sy_id = ?) AS subject_names,
                MAX(GREATEST(
                    COALESCE(gs.highest_level_reached, 1),
                    COALESCE(lb.best_level_reached, 1),
                    COALESCE(u.current_level, 1)
                )) AS highest_level_reached,
                MAX(GREATEST(
                    COALESCE(gs.final_score_p1, 0),
                    COALESCE(gs.final_score_p2, 0),
                    COALESCE(lb.best_score_total, 0)
                )) AS highest_game_score,
                COALESCE(SUM(COALESCE(gs.final_score_p1, 0)), 0) AS cumulative_game_score,
                COUNT(DISTINCT gs.session_id) AS total_game_sessions,
                MAX(gs.started_at) AS last_played_at
            FROM users u
            JOIN class_students cs_lead ON cs_lead.student_id = u.user_id
            JOIN classes c_lead ON c_lead.class_id = cs_lead.class_id AND c_lead.sy_id = ?
            LEFT JOIN elementa_game_sessions gs ON (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
            LEFT JOIN elementa_leaderboard lb ON lb.student_id = u.user_id
            WHERE u.role = 'Student'
            GROUP BY u.user_id
            ORDER BY highest_level_reached DESC, highest_game_score DESC, total_game_sessions DESC
        `, [selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id]);

        const studentGameLeaderboard = studentGameLeaderboardRaw.map((s, idx) => ({
            ...s,
            placement: idx + 1,
            highest_level_reached: Number(s.highest_level_reached || 1),
            highest_game_score: Number(s.highest_game_score || 0),
            cumulative_game_score: Number(s.cumulative_game_score || 0),
            total_game_sessions: Number(s.total_game_sessions || 0)
        }));

        res.render('admin/resources_engagement', {
            user: req.user,
            reStats,
            quarters,
            allTopics,
            forums,
            interactionLog,
            gameInteractionLog,
            activityFeed,
            studentProgress,
            engagementMilestones,
            topEngagedStudent,
            subjectsOverview,
            classesBreakdown,
            studentGameLeaderboard,
            leaderboard: studentGameLeaderboard, // backward-compatibility fallback
            leaderboardHistory: [],
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY
        });

    } catch (err) {
        console.error('[RE GET Error]', err);
        res.status(500).send('Server error loading Resources & Engagement: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PILLAR 1 — LEARNING MATERIALS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/re/materials
// Upload a new learning material.
// Handles both FILE upload (multipart) and LINK (JSON) in one route.
// Content-Type is detected automatically via multer.
// ─────────────────────────────────────────────────────────────────────────────
const MATERIAL_TYPE_RULES = {
    pdf: {
        label: 'PDF',
        extensions: ['.pdf']
    },
    word: {
        label: 'Word Document',
        extensions: ['.doc', '.docx']
    },
    img: {
        label: 'Image',
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']
    },
    video: {
        label: 'Video',
        extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm']
    },
    presentation: {
        label: 'Presentation (PPT)',
        extensions: ['.ppt', '.pptx']
    }
};

router.post('/re/materials', requireAdmin, (req, res, next) => {
    // If the client sends JSON (link type), skip multer
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        return next();
    }
    // Otherwise run multer for file upload
    uploadMaterial.single('material_file')(req, res, (err) => {
        if (err) {
            let msg = err.message || 'File upload failed.';
            if (err.code === 'LIMIT_FILE_SIZE') {
                msg = 'File size limit exceeded. Maximum file size allowed is 100MB.';
            }
            return res.json({ success: false, message: msg });
        }
        next();
    });
}, async (req, res) => {
    try {
        const title         = req.body.title        ? req.body.title.trim().substring(0, 255) : null;
        const topic_id      = parseInt(req.body.topic_id, 10) || null;
        const material_type = req.body.material_type || null;
        const is_locked     = req.body.is_locked !== undefined ? parseInt(req.body.is_locked, 10) : 1;

        // ── Validation ────────────────────────────────────────────────────────
        if (!title) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
            }
            return res.json({ success: false, message: 'Title is required.' });
        }
        if (!topic_id) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
            }
            return res.json({ success: false, message: 'A valid topic is required.' });
        }

        const VALID_TYPES = ['pdf', 'word', 'img', 'video', 'link', 'presentation'];
        if (!material_type || !VALID_TYPES.includes(material_type)) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
            }
            return res.json({ success: false, message: `material_type must be one of: ${VALID_TYPES.join(', ')}.` });
        }

        // ── Validate topic exists ─────────────────────────────────────────────
        const [[topic]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topic_id]);
        if (!topic) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
            }
            return res.json({ success: false, message: `Topic ID ${topic_id} not found.` });
        }

        // ── Determine file_path_or_url & File Type Validation ─────────────────
        let file_path_or_url;

        if (material_type === 'link') {
            const url = req.body.file_path_or_url ? req.body.file_path_or_url.trim() : null;
            if (!url || !/^https?:\/\/.+/i.test(url)) {
                return res.json({ success: false, message: 'A valid URL (starting with http:// or https://) is required for Link type.' });
            }
            file_path_or_url = url;

        } else {
            // File upload validation
            if (!req.file) {
                return res.json({ success: false, message: 'A file upload is required for this material type.' });
            }

            const rule = MATERIAL_TYPE_RULES[material_type];
            if (!rule) {
                if (req.file.path && fs.existsSync(req.file.path)) {
                    try { fs.unlinkSync(req.file.path); } catch (_) {}
                }
                return res.json({ success: false, message: `Unsupported file material type: ${material_type}.` });
            }

            const fileExt = path.extname(req.file.originalname).toLowerCase();
            if (!rule.extensions.includes(fileExt)) {
                // Delete mismatched file from disk
                if (req.file.path && fs.existsSync(req.file.path)) {
                    try { fs.unlinkSync(req.file.path); } catch (_) {}
                }
                return res.json({
                    success: false,
                    message: `File type mismatch: You selected "${rule.label}", but uploaded "${req.file.originalname}" (${fileExt || 'unrecognized'}). Allowed formats: ${rule.extensions.join(', ')}.`
                });
            }

            file_path_or_url = req.file.filename;  // stored filename only; path prefix added in EJS
        }

        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.body.sy_id || req.query.sy_id);
        const targetSyId = syContext?.selectedSY?.sy_id || null;

        const [result] = await db.query(`
            INSERT INTO learning_materials (sy_id, topic_id, title, material_type, file_path_or_url, is_locked, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [targetSyId, topic_id, title, material_type, file_path_or_url, is_locked, req.user.user_id]);

        await logActivity(req.user.user_id, 'Admin', 'CREATE_MATERIAL',
            `Uploaded material: "${title}" (${material_type}) → topic ID ${topic_id}`);

        return res.json({ success: true, material_id: result.insertId });

    } catch (err) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        console.error('[RE Create Material Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/re/materials/:id
// Edit title, topic reassignment, and lock status.
// Body (JSON): { title, topic_id, is_locked }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/re/materials/:id', requireAdmin, async (req, res) => {
    try {
        const matId = parseInt(req.params.id, 10);
        if (isNaN(matId)) return res.json({ success: false, message: 'Invalid material ID.' });

        const title    = req.body.title    ? req.body.title.trim().substring(0, 255) : null;
        const topic_id = req.body.topic_id ? parseInt(req.body.topic_id, 10)         : null;
        const is_locked = req.body.is_locked !== undefined ? parseInt(req.body.is_locked, 10) : 0;

        if (!title) return res.json({ success: false, message: 'Title is required.' });

        const [[mat]] = await db.query(
            `SELECT material_id, title FROM learning_materials WHERE material_id = ?`, [matId]
        );
        if (!mat) return res.json({ success: false, message: 'Material not found.' });

        if (topic_id) {
            const [[t]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topic_id]);
            if (!t) return res.json({ success: false, message: `Topic ID ${topic_id} not found.` });
        }

        await db.query(`
            UPDATE learning_materials
            SET title = ?, topic_id = COALESCE(?, topic_id), is_locked = ?
            WHERE material_id = ?
        `, [title, topic_id || null, is_locked, matId]);

        await logActivity(req.user.user_id, 'Admin', 'EDIT_MATERIAL',
            `Updated material ID ${matId}: "${title}"`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[RE Edit Material Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/re/materials/:id/toggle-lock
// Flip is_locked for a material.
// Returns: { success: true, is_locked: 0|1 }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/re/materials/:id/toggle-lock', requireAdmin, async (req, res) => {
    try {
        const matId = parseInt(req.params.id, 10);
        if (isNaN(matId)) return res.json({ success: false, message: 'Invalid material ID.' });

        const [[mat]] = await db.query(
            `SELECT material_id, title, is_locked FROM learning_materials WHERE material_id = ?`, [matId]
        );
        if (!mat) return res.json({ success: false, message: 'Material not found.' });

        const newVal = mat.is_locked ? 0 : 1;
        await db.query(`UPDATE learning_materials SET is_locked = ? WHERE material_id = ?`, [newVal, matId]);

        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_MATERIAL_LOCK',
            `Material "${mat.title}" (ID: ${matId}) set to ${newVal ? 'locked' : 'unlocked'}`);

        return res.json({ success: true, is_locked: newVal });

    } catch (err) {
        console.error('[RE Toggle Material Lock Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/re/materials/:id
// Delete material DB record AND physical file from disk.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/re/materials/:id', requireAdmin, async (req, res) => {
    try {
        const matId = parseInt(req.params.id, 10);
        if (isNaN(matId)) return res.json({ success: false, message: 'Invalid material ID.' });

        const [[mat]] = await db.query(
            `SELECT material_id, title, material_type, file_path_or_url
             FROM learning_materials WHERE material_id = ?`, [matId]
        );
        if (!mat) return res.json({ success: false, message: 'Material not found.' });

        // Delete in FK order: student_interactions, remediation_materials first
        await db.query(`DELETE FROM student_material_interactions WHERE material_id = ?`, [matId]);
        await db.query(`UPDATE remediation_materials SET material_id = NULL WHERE material_id = ?`, [matId]);
        await db.query(`DELETE FROM learning_materials WHERE material_id = ?`, [matId]);

        // Delete physical file if not a link
        if (mat.material_type !== 'link' && mat.file_path_or_url) {
            const filePath = path.join(__dirname, '../material_uploads', mat.file_path_or_url);
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (err) console.warn('[RE Delete File Warning]', err.message);
                });
            }
        }

        await logActivity(req.user.user_id, 'Admin', 'DELETE_MATERIAL',
            `Deleted material "${mat.title}" (ID: ${matId}, type: ${mat.material_type})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[RE Delete Material Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PILLAR 2 — FORUM MODERATION
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/re/forums
// Create a new forum board.
// Body (JSON): { title, topic_id, forum_content, is_pinned }
// Returns: { success: true, forum_id } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/re/forums', requireAdmin, async (req, res) => {
    try {
        const title         = req.body.title         ? req.body.title.trim().substring(0, 255) : null;
        const topic_id      = req.body.topic_id      ? parseInt(req.body.topic_id, 10)          : null;
        const forum_content = req.body.forum_content ? req.body.forum_content.trim().substring(0, 2000) : null;
        const is_pinned     = req.body.is_pinned      ? 1 : 0;

        if (!title)
            return res.json({ success: false, message: 'Forum title is required.' });
        if (!topic_id)
            return res.json({ success: false, message: 'A linked topic is required.' });

        // Validate topic
        const [[topic]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topic_id]);
        if (!topic)
            return res.json({ success: false, message: `Topic ID ${topic_id} not found.` });

        // forum_topics has: forum_id, topic_id, is_pinned, subject_id, teacher_id, title, forum_content, created_at
        // subject_id — derive from topic chain
        const [[topicFull]] = await db.query(`
            SELECT t.topic_id, q.subject_id
            FROM topics t JOIN quarters q ON q.quarter_id = t.quarter_id
            WHERE t.topic_id = ?
        `, [topic_id]);

        const [result] = await db.query(`
            INSERT INTO forum_topics (topic_id, is_pinned, subject_id, teacher_id, title, forum_content)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            topic_id,
            is_pinned,
            topicFull ? topicFull.subject_id : null,
            req.user.user_id,
            title,
            forum_content,
        ]);

        await logActivity(req.user.user_id, 'Admin', 'CREATE_FORUM',
            `Created forum board: "${title}" (ID: ${result.insertId})`);

        return res.json({ success: true, forum_id: result.insertId });

    } catch (err) {
        console.error('[RE Create Forum Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/re/forums/:id
// Edit forum title, content, and pin status.
// Body (JSON): { title, forum_content, is_pinned }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/re/forums/:id', requireAdmin, async (req, res) => {
    try {
        const forumId = parseInt(req.params.id, 10);
        if (isNaN(forumId)) return res.json({ success: false, message: 'Invalid forum ID.' });

        const title         = req.body.title         ? req.body.title.trim().substring(0, 255)     : null;
        const forum_content = req.body.forum_content ? req.body.forum_content.trim().substring(0, 2000) : null;
        const is_pinned     = req.body.is_pinned      ? 1 : 0;

        if (!title) return res.json({ success: false, message: 'Forum title is required.' });

        const [[forum]] = await db.query(
            `SELECT forum_id, status, topic_id FROM forum_topics WHERE forum_id = ?`, [forumId]
        );
        if (!forum) return res.json({ success: false, message: 'Forum not found.' });

        const allowedStatuses = ['unresolved', 'solved', 'instructor_verified'];
        const status = allowedStatuses.includes(req.body.status) ? req.body.status : (forum.status || 'unresolved');
        const topic_id = req.body.topic_id ? parseInt(req.body.topic_id, 10) : forum.topic_id;

        await db.query(`
            UPDATE forum_topics SET title = ?, forum_content = ?, is_pinned = ?, status = ?, topic_id = ?
            WHERE forum_id = ?
        `, [title, forum_content, is_pinned, status, topic_id, forumId]);

        await logActivity(req.user.user_id, 'Admin', 'EDIT_FORUM',
            `Updated forum ID ${forumId}: "${title}"`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[RE Edit Forum Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/re/forums/:id
// Delete forum board and all its replies (cascade via FK).
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/re/forums/:id', requireAdmin, async (req, res) => {
    try {
        const forumId = parseInt(req.params.id, 10);
        if (isNaN(forumId)) return res.json({ success: false, message: 'Invalid forum ID.' });

        const [[forum]] = await db.query(
            `SELECT forum_id, title FROM forum_topics WHERE forum_id = ?`, [forumId]
        );
        if (!forum) return res.json({ success: false, message: 'Forum not found.' });

        // forum_replies has ON DELETE CASCADE from forum_topics (FK)
        // student_forum_done also has ON DELETE CASCADE
        // So a single delete is sufficient:
        await db.query(`DELETE FROM forum_topics WHERE forum_id = ?`, [forumId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_FORUM',
            `Deleted forum: "${forum.title}" (ID: ${forumId})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[RE Delete Forum Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/re/replies/:id
// Delete a single forum reply (children cascade via FK self-reference).
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/re/forum/reply/:replyId/reveal
// Break-glass unmask endpoint for admin with justification
// ─────────────────────────────────────────────────────────────────────────────
router.post('/re/forum/reply/:replyId/reveal', requireAdmin, async (req, res) => {
    try {
        const replyId = parseInt(req.params.replyId, 10);
        const { justification } = req.body;
        if (isNaN(replyId)) return res.status(400).json({ success: false, message: 'Invalid reply ID.' });
        if (!justification || justification.trim().length < 5) {
            return res.status(400).json({ success: false, message: 'A justification of at least 5 characters is required.' });
        }

        const [[reply]] = await db.query(`
            SELECT fr.reply_id, fr.user_id, fr.is_anonymous,
                   u.first_name, u.last_name, u.role
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.reply_id = ?
        `, [replyId]);

        if (!reply) return res.status(404).json({ success: false, message: 'Reply not found.' });
        if (!reply.is_anonymous) return res.status(400).json({ success: false, message: 'Reply is not anonymous.' });

        await db.query(`
            INSERT INTO forum_unmask_logs (unmasker_id, unmasker_role, target_reply_id, justification)
            VALUES (?, 'admin', ?, ?)
        `, [req.user.user_id, replyId, justification.trim()]);

        await logActivity(req.user.user_id, 'Admin', 'UNMASK_REPLY',
            `Unmasked anonymous reply #${replyId} by student ID ${reply.user_id} (${reply.first_name} ${reply.last_name}). Reason: "${justification.trim()}"`);

        return res.json({
            success: true,
            real_name: `${reply.first_name} ${reply.last_name}`,
            user_id: reply.user_id
        });
    } catch (err) {
        console.error('[Admin Unmask Reply Error]', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/api/forum-unmask-logs
// Audit trail of unmasked anonymous posts
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/forum-unmask-logs', requireAdmin, async (req, res) => {
    try {
        const [logs] = await db.query(`
            SELECT ful.log_id, ful.unmasker_id, ful.unmasker_role, ful.target_reply_id,
                   ful.justification, ful.created_at,
                   COALESCE(CONCAT(u.first_name, ' ', u.last_name), 'Unknown User') AS unmasker_name,
                   COALESCE(CONCAT(author.first_name, ' ', author.last_name), 'Anonymous Student') AS target_author_name,
                   COALESCE(fr.reply_content, '(Reply removed)') AS reply_content
            FROM forum_unmask_logs ful
            LEFT JOIN users u ON ful.unmasker_id = u.user_id
            LEFT JOIN forum_replies fr ON ful.target_reply_id = fr.reply_id
            LEFT JOIN users author ON fr.user_id = author.user_id
            ORDER BY ful.created_at DESC
            LIMIT 100
        `);
        res.json({ success: true, logs: logs || [] });
    } catch (err) {
        console.error('[Admin Get Unmask Logs Error]', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/api/forum-reports
// View flagged discussion posts and moderation reports
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/forum-reports', requireAdmin, async (req, res) => {
    try {
        const [reports] = await db.query(`
            SELECT r.report_id, r.reporter_id, r.reply_id, r.reason, r.details, r.status, r.created_at,
                   COALESCE(CONCAT(rep.first_name, ' ', rep.last_name), 'Unknown Reporter') AS reporter_name,
                   COALESCE(CONCAT(auth.first_name, ' ', auth.last_name), 'Unknown Author') AS author_name,
                   COALESCE(fr.reply_content, '(Reply removed)') AS reply_content,
                   ft.forum_id, ft.title AS forum_title
            FROM forum_reports r
            LEFT JOIN users rep ON r.reporter_id = rep.user_id
            LEFT JOIN forum_replies fr ON r.reply_id = fr.reply_id
            LEFT JOIN users auth ON fr.user_id = auth.user_id
            LEFT JOIN forum_topics ft ON fr.topic_id = ft.forum_id
            ORDER BY r.created_at DESC
            LIMIT 100
        `);
        res.json({ success: true, reports: reports || [] });
    } catch (err) {
        console.error('[Admin Get Forum Reports Error]', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/api/forum-reports/:reportId/status
// Update report status (reviewed, dismissed, actioned)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/api/forum-reports/:reportId/status', requireAdmin, async (req, res) => {
    try {
        const reportId = parseInt(req.params.reportId, 10);
        const { status } = req.body;
        const allowed = ['pending', 'reviewed', 'dismissed', 'actioned'];
        if (isNaN(reportId) || !status || !allowed.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid report ID or status.' });
        }

        await db.query(`UPDATE forum_reports SET status = ? WHERE report_id = ?`, [status, reportId]);

        await logActivity(req.user.user_id, 'Admin', 'MODERATE_FORUM_REPORT',
            `Updated forum moderation report #${reportId} status to "${status}"`);

        res.json({ success: true, status });
    } catch (err) {
        console.error('[Admin Patch Forum Report Error]', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// POST /admin/re/forum/reply/:replyId/reset-votes — Reset votes on a reply (Phase 5)
router.post('/re/forum/reply/:replyId/reset-votes', requireAdmin, async (req, res) => {
    try {
        const replyId = parseInt(req.params.replyId, 10);
        if (isNaN(replyId)) return res.json({ success: false, message: 'Invalid reply ID.' });

        const [[reply]] = await db.query(
            'SELECT reply_id, user_id, topic_id FROM forum_replies WHERE reply_id = ?', [replyId]
        );
        if (!reply) return res.json({ success: false, message: 'Reply not found.' });

        await db.query('DELETE FROM reply_votes WHERE reply_id = ?', [replyId]);

        // Recalculate top_contributor for reply author
        const [[{ totalUpvotes }]] = await db.query(`
            SELECT COUNT(rv.vote_id) AS totalUpvotes
            FROM forum_replies fr
            JOIN reply_votes rv ON fr.reply_id = rv.reply_id
            WHERE fr.user_id = ?
        `, [reply.user_id]);

        const [[thresholdRow]] = await db.query(
            "SELECT threshold_value FROM badge_thresholds WHERE badge_key = 'top_contributor_votes'"
        );
        const threshold = thresholdRow ? thresholdRow.threshold_value : 10;
        await db.query('UPDATE users SET top_contributor = ? WHERE user_id = ?', [
            totalUpvotes >= threshold ? 1 : 0,
            reply.user_id
        ]);

        await logActivity(req.user.user_id, 'Admin', 'RESET_FORUM_REPLY_VOTES',
            `Reset upvotes for reply ID ${replyId} by user ID ${reply.user_id}`);

        return res.json({ success: true, message: 'Votes reset successfully.' });
    } catch (err) {
        console.error('[Admin Reset Reply Votes Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.delete('/re/replies/:id', requireAdmin, async (req, res) => {
    try {
        const replyId = parseInt(req.params.id, 10);
        if (isNaN(replyId)) return res.json({ success: false, message: 'Invalid reply ID.' });

        const [[reply]] = await db.query(
            `SELECT reply_id, topic_id FROM forum_replies WHERE reply_id = ?`, [replyId]
        );
        if (!reply) return res.json({ success: false, message: 'Reply not found.' });

        // Child replies cascade via FK ON DELETE CASCADE (parent_reply_id)
        await db.query(`DELETE FROM forum_replies WHERE reply_id = ?`, [replyId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_FORUM_REPLY',
            `Deleted forum reply ID ${replyId} (forum ID: ${reply.topic_id})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[RE Delete Reply Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PILLAR 3 — ENGAGEMENT ANALYTICS (read-only fetch endpoints)
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/re/interactions?student=&limit=
// Paginated/filtered interaction log. Used if the page needs live refresh.
// Returns: { success: true, interactions: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/re/interactions', requireAdmin, async (req, res) => {
    try {
        const studentFilter = req.query.student ? `%${req.query.student.trim()}%` : null;
        const limit         = Math.min(500, parseInt(req.query.limit, 10) || 100);

        let query, params;

        if (studentFilter) {
            query = `
                SELECT smi.interaction_id, smi.interaction_type, smi.interacted_at,
                       CONCAT(u.first_name,' ',u.last_name) AS student_name,
                       lm.title AS material_title
                FROM student_material_interactions smi
                JOIN users u ON u.user_id = smi.student_id
                JOIN learning_materials lm ON lm.material_id = smi.material_id
                WHERE CONCAT(u.first_name,' ',u.last_name) LIKE ?
                ORDER BY smi.interacted_at DESC
                LIMIT ?
            `;
            params = [studentFilter, limit];
        } else {
            query = `
                SELECT smi.interaction_id, smi.interaction_type, smi.interacted_at,
                       CONCAT(u.first_name,' ',u.last_name) AS student_name,
                       lm.title AS material_title
                FROM student_material_interactions smi
                JOIN users u ON u.user_id = smi.student_id
                JOIN learning_materials lm ON lm.material_id = smi.material_id
                ORDER BY smi.interacted_at DESC
                LIMIT ?
            `;
            params = [limit];
        }

        const [interactions] = await db.query(query, params);
        return res.json({ success: true, interactions });

    } catch (err) {
        console.error('[RE Interactions Error]', err);
        return res.json({ success: false, message: err.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/re/analytics/date-engagement?date=YYYY-MM-DD
// Returns comparison of student interactions with learning materials vs games
// on a specific date, with hourly distribution and engagement evaluation algorithm.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/re/analytics/date-engagement', requireAdmin, async (req, res) => {
    try {
        // Find latest active date across both tables as fallback
        const [[latestMat]] = await db.query(`SELECT SUBSTRING(interacted_at, 1, 10) as d FROM student_material_interactions WHERE interacted_at IS NOT NULL ORDER BY interacted_at DESC LIMIT 1`);
        const [[latestGame]] = await db.query(`SELECT SUBSTRING(started_at, 1, 10) as d FROM elementa_game_sessions WHERE started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
        
        let fallbackDate = new Date().toISOString().slice(0, 10);
        if (latestMat?.d && latestGame?.d) {
            fallbackDate = latestMat.d > latestGame.d ? latestMat.d : latestGame.d;
        } else if (latestMat?.d) {
            fallbackDate = latestMat.d;
        } else if (latestGame?.d) {
            fallbackDate = latestGame.d;
        }

        const dateParam = (req.query.date || '').trim();
        const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : fallbackDate;

        // Fetch distinct available dates with interactions for quick navigation
        const [matDates] = await db.query(`SELECT DISTINCT SUBSTRING(interacted_at, 1, 10) as d FROM student_material_interactions WHERE interacted_at IS NOT NULL`);
        const [gameDates] = await db.query(`SELECT DISTINCT SUBSTRING(started_at, 1, 10) as d FROM elementa_game_sessions WHERE started_at IS NOT NULL`);
        
        const availableDatesSet = new Set();
        matDates.forEach(r => r.d && availableDatesSet.add(r.d));
        gameDates.forEach(r => r.d && availableDatesSet.add(r.d));
        const availableDates = Array.from(availableDatesSet).sort().reverse();

        // 1. Fetch Material Interactions on target date
        const [matRows] = await db.query(`
            SELECT 
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                HOUR(smi.interacted_at) as hour_of_day,
                smi.student_id,
                CONCAT(u.first_name, ' ', u.last_name) as student_name,
                lm.title as material_title
            FROM student_material_interactions smi
            JOIN users u ON u.user_id = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            WHERE SUBSTRING(smi.interacted_at, 1, 10) = ?
            ORDER BY smi.interacted_at ASC
        `, [targetDate]);

        // 2. Fetch Game Sessions on target date
        const [gameRows] = await db.query(`
            SELECT 
                gs.session_id, gs.play_mode, gs.session_status, gs.started_at,
                HOUR(gs.started_at) as hour_of_day,
                gs.student_id_p1, gs.student_id_p2,
                gs.total_duration_s, gs.highest_level_reached, gs.final_score_p1,
                CONCAT(u1.first_name, ' ', u1.last_name) as p1_name,
                CONCAT(u2.first_name, ' ', u2.last_name) as p2_name
            FROM elementa_game_sessions gs
            LEFT JOIN users u1 ON u1.user_id = gs.student_id_p1
            LEFT JOIN users u2 ON u2.user_id = gs.student_id_p2
            WHERE SUBSTRING(gs.started_at, 1, 10) = ?
            ORDER BY gs.started_at ASC
        `, [targetDate]);

        // Hourly distributions (0-23)
        const matHourly = new Array(24).fill(0);
        let matViews = 0, matDownloads = 0;
        const matStudentIds = new Set();

        matRows.forEach(r => {
            if (r.hour_of_day >= 0 && r.hour_of_day <= 23) matHourly[r.hour_of_day]++;
            if (r.interaction_type === 'viewed') matViews++;
            if (r.interaction_type === 'downloaded') matDownloads++;
            if (r.student_id) matStudentIds.add(r.student_id);
        });

        const gameHourly = new Array(24).fill(0);
        let gameCompleted = 0, gameOngoing = 0, gameSolo = 0, gameVersus = 0;
        let totalDurationSec = 0, totalScore = 0;
        const gameStudentIds = new Set();

        gameRows.forEach(r => {
            if (r.hour_of_day >= 0 && r.hour_of_day <= 23) gameHourly[r.hour_of_day]++;
            if (r.session_status === 'Completed') gameCompleted++;
            if (r.session_status === 'Ongoing') gameOngoing++;
            if (r.play_mode === 'Solo') gameSolo++;
            if (r.play_mode === 'Versus') gameVersus++;
            if (r.total_duration_s) totalDurationSec += r.total_duration_s;
            if (r.final_score_p1) totalScore += r.final_score_p1;
            if (r.student_id_p1) gameStudentIds.add(r.student_id_p1);
            if (r.student_id_p2) gameStudentIds.add(r.student_id_p2);
        });

        const vMat = matRows.length;
        const vGame = gameRows.length;
        const uMat = matStudentIds.size;
        const uGame = gameStudentIds.size;

        const iMat = uMat > 0 ? (vMat / uMat) : 0;
        const iGame = uGame > 0 ? (vGame / uGame) : 0;

        // Algorithm Evaluation
        let algorithmResult;
        const totalVolume = vMat + vGame;

        if (totalVolume === 0) {
            algorithmResult = {
                verdict: 'none',
                higherEngagement: 'none',
                badgeText: 'No Interactions Recorded',
                scores: { materials: 0, games: 0 },
                metrics: {
                    volume: { materials: 0, games: 0, matShare: 0, gameShare: 0, weight: 0.50 },
                    reach: { materials: 0, games: 0, matShare: 0, gameShare: 0, weight: 0.35 },
                    intensity: { materials: 0, games: 0, matShare: 0, gameShare: 0, weight: 0.15 }
                },
                summary: `No student interactions with either learning materials or arcade games occurred on ${targetDate}.`,
                recommendation: 'Select another date with student activity or encourage students to explore the vault and arcade.',
                calculationSteps: [
                    'Total interaction volume on selected date is 0.',
                    'Composite Engagement Score requires non-zero interaction touchpoints to evaluate.'
                ]
            };
        } else {
            const vsMat = totalVolume > 0 ? (vMat / totalVolume) * 100 : 0;
            const vsGame = totalVolume > 0 ? (vGame / totalVolume) * 100 : 0;

            const totalReach = uMat + uGame;
            const rsMat = totalReach > 0 ? (uMat / totalReach) * 100 : vsMat;
            const rsGame = totalReach > 0 ? (uGame / totalReach) * 100 : vsGame;

            const totalIntensity = iMat + iGame;
            const isMat = totalIntensity > 0 ? (iMat / totalIntensity) * 100 : vsMat;
            const isGame = totalIntensity > 0 ? (iGame / totalIntensity) * 100 : vsGame;

            const W_V = 0.50, W_R = 0.35, W_I = 0.15;
            let cesMat = (W_V * vsMat) + (W_R * rsMat) + (W_I * isMat);
            let cesGame = (W_V * vsGame) + (W_R * rsGame) + (W_I * isGame);

            const sumCES = cesMat + cesGame;
            if (sumCES > 0) {
                cesMat = Math.round((cesMat / sumCES) * 1000) / 10;
                cesGame = Math.round((100 - cesMat) * 10) / 10;
            }

            let verdict = 'balanced';
            let higherEngagement = 'balanced';
            let badgeText = 'Balanced Multi-Modal Engagement';
            let summary = '';
            let recommendation = '';

            if (cesGame >= 60.0) {
                verdict = 'games_high';
                higherEngagement = 'games';
                badgeText = 'Significantly Higher Game Engagement';
                summary = `Students exhibited substantially higher engagement with arcade games (${cesGame}%) compared to learning materials (${cesMat}%).`;
                recommendation = 'Gamified modules are driving significant engagement. Reinforce core concepts by tying arcade challenges to corresponding reading vault topics.';
            } else if (cesGame > 52.0) {
                verdict = 'games_moderate';
                higherEngagement = 'games';
                badgeText = 'Moderately Higher Game Engagement';
                summary = `Students favored game interactions (${cesGame}%) over learning materials (${cesMat}%).`;
                recommendation = 'Gameplay holds greater interest on this date. Pair upcoming game missions with study material checkpoints for optimal retention.';
            } else if (cesMat >= 60.0) {
                verdict = 'materials_high';
                higherEngagement = 'materials';
                badgeText = 'Significantly Higher Material Engagement';
                summary = `Students exhibited substantially higher engagement with learning materials (${cesMat}%) compared to arcade games (${cesGame}%).`;
                recommendation = 'Students focused heavily on study materials, documents, and slides. Introduce optional arcade missions to test applied knowledge.';
            } else if (cesMat > 52.0) {
                verdict = 'materials_moderate';
                higherEngagement = 'materials';
                badgeText = 'Moderately Higher Material Engagement';
                summary = `Students favored learning materials (${cesMat}%) over arcade games (${cesGame}%).`;
                recommendation = 'Study materials received consistent review. Encourage arcade sessions to reinforce learning with tactile problem solving.';
            } else {
                verdict = 'balanced';
                higherEngagement = 'balanced';
                badgeText = 'Balanced Multi-Modal Engagement';
                summary = `Students engaged evenly between learning materials (${cesMat}%) and arcade games (${cesGame}%).`;
                recommendation = 'Balanced learning behavior observed across both foundational reading and game simulation.';
            }

            const calculationSteps = [
                `Step 1: Volume Share (50% Weight) — Materials: ${vMat} (${vsMat.toFixed(1)}%), Games: ${vGame} (${vsGame.toFixed(1)}%)`,
                `Step 2: Unique Student Reach (35% Weight) — Materials: ${uMat} students (${rsMat.toFixed(1)}%), Games: ${uGame} players (${rsGame.toFixed(1)}%)`,
                `Step 3: Interaction Intensity (15% Weight) — Materials: ${iMat.toFixed(2)}/student (${isMat.toFixed(1)}%), Games: ${iGame.toFixed(2)}/player (${isGame.toFixed(1)}%)`,
                `Step 4: Composite Calculation Formula — CES = (0.50 × VolumeShare) + (0.35 × ReachShare) + (0.15 × IntensityShare)`,
                `Step 5: Resulting Scores — Games: ${cesGame.toFixed(1)}% | Learning Materials: ${cesMat.toFixed(1)}%`
            ];

            algorithmResult = {
                verdict,
                higherEngagement,
                badgeText,
                scores: { materials: cesMat, games: cesGame },
                metrics: {
                    volume: { materials: vMat, games: vGame, matShare: +vsMat.toFixed(1), gameShare: +vsGame.toFixed(1), weight: W_V },
                    reach: { materials: uMat, games: uGame, matShare: +rsMat.toFixed(1), gameShare: +rsGame.toFixed(1), weight: W_R },
                    intensity: { materials: +iMat.toFixed(2), games: +iGame.toFixed(2), matShare: +isMat.toFixed(1), gameShare: +isGame.toFixed(1), weight: W_I }
                },
                summary,
                recommendation,
                calculationSteps
            };
        }

        return res.json({
            success: true,
            date: targetDate,
            availableDates,
            materials: {
                total: vMat,
                uniqueStudents: uMat,
                views: matViews,
                downloads: matDownloads,
                hourly: matHourly,
                items: matRows.slice(0, 50)
            },
            games: {
                total: vGame,
                uniqueStudents: uGame,
                completed: gameCompleted,
                ongoing: gameOngoing,
                solo: gameSolo,
                versus: gameVersus,
                avgDurationSec: vGame > 0 ? Math.round(totalDurationSec / vGame) : 0,
                avgScore: vGame > 0 ? Math.round(totalScore / vGame) : 0,
                hourly: gameHourly,
                items: gameRows.slice(0, 50)
            },
            algorithm: algorithmResult
        });

    } catch (err) {
        console.error('[RE Date Engagement Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/re/activity-feed?limit=
// Latest admin activity audit feed.
// Returns: { success: true, feed: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/re/activity-feed', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);

        const [feed] = await db.query(`
            SELECT log_id, actor_id, actor_role, action, description, created_at
            FROM activity_logs
            ORDER BY created_at DESC
            LIMIT ?
        `, [limit]);

        return res.json({ success: true, feed });

    } catch (err) {
        console.error('[RE Activity Feed Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PILLAR 4 — LEADERBOARD (read endpoints)
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/re/leaderboard?subject_id=&limit=
// Returns master leaderboard (top N by total_exp), optionally per subject.
// Returns: { success: true, leaderboard: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/re/leaderboard', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);

        const [leaderboard] = await db.query(`
            SELECT user_id, first_name, last_name, profile_pic, current_level, total_exp
            FROM users
            WHERE role = 'Student'
            ORDER BY total_exp DESC
            LIMIT ?
        `, [limit]);

        return res.json({ success: true, leaderboard });

    } catch (err) {
        console.error('[RE Leaderboard Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/re/leaderboard-history?subject_id=&limit=
// Returns rank history snapshots.
// Returns: { success: true, history: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/re/leaderboard-history', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);

        const [history] = await db.query(`
            SELECT el.lb_id AS history_id,
                   RANK() OVER (ORDER BY el.best_score_total DESC, el.best_level_reached DESC) AS rank_achieved,
                   el.best_score_total AS total_exp_snapshot,
                   el.last_played_at AS awarded_date,
                   CONCAT(u.first_name,' ',u.last_name) AS student_name
            FROM elementa_leaderboard el
            JOIN users u ON u.user_id = el.student_id
            ORDER BY el.best_score_total DESC, el.best_level_reached DESC
            LIMIT ?
        `, [limit]);

        return res.json({ success: true, history });

    } catch (err) {
        console.error('[RE Leaderboard History Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ██████╗ ███╗   ███╗    ██████╗  ██████╗ ██╗   ██╗████████╗███████╗███████╗
// ██╔══██╗████╗ ████║    ██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔════╝
// ██████╔╝██╔████╔██║    ██████╔╝██║   ██║██║   ██║   ██║   █████╗  ███████╗
// ██╔══██╗██║╚██╔╝██║    ██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ╚════██║
// ██║  ██║██║ ╚═╝ ██║    ██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗███████║
// ╚═╝  ╚═╝╚═╝     ╚═╝    ╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚══════╝
// REPORTS & MONITORING — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
//
// DEPENDENCY NOTE: These routes use the 'xlsx' package (already in admin.js).
// They also use 'pdfkit' for PDF generation. Install once if not yet present:
//   npm install pdfkit
// Then add near the top of admin.js:
//   const PDFDocument = require('pdfkit');
//
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// PAGE LOADER
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/reports_monitoring
// Renders the full Reports & Monitoring Analytical Command Center.
// Supplies ALL variables declared in the EJS header comment block.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reports_monitoring', requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        // ── KPI stats ──────────────────────────────────────────────────────────
        const [[sRow]] = await db.query(`
            SELECT COUNT(DISTINCT cs.student_id) AS cnt 
            FROM class_students cs 
            JOIN classes c ON c.class_id = cs.class_id 
            WHERE c.sy_id = ?
        `, [selectedSY.sy_id]);
        const [[aRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE sy_id = ?`, [selectedSY.sy_id]);
        const [[qRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND sy_id = ?`, [selectedSY.sy_id]);
        const [[mRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM learning_materials WHERE sy_id = ?`, [selectedSY.sy_id]);

        const [[asgtRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE assessment_type = 'Assignment' AND sy_id = ?`, [selectedSY.sy_id]);
        const [asgtCategories] = await db.query(`
            SELECT category, COUNT(*) as cnt 
            FROM assessments 
            WHERE assessment_type = 'Assignment' AND sy_id = ?
            GROUP BY category
        `, [selectedSY.sy_id]);
        let asgtSubmissions = { totalSubmissions: 0, gradedSubmissions: 0, pendingSubmissions: 0, groupSubmissions: 0 };
        try {
            const [[subRow]] = await db.query(`
                SELECT 
                    COUNT(*) as totalSubmissions,
                    COUNT(CASE WHEN ss.score_obtained IS NOT NULL THEN 1 END) as gradedSubmissions,
                    COUNT(CASE WHEN ss.score_obtained IS NULL THEN 1 END) as pendingSubmissions,
                    COUNT(CASE WHEN ss.group_id IS NOT NULL THEN 1 END) as groupSubmissions
                FROM student_scores ss
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                WHERE a.assessment_type = 'Assignment' AND a.sy_id = ?
            `, [selectedSY.sy_id]);
            if (subRow) asgtSubmissions = subRow;
        } catch (_) {}

        const rmStats = {
            totalStudents   : sRow ? sRow.cnt : 0,
            totalAssessments: aRow ? aRow.cnt : 0,
            totalQuestions  : qRow ? qRow.cnt : 0,
            totalMaterials  : mRow ? mRow.cnt : 0,
            totalAssignments: asgtRow ? asgtRow.cnt : 0
        };

        const assignmentMetrics = {
            total: asgtRow ? asgtRow.cnt : 0,
            categories: asgtCategories || [],
            submissions: asgtSubmissions || { totalSubmissions: 0, gradedSubmissions: 0, pendingSubmissions: 0, groupSubmissions: 0 }
        };

        // ─────────────────────────────────────────────────────────────────────
        // TAB 1 — CURRICULUM CONTENTS DATA
        // curriculumData: [ { quarter_number, subject_name, topics: [ { topic_name,
        //   materialCount, assessmentCount, assignmentCount, forumCount, coveredPct } ] } ]
        // coveredPct = proportion of the 4 content categories covered:
        // Materials (25%), Assessments (25%), Assignments (25%), Discussion Forums (25%).
        // Simple formula: min(100, (mC>=1?25:0) + (aC>=1?25:0) + (asgnC>=1?25:0) + (fC>=1?25:0))
        // This yields clean 0%, 25%, 50%, 75%, or 100% progress across all 4 content pillars.
        // ─────────────────────────────────────────────────────────────────────
        const [rawCurriculum] = await db.query(`
            SELECT
                q.quarter_id, q.quarter_number,
                s.subject_name,
                t.topic_id, t.topic_name,
                COUNT(DISTINCT lm.material_id)     AS materialCount,
                COUNT(DISTINCT a.assessment_id)    AS assessmentCount,
                COUNT(DISTINCT asgn.assessment_id) AS assignmentCount,
                COUNT(DISTINCT ft.forum_id)        AS forumCount
            FROM quarters q
            JOIN subjects s ON s.subject_id = q.subject_id
            LEFT JOIN topics t             ON t.quarter_id    = q.quarter_id
            LEFT JOIN learning_materials lm ON lm.topic_id   = t.topic_id AND (lm.sy_id = ? OR lm.sy_id IS NULL)
            LEFT JOIN assessments a         ON a.topic_id    = t.topic_id AND a.sy_id = ? AND (a.assessment_type != 'Assignment' OR a.assessment_type IS NULL)
            LEFT JOIN assessments asgn      ON asgn.topic_id = t.topic_id AND asgn.sy_id = ? AND asgn.assessment_type = 'Assignment'
            LEFT JOIN (
                SELECT ft_inner.forum_id, ft_inner.topic_id
                FROM forum_topics ft_inner
                LEFT JOIN classes cls ON cls.class_id = ft_inner.class_id
                WHERE cls.sy_id = ? OR (ft_inner.class_id IS NULL AND ft_inner.created_at >= ? AND ft_inner.created_at <= ?)
            ) ft ON ft.topic_id = t.topic_id
            GROUP BY q.quarter_id, t.topic_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, t.topic_id ASC
        `, [selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id, selectedSY.start_date || '1970-01-01', selectedSY.end_date || '2099-12-31']);

        // Group into quarters
        const curriculumMap = {};
        rawCurriculum.forEach(row => {
            const key = `${row.quarter_id}`;
            if (!curriculumMap[key]) {
                curriculumMap[key] = {
                    quarter_id    : row.quarter_id,
                    quarter_number: row.quarter_number,
                    subject_name  : row.subject_name,
                    topics        : [],
                };
            }
            if (row.topic_id) {
                const mC = parseInt(row.materialCount,   10) || 0;
                const aC = parseInt(row.assessmentCount, 10) || 0;
                const asgnC = parseInt(row.assignmentCount, 10) || 0;
                const fC = parseInt(row.forumCount,      10) || 0;
                const coveredPct = Math.min(100, (mC >= 1 ? 25 : 0) + (aC >= 1 ? 25 : 0) + (asgnC >= 1 ? 25 : 0) + (fC >= 1 ? 25 : 0));
                curriculumMap[key].topics.push({
                    topic_id       : row.topic_id,
                    topic_name     : row.topic_name,
                    materialCount  : mC,
                    assessmentCount: aC,
                    assignmentCount: asgnC,
                    forumCount     : fC,
                    coveredPct,
                });
            }
        });
        const curriculumData = Object.values(curriculumMap);

        // ─────────────────────────────────────────────────────────────────────
        // TAB 2 — CLASS & TEACHER MAPPING
        // classMapping: [ { class_id, class_name, teacher_name, subject_name,
        //   studentCount, avgScore } ]
        // avgScore = (avg student score_obtained / total_items * 100) across
        //   all scores for any assessment tied to this class's subject.
        // ─────────────────────────────────────────────────────────────────────
        const [classMapping] = await db.query(`
            SELECT
                c.class_id, c.class_name,
                CONCAT(u.first_name,' ',u.last_name) AS teacher_name,
                s.subject_name, s.semester,
                COUNT(DISTINCT cs.student_id) AS studentCount,
                AVG(sg.grade_percent) AS avgScore
            FROM classes c
            LEFT JOIN users u     ON u.user_id    = c.teacher_id
            LEFT JOIN subjects s  ON s.subject_id  = c.subject_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN elementa_student_grades sg
                ON (sg.class_id = c.class_id OR sg.student_id = cs.student_id)
            WHERE c.sy_id = ?
            GROUP BY c.class_id, s.semester
            ORDER BY s.subject_name ASC, c.class_name ASC
        `, [selectedSY.sy_id]);

        // ─────────────────────────────────────────────────────────────────────
        // TAB 3 — STUDENT DOSSIER
        // students: full list with avgScore and interactionCount
        // ─────────────────────────────────────────────────────────────────────
        const [students] = await db.query(`
            SELECT
                u.user_id,
                u.first_name, u.last_name, u.email,
                u.role, u.grade_level, u.section, u.strand,
                u.current_level, u.total_exp,
                u.profile_pic, u.created_at,
                u.lrn_number, u.faculty_id,
                u.sex, u.birthdate, u.mobile_number,
                AVG(sg.grade_percent) AS avgScore,
                COUNT(DISTINCT smi.interaction_id) AS interactionCount
            FROM users u
            JOIN class_students cs ON cs.student_id = u.user_id
            JOIN classes c ON c.class_id = cs.class_id AND c.sy_id = ?
            LEFT JOIN elementa_student_grades sg ON sg.student_id = u.user_id AND (sg.class_id = c.class_id OR sg.class_id IS NULL)
            LEFT JOIN student_material_interactions smi ON smi.student_id = u.user_id AND smi.interacted_at >= ? AND smi.interacted_at <= ?
            WHERE u.role = 'Student'
            GROUP BY u.user_id
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);

        // ─────────────────────────────────────────────────────────────────────
        // TAB 4 — ITEM ANALYSIS & REMEDIATION (Arcade Micro-Telemetry)
        // ─────────────────────────────────────────────────────────────────────

        // Item analysis from elementa_customer_attempts & elementa_questions
        const [rawDistractors] = await db.query(`
            SELECT
                ca.question_id,
                COALESCE(eq.prompt, ca.question_snapshot, 'Arcade Question') AS question_text,
                COALESCE(eq.answer_text, 'Correct') AS correct_answer,
                COUNT(*) AS totalAttempts,
                SUM(ca.is_correct) AS correctCount,
                0 AS countA, 0 AS countB, 0 AS countC, 0 AS countD
            FROM elementa_customer_attempts ca
            LEFT JOIN elementa_questions eq ON eq.question_id = ca.question_id
            WHERE ca.attempted_at >= ? AND ca.attempted_at <= ?
            GROUP BY ca.question_id, eq.prompt, ca.question_snapshot, eq.answer_text
            ORDER BY totalAttempts DESC
            LIMIT 50
        `, [selectedSY.start_date, selectedSY.end_date]);

        const itemAnalysis = rawDistractors.map(row => ({
            question_id   : row.question_id,
            question_text : row.question_text,
            correct_answer: row.correct_answer,
            totalAttempts : parseInt(row.totalAttempts, 10) || 0,
            correctCount  : parseInt(row.correctCount,  10) || 0,
            distractors   : {
                A: parseInt(row.countA, 10) || 0,
                B: parseInt(row.countB, 10) || 0,
                C: parseInt(row.countC, 10) || 0,
                D: parseInt(row.countD, 10) || 0,
            },
        }));

        // Remediation audit — students who scored < 75% on arcade challenges
        const [remediationAudit] = await db.query(`
            SELECT
                CONCAT(u.first_name,' ',u.last_name) AS student_name,
                sg.points_earned AS score,
                sg.points_possible AS total_items,
                sg.grade_percent AS scorePct,
                EXISTS (
                    SELECT 1 FROM student_material_interactions smi
                    WHERE smi.student_id = u.user_id AND smi.interacted_at >= ? AND smi.interacted_at <= ?
                ) AS hasMaterialView
            FROM elementa_student_grades sg
            JOIN users u ON u.user_id = sg.student_id
            JOIN class_students cs ON cs.student_id = u.user_id
            JOIN classes c ON c.class_id = cs.class_id AND c.sy_id = ?
            WHERE sg.grade_percent < 75
            ORDER BY scorePct ASC
            LIMIT 100
        `, [selectedSY.start_date, selectedSY.end_date, selectedSY.sy_id]);

        // ─────────────────────────────────────────────────────────────────────
        // AUDIT SIDEBAR — latest 20 activity logs with actor name
        // ─────────────────────────────────────────────────────────────────────
        const [activityLogs] = await db.query(`
            SELECT
                al.log_id, al.actor_id, al.actor_role, al.action,
                al.description, al.created_at,
                CONCAT(u.first_name,' ',u.last_name) AS actor_name
            FROM activity_logs al
            LEFT JOIN users u ON u.user_id = al.actor_id
            WHERE al.created_at >= ? AND al.created_at <= ?
            ORDER BY al.created_at DESC
            LIMIT 20
        `, [selectedSY.start_date, selectedSY.end_date]);

        // ─────────────────────────────────────────────────────────────────────
        // DROPDOWN FILTERS (subjects, quarters, topics)
        // ─────────────────────────────────────────────────────────────────────
        const [subjects] = await db.query(
            `SELECT subject_id, subject_name FROM subjects ORDER BY subject_name ASC`
        );
        const [quarters] = await db.query(
            `SELECT quarter_id, quarter_number, subject_id FROM quarters ORDER BY quarter_number ASC`
        );
        const [topics] = await db.query(`
            SELECT t.topic_id, t.topic_name, q.quarter_id
            FROM topics t JOIN quarters q ON q.quarter_id = t.quarter_id
            ORDER BY t.topic_id ASC
        `);

        res.render('admin/reports_monitoring', {
            user: req.user,
            rmStats,
            assignmentMetrics,
            curriculumData,
            classMapping,
            students,
            itemAnalysis,
            remediationAudit,
            activityLogs,
            subjects,
            quarters,
            topics,
            questionBank: [],
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY
        });

    } catch (err) {
        console.error('[RM GET Error]', err);
        res.status(500).send('Server error loading Reports & Monitoring: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ── EXPORT: CURRICULUM CONTENTS — Excel ──────────────────────────────────────
router.get('/rm/export/curriculum', requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY } = syContext;

        const [rows] = await db.query(`
            SELECT
                s.subject_name,
                q.quarter_number,
                t.topic_name,
                COUNT(DISTINCT lm.material_id)     AS materialCount,
                COUNT(DISTINCT a.assessment_id)    AS assessmentCount,
                COUNT(DISTINCT asgn.assessment_id) AS assignmentCount,
                COUNT(DISTINCT ft.forum_id)        AS forumCount
            FROM quarters q
            JOIN subjects s ON s.subject_id = q.subject_id
            LEFT JOIN topics t             ON t.quarter_id   = q.quarter_id
            LEFT JOIN learning_materials lm ON lm.topic_id   = t.topic_id AND (lm.sy_id = ? OR lm.sy_id IS NULL)
            LEFT JOIN assessments a         ON a.topic_id    = t.topic_id AND a.sy_id = ? AND (a.assessment_type != 'Assignment' OR a.assessment_type IS NULL)
            LEFT JOIN assessments asgn      ON asgn.topic_id = t.topic_id AND asgn.sy_id = ? AND asgn.assessment_type = 'Assignment'
            LEFT JOIN (
                SELECT ft_inner.forum_id, ft_inner.topic_id
                FROM forum_topics ft_inner
                LEFT JOIN classes cls ON cls.class_id = ft_inner.class_id
                WHERE cls.sy_id = ? OR (ft_inner.class_id IS NULL AND ft_inner.created_at >= ? AND ft_inner.created_at <= ?)
            ) ft ON ft.topic_id = t.topic_id
            GROUP BY q.quarter_id, t.topic_id
            ORDER BY s.subject_name, q.quarter_number, t.topic_id
        `, [selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id, selectedSY.sy_id, selectedSY.start_date || '1970-01-01', selectedSY.end_date || '2099-12-31']);

        const auditRef = generateAuditRef('CUR');
        const wb = new ExcelJS.Workbook();
        wb.creator = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Admin';
        wb.created = new Date();
        const ws = wb.addWorksheet('Curriculum Contents');

        applyExcelMetadataHeader(ws, {
            title: 'Curriculum Contents & Topic Coverage Report',
            scope: 'All Subjects & Quarters',
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — ADMIN EYES ONLY',
            auditRef,
            lastCol: 'H'
        });

        // Header row
        const headerRow = ws.addRow(['Subject', 'Quarter', 'Topic', 'Materials', 'Assessments', 'Assignments', 'Forums', 'Covered %']);
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border    = { bottom: { style: 'thin', color: { argb: 'FF06B6D4' } } };
        });

        rows.forEach((r, idx) => {
            const mC    = parseInt(r.materialCount,   10) || 0;
            const aC    = parseInt(r.assessmentCount, 10) || 0;
            const asgnC = parseInt(r.assignmentCount, 10) || 0;
            const fC    = parseInt(r.forumCount,      10) || 0;
            const pct   = Math.min(100, (mC >= 1 ? 25 : 0) + (aC >= 1 ? 25 : 0) + (asgnC >= 1 ? 25 : 0) + (fC >= 1 ? 25 : 0));
            const row = ws.addRow([
                r.subject_name || '',
                `Quarter ${r.quarter_number}`,
                r.topic_name   || '(No Topics)',
                mC,
                aC,
                asgnC,
                fC,
                `${pct}%`,
            ]);
            if (idx % 2 === 0) {
                row.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                });
            }
        });

        ws.columns = [
            { width: 28 }, { width: 14 }, { width: 34 },
            { width: 14 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }
        ];

        setExportHttpHeaders(res, `curriculum_contents_${auditRef}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await wb.xlsx.write(res);
        res.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CURRICULUM',
            `Exported Curriculum Contents Excel report (Ref: ${auditRef})`);

    } catch (err) {
        console.error('[RM Export Curriculum Error]', err);
        return res.status(500).send('Export failed: ' + err.message);
    }
});


// ── EXPORT: CLASS SUMMARY — PDF (all classes) ───────────────────────────────
router.get('/rm/export/class-summary', requireAdmin, async (req, res) => {
    try {
        const [classes] = await db.query(`
            SELECT
                c.class_id, c.class_name,
                CONCAT(u.first_name,' ',u.last_name) AS teacher_name,
                s.subject_name,
                COUNT(DISTINCT cs.student_id) AS studentCount,
                AVG(sg.grade_percent) AS avgScore
            FROM classes c
            LEFT JOIN users u   ON u.user_id = c.teacher_id
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN elementa_student_grades sg
                ON (sg.class_id = c.class_id OR sg.student_id = cs.student_id)
            GROUP BY c.class_id
            ORDER BY s.subject_name ASC, c.class_name ASC
        `);

        const auditRef = generateAuditRef('CLS-SUM');
        const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
        doc._currentAuditRef = auditRef;

        setExportHttpHeaders(res, `class_summary_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        // Header matching header.docx institutional letterhead
        drawPdfDocumentHeader(doc, {
            title: 'Class & Teacher Mapping — Summary Report',
            scope: 'All Active Academic Classes',
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — ADMIN EYES ONLY',
            auditRef
        });

        // ── Table ────────────────────────────────────────────────────────
        const colWidths = [140, 120, 125, 60, 70];
        const headers   = ['Class / Section', 'Teacher', 'Subject', 'Students', 'Avg Score'];
        const startX    = 40;
        let   y         = doc.y;

        const drawHeader = (curY) => {
            doc.rect(startX, curY, colWidths.reduce((a, b) => a + b, 0), 18).fill('#312E81');
            doc.fillColor('white').fontSize(8.5).font('Helvetica-Bold');
            let hx = startX;
            headers.forEach((h, i) => {
                doc.text(h, hx + 4, curY + 5, { width: colWidths[i] - 6 });
                hx += colWidths[i];
            });
            return curY + 18;
        };

        y = drawHeader(y);
        doc.fillColor('#000000').font('Helvetica').fontSize(8.5);

        classes.forEach((cl, idx) => {
            if (y > 760) {
                doc.addPage();
                drawPdfDocumentHeader(doc, {
                    title: 'Class & Teacher Mapping — Summary Report',
                    user: req.user,
                    role: 'Admin',
                    auditRef,
                    isContinuation: true
                });
                y = drawHeader(doc.y);
                doc.font('Helvetica').fontSize(8.5);
            }
            if (idx % 2 === 0) doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), 16).fill('#f8fafc');
            doc.fillColor('#1e293b');
            let x = startX;
            const avg    = parseFloat(cl.avgScore) || 0;
            const avgStr = cl.avgScore != null ? `${avg.toFixed(1)}%` : '—';
            const cells  = [
                (cl.class_name   || '').substring(0, 24),
                (cl.teacher_name || '—').substring(0, 20),
                (cl.subject_name || '—').substring(0, 22),
                String(cl.studentCount || 0),
                avgStr,
            ];
            cells.forEach((cell, i) => {
                doc.text(cell, x + 4, y + 3, { width: colWidths[i] - 6 });
                x += colWidths[i];
            });
            y += 16;
        });

        if (classes.length === 0) {
            doc.moveDown().fillColor('#64748b').fontSize(10).text('No classes registered.', { align: 'center' });
        }

        attachPdfFooters(doc, auditRef, 'RESTRICTED — ADMIN EYES ONLY');
        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CLASS_SUMMARY',
            `Exported Class Summary PDF (Ref: ${auditRef})`);

    } catch (err) {
        console.error('[RM Export Class Summary Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ── EXPORT: SINGLE CLASS DETAIL — PDF ───────────────────────────────────────
router.get('/rm/export/class/:id', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.status(400).send('Invalid class ID.');

        const gradebookResult = await gradebookHelper.computeClassGradebookData(db, classId, null, {});
        if (!gradebookResult.classes || gradebookResult.classes.length === 0) {
            return res.status(404).render('404', {
                title: 'Class Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Admin',
                requestedPath: req.originalUrl,
                customMessage: 'The requested class record could not be found in the academic repository.'
            });
        }

        const classReport = gradebookResult.classes[0];
        const cls = classReport.classInfo;
        const students = classReport.students;
        const kpis = classReport.kpis;

        // Subject & Semester context determination
        const isSem1 = Number(cls.semester) === 1 || (cls.subject_name && cls.subject_name.toLowerCase().includes('chemistry 1'));
        const qA_label = isSem1 ? 'Q1 Grade' : 'Q3 Grade';
        const qB_label = isSem1 ? 'Q2 Grade' : 'Q4 Grade';
        const qA_num = isSem1 ? 1 : 3;
        const qB_num = isSem1 ? 2 : 4;
        const gateLabel = isSem1 ? 'Chem 2 Prerequisite Gate' : 'SHS Chem Standing';

        // Compute Quarter A and B class means from active student quarter grades
        const qA_scores = students.map(s => s.quarter_grades && s.quarter_grades[qA_num] ? s.quarter_grades[qA_num].finalGrade : null).filter(g => g !== null && g !== undefined);
        const qB_scores = students.map(s => s.quarter_grades && s.quarter_grades[qB_num] ? s.quarter_grades[qB_num].finalGrade : null).filter(g => g !== null && g !== undefined);
        const qA_Mean = qA_scores.length > 0 ? (Math.round((qA_scores.reduce((a, b) => a + b, 0) / qA_scores.length) * 10) / 10) : null;
        const qB_Mean = qB_scores.length > 0 ? (Math.round((qB_scores.reduce((a, b) => a + b, 0) / qB_scores.length) * 10) / 10) : null;

        // Prerequisite Gate Counts for Chemistry 1
        const eligibleCount = students.filter(s => s.chem2_eligibility && s.chem2_eligibility.status === 'ELIGIBLE').length;
        const blockedCount = students.filter(s => s.chem2_eligibility && s.chem2_eligibility.status === 'INELIGIBLE').length;

        const auditRef = generateAuditRef('CLS-DET');
        const doc      = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin: 36,
            bufferPages: true
        });
        doc._currentAuditRef = auditRef;

        const safeClassName = (cls.class_name || 'Class').replace(/[^a-zA-Z0-9_-]/g, '_');
        setExportHttpHeaders(res, `class_performance_${safeClassName}_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        // Header matching header.docx institutional letterhead
        drawPdfDocumentHeader(doc, {
            title: `CLASS PERFORMANCE REPORT — ${cls.class_name.toUpperCase()}`,
            scope: `Teacher: ${cls.teacher_name || '—'}   |   Subject: ${cls.subject_name || 'General Chemistry'} (${isSem1 ? 'Semester 1' : 'Semester 2'})   |   Academic Year: ${cls.sy_range || 'Current SY'}`,
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — ADMIN EYES ONLY',
            auditRef,
            layout: 'landscape'
        });

        // ═════════════════════════════════════════════════════════════════════
        // EXECUTIVE CLASS KPI SNAPSHOT BAR (6 CARDS ACROSS 770pt)
        // ═════════════════════════════════════════════════════════════════════
        const startX = 36;
        let curY = doc.y + 2;
        const cardW = 121;
        const cardH = 38;
        const gap = 8.8;

        const kpiCards = [
            {
                label: 'TOTAL ENROLLED',
                val: `${kpis.totalEnrolled}`,
                sub: `${cls.class_name} Active Roster`,
                color: '#0f172a'
            },
            {
                label: 'CLASS PASSING RATE',
                val: `${kpis.passingRate}%`,
                sub: `${kpis.passedCount}/${kpis.totalEnrolled} Students (≥75%)`,
                color: '#059669'
            },
            {
                label: 'AT-RISK / INTERVENTION',
                val: `${kpis.atRiskRate}%`,
                sub: `${kpis.atRiskCount}/${kpis.totalEnrolled} In Danger (<75%)`,
                color: kpis.atRiskCount > 0 ? '#dc2626' : '#059669'
            },
            {
                label: `${qA_label.toUpperCase()} CLASS MEAN`,
                val: qA_Mean !== null ? `${qA_Mean}%` : '—',
                sub: `${qA_scores.length}/${kpis.totalEnrolled} Encoded`,
                color: '#1e1b4b'
            },
            {
                label: `${qB_label.toUpperCase()} CLASS MEAN`,
                val: qB_Mean !== null ? `${qB_Mean}%` : '—',
                sub: `${qB_scores.length}/${kpis.totalEnrolled} Encoded`,
                color: '#1e1b4b'
            },
            {
                label: isSem1 ? 'CHEM 2 GATE ELIGIBLE' : 'SHS CHEM COMPLETED',
                val: isSem1 ? `${eligibleCount}` : `${kpis.passedCount}`,
                sub: isSem1 ? `${blockedCount} Blocked for Chem 2` : `${kpis.passedCount}/${kpis.totalEnrolled} Completed`,
                color: isSem1 ? (blockedCount > 0 ? '#d97706' : '#059669') : '#059669'
            }
        ];

        let kpiX = startX;
        for (const card of kpiCards) {
            doc.roundedRect(kpiX, curY, cardW, cardH, 5).fillAndStroke('#f8fafc', '#cbd5e1');
            doc.fontSize(6).font('Helvetica-Bold').fillColor('#64748b')
               .text(card.label, kpiX + 3, curY + 4, { width: cardW - 6, align: 'center' });
            doc.fontSize(11).font('Helvetica-Bold').fillColor(card.color)
               .text(card.val, kpiX + 3, curY + 14, { width: cardW - 6, align: 'center' });
            doc.fontSize(5.5).font('Helvetica').fillColor('#64748b')
               .text(card.sub, kpiX + 2, curY + 27, { width: cardW - 4, align: 'center' });
            kpiX += cardW + gap;
        }

        curY += cardH + 10;

        // ═════════════════════════════════════════════════════════════════════
        // DYNAMIC STUDENT ROSTER TABLE (770pt)
        // ═════════════════════════════════════════════════════════════════════
        const COLS = [
            { id: 'num',      title: '#',                      width: 20,  align: 'center' },
            { id: 'lrn',      title: 'LRN Number',             width: 75,  align: 'left' },
            { id: 'name',     title: 'Student Full Name',      width: 135, align: 'left' },
            { id: 'sex',      title: 'Sex',                    width: 30,  align: 'center' },
            { id: 'asmt',     title: 'Written Works',          width: 55,  align: 'center' },
            { id: 'asgn',     title: 'Perf. Tasks',            width: 55,  align: 'center' },
            { id: 'sim',      title: 'Sim Labs',               width: 50,  align: 'center' },
            { id: 'qA',       title: qA_label,                 width: 50,  align: 'center' },
            { id: 'qB',       title: qB_label,                 width: 50,  align: 'center' },
            { id: 'sem',      title: 'Sem. Final',             width: 55,  align: 'center' },
            { id: 'exp',      title: 'Level & EXP',            width: 65,  align: 'center' },
            { id: 'gate',     title: gateLabel,                width: 130, align: 'center' }
        ];

        function drawTableHeader(yPos) {
            const hH = 20;
            doc.rect(startX, yPos, 770, hH).fill('#1e1b4b');
            doc.rect(startX, yPos + hH - 1.5, 770, 1.5).fill('#06b6d4');
            doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff');

            let hX = startX;
            for (const col of COLS) {
                const pad = col.align === 'left' ? 4 : 0;
                doc.text(col.title, hX + pad, yPos + 6, {
                    width: col.width - (pad * 2),
                    align: col.align
                });
                hX += col.width;
            }
            return yPos + hH;
        }

        curY = drawTableHeader(curY);

        if (students.length === 0) {
            curY += 15;
            doc.roundedRect(startX, curY, 770, 60, 6).fillAndStroke('#f8fafc', '#e2e8f0');
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#64748b')
               .text(`No students are currently enrolled in Section "${cls.class_name}" for this academic cycle.`, startX + 10, curY + 20, { width: 750, align: 'center' });
            doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
               .text(`Enroll students into ${cls.subject_name} via Academic Management or User Access Control to populate performance analytics.`, startX + 10, curY + 35, { width: 750, align: 'center' });
        } else {
            const rowH = 15;
            students.forEach((s, idx) => {
                if (curY > 520) {
                    doc.addPage();
                    drawPdfDocumentHeader(doc, {
                        title: `CLASS PERFORMANCE REPORT — ${cls.class_name.toUpperCase()}`,
                        user: req.user,
                        role: 'Admin',
                        auditRef,
                        isContinuation: true,
                        layout: 'landscape'
                    });
                    curY = drawTableHeader(doc.y + 4);
                }

                if (idx % 2 === 0) {
                    doc.rect(startX, curY, 770, rowH).fill('#f8fafc');
                }

                const qA_val = s.quarter_grades && s.quarter_grades[qA_num] ? s.quarter_grades[qA_num].finalGrade : null;
                const qB_val = s.quarter_grades && s.quarter_grades[qB_num] ? s.quarter_grades[qB_num].finalGrade : null;
                const sem_val = s.semestral_grade;

                let gateText = 'N/A';
                let gateColor = '#475569';
                if (isSem1) {
                    if (s.chem2_eligibility && s.chem2_eligibility.status === 'ELIGIBLE') {
                        gateText = 'ELIGIBLE (Chem 2)';
                        gateColor = '#065f46';
                    } else if (s.chem2_eligibility && s.chem2_eligibility.status === 'INELIGIBLE') {
                        gateText = 'BLOCKED (Remedial)';
                        gateColor = '#991b1b';
                    } else {
                        gateText = 'PENDING QUARTERS';
                        gateColor = '#d97706';
                    }
                } else {
                    if (s.standing === 'Passed') {
                        gateText = 'PASSED (SHS Chem)';
                        gateColor = '#065f46';
                    } else if (s.standing === 'At-Risk') {
                        gateText = 'FAILED / AT-RISK';
                        gateColor = '#991b1b';
                    } else {
                        gateText = 'INCOMPLETE';
                        gateColor = '#64748b';
                    }
                }

                const simText = s.sim ? `${s.sim.count || 0} Labs` : '0 Labs';
                const expText = `Lv.${s.current_level || 1} (${Number(s.total_platform_exp || 0).toLocaleString()})`;

                const rowValues = [
                    { val: `${idx + 1}`, align: 'center', color: '#64748b' },
                    { val: s.lrn_number || '—', align: 'left', color: '#1e293b' },
                    { val: (s.full_name || `${s.last_name}, ${s.first_name}`).substring(0, 24), align: 'left', color: '#0f172a', bold: true },
                    { val: s.sex ? s.sex.substring(0, 1).toUpperCase() : '—', align: 'center', color: '#64748b' },
                    { val: s.asmt && s.asmt.pct !== null ? `${s.asmt.pct}%` : '—', align: 'center', color: '#1e293b' },
                    { val: s.asgn && s.asgn.pct !== null ? `${s.asgn.pct}%` : '—', align: 'center', color: '#1e293b' },
                    { val: simText, align: 'center', color: '#4f46e5' },
                    { val: qA_val !== null && qA_val !== undefined ? `${qA_val}%` : '—', align: 'center', color: (qA_val !== null && qA_val >= 75) ? '#065f46' : '#991b1b' },
                    { val: qB_val !== null && qB_val !== undefined ? `${qB_val}%` : '—', align: 'center', color: (qB_val !== null && qB_val >= 75) ? '#065f46' : '#991b1b' },
                    { val: sem_val !== null && sem_val !== undefined ? `${sem_val}%` : '—', align: 'center', color: (sem_val !== null && sem_val >= 75) ? '#065f46' : '#991b1b', bold: true },
                    { val: expText, align: 'center', color: '#334155' },
                    { val: gateText, align: 'center', color: gateColor, bold: true }
                ];

                let rX = startX;
                rowValues.forEach((cell, cIdx) => {
                    const colDef = COLS[cIdx];
                    const pad = colDef.align === 'left' ? 4 : 0;
                    doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5).fillColor(cell.color)
                       .text(cell.val, rX + pad, curY + 4, {
                           width: colDef.width - (pad * 2),
                           align: colDef.align
                       });
                    rX += colDef.width;
                });

                curY += rowH;
            });
        }

        attachPdfFooters(doc, auditRef, 'RESTRICTED — ADMIN EYES ONLY');
        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CLASS_DETAIL',
            `Exported class detail PDF for class ID ${classId}: "${cls.class_name}" (Ref: ${auditRef})`);

    } catch (err) {
        console.error('[RM Export Class Detail Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ── EXPORT: INDIVIDUAL STUDENT DOSSIER — PDF ────────────────────────────────
router.get('/rm/export/student/:id', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).send('Invalid user ID.');

        // Personal info (masked sensitive fields for privacy protection)
        const [[student]] = await db.query(`
            SELECT
                first_name, last_name, email, role, created_at,
                grade_level, section, strand, lrn_number,
                current_level, total_exp, sex, birthdate,
                mobile_number, city_town
            FROM users
            WHERE user_id = ? AND role = 'Student'
        `, [userId]);
        if (!student) {
            return res.status(404).render('404', {
                title: 'Student Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Admin',
                requestedPath: req.originalUrl,
                customMessage: 'The requested student profile could not be found in the registry.'
            });
        }

        // Academic scores - from elementa_student_grades
        const [scores] = await db.query(`
            SELECT
                COALESCE(a.assessment_name, CONCAT('Level ', sg.assessment_number, ' - ', sg.level_topic)) AS assessment_name,
                COALESCE(a.assessment_type, 'Arcade Challenge') AS assessment_type,
                sg.points_earned AS score_obtained,
                sg.points_possible AS total_items,
                sg.points_earned AS exp_gained,
                sg.started_at AS date_recorded
            FROM elementa_student_grades sg
            LEFT JOIN assessments a ON a.assessment_id = sg.assessment_id
            WHERE sg.student_id = ?
            ORDER BY sg.started_at DESC
        `, [userId]);

        // Material interaction count
        const [[intRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM student_material_interactions WHERE student_id = ?`,
            [userId]
        );

        const fullName = `${student.first_name} ${student.last_name}`;
        const auditRef = generateAuditRef('DOS');
        const doc      = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
        doc._currentAuditRef = auditRef;

        setExportHttpHeaders(res, `dossier_${fullName.replace(/[^a-z0-9]/gi, '_')}_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        // Header matching header.docx institutional letterhead
        drawPdfDocumentHeader(doc, {
            title: 'Student Academic Dossier & Cumulative Profile',
            scope: `Student: ${fullName}   |   LRN: ${student.lrn_number || '—'}`,
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — ADMIN EYES ONLY',
            auditRef
        });

        const drawSectionHeader = (title, yPos) => {
            doc.rect(40, yPos, doc.page.width - 80, 18).fill('#eef2ff');
            doc.fillColor('#4338ca').fontSize(9.5).font('Helvetica-Bold')
               .text(title, 48, yPos + 4);
            doc.fillColor('#000000');
        };

        // Mask minor's mobile number: 0917-***-1234
        const rawMobile = student.mobile_number || '';
        const maskedMobile = rawMobile.length >= 7
            ? `${rawMobile.slice(0, 4)}-***-${rawMobile.slice(-4)}`
            : (rawMobile || '—');

        let curY = doc.y;
        drawSectionHeader('PERSONAL INFORMATION (PROTECTED)', curY);
        curY += 24;
        doc.font('Helvetica').fontSize(9);
        const infoRows = [
            ['Full Name',      fullName],
            ['Email',          student.email || '—'],
            ['Grade Level',    student.grade_level || '—'],
            ['Section',        student.section     || '—'],
            ['Strand',         student.strand      || '—'],
            ['LRN',            student.lrn_number  || '—'],
            ['Sex',            student.sex         || '—'],
            ['Birthdate',      student.birthdate ? new Date(student.birthdate).toLocaleDateString('en-PH') : '—'],
            ['Contact Mobile', maskedMobile],
            ['City / Town',    student.city_town   || '—'],
            ['Enrolled Since', student.created_at ? new Date(student.created_at).toLocaleDateString('en-PH') : '—'],
        ];
        infoRows.forEach(([label, value]) => {
            doc.fillColor('#64748b').text(label + ':', 48, curY, { width: 110, continued: false });
            doc.fillColor('#1e293b').text(value, 165, curY);
            curY += 14;
        });

        // ── Arcade Status ────────────────────────────────────────────────
        curY += 6;
        drawSectionHeader('ARCADE STATUS & ENGAGEMENT', curY);
        curY += 24;
        doc.font('Helvetica').fontSize(9);
        [
            ['Current Level', `Level ${student.current_level || 1}`],
            ['Total EXP',     (student.total_exp || 0).toLocaleString() + ' EXP'],
            ['Material Interactions', String(intRow ? intRow.cnt : 0)],
        ].forEach(([label, value]) => {
            doc.fillColor('#64748b').text(label + ':', 48, curY, { width: 150 });
            doc.fillColor('#1e293b').text(value, 205, curY);
            curY += 14;
        });

        // ── Academic Scores ──────────────────────────────────────────────
        curY += 8;
        if (curY > 660) {
            doc.addPage();
            drawPdfDocumentHeader(doc, {
                title: 'Student Academic Dossier & Cumulative Profile',
                user: req.user,
                role: 'Admin',
                auditRef,
                isContinuation: true
            });
            curY = doc.y;
        }
        drawSectionHeader('ASSESSMENT SCORES RECORD', curY);
        curY += 24;

        if (scores.length === 0) {
            doc.fontSize(9).fillColor('#64748b').text('No assessment records found.', 48, curY);
        } else {
            const sCols = [215, 100, 110, 90];
            const sHdrs = ['Assessment', 'Type', 'Score', 'EXP'];
            doc.rect(40, curY, sCols.reduce((a, b) => a + b, 0), 16).fill('#312E81');
            doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
            let sx = 40;
            sHdrs.forEach((h, i) => { doc.text(h, sx + 4, curY + 4, { width: sCols[i] - 6 }); sx += sCols[i]; });
            curY += 16;
            doc.font('Helvetica').fontSize(8);

            scores.forEach((sc, idx) => {
                if (curY > 760) {
                    doc.addPage();
                    drawPdfDocumentHeader(doc, {
                        title: 'Student Academic Dossier & Cumulative Profile',
                        user: req.user,
                        role: 'Admin',
                        auditRef,
                        isContinuation: true
                    });
                    curY = doc.y;
                    doc.rect(40, curY, sCols.reduce((a, b) => a + b, 0), 16).fill('#312E81');
                    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
                    let nsx = 40;
                    sHdrs.forEach((h, i) => { doc.text(h, nsx + 4, curY + 4, { width: sCols[i] - 6 }); nsx += sCols[i]; });
                    curY += 16;
                    doc.font('Helvetica').fontSize(8);
                }
                if (idx % 2 === 0) doc.rect(40, curY, sCols.reduce((a, b) => a + b, 0), 14).fill('#f8fafc');
                const pct     = sc.total_items > 0 ? ((sc.score_obtained / sc.total_items) * 100).toFixed(0) : 0;
                const passing = parseInt(pct, 10) >= 75;
                doc.fillColor(passing ? '#065f46' : '#991b1b');
                const cells = [
                    (sc.assessment_name || 'Unnamed').substring(0, 32),
                    sc.assessment_type  || '—',
                    `${sc.score_obtained}/${sc.total_items} (${pct}%)`,
                    `+${sc.exp_gained || 0}`,
                ];
                sx = 40;
                cells.forEach((cell, i) => {
                    if (i !== 2) doc.fillColor('#1e293b');
                    doc.text(cell, sx + 4, curY + 3, { width: sCols[i] - 6 });
                    sx += sCols[i];
                });
                curY += 14;
            });
        }

        attachPdfFooters(doc, auditRef, 'RESTRICTED — ADMIN EYES ONLY');
        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_STUDENT_DOSSIER',
            `Exported dossier PDF for student: ${fullName} (ID: ${userId}) (Ref: ${auditRef})`);

    } catch (err) {
        console.error('[RM Export Student Dossier Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ── EXPORT: ALL STUDENTS — PDF ──────────────────────────────────────────────
router.get('/rm/export/students-all', requireAdmin, async (req, res) => {
    try {
        const statusFilter = req.query.status || 'all'; // all | pass | fail

        let havingClause = '';
        if (statusFilter === 'pass') havingClause = 'HAVING avgPct >= 75 OR avgPct IS NULL';
        if (statusFilter === 'fail') havingClause = 'HAVING avgPct < 75 AND avgPct IS NOT NULL';

        const [students] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.email,
                u.grade_level, u.section, u.current_level, u.total_exp,
                u.lrn_number,
                AVG(sg.grade_percent) AS avgPct,
                COUNT(DISTINCT smi.interaction_id) AS interactionCount
            FROM users u
            LEFT JOIN elementa_student_grades sg ON sg.student_id = u.user_id
            LEFT JOIN student_material_interactions smi ON smi.student_id = u.user_id
            WHERE u.role = 'Student'
            GROUP BY u.user_id
            ${havingClause}
            ORDER BY u.last_name ASC, u.first_name ASC
        `);

        const auditRef = generateAuditRef('STU-ALL');
        const doc      = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape', bufferPages: true });
        doc._currentAuditRef = auditRef;

        const label    = statusFilter === 'pass' ? 'Passing Students' : statusFilter === 'fail' ? 'Failing Students' : 'All Students';
        setExportHttpHeaders(res, `students_${statusFilter}_${auditRef}.pdf`, 'application/pdf');
        doc.pipe(res);

        // Header matching header.docx institutional letterhead
        drawPdfDocumentHeader(doc, {
            title: `Institutional Student Roster — ${label}`,
            scope: `Filter: ${label}   |   Total Enrolled: ${students.length}`,
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — ADMIN EYES ONLY',
            auditRef,
            layout: 'landscape'
        });

        const colW   = [160, 140, 95, 65, 75, 80, 70, 75];
        const hdrs   = ['Student Name', 'Email', 'LRN', 'Grade', 'Section', 'Avg Score', 'Level', 'Status'];
        const startX = 40;
        let   y      = doc.y;

        const drawLandscapeHeader = (curY) => {
            doc.rect(startX, curY, colW.reduce((a, b) => a + b, 0), 18).fill('#312E81');
            doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
            let hx = startX;
            hdrs.forEach((h, i) => { doc.text(h, hx + 4, curY + 5, { width: colW[i] - 6 }); hx += colW[i]; });
            return curY + 18;
        };

        y = drawLandscapeHeader(y);
        doc.font('Helvetica').fontSize(8);

        students.forEach((s, idx) => {
            if (y > 520) {
                doc.addPage({ layout: 'landscape' });
                drawPdfDocumentHeader(doc, {
                    title: `Institutional Student Roster — ${label}`,
                    user: req.user,
                    role: 'Admin',
                    auditRef,
                    isContinuation: true,
                    layout: 'landscape'
                });
                y = drawLandscapeHeader(doc.y);
                doc.font('Helvetica').fontSize(8);
            }
            if (idx % 2 === 0) doc.rect(startX, y, colW.reduce((a, b) => a + b, 0), 14).fill('#f8fafc');
            const avg     = parseFloat(s.avgPct) || 0;
            const passing = s.avgPct != null && avg >= 75;
            const cells   = [
                `${s.first_name} ${s.last_name}`.substring(0, 26),
                (s.email         || '—').substring(0, 24),
                s.lrn_number     || '—',
                s.grade_level    || '—',
                s.section        || '—',
                s.avgPct != null ? `${avg.toFixed(1)}%` : '—',
                `Lv.${s.current_level}`,
                s.avgPct != null ? (passing ? 'Passing' : 'Failing') : 'N/A',
            ];
            let x = startX;
            cells.forEach((cell, i) => {
                if (i === 7 && s.avgPct != null) doc.fillColor(passing ? '#065f46' : '#991b1b');
                else doc.fillColor('#1e293b');
                doc.text(cell, x + 4, y + 3, { width: colW[i] - 6 });
                x += colW[i];
            });
            y += 14;
        });

        if (students.length === 0) {
            doc.fillColor('#64748b').fontSize(10).text('No students match this filter.', { align: 'center' });
        }

        attachPdfFooters(doc, auditRef, 'RESTRICTED — ADMIN EYES ONLY');
        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_ALL_STUDENTS_PDF',
            `Exported all students report (Filter: ${statusFilter}, Ref: ${auditRef})`);

    } catch (err) {
        console.error('[RM Export All Students Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// TEST PAPER GENERATOR — Printable HTML (opens in new tab → browser print)
// Called by: generateTestPaper() → GET /admin/rm/test-paper?ids=1,2,3&title=...
//
// Generates a printable HTML page with:
//   - Branded school header
//   - Name / Date / Section / Grade blanks
//   - Questions formatted by input_mode (MCQ choices vs blank lines)
//   - Separate Answer Key page at end
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/test-paper', requireAdmin, async (req, res) => {
    try {
        const idsParam = req.query.ids || '';
        const title    = req.query.title ? decodeURIComponent(req.query.title) : 'Examination';

        if (!idsParam) return res.status(400).send('No question IDs provided.');

        const ids = idsParam.split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id) && id > 0);

        if (ids.length === 0) return res.status(400).send('No valid question IDs provided.');

        // Fetch selected questions (from elementa_questions)
        const [questions] = await db.query(`
            SELECT
                eq.question_id,
                eq.prompt AS question_text,
                eq.machine_name AS input_mode,
                eq.steps_json,
                eq.answer_text AS correct_answer,
                eq.difficulty,
                '' AS instruction_override,
                t.topic_name,
                q.quarter_number,
                s.subject_name
            FROM elementa_questions eq
            LEFT JOIN topics   t ON t.topic_id   = eq.topic_id
            LEFT JOIN quarters q ON q.quarter_id  = t.quarter_id
            LEFT JOIN subjects s ON s.subject_id  = q.subject_id
            WHERE eq.question_id IN (?)
        `, [ids]);

        // Parse steps_json for multiple-choice options & answers
        questions.forEach(q => {
            q.option_a = '';
            q.option_b = '';
            q.option_c = '';
            q.option_d = '';
            q.correct_choice = '';

            let steps = [];
            try {
                steps = typeof q.steps_json === 'string' ? JSON.parse(q.steps_json) : (q.steps_json || []);
            } catch (_) {}

            const choiceStep = steps.find(s => s && s.type === 'choice' && Array.isArray(s.options));
            if (choiceStep && Array.isArray(choiceStep.options)) {
                q.option_a = choiceStep.options[0] || '';
                q.option_b = choiceStep.options[1] || '';
                q.option_c = choiceStep.options[2] || '';
                q.option_d = choiceStep.options[3] || '';

                const targetAns = choiceStep.answer || q.correct_answer;
                const matchIdx = choiceStep.options.findIndex(opt => opt === targetAns || (targetAns && typeof targetAns === 'string' && targetAns.includes(opt)));
                if (matchIdx >= 0 && matchIdx < 4) {
                    q.correct_choice = ['A', 'B', 'C', 'D'][matchIdx];
                }
                if (!q.instruction_override && choiceStep.label) {
                    q.instruction_override = choiceStep.label;
                }
            }
        });

        // Preserve the order the admin selected them in
        const orderedQuestions = ids
            .map(id => questions.find(q => q.question_id === id))
            .filter(Boolean);

        const seqMap = {};

        // Build HTML question blocks
        const buildQuestionBlock = (q, num, showAnswers) => {
            const seqs = seqMap[q.question_id] || [];

            let bodyHtml = '';

            if (q.input_mode === 'Standard' || (q.option_a && q.option_b)) {
                const opts = ['A', 'B', 'C', 'D'];
                const vals = [q.option_a, q.option_b, q.option_c, q.option_d];
                const optHtml = opts.map((lbl, i) => {
                    const isCorrect = showAnswers && (q.correct_choice === lbl || q.correct_answer === lbl || q.correct_answer === vals[i]);
                    return `<div style="display:inline-block;width:46%;margin:2px 1%;${isCorrect ? 'background:#d1fae5;border-radius:4px;padding:1px 4px;' : ''}">
                        <span style="font-weight:700;">${lbl}.</span> ${vals[i] || '—'}
                    </div>`;
                }).join('');
                bodyHtml = `<div style="margin-top:4px;">${optHtml}</div>`;

            } else if (q.input_mode === 'Numeric') {
                bodyHtml = showAnswers
                    ? `<p style="margin:4px 0;color:#065f46;font-weight:700;">Answer: ${q.correct_answer || '—'}</p>`
                    : `<div style="margin-top:6px;border-bottom:1.5px solid #000;width:160px;">&nbsp;</div>`;

            } else if (q.input_mode === 'Periodic_Single') {
                bodyHtml = showAnswers
                    ? `<p style="margin:4px 0;color:#065f46;font-weight:700;">Answer: ${q.correct_answer || '—'}</p>`
                    : `<div style="margin-top:6px;border-bottom:1.5px solid #000;width:120px;">&nbsp;</div>`;

            } else if (q.input_mode === 'Periodic_Sequence') {
                if (showAnswers && seqs.length) {
                    const formula = seqs.map(s => `${s.element_symbol}<sub>${s.subscript > 1 ? s.subscript : ''}</sub>`).join('');
                    bodyHtml = `<p style="margin:4px 0;color:#065f46;font-weight:700;">Answer: ${formula}</p>`;
                } else {
                    bodyHtml = `<div style="margin-top:6px;border-bottom:1.5px solid #000;width:200px;">&nbsp;</div>`;
                }
            } else {
                bodyHtml = showAnswers
                    ? `<p style="margin:4px 0;color:#065f46;font-weight:700;">Answer: ${q.correct_answer || '—'}</p>`
                    : `<div style="margin-top:6px;border-bottom:1.5px solid #000;width:200px;">&nbsp;</div>`;
            }

            const instruction = q.instruction_override
                ? `<em style="font-size:10px;color:#64748b;">${q.instruction_override}</em><br>`
                : '';

            return `
                <div style="margin-bottom:16px;page-break-inside:avoid;">
                    <p style="margin:0 0 2px;"><strong>${num}.</strong> ${instruction}${q.question_text}</p>
                    ${bodyHtml}
                </div>
            `;
        };

        const questionsHtml = orderedQuestions
            .map((q, i) => buildQuestionBlock(q, i + 1, false))
            .join('');

        const answerKeyHtml = orderedQuestions.map((q, i) => {
            let ans = q.correct_answer || '';
            if (q.correct_choice) {
                const vals = [q.option_a, q.option_b, q.option_c, q.option_d];
                const optIdx = ['A', 'B', 'C', 'D'].indexOf(q.correct_choice);
                const optText = optIdx >= 0 && vals[optIdx] ? ` (${vals[optIdx]})` : '';
                ans = `${q.correct_choice}${optText}`;
            } else if (q.input_mode === 'Periodic_Sequence') {
                const seqs = seqMap[q.question_id] || [];
                ans = seqs.map(s => `${s.element_symbol}${s.subscript > 1 ? s.subscript : ''}`).join('');
            }
            return `<tr>
                <td style="padding:3px 8px;border:1px solid #e2e8f0;font-size:11px;">${i + 1}</td>
                <td style="padding:3px 8px;border:1px solid #e2e8f0;font-size:11px;max-width:300px;">${q.question_text.substring(0, 60)}...</td>
                <td style="padding:3px 8px;border:1px solid #e2e8f0;font-size:11px;font-weight:700;color:#065f46;">${ans}</td>
            </tr>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
    @page { size: A4; margin: 20mm 18mm; }
    body { font-family: 'Times New Roman', Times, serif; font-size: 12px; color: #000; }
    h1 { font-size: 16px; text-align: center; margin: 0 0 2px; }
    h2 { font-size: 13px; text-align: center; margin: 0 0 12px; }
    .header-block { text-align: center; margin-bottom: 16px; border-bottom: 2px solid #000; padding-bottom: 10px; }
    .info-row { display: flex; gap: 20px; margin-bottom: 12px; font-size: 12px; }
    .info-field { flex: 1; border-bottom: 1px solid #000; padding-bottom: 2px; }
    .section-title { font-weight: 700; font-size: 12px; text-transform: uppercase; background: #e2e8f0; padding: 3px 6px; margin: 12px 0 8px; }
    .answer-key { page-break-before: always; }
    .answer-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    @media print { .no-print { display: none; } }
    .no-print { text-align: center; padding: 16px; background: #4f46e5; color: white; font-family: sans-serif; font-size: 13px; font-weight: bold; cursor: pointer; border-radius: 8px; margin: 16px auto; display: block; max-width: 200px; }
</style>
</head>
<body>

<button class="no-print" onclick="window.print()">🖨️ Print / Save as PDF</button>

<!-- Exam Header -->
<div class="header-block" style="display:flex;align-items:center;gap:14px;justify-content:center;">
    <img src="/assets/mabini-letterhead.png" style="width:60px;height:auto;" alt="Mabini Colleges Seal">
    <div>
        <h1>MABINI COLLEGES, INC.</h1>
        <p style="font-size:11px;margin:0;">HIGH SCHOOL DEPARTMENT (Flora A. Ibana Campus)</p>
        <p style="font-size:10px;margin:0;color:#64748b;">Kapt. Isko St., Daet, Camarines Norte</p>
        <h2 style="margin-top:6px;">${title}</h2>
        <p style="font-size:10px;color:#64748b;">Subject: ${orderedQuestions[0] && orderedQuestions[0].subject_name ? orderedQuestions[0].subject_name : ''} | Total Items: ${orderedQuestions.length}</p>
    </div>
</div>

<div class="info-row">
    <div><span style="font-weight:700;">Name:</span> <span class="info-field" style="display:inline-block;width:220px;">&nbsp;</span></div>
    <div><span style="font-weight:700;">Date:</span> <span class="info-field" style="display:inline-block;width:120px;">&nbsp;</span></div>
</div>
<div class="info-row">
    <div><span style="font-weight:700;">Grade &amp; Section:</span> <span class="info-field" style="display:inline-block;width:150px;">&nbsp;</span></div>
    <div><span style="font-weight:700;">Score:</span> <span class="info-field" style="display:inline-block;width:80px;">&nbsp;</span> / ${orderedQuestions.length}</div>
</div>

<div class="section-title">Directions: Answer all items carefully.</div>

${questionsHtml}

<!-- Answer Key (separate page) -->
<div class="answer-key">
    <div class="header-block">
        <h2>${title} — ANSWER KEY</h2>
        <p style="font-size:9px;color:#64748b;">For teacher use only. Do not distribute to students.</p>
    </div>
    <table class="answer-table">
        <thead>
            <tr>
                <th style="padding:4px 8px;border:1px solid #e2e8f0;background:#f8fafc;font-size:11px;text-align:left;">#</th>
                <th style="padding:4px 8px;border:1px solid #e2e8f0;background:#f8fafc;font-size:11px;text-align:left;">Question (truncated)</th>
                <th style="padding:4px 8px;border:1px solid #e2e8f0;background:#f8fafc;font-size:11px;text-align:left;">Correct Answer</th>
            </tr>
        </thead>
        <tbody>${answerKeyHtml}</tbody>
    </table>
</div>
</body>
</html>`;

        await logActivity(req.user.user_id, 'Admin', 'GENERATE_TEST_PAPER',
            `Generated test paper: "${title}" (${orderedQuestions.length} questions)`);

        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        return res.send(html);

    } catch (err) {
        console.error('[RM Test Paper Error]', err);
        return res.status(500).send('Test paper generation failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ███████╗██╗   ██╗███████╗████████╗███████╗███╗   ███╗     █████╗ ██╗   ██╗██████╗ ██╗████████╗
// ██╔════╝╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝████╗ ████║    ██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝
// ███████╗ ╚████╔╝ ███████╗   ██║   █████╗  ██╔████╔██║    ███████║██║   ██║██║  ██║██║   ██║
// ╚════██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██║╚██╔╝██║    ██╔══██║██║   ██║██║  ██║██║   ██║
// ███████║   ██║   ███████║   ██║   ███████╗██║ ╚═╝ ██║    ██║  ██║╚██████╔╝██████╔╝██║   ██║
// ╚══════╝   ╚═╝   ╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝   ╚═╝
// SYSTEM AUDIT — ALL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/system_audit
// Renders the full System Audit page with:
//   - KPI snapshot (totalLogs, adminActions, teacherActions, studentActions)
//   - Activity bar chart (14-day breakdown by role)
//   - Top most active users
//   - Action type frequency breakdown
//   - Paginated, filterable full activity_logs table
//   - Invitation health (pending / expired / used counts + recent list)
//   - Flagged students (users with flagged_assessment_id)
//   - Question bank audit (pending / approved / rejected + pending list)
//   - Active & recent arcade sessions (active_sessions table)
//   - Competitive match log (competitive_matches table)
//   - School years overview
//   - Classes + enrollment summary
//   - Material interaction log (student_material_interactions)
//   - Forum activity summary (forum_topics + forum_replies)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/system_audit', requireAdmin, async (req, res) => {
    try {
        const syContext = await academicHelper.resolveAdminSchoolYearContext(db, req.query.sy_id);
        const { selectedSY, currentSY, allSchoolYears, isCurrentSY, isHistoricalSY, isDraftSY } = syContext;

        // ── Pagination & filters from query string ─────────────────────────────
        const PAGE_SIZE  = 50;
        const currentPage = Math.max(1, parseInt(req.query.page) || 1);
        const offset      = (currentPage - 1) * PAGE_SIZE;

        const filterSearch = (req.query.search || '').trim();
        const filterRole   = req.query.role   || '';
        const filterAction = req.query.action || '';
        const filterFrom   = req.query.from   || '';
        const filterTo     = req.query.to     || '';

        // Build dynamic WHERE clause for activity_logs
        const whereClauses = [];
        const whereParams  = [];

        if (filterRole) {
            whereClauses.push('al.actor_role = ?');
            whereParams.push(filterRole);
        }
        if (filterAction) {
            whereClauses.push('al.action = ?');
            whereParams.push(filterAction);
        }
        if (filterSearch) {
            whereClauses.push('(al.description LIKE ? OR al.action LIKE ?)');
            whereParams.push(`%${filterSearch}%`, `%${filterSearch}%`);
        }
        if (filterFrom) {
            whereClauses.push('DATE(al.created_at) >= ?');
            whereParams.push(filterFrom);
        } else if (selectedSY && selectedSY.start_date) {
            whereClauses.push('DATE(al.created_at) >= ?');
            whereParams.push(selectedSY.start_date);
        }
        if (filterTo) {
            whereClauses.push('DATE(al.created_at) <= ?');
            whereParams.push(filterTo);
        } else if (selectedSY && selectedSY.end_date) {
            whereClauses.push('DATE(al.created_at) <= ?');
            whereParams.push(selectedSY.end_date);
        }

        const whereSQL = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

        // ── 1. KPI COUNTS ──────────────────────────────────────────────────────
        const [[totalRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs al ${whereSQL}`, whereParams);
        const [[adminRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Admin' AND created_at >= ? AND created_at <= ?`, [selectedSY.start_date, selectedSY.end_date]);
        const [[teacherRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Teacher' AND created_at >= ? AND created_at <= ?`, [selectedSY.start_date, selectedSY.end_date]);
        const [[studentRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Student' AND created_at >= ? AND created_at <= ?`, [selectedSY.start_date, selectedSY.end_date]);

        const auditStats = {
            totalLogs      : totalRow ? totalRow.cnt : 0,
            adminActions   : adminRow ? adminRow.cnt : 0,
            teacherActions : teacherRow ? teacherRow.cnt : 0,
            studentActions : studentRow ? studentRow.cnt : 0,
        };

        const totalPages = Math.max(1, Math.ceil(totalRow.cnt / PAGE_SIZE));

        // ── 2. ACTIVITY CHART — 14 days, stacked by role ───────────────────────
        const [chartRows] = await db.query(`
            SELECT DATE(created_at) AS day, actor_role, COUNT(*) AS total
            FROM activity_logs
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
            GROUP BY DATE(created_at), actor_role
            ORDER BY day ASC
        `);

        const chartLabels = [];
        const adminCounts = [], teacherCounts = [], studentCounts = [];

        for (let i = 13; i >= 0; i--) {
            const d     = new Date();
            d.setDate(d.getDate() - i);
            const key   = d.toISOString().slice(0, 10);
            const label = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
            chartLabels.push(label);

            const dayRows = chartRows.filter(r => new Date(r.day).toISOString().slice(0, 10) === key);
            adminCounts.push(  (dayRows.find(r => r.actor_role === 'Admin')   || { total: 0 }).total);
            teacherCounts.push((dayRows.find(r => r.actor_role === 'Teacher') || { total: 0 }).total);
            studentCounts.push((dayRows.find(r => r.actor_role === 'Student') || { total: 0 }).total);
        }

        const activityChart = { labels: chartLabels, adminCounts, teacherCounts, studentCounts };

        // ── 3. TOP ACTORS — top 10 most active users ───────────────────────────
        const [topActors] = await db.query(`
            SELECT
                al.actor_id,
                al.actor_role,
                CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                COUNT(al.log_id) AS action_count
            FROM activity_logs al
            LEFT JOIN users u ON u.user_id = al.actor_id
            GROUP BY al.actor_id, al.actor_role
            ORDER BY action_count DESC
            LIMIT 10
        `);

        // ── 4. ACTION TYPE BREAKDOWN ────────────────────────────────────────────
        const [actionBreakdown] = await db.query(`
            SELECT action, COUNT(*) AS cnt
            FROM activity_logs
            GROUP BY action
            ORDER BY cnt DESC
        `);

        // ── 5. PAGINATED FULL LOG (with filters) ───────────────────────────────
        const [logs] = await db.query(`
            SELECT
                al.log_id, al.actor_id, al.actor_role, al.ip_address, al.user_agent, al.session_id, al.action, al.description, al.created_at,
                CONCAT(u.first_name, ' ', u.last_name) AS actor_name
            FROM activity_logs al
            LEFT JOIN users u ON u.user_id = al.actor_id
            ${whereSQL}
            ORDER BY al.created_at DESC
            LIMIT ${PAGE_SIZE} OFFSET ${offset}
        `, whereParams);

        // ── 6. INVITATION HEALTH ───────────────────────────────────────────────
        const [[pendingInvRow]] = await db.query(`
            SELECT COUNT(*) AS cnt FROM account_invitations
            WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())
        `);
        const [[expiredInvRow]] = await db.query(`
            SELECT COUNT(*) AS cnt FROM account_invitations
            WHERE is_used = 0 AND expires_at IS NOT NULL AND expires_at < NOW()
        `);
        const [[usedInvRow]]    = await db.query(`
            SELECT COUNT(*) AS cnt FROM account_invitations WHERE is_used = 1
        `);

        const inviteHealth = {
            pending : pendingInvRow.cnt,
            expired : expiredInvRow.cnt,
            used    : usedInvRow.cnt,
        };

        // Recent 10 invitations (any status) for the list
        const [recentInvites] = await db.query(`
            SELECT invitation_id, email, role, is_used, expires_at, created_at
            FROM account_invitations
            ORDER BY created_at DESC
            LIMIT 10
        `);

        // ── 7. FLAGGED STUDENTS ────────────────────────────────────────────────
        const [flaggedStudents] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name,
                u.profile_pic, u.current_level, u.total_exp,
                u.flagged_assessment_id,
                a.assessment_name
            FROM users u
            LEFT JOIN assessments a ON a.assessment_id = u.flagged_assessment_id
            WHERE u.flagged_assessment_id IS NOT NULL
              AND (
                  u.role IN ('Admin', 'Teacher')
                  OR u.user_id IN (SELECT cs.student_id FROM class_students cs WHERE cs.sy_id = ?)
              )
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [selectedSY.sy_id]);

        // ── 8. QUESTION BANK AUDIT (Arcade Challenges) ─────────────────────────
        const [[qTotalRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND sy_id = ?`, [selectedSY.sy_id]);
        const [[qPendingRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND verification_status = 'Pending' AND sy_id = ?`, [selectedSY.sy_id]);
        const [[qApprovedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND verification_status = 'Approved' AND sy_id = ?`, [selectedSY.sy_id]);
        const [[qRejectedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_questions WHERE is_active = 1 AND verification_status = 'Rejected' AND sy_id = ?`, [selectedSY.sy_id]);

        const questionStats = {
            total    : qTotalRow ? qTotalRow.cnt : 0,
            pending  : qPendingRow ? qPendingRow.cnt : 0,
            approved : qApprovedRow ? qApprovedRow.cnt : 0,
            rejected : qRejectedRow ? qRejectedRow.cnt : 0,
        };

        // Questions still pending — show up to 20
        const [pendingQuestions] = await db.query(`
            SELECT
                eq.question_id, eq.prompt AS question_text, eq.difficulty, eq.machine_name AS input_mode,
                COALESCE(t.topic_name, eq.topic) AS topic_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
            FROM elementa_questions eq
            LEFT JOIN topics  t ON t.topic_id   = eq.topic_id
            LEFT JOIN users   u ON u.user_id     = eq.teacher_id
            WHERE eq.is_active = 1 AND eq.verification_status = 'Pending' AND eq.sy_id = ?
            ORDER BY eq.question_id DESC
            LIMIT 20
        `, [selectedSY.sy_id]);

        // ── 9. ACTIVE / RECENT ARCADE SESSIONS ────────────────────────────────
        const [[sessTotalRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions`);
        const [[sessOngoingRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE session_status = 'Ongoing'`);
        const [[sessFinishedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE session_status = 'Finished'`);

        const sessionStats = {
            total    : sessTotalRow.cnt,
            ongoing  : sessOngoingRow.cnt,
            finished : sessFinishedRow.cnt,
        };

        const [activeSessions] = await db.query(`
            SELECT
                s.session_id, s.play_mode AS player_mode, s.highest_level_reached AS current_item_index,
                COALESCE(s.final_score_p1, 0) AS accumulated_score, s.session_status, s.started_at AS start_time,
                COALESCE(a.assessment_name, 'Arcade Session') AS assessment_name, 12 AS total_items,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM elementa_game_sessions s
            LEFT JOIN users        u ON u.user_id        = s.student_id_p1
            LEFT JOIN assessments  a ON a.assessment_id  = s.assessment_id
            ORDER BY
                FIELD(s.session_status, 'Ongoing', 'Finished', 'Abandoned'),
                s.started_at DESC
            LIMIT 50
        `);

        // ── 10. COMPETITIVE MATCH LOG (Arcade Versus Duels) ─────────────────────
        const [[matchTotalRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE play_mode = 'Versus'`);

        const matchStats = { totalMatches: matchTotalRow.cnt };

        const [competitiveMatches] = await db.query(`
            SELECT
                s.session_id AS match_id, s.final_score_p1 AS p1_score, s.final_score_p2 AS p2_score, s.started_at AS match_date,
                COALESCE(a.assessment_name, 'Arcade Versus Match') AS assessment_name,
                CONCAT(p1.first_name, ' ', p1.last_name) AS p1_name,
                CONCAT(p2.first_name, ' ', p2.last_name) AS p2_name,
                s.winner AS winner_name
            FROM elementa_game_sessions s
            LEFT JOIN users        p1 ON p1.user_id = s.student_id_p1
            LEFT JOIN users        p2 ON p2.user_id = s.student_id_p2
            LEFT JOIN assessments  a  ON a.assessment_id = s.assessment_id
            WHERE s.play_mode = 'Versus'
            ORDER BY s.started_at DESC
            LIMIT 50
        `);

        // ── 11. SCHOOL YEARS ───────────────────────────────────────────────────
        const [schoolYears] = await db.query(`
            SELECT sy_id, sy_range, is_active, created_at
            FROM school_years
            ORDER BY sy_range DESC
        `);

        // ── 12. CLASSES SUMMARY ────────────────────────────────────────────────
        const [classesSummary] = await db.query(`
            SELECT
                c.class_id, c.class_name,
                s.subject_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                COUNT(cs.student_id) AS enrolled_count
            FROM classes c
            LEFT JOIN subjects    s  ON s.subject_id = c.subject_id
            LEFT JOIN users       u  ON u.user_id    = c.teacher_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            WHERE c.sy_id = ?
            GROUP BY c.class_id
            ORDER BY c.class_name ASC
        `, [selectedSY.sy_id]);

        // ── 13. MATERIAL INTERACTION LOG ──────────────────────────────────────
        const [[viewRow]]     = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM student_material_interactions 
            WHERE interaction_type = 'viewed' AND interacted_at >= ? AND interacted_at <= ?
        `, [selectedSY.start_date, selectedSY.end_date]);
        const [[downloadRow]] = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM student_material_interactions 
            WHERE interaction_type = 'downloaded' AND interacted_at >= ? AND interacted_at <= ?
        `, [selectedSY.start_date, selectedSY.end_date]);

        const materialStats = {
            totalViews     : viewRow ? viewRow.cnt : 0,
            totalDownloads : downloadRow ? downloadRow.cnt : 0,
        };

        const [materialInteractions] = await db.query(`
            SELECT
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                lm.title AS material_title, lm.material_type,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM student_material_interactions smi
            JOIN users             u  ON u.user_id    = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            WHERE smi.interacted_at >= ? AND smi.interacted_at <= ?
            ORDER BY smi.interacted_at DESC
            LIMIT 50
        `, [selectedSY.start_date, selectedSY.end_date]);

        // ── 14. FORUM ACTIVITY ─────────────────────────────────────────────────
        const [[forumTopicsRow]]   = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM forum_topics ft
            LEFT JOIN classes c ON c.class_id = ft.class_id
            WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);
        const [[forumRepliesRow]]  = await db.query(`
            SELECT COUNT(*) AS cnt 
            FROM forum_replies fr
            JOIN forum_topics ft ON ft.forum_id = fr.topic_id
            LEFT JOIN classes c ON c.class_id = ft.class_id
            WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);

        const [recentForumReplies] = await db.query(`
            SELECT
                fr.reply_id, fr.reply_content, fr.created_at,
                ft.title AS forum_title,
                CONCAT(u.first_name, ' ', u.last_name) AS user_name
            FROM forum_replies fr
            JOIN users        u  ON u.user_id  = fr.user_id
            JOIN forum_topics ft ON ft.forum_id = fr.topic_id
            LEFT JOIN classes c ON c.class_id = ft.class_id
            WHERE c.sy_id = ? OR (ft.class_id IS NULL AND ft.created_at >= ? AND ft.created_at <= ?)
            ORDER BY fr.created_at DESC
            LIMIT 15
        `, [selectedSY.sy_id, selectedSY.start_date, selectedSY.end_date]);

        const forumStats = {
            totalTopics  : forumTopicsRow ? forumTopicsRow.cnt : 0,
            totalReplies : forumRepliesRow ? forumRepliesRow.cnt : 0,
            recentReplies: recentForumReplies,
        };

        // ── Render ─────────────────────────────────────────────────────────────
        res.render('admin/system_audit', {
            user: req.user,
            annotationLogs: [],
            questionTrendLabels: [],
            questionTrendCounts: [],
            questionPieRows: [],

            // KPI
            auditStats,

            // Chart
            activityChart,

            // Actors
            topActors,

            // Action breakdown
            actionBreakdown,

            // Full log (paginated + filtered)
            logs,
            currentPage,
            totalPages,
            filters: {
                search: filterSearch,
                role  : filterRole,
                action: filterAction,
                from  : filterFrom,
                to    : filterTo,
            },

            // Invitations
            inviteHealth,
            recentInvites,

            // Flagged students
            flaggedStudents,

            // Question bank
            questionStats,
            pendingQuestions,

            // Sessions
            sessionStats,
            activeSessions,

            // Competitive
            matchStats,
            competitiveMatches,

            // Academic structure
            schoolYears,
            classesSummary,

            // Materials
            materialStats,
            materialInteractions,

            // Forum
            forumStats,
            selectedSY,
            currentSY,
            allSchoolYears,
            isCurrentSY,
            isHistoricalSY,
            isDraftSY
        });

    } catch (err) {
        console.error('[System Audit GET Error]', err);
        res.status(500).send('Server error loading System Audit: ' + err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/system_audit/export
// Exports the full activity_logs as an Excel (.xlsx) file.
// Columns: Log ID, Actor Name, Actor Role, Action, Description, Date & Time
// ─────────────────────────────────────────────────────────────────────────────
router.get('/system_audit/export', requireAdmin, async (req, res) => {
    try {
        const auditRef = generateAuditRef();
        // Fetch logs with a safe upper limit to protect server memory
        const [rows] = await db.query(`
            SELECT
                al.log_id,
                CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                al.actor_role,
                al.ip_address,
                al.user_agent,
                al.session_id,
                al.action,
                al.description,
                al.created_at
            FROM activity_logs al
            LEFT JOIN users u ON u.user_id = al.actor_id
            ORDER BY al.created_at DESC
            LIMIT 10000
        `);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Elementa Chemistry Arcade LMS';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('System Audit Log');

        // Apply institutional metadata header block (Header.docx standard)
        applyExcelMetadataHeader(worksheet, {
            title: 'SYSTEM AUDIT & ACTIVITY TRAIL REPORT',
            scope: `Latest ${rows.length} System Audit Records`,
            user: req.user,
            role: 'Admin',
            classification: 'RESTRICTED — AUDIT TRAIL (OFFICIAL USE ONLY)',
            auditRef,
            lastCol: 'I'
        });

        // Define Columns
        const headerRow = worksheet.addRow([
            'Log ID', 'Actor Name', 'Actor Role', 'IP Address', 'Device / User Agent', 'Session Token', 'Action', 'Description', 'Date & Time (PST)'
        ]);

        headerRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        headerRow.height = 24;

        worksheet.columns = [
            { width: 10 },  // Log ID
            { width: 25 },  // Actor Name
            { width: 14 },  // Role
            { width: 18 },  // IP Address
            { width: 35 },  // User Agent
            { width: 18 },  // Session ID (masked)
            { width: 28 },  // Action
            { width: 50 },  // Description
            { width: 24 },  // Date
        ];

        rows.forEach(r => {
            // Mask session_id to prevent hijacking via downloaded audit files
            const maskedSession = (r.session_id && r.session_id.length > 6)
                ? `sess_***${r.session_id.slice(-4)}`
                : (r.session_id || '—');

            worksheet.addRow([
                r.log_id,
                r.actor_name || '—',
                r.actor_role || 'System',
                r.ip_address || '—',
                r.user_agent || '—',
                maskedSession,
                r.action,
                r.description || '',
                r.created_at ? new Date(r.created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : ''
            ]);
        });

        const filename = `System_Audit_Log_${new Date().toISOString().slice(0, 10)}_${auditRef}.xlsx`;
        setExportHttpHeaders(res, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        await workbook.xlsx.write(res);

        await logActivity(
            req.user.user_id,
            'Admin',
            'EXPORT_AUDIT_LOG',
            `Exported system audit log (${rows.length} entries, ref: ${auditRef})`
        );

        return res.end();

    } catch (err) {
        console.error('[Audit Export Error]', err);
        return res.status(500).send('Audit export failed: ' + err.message);
    }
});


// ============================================================================
// ENTERPRISE ADMIN RECEIPT AUDIT CONSOLE & CAMPUS GRACE BUFFER CONFIG
// ============================================================================

const { verifyReceipt } = require('../utils/receiptGenerator');

// GET /admin/api/receipts/verify/:hash — Admin Non-Repudiation Lookup Console
router.get('/api/receipts/verify/:hash', requireAdmin, async (req, res) => {
    try {
        const hash = req.params.hash;
        const receipt = await verifyReceipt(hash);
        if (!receipt) {
            return res.status(404).json({
                success: false,
                verified: false,
                message: 'No submission record matches this SHA-256 fingerprint.'
            });
        }
        res.json({
            success: true,
            verified: true,
            receipt
        });
    } catch (err) {
        console.error('[GET /admin/api/receipts/verify/:hash]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /admin/api/receipts/recent — Recent Receipt Audit Feed
router.get('/api/receipts/recent', requireAdmin, async (req, res) => {
    try {
        const [receipts] = await db.query(`
            SELECT sr.*, u.first_name, u.last_name, u.email, a.assessment_name
            FROM submission_receipts sr
            JOIN users u ON sr.student_id = u.user_id
            JOIN assessments a ON sr.assessment_id = a.assessment_id
            ORDER BY sr.server_timestamp DESC
            LIMIT 25
        `);
        res.json({ success: true, receipts });
    } catch (err) {
        console.error('[GET /admin/api/receipts/recent]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/api/settings/grace-buffer — Campus-Wide Default Buffer Configuration
router.post('/api/settings/grace-buffer', requireAdmin, async (req, res) => {
    try {
        const minutes = parseInt(req.body.grace_period_minutes) || 5;

        // Apply to future assessments
        await db.query(`
            UPDATE assessments 
            SET grace_period_minutes = ? 
            WHERE due_date > NOW() OR due_date IS NULL
        `, [minutes]);

        logActivity(req, 'UPDATE_CAMPUS_SETTINGS', `Updated campus-wide grace period buffer to ${minutes} minutes.`, req.user.user_id, 'Admin').catch(() => {});

        res.json({
            success: true,
            message: `Campus default grace period updated to ${minutes} minutes for all upcoming assessments.`,
            grace_period_minutes: minutes
        });
    } catch (err) {
        console.error('[POST /admin/api/settings/grace-buffer]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE AUDIT & CLEANUP APIS (Deliverables, Templates, Samples, Audio Notes)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/storage/audit', requireAdmin, async (req, res) => {
    try {
        const rootDir = path.join(__dirname, '..');
        const directories = [
            { id: 'deliverables', name: 'Deliverables (Submissions)', relPath: 'material_uploads', isSubdir: false },
            { id: 'templates', name: 'Assignment Templates', relPath: path.join('public', 'assignment_templates'), isSubdir: false },
            { id: 'samples', name: 'Assignment Exemplars/Samples', relPath: path.join('public', 'assignment_samples'), isSubdir: false },
            { id: 'audio_notes', name: 'Audio Feedback Notes', relPath: path.join('material_uploads', 'audio_notes'), isSubdir: true }
        ];

        // Collect all DB referenced filenames (including learning_materials and cloud_file_registry)
        let scoreFiles = [];
        try {
            const [rows] = await db.query(`SELECT file_path, voice_note_path FROM student_scores WHERE file_path IS NOT NULL OR voice_note_path IS NOT NULL`);
            scoreFiles = rows;
        } catch (_) {}
        const [asgtFiles] = await db.query(`SELECT format_file_path, sample_output_path FROM assessments WHERE format_file_path IS NOT NULL OR sample_output_path IS NOT NULL`);
        let matFiles = [];
        try {
            const [mRows] = await db.query(`SELECT file_path_or_url FROM learning_materials WHERE file_path_or_url IS NOT NULL`);
            matFiles = mRows;
        } catch (_) {}

        const referencedFiles = new Set();
        scoreFiles.forEach(row => {
            if (row.file_path) referencedFiles.add(path.basename(row.file_path));
            if (row.voice_note_path) referencedFiles.add(path.basename(row.voice_note_path));
        });
        asgtFiles.forEach(row => {
            if (row.format_file_path) referencedFiles.add(path.basename(row.format_file_path));
            if (row.sample_output_path) referencedFiles.add(path.basename(row.sample_output_path));
        });
        matFiles.forEach(row => {
            if (row.file_path_or_url) referencedFiles.add(path.basename(row.file_path_or_url));
        });

        let cloudRecords = [];
        try {
            const [cRows] = await db.query(`SELECT rel_dir, filename, size_bytes, created_at FROM cloud_file_registry`);
            cloudRecords = cRows;
        } catch (_) {}

        let totalFiles = 0;
        let totalSizeBytes = 0;
        let activeFiles = 0;
        let activeSizeBytes = 0;
        let orphanFiles = 0;
        let orphanSizeBytes = 0;

        const dirSummaries = [];
        const orphanList = [];

        for (const dir of directories) {
            const absPath = path.join(rootDir, dir.relPath);
            const normRelDir = dir.relPath.replace(/\\/g, '/');
            let dirFilesCount = 0;
            let dirSizeBytes = 0;
            let dirOrphanCount = 0;
            let dirOrphanBytes = 0;
            const seenInDir = new Set();

            if (fs.existsSync(absPath)) {
                const entries = fs.readdirSync(absPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) continue;
                    const fname = entry.name;
                    if (fname === '.gitkeep' || fname === '.DS_Store') continue;

                    const filePath = path.join(absPath, fname);
                    try {
                        const stat = fs.statSync(filePath);
                        const fileSize = stat.size;
                        seenInDir.add(fname);
                        dirFilesCount++;
                        dirSizeBytes += fileSize;
                        totalFiles++;
                        totalSizeBytes += fileSize;

                        const isReferenced = referencedFiles.has(fname);
                        if (isReferenced) {
                            activeFiles++;
                            activeSizeBytes += fileSize;
                        } else {
                            orphanFiles++;
                            orphanSizeBytes += fileSize;
                            dirOrphanCount++;
                            dirOrphanBytes += fileSize;
                            orphanList.push({
                                folder: dir.name,
                                filename: fname,
                                sizeBytes: fileSize,
                                relativePath: path.join(dir.relPath, fname).replace(/\\/g, '/'),
                                modifiedAt: stat.mtime
                            });
                        }
                    } catch (_) {}
                }
            }

            // Include cloud-stored files that were evicted from local container cache
            for (const cRec of cloudRecords) {
                if (cRec.rel_dir === normRelDir && !seenInDir.has(cRec.filename)) {
                    const fileSize = Number(cRec.size_bytes) || 0;
                    seenInDir.add(cRec.filename);
                    dirFilesCount++;
                    dirSizeBytes += fileSize;
                    totalFiles++;
                    totalSizeBytes += fileSize;

                    const isReferenced = referencedFiles.has(cRec.filename);
                    if (isReferenced) {
                        activeFiles++;
                        activeSizeBytes += fileSize;
                    } else {
                        orphanFiles++;
                        orphanSizeBytes += fileSize;
                        dirOrphanCount++;
                        dirOrphanBytes += fileSize;
                        orphanList.push({
                            folder: `${dir.name} (Cloud Vault)`,
                            filename: cRec.filename,
                            sizeBytes: fileSize,
                            relativePath: `${normRelDir}/${cRec.filename}`,
                            modifiedAt: cRec.created_at
                        });
                    }
                }
            }

            dirSummaries.push({
                id: dir.id,
                name: dir.name,
                path: dir.relPath.replace(/\\/g, '/'),
                totalFiles: dirFilesCount,
                sizeBytes: dirSizeBytes,
                orphanCount: dirOrphanCount,
                orphanBytes: dirOrphanBytes
            });
        }

        const formatBytes = (bytes) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        res.json({
            success: true,
            summary: {
                totalFiles,
                totalSizeBytes,
                totalSizeFormatted: formatBytes(totalSizeBytes),
                activeFiles,
                activeSizeBytes,
                activeSizeFormatted: formatBytes(activeSizeBytes),
                orphanFiles,
                orphanSizeBytes,
                orphanSizeFormatted: formatBytes(orphanSizeBytes)
            },
            directories: dirSummaries,
            orphans: orphanList
        });
    } catch (err) {
        console.error('[GET /admin/api/storage/audit]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/storage/cleanup-orphans', requireAdmin, async (req, res) => {
    try {
        const rootDir = path.join(__dirname, '..');
        const directories = [
            path.join(rootDir, 'material_uploads'),
            path.join(rootDir, 'public', 'assignment_templates'),
            path.join(rootDir, 'public', 'assignment_samples'),
            path.join(rootDir, 'material_uploads', 'audio_notes')
        ];

        // Collect all DB referenced filenames
        let scoreFiles = [];
        try {
            const [rows] = await db.query(`SELECT file_path, voice_note_path FROM student_scores WHERE file_path IS NOT NULL OR voice_note_path IS NOT NULL`);
            scoreFiles = rows;
        } catch (_) {}
        const [asgtFiles] = await db.query(`SELECT format_file_path, sample_output_path FROM assessments WHERE format_file_path IS NOT NULL OR sample_output_path IS NOT NULL`);
        let matFiles = [];
        try {
            const [mRows] = await db.query(`SELECT file_path_or_url FROM learning_materials WHERE file_path_or_url IS NOT NULL`);
            matFiles = mRows;
        } catch (_) {}

        const referencedFiles = new Set();
        scoreFiles.forEach(row => {
            if (row.file_path) referencedFiles.add(path.basename(row.file_path));
            if (row.voice_note_path) referencedFiles.add(path.basename(row.voice_note_path));
        });
        asgtFiles.forEach(row => {
            if (row.format_file_path) referencedFiles.add(path.basename(row.format_file_path));
            if (row.sample_output_path) referencedFiles.add(path.basename(row.sample_output_path));
        });
        matFiles.forEach(row => {
            if (row.file_path_or_url) referencedFiles.add(path.basename(row.file_path_or_url));
        });

        let deletedCount = 0;
        let deletedSizeBytes = 0;
        const cloudStorageEngine = require('../utils/cloudStorageEngine');

        for (const dirPath of directories) {
            const relDir = path.relative(rootDir, dirPath).replace(/\\/g, '/');
            if (fs.existsSync(dirPath)) {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) continue;
                    const fname = entry.name;
                    if (fname === '.gitkeep' || fname === '.DS_Store') continue;

                    if (!referencedFiles.has(fname)) {
                        const filePath = path.join(dirPath, fname);
                        try {
                            const stat = fs.statSync(filePath);
                            fs.unlinkSync(filePath);
                            await cloudStorageEngine.deleteCloudFile(relDir, fname);
                            deletedCount++;
                            deletedSizeBytes += stat.size;
                        } catch (e) {
                            console.warn(`[Cleanup] Failed to unlink ${filePath}:`, e.message);
                        }
                    }
                }
            }

            // Also clean up cloud-only orphans in this directory
            try {
                const [cRows] = await db.query(
                    `SELECT filename, size_bytes FROM cloud_file_registry WHERE rel_dir = ?`,
                    [relDir]
                );
                for (const cRow of cRows) {
                    if (!referencedFiles.has(cRow.filename)) {
                        await cloudStorageEngine.deleteCloudFile(relDir, cRow.filename);
                        deletedCount++;
                        deletedSizeBytes += Number(cRow.size_bytes) || 0;
                    }
                }
            } catch (_) {}
        }

        await logActivity(req.user.user_id, 'Admin', 'CLEANUP_ORPHAN_STORAGE', `Cleaned up ${deletedCount} unlinked files (${(deletedSizeBytes / (1024*1024)).toFixed(2)} MB freed).`);

        res.json({
            success: true,
            deletedCount,
            deletedSizeBytes,
            message: `Successfully purged ${deletedCount} orphan file(s) and freed ${(deletedSizeBytes / (1024*1024)).toFixed(2)} MB.`
        });
    } catch (err) {
        console.error('[POST /admin/api/storage/cleanup-orphans]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ELEMENTA ARCADE HARDWARE & KIOSK FLEET MONITOR (Admin)
// ============================================================
router.get('/arcade-hardware-monitor', requireAdmin, async (req, res) => {
    try {
        // 1. Fetch live kiosk status
        const [kiosks] = await db.query(`SELECT * FROM elementa_kiosk_status ORDER BY cabinet_id ASC`);

        // 2. Question Bank Psychometrics (Difficulty P & Discrimination D)
        const itemPsychometrics = await arcadeAnalyticsService.getQuestionPsychometrics();

        // 3. High-level Fleet Performance
        const [[sessionCounts]] = await db.query(`
            SELECT 
                COUNT(*) AS total_sessions,
                COUNT(DISTINCT student_id_p1) AS total_students_played,
                MAX(started_at) AS last_session_at
            FROM elementa_game_sessions
        `);

        const [[attemptStats]] = await db.query(`
            SELECT 
                COUNT(*) AS total_attempts,
                SUM(is_correct) AS total_correct,
                SUM(is_timeout) AS total_timeouts,
                ROUND(AVG(response_time_s), 1) AS avg_rt
            FROM elementa_customer_attempts
        `);

        // 4. Offline Spool Activity & Recent Sessions
        const [recentSessions] = await db.query(`
            SELECT s.*, 
                   CONCAT(u1.first_name, ' ', u1.last_name) AS p1_name,
                   u1.lrn_number AS p1_lrn
            FROM elementa_game_sessions s
            LEFT JOIN users u1 ON u1.user_id = s.student_id_p1
            ORDER BY s.started_at DESC
            LIMIT 15
        `);


        res.render('admin/arcade_hardware_monitor', {
            user: req.user,
            kiosks: kiosks || [],
            itemPsychometrics: itemPsychometrics || [],
            stats: {
                totalSessions: sessionCounts?.total_sessions || 0,
                totalStudents: sessionCounts?.total_students_played || 0,
                lastSession: sessionCounts?.last_session_at || null,
                totalAttempts: attemptStats?.total_attempts || 0,
                fleetAccuracy: attemptStats?.total_attempts ? Math.round((attemptStats.total_correct / attemptStats.total_attempts) * 100) : 0,
                avgResponseTime: attemptStats?.avg_rt || 0,
                totalTimeouts: attemptStats?.total_timeouts || 0
            },
            recentSessions: recentSessions || []
        });
    } catch (err) {
        console.error('❌ [GET /admin/arcade-hardware-monitor]', err);
        res.status(500).send('Internal Server Error: ' + err.message);
    }
});

module.exports = router;