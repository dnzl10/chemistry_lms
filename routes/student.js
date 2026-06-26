const express = require('express');
const router  = express.Router();
const db      = require('../db');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { forumUpload } = require('../app');


// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Recalculate and upsert student_progress for one student+subject.
// Formula: (done forums + done assessments + done materials) / total × 100
// Call this after any insert to student_forum_done, student_scores,
// or student_material_interactions.
// ─────────────────────────────────────────────────────────────────────────────
async function recalculateProgress(studentId, subjectId) {
    try {
        // --- Total counts (all unlocked items linked to this subject) ---

        const [[{ totalForums }]] = await db.query(`
            SELECT COUNT(*) AS totalForums
            FROM forum_topics ft
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0
        `, [subjectId]);

        const [[{ totalAssessments }]] = await db.query(`
            SELECT COUNT(*) AS totalAssessments
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0 AND a.is_unlocked = 1
        `, [subjectId]);

        const [[{ totalMaterials }]] = await db.query(`
            SELECT COUNT(*) AS totalMaterials
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ? AND t.is_locked = 0 AND lm.is_locked = 0
        `, [subjectId]);

        // --- Done counts for this specific student ---

        const [[{ doneForums }]] = await db.query(`
            SELECT COUNT(*) AS doneForums
            FROM student_forum_done sfd
            JOIN forum_topics ft ON sfd.forum_id = ft.forum_id
            JOIN topics t ON ft.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE sfd.student_id = ? AND q.subject_id = ?
        `, [studentId, subjectId]);

        const [[{ doneAssessments }]] = await db.query(`
            SELECT COUNT(DISTINCT ss.assessment_id) AS doneAssessments
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ss.student_id = ? AND q.subject_id = ?
        `, [studentId, subjectId]);

        const [[{ doneMaterials }]] = await db.query(`
            SELECT COUNT(DISTINCT smi.material_id) AS doneMaterials
            FROM student_material_interactions smi
            JOIN learning_materials lm ON smi.material_id = lm.material_id
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE smi.student_id = ? AND q.subject_id = ?
        `, [studentId, subjectId]);

        // --- Calculate ---
        const total = (totalForums + totalAssessments + totalMaterials) || 0;
        const done  = (doneForums  + doneAssessments  + doneMaterials)  || 0;
        const progressPercent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

        // --- Upsert student_progress ---
        await db.query(`
            INSERT INTO student_progress (student_id, subject_id, progress_percent, last_accessed)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                progress_percent = VALUES(progress_percent),
                last_accessed    = NOW()
        `, [studentId, subjectId, progressPercent]);

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

        const [
            [announcements],
            [upcomingTasks],
            [timeline],
            [subjects],
            [events],
            [assessmentDates],
            [recentForums]
        ] = await Promise.all([

            db.query(`
                SELECT a.*, u.first_name, u.last_name
                FROM announcements a
                JOIN users u ON a.teacher_id = u.user_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN classes c ON a.class_id = c.class_id
                WHERE (a.topic_id IS NULL AND c.class_id IN (
                            SELECT class_id FROM class_students WHERE student_id = ?
                    ))
                OR (a.topic_id IS NOT NULL AND a.topic_id IN (
                            SELECT t.topic_id
                            FROM topics t
                            JOIN quarters q ON t.quarter_id = q.quarter_id
                            JOIN classes c ON q.subject_id = c.subject_id
                            JOIN class_students cs ON cs.class_id = c.class_id
                            WHERE cs.student_id = ?
                    ))
                ORDER BY a.created_at DESC
                LIMIT 3
            `, [studentId, studentId]),

            db.query(`
                SELECT a.* 
                FROM assessments a
                JOIN quarters q ON a.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                JOIN class_students cs ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
                AND a.due_date >= NOW()
                AND a.is_unlocked = 1
                ORDER BY a.due_date ASC
                LIMIT 4
            `, [studentId]),

            db.query(`
                SELECT a.*, s.subject_name 
                FROM assessments a
                JOIN quarters q ON a.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                ORDER BY a.due_date DESC
            `),

            db.query(`
                SELECT 
                s.subject_id,
                s.subject_name,
                s.subject_code,
                s.subject_image, -- <--- Add this column here
                COALESCE(sp.progress_percent,0) AS progress_percent,
                sp.last_accessed
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                JOIN subjects s ON c.subject_id = s.subject_id
                LEFT JOIN student_progress sp 
                       ON sp.subject_id = s.subject_id 
                       AND sp.student_id = cs.student_id
                WHERE cs.student_id = ?
                ORDER BY sp.last_accessed DESC
                LIMIT 2
            `, [studentId]),

            db.query(`
                SELECT * 
                FROM calendar_events 
                WHERE MONTH(event_date) = MONTH(CURRENT_DATE())
            `),

            db.query(`
                SELECT 
                DATE(due_date) AS due_date,
                assessment_name
                FROM assessments
                WHERE due_date IS NOT NULL
                AND is_unlocked = 1
            `),

            db.query(`
                SELECT 
                    ft.forum_id, ft.title, ft.subject_id, ft.teacher_id, ft.created_at, 
                    s.subject_code
                FROM forum_topics ft
                JOIN subjects s ON ft.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                JOIN class_students cs ON c.class_id = cs.class_id
                WHERE cs.student_id = ?
                LIMIT 20 OFFSET 0
            `, [studentId]),
        ]);

        const [[currentUser]] = await db.query(
            'SELECT flagged_assessment_id FROM users WHERE user_id = ?',
            [studentId]
        );

        // Normalize progress
        subjects.forEach(c => {
            c.progress_percent = Math.min(100, Math.max(0, Math.round(c.progress_percent || 0)));
        });

        // Convert assessment due dates to day numbers
        const dueDays = (assessmentDates || []).map(a => {
            const d = new Date(a.due_date);
            return d.getDate();
        });


        // Calendar Logic
        const today = new Date();
        const year = today.getFullYear();
        const month = today.getMonth();

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        let calendarDays = [];

        for (let i = 0; i < firstDay; i++) {
            calendarDays.push(null);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            calendarDays.push(d);
        }

        // Render dashboard
        res.render('dashboard-student', {
            user: req.user,
            announcements: announcements ?? [],
            upcomingTasks: upcomingTasks ?? [],
            timeline: timeline ?? [],
            subjects: subjects ?? [],
            events: events ?? [],
            calendarDays,
            month,
            year,
            dueDays,   // IMPORTANT 
            recentForums ,
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
        res.sendStatus(200);
    } catch (err) {
        console.error("Flag Assessment Error:", err);
        res.sendStatus(500);
    }
});

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
        const user = req.user; // Dito galing ang data (first_name, qr_code_token, etc.)

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

        // 3. I-render ang profile page at ipasa ang user at qrCodeData
        res.render('profile', { 
            user: user, 
            qrCodeData: qrCodeData 
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
                fs.unlink(oldPath, () => {}); // silent fail — file may already be gone
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
            fs.unlink(failedPath, () => {});
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});



// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conversations
// Returns a list of unique conversation partners for the current user.
// Each entry has: other_user_id, other_name, other_pic, last_message, unread
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/conversations', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId = req.user.user_id;
 
    try {
        const [rows] = await db.query(`
            SELECT
                partner.user_id                                        AS other_user_id,
                CONCAT(partner.first_name, ' ', partner.last_name)     AS other_name,
                partner.profile_pic                                    AS other_pic,
                latest.message_text                                    AS last_message,
                latest.sent_at,
                unread.cnt                                             AS unread
            FROM (
                -- all unique partner IDs
                SELECT DISTINCT
                    IF(sender_id = ?, receiver_id, sender_id) AS partner_id
                FROM private_messages
                WHERE sender_id = ? OR receiver_id = ?
            ) convo
            JOIN users partner ON partner.user_id = convo.partner_id
            JOIN private_messages latest ON latest.message_id = (
                SELECT message_id FROM private_messages
                WHERE (sender_id = ? AND receiver_id = convo.partner_id)
                   OR (sender_id = convo.partner_id AND receiver_id = ?)
                ORDER BY sent_at DESC LIMIT 1
            )
            LEFT JOIN (
                SELECT sender_id, COUNT(*) AS cnt
                FROM private_messages
                WHERE receiver_id = ? AND is_read = 0
                GROUP BY sender_id
            ) unread ON unread.sender_id = convo.partner_id
            ORDER BY latest.sent_at DESC
        `, [myId, myId, myId, myId, myId, myId]);
 
        res.json(rows);
    } catch (err) {
        console.error('[GET CONVERSATIONS]', err);
        res.status(500).json([]);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/:userId
// Returns full message thread between current user and :userId.
// Also marks received messages as read.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/messages/:userId', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId     = req.user.user_id;
    const otherId  = parseInt(req.params.userId, 10);
 
    if (isNaN(otherId)) return res.status(400).json([]);
 
    try {
        const [messages] = await db.query(`
            SELECT message_id, sender_id, receiver_id, message_text, sent_at, is_read
            FROM private_messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY sent_at ASC
        `, [myId, otherId, otherId, myId]);
 
        // Mark incoming messages as read
        await db.query(
            `UPDATE private_messages SET is_read = 1
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [otherId, myId]
        );
 
        res.json(messages);
    } catch (err) {
        console.error('[GET MESSAGES]', err);
        res.status(500).json([]);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages
// Send a new private message to another user.
// Body: { receiver_id, message_text }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/messages', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const senderId  = req.user.user_id;
    const { receiver_id, message_text } = req.body;

    if (!receiver_id || !message_text?.trim()) {
        return res.status(400).json({ error: 'receiver_id and message_text are required' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO private_messages (sender_id, receiver_id, message_text, is_read)
             VALUES (?, ?, ?, 0)`,
            [senderId, parseInt(receiver_id, 10), message_text.trim()]
        );
        res.json({ success: true, message_id: result.insertId });
    } catch (err) {
        console.error('[POST MESSAGES]', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search-users?q=
// Search for users to start a new conversation.
// Excludes current user. Returns: user_id, first_name, last_name, role, profile_pic
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/search-users', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const myId = req.user.user_id;
    const q    = String(req.query.q || '').trim();
 
    if (!q) return res.json([]);
 
    try {
        const like = `%${q}%`;
        const [users] = await db.query(`
            SELECT user_id, first_name, last_name, role, profile_pic
            FROM users
            WHERE user_id <> ?
              AND (
                  first_name  LIKE ? OR
                  last_name   LIKE ? OR
                  email       LIKE ? OR
                  CONCAT(first_name,' ',last_name) LIKE ?
              )
            LIMIT 10
        `, [myId, like, like, like, like]);
 
        res.json(users);
    } catch (err) {
        console.error('[SEARCH USERS]', err);
        res.status(500).json([]);
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
        // User summary (level + total exp)
        const [[summary]] = await db.query(
            `SELECT user_id, first_name, last_name, current_level, total_exp
             FROM users WHERE user_id = ?`,
            [studentId]
        );
 
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
            label     : s.assessment_name,
            exp_gained: s.exp_gained || 0
        }));
 
        res.json({ success: true, summary, scores, expHistory });
 
    } catch (err) {
        console.error('[MY GAME STATS]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /home - Listahan ng mga subjects na pwedeng pasukan
router.get('/home', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");

    const studentId = req.user.user_id;

    try {
        // Kunin ang subjects na HINDI pa naka-enroll ang student (base sa student_progress)
        const [subjects] = await db.query(`
            SELECT s.*, u.first_name, u.last_name, u.profile_pic
            FROM subjects s
            LEFT JOIN classes c ON s.subject_id = c.subject_id
            LEFT JOIN users u ON c.teacher_id = u.user_id
            WHERE s.subject_id NOT IN (
                SELECT subject_id FROM student_progress WHERE student_id = ?
            )
        `, [studentId]);

        res.render('home-student', { user: req.user, subjects });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// POST /enroll - Logic para sa pag-enroll gamit ang code
router.post('/enroll', async (req, res) => {
    
    const { subject_id, enrollment_code } = req.body;
    const student_id = req.user.user_id; // Passport.js gamit mo kaya req.user dapat

    try {
        // 1. I-verify ang Code at kunin ang Class ID
        // Ginagamit natin ang JOIN para makuha ang class_id na naka-link sa subject na iyon
        const [subjectData] = await db.query(`
            SELECT s.enrollment_code, c.class_id 
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            WHERE s.subject_id = ?
        `, [subject_id]);

        if (subjectData.length === 0 || subjectData[0].enrollment_code !== enrollment_code) {
            return res.send("<script>alert('Maling Enrollment Code!'); window.location='/home';</script>");
        }

        const class_id = subjectData[0].class_id;

        // 2. I-check kung enrolled na (safety check)
        const [existing] = await db.query(
            "SELECT * FROM student_progress WHERE student_id = ? AND subject_id = ?",
            [student_id, subject_id]
        );

        if (existing.length > 0) {
            return res.send("<script>alert('Enrolled ka na rito!'); window.location='/dashboard';</script>");
        }

        // 3. TRANSACTION: Mag-insert sa dalawang table nang sabay
        // Para siguradong lalabas sa Dashboard (class_students) at may progress tracking (student_progress)
        await db.query("INSERT INTO student_progress (student_id, subject_id, progress_percent) VALUES (?, ?, 0)", [student_id, subject_id]);
        await db.query("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", [class_id, student_id]);

        res.send("<script>alert('Enrollment Successful!'); window.location='/dashboard';</script>");
    } catch (err) {
        console.error(err);
        res.status(500).send("Enrollment Failed");
    }
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
            WHERE cs.student_id = ?
              AND e.teacher_id != ?
            ORDER BY e.event_date ASC
        `, [studentId, studentId]);
 
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
                a.assessment_type,
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
            teacherEvents:  teacherEvents  || [],
            studentEvents:  studentEvents  || [],
            dueDates:       dueDates       || [],
            userSubjects:   userSubjects   || []
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
 
        const finalStartDate  = duration_type === 'DateRange' ? (start_date  || null) : null;
        const finalEndDate    = duration_type === 'DateRange' ? (end_date    || null) : null;
        const finalMinutes    = duration_type === 'Minutes'   ? (duration_minutes || null) : null;
        const repeatableFlag  = is_repeatable === 'on' ? 1 : 0;
        const finalCycle      = repeatableFlag ? (repeat_cycle || 'None') : 'None';
 
        await db.query(`
            INSERT INTO calendar_events (
                subject_id, event_title, event_description, event_location,
                event_type, event_date, duration_type,
                start_date, end_date, duration_minutes,
                is_repeatable, repeat_cycle, teacher_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            subject_id   || null,
            event_title,
            event_description || null,
            event_location    || 'TBA',
            event_type        || 'Material',
            event_date,
            duration_type     || 'None',
            finalStartDate,
            finalEndDate,
            finalMinutes,
            repeatableFlag,
            finalCycle,
            studentId   // student is the creator
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
    const eventId   = parseInt(req.params.id, 10);
 
    try {
        // Ownership check — only allow editing if teacher_id === student's id
        const [[existing]] = await db.query(
            'SELECT event_id FROM calendar_events WHERE event_id = ? AND teacher_id = ?',
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
            repeat_cycle
        } = req.body;
 
        if (!event_title || !event_date) {
            return res.status(400).send('Event title and date are required.');
        }
 
        const finalStartDate = duration_type === 'DateRange' ? (start_date  || null) : null;
        const finalEndDate   = duration_type === 'DateRange' ? (end_date    || null) : null;
        const finalMinutes   = duration_type === 'Minutes'   ? (duration_minutes || null) : null;
        const repeatableFlag = is_repeatable === 'on' ? 1 : 0;
        const finalCycle     = repeatableFlag ? (repeat_cycle || 'None') : 'None';
 
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
            subject_id        || null,
            event_title,
            event_description || null,
            event_location    || 'TBA',
            event_type        || 'Material',
            event_date,
            duration_type     || 'None',
            finalStartDate,
            finalEndDate,
            finalMinutes,
            repeatableFlag,
            finalCycle,
            eventId,
            studentId   // double-enforce ownership in WHERE clause
        ]);
 
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
    const eventId   = parseInt(req.params.id, 10);
 
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
        // classes -> users (para sa Teacher name)
        // classes -> school_years (para sa SY range)
        const [enrolledSubjects] = await db.execute(`
            SELECT 
                s.subject_id,
                s.subject_code,
                s.subject_name,
                s.subject_image,
                s.description,
                s.semester,
                CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                sy.sy_range
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN users t ON c.teacher_id = t.user_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE cs.student_id = ?
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

// GET /subjects/open/:id - View specific subject details
router.get('/subjects/open/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const subjectId = req.params.id;
    const studentId = req.user.user_id;

    try {
        // 1. SUBJECT INFO
        const [subjectInfo] = await db.query(`
            SELECT s.*, c.class_name, sy.sy_range, CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, u.profile_pic AS teacher_pic
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            JOIN users u ON c.teacher_id = u.user_id
            WHERE s.subject_id = ?
        `, [subjectId]);

        if (subjectInfo.length === 0) return res.status(404).send("Subject not found");

        // 2. GET QUARTERS
        const [quartersRaw] = await db.query(`SELECT * FROM quarters WHERE subject_id = ?`, [subjectId]);

        // 3. GET TOPICS
        const [topicsRaw] = await db.query(`
            SELECT * FROM topics WHERE quarter_id IN (
                SELECT quarter_id FROM quarters WHERE subject_id = ?
            )
        `, [subjectId]);

        // 4. GET MATERIALS
        const [materialsRaw] = await db.query(`
            SELECT * FROM learning_materials WHERE topic_id IN (
                SELECT topic_id FROM topics WHERE quarter_id IN (
                    SELECT quarter_id FROM quarters WHERE subject_id = ?
                )
            )
        `, [subjectId]);

        // 5. GET ASSESSMENTS
        const [assessmentsRaw] = await db.query(`
            SELECT a.*
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
            ORDER BY a.due_date ASC
        `, [subjectId]);

        // 6. GET ANNOUNCEMENTS
        const [announcementsRaw] = await db.query(`
            SELECT a.*, u.first_name, u.last_name
            FROM announcements a
            JOIN users u ON a.teacher_id = u.user_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN classes c ON a.class_id = c.class_id
            WHERE (a.topic_id IS NULL AND c.class_id IN (
                        SELECT class_id FROM class_students WHERE student_id = ?
                ))
            OR (a.topic_id IS NOT NULL AND a.topic_id IN (
                        SELECT t.topic_id
                        FROM topics t
                        JOIN quarters q ON t.quarter_id = q.quarter_id
                        JOIN classes c ON q.subject_id = c.subject_id
                        JOIN class_students cs ON cs.class_id = c.class_id
                        WHERE cs.student_id = ?
                ))
            ORDER BY a.created_at DESC
            LIMIT 3
        `, [studentId, studentId]);

        // 7. GET FORUM THREADS
        const [forumsRaw] = await db.query(`
            SELECT f.*, CONCAT(u.first_name, ' ', u.last_name) AS author_name
            FROM forum_topics f
            JOIN users u ON f.teacher_id = u.user_id
            WHERE f.subject_id = ?
            ORDER BY f.created_at DESC
            LIMIT 5
        `, [subjectId]);

        // 8. STUDENT COMPLETED TASKS
        const [doneForums] = await db.query(`SELECT forum_id FROM student_forum_done WHERE student_id = ?`, [studentId]);
        const [doneAssessments] = await db.query(`SELECT DISTINCT assessment_id FROM student_scores WHERE student_id = ?`, [studentId]);

        // 8b. STUDENT MATERIAL INTERACTIONS
        const [materialInteractions] = await db.query(
            `SELECT DISTINCT material_id FROM student_material_interactions WHERE student_id = ?`,
            [studentId]
        );
        const interactedMaterialIds = new Set(materialInteractions.map(r => r.material_id));

        // 9. BUILD NESTED QUARTERS/TOPICS
        const quarters = quartersRaw.map((q, qIndex) => {
            const topics = topicsRaw
                .filter(t => t.quarter_id === q.quarter_id)
                .map((t, tIndex) => {
                    const topicLocked = t.is_locked === 1 || tIndex !== 0;

                    const materials = materialsRaw.filter(m => m.topic_id === t.topic_id).map(m => ({
                        ...m,
                        is_interacted: interactedMaterialIds.has(m.material_id)
                    }));

                    const assessments = assessmentsRaw
                    .filter(a => a.topic_id === t.topic_id)
                    .map((a, aIndex) => ({
                        ...a,
                        // Heto ang fix: Gamitin ang value mula sa DB ('a.is_unlocked'). 
                        // OR logic: Magiging unlocked kung 1 sa DB, O KUNG ito ang index 0 (at hindi locked ang topic).
                        is_unlocked: topicLocked ? 0 : (a.is_unlocked === 1 || aIndex === 0 ? 1 : 0),
                        
                        is_done: doneAssessments.some(da => da.assessment_id === a.assessment_id) ? 1 : 0
                    }));

                    const topicForums = forumsRaw
                        .filter(f => f.topic_id === t.topic_id)
                        .map(f => ({
                            ...f,
                            is_unlocked: topicLocked ? 0 : 1,
                            is_done: doneForums.some(df => df.forum_id === f.forum_id) ? 1 : 0
                        }));

                    const topicAnnouncements = announcementsRaw.filter(a => a.topic_id === t.topic_id);

                    return {
                        ...t,
                        is_locked: topicLocked,
                        materials,
                        assessments,
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
            });
        });

        const progressPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

        // 11. UPDATE student_progress
        await db.query(`
            INSERT INTO student_progress (student_id, subject_id, progress_percent, last_accessed)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
                progress_percent = VALUES(progress_percent),
                last_accessed = NOW()
        `, [studentId, subjectId, progressPercent]);

        // 12. GET LEADERBOARD
        const [leaderboard] = await db.query(`
            SELECT u.first_name, u.last_name, COALESCE(sp.progress_percent, 0) as total_exp
            FROM student_progress sp
            JOIN users u ON sp.student_id = u.user_id
            WHERE sp.subject_id = ?
            ORDER BY sp.progress_percent DESC
            LIMIT 5
        `, [subjectId]);

        // 13. RENDER
        res.render('opensubject-student', {
            user: req.user,
            subject: subjectInfo[0],
            quarters,
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
        // Score record
        // NOTE: student_scores has no created_at → use date_recorded
        // assessments has no is_multiple_answer/total_items → those come from ss.total_items & qb.is_multiple_answer
        const [[score]] = await db.query(`
            SELECT ss.*,
                   a.assessment_name, a.assessment_type, a.timer_type, a.duration_minutes
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            WHERE ss.assessment_id = ? AND ss.student_id = ?
            ORDER BY ss.date_recorded DESC LIMIT 1
        `, [assessmentId, studentId]);

        if (!score) return res.status(404).json({ error: 'No score found' });

        // Questions with student responses and remediation
        // NOTE: remediation_materials PK is rem_id (not remediation_id), FK to learning_materials is material_id
        const [questions] = await db.query(`
            SELECT
                qb.*,
                aq.sort_order,
                sr.selected_option,
                sr.is_correct,
                sr.response_time_ms,
                rm.rem_id          AS remediation_id,
                rm.link_url,
                rm.preview_json,
                rm.advice_text,
                rm.created_at      AS remediation_created_at,
                lm.title           AS material_title,
                lm.file_path_or_url AS material_path,
                lm.material_type
            FROM assessment_questions aq
            JOIN question_bank qb ON aq.question_id = qb.question_id
            LEFT JOIN student_responses sr
                ON sr.question_id = qb.question_id AND sr.score_id = ?
            LEFT JOIN remediation_materials rm ON rm.question_id = qb.question_id
            LEFT JOIN learning_materials lm ON lm.material_id = rm.material_id
            WHERE aq.assessment_id = ?
            ORDER BY aq.sort_order ASC
        `, [score.score_id, assessmentId]);

        // For Periodic_Sequence, fetch answer sequences per question
        const seqQIds = questions
            .filter(q => q.input_mode === 'Periodic_Sequence')
            .map(q => q.question_id);

        let sequences = {};
        if (seqQIds.length > 0) {
            const [seqRows] = await db.query(
                `SELECT * FROM answer_sequences WHERE question_id IN (?) ORDER BY question_id, sort_order ASC`,
                [seqQIds]
            );
            seqRows.forEach(s => {
                if (!sequences[s.question_id]) sequences[s.question_id] = [];
                sequences[s.question_id].push(s);
            });
        }

        questions.forEach(q => { q.sequences = sequences[q.question_id] || []; });

        res.json({ score, questions });
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
            SELECT q.subject_id
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE lm.material_id = ?
        `, [material_id]);

        if (subjectRow) {
            await recalculateProgress(student_id, subjectRow.subject_id);
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

    try {
        // 1. GLOBAL RANKINGS (Top Alchemists)
        const [globalTop] = await db.query(`
            SELECT first_name, last_name, profile_pic, total_exp, current_level, strand, section 
            FROM users WHERE role = 'Student' 
            ORDER BY total_exp DESC LIMIT 10
        `);

        // 2. SUBJECT-SPECIFIC (Sample: Top students in all subjects they are enrolled in)
        const [subjectRankings] = await db.query(`
            SELECT subject_name, first_name, last_name, progress_percent
            FROM (
                SELECT 
                    s.subject_name, 
                    u.first_name, 
                    u.last_name, 
                    sp.progress_percent,
                    -- Binibigyan nito ng rank (#1, #2, #3...) ang bawat student SA LOOB ng bawat subject
                    ROW_NUMBER() OVER (PARTITION BY s.subject_id ORDER BY sp.progress_percent DESC) as student_rank
                FROM student_progress sp
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN users u ON sp.student_id = u.user_id
            ) AS ranked_progress
            WHERE student_rank <= 3 -- Dito natin lilimitahan: Top 3 lang kada subject ang lalabas
            ORDER BY subject_name, progress_percent DESC;
        `);

        // 3. PVP KINGS (Most Wins in Arcade)
        const [pvpKings] = await db.query(`
            SELECT u.first_name, u.last_name, u.profile_pic, COUNT(m.winner_id) as wins
            FROM competitive_matches m
            JOIN users u ON m.winner_id = u.user_id
            GROUP BY m.winner_id
            ORDER BY wins DESC LIMIT 5
        `);

        // 4. PERSONAL RANK CARD (Logic to find current user's rank)
        const [personalRank] = await db.query(`
            SELECT rank FROM (
                SELECT user_id, RANK() OVER (ORDER BY total_exp DESC) as rank 
                FROM users WHERE role = 'Student'
            ) as ranking WHERE user_id = ?
        `, [studentId]);

        const [totalStudents] = await db.query(`SELECT COUNT(*) as count FROM users WHERE role = 'Student'`);

        // 5. WALL OF FAME (History)
        const [history] = await db.query(`
            SELECT h.*, u.first_name, u.last_name, s.subject_name 
            FROM leaderboard_history h
            JOIN users u ON h.student_id = u.user_id
            LEFT JOIN subjects s ON h.subject_id = s.subject_id
            ORDER BY h.awarded_date DESC LIMIT 10
        `);

        res.render('leaderboard-student', {
            user: req.user,
            globalTop,
            subjectRankings,
            pvpKings,
            history,
            myRank: personalRank[0] ? personalRank[0].rank : 'N/A',
            totalCount: totalStudents[0].count
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading leaderboards");
    }
});

// GET: Main Forum Page
router.get('/forums', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;
 
    try {
        // Fetch all forums for subjects the student is enrolled in.
        // DISTINCT prevents the duplication that occurs when a student is in
        // multiple classes that map to the same subject (or the same class
        // appears more than once through different join paths).
        const [forums] = await db.query(`
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
            LEFT JOIN subjects s ON ft.subject_id = s.subject_id
            LEFT JOIN topics   t ON ft.topic_id   = t.topic_id
            LEFT JOIN users    u ON ft.teacher_id  = u.user_id
 
            -- Only return forums whose subject the student is enrolled in
            WHERE EXISTS (
                SELECT 1
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id  = ?
                  AND c.subject_id   = ft.subject_id
            )
 
            ORDER BY ft.is_pinned DESC, ft.created_at DESC
        `, [studentId, studentId]);
 
        // Count how many distinct forums the student has actually replied in
        // (used for the "Discussions Joined" stat card)
        const [[{ totalParticipated }]] = await db.query(`
            SELECT COUNT(DISTINCT fr.topic_id) AS totalParticipated
            FROM forum_replies fr
            WHERE fr.user_id = ?
        `, [studentId]);
 
        res.render('forum-student', {
            user:              req.user,
            forums:            forums  ?? [],
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
 
        const userId   = req.user.user_id;
        const { forum_id, reply_text, parent_id } = req.body;
        const content  = (reply_text || '').trim();
 
        if (!forum_id || !content) {
            return res.status(400).json({ success: false, error: 'forum_id and reply_text are required.' });
        }
 
        const safeParentId = parent_id && !isNaN(parent_id) ? parseInt(parent_id, 10) : null;
        const filePath     = req.file ? req.file.filename      : null;
        const fileName     = req.file ? req.file.originalname  : null;
        const fileType     = req.file ? req.file.mimetype      : null;
 
        try {
            const [result] = await db.query(`
                INSERT INTO forum_replies
                    (topic_id, user_id, parent_reply_id, reply_content,
                     file_path, file_name, file_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `, [forum_id, userId, safeParentId, content, filePath, fileName, fileType]);
 
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
        // student_forum_done has a UNIQUE KEY on (student_id, forum_id)
        // so this is safe to call repeatedly.
        await db.query(`
            INSERT INTO student_forum_done (student_id, forum_id, done_at)
            VALUES (?, ?, NOW())
            ON DUPLICATE KEY UPDATE done_at = done_at
        `, [studentId, forum_id]);

        // ── Recalculate progress ──────────────────────────────────────────────
        // Find which subject this forum belongs to
        const [[forumRow]] = await db.query(
            `SELECT subject_id FROM forum_topics WHERE forum_id = ?`,
            [forum_id]
        );

        if (forumRow) {
            await recalculateProgress(studentId, forumRow.subject_id);
        }
        // ─────────────────────────────────────────────────────────────────────
 
        res.json({ success: true });
 
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
        await db.query(`
            INSERT INTO private_messages (sender_id, receiver_id, message_text, sent_at)
            VALUES (?, ?, ?, NOW())
        `, [senderId, parseInt(receiver_id, 10), String(message).trim()]);
 
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
            return res.status(404).send("Forum not found");
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

// GET: Unified Notifications for the Slide-over
router.get('/api/notifications', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const studentId = req.user.user_id;

    try {
        const query = `
            -- 1. NEW ANNOUNCEMENTS
            (SELECT 
                'announcement' AS type, 
                a.title AS heading, 
                a.content AS snippet, 
                a.created_at, 
                NULL AS extra_info 
            FROM announcements a
            WHERE a.class_id IN (SELECT class_id FROM class_students WHERE student_id = ?))

            UNION ALL

            -- 2. UPCOMING ASSESSMENTS (Deadlines)
            (SELECT 
                'assessment' AS type, 
                ass.assessment_name AS heading, 
                CONCAT('Due Date: ', DATE_FORMAT(ass.due_date, '%M %d, %h:%i %p')) AS snippet, 
                ass.due_date AS created_at, 
                ass.assessment_type AS extra_info
            FROM assessments ass
            JOIN topics t ON ass.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            )
            AND ass.due_date > NOW())

            UNION ALL

            -- 3. NEW LEARNING MATERIALS
            (SELECT 
                'material' AS type, 
                lm.title AS heading, 
                CONCAT('New ', lm.material_type, ' uploaded') AS snippet, 
                NOW() AS created_at, 
                s.subject_name AS extra_info
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN subjects s ON q.subject_id = s.subject_id
            WHERE s.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            ))

            UNION ALL

            -- 4. NEW FORUM TOPICS
            (SELECT 
                'forum_new' AS type, 
                ft.title AS heading, 
                'New discussion started' AS snippet, 
                ft.created_at, 
                s.subject_name AS extra_info
            FROM forum_topics ft
            JOIN subjects s ON ft.subject_id = s.subject_id
            WHERE s.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            ))

            UNION ALL

            -- 5. REPLIES ON FORUMS YOU PARTICIPATED IN
            (SELECT 
                'forum_reply' AS type, 
                'New Reply in Thread' AS heading, 
                fr.reply_content AS snippet, 
                fr.created_at, 
                u.first_name AS extra_info
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id IN (SELECT topic_id FROM forum_replies WHERE user_id = ?)
            AND fr.user_id != ?)

            UNION ALL

            -- 6. RECENT SCORES & EXP GAINED
            (SELECT 
                'score' AS type, 
                ass.assessment_name AS heading, 
                CONCAT('Score: ', ss.score_obtained, '/', ss.total_items) AS snippet, 
                ss.date_recorded AS created_at, 
                CONCAT('+', ss.exp_gained, ' EXP') AS extra_info
            FROM student_scores ss
            JOIN assessments ass ON ss.assessment_id = ass.assessment_id
            WHERE ss.student_id = ?)

            ORDER BY created_at DESC 
            LIMIT 20;
        `;

        // We have 7 placeholders (?) in the query above.
        const [notifications] = await db.query(query, [
            studentId, // 1. Announcements
            studentId, // 2. Assessments
            studentId, // 3. Materials
            studentId, // 4. Forums
            studentId, // 5. Forum Replies (thread check)
            studentId, // 5. Forum Replies (exclude self)
            studentId  // 6. Scores
        ]);

        res.json(notifications);
    } catch (err) {
        console.error("NOTIFICATION API ERROR:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

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
        const topicId      = row.topic_id;
        const totalItems   = row.total_items || 15;

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
        let distEasy      = countMap.Easy;
        let distAverage   = countMap.Average;
        let distDifficult = countMap.Difficult;

        if (fillerNeeded > 0) {
            // Distribute filler evenly; remainder goes to Easy
            const baseF      = Math.floor(fillerNeeded / 3);
            const remainderF = fillerNeeded % 3;
            distEasy      += baseF + remainderF;
            distAverage   += baseF;
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
                user_id       : row.user_id,
                first_name    : row.first_name    || '',
                last_name     : row.last_name     || '',
                profile_pic   : row.profile_pic   || 'default_avatar.png',
                qr_code_token : row.qr_code_token,
            },
            assessment: {
                assessment_name  : row.assessment_name,
                assessment_type  : row.assessment_type,
                timer_type       : row.timer_type        || 'Global',
                duration_minutes : row.duration_minutes  || 30,
                time_limit       : perItemSeconds,        // per-item seconds (PerItem only)
            },
            total : displayTotal,
            dist  : {
                easy      : distEasy,
                average   : distAverage,
                difficult : distDifficult,
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
        const topicId      = userRow.topic_id;
        const themeId      = userRow.theme_id   || 'default_lab';
        const topicName    = userRow.topic_name || '';
        const subjectId    = userRow.subject_id || null;

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
        const totalItems     = userRow.total_items || mandatoryCount;
        const fillerNeeded   = Math.max(0, totalItems - mandatoryCount);
        const mandatoryIds   = mandatoryWithSeqs.map(q => q.question_id);

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
                     a : 'A',  b : 'B',  c : 'C',  d : 'D',
                     A : 'A',  B : 'B',  C : 'C',  D : 'D',
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
                question_id            : q.question_id,
                question_text          : q.question_text         || '',
                instruction_override   : q.instruction_override  || null,
                media_path             : q.media_path            || null,
                media_type             : q.media_type            || null,
                difficulty             : q.difficulty            || 'Easy',
                input_mode             : q.input_mode            || 'Standard',
                mechanic_type          : q.mechanic_type         || 'standard_mcq',
                base_exp               : parseInt(q.base_exp,    10) || 100,
                points                 : parseInt(q.points,      10) || 1,
                time_limit             : parseInt(q.time_limit,  10) || 30,
                is_multiple_answer     : q.is_multiple_answer ? 1 : 0,
                required_answers_count : parseInt(q.required_answers_count, 10) || 1,
                option_a               : q.option_a        || null,
                option_a_image         : q.option_a_image  || null,
                option_b               : q.option_b        || null,
                option_b_image         : q.option_b_image  || null,
                option_c               : q.option_c        || null,
                option_c_image         : q.option_c_image  || null,
                option_d               : q.option_d        || null,
                option_d_image         : q.option_d_image  || null,
                correct_answer         : q.correct_answer   || null,
                numeric_answer         : q.numeric_answer   !== undefined ? q.numeric_answer : null,
                numeric_tolerance      : parseFloat(q.numeric_tolerance) || 0,
                selected_bg_key        : q.selected_bg_key || null,
                answer_sequences       : q.answer_sequences || [],
                theme_id               : q.theme_id    || 'default_lab',
                topic_name             : q.topic_name  || '',
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
                user_id       : userRow.user_id,
                first_name    : userRow.first_name,
                last_name     : userRow.last_name     || '',
                profile_pic   : userRow.profile_pic   || 'default_avatar.png',
                current_level : userRow.current_level || 1,
                total_exp     : userRow.total_exp     || 0,
            },
            assessment: {
                assessment_id    : assessmentId,
                assessment_name  : userRow.assessment_name,
                assessment_type  : userRow.assessment_type,
                timer_type       : userRow.timer_type       || 'Global',
                duration_minutes : userRow.duration_minutes || 30,
                total_items      : totalItems,
                sound_bg         : userRow.sound_bg         || '',
                sound_correct    : userRow.sound_correct     || '',
                sound_wrong      : userRow.sound_wrong       || '',
                sound_result_pass: userRow.sound_result_pass || '',
                sound_result_fail: userRow.sound_result_fail || '',
                speech_enabled   : userRow.speech_enabled    || 0,
                // ── FIX 1: subject_id must be in the assessment object so the
                //    EJS serializes it into ASSESSMENT.subject_id on line 1189.
                //    Without this, ASSESSMENT.subject_id is always undefined →
                //    submit-results receives subjectId=null → leaderboard never written.
                subject_id       : subjectId,
            },
            questions          : processedQuestions,
            totalPossibleScore,
            token,
            buttonMappings     : buttonMappings || [],
            resumeIndex        : existingSession
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
            parseInt(accumulatedScore,  10) || 0,
            parseInt(studentId,         10),
            parseInt(assessmentId,      10),
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

    const cleanUserId   = parseInt(userId,             10);
    const cleanAsmId    = parseInt(assessmentId,       10);
    const cleanSubjId   = parseInt(subjectId,          10) || null;
    const cleanScore    = parseInt(scoreObtained,      10) || 0;
    const cleanPossible = parseInt(totalPossibleScore, 10) || 0;
    const cleanTotal    = parseInt(totalItems,         10) || 0;
    const cleanExp      = parseInt(expGained,          10) || 0;

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
                parseInt(r.questionId,  10) || 0,
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

        // ── 6. Recompute current_level from level_thresholds ──────────────────
        // Re-fetch total_exp because the DB trigger already incremented it.
        const [[updatedUser]] = await connection.execute(
            `SELECT total_exp FROM users WHERE user_id = ?`,
            [cleanUserId]
        );
        const newTotalExp = updatedUser.total_exp || 0;

        const [[levelRow]] = await connection.execute(`
            SELECT level_number
            FROM level_thresholds
            WHERE min_exp_required <= ?
            ORDER BY min_exp_required DESC
            LIMIT 1
        `, [newTotalExp]);

        const newLevel = levelRow ? levelRow.level_number : 1;

        await connection.execute(`
            UPDATE users
            SET current_level         = ?,
                is_ready_for_arcade   = 0,
                flagged_assessment_id = NULL
            WHERE user_id = ?
        `, [newLevel, cleanUserId]);

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

        return res.json({
            success        : true,
            scoreId        : newScoreId,
            finalScore     : cleanScore,
            totalPossible  : cleanPossible,
            totalExpGained : cleanExp,
            newTotalExp,
            newLevel,
            // ── FIX 2: now returned so the EJS final screen can display it ──
            surpassedCount,
        });

    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
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
            const activeSockets   = req.app.get('activeSockets');
            const targetSocketId  = activeSockets ? activeSockets[targetStudentId] : null;

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
            const userId    = parseInt(playerData.userId,    10);
            const score     = parseInt(playerData.score,     10) || 0;
            const expGained = parseInt(playerData.expGained  || 0, 10);

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

            // Re-fetch to get trigger-updated total_exp
            const [[updated]] = await connection.execute(
                `SELECT total_exp FROM users WHERE user_id = ?`, [userId]
            );
            const newTotalExp = updated.total_exp || 0;

            const [[lvlRow]] = await connection.execute(`
                SELECT level_number FROM level_thresholds
                WHERE min_exp_required <= ?
                ORDER BY min_exp_required DESC LIMIT 1
            `, [newTotalExp]);
            const newLevel = lvlRow ? lvlRow.level_number : 1;

            await connection.execute(`
                UPDATE users
                SET is_ready_for_arcade = 0, flagged_assessment_id = NULL, current_level = ?
                WHERE user_id = ?
            `, [newLevel, userId]);

            return { userId, score, expGained, newLevel };
        };

        const p1Result = await savePlayer(p1, 1);
        const p2Result = await savePlayer(p2, 2);

        // ── Determine winner (null = draw) ────────────────────────────────────
        let winnerId = null;
        if      (p1Result.score > p2Result.score) winnerId = p1Result.userId;
        else if (p2Result.score > p1Result.score) winnerId = p2Result.userId;

        // ── Record competitive match ──────────────────────────────────────────
        await connection.execute(`
            INSERT INTO competitive_matches
                (p1_id, p2_id, p1_score, p2_score, winner_id, assessment_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [p1Result.userId, p2Result.userId, p1Result.score, p2Result.score, winnerId, cleanAsmId]);

        await connection.commit();

        return res.json({ success: true, winnerId, p1Result, p2Result });

    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
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