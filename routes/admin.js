const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const bcrypt     = require('bcrypt');
const crypto     = require('crypto');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

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
        const [[studentRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Student'`);
        const [[teacherRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Teacher'`);
        const [[adminRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Admin'`);
        const [[subjRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM subjects`);
        const [[assessRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM assessments`);
        const [[qbRow]]       = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank`);
        const [[pendInvRow]]  = await db.query(
            `SELECT COUNT(*) AS cnt FROM account_invitations WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())`
        );

        const stats = {
            totalStudents   : studentRow.cnt,
            totalTeachers   : teacherRow.cnt,
            totalAdmins     : adminRow.cnt,
            totalSubjects   : subjRow.cnt,
            totalAssessments: assessRow.cnt,
            totalQuestions  : qbRow.cnt,
            pendingInvites  : pendInvRow.cnt,
        };

        const [[syRow]] = await db.query(`SELECT sy_id, sy_range FROM school_years WHERE is_active = 1 LIMIT 1`);
        let activeSY = null;
        if (syRow) {
            const [[classCountRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM classes WHERE sy_id = ?`, [syRow.sy_id]);
            const [[enrollCountRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM class_students WHERE sy_id = ?`, [syRow.sy_id]);
            activeSY = { sy_id: syRow.sy_id, sy_range: syRow.sy_range, classCount: classCountRow.cnt, enrolledCount: enrollCountRow.cnt };
        }

        const [[expInvRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM account_invitations WHERE is_used = 0 AND expires_at < NOW()`);
        const [[flagRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE flagged_assessment_id IS NOT NULL`);
        const [[lockedPDRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments WHERE is_unlocked = 0 AND due_date IS NOT NULL AND due_date < NOW()`);
        const [[overdueRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM calendar_events WHERE event_type = 'Deadline' AND event_date < CURDATE()`);

        const alerts = {
            expiredInvites  : expInvRow.cnt,
            flaggedStudents : flagRow.cnt,
            lockedPastDue   : lockedPDRow.cnt,
            overdueDeadlines: overdueRow.cnt,
            total           : expInvRow.cnt + flagRow.cnt + lockedPDRow.cnt + overdueRow.cnt,
        };

        const [activeSessions] = await db.query(`
            SELECT s.session_id, s.player_mode, s.current_item_index, s.accumulated_score, s.start_time,
                   a.assessment_name, a.total_items, CONCAT(u.first_name,' ',u.last_name) AS student_name
            FROM active_sessions s
            JOIN users u ON u.user_id = s.student_id
            JOIN assessments a ON a.assessment_id = s.assessment_id
            WHERE s.session_status = 'Ongoing'
            ORDER BY s.start_time DESC
        `);

        const [chartRows] = await db.query(`
            SELECT DATE(date_recorded) AS day, COUNT(*) AS total
            FROM student_scores
            WHERE date_recorded >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY DATE(date_recorded)
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

        const [[preTestRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM student_scores ss JOIN assessments a ON a.assessment_id = ss.assessment_id WHERE a.assessment_type = 'Pre-Test'    AND ss.date_recorded >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);
        const [[postTestRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM student_scores ss JOIN assessments a ON a.assessment_id = ss.assessment_id WHERE a.assessment_type = 'Post-Test'   AND ss.date_recorded >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);
        const [[quizRow]]        = await db.query(`SELECT COUNT(*) AS cnt FROM student_scores ss JOIN assessments a ON a.assessment_id = ss.assessment_id WHERE a.assessment_type = 'Quiz'        AND ss.date_recorded >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);
        const [[competitiveRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM student_scores ss JOIN assessments a ON a.assessment_id = ss.assessment_id WHERE a.assessment_type = 'Competitive' AND ss.date_recorded >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);

        const chartData = { labels, counts, preTestCount: preTestRow.cnt, postTestCount: postTestRow.cnt, quizCount: quizRow.cnt, competitiveCount: competitiveRow.cnt };

        const [topStudents]     = await db.query(`SELECT user_id, first_name, last_name, profile_pic, current_level, total_exp FROM users WHERE role = 'Student' ORDER BY total_exp DESC LIMIT 10`);
        const [recentLogs]      = await db.query(`SELECT al.log_id, al.actor_role, al.action, al.description, al.created_at, CONCAT(u.first_name,' ',u.last_name) AS actor_name FROM activity_logs al LEFT JOIN users u ON u.user_id = al.actor_id ORDER BY al.created_at DESC LIMIT 15`);
        const [recentUsers]     = await db.query(`SELECT user_id, first_name, last_name, role, profile_pic, created_at FROM users ORDER BY created_at DESC LIMIT 5`);
        const [upcomingEvents]     = await db.query(`SELECT ce.event_id, ce.event_title, ce.event_type, ce.event_date, ce.event_location, ce.duration_type, ce.start_date, ce.end_date, ce.duration_minutes, s.subject_name FROM calendar_events ce LEFT JOIN subjects s ON s.subject_id = ce.subject_id WHERE ce.event_date >= CURDATE() ORDER BY ce.event_date ASC LIMIT 5`);
        const [allUpcomingEvents]  = await db.query(`SELECT ce.event_id, ce.event_title, ce.event_type, ce.event_date, ce.event_location, ce.event_description, ce.duration_type, ce.start_date, ce.end_date, ce.duration_minutes, ce.is_repeatable, ce.repeat_cycle, s.subject_name FROM calendar_events ce LEFT JOIN subjects s ON s.subject_id = ce.subject_id WHERE ce.event_date >= CURDATE() ORDER BY ce.event_date ASC`);
        const [[topicsRow]]        = await db.query(`SELECT COUNT(*) AS cnt FROM forum_topics`);
        const [[repliesRow]]       = await db.query(`SELECT COUNT(*) AS cnt FROM forum_replies`);
        const [latestReplies]      = await db.query(`SELECT fr.reply_id, fr.reply_content, fr.created_at, CONCAT(u.first_name,' ',u.last_name) AS user_name, ft.title AS forum_title FROM forum_replies fr JOIN users u ON u.user_id = fr.user_id JOIN forum_topics ft ON ft.forum_id = fr.topic_id ORDER BY fr.created_at DESC LIMIT 3`);
        const forumStats           = { totalTopics: topicsRow.cnt, totalReplies: repliesRow.cnt, latestReplies };
        const [[totalMatchRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM competitive_matches`);
        const [[todayMatchRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM competitive_matches WHERE DATE(match_date) = CURDATE()`);
        const [topWinnerRows]   = await db.query(`SELECT u.first_name, u.last_name, COUNT(cm.match_id) AS win_count FROM competitive_matches cm JOIN users u ON u.user_id = cm.winner_id WHERE cm.winner_id IS NOT NULL GROUP BY cm.winner_id ORDER BY win_count DESC LIMIT 1`);
        const matchStats        = { totalMatches: totalMatchRow.cnt, todayMatches: todayMatchRow.cnt, topWinner: topWinnerRows[0] || null };

        res.render('admin/dashboard', {
            user: req.user, stats, activeSY, alerts, activeSessions,
            chartData, topStudents, recentLogs, recentUsers, upcomingEvents, allUpcomingEvents, forumStats, matchStats,
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

        // 6. AI-generated questions pending approval
        const [pendingQuestions] = await db.query(`
            SELECT qb.question_id, qb.question_text,
                   s.subject_name
            FROM question_bank qb
            JOIN topics t   ON t.topic_id   = qb.topic_id
            JOIN quarters q ON q.quarter_id = t.quarter_id
            JOIN subjects s ON s.subject_id = q.subject_id
            WHERE qb.verification_status = 'Pending'
            ORDER BY qb.question_id DESC LIMIT 10
        `);

        // 7. Active game sessions right now
        const [activeSessions] = await db.query(`
            SELECT s.session_id, s.player_mode, s.start_time,
                   CONCAT(u.first_name,' ',u.last_name) AS student_name,
                   a.assessment_name
            FROM active_sessions s
            JOIN users u ON u.user_id = s.student_id
            JOIN assessments a ON a.assessment_id = s.assessment_id
            WHERE s.session_status = 'Ongoing'
            ORDER BY s.start_time DESC LIMIT 10
        `);

        // 8. New user registrations in last 24 hours
        const [newUsers] = await db.query(`
            SELECT user_id, CONCAT(first_name,' ',last_name) AS full_name,
                   role, profile_pic, created_at
            FROM users
            WHERE created_at >= NOW() - INTERVAL 24 HOUR
            ORDER BY created_at DESC LIMIT 10
        `);

        const total = expiredInvites.length + flaggedStudents.length +
                      lockedPastDue.length + overdueDeadlines.length +
                      pendingQuestions.length;

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
// NODEMAILER — Transporter (shared by all email-sending routes)
// Reads from process.env.EMAIL_USER / process.env.EMAIL_PASS
// ─────────────────────────────────────────────────────────────────────────────
function createTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });
}
 
// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/user_access_control
// Renders the full UAC page.
// EJS expects: user, users, flaggedUsers, invitations, uacStats
// REQ#7 — invitations is filtered to is_used = 0 ONLY (no Used records sent).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user_access_control', requireAdmin, async (req, res) => {
    try {
        // ── Confirmed users (those who completed registration) ────────────────
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
                created_at
            FROM users
            ORDER BY role ASC, last_name ASC, first_name ASC
        `);
 
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
            ORDER BY u.last_name ASC, u.first_name ASC
        `);
 
        // ── REQ#7 — Only pending (unconfirmed, not-used) invitations ─────────
        const [invitations] = await db.query(`
            SELECT invitation_id, email, role, token, is_used, expires_at, created_at
            FROM account_invitations
            WHERE is_used = 0
            ORDER BY created_at DESC
        `);
 
        // ── KPI stats ─────────────────────────────────────────────────────────
        const [[sRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Student'`);
        const [[tRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Teacher'`);
        const [[aRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Admin'`);
        const [[pRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM account_invitations
             WHERE is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())`
        );
 
        const uacStats = {
            totalStudents : sRow.cnt,
            totalTeachers : tRow.cnt,
            totalAdmins   : aRow.cnt,
            pendingInvites: pRow.cnt,
        };
 
        res.render('admin/user_access_control', {
            user: req.user,
            users,
            flaggedUsers,
            invitations,
            uacStats,
        });
 
    } catch (err) {
        console.error('[UAC GET Error]', err);
        res.status(500).send('Server error loading User & Access Control: ' + err.message);
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
            facultyId, department,
        } = req.body;
 
        // ── Required field validation ─────────────────────────────────────────
        if (!firstName || !firstName.trim())
            return res.json({ success: false, message: 'First name is required.' });
        if (!lastName || !lastName.trim())
            return res.json({ success: false, message: 'Last name is required.' });
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
 
        // REQ#6 — Faculty ID uniqueness for Teacher/Admin
        if ((role === 'Teacher' || role === 'Admin') && facultyId && facultyId.trim()) {
            const [[fidEx]] = await db.query(
                `SELECT user_id FROM users WHERE faculty_id = ?`, [facultyId.trim()]
            );
            if (fidEx)
                return res.json({ success: false, duplicate: true, message: `Faculty ID "${facultyId.trim()}" is already in use.` });
        }
 
        // Build invitation token and expiry
        const token    = generateInviteToken();
        let expiresAt  = null;
        if (expiryHours && !isNaN(parseInt(expiryHours))) {
            expiresAt = new Date(Date.now() + parseInt(expiryHours) * 3600 * 1000);
        }
 
        // Build prefill_data JSON — all admin-supplied fields stored in the invitation row.
        // The /setup-profile route reads this via token lookup and pre-populates fields.
        const prefillData = JSON.stringify({
            firstName   : firstName   ? firstName.trim()   : null,
            middleName  : middleName  ? middleName.trim()  : null,
            lastName    : lastName    ? lastName.trim()    : null,
            suffix      : suffix      ? suffix.trim()      : null,
            sex         : sex         ? sex.trim()         : null,
            birthdate   : birthdate   || null,
            lrn         : (role === 'Student' && lrn)        ? lrn.trim()      : null,
            gradeLevel  : (role === 'Student' && gradeLevel) ? gradeLevel      : null,
            section     : (role === 'Student' && section)    ? section.trim()  : null,
            strand      : (role === 'Student' && strand)     ? strand.trim()   : null,
            interests   : (role === 'Student' && interests)  ? interests.trim(): null,
            facultyId   : ((role === 'Teacher'||role==='Admin') && facultyId)  ? facultyId.trim()  : null,
            department  : ((role === 'Teacher'||role==='Admin') && department) ? department.trim() : null,
        });
 
        // Delete any old used/expired record for this email (UNIQUE constraint)
        // Only delete old real invitation records, not reset tokens
        await db.query(
            `DELETE FROM account_invitations WHERE email = ? AND role IN ('Admin', 'Teacher', 'Student')`,
            [cleanEmail]
        );
 
        await db.query(
            `INSERT INTO account_invitations (email, role, token, expires_at, prefill_data) VALUES (?, ?, ?, ?, ?)`,
            [cleanEmail, role, token, expiresAt, prefillData]
        );
 
        // ── Build registration link ───────────────────────────────────────────
        const baseUrl  = process.env.APP_URL || 'http://localhost:3000';
        const regLink  = `${baseUrl}/setup-profile?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
        const fullName = `${firstName.trim()} ${lastName.trim()}`;
 
        // ── Build role-specific info block for email body ─────────────────────
        let roleInfoHtml = '';
        if (role === 'Student') {
            roleInfoHtml = `
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>LRN:</b></td><td style="padding:4px 8px;font-size:13px;">${lrn || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Grade:</b></td><td style="padding:4px 8px;font-size:13px;">${gradeLevel || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Section:</b></td><td style="padding:4px 8px;font-size:13px;">${section || '—'}</td></tr>
                <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Strand:</b></td><td style="padding:4px 8px;font-size:13px;">${strand || '—'}</td></tr>
            `;
        } else if (role === 'Teacher' || role === 'Admin') {
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
 
        await createTransporter().sendMail(mailOptions);
 
        await logActivity(req.user.user_id, 'Admin', 'SEND_INVITATION',
            `Sent ${role} invitation to: ${cleanEmail}`);
 
        return res.json({ success: true, token });
 
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
 
        // Scores and responses
        const [scoreRows] = await db.query(
            `SELECT score_id FROM student_scores WHERE student_id = ?`, [userId]
        );
        const scoreIds = scoreRows.map(r => r.score_id);
        if (scoreIds.length) {
            await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
        }
        await db.query(`DELETE FROM student_scores WHERE student_id = ?`, [userId]);
 
        // Active sessions
        await db.query(`DELETE FROM active_sessions WHERE student_id = ?`, [userId]);
 
        // Competitive matches
        await db.query(`DELETE FROM competitive_matches WHERE p1_id = ? OR p2_id = ? OR winner_id = ?`, [userId, userId, userId]);
 
        // Leaderboard history
        await db.query(`DELETE FROM leaderboard_history WHERE student_id = ?`, [userId]);
 
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
        await db.query(`UPDATE question_bank SET teacher_id = NULL WHERE teacher_id = ?`, [userId]);
 
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
 
        if (!req.file) return res.json({ success: false, message: 'No file uploaded.' });
 
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
 
        if (rows.length === 0)
            return res.json({ success: false, message: 'The uploaded file contains no data rows.' });
 
        const maxRows = type === 'student' ? 500 : 200;
        if (rows.length > maxRows)
            return res.json({ success: false, message: `Maximum ${maxRows} rows per import for ${role}.` });
 
        let created = 0, skipped = 0, errors = 0;
        const log   = [];
        const transporter = createTransporter();
 
        for (const rawRow of rows) {
            // Normalise keys: strip asterisks
            const row = {};
            for (const [k, v] of Object.entries(rawRow)) {
                row[k.replace('*', '').replace('(YYYY-MM-DD)', '').trim()] = String(v).trim();
            }
 
            const { first_name, last_name, email } = row;
 
            if (!first_name || !last_name || !email) {
                log.push({ ok: false, msg: `Skipped — missing required field(s): ${email || '(no email)'}` });
                skipped++;
                continue;
            }
 
            const cleanEmail = email.toLowerCase();
 
            try {
                // REQ#6 — Check duplicate in users table
                const [[existUser]] = await db.query(
                    `SELECT user_id FROM users WHERE email = ?`, [cleanEmail]
                );
                if (existUser) {
                    log.push({ ok: false, msg: `Skipped — already a registered user: ${cleanEmail}` });
                    skipped++;
                    continue;
                }
 
                // REQ#6 — Check duplicate in pending invitations
                const [[existInv]] = await db.query(
                    `SELECT invitation_id FROM account_invitations WHERE email = ? AND is_used = 0`,
                    [cleanEmail]
                );
                if (existInv) {
                    log.push({ ok: false, msg: `Skipped — pending invite already exists: ${cleanEmail}` });
                    skipped++;
                    continue;
                }
 
                // REQ#4 / REQ#6 — LRN uniqueness for students
                if (type === 'student' && row.lrn_number) {
                    if (!/^\d{12}$/.test(row.lrn_number)) {
                        log.push({ ok: false, msg: `Skipped — LRN must be 12 digits: ${cleanEmail} (got: ${row.lrn_number})` });
                        skipped++;
                        continue;
                    }
                    const [[lrnEx]] = await db.query(
                        `SELECT user_id FROM users WHERE lrn_number = ?`, [row.lrn_number]
                    );
                    if (lrnEx) {
                        log.push({ ok: false, msg: `Skipped — LRN already exists: ${row.lrn_number} (${cleanEmail})` });
                        skipped++;
                        continue;
                    }
                }
 
                // REQ#6 — Faculty ID uniqueness for teachers
                if (type === 'teacher' && row.faculty_id) {
                    const [[fidEx]] = await db.query(
                        `SELECT user_id FROM users WHERE faculty_id = ?`, [row.faculty_id]
                    );
                    if (fidEx) {
                        log.push({ ok: false, msg: `Skipped — Faculty ID already exists: ${row.faculty_id} (${cleanEmail})` });
                        skipped++;
                        continue;
                    }
                }
 
                // Generate invitation token
                const token    = generateInviteToken();
                const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days
 
                // Remove any old used/expired record for this email
                // Only delete old real invitation records, not reset tokens
                await db.query(
                    `DELETE FROM account_invitations WHERE email = ? AND role IN ('Admin', 'Teacher', 'Student')`,
                    [cleanEmail]
                );
 
                // Store prefill data from Excel row
                const bulkPrefill = JSON.stringify({
                    firstName  : row.first_name  || null,
                    middleName : row.middle_name || null,
                    lastName   : row.last_name   || null,
                    suffix     : row.suffix      || null,
                    sex        : row.sex         || null,
                    birthdate  : row.birthdate   || null,
                    lrn        : type === 'student' ? (row.lrn_number    || null) : null,
                    gradeLevel : type === 'student' ? (row.grade_level   || null) : null,
                    section    : type === 'student' ? (row.section       || null) : null,
                    strand     : type === 'student' ? (row.strand        || null) : null,
                    interests  : type === 'student' ? (row.interests     || null) : null,
                    facultyId  : type === 'teacher' ? (row.faculty_id    || null) : null,
                    department : type === 'teacher' ? (row.department    || null) : null,
                    mobileNumber : row.mobile_number || null,
                    cityTown     : row.city_town     || null,
                });
 
                await db.query(
                    `INSERT INTO account_invitations (email, role, token, expires_at, prefill_data) VALUES (?, ?, ?, ?, ?)`,
                    [cleanEmail, role, token, expiresAt, bulkPrefill]
                );
 
                // Send invitation email
                const baseUrl  = process.env.APP_URL || 'http://localhost:3000';
                const regLink  = `${baseUrl}/setup-profile?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
                const fullName = `${first_name} ${last_name}`;
 
                const mailOptions = {
                    from   : `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`,
                    to     : cleanEmail,
                    subject: `You're invited to Chemistry Arcade LMS as a ${role}`,
                    html   : `
                        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                            <div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);padding:24px 28px;">
                                <h1 style="color:white;margin:0;font-size:20px;font-weight:900;">⚗️ Chemistry Arcade LMS</h1>
                            </div>
                            <div style="padding:24px 28px;background:white;">
                                <p style="font-size:15px;color:#1e293b;">Hello <b>${fullName}</b>,</p>
                                <p style="font-size:14px;color:#475569;line-height:1.6;">
                                    You have been invited to join <b>Chemistry Arcade LMS</b> as a <b style="color:#4f46e5;">${role}</b>.
                                    Click the link below to complete your registration and set your own password.
                                </p>
                                <div style="text-align:center;margin:24px 0;">
                                    <a href="${regLink}" style="background:linear-gradient(135deg,#4f46e5,#06b6d4);color:white;padding:12px 28px;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;display:inline-block;">
                                        ✉️ Complete Registration
                                    </a>
                                </div>
                                <p style="font-size:11px;color:#94a3b8;text-align:center;">This link expires in 7 days.</p>
                            </div>
                        </div>
                    `,
                };
 
                await transporter.sendMail(mailOptions);
 
                log.push({ ok: true, msg: `✔ Invited: ${fullName} (${cleanEmail})` });
                created++;
 
            } catch (rowErr) {
                log.push({ ok: false, msg: `Error for ${cleanEmail}: ${rowErr.message}` });
                errors++;
            }
        }
 
        await logActivity(req.user.user_id, 'Admin', 'BULK_INVITE',
            `Bulk invited ${created} ${role}(s) — skipped: ${skipped}, errors: ${errors}`);
 
        return res.json({ success: true, created, skipped, errors, log });
 
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
// Returns: .xlsx file download
// ─────────────────────────────────────────────────────────────────────────────
router.get('/uac/bulk-template', requireAdmin, (req, res) => {
    const type = req.query.type === 'teacher' ? 'teacher' : 'student';
 
    // REQ#2 — No password column. Invitation flow handles password creation.
    const studentHeaders = [
        'first_name*',
        'middle_name',
        'last_name*',
        'suffix',
        'email*',
        'lrn_number',
        'grade_level',
        'section',
        'strand',
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
        'faculty_id',
        'department',
        'sex',
        'birthdate(YYYY-MM-DD)',
        'mobile_number',
        'city_town',
    ];
 
    const headers = type === 'teacher' ? teacherHeaders : studentHeaders;
 
    const sampleStudent = [
        'Juan', 'Santos', 'Dela Cruz', 'Jr.',
        'juan@gmail.com',
        '123456789012', 'Grade 11', 'STEM-A', 'Academic Track',
        'Male', '2007-05-14', '+63 912 345 6789', 'Batangas City',
        'I love chemistry!', 'Gaming, Science',
    ];
 
    const sampleTeacher = [
        'Maria', '', 'Santos', '',
        'teacher@gmail.com',
        'FAC-001', 'Science Department',
        'Female', '1990-03-22', '+63 917 000 0000', 'Batangas City',
    ];
 
    const sample = type === 'teacher' ? sampleTeacher : sampleStudent;
 
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${type}_invite_template`);
 
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
 
    res.setHeader('Content-Disposition', `attachment; filename="uac_${type}_invite_template.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
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
        // ── All school years ──────────────────────────────────────────────────
        const [allSchoolYears] = await db.query(
            `SELECT sy_id, sy_range, is_active, created_at FROM school_years ORDER BY sy_range DESC`
        );
        // Show only 2 latest in the card; all go to the "past SY" modal
        const schoolYears    = allSchoolYears.slice(0, 2);
        const pastSchoolYears = allSchoolYears; // all, sorted latest-to-oldest

        // ── Active school year with class/enroll counts ───────────────────────
        let activeSY = null;
        const activeSYRow = schoolYears.find(sy => sy.is_active);
        if (activeSYRow) {
            const [[classCountRow]]  = await db.query(
                `SELECT COUNT(*) AS cnt FROM classes WHERE sy_id = ?`, [activeSYRow.sy_id]
            );
            const [[enrollCountRow]] = await db.query(
                `SELECT COUNT(*) AS cnt FROM class_students WHERE sy_id = ?`, [activeSYRow.sy_id]
            );
            activeSY = {
                ...activeSYRow,
                classCount   : classCountRow.cnt,
                enrolledCount: enrollCountRow.cnt,
            };
        }

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

        // ── KPI stat cards ────────────────────────────────────────────────────
        const [[subjRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM subjects`);
        const [[quarRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM quarters`);
        const [[topicRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM topics`);
        const [[classRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM classes`);

        const amStats = {
            totalSubjects : subjRow.cnt,
            totalQuarters : quarRow.cnt,
            totalTopics   : topicRow.cnt,
            totalClasses  : classRow.cnt,
        };

        res.render('admin/academic_management', {
            user          : req.user,
            schoolYears,
            pastSchoolYears,
            activeSY,
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
// SCHOOL YEARS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years
// Create a new school year.
// Body: { sy_range }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years', requireAdmin, async (req, res) => {
    try {
        const { sy_range } = req.body;

        if (!sy_range || !sy_range.trim())
            return res.json({ success: false, message: 'SY range is required.' });

        const cleanRange = sy_range.trim();

        // Must be strictly YYYY-YYYY digits only — no letters or other characters
        if (!/^\d{4}-\d{4}$/.test(cleanRange))
            return res.json({ success: false, message: 'Format must be YYYY-YYYY using numbers only (e.g. 2025-2026). Letters are not accepted.' });

        const [startYear, endYear] = cleanRange.split('-').map(Number);

        // End year must be exactly start year + 1
        if (endYear !== startYear + 1)
            return res.json({ success: false, message: `Invalid range: "${cleanRange}". The second year must be exactly one year after the first (e.g. 2026-2027).` });

        const currentYear = new Date().getFullYear();

        // Cannot add a school year that is fully in the past
        if (startYear < currentYear)
            return res.json({ success: false, message: `"${cleanRange}" is a past school year and can no longer be added.` });

        // Cannot add a future school year — only the current year's SY is allowed
        if (startYear > currentYear)
            return res.json({ success: false, message: `"${cleanRange}" is too far in advance. You can only add the current school year (${currentYear}-${currentYear + 1}).` });

        // Check duplicate
        const [[existing]] = await db.query(
            `SELECT sy_id FROM school_years WHERE sy_range = ?`, [cleanRange]
        );
        if (existing)
            return res.json({ success: false, message: `School year "${cleanRange}" already exists.` });

        await db.query(`INSERT INTO school_years (sy_range, is_active) VALUES (?, 0)`, [cleanRange]);

        await logActivity(req.user.user_id, 'Admin', 'CREATE_SCHOOL_YEAR',
            `Created school year: ${cleanRange}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Create SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id
// Edit an existing school year's range.
// Body: { sy_range }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id', requireAdmin, async (req, res) => {
    try {
        const syId      = parseInt(req.params.id, 10);
        const { sy_range } = req.body;

        if (isNaN(syId))                        return res.json({ success: false, message: 'Invalid school year ID.' });
        if (!sy_range || !sy_range.trim())      return res.json({ success: false, message: 'SY range is required.' });

        const cleanRange = sy_range.trim();

        if (!/^\d{4}-\d{4}$/.test(cleanRange))
            return res.json({ success: false, message: 'Format must be YYYY-YYYY using numbers only (e.g. 2025-2026).' });

        const [startYear, endYear] = cleanRange.split('-').map(Number);
        if (endYear !== startYear + 1)
            return res.json({ success: false, message: `Invalid range: end year must be exactly start year + 1.` });

        // Ensure the SY actually exists
        const [[sy]] = await db.query(`SELECT sy_id FROM school_years WHERE sy_id = ?`, [syId]);
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        // Check conflict with another record
        const [[conflict]] = await db.query(
            `SELECT sy_id FROM school_years WHERE sy_range = ? AND sy_id <> ?`, [cleanRange, syId]
        );
        if (conflict)
            return res.json({ success: false, message: `School year "${cleanRange}" already exists.` });

        await db.query(`UPDATE school_years SET sy_range = ? WHERE sy_id = ?`, [cleanRange, syId]);

        await logActivity(req.user.user_id, 'Admin', 'EDIT_SCHOOL_YEAR',
            `Updated school year ID ${syId} → ${cleanRange}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Edit SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/school-years/:id/activate
// Set a school year as the active one (deactivates all others).
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/school-years/:id/activate', requireAdmin, async (req, res) => {
    try {
        const syId = parseInt(req.params.id, 10);
        if (isNaN(syId)) return res.json({ success: false, message: 'Invalid school year ID.' });

        const [[sy]] = await db.query(
            `SELECT sy_id, sy_range FROM school_years WHERE sy_id = ?`, [syId]
        );
        if (!sy) return res.json({ success: false, message: 'School year not found.' });

        // Deactivate all, then activate the target
        await db.query(`UPDATE school_years SET is_active = 0`);
        await db.query(`UPDATE school_years SET is_active = 1 WHERE sy_id = ?`, [syId]);

        await logActivity(req.user.user_id, 'Admin', 'ACTIVATE_SCHOOL_YEAR',
            `Activated school year: ${sy.sy_range}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Activate SY Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/school-years/:id
// Delete a school year and all linked classes/enrollments.
// Returns: { success: true } | { success: false, message }
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

        // Delete in FK order
        if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
        if (assessIds.length) await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
        if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
        if (assessIds.length) await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
        if (assessIds.length) await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);

        // Get all question IDs for topics in this subject
        if (topicIds.length) {
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
            // student_forum_done cascade via FK
            await db.query(`DELETE FROM announcements WHERE topic_id IN (?)`, [topicIds]);
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
        await db.query(`DELETE FROM announcements WHERE class_id IS NULL AND topic_id IS NULL AND teacher_id IN (SELECT user_id FROM users WHERE role='Teacher')`);
        await db.query(`DELETE FROM student_progress WHERE subject_id = ?`, [subjectId]);
        await db.query(`DELETE FROM leaderboard_history WHERE subject_id = ?`, [subjectId]);
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

        const [quarters] = await db.query(
            `SELECT quarter_id, quarter_number, is_locked
             FROM quarters WHERE subject_id = ? ORDER BY quarter_number ASC`,
            [subjectId]
        );

        // Attach topics to each quarter
        for (const q of quarters) {
            const [topics] = await db.query(
                `SELECT topic_id, topic_name, theme_id, is_locked
                 FROM topics WHERE quarter_id = ? ORDER BY topic_id ASC`,
                [q.quarter_id]
            );
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
// Body: { quarter_number }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/subjects/:id/quarters', requireAdmin, async (req, res) => {
    try {
        const subjectId     = parseInt(req.params.id, 10);
        const quarterNumber = parseInt(req.body.quarter_number, 10);

        if (isNaN(subjectId))     return res.json({ success: false, message: 'Invalid subject ID.' });
        if (isNaN(quarterNumber) || quarterNumber < 1 || quarterNumber > 4)
            return res.json({ success: false, message: 'Quarter number must be 1–4.' });

        const [[subj]] = await db.query(`SELECT subject_id FROM subjects WHERE subject_id = ?`, [subjectId]);
        if (!subj) return res.json({ success: false, message: 'Subject not found.' });

        // Prevent duplicate quarter numbers for same subject
        const [[dup]] = await db.query(
            `SELECT quarter_id FROM quarters WHERE subject_id = ? AND quarter_number = ?`,
            [subjectId, quarterNumber]
        );
        if (dup)
            return res.json({ success: false, message: `Quarter ${quarterNumber} already exists for this subject.` });

        await db.query(
            `INSERT INTO quarters (subject_id, quarter_number, is_locked) VALUES (?, ?, 1)`,
            [subjectId, quarterNumber]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_QUARTER',
            `Added Quarter ${quarterNumber} to subject ID ${subjectId}`);

        return res.json({ success: true });

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

        const [[q]] = await db.query(`SELECT quarter_id FROM quarters WHERE quarter_id = ?`, [quarterId]);
        if (!q) return res.json({ success: false, message: 'Quarter not found.' });

        await db.query(`UPDATE quarters SET is_locked = ? WHERE quarter_id = ?`, [isLocked, quarterId]);

        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_QUARTER_LOCK',
            `Quarter ID ${quarterId} set to ${isLocked ? 'locked' : 'unlocked'}`);

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
                const [scoreRows] = await db.query(
                    `SELECT score_id FROM student_scores WHERE assessment_id IN (?)`, [assessIds]
                );
                const scoreIds = scoreRows.map(r => r.score_id);
                if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
                await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
                if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
                await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
                await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);
            }

            // Questions
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
            await db.query(`DELETE FROM announcements WHERE topic_id IN (?)`, [topicIds]);
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/quarters/:id/topics
// Add a new topic to a quarter.
// Body: { topic_name, theme_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/quarters/:id/topics', requireAdmin, async (req, res) => {
    try {
        const quarterId = parseInt(req.params.id, 10);
        if (isNaN(quarterId)) return res.json({ success: false, message: 'Invalid quarter ID.' });

        let { topic_name, theme_id } = req.body;
        if (!topic_name || !topic_name.trim())
            return res.json({ success: false, message: 'Topic name is required.' });

        topic_name = topic_name.trim();
        theme_id   = theme_id && theme_id.trim() ? theme_id.trim() : 'default_lab';

        const [[q]] = await db.query(`SELECT quarter_id FROM quarters WHERE quarter_id = ?`, [quarterId]);
        if (!q) return res.json({ success: false, message: 'Quarter not found.' });

        const [result] = await db.query(
            `INSERT INTO topics (quarter_id, topic_name, theme_id, is_locked) VALUES (?, ?, ?, 1)`,
            [quarterId, topic_name, theme_id]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_TOPIC',
            `Added topic "${topic_name}" to quarter ID ${quarterId}`);

        return res.json({ success: true, topic_id: result.insertId });

    } catch (err) {
        console.error('[AM Create Topic Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/topics/:id
// Edit an existing topic's name and theme.
// Body: { topic_name, theme_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/topics/:id', requireAdmin, async (req, res) => {
    try {
        const topicId = parseInt(req.params.id, 10);
        if (isNaN(topicId)) return res.json({ success: false, message: 'Invalid topic ID.' });

        let { topic_name, theme_id } = req.body;
        if (!topic_name || !topic_name.trim())
            return res.json({ success: false, message: 'Topic name is required.' });

        topic_name = topic_name.trim();
        theme_id   = theme_id && theme_id.trim() ? theme_id.trim() : 'default_lab';

        const [[t]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topicId]);
        if (!t) return res.json({ success: false, message: 'Topic not found.' });

        await db.query(
            `UPDATE topics SET topic_name = ?, theme_id = ? WHERE topic_id = ?`,
            [topic_name, theme_id, topicId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_TOPIC',
            `Updated topic ID ${topicId}: "${topic_name}"`);

        return res.json({ success: true });

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

        const [[t]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topicId]);
        if (!t) return res.json({ success: false, message: 'Topic not found.' });

        await db.query(`UPDATE topics SET is_locked = ? WHERE topic_id = ?`, [isLocked, topicId]);

        await logActivity(req.user.user_id, 'Admin', 'TOGGLE_TOPIC_LOCK',
            `Topic ID ${topicId} set to ${isLocked ? 'locked' : 'unlocked'}`);

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
            const [scoreRows] = await db.query(
                `SELECT score_id FROM student_scores WHERE assessment_id IN (?)`, [assessIds]
            );
            const scoreIds = scoreRows.map(r => r.score_id);
            if (scoreIds.length)  await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
            await db.query(`DELETE FROM active_sessions WHERE assessment_id IN (?)`, [assessIds]);
            if (scoreIds.length)  await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
            await db.query(`DELETE FROM competitive_matches WHERE assessment_id IN (?)`, [assessIds]);
            await db.query(`DELETE FROM assessments WHERE assessment_id IN (?)`, [assessIds]);
        }

        // Questions
        const [qRows] = await db.query(`SELECT question_id FROM question_bank WHERE topic_id = ?`, [topicId]);
        const qIds    = qRows.map(r => r.question_id);
        if (qIds.length) {
            await db.query(`DELETE FROM answer_sequences WHERE question_id IN (?)`, [qIds]);
            await db.query(`DELETE FROM remediation_materials WHERE question_id IN (?)`, [qIds]);
            await db.query(`DELETE FROM student_responses WHERE question_id IN (?)`, [qIds]);
            await db.query(`DELETE FROM question_bank WHERE question_id IN (?)`, [qIds]);
        }

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
        await db.query(`DELETE FROM announcements WHERE topic_id = ?`, [topicId]);
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

        // Get active SY
        const [[activeSY]] = await db.query(
            `SELECT sy_id, sy_range FROM school_years WHERE is_active = 1 LIMIT 1`
        );

        // If no active SY, return empty with a note
        if (!activeSY) {
            return res.json({ success: true, classes: [], activeSY: null });
        }

        const [classes] = await db.query(`
            SELECT
                c.class_id, c.class_name, c.teacher_id, c.sy_id,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                sy.sy_range,
                COUNT(cs.student_id) AS student_count
            FROM classes c
            LEFT JOIN users u         ON u.user_id     = c.teacher_id
            LEFT JOIN school_years sy ON sy.sy_id      = c.sy_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            WHERE c.subject_id = ? AND c.sy_id = ?
            GROUP BY c.class_id
            ORDER BY c.class_name ASC
        `, [subjectId, activeSY.sy_id]);

        return res.json({ success: true, classes, activeSY });

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

        const [result] = await db.query(
            `INSERT INTO classes (class_name, teacher_id, subject_id, sy_id) VALUES (?, ?, ?, ?)`,
            [class_name, teacher_id, subject_id, sy_id]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_CLASS',
            `Created class "${class_name}" for subject ID ${subject_id}`);

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

        const [[cls]] = await db.query(`SELECT class_id FROM classes WHERE class_id = ?`, [classId]);
        if (!cls) return res.json({ success: false, message: 'Class not found.' });

        await db.query(
            `UPDATE classes SET class_name = ?, teacher_id = ?, sy_id = ? WHERE class_id = ?`,
            [class_name, teacher_id, sy_id, classId]
        );

        await logActivity(req.user.user_id, 'Admin', 'EDIT_CLASS',
            `Updated class ID ${classId}: "${class_name}"`);

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


// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/classes/:id/students
// Return all students enrolled in a specific class.
// Returns: { success: true, students: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/classes/:id/students', requireAdmin, async (req, res) => {
    try {
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.json({ success: false, message: 'Invalid class ID.' });

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

        return res.json({ success: true, students });

    } catch (err) {
        console.error('[AM Get Class Students Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT PROGRESS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/progress?class_id=
// Return student progress for a subject, optionally filtered by class.
// Returns: { success: true, progress: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/progress', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        const classId   = req.query.class_id ? parseInt(req.query.class_id, 10) : null;

        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        let query, params;

        if (classId && !isNaN(classId)) {
            // Filter by specific class: only enrolled students in that class
            query = `
                SELECT
                    u.user_id, u.first_name, u.last_name, u.profile_pic,
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    sp.last_accessed
                FROM class_students cs
                JOIN users u ON u.user_id = cs.student_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = ?
                WHERE cs.class_id = ?
                ORDER BY progress_percent DESC, u.last_name ASC, u.first_name ASC
            `;
            params = [subjectId, classId];
        } else {
            // All students enrolled in any class for this subject
            query = `
                SELECT DISTINCT
                    u.user_id, u.first_name, u.last_name, u.profile_pic,
                    COALESCE(sp.progress_percent, 0) AS progress_percent,
                    sp.last_accessed
                FROM class_students cs
                JOIN classes c ON c.class_id = cs.class_id
                JOIN users u ON u.user_id = cs.student_id
                LEFT JOIN student_progress sp ON sp.student_id = u.user_id AND sp.subject_id = ?
                WHERE c.subject_id = ?
                ORDER BY progress_percent DESC, u.last_name ASC, u.first_name ASC
            `;
            params = [subjectId, subjectId];
        }

        const [progress] = await db.query(query, params);

        return res.json({ success: true, progress });

    } catch (err) {
        console.error('[AM Get Progress Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/announcements
// Return all announcements for a subject (subject-wide + per-class).
// Returns: { success: true, announcements: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/announcements', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        // Announcements linked to classes under this subject OR subject-wide (class_id NULL + matches subject via teacher)
        const [announcements] = await db.query(`
            SELECT
                a.announcement_id, a.title, a.content, a.is_priority, a.created_at,
                a.class_id, a.teacher_id,
                c.class_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
            FROM announcements a
            LEFT JOIN classes c ON c.class_id = a.class_id
            LEFT JOIN users u   ON u.user_id   = a.teacher_id
            WHERE c.subject_id = ? OR (a.class_id IS NULL AND a.topic_id IS NULL AND c.subject_id IS NULL
                AND a.teacher_id IN (SELECT teacher_id FROM classes WHERE subject_id = ?))
            ORDER BY a.is_priority DESC, a.created_at DESC
        `, [subjectId, subjectId]);

        return res.json({ success: true, announcements });

    } catch (err) {
        console.error('[AM Get Announcements Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/announcements
// Create a new announcement for a subject/class.
// Body: { title, content, class_id, subject_id, is_priority, teacher_id }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/announcements', requireAdmin, async (req, res) => {
    try {
        let { title, content, class_id, subject_id, is_priority, teacher_id } = req.body;

        if (!title   || !title.trim())   return res.json({ success: false, message: 'Title is required.' });
        if (!content || !content.trim()) return res.json({ success: false, message: 'Content is required.' });

        title      = title.trim();
        content    = content.trim();
        class_id   = class_id   ? parseInt(class_id, 10)   : null;
        subject_id = subject_id ? parseInt(subject_id, 10) : null;
        teacher_id = teacher_id ? parseInt(teacher_id, 10) : req.user.user_id;
        is_priority = is_priority ? 1 : 0;

        // If a class_id is given, validate it belongs to the subject
        if (class_id && subject_id) {
            const [[cls]] = await db.query(
                `SELECT class_id FROM classes WHERE class_id = ? AND subject_id = ?`,
                [class_id, subject_id]
            );
            if (!cls)
                return res.json({ success: false, message: 'Selected class does not belong to this subject.' });
        }

        const [result] = await db.query(
            `INSERT INTO announcements (class_id, teacher_id, title, content, is_priority) VALUES (?, ?, ?, ?, ?)`,
            [class_id, teacher_id, title, content, is_priority]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_ANNOUNCEMENT',
            `Posted announcement "${title}" for subject ID ${subject_id}`);

        return res.json({ success: true, announcement_id: result.insertId });

    } catch (err) {
        console.error('[AM Create Announcement Error]', err);
        return res.json({ success: false, message: err.message });
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
            `SELECT announcement_id, title FROM announcements WHERE announcement_id = ?`, [annId]
        );
        if (!ann) return res.json({ success: false, message: 'Announcement not found.' });

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
                lh.history_id, lh.rank_achieved, lh.total_exp_snapshot, lh.awarded_date,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM leaderboard_history lh
            JOIN users u ON u.user_id = lh.student_id
            WHERE lh.subject_id = ?
            ORDER BY lh.awarded_date DESC, lh.rank_achieved ASC
        `, [subjectId]);

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
            `SELECT history_id FROM leaderboard_history WHERE history_id = ?`, [histId]
        );
        if (!entry) return res.json({ success: false, message: 'Leaderboard entry not found.' });

        await db.query(`DELETE FROM leaderboard_history WHERE history_id = ?`, [histId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_LEADERBOARD_ENTRY',
            `Deleted leaderboard history entry ID ${histId}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Leaderboard Entry Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ARCADE CONFIG — COMPETITIVE MATCHES
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/subjects/:id/matches
// Return competitive match history for a subject (via assessments → topic → quarter → subject).
// Returns: { success: true, matches: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/subjects/:id/matches', requireAdmin, async (req, res) => {
    try {
        const subjectId = parseInt(req.params.id, 10);
        if (isNaN(subjectId)) return res.json({ success: false, message: 'Invalid subject ID.' });

        const [matches] = await db.query(`
            SELECT
                cm.match_id, cm.p1_score, cm.p2_score, cm.match_date,
                CONCAT(p1.first_name, ' ', p1.last_name) AS p1_name,
                CONCAT(p2.first_name, ' ', p2.last_name) AS p2_name,
                CONCAT(w.first_name, ' ', w.last_name)   AS winner_name
            FROM competitive_matches cm
            JOIN users p1 ON p1.user_id = cm.p1_id
            JOIN users p2 ON p2.user_id = cm.p2_id
            LEFT JOIN users w ON w.user_id = cm.winner_id
            JOIN assessments a   ON a.assessment_id = cm.assessment_id
            JOIN topics t        ON t.topic_id       = a.topic_id
            JOIN quarters q      ON q.quarter_id     = t.quarter_id
            WHERE q.subject_id = ?
            ORDER BY cm.match_date DESC
        `, [subjectId]);

        return res.json({ success: true, matches });

    } catch (err) {
        console.error('[AM Get Matches Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/matches/:id
// Delete a competitive match record.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/matches/:id', requireAdmin, async (req, res) => {
    try {
        const matchId = parseInt(req.params.id, 10);
        if (isNaN(matchId)) return res.json({ success: false, message: 'Invalid match ID.' });

        const [[match]] = await db.query(
            `SELECT match_id FROM competitive_matches WHERE match_id = ?`, [matchId]
        );
        if (!match) return res.json({ success: false, message: 'Match not found.' });

        await db.query(`DELETE FROM competitive_matches WHERE match_id = ?`, [matchId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_MATCH',
            `Deleted competitive match ID ${matchId}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Match Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ARCADE CONFIG — HARDWARE BUTTON MAPPINGS
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/am/button-mappings
// Return all hardware button mappings.
// Returns: { success: true, mappings: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/am/button-mappings', requireAdmin, async (req, res) => {
    try {
        const [mappings] = await db.query(
            `SELECT mapping_id, button_pin, element_symbol, player_side
             FROM button_mappings ORDER BY player_side ASC, button_pin ASC`
        );
        return res.json({ success: true, mappings });

    } catch (err) {
        console.error('[AM Get Mappings Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/am/button-mappings
// Add a new hardware button mapping.
// Body: { button_pin, element_symbol, player_side }
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/am/button-mappings', requireAdmin, async (req, res) => {
    try {
        const button_pin     = parseInt(req.body.button_pin, 10);
        const element_symbol = req.body.element_symbol ? req.body.element_symbol.trim() : null;
        const player_side    = parseInt(req.body.player_side, 10);

        if (isNaN(button_pin) || button_pin < 0 || button_pin > 99)
            return res.json({ success: false, message: 'Button pin must be 0–99.' });
        if (!element_symbol)
            return res.json({ success: false, message: 'Element symbol is required.' });
        if (player_side !== 1 && player_side !== 2)
            return res.json({ success: false, message: 'Player side must be 1 or 2.' });

        // Prevent duplicate pin+player_side combinations
        const [[dup]] = await db.query(
            `SELECT mapping_id FROM button_mappings WHERE button_pin = ? AND player_side = ?`,
            [button_pin, player_side]
        );
        if (dup)
            return res.json({ success: false, message: `Pin ${button_pin} is already mapped for Player ${player_side}.` });

        await db.query(
            `INSERT INTO button_mappings (button_pin, element_symbol, player_side) VALUES (?, ?, ?)`,
            [button_pin, element_symbol, player_side]
        );

        await logActivity(req.user.user_id, 'Admin', 'CREATE_BUTTON_MAPPING',
            `Mapped pin ${button_pin} → "${element_symbol}" (P${player_side})`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Create Mapping Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/am/button-mappings/:id
// Remove a hardware button mapping.
// Returns: { success: true } | { success: false, message }
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/am/button-mappings/:id', requireAdmin, async (req, res) => {
    try {
        const mappingId = parseInt(req.params.id, 10);
        if (isNaN(mappingId)) return res.json({ success: false, message: 'Invalid mapping ID.' });

        const [[m]] = await db.query(
            `SELECT mapping_id FROM button_mappings WHERE mapping_id = ?`, [mappingId]
        );
        if (!m) return res.json({ success: false, message: 'Mapping not found.' });

        await db.query(`DELETE FROM button_mappings WHERE mapping_id = ?`, [mappingId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_BUTTON_MAPPING',
            `Deleted button mapping ID ${mappingId}`);

        return res.json({ success: true });

    } catch (err) {
        console.error('[AM Delete Mapping Error]', err);
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

        // Validate class exists and fetch its sy_id
        const [[cls]] = await db.query(
            `SELECT class_id, class_name, sy_id FROM classes WHERE class_id = ?`, [classId]
        );
        if (!cls) return res.json({ success: false, message: 'Selected class not found.' });

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

router.get('/gaming_question_bank', requireAdmin, async (req, res) => {
    try {
        const [[aTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments`);
        const [[qTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank`);
        const [[mTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM button_mappings`);
        const [[rTot]] = await db.query(`SELECT COUNT(*) AS cnt FROM remediation_materials`);

        const gqStats = {
            totalAssessments : aTot.cnt,
            totalQuestions   : qTot.cnt,
            totalMappings    : mTot.cnt,
            totalRemediation : rTot.cnt,
        };

        const [assessments] = await db.query(`
            SELECT
                a.assessment_id, a.assessment_name, a.assessment_type,
                a.total_items, a.duration_minutes, a.timer_type,
                a.is_unlocked, a.due_date, a.quarter_id, a.topic_id, a.teacher_id,
                t.topic_name,
                q.quarter_number,
                s.subject_name,
                COUNT(DISTINCT ss.score_id) AS attempt_count
            FROM assessments a
            LEFT JOIN topics   t  ON t.topic_id   = a.topic_id
            LEFT JOIN quarters q  ON q.quarter_id  = t.quarter_id
            LEFT JOIN subjects s  ON s.subject_id  = q.subject_id
            LEFT JOIN student_scores ss ON ss.assessment_id = a.assessment_id
            GROUP BY a.assessment_id
            ORDER BY a.assessment_id DESC
        `);

        const [questions] = await db.query(`
            SELECT
                qb.question_id, qb.question_text, qb.instruction_override,
                qb.difficulty, qb.input_mode, qb.mechanic_type,
                qb.base_exp, qb.time_limit,
                qb.is_multiple_answer, qb.required_answers_count,
                qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                qb.correct_answer, qb.numeric_answer, qb.numeric_tolerance,
                qb.is_ai_generated, qb.verification_status,
                qb.topic_id, qb.teacher_id,
                t.topic_name
            FROM question_bank qb
            LEFT JOIN topics t ON t.topic_id = qb.topic_id
            ORDER BY qb.question_id DESC
        `);

        const seqQuestionIds = questions
            .filter(q => q.input_mode === 'Periodic_Sequence' || q.input_mode === 'Periodic_Single')
            .map(q => q.question_id);

        let seqMap = {};
        if (seqQuestionIds.length) {
            const [seqs] = await db.query(
                `SELECT answer_id, question_id, element_symbol, subscript, sort_order
                 FROM answer_sequences
                 WHERE question_id IN (?)
                 ORDER BY question_id, sort_order ASC`,
                [seqQuestionIds]
            );
            seqs.forEach(s => {
                if (!seqMap[s.question_id]) seqMap[s.question_id] = [];
                seqMap[s.question_id].push(s);
            });
        }
        questions.forEach(q => {
            q.sequences = seqMap[q.question_id] || [];
        });

        const [buttonMappings] = await db.query(
            `SELECT mapping_id, button_pin, element_symbol, player_side
             FROM button_mappings ORDER BY player_side ASC, button_pin ASC`
        );

        const [topics] = await db.query(`
            SELECT
                t.topic_id, t.topic_name, t.theme_id, t.is_locked,
                q.quarter_number, q.quarter_id,
                s.subject_name, s.subject_id
            FROM topics t
            JOIN quarters q ON q.quarter_id = t.quarter_id
            JOIN subjects s ON s.subject_id  = q.subject_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, t.topic_id ASC
        `);

        const [materials] = await db.query(
            `SELECT material_id, title, material_type, topic_id
             FROM learning_materials ORDER BY title ASC`
        );

        const [remediationList] = await db.query(`
            SELECT
                rm.rem_id, rm.question_id, rm.material_id,
                rm.advice_text, rm.link_url, rm.created_at,
                LEFT(qb.question_text, 60) AS question_text,
                lm.title AS material_title
            FROM remediation_materials rm
            LEFT JOIN question_bank    qb ON qb.question_id = rm.question_id
            LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
            ORDER BY rm.created_at DESC
            LIMIT 200
        `);

        const [pendingQuestions] = await db.query(`
            SELECT
                qb.question_id, qb.question_text, qb.difficulty,
                qb.input_mode, qb.mechanic_type, qb.base_exp,
                qb.verification_status, qb.verified_at, qb.rejection_reason,
                qb.is_ai_generated, qb.topic_id,
                t.topic_name,
                CONCAT(teacher.first_name, ' ', teacher.last_name) AS teacher_name,
                CONCAT(verifier.first_name, ' ', verifier.last_name) AS verified_by_name
            FROM question_bank qb
            LEFT JOIN topics t ON t.topic_id = qb.topic_id
            LEFT JOIN users teacher  ON teacher.user_id  = qb.teacher_id
            LEFT JOIN users verifier ON verifier.user_id = qb.verified_by
            ORDER BY
                FIELD(qb.verification_status, 'Pending', 'Approved', 'Rejected'),
                qb.question_id DESC
        `);

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
        });

    } catch (err) {
        console.error('[GQB GET Error]', err);
        res.status(500).send('Server error loading Gaming & Q-Bank: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — ASSESSMENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/assessments', requireAdmin, async (req, res) => {
    try {
        let { assessment_name, assessment_type, topic_id, total_items, duration_minutes, timer_type, is_unlocked, due_date } = req.body;

        topic_id = parseInt(topic_id, 10);
        if (!topic_id || isNaN(topic_id)) return res.json({ success: false, message: 'A valid topic is required.' });
        if (!VALID_ASM_TYPES.includes(assessment_type)) return res.json({ success: false, message: `assessment_type must be one of: ${VALID_ASM_TYPES.join(', ')}.` });
        if (!VALID_TIMER_TYPES.includes(timer_type)) return res.json({ success: false, message: `timer_type must be Global or PerItem.` });

        total_items      = parseInt(total_items, 10)      || 10;
        duration_minutes = parseInt(duration_minutes, 10) || 30;
        is_unlocked      = is_unlocked ? 1 : 0;

        if (total_items < 1 || total_items > 200) return res.json({ success: false, message: 'total_items must be between 1 and 200.' });
        if (duration_minutes < 1 || duration_minutes > 180) return res.json({ success: false, message: 'duration_minutes must be between 1 and 180.' });

        const [[topic]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topic_id]);
        if (!topic) return res.json({ success: false, message: 'Selected topic does not exist.' });

        const [[topicFull]] = await db.query(`SELECT quarter_id FROM topics WHERE topic_id = ?`, [topic_id]);

        const [result] = await db.query(`
            INSERT INTO assessments (quarter_id, topic_id, assessment_name, assessment_type, total_items, duration_minutes, timer_type, is_unlocked, due_date, teacher_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [topicFull.quarter_id, topic_id, assessment_name ? assessment_name.trim().substring(0, 100) : null, assessment_type, total_items, duration_minutes, timer_type, is_unlocked, due_date || null, req.user.user_id]);

        await logActivity(req.user.user_id, 'Admin', 'CREATE_ASSESSMENT', `Created assessment: "${assessment_name || 'Unnamed'}" (ID: ${result.insertId})`);
        return res.json({ success: true, assessment_id: result.insertId });

    } catch (err) {
        console.error('[GQB Create Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.put('/gqb/assessments/:id', requireAdmin, async (req, res) => {
    try {
        const asmId = parseInt(req.params.id, 10);
        if (isNaN(asmId)) return res.json({ success: false, message: 'Invalid assessment ID.' });

        let { assessment_name, assessment_type, topic_id, total_items, duration_minutes, timer_type, is_unlocked, due_date } = req.body;

        topic_id = topic_id ? parseInt(topic_id, 10) : null;
        if (assessment_type && !VALID_ASM_TYPES.includes(assessment_type)) return res.json({ success: false, message: `Invalid assessment_type.` });
        if (timer_type && !VALID_TIMER_TYPES.includes(timer_type)) return res.json({ success: false, message: `Invalid timer_type.` });

        total_items      = parseInt(total_items, 10)      || 10;
        duration_minutes = parseInt(duration_minutes, 10) || 30;
        is_unlocked      = is_unlocked ? 1 : 0;

        const [[asm]] = await db.query(`SELECT assessment_id FROM assessments WHERE assessment_id = ?`, [asmId]);
        if (!asm) return res.json({ success: false, message: 'Assessment not found.' });

        let quarter_id = null;
        if (topic_id) {
            const [[t]] = await db.query(`SELECT quarter_id FROM topics WHERE topic_id = ?`, [topic_id]);
            if (!t) return res.json({ success: false, message: 'Selected topic not found.' });
            quarter_id = t.quarter_id;
        }

        await db.query(`
            UPDATE assessments SET assessment_name=?, assessment_type=?, topic_id=?,
            quarter_id=COALESCE(?,quarter_id), total_items=?, duration_minutes=?,
            timer_type=?, is_unlocked=?, due_date=? WHERE assessment_id=?
        `, [assessment_name ? assessment_name.trim().substring(0, 100) : null, assessment_type || 'Quiz', topic_id || null, quarter_id, total_items, duration_minutes, timer_type || 'Global', is_unlocked, due_date || null, asmId]);

        await logActivity(req.user.user_id, 'Admin', 'EDIT_ASSESSMENT', `Updated assessment ID ${asmId}`);
        return res.json({ success: true });

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

        const [scoreRows] = await db.query(`SELECT score_id FROM student_scores WHERE assessment_id = ?`, [asmId]);
        const scoreIds = scoreRows.map(r => r.score_id);
        if (scoreIds.length) {
            await db.query(`DELETE FROM student_responses WHERE score_id IN (?)`, [scoreIds]);
            await db.query(`DELETE FROM student_scores WHERE score_id IN (?)`, [scoreIds]);
        }
        await db.query(`DELETE FROM active_sessions WHERE assessment_id = ?`, [asmId]);
        await db.query(`DELETE FROM competitive_matches WHERE assessment_id = ?`, [asmId]);
        await db.query(`DELETE FROM assessments WHERE assessment_id = ?`, [asmId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_ASSESSMENT', `Deleted assessment "${asm.assessment_name}" (ID: ${asmId})`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Delete Assessment Error]', err);
        return res.json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — QUESTION BANK
// Admin-created questions are auto-approved (no teacher verification needed).
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/gqb/questions', requireAdmin, async (req, res) => {
    try {
        const result = await _upsertQuestion(req, null);
        return res.json(result);
    } catch (err) {
        console.error('[GQB Create Question Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

router.put('/gqb/questions/:id', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });
        const result = await _upsertQuestion(req, qId);
        return res.json(result);
    } catch (err) {
        console.error('[GQB Edit Question Error]', err);
        return res.json({ success: false, message: err.message });
    }
});

async function _upsertQuestion(req, qId) {
    const {
        question_text, instruction_override, topic_id, difficulty,
        base_exp, time_limit, input_mode, mechanic_type,
        is_multiple_answer, required_answers_count, is_ai_generated,
        option_a, option_b, option_c, option_d, correct_answer,
        numeric_answer, numeric_tolerance,
        sequences,
    } = req.body;

    if (!question_text || !question_text.trim()) return { success: false, message: 'Question text is required.' };

    const cleanTopicId = parseInt(topic_id, 10);
    if (!cleanTopicId || isNaN(cleanTopicId)) return { success: false, message: 'A valid topic is required.' };
    if (!VALID_INPUT_MODES.includes(input_mode)) return { success: false, message: `input_mode must be one of: ${VALID_INPUT_MODES.join(', ')}.` };
    if (!VALID_MECHANIC_TYPES.includes(mechanic_type)) return { success: false, message: `mechanic_type must be one of: ${VALID_MECHANIC_TYPES.join(', ')}.` };
    if (!VALID_DIFFICULTIES.includes(difficulty)) return { success: false, message: `difficulty must be Easy, Average, or Difficult.` };

    const [[topicRow]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [cleanTopicId]);
    if (!topicRow) return { success: false, message: `Topic ID ${cleanTopicId} not found.` };

    // ── Mode-specific validation ──────────────────────────────────────────────
    let cleanCorrect    = null;
    let cleanNumAnswer  = null;
    let cleanNumTol     = 0;
    let symbolWarning   = false;

    if (input_mode === 'Standard') {
        if (!['A', 'B', 'C', 'D'].includes(correct_answer))
            return { success: false, message: 'For Standard mode, correct_answer must be A, B, C, or D.' };
        cleanCorrect = correct_answer;

    } else if (input_mode === 'Periodic_Single') {
        // Answer stored in answer_sequences table, not correct_answer column
        if (!sequences || !Array.isArray(sequences) || sequences.length === 0)
            return { success: false, message: 'Periodic_Single requires exactly one element entry in sequences.' };
        const sym = sequences[0].symbol ? sequences[0].symbol.trim() : '';
        if (!sym) return { success: false, message: 'Element symbol is required for Periodic_Single mode.' };
        // Warn if symbol not in button_mappings
        const [[bm]] = await db.query(`SELECT mapping_id FROM button_mappings WHERE element_symbol = ?`, [sym]);
        if (!bm) symbolWarning = true;
        cleanCorrect = null; // stored in answer_sequences

    } else if (input_mode === 'Numeric') {
        if (numeric_answer === undefined || numeric_answer === '' || isNaN(Number(numeric_answer)))
            return { success: false, message: 'For Numeric mode, numeric_answer must be a pure number.' };
        cleanNumAnswer = parseFloat(numeric_answer);
        cleanNumTol    = isNaN(parseFloat(numeric_tolerance)) ? 0 : Math.abs(parseFloat(numeric_tolerance));
        cleanCorrect   = null; // stored in numeric_answer column

    } else if (input_mode === 'Periodic_Sequence') {
        // Answers stored in answer_sequences table
        if (!sequences || !Array.isArray(sequences) || sequences.length === 0)
            return { success: false, message: 'At least one element entry is required for Periodic_Sequence mode.' };
        for (const s of sequences) {
            if (!s.symbol || !s.symbol.trim())
                return { success: false, message: 'All sequence entries must have a non-empty symbol.' };
        }
        cleanCorrect = null;
    }

    if (qId) {
        const [[existing]] = await db.query(`SELECT question_id FROM question_bank WHERE question_id = ?`, [qId]);
        if (!existing) return { success: false, message: 'Question not found.' };
    }

    const cleanBase = Math.max(10, Math.min(9999, parseInt(base_exp, 10) || 100));
    const cleanTime = Math.max(5,  Math.min(300,  parseInt(time_limit, 10) || 10));
    const isMulti   = is_multiple_answer ? 1 : 0;
    const reqAns    = Math.max(1, Math.min(10, parseInt(required_answers_count, 10) || 1));
    const isAI      = is_ai_generated ? 1 : 0;

    // Admin-created questions are auto-approved
    const verificationStatus = 'Approved';
    const verifiedBy         = req.user.user_id;

    const fields = [
        cleanTopicId,
        req.user.user_id,
        question_text.trim().substring(0, 1000),
        instruction_override ? instruction_override.trim().substring(0, 500) : null,
        difficulty,
        input_mode,
        mechanic_type,
        cleanBase,
        cleanTime,
        isMulti,
        reqAns,
        option_a ? option_a.trim().substring(0, 255) : null,
        option_b ? option_b.trim().substring(0, 255) : null,
        option_c ? option_c.trim().substring(0, 255) : null,
        option_d ? option_d.trim().substring(0, 255) : null,
        cleanCorrect ? cleanCorrect.substring(0, 10) : null,
        cleanNumAnswer,
        cleanNumTol,
        isAI,
        verificationStatus,
        verifiedBy,
    ];

    let questionId;

    if (!qId) {
        const [result] = await db.query(`
            INSERT INTO question_bank
                (topic_id, teacher_id, question_text, instruction_override,
                 difficulty, input_mode, mechanic_type, base_exp, time_limit,
                 is_multiple_answer, required_answers_count,
                 option_a, option_b, option_c, option_d,
                 correct_answer, numeric_answer, numeric_tolerance,
                 is_ai_generated, verification_status, verified_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, fields);
        questionId = result.insertId;
        await logActivity(req.user.user_id, 'Admin', 'CREATE_QUESTION', `Created question ID ${questionId} (${input_mode}, ${difficulty}) — auto-approved`);
    } else {
        await db.query(`
            UPDATE question_bank SET
                topic_id=?, teacher_id=?, question_text=?, instruction_override=?,
                difficulty=?, input_mode=?, mechanic_type=?, base_exp=?, time_limit=?,
                is_multiple_answer=?, required_answers_count=?,
                option_a=?, option_b=?, option_c=?, option_d=?,
                correct_answer=?, numeric_answer=?, numeric_tolerance=?,
                is_ai_generated=?, verification_status=?, verified_by=?
            WHERE question_id=?
        `, [...fields, qId]);
        questionId = qId;
        await logActivity(req.user.user_id, 'Admin', 'EDIT_QUESTION', `Updated question ID ${qId} (${input_mode}, ${difficulty})`);
    }

    // ── Handle answer_sequences ──────────────────────────────────────────────
    if ((input_mode === 'Periodic_Sequence' || input_mode === 'Periodic_Single') && sequences && Array.isArray(sequences)) {
        await db.query(`DELETE FROM answer_sequences WHERE question_id = ?`, [questionId]);
        for (let i = 0; i < sequences.length; i++) {
            const s   = sequences[i];
            const sym = String(s.symbol || '').trim().substring(0, 10);
            if (!sym) continue;
            await db.query(`
                INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order)
                VALUES (?, ?, ?, ?)
            `, [questionId, sym, Math.max(1, Math.min(99, parseInt(s.subscript, 10) || 1)), i + 1]);
        }
    } else if (input_mode !== 'Periodic_Sequence' && input_mode !== 'Periodic_Single') {
        await db.query(`DELETE FROM answer_sequences WHERE question_id = ?`, [questionId]);
    }

    return { success: true, question_id: questionId, symbolWarning };
}

router.delete('/gqb/questions/:id', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });

        const [[q]] = await db.query(`SELECT question_id, question_text FROM question_bank WHERE question_id = ?`, [qId]);
        if (!q) return res.json({ success: false, message: 'Question not found.' });

        await db.query(`DELETE FROM answer_sequences      WHERE question_id = ?`, [qId]);
        await db.query(`DELETE FROM remediation_materials WHERE question_id = ?`, [qId]);
        await db.query(`DELETE FROM student_responses     WHERE question_id = ?`, [qId]);
        await db.query(`DELETE FROM question_bank         WHERE question_id = ?`, [qId]);

        await logActivity(req.user.user_id, 'Admin', 'DELETE_QUESTION', `Deleted question ID ${qId}: "${q.question_text.substring(0, 60)}"`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Delete Question Error]', err);
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

router.post('/gqb/topics/:id/theme', requireAdmin, async (req, res) => {
    try {
        const topicId = parseInt(req.params.id, 10);
        if (isNaN(topicId)) return res.json({ success: false, message: 'Invalid topic ID.' });

        const theme_id = req.body.theme_id ? req.body.theme_id.trim() : null;
        if (!theme_id) return res.json({ success: false, message: 'theme_id is required.' });

        const VALID_THEMES = ['default_lab', 'neon_reactor', 'space_chem', 'bio_hazard', 'crystal_cave'];
        if (!VALID_THEMES.includes(theme_id)) return res.json({ success: false, message: `theme_id must be one of: ${VALID_THEMES.join(', ')}.` });

        const [[topic]] = await db.query(`SELECT topic_id, topic_name FROM topics WHERE topic_id = ?`, [topicId]);
        if (!topic) return res.json({ success: false, message: 'Topic not found.' });

        await db.query(`UPDATE topics SET theme_id = ? WHERE topic_id = ?`, [theme_id, topicId]);
        await logActivity(req.user.user_id, 'Admin', 'UPDATE_TOPIC_THEME', `Updated topic "${topic.topic_name}" theme → "${theme_id}"`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[GQB Update Theme Error]', err);
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

    const [[q]] = await db.query(`SELECT question_id FROM question_bank WHERE question_id = ?`, [cleanQId]);
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
        const [[q]] = await db.query(`SELECT question_id, question_text, verification_status FROM question_bank WHERE question_id = ?`, [qId]);
        if (!q) return res.json({ success: false, message: 'Question not found.' });
        if (q.verification_status === 'Approved') return res.json({ success: false, message: 'Question is already approved.' });
        await db.query(`UPDATE question_bank SET verification_status='Approved', verified_by=?, verified_at=NOW(), rejection_reason=NULL WHERE question_id=?`, [req.user.user_id, qId]);
        await logActivity(req.user.user_id, 'Admin', 'APPROVE_QUESTION', `Approved question ID ${qId}`);
        return res.json({ success: true });
    } catch (err) { return res.json({ success: false, message: err.message }); }
});

router.post('/gqb/questions/:id/reject', requireAdmin, async (req, res) => {
    try {
        const qId = parseInt(req.params.id, 10);
        if (isNaN(qId)) return res.json({ success: false, message: 'Invalid question ID.' });
        const rejection_reason = req.body.rejection_reason ? req.body.rejection_reason.trim() : '';
        if (!rejection_reason) return res.json({ success: false, message: 'A rejection reason is required.' });
        const [[q]] = await db.query(`SELECT question_id, verification_status FROM question_bank WHERE question_id = ?`, [qId]);
        if (!q) return res.json({ success: false, message: 'Question not found.' });
        if (q.verification_status === 'Rejected') return res.json({ success: false, message: 'Question is already rejected.' });
        await db.query(`UPDATE question_bank SET verification_status='Rejected', verified_by=?, verified_at=NOW(), rejection_reason=? WHERE question_id=?`, [req.user.user_id, rejection_reason.substring(0, 1000), qId]);
        await logActivity(req.user.user_id, 'Admin', 'REJECT_QUESTION', `Rejected question ID ${qId}`);
        return res.json({ success: true });
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
        const [existingQs]   = await db.query(`SELECT LOWER(TRIM(question_text)) AS qt FROM question_bank`);
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

        const [existingQs]   = await db.query(`SELECT LOWER(TRIM(question_text)) AS qt FROM question_bank`);
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
                    INSERT INTO question_bank
                        (topic_id, teacher_id, question_text, instruction_override,
                         difficulty, input_mode, mechanic_type, base_exp, time_limit,
                         is_multiple_answer, required_answers_count,
                         option_a, option_b, option_c, option_d,
                         correct_answer, numeric_answer, numeric_tolerance,
                         is_ai_generated, verification_status, verified_by, verified_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                `, [
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

                const newQId = result.insertId;
                existingTexts.add(qLower); // prevent duplicates within this batch vs DB

                // Insert sequences for Periodic_Sequence
                if (row.input_mode === 'Periodic_Sequence' && seqPairs.length) {
                    for (let i = 0; i < seqPairs.length; i++) {
                        await db.query(`INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order) VALUES (?,?,?,?)`,
                            [newQId, seqPairs[i].symbol, seqPairs[i].subscript, i + 1]);
                    }
                }

                // Insert single element for Periodic_Single
                if (row.input_mode === 'Periodic_Single' && row.element_symbol) {
                    await db.query(`INSERT INTO answer_sequences (question_id, element_symbol, subscript, sort_order) VALUES (?,?,?,?)`,
                        [newQId, row.element_symbol, 1, 1]);
                }

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

        // ── KPI stats ──────────────────────────────────────────────────────────
        const [[mRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM learning_materials`);
        const [[fRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM forum_topics`);
        const [[iRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM student_material_interactions`);
        const [[sRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Student'`);

        const reStats = {
            totalMaterials    : mRow.cnt,
            totalForums       : fRow.cnt,
            totalInteractions : iRow.cnt,
            totalStudents     : sRow.cnt,
        };

        // ── All topics flat list for dropdowns ────────────────────────────────
        const [allTopics] = await db.query(`
            SELECT
                t.topic_id, t.topic_name, t.theme_id,
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
                    SELECT material_id, title, material_type, file_path_or_url, is_locked, topic_id
                    FROM learning_materials
                    WHERE topic_id = ? ORDER BY material_id DESC
                `, [t.topic_id]);
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
                t.topic_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                COUNT(DISTINCT fr.reply_id) AS reply_count
            FROM forum_topics ft
            LEFT JOIN topics t  ON t.topic_id  = ft.topic_id
            LEFT JOIN users u   ON u.user_id    = ft.teacher_id
            LEFT JOIN forum_replies fr ON fr.topic_id = ft.forum_id
            GROUP BY ft.forum_id
            ORDER BY ft.is_pinned DESC, ft.created_at DESC
        `);

        // Attach top 20 replies per forum
        const forums = [];
        for (const f of rawForums) {
            const [replies] = await db.query(`
                SELECT
                    fr.reply_id, fr.reply_content, fr.created_at, fr.parent_reply_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS user_name
                FROM forum_replies fr
                LEFT JOIN users u ON u.user_id = fr.user_id
                WHERE fr.topic_id = ?
                ORDER BY fr.created_at ASC
                LIMIT 20
            `, [f.forum_id]);
            forums.push({ ...f, replies });
        }

        // ── Student material interaction log (Pillar 3) ───────────────────────
        const [interactionLog] = await db.query(`
            SELECT
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                lm.title AS material_title
            FROM student_material_interactions smi
            JOIN users u  ON u.user_id    = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            ORDER BY smi.interacted_at DESC
            LIMIT 300
        `);

        // ── Activity Audit Feed (Pillar 3 sidebar) ────────────────────────────
        const [activityFeed] = await db.query(`
            SELECT log_id, actor_id, actor_role, action, description, created_at
            FROM activity_logs
            ORDER BY created_at DESC
            LIMIT 50
        `);

        // ── Student progress for engagement milestones (Pillar 3) ─────────────
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

        // ── Master Leaderboard: Top 10 by total_exp (Pillar 4) ────────────────
        const [leaderboard] = await db.query(`
            SELECT user_id, first_name, last_name, profile_pic,
                   current_level, total_exp
            FROM users
            WHERE role = 'Student'
            ORDER BY total_exp DESC
            LIMIT 10
        `);

        // ── Leaderboard history snapshots (Pillar 4) ──────────────────────────
        const [leaderboardHistory] = await db.query(`
            SELECT
                lh.history_id, lh.rank_achieved, lh.total_exp_snapshot, lh.awarded_date,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM leaderboard_history lh
            JOIN users u ON u.user_id = lh.student_id
            ORDER BY lh.awarded_date DESC
            LIMIT 50
        `);

        res.render('admin/resources_engagement', {
            user: req.user,
            reStats,
            quarters,
            allTopics,
            forums,
            interactionLog,
            activityFeed,
            studentProgress,
            leaderboard,
            leaderboardHistory,
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
router.post('/re/materials', requireAdmin, (req, res, next) => {
    // If the client sends JSON (link type), skip multer
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        return next();
    }
    // Otherwise run multer for file upload
    uploadMaterial.single('material_file')(req, res, (err) => {
        if (err) return res.json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    try {
        const title         = req.body.title        ? req.body.title.trim().substring(0, 255) : null;
        const topic_id      = parseInt(req.body.topic_id, 10) || null;
        const material_type = req.body.material_type || null;
        const is_locked     = req.body.is_locked !== undefined ? parseInt(req.body.is_locked, 10) : 1;

        // ── Validation ────────────────────────────────────────────────────────
        if (!title)
            return res.json({ success: false, message: 'Title is required.' });
        if (!topic_id)
            return res.json({ success: false, message: 'A valid topic is required.' });

        const VALID_TYPES = ['pdf', 'word', 'img', 'video', 'link', 'presentation'];
        if (!material_type || !VALID_TYPES.includes(material_type))
            return res.json({ success: false, message: `material_type must be one of: ${VALID_TYPES.join(', ')}.` });

        // ── Validate topic exists ─────────────────────────────────────────────
        const [[topic]] = await db.query(`SELECT topic_id FROM topics WHERE topic_id = ?`, [topic_id]);
        if (!topic)
            return res.json({ success: false, message: `Topic ID ${topic_id} not found.` });

        // ── Determine file_path_or_url ────────────────────────────────────────
        let file_path_or_url;

        if (material_type === 'link') {
            const url = req.body.file_path_or_url ? req.body.file_path_or_url.trim() : null;
            if (!url || !url.startsWith('http'))
                return res.json({ success: false, message: 'A valid URL (starting with http) is required for Link type.' });
            file_path_or_url = url;

        } else {
            // File upload
            if (!req.file)
                return res.json({ success: false, message: 'A file upload is required for this material type.' });
            file_path_or_url = req.file.filename;  // stored filename only; path prefix added in EJS
        }

        const [result] = await db.query(`
            INSERT INTO learning_materials (topic_id, title, material_type, file_path_or_url, is_locked)
            VALUES (?, ?, ?, ?, ?)
        `, [topic_id, title, material_type, file_path_or_url, is_locked]);

        await logActivity(req.user.user_id, 'Admin', 'CREATE_MATERIAL',
            `Uploaded material: "${title}" (${material_type}) → topic ID ${topic_id}`);

        return res.json({ success: true, material_id: result.insertId });

    } catch (err) {
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
            `SELECT forum_id FROM forum_topics WHERE forum_id = ?`, [forumId]
        );
        if (!forum) return res.json({ success: false, message: 'Forum not found.' });

        await db.query(`
            UPDATE forum_topics SET title = ?, forum_content = ?, is_pinned = ?
            WHERE forum_id = ?
        `, [title, forum_content, is_pinned, forumId]);

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
        const limit     = Math.min(200, parseInt(req.query.limit, 10) || 50);
        const subjectId = req.query.subject_id ? parseInt(req.query.subject_id, 10) : null;

        let query, params;

        if (subjectId && !isNaN(subjectId)) {
            query = `
                SELECT lh.history_id, lh.rank_achieved, lh.total_exp_snapshot, lh.awarded_date,
                       CONCAT(u.first_name,' ',u.last_name) AS student_name
                FROM leaderboard_history lh
                JOIN users u ON u.user_id = lh.student_id
                WHERE lh.subject_id = ?
                ORDER BY lh.awarded_date DESC
                LIMIT ?
            `;
            params = [subjectId, limit];
        } else {
            query = `
                SELECT lh.history_id, lh.rank_achieved, lh.total_exp_snapshot, lh.awarded_date,
                       CONCAT(u.first_name,' ',u.last_name) AS student_name
                FROM leaderboard_history lh
                JOIN users u ON u.user_id = lh.student_id
                ORDER BY lh.awarded_date DESC
                LIMIT ?
            `;
            params = [limit];
        }

        const [history] = await db.query(query, params);
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

        // ── KPI stats ──────────────────────────────────────────────────────────
        const [[sRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'Student'`);
        const [[aRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM assessments`);
        const [[qRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank`);
        const [[mRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM learning_materials`);

        const rmStats = {
            totalStudents   : sRow.cnt,
            totalAssessments: aRow.cnt,
            totalQuestions  : qRow.cnt,
            totalMaterials  : mRow.cnt,
        };

        // ─────────────────────────────────────────────────────────────────────
        // TAB 1 — CURRICULUM PROGRESS DATA
        // curriculumData: [ { quarter_number, subject_name, topics: [ { topic_name,
        //   materialCount, assessmentCount, coveredPct } ] } ]
        // coveredPct = if either materials > 0 OR assessments > 0, considered covered.
        // We use: min(100, round((materialCount + assessmentCount) / maxPossible * 100))
        // Simple formula: coveredPct = min(100, (assessmentCount >= 1 ? 50 : 0) + (materialCount >= 1 ? 50 : 0))
        // This yields 0%, 50%, or 100% — clean and meaningful for a progress bar.
        // ─────────────────────────────────────────────────────────────────────
        const [rawCurriculum] = await db.query(`
            SELECT
                q.quarter_id, q.quarter_number,
                s.subject_name,
                t.topic_id, t.topic_name,
                COUNT(DISTINCT lm.material_id)  AS materialCount,
                COUNT(DISTINCT a.assessment_id) AS assessmentCount
            FROM quarters q
            JOIN subjects s ON s.subject_id = q.subject_id
            LEFT JOIN topics t           ON t.quarter_id    = q.quarter_id
            LEFT JOIN learning_materials lm ON lm.topic_id  = t.topic_id
            LEFT JOIN assessments a       ON a.topic_id     = t.topic_id
            GROUP BY q.quarter_id, t.topic_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, t.topic_id ASC
        `);

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
                const mC = parseInt(row.materialCount,  10) || 0;
                const aC = parseInt(row.assessmentCount,10) || 0;
                const coveredPct = Math.min(100, (aC >= 1 ? 50 : 0) + (mC >= 1 ? 50 : 0));
                curriculumMap[key].topics.push({
                    topic_id       : row.topic_id,
                    topic_name     : row.topic_name,
                    materialCount  : mC,
                    assessmentCount: aC,
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
                s.subject_name,
                COUNT(DISTINCT cs.student_id) AS studentCount,
                AVG(
                    CASE WHEN ss.total_items > 0
                    THEN (ss.score_obtained / ss.total_items) * 100
                    ELSE NULL END
                ) AS avgScore
            FROM classes c
            LEFT JOIN users u     ON u.user_id    = c.teacher_id
            LEFT JOIN subjects s  ON s.subject_id  = c.subject_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN student_scores ss
                ON ss.student_id = cs.student_id
                AND ss.assessment_id IN (
                    SELECT a.assessment_id FROM assessments a
                    JOIN topics t  ON t.topic_id  = a.topic_id
                    JOIN quarters q ON q.quarter_id = t.quarter_id
                    WHERE q.subject_id = c.subject_id
                )
            GROUP BY c.class_id
            ORDER BY s.subject_name ASC, c.class_name ASC
        `);

        // ─────────────────────────────────────────────────────────────────────
        // TAB 3 — STUDENT DOSSIER
        // students: full list with avgScore and interactionCount
        // Excludes: password_hash, google_id, user_id NOT excluded (needed
        //   for exportStudentDossier(userId) call), flagged_assessment_id excluded.
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
                AVG(
                    CASE WHEN ss.total_items > 0
                    THEN (ss.score_obtained / ss.total_items) * 100
                    ELSE NULL END
                ) AS avgScore,
                COUNT(DISTINCT smi.interaction_id) AS interactionCount
            FROM users u
            LEFT JOIN student_scores ss ON ss.student_id = u.user_id
            LEFT JOIN student_material_interactions smi ON smi.student_id = u.user_id
            WHERE u.role = 'Student'
            GROUP BY u.user_id
            ORDER BY u.last_name ASC, u.first_name ASC
        `);

        // ─────────────────────────────────────────────────────────────────────
        // TAB 4 — TEST PAPER QUESTION BANK
        // questionBank: all questions with topic, quarter, subject IDs attached
        //   for client-side filtering (data-subject, data-quarter, data-topic).
        // ─────────────────────────────────────────────────────────────────────
        const [questionBank] = await db.query(`
            SELECT
                qb.question_id, qb.question_text,
                qb.input_mode, qb.mechanic_type, qb.difficulty,
                qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                qb.correct_answer,
                qb.topic_id,
                t.topic_name,
                q.quarter_id, q.quarter_number,
                s.subject_id
            FROM question_bank qb
            LEFT JOIN topics   t  ON t.topic_id   = qb.topic_id
            LEFT JOIN quarters q  ON q.quarter_id  = t.quarter_id
            LEFT JOIN subjects s  ON s.subject_id  = q.subject_id
            ORDER BY s.subject_name ASC, q.quarter_number ASC, qb.question_id ASC
        `);

        // Also fetch sequences for Periodic_Sequence questions (used in PDF)
        const seqQids = questionBank
            .filter(q => q.input_mode === 'Periodic_Sequence')
            .map(q => q.question_id);
        if (seqQids.length) {
            const [seqs] = await db.query(
                `SELECT question_id, element_symbol, subscript, sort_order
                 FROM answer_sequences WHERE question_id IN (?) ORDER BY question_id, sort_order`,
                [seqQids]
            );
            const seqMap = {};
            seqs.forEach(s => {
                if (!seqMap[s.question_id]) seqMap[s.question_id] = [];
                seqMap[s.question_id].push(s);
            });
            questionBank.forEach(q => { q.sequences = seqMap[q.question_id] || []; });
        } else {
            questionBank.forEach(q => { q.sequences = []; });
        }

        // ─────────────────────────────────────────────────────────────────────
        // TAB 5 — ITEM ANALYSIS
        // itemAnalysis: per-question distractor breakdown for Standard MCQ
        // remediationAudit: students below 75% + whether they viewed linked material
        // ─────────────────────────────────────────────────────────────────────

        // Distractor tracking — Standard MCQ only (has options A-D)
        const [rawDistractors] = await db.query(`
            SELECT
                sr.question_id,
                qb.question_text,
                qb.correct_answer,
                COUNT(*) AS totalAttempts,
                SUM(sr.is_correct) AS correctCount,
                SUM(CASE WHEN sr.selected_option = 'A' THEN 1 ELSE 0 END) AS countA,
                SUM(CASE WHEN sr.selected_option = 'B' THEN 1 ELSE 0 END) AS countB,
                SUM(CASE WHEN sr.selected_option = 'C' THEN 1 ELSE 0 END) AS countC,
                SUM(CASE WHEN sr.selected_option = 'D' THEN 1 ELSE 0 END) AS countD
            FROM student_responses sr
            JOIN question_bank qb ON qb.question_id = sr.question_id
            WHERE qb.input_mode = 'Standard'
            GROUP BY sr.question_id
            ORDER BY totalAttempts DESC
            LIMIT 50
        `);

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

        // Remediation audit — students who scored < 75% and whether they viewed
        // any remediation-linked material for the same question's topic.
        const [remediationAudit] = await db.query(`
            SELECT
                CONCAT(u.first_name,' ',u.last_name)     AS student_name,
                ss.score_obtained                         AS score,
                ss.total_items,
                (ss.score_obtained / ss.total_items * 100) AS scorePct,
                EXISTS (
                    SELECT 1 FROM student_material_interactions smi
                    JOIN remediation_materials rm ON rm.material_id = smi.material_id
                    JOIN question_bank qb2 ON qb2.question_id = rm.question_id
                    JOIN assessments a2    ON a2.assessment_id = ss.assessment_id
                    WHERE smi.student_id = u.user_id
                      AND qb2.topic_id = (
                          SELECT topic_id FROM assessments WHERE assessment_id = ss.assessment_id LIMIT 1
                      )
                ) AS hasMaterialView
            FROM student_scores ss
            JOIN users u ON u.user_id = ss.student_id
            WHERE ss.total_items > 0
              AND (ss.score_obtained / ss.total_items * 100) < 75
            ORDER BY scorePct ASC
            LIMIT 100
        `);

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
            ORDER BY al.created_at DESC
            LIMIT 20
        `);

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
            curriculumData,
            classMapping,
            students,
            itemAnalysis,
            remediationAudit,
            activityLogs,
            subjects,
            quarters,
            topics,
            questionBank,
        });

    } catch (err) {
        console.error('[RM GET Error]', err);
        res.status(500).send('Server error loading Reports & Monitoring: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT: CURRICULUM PROGRESS — Excel
// Called by: exportCurriculum() → GET /admin/rm/export/curriculum
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/export/curriculum', requireAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                s.subject_name,
                q.quarter_number,
                t.topic_name,
                COUNT(DISTINCT lm.material_id)   AS materialCount,
                COUNT(DISTINCT a.assessment_id)  AS assessmentCount
            FROM quarters q
            JOIN subjects s ON s.subject_id = q.subject_id
            LEFT JOIN topics t            ON t.quarter_id   = q.quarter_id
            LEFT JOIN learning_materials lm ON lm.topic_id  = t.topic_id
            LEFT JOIN assessments a         ON a.topic_id   = t.topic_id
            GROUP BY q.quarter_id, t.topic_id
            ORDER BY s.subject_name, q.quarter_number, t.topic_id
        `);

        const sheetData = [
            ['Subject', 'Quarter', 'Topic', 'Materials', 'Assessments', 'Covered %']
        ];
        rows.forEach(r => {
            const mC  = parseInt(r.materialCount,  10) || 0;
            const aC  = parseInt(r.assessmentCount,10) || 0;
            const pct = Math.min(100, (aC >= 1 ? 50 : 0) + (mC >= 1 ? 50 : 0));
            sheetData.push([
                r.subject_name || '',
                `Quarter ${r.quarter_number}`,
                r.topic_name   || '(No Topics)',
                mC,
                aC,
                `${pct}%`,
            ]);
        });

        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.aoa_to_sheet(sheetData);
        ws['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 32 }, { wch: 12 }, { wch: 14 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Curriculum Progress');

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CURRICULUM',
            'Exported Curriculum Progress Excel report');

        res.setHeader('Content-Disposition', 'attachment; filename="curriculum_progress.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buf);

    } catch (err) {
        console.error('[RM Export Curriculum Error]', err);
        return res.status(500).send('Export failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT: CLASS SUMMARY — PDF (all classes)
// Called by: exportClassSummary() → GET /admin/rm/export/class-summary
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/export/class-summary', requireAdmin, async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');

        const [classes] = await db.query(`
            SELECT
                c.class_id, c.class_name,
                CONCAT(u.first_name,' ',u.last_name) AS teacher_name,
                s.subject_name,
                COUNT(DISTINCT cs.student_id) AS studentCount,
                AVG(
                    CASE WHEN ss.total_items > 0
                    THEN (ss.score_obtained / ss.total_items) * 100
                    ELSE NULL END
                ) AS avgScore
            FROM classes c
            LEFT JOIN users u   ON u.user_id = c.teacher_id
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN student_scores ss ON ss.student_id = cs.student_id
            GROUP BY c.class_id
            ORDER BY s.subject_name ASC, c.class_name ASC
        `);

        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="class_summary.pdf"');
        doc.pipe(res);

        // ── Header ──────────────────────────────────────────────────────
        doc.fontSize(18).font('Helvetica-Bold').text('Chemistry Arcade LMS', { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Class & Teacher Mapping — Summary Report', { align: 'center' });
        doc.fontSize(9).fillColor('#64748b').text(`Generated: ${new Date().toLocaleString('en-PH')}`, { align: 'center' });
        doc.moveDown(1.2).fillColor('#000000');

        // ── Table ────────────────────────────────────────────────────────
        const colWidths = [140, 120, 110, 60, 70];
        const headers   = ['Class / Section', 'Teacher', 'Subject', 'Students', 'Avg Score'];
        const startX    = 48;
        let   y         = doc.y;

        // Header row background
        doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), 18).fill('#4f46e5');
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
        let x = startX;
        headers.forEach((h, i) => {
            doc.text(h, x + 4, y + 4, { width: colWidths[i] - 6 });
            x += colWidths[i];
        });
        y += 18;
        doc.fillColor('#000000').font('Helvetica').fontSize(9);

        classes.forEach((cl, idx) => {
            if (y > 740) { doc.addPage(); y = 48; }
            if (idx % 2 === 0) doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), 16).fill('#f8fafc');
            doc.fillColor('#1e293b');
            x = startX;
            const avg    = parseFloat(cl.avgScore) || 0;
            const avgStr = cl.avgScore != null ? `${avg.toFixed(1)}%` : '—';
            const cells  = [
                (cl.class_name   || '').substring(0, 22),
                (cl.teacher_name || '—').substring(0, 20),
                (cl.subject_name || '—').substring(0, 18),
                String(cl.studentCount || 0),
                avgStr,
            ];
            cells.forEach((cell, i) => {
                doc.text(cell, x + 4, y + 3, { width: colWidths[i] - 6 });
                x += colWidths[i];
            });
            y += 16;
        });

        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CLASS_SUMMARY',
            'Exported Class Summary PDF');

    } catch (err) {
        console.error('[RM Export Class Summary Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT: SINGLE CLASS DETAIL — PDF
// Called by: exportClassDetail(classId) → GET /admin/rm/export/class/:id
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/export/class/:id', requireAdmin, async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const classId = parseInt(req.params.id, 10);
        if (isNaN(classId)) return res.status(400).send('Invalid class ID.');

        const [[cls]] = await db.query(`
            SELECT c.class_name, c.subject_id,
                   CONCAT(u.first_name,' ',u.last_name) AS teacher_name,
                   s.subject_name
            FROM classes c
            LEFT JOIN users u ON u.user_id = c.teacher_id
            LEFT JOIN subjects s ON s.subject_id = c.subject_id
            WHERE c.class_id = ?
        `, [classId]);
        if (!cls) return res.status(404).send('Class not found.');

        // Students enrolled + their scores for this subject
        const [students] = await db.query(`
            SELECT
                u.first_name, u.last_name, u.lrn_number, u.grade_level, u.section,
                u.current_level, u.total_exp,
                COUNT(DISTINCT smi.interaction_id) AS interactionCount,
                AVG(
                    CASE WHEN ss.total_items > 0
                    THEN (ss.score_obtained / ss.total_items) * 100
                    ELSE NULL END
                ) AS avgScore
            FROM class_students cs
            JOIN users u ON u.user_id = cs.student_id
            LEFT JOIN student_material_interactions smi ON smi.student_id = u.user_id
            LEFT JOIN student_scores ss ON ss.student_id = u.user_id
            WHERE cs.class_id = ?
            GROUP BY u.user_id
            ORDER BY u.last_name ASC, u.first_name ASC
        `, [classId]);

        const doc      = new PDFDocument({ size: 'A4', margin: 48 });
        const filename = `class_${classId}_${(cls.class_name || 'detail').replace(/[^a-z0-9]/gi, '_')}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // Header
        doc.fontSize(16).font('Helvetica-Bold').text('Chemistry Arcade LMS — Class Report', { align: 'center' });
        doc.fontSize(11).font('Helvetica').fillColor('#64748b');
        doc.text(`Class: ${cls.class_name}  |  Teacher: ${cls.teacher_name || '—'}  |  Subject: ${cls.subject_name || '—'}`, { align: 'center' });
        doc.fontSize(9).text(`Generated: ${new Date().toLocaleString('en-PH')}`, { align: 'center' });
        doc.moveDown(1).fillColor('#000000');

        // Table header
        const colWidths = [130, 80, 60, 55, 55, 75, 45];
        const headers   = ['Student Name', 'LRN', 'Grade', 'Level', 'EXP', 'Avg Score', 'Status'];
        const startX    = 48;
        let   y         = doc.y;

        doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), 18).fill('#4f46e5');
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
        let x = startX;
        headers.forEach((h, i) => { doc.text(h, x + 3, y + 4, { width: colWidths[i] - 4 }); x += colWidths[i]; });
        y += 18;
        doc.font('Helvetica').fontSize(8);

        students.forEach((s, idx) => {
            if (y > 750) { doc.addPage(); y = 48; }
            if (idx % 2 === 0) doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), 15).fill('#f8fafc');
            doc.fillColor('#1e293b');
            const avg    = parseFloat(s.avgScore) || 0;
            const isPassing = s.avgScore != null && avg >= 75;
            const cells  = [
                `${s.first_name} ${s.last_name}`.substring(0, 22),
                s.lrn_number || '—',
                s.grade_level || '—',
                `Lv.${s.current_level}`,
                (s.total_exp || 0).toLocaleString(),
                s.avgScore != null ? `${avg.toFixed(1)}%` : '—',
                s.avgScore != null ? (isPassing ? 'Passing' : 'Failing') : 'N/A',
            ];
            x = startX;
            cells.forEach((cell, i) => {
                if (i === 6 && s.avgScore != null) doc.fillColor(isPassing ? '#065f46' : '#991b1b');
                else doc.fillColor('#1e293b');
                doc.text(cell, x + 3, y + 3, { width: colWidths[i] - 4 });
                x += colWidths[i];
            });
            y += 15;
        });

        if (students.length === 0) {
            doc.moveDown().fillColor('#64748b').fontSize(10).text('No students enrolled in this class.', { align: 'center' });
        }

        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_CLASS_DETAIL',
            `Exported class detail PDF for class ID ${classId}: "${cls.class_name}"`);

    } catch (err) {
        console.error('[RM Export Class Detail Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT: INDIVIDUAL STUDENT DOSSIER — PDF
// Called by: exportStudentDossier(userId) → GET /admin/rm/export/student/:id
// Sensitive fields EXCLUDED: password_hash, google_id, flagged_assessment_id
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/export/student/:id', requireAdmin, async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).send('Invalid user ID.');

        // Personal info (no sensitive fields)
        const [[student]] = await db.query(`
            SELECT
                first_name, last_name, email, role, created_at,
                grade_level, section, strand, lrn_number,
                current_level, total_exp, sex, birthdate,
                mobile_number, city_town
            FROM users
            WHERE user_id = ? AND role = 'Student'
        `, [userId]);
        if (!student) return res.status(404).send('Student not found.');

        // Academic scores
        const [scores] = await db.query(`
            SELECT
                a.assessment_name, a.assessment_type,
                ss.score_obtained, ss.total_items, ss.exp_gained, ss.date_recorded
            FROM student_scores ss
            JOIN assessments a ON a.assessment_id = ss.assessment_id
            WHERE ss.student_id = ?
            ORDER BY ss.date_recorded DESC
        `, [userId]);

        // Material interaction count
        const [[intRow]] = await db.query(
            `SELECT COUNT(*) AS cnt FROM student_material_interactions WHERE student_id = ?`,
            [userId]
        );

        const fullName = `${student.first_name} ${student.last_name}`;
        const doc      = new PDFDocument({ size: 'A4', margin: 50 });
        const filename = `dossier_${fullName.replace(/[^a-z0-9]/gi, '_')}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // ── Page Header ─────────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 72).fill('#4f46e5');
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
           .text('Chemistry Arcade LMS', 50, 16);
        doc.fontSize(11).font('Helvetica')
           .text('Student Academic Dossier', 50, 38);
        doc.fontSize(8).fillColor('#c7d2fe')
           .text(`Generated: ${new Date().toLocaleString('en-PH')}  |  Confidential`, 50, 56);
        doc.moveDown(3).fillColor('#000000');

        // ── Personal Information ─────────────────────────────────────────
        const drawSectionHeader = (title, yPos) => {
            doc.rect(50, yPos, doc.page.width - 100, 20).fill('#eef2ff');
            doc.fillColor('#4338ca').fontSize(10).font('Helvetica-Bold')
               .text(title, 55, yPos + 5);
            doc.fillColor('#000000');
        };

        let curY = doc.y;
        drawSectionHeader('PERSONAL INFORMATION', curY);
        curY += 28;
        doc.font('Helvetica').fontSize(10);
        const infoRows = [
            ['Full Name',      fullName],
            ['Email',          student.email || '—'],
            ['Role',           student.role  || '—'],
            ['Grade Level',    student.grade_level || '—'],
            ['Section',        student.section     || '—'],
            ['Strand',         student.strand      || '—'],
            ['LRN',            student.lrn_number  || '—'],
            ['Sex',            student.sex         || '—'],
            ['Birthdate',      student.birthdate ? new Date(student.birthdate).toLocaleDateString('en-PH') : '—'],
            ['Mobile',         student.mobile_number || '—'],
            ['City/Town',      student.city_town     || '—'],
            ['Joined',         new Date(student.created_at).toLocaleDateString('en-PH')],
        ];
        infoRows.forEach(([label, value]) => {
            doc.fillColor('#64748b').text(label + ':', 55, curY, { width: 110, continued: false });
            doc.fillColor('#1e293b').text(value, 175, curY);
            curY += 15;
        });

        // ── Arcade Status ────────────────────────────────────────────────
        curY += 6;
        drawSectionHeader('ARCADE STATUS', curY);
        curY += 28;
        doc.font('Helvetica').fontSize(10);
        [
            ['Current Level', `Level ${student.current_level}`],
            ['Total EXP',     (student.total_exp || 0).toLocaleString() + ' EXP'],
            ['Material Interactions', String(intRow.cnt)],
        ].forEach(([label, value]) => {
            doc.fillColor('#64748b').text(label + ':', 55, curY, { width: 160 });
            doc.fillColor('#1e293b').text(value, 225, curY);
            curY += 15;
        });

        // ── Academic Scores ──────────────────────────────────────────────
        curY += 8;
        if (curY > 650) { doc.addPage(); curY = 50; }
        drawSectionHeader('ASSESSMENT SCORES', curY);
        curY += 28;

        if (scores.length === 0) {
            doc.fontSize(10).fillColor('#64748b').text('No assessment records.', 55, curY);
        } else {
            // Mini table headers
            const sCols = [190, 90, 90, 80];
            const sHdrs = ['Assessment', 'Type', 'Score', 'EXP'];
            doc.rect(50, curY, sCols.reduce((a, b) => a + b, 0), 16).fill('#4f46e5');
            doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
            let sx = 50;
            sHdrs.forEach((h, i) => { doc.text(h, sx + 3, curY + 4, { width: sCols[i] - 4 }); sx += sCols[i]; });
            curY += 16;
            doc.font('Helvetica').fontSize(8);

            scores.forEach((sc, idx) => {
                if (curY > 760) { doc.addPage(); curY = 50; }
                if (idx % 2 === 0) doc.rect(50, curY, sCols.reduce((a, b) => a + b, 0), 14).fill('#f8fafc');
                const pct     = sc.total_items > 0 ? ((sc.score_obtained / sc.total_items) * 100).toFixed(0) : 0;
                const passing = parseInt(pct, 10) >= 75;
                doc.fillColor(passing ? '#065f46' : '#991b1b');
                const cells = [
                    (sc.assessment_name || 'Unnamed').substring(0, 28),
                    sc.assessment_type  || '—',
                    `${sc.score_obtained}/${sc.total_items} (${pct}%)`,
                    `+${sc.exp_gained || 0}`,
                ];
                sx = 50;
                cells.forEach((cell, i) => {
                    if (i !== 2) doc.fillColor('#1e293b');
                    doc.text(cell, sx + 3, curY + 3, { width: sCols[i] - 4 });
                    sx += sCols[i];
                });
                curY += 14;
            });
        }

        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_STUDENT_DOSSIER',
            `Exported dossier PDF for student: ${fullName} (ID: ${userId})`);

    } catch (err) {
        console.error('[RM Export Student Dossier Error]', err);
        if (!res.headersSent) res.status(500).send('Export failed: ' + err.message);
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT: ALL STUDENTS — PDF (with optional filter: all | pass | fail)
// Called by: exportAllStudentsPDF() → GET /admin/rm/export/students-all?status=
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/rm/export/students-all', requireAdmin, async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const statusFilter = req.query.status || 'all'; // all | pass | fail

        let havingClause = '';
        if (statusFilter === 'pass') havingClause = 'HAVING avgPct >= 75 OR avgPct IS NULL';
        if (statusFilter === 'fail') havingClause = 'HAVING avgPct < 75 AND avgPct IS NOT NULL';

        const [students] = await db.query(`
            SELECT
                u.user_id, u.first_name, u.last_name, u.email,
                u.grade_level, u.section, u.current_level, u.total_exp,
                u.lrn_number,
                AVG(
                    CASE WHEN ss.total_items > 0
                    THEN (ss.score_obtained / ss.total_items) * 100
                    ELSE NULL END
                ) AS avgPct,
                COUNT(DISTINCT smi.interaction_id) AS interactionCount
            FROM users u
            LEFT JOIN student_scores ss ON ss.student_id = u.user_id
            LEFT JOIN student_material_interactions smi ON smi.student_id = u.user_id
            WHERE u.role = 'Student'
            GROUP BY u.user_id
            ${havingClause}
            ORDER BY u.last_name ASC, u.first_name ASC
        `);

        const doc      = new PDFDocument({ size: 'A4', margin: 48, layout: 'landscape' });
        const label    = statusFilter === 'pass' ? 'Passing Students' : statusFilter === 'fail' ? 'Failing Students' : 'All Students';
        const filename = `students_${statusFilter}_${Date.now()}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // Header
        doc.rect(0, 0, doc.page.width, 60).fill('#4f46e5');
        doc.fillColor('white').fontSize(16).font('Helvetica-Bold')
           .text('Chemistry Arcade LMS', 48, 12);
        doc.fontSize(10).font('Helvetica')
           .text(`Student Report — ${label}  |  Generated: ${new Date().toLocaleDateString('en-PH')}`, 48, 34);
        doc.moveDown(3).fillColor('#000000');

        const colW   = [150, 100, 80, 60, 65, 75, 60, 60];
        const hdrs   = ['Student Name', 'Email', 'LRN', 'Grade', 'Section', 'Avg Score', 'Level', 'Status'];
        const startX = 48;
        let   y      = doc.y;

        doc.rect(startX, y, colW.reduce((a, b) => a + b, 0), 18).fill('#6366f1');
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
        let x = startX;
        hdrs.forEach((h, i) => { doc.text(h, x + 3, y + 4, { width: colW[i] - 4 }); x += colW[i]; });
        y += 18;
        doc.font('Helvetica').fontSize(8);

        students.forEach((s, idx) => {
            if (y > 520) { doc.addPage({ layout: 'landscape' }); y = 48; }
            if (idx % 2 === 0) doc.rect(startX, y, colW.reduce((a, b) => a + b, 0), 14).fill('#f8fafc');
            const avg     = parseFloat(s.avgPct) || 0;
            const passing = s.avgPct != null && avg >= 75;
            const cells   = [
                `${s.first_name} ${s.last_name}`.substring(0, 24),
                (s.email         || '—').substring(0, 18),
                s.lrn_number     || '—',
                s.grade_level    || '—',
                s.section        || '—',
                s.avgPct != null ? `${avg.toFixed(1)}%` : '—',
                `Lv.${s.current_level}`,
                s.avgPct != null ? (passing ? 'Passing' : 'Failing') : 'N/A',
            ];
            x = startX;
            cells.forEach((cell, i) => {
                if (i === 7 && s.avgPct != null) doc.fillColor(passing ? '#065f46' : '#991b1b');
                else doc.fillColor('#1e293b');
                doc.text(cell, x + 3, y + 3, { width: colW[i] - 4 });
                x += colW[i];
            });
            y += 14;
        });

        if (students.length === 0) {
            doc.fillColor('#64748b').fontSize(11).text('No students match this filter.', { align: 'center' });
        }

        doc.end();

        await logActivity(req.user.user_id, 'Admin', 'EXPORT_ALL_STUDENTS',
            `Exported All Students PDF (filter: ${statusFilter}) — ${students.length} record(s)`);

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

        // Fetch selected questions with sequence data
        const [questions] = await db.query(`
            SELECT
                qb.question_id, qb.question_text, qb.input_mode,
                qb.option_a, qb.option_b, qb.option_c, qb.option_d,
                qb.correct_answer, qb.difficulty,
                qb.instruction_override,
                t.topic_name,
                q.quarter_number,
                s.subject_name
            FROM question_bank qb
            LEFT JOIN topics   t ON t.topic_id   = qb.topic_id
            LEFT JOIN quarters q ON q.quarter_id  = t.quarter_id
            LEFT JOIN subjects s ON s.subject_id  = q.subject_id
            WHERE qb.question_id IN (?)
        `, [ids]);

        // Preserve the order the admin selected them in
        const orderedQuestions = ids
            .map(id => questions.find(q => q.question_id === id))
            .filter(Boolean);

        // Fetch sequences for Periodic_Sequence questions
        const seqIds = orderedQuestions
            .filter(q => q.input_mode === 'Periodic_Sequence')
            .map(q => q.question_id);

        const seqMap = {};
        if (seqIds.length) {
            const [seqs] = await db.query(
                `SELECT question_id, element_symbol, subscript, sort_order
                 FROM answer_sequences WHERE question_id IN (?) ORDER BY question_id, sort_order`,
                [seqIds]
            );
            seqs.forEach(s => {
                if (!seqMap[s.question_id]) seqMap[s.question_id] = [];
                seqMap[s.question_id].push(s);
            });
        }

        // Build HTML question blocks
        const buildQuestionBlock = (q, num, showAnswers) => {
            const seqs = seqMap[q.question_id] || [];

            let bodyHtml = '';

            if (q.input_mode === 'Standard') {
                const opts = ['A', 'B', 'C', 'D'];
                const vals = [q.option_a, q.option_b, q.option_c, q.option_d];
                const optHtml = opts.map((lbl, i) => {
                    const isCorrect = showAnswers && (q.correct_answer === lbl);
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
            if (q.input_mode === 'Periodic_Sequence') {
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
<div class="header-block">
    <h1>MABINI COLLEGE</h1>
    <h2>Chemistry Arcade LMS — ${title}</h2>
    <p style="font-size:10px;color:#64748b;">Subject: ${orderedQuestions[0] && orderedQuestions[0].subject_name ? orderedQuestions[0].subject_name : ''}  |  Total Items: ${orderedQuestions.length}</p>
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
        }
        if (filterTo) {
            whereClauses.push('DATE(al.created_at) <= ?');
            whereParams.push(filterTo);
        }

        const whereSQL = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

        // ── 1. KPI COUNTS ──────────────────────────────────────────────────────
        const [[totalRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs al ${whereSQL}`, whereParams);
        const [[adminRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Admin'`);
        const [[teacherRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Teacher'`);
        const [[studentRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_role = 'Student'`);

        const auditStats = {
            totalLogs      : totalRow.cnt,
            adminActions   : adminRow.cnt,
            teacherActions : teacherRow.cnt,
            studentActions : studentRow.cnt,
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
                al.log_id, al.actor_id, al.actor_role, al.action, al.description, al.created_at,
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
            ORDER BY u.last_name ASC, u.first_name ASC
        `);

        // ── 8. QUESTION BANK AUDIT ─────────────────────────────────────────────
        const [[qTotalRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank`);
        const [[qPendingRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank WHERE verification_status = 'Pending'`);
        const [[qApprovedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank WHERE verification_status = 'Approved'`);
        const [[qRejectedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM question_bank WHERE verification_status = 'Rejected'`);

        const questionStats = {
            total    : qTotalRow.cnt,
            pending  : qPendingRow.cnt,
            approved : qApprovedRow.cnt,
            rejected : qRejectedRow.cnt,
        };

        // Questions still pending — show up to 20
        const [pendingQuestions] = await db.query(`
            SELECT
                qb.question_id, qb.question_text, qb.difficulty, qb.input_mode,
                t.topic_name,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
            FROM question_bank qb
            LEFT JOIN topics  t ON t.topic_id   = qb.topic_id
            LEFT JOIN users   u ON u.user_id     = qb.teacher_id
            WHERE qb.verification_status = 'Pending'
            ORDER BY qb.question_id DESC
            LIMIT 20
        `);

        // ── 9. ACTIVE / RECENT ARCADE SESSIONS ────────────────────────────────
        const [[sessTotalRow]]    = await db.query(`SELECT COUNT(*) AS cnt FROM active_sessions`);
        const [[sessOngoingRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM active_sessions WHERE session_status = 'Ongoing'`);
        const [[sessFinishedRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM active_sessions WHERE session_status = 'Finished'`);

        const sessionStats = {
            total    : sessTotalRow.cnt,
            ongoing  : sessOngoingRow.cnt,
            finished : sessFinishedRow.cnt,
        };

        const [activeSessions] = await db.query(`
            SELECT
                s.session_id, s.player_mode, s.current_item_index,
                s.accumulated_score, s.session_status, s.start_time,
                a.assessment_name, a.total_items,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM active_sessions s
            JOIN users        u ON u.user_id        = s.student_id
            JOIN assessments  a ON a.assessment_id  = s.assessment_id
            ORDER BY
                FIELD(s.session_status, 'Ongoing', 'Finished'),
                s.start_time DESC
            LIMIT 50
        `);

        // ── 10. COMPETITIVE MATCH LOG ──────────────────────────────────────────
        const [[matchTotalRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM competitive_matches`);

        const matchStats = { totalMatches: matchTotalRow.cnt };

        const [competitiveMatches] = await db.query(`
            SELECT
                cm.match_id, cm.p1_score, cm.p2_score, cm.match_date,
                a.assessment_name,
                CONCAT(p1.first_name, ' ', p1.last_name) AS p1_name,
                CONCAT(p2.first_name, ' ', p2.last_name) AS p2_name,
                CONCAT(w.first_name,  ' ', w.last_name)  AS winner_name
            FROM competitive_matches cm
            LEFT JOIN users        p1 ON p1.user_id = cm.p1_id
            LEFT JOIN users        p2 ON p2.user_id = cm.p2_id
            LEFT JOIN users        w  ON w.user_id  = cm.winner_id
            LEFT JOIN assessments  a  ON a.assessment_id = cm.assessment_id
            ORDER BY cm.match_date DESC
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
            GROUP BY c.class_id
            ORDER BY c.class_name ASC
        `);

        // ── 13. MATERIAL INTERACTION LOG ──────────────────────────────────────
        const [[viewRow]]     = await db.query(`SELECT COUNT(*) AS cnt FROM student_material_interactions WHERE interaction_type = 'viewed'`);
        const [[downloadRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM student_material_interactions WHERE interaction_type = 'downloaded'`);

        const materialStats = {
            totalViews     : viewRow.cnt,
            totalDownloads : downloadRow.cnt,
        };

        const [materialInteractions] = await db.query(`
            SELECT
                smi.interaction_id, smi.interaction_type, smi.interacted_at,
                lm.title AS material_title, lm.material_type,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name
            FROM student_material_interactions smi
            JOIN users             u  ON u.user_id    = smi.student_id
            JOIN learning_materials lm ON lm.material_id = smi.material_id
            ORDER BY smi.interacted_at DESC
            LIMIT 50
        `);

        // ── 14. FORUM ACTIVITY ─────────────────────────────────────────────────
        const [[forumTopicsRow]]   = await db.query(`SELECT COUNT(*) AS cnt FROM forum_topics`);
        const [[forumRepliesRow]]  = await db.query(`SELECT COUNT(*) AS cnt FROM forum_replies`);

        const [recentForumReplies] = await db.query(`
            SELECT
                fr.reply_id, fr.reply_content, fr.created_at,
                ft.title AS forum_title,
                CONCAT(u.first_name, ' ', u.last_name) AS user_name
            FROM forum_replies fr
            JOIN users        u  ON u.user_id  = fr.user_id
            JOIN forum_topics ft ON ft.forum_id = fr.topic_id
            ORDER BY fr.created_at DESC
            LIMIT 15
        `);

        const forumStats = {
            totalTopics  : forumTopicsRow.cnt,
            totalReplies : forumRepliesRow.cnt,
            recentReplies: recentForumReplies,
        };

        // ── Render ─────────────────────────────────────────────────────────────
        res.render('admin/system_audit', {
            user: req.user,

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
        // Fetch all logs joined with user names — no pagination for export
        const [rows] = await db.query(`
            SELECT
                al.log_id,
                CONCAT(u.first_name, ' ', u.last_name) AS actor_name,
                al.actor_role,
                al.action,
                al.description,
                al.created_at
            FROM activity_logs al
            LEFT JOIN users u ON u.user_id = al.actor_id
            ORDER BY al.created_at DESC
        `);

        // Build worksheet data
        const wsData = [
            ['Log ID', 'Actor Name', 'Actor Role', 'Action', 'Description', 'Date & Time']
        ];

        rows.forEach(r => {
            wsData.push([
                r.log_id,
                r.actor_name || '—',
                r.actor_role,
                r.action,
                r.description || '',
                r.created_at ? new Date(r.created_at).toLocaleString('en-PH') : '',
            ]);
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Column widths
        ws['!cols'] = [
            { wch: 8  },  // Log ID
            { wch: 22 },  // Actor Name
            { wch: 10 },  // Role
            { wch: 24 },  // Action
            { wch: 60 },  // Description
            { wch: 22 },  // Date
        ];

        XLSX.utils.book_append_sheet(wb, ws, 'Activity Log');

        const filename = `audit_log_${new Date().toISOString().slice(0, 10)}.xlsx`;
        const buffer   = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        await logActivity(
            req.user.user_id,
            'Admin',
            'EXPORT_AUDIT_LOG',
            `Exported full system audit log (${rows.length} entries)`
        );

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buffer);

    } catch (err) {
        console.error('[Audit Export Error]', err);
        return res.status(500).send('Audit export failed: ' + err.message);
    }
});

module.exports = router;