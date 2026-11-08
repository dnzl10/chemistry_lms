process.env.TZ = process.env.TZ || 'Asia/Manila';
require('dotenv').config();
const express = require('express');
const db = require('./db'); // Ito 'yung ginawa nating db.js kanina
const crypto = require('crypto'); // Built-in sa Node.js para sa tokens
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const QRCode = require('qrcode');
const fs = require('fs');


const app = express();
app.set('trust proxy', 1);

const { ensureDirectoriesExist } = require('./utils/fileSecurityHelper');
ensureDirectoriesExist([
    path.join(__dirname, 'public', 'assignment_templates'),
    path.join(__dirname, 'public', 'assignment_samples'),
    path.join(__dirname, 'material_uploads'),
    path.join(__dirname, 'material_uploads', 'audio_notes')
]);

// ---------------- PROFILE PICS UPLOAD ----------------

// 1️⃣ Setup Storage
const profileStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const profileDir = path.join(__dirname, 'profile_pics');
        if (!fs.existsSync(profileDir)) {
            console.log('Creating profile_pics folder...');
            fs.mkdirSync(profileDir, { recursive: true });
        }
        console.log('Saving profile pic to:', profileDir);
        cb(null, profileDir);
    },
    filename: function (req, file, cb) {
        const ext = (file && file.originalname) ? path.extname(file.originalname) : '.png';
        const filename = 'profile-' + Date.now() + ext;
        console.log('Profile pic filename:', filename);
        cb(null, filename);
    }
});

// 2️⃣ File type check
function checkProfileFile(req, file, cb) {
    if (!file || !file.originalname) {
        return cb(null, true);
    }
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const extname = allowedTypes.test(ext);
    const mimetype = allowedTypes.test(file.mimetype || '');
    console.log('Profile file type check:', file.originalname, mimetype, extname);

    if (mimetype || extname) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (JPG, PNG, GIF, WEBP) are allowed!'));
    }
}

// 3️⃣ Init Multer
const uploadProfile = multer({
    storage: profileStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: checkProfileFile
}).single('profilePic');

const MySQLSessionStore = require('./utils/mysqlSessionStore');
const cloudStorageEngine = require('./utils/cloudStorageEngine');

// Cloud Storage Stream & Restore Middleware (intercepts missing local uploads and streams from 15GB-45GB Drive Vault)
app.use(cloudStorageEngine.middleware());

// 4️⃣ Serve profile pics statically
app.use('/profile_uploads', express.static(path.join(__dirname, 'profile_pics')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));


// Idagdag ito sa app.js
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// (materials route moved down to after session/passport initialization)

// ================= FORUM FILE UPLOAD =================

// 1️⃣ Setup Storage
const forumStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const forumDir = path.join(__dirname, 'files');
        if (!fs.existsSync(forumDir)) {
            console.log('Creating files folder...');
            fs.mkdirSync(forumDir, { recursive: true });
        }
        console.log('Saving forum file to:', forumDir);
        cb(null, forumDir);
    },
    filename: function (req, file, cb) {
        const filename = 'file-' + Date.now() + path.extname(file.originalname);
        console.log('Forum file filename:', filename);
        cb(null, filename);
    }
});

// 2️⃣ File type check
// 1️⃣ Correct signature: req, file, cb
function checkForumFile(req, file, cb) {
    if (!file || !file.originalname) {
        // If no file uploaded, allow it
        return cb(null, true);
    }

    // Support images, audio recordings (voice notes), video clips, and documents
    const allowed = /jpeg|jpg|png|gif|webp|svg|pdf|doc|docx|ppt|pptx|xls|xlsx|txt|mp4|mov|webm|mp3|wav|ogg|m4a/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());

    console.log('Forum file type check:', file.originalname, ext);

    if (ext) cb(null, true);
    else cb(new Error("File type not allowed"));
}

// 3️⃣ Init Multer
const forumUpload = multer({
    storage: forumStorage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB for audio/video & presentations
    fileFilter: checkForumFile
}).single('file'); // must match <input name="file">

// 4️⃣ Serve forum files statically
app.use('/forum_uploads', express.static(path.join(__dirname, 'files')));
app.use('/forum_banners', express.static(path.join(__dirname, 'public', 'forum_banners')));
app.use('/material_uploads', express.static(path.join(__dirname, 'public', 'material_uploads')));
app.use('/material_uploads', express.static(path.join(__dirname, 'material_uploads')));
// Static fallback alias for legacy/material upload links
app.use('/uploads/materials', express.static(path.join(__dirname, 'public', 'material_uploads')));
app.use('/uploads/materials', express.static(path.join(__dirname, 'material_uploads')));

// ================= PUBLIC =================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/Simulations', express.static(path.join(__dirname, 'Simulations')));

// ================= EXPORT =================
// if you plan to use forumUpload in routes
module.exports = { forumUpload, uploadProfile };



// --- END OF FORUM FILE UPLOAD SETUP ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); // Para mabasa ang data mula sa forms
app.use(express.json()); // <--- Ito ang missing piece para mabasa ang JSON fetch

const sessionStore = new MySQLSessionStore(db, {
    tableName: 'user_sessions',
    ttlMs: 30 * 60 * 1000
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'elementa_fallback_session_secret_2026',
    store: sessionStore,
    resave: false,
    saveUninitialized: false, // Don't save uninitialized sessions
    cookie: {
        maxAge: 30 * 60 * 1000, // 30 mins Inactivity Timeout
        httpOnly: true, // Prevent XSS theft
        secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
        sameSite: 'lax' // CSRF protection
    }
}));

//I-configure ang Session (Temporary Memory)
//Kailangan ng server ng paraan para "matandaan" na naka-login na ang user habang lumilipat sila ng pages.
app.use(passport.initialize());
app.use(passport.session());

// Staging Environment Indicator Middleware:
// Automatically identifies when running on the Staging / Preview environment and injects a non-intrusive
// visual indicator on rendered HTML pages so testers never confuse Staging with Live Production.
app.use((req, res, next) => {
    const host = (req.hostname || req.headers.host || '').toLowerCase();
    const isStaging =
        (process.env.APP_ENV || '').toLowerCase() === 'staging' ||
        host.includes('-staging.') ||
        host.startsWith('staging.');

    res.locals.isStaging = isStaging;
    res.locals.appEnv = isStaging ? 'staging' : (process.env.APP_ENV || process.env.NODE_ENV || 'development');

    if (isStaging) {
        const origRender = res.render.bind(res);
        res.render = function (view, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            origRender(view, options, (err, html) => {
                if (typeof callback === 'function') {
                    return callback(err, html);
                }
                if (err) {
                    return req.next ? req.next(err) : res.status(500).send(err.message);
                }
                if (typeof html === 'string' && html.includes('</body>') && !html.includes('id="elementa-staging-banner"')) {
                    const bannerHtml = `
<div id="elementa-staging-banner" style="position:fixed;bottom:12px;left:12px;z-index:999999;background:linear-gradient(135deg,#b45309,#d97706);color:#fff;padding:6px 14px;border-radius:999px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.3px;box-shadow:0 4px 14px rgba(0,0,0,0.35);display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,0.25);pointer-events:auto;">
  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fde047;box-shadow:0 0 6px #fde047;"></span>
  <span>STAGING PREVIEW (${process.env.DB_NAME || 'Test DB'})</span>
  <button onclick="this.parentElement.remove()" title="Dismiss for this page" style="background:transparent;border:none;color:rgba(255,255,255,0.85);cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 4px;">&times;</button>
</div>`;
                    html = html.replace('</body>', bannerHtml + '\n</body>');
                }
                res.send(html);
            });
        };
    }
    next();
});

// Pag-save ng user info sa session
passport.serializeUser((user, done) => done(null, user.user_id));
passport.deserializeUser(async (obj, done) => {
    try {
        const id = obj.user_id || obj; // Fallback for existing old sessions
        const [users] = await db.query("SELECT * FROM users WHERE user_id = ?", [id]);
        if (users.length > 0) {
            done(null, users[0]);
        } else {
            done(null, false);
        }
    } catch (err) {
        done(err);
    }
});

// GET /setup-profile
app.get('/setup-profile', async (req, res) => {
    const { token, email } = req.query;

    try {
        const [invitations] = await db.query(
            "SELECT * FROM account_invitations WHERE email = ? AND token = ? AND is_used = 0",
            [email, token]
        );

        if (invitations.length === 0) {
            return res.send("Invalid or expired invitation link.");
        }

        res.render('setup-profile', {
            email: email,
            token: token,
            mode: 'setup'
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// POST /setup-profile
app.post('/setup-profile', async (req, res) => {
    const { email, password, confirm_password, token } = req.body;

    if (password !== confirm_password) {
        return res.status(400).send("Passwords do not match.");
    }

    try {
        // Lookup ONLY real invitations — explicitly exclude __RESET__ tokens
        const [invites] = await db.query(
            `SELECT * FROM account_invitations 
             WHERE email = ? AND token = ? AND is_used = 0
             AND role IN ('Admin', 'Teacher', 'Student')`,
            [email, token]
        );

        if (invites.length === 0) {
            return res.send("Invalid or expired invitation.");
        }

        const inv  = invites[0];
        const role = inv.role;

        // Sanity guard — should never trigger now, but kept as a safety net
        if (!role || !['Admin', 'Teacher', 'Student'].includes(role)) {
            return res.status(400).send("Invalid role on this invitation. Please contact your administrator.");
        }

        let prefill = {};
        try {
            if (inv.prefill_data) prefill = JSON.parse(inv.prefill_data);
        } catch (_) {
            console.warn("Could not parse prefill_data for:", email);
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const qrToken        = crypto.randomBytes(16).toString('hex');

        await db.query(`
            INSERT INTO users (
                email, password_hash, role, qr_code_token,
                first_name, middle_name, last_name, suffix,
                sex, birthdate,
                lrn_number, grade_level, section, strand, interests,
                faculty_id, department
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            email,
            hashedPassword,
            role,
            qrToken,
            prefill.firstName  || null,
            prefill.middleName || null,
            prefill.lastName   || null,
            prefill.suffix     || null,
            prefill.sex        || null,
            prefill.birthdate  || null,
            prefill.lrn        || null,
            prefill.gradeLevel || null,   // no hardcoded default — trust what admin set
            prefill.section    || null,
            prefill.track      || prefill.strand || (role === 'Student' ? 'Academic Track' : null),
            prefill.interests  || null,
            prefill.facultyId  || null,
            prefill.department || null,
        ]);

        // Mark invitation as used — scoped to role IN (...) to never touch __RESET__ rows
        await db.query(
            `UPDATE account_invitations SET is_used = 1 
             WHERE email = ? AND token = ? AND role IN ('Admin', 'Teacher', 'Student')`,
            [email, token]
        );

        const [rows]  = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        const newUser = rows[0];

        // ── AUTOMATIC TEACHER CLASS ASSIGNMENT UPON ACCOUNT CREATION ───────────
        if (newUser && newUser.role === 'Teacher' && prefill && (prefill.classIds || prefill.classId)) {
            try {
                const classIdsToAssign = Array.isArray(prefill.classIds)
                    ? prefill.classIds
                    : (prefill.classId ? [prefill.classId] : []);
                for (const cid of classIdsToAssign) {
                    await db.query("UPDATE classes SET teacher_id = ? WHERE class_id = ?", [newUser.user_id, cid]);
                }
            } catch (teacherAssignErr) {
                console.error('[Automatic Teacher Class Assignment Error]', teacherAssignErr);
            }
        }

        // ── AUTOMATIC CLASS & COURSE ENROLLMENT UPON ACCOUNT CREATION ───────────
        if (newUser && newUser.role === 'Student' && prefill && prefill.classId) {
            try {
                // Double safety prerequisite check
                const academicHelper = require('./utils/academicHelper');
                const [[targetCls]] = await db.query(
                    "SELECT class_id, subject_id FROM classes WHERE class_id = ?", [prefill.classId]
                );
                let canEnroll = true;
                if (targetCls) {
                    const prereqCheck = await academicHelper.checkStudentPrerequisite(db, newUser.user_id, targetCls.subject_id);
                    if (!prereqCheck.eligible) {
                        canEnroll = false;
                        console.warn(`[Setup Profile Enrollment Blocked] Student ${newUser.email} ineligible for class ${prefill.classId}: ${prereqCheck.reason}`);
                    }
                }
                const [existingCs] = await db.query(
                    "SELECT * FROM class_students WHERE class_id = ? AND student_id = ?",
                    [prefill.classId, newUser.user_id]
                );
                if (existingCs.length === 0 && canEnroll) {
                    await db.query(
                        "INSERT INTO class_students (class_id, student_id, sy_id) VALUES (?, ?, ?)",
                        [prefill.classId, newUser.user_id, prefill.syId || null]
                    );
                    await db.query(
                        "UPDATE classes SET enrolled_count = (SELECT COUNT(*) FROM class_students WHERE class_id = ?) WHERE class_id = ?",
                        [prefill.classId, prefill.classId]
                    );
                    // T-24: Notify Teacher of auto-enrolled student
                    try {
                        const notificationService = require('./services/notificationService');
                        const [[clsInfo]] = await db.query(
                            `SELECT c.teacher_id, c.class_name, s.subject_name
                             FROM classes c LEFT JOIN subjects s ON c.subject_id = s.subject_id
                             WHERE c.class_id = ?`,
                            [prefill.classId]
                        );
                        if (clsInfo && clsInfo.teacher_id) {
                            await notificationService.dispatch({
                                recipientIds: clsInfo.teacher_id,
                                actorId: newUser.user_id,
                                role: 'Teacher',
                                category: 'academic',
                                priority: 'normal',
                                eventType: 'student_enrolled',
                                title: `New Student Enrolled: ${clsInfo.class_name}`,
                                message: `${newUser.first_name} ${newUser.last_name} joined ${clsInfo.class_name} (${clsInfo.subject_name || 'Course'}).`,
                                targetUrl: `/teacher/class/${prefill.classId}?tab=students`,
                                metadata: { classId: prefill.classId, studentId: newUser.user_id }
                            });
                        }
                    } catch (eNotifErr) {
                        console.error('[Setup-Profile Teacher Enroll Notification Error]', eNotifErr.message);
                    }
                }

                if (prefill.subjectId) {
                    const [existingSp] = await db.query(
                        "SELECT * FROM student_progress WHERE student_id = ? AND subject_id = ?",
                        [newUser.user_id, prefill.subjectId]
                    );
                    if (existingSp.length === 0) {
                        await db.query(
                            "INSERT INTO student_progress (student_id, subject_id, progress_percent) VALUES (?, ?, 0)",
                            [newUser.user_id, prefill.subjectId]
                        );
                    }
                }
            } catch (autoEnrollErr) {
                console.error('[Automatic Class & Course Enrollment Error]', autoEnrollErr);
            }
        }

        // Notify Admins about new user registration
        try {
            const notificationService = require('./services/notificationService');
            const [adminRows] = await db.query("SELECT user_id FROM users WHERE role = 'Admin'");
            if (adminRows.length > 0) {
                await notificationService.dispatch({
                    recipientIds: adminRows.map(a => a.user_id),
                    actorId: newUser.user_id,
                    role: 'Admin',
                    category: 'system',
                    priority: 'normal',
                    eventType: 'user_registered',
                    title: `New User Registered: ${newUser.first_name} ${newUser.last_name}`,
                    message: `${newUser.first_name} ${newUser.last_name} (${newUser.email}) completed registration as ${newUser.role}.`,
                    targetUrl: '/admin/user_access_control'
                });
            }
        } catch (notifErr) {
            console.error('[User Registration Notification Error]', notifErr.message);
        }

        req.login(newUser, (err) => {
            if (err) {
                console.error("Login Error after registration:", err);
                return res.redirect('/login');
            }
            return res.redirect('/registration-success');
        });

    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).send("Nagkaroon ng error: " + err.message);
    }
});

// GET /registration-success - Live Onboarding & Profile Setup Stepper
app.get('/registration-success', async (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.redirect('/login');
    }

    try {
        const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [req.user.user_id]);
        const currentUser = rows.length > 0 ? rows[0] : req.user;
        let qrCodeData = null;
        if (currentUser.qr_code_token) {
            try {
                qrCodeData = await QRCode.toDataURL(currentUser.qr_code_token);
            } catch (qrErr) {
                console.warn("[QRCode Generation Warning]", qrErr.message);
            }
        }
        res.render('registration-success', {
            user: currentUser,
            email: currentUser.email,
            qrCodeData,
            errorMessage: req.query.error || null
        });
    } catch (err) {
        console.error('[GET /registration-success Error]', err);
        res.status(500).send("Error loading profile setup: " + err.message);
    }
});



// GET /reset-password
app.get('/reset-password', async (req, res) => {
    const { token, email } = req.query;

    if (!token || !email) return res.send("Invalid reset link.");

    try {
        const [rows] = await db.query(
            `SELECT * FROM account_invitations
             WHERE email = ? AND token = ? AND role = '__RESET__' AND is_used = 0
             AND expires_at > NOW()`,
            [email, token]
        );

        if (rows.length === 0) {
            return res.send("This reset link is invalid or has already expired. Please ask your administrator to send a new one.");
        }

        res.render('setup-profile', { email, token, mode: 'reset' });

    } catch (err) {
        console.error('[GET /reset-password]', err);
        res.status(500).send("Server error.");
    }
});

// POST /reset-password
app.post('/reset-password', async (req, res) => {
    const { email, token, password, confirm_password } = req.body;

    if (password !== confirm_password) {
        return res.status(400).send("Passwords do not match.");
    }

    try {
        const [rows] = await db.query(
            `SELECT * FROM account_invitations
             WHERE email = ? AND token = ? AND role = '__RESET__' AND is_used = 0
             AND expires_at > NOW()`,
            [email, token]
        );

        if (rows.length === 0) {
            return res.send("This reset link is invalid or has already expired.");
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        // Update the user's password
        await db.query(
            `UPDATE users SET password_hash = ? WHERE email = ?`,
            [hashedPassword, email]
        );

        // Mark the reset token as used
        await db.query(
            `UPDATE account_invitations SET is_used = 1
             WHERE email = ? AND token = ? AND role = '__RESET__'`,
            [email, token]
        );

        // Redirect to login with a success message
        res.redirect('/login?reset=success');

    } catch (err) {
        console.error('[POST /reset-password]', err);
        res.status(500).send("Server error: " + err.message);
    }
});

// Ang Google Strategy Logic
// Dito natin gagamitin ang Client ID at Client Secret na kinuha mo sa Google Cloud Console kanina.

// Smart callback URL resolver: prevents accidental redirect to localhost on production cloud hosts
const googleCallbackURL = (() => {
    if (process.env.NODE_ENV === 'production') {
        if (process.env.APP_URL && !process.env.APP_URL.includes('localhost')) {
            return `${process.env.APP_URL.replace(/\/+$/, '')}/auth/google/callback`;
        }
        if (process.env.GOOGLE_CALLBACK_URL && !process.env.GOOGLE_CALLBACK_URL.includes('localhost')) {
            return process.env.GOOGLE_CALLBACK_URL;
        }
        return '/auth/google/callback';
    }
    return process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback';
})();

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: googleCallbackURL,
    proxy: true
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    const googleId = profile.id;

    try {
        // I-check kung ang email ay "invited" na sa database natin
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

        if (users.length > 0) {
            // Kung invited na, i-update ang google_id nila
            await db.query("UPDATE users SET google_id = ? WHERE email = ?", [googleId, email]);
            return done(null, users[0]);
        } else {
            // Kung hindi invited, bawal silang pumasok (Admin-only invite system tayo)
            return done(null, false, { message: 'You are not invited to this system.' });
        }
    } catch (err) {
        return done(err);
    }
  }
));

// Ang Authentication Routes
// Dito natin gagawin ang "Gate" kung saan dadaan ang user pag-click ng "Sign in with Google".

// 1. Ang trigger kapag kinlik ang button
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// 2. Ang callback kapag tapos na si Google mag-verify
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-error' }),
  async (req, res, next) => {
    const user = req.user;
    if (!user) return res.redirect('/login-error');

    if (Number(user.is_suspended) === 1) {
        logActivity(req, 'LOGIN_BLOCKED', `Suspended user OAuth attempt: ${user.email}`, user.user_id, user.role).catch(()=>{});
        return req.logout((err) => {
            res.redirect('/login?error=' + encodeURIComponent('This account has been suspended by administration. Please contact the Office of Student Affairs.'));
        });
    }

    if (Number(user.is_active) === 0) {
        logActivity(req, 'LOGIN_BLOCKED', `Archived user OAuth attempt: ${user.email}`, user.user_id, user.role).catch(()=>{});
        return req.logout((err) => {
            res.redirect('/login?error=' + encodeURIComponent('Institutional Notice: This student account has been archived following graduation or school year completion. For transcript requests or record evaluations, please contact the Registrar.'));
        });
    }

    // Remote session revocation: if a previous session exists on another device, terminate it
    if (user.current_session_id && user.current_session_id !== req.sessionID) {
        if (req.sessionStore && typeof req.sessionStore.destroy === 'function') {
            req.sessionStore.destroy(user.current_session_id, () => {});
        }
    }

    req.session.createdAt = Date.now();
    await db.query("UPDATE users SET current_session_id = ? WHERE email = ?", [req.sessionID, user.email]);
    logActivity(req, 'LOGIN_SUCCESS', `User ${user.email} logged in via Google.`, user.user_id, user.role).catch(()=>{});

    const role = user.role;
    if (role === 'Teacher') {
        res.redirect('/teacher/dashboard');
    } else if (role === 'Admin') {
        res.redirect('/admin/dashboard');
    } else {
        res.redirect('/dashboard'); // Default for Students
    }
  }
);

// 1. Ipakita ang Login Page
app.get('/login', (req, res) => {
    const errorMsg = req.query.error || null;
    res.render('login', { error: errorMsg, showResetPrompt: false, showGoogleResetPrompt: false });
});

// 2. Manual Login Logic (Email & Password)
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many login attempts. Please try again later.",
    keyGenerator: (req) => {
        // Exclusively use email for tracking rate limits. 
        // We append a static string to bypass the strict IPv6 validation warning
        return req.body.email ? String(req.body.email).toLowerCase() + '_ratelimit' : 'unknown_user_ratelimit';
    }
});

const { logActivity } = require('./utils/logger');
// Dummy hash for timing attack defense (bcrypt hash of an empty string)
const dummyHash = '$2b$12$KIXeW9V339B2P/0oR5U8f.8B2M4d/eN8e9JqLp3dM2gM/R9i.1f7i';

app.post('/login', loginLimiter, async (req, res, next) => {
    const { email, password, force_login } = req.body;
    let user = null;
    let isMatch = false;

    try {
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        
        if (users.length > 0) {
            user = users[0];
            
            // STRICT Numeric Check for lifecycle & suspension
            if (Number(user.is_suspended) === 1) {
                logActivity(req, 'LOGIN_FAILED', `Suspended account attempt: ${email}`, user.user_id, user.role).catch(()=>{});
                return res.render('login', { error: 'This account has been suspended by administration. Please contact the Office of Student Affairs.', showResetPrompt: false, showGoogleResetPrompt: false });
            }

            if (Number(user.is_active) === 0) {
                logActivity(req, 'LOGIN_FAILED', `Archived account attempt: ${email}`, user.user_id, user.role).catch(()=>{});
                return res.render('login', { error: 'Institutional Notice: This student account has been archived following graduation or school year completion. For transcript requests or record evaluations, please contact the Registrar.', showResetPrompt: false, showGoogleResetPrompt: false });
            }
            // 7. Timing Attack Defense (Real comparison)
            isMatch = await bcrypt.compare(password, user.password_hash);
        } else {
            // 7. Timing Attack Defense (Dummy comparison)
            await bcrypt.compare(password, dummyHash);
        }

        if (isMatch && user) {
            // Check if the session in user.current_session_id is genuinely alive in sessionStore
            const isSessionActive = await new Promise((resolve) => {
                if (!user.current_session_id || user.current_session_id === req.sessionID || !req.sessionStore || typeof req.sessionStore.get !== 'function') {
                    return resolve(false);
                }
                req.sessionStore.get(user.current_session_id, (storeErr, sess) => {
                    if (storeErr || !sess) return resolve(false);
                    resolve(true);
                });
            });

            // If there's no genuine active session in memory, clear stale database reference
            if (!isSessionActive && user.current_session_id && user.current_session_id !== req.sessionID) {
                await db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [user.user_id]);
                user.current_session_id = null;
            }

            // Prompt only if an active session genuinely exists on another device and user hasn't confirmed force login
            if (isSessionActive && force_login !== 'yes') {
                return res.render('login', { 
                    error: null, 
                    showResetPrompt: true,
                    pendingRequestId: (() => {
                        try {
                            const sessionHandshakeService = require('./services/sessionHandshakeService');
                            const hs = sessionHandshakeService.createLoginRequest({
                                userId: user.user_id,
                                userEmail: user.email,
                                userRole: user.role,
                                newSessionId: req.sessionID,
                                ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                                userAgent: req.headers['user-agent'] || 'Unknown Device',
                                authMethod: 'password'
                            });
                            return hs.requestId;
                        } catch (e) {
                            return null;
                        }
                    })(), 
                    showGoogleResetPrompt: false,
                    prefillEmail: email, 
                    prefillPassword: password 
                });
            }

            // Remote session revocation: destroy prior session in store
            if (user.current_session_id && user.current_session_id !== req.sessionID) {
                if (req.sessionStore && typeof req.sessionStore.destroy === 'function') {
                    req.sessionStore.destroy(user.current_session_id, () => {});
                }
            }

            // 4. Session Fixation Defense
            req.session.regenerate((err) => {
                if (err) return next(err);
                
                req.login(user, async (loginErr) => {
                    if (loginErr) return next(loginErr);
                    
                    req.session.createdAt = Date.now(); // For Absolute Expiration
                    
                    // 3. Single Active Session Enforcement
                    await db.query("UPDATE users SET current_session_id = ? WHERE email = ?", [req.sessionID, email]);
                    
                    // 11. Audit Logging
                    logActivity(req, 'LOGIN_SUCCESS', `User ${user.email} logged in.`, user.user_id, user.role).catch(()=>{});
                    
                    if (user.role === 'Teacher') return res.redirect('/teacher/dashboard');
                    if (user.role === 'Admin') return res.redirect('/admin/dashboard');
                    return res.redirect('/dashboard');
                });
            });
        } else {
            // 8. Generic Error Messaging
            const actorId = user ? user.user_id : null;
            const actorRole = user ? user.role : 'Student';
            logActivity(req, 'LOGIN_FAILED', `Failed login attempt for: ${email}`, actorId, actorRole).catch(()=>{});
            res.render('login', { error: 'Invalid email or password.', showResetPrompt: false, showGoogleResetPrompt: false });
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// 2.5 Google Force Login Logic (legacy cleanup redirect)
app.post('/login/google-force', async (req, res, next) => {
    if (req.session && req.session.pendingGoogleUserId) {
        try {
            await db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [req.session.pendingGoogleUserId]);
            delete req.session.pendingGoogleUserId;
        } catch (err) {
            console.error(err);
        }
    }
    return res.redirect('/auth/google');
});

// 3. Logout Route
app.get(['/logout', '/auth/logout'], async (req, res, next) => {
    try {
        const userId = (req.user && req.user.user_id) || (req.session && req.session.passport && req.session.passport.user);
        const userEmail = req.user ? req.user.email : null;
        const userRole = req.user ? req.user.role : null;

        if (userId) {
            await db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [userId]);
            if (userEmail) {
                logActivity(req, 'LOGOUT_SUCCESS', `User ${userEmail} logged out.`, userId, userRole).catch(() => {});
            }
        }
        if (req.sessionID) {
            await db.query("UPDATE users SET current_session_id = NULL WHERE current_session_id = ?", [req.sessionID]);
        }

        req.logout((err) => {
            if (err) console.error('[Logout Error]', err);
            if (req.session) {
                req.session.destroy(() => {
                    res.clearCookie('connect.sid', { path: '/' });
                    res.redirect('/login');
                });
            } else {
                res.clearCookie('connect.sid', { path: '/' });
                res.redirect('/login');
            }
        });
    } catch (err) {
        console.error('Logout error:', err);
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/login');
    }
});

// BAGONG ROUTE: Pinagsamang Image Upload at Profile Data Update
app.post('/finalize-profile', (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.redirect('/login');
    }

    uploadProfile(req, res, async (err) => {
        if (err) {
            console.error("Upload error during profile finalize:", err);
            return res.redirect('/registration-success?error=' + encodeURIComponent("Upload error: " + (err.message || err)));
        }

        const { 
            first_name, middle_name, last_name, suffix,
            sex, birthdate,
            lrn_number, grade_level, section, strand,
            faculty_id, department,
            city_town, self_description, fname_phonetic, mname_phonetic, lname_phonetic, 
            alt_name, interests, mobile, address, pic_description, remove_avatar
        } = req.body;
        
        const userId = req.user.user_id;
        const userRole = req.user.role;

        try {
            // Check LRN uniqueness if submitted for Student
            if (userRole === 'Student' && lrn_number && lrn_number.trim()) {
                const cleanLrn = lrn_number.trim();
                const [existingLrn] = await db.query(
                    "SELECT user_id FROM users WHERE lrn_number = ? AND user_id != ?",
                    [cleanLrn, userId]
                );
                if (existingLrn.length > 0) {
                    return res.redirect('/registration-success?error=' + encodeURIComponent(`LRN "${cleanLrn}" is already in use by another student.`));
                }
            }

            // Check Faculty ID uniqueness if submitted for Staff
            if (userRole !== 'Student' && faculty_id && faculty_id.trim()) {
                const cleanFid = faculty_id.trim();
                const [existingFid] = await db.query(
                    "SELECT user_id FROM users WHERE faculty_id = ? AND user_id != ?",
                    [cleanFid, userId]
                );
                if (existingFid.length > 0) {
                    return res.redirect('/registration-success?error=' + encodeURIComponent(`Faculty ID "${cleanFid}" is already in use.`));
                }
            }

            // Determine profile pic filename
            let profilePicPath = req.user.profile_pic || 'default_avatar.png'; 
            if (req.file) {
                profilePicPath = req.file.filename; 
            } else if (remove_avatar === '1') {
                profilePicPath = 'default_avatar.png';
            }

            const sql = `UPDATE users SET 
                first_name = COALESCE(?, first_name),
                middle_name = ?,
                last_name = COALESCE(?, last_name),
                suffix = ?,
                sex = ?,
                birthdate = ?,
                lrn_number = ?,
                grade_level = ?,
                section = ?,
                strand = ?,
                faculty_id = ?,
                department = ?,
                city_town = ?,
                self_description = ?,
                first_name_phonetic = ?,
                middle_name_phonetic = ?, 
                last_name_phonetic = ?,
                alternative_name = ?,
                interests = ?, 
                mobile_number = ?,
                home_address = ?,
                pic_description = ?,
                profile_pic = ?
                WHERE user_id = ?`;

            await db.query(sql, [
                first_name && first_name.trim() ? first_name.trim() : null,
                middle_name && middle_name.trim() ? middle_name.trim() : null,
                last_name && last_name.trim() ? last_name.trim() : null,
                suffix && suffix.trim() ? suffix.trim() : null,
                sex && sex.trim() ? sex.trim() : null,
                birthdate && birthdate.trim() ? birthdate.trim() : null,
                (userRole === 'Student' && lrn_number && lrn_number.trim()) ? lrn_number.trim() : (req.user.lrn_number || null),
                (userRole === 'Student' && grade_level && grade_level.trim()) ? grade_level.trim() : (req.user.grade_level || null),
                (userRole === 'Student' && section && section.trim()) ? section.trim() : (req.user.section || null),
                (userRole === 'Student' && strand && strand.trim()) ? strand.trim() : (req.user.strand || null),
                (userRole !== 'Student' && faculty_id && faculty_id.trim()) ? faculty_id.trim() : (req.user.faculty_id || null),
                (userRole !== 'Student' && department && department.trim()) ? department.trim() : (req.user.department || null),
                city_town && city_town.trim() ? city_town.trim() : null,
                self_description && self_description.trim() ? self_description.trim() : null,
                fname_phonetic && fname_phonetic.trim() ? fname_phonetic.trim() : null,
                mname_phonetic && mname_phonetic.trim() ? mname_phonetic.trim() : null,
                lname_phonetic && lname_phonetic.trim() ? lname_phonetic.trim() : null, 
                alt_name && alt_name.trim() ? alt_name.trim() : null,
                interests && interests.trim() ? interests.trim() : null,
                mobile && mobile.trim() ? mobile.trim() : null,
                address && address.trim() ? address.trim() : null,
                pic_description && pic_description.trim() ? pic_description.trim() : null, 
                profilePicPath,
                userId
            ]);

            // Fallback auto-enrollment: ensure student is linked to class and subject
            if (userRole === 'Student' && section && section.trim()) {
                try {
                    const [alreadyInClass] = await db.query(
                        "SELECT class_id FROM class_students WHERE student_id = ?",
                        [userId]
                    );
                    if (alreadyInClass.length === 0) {
                        const [[matchClass]] = await db.query(
                            "SELECT class_id, subject_id, sy_id FROM classes WHERE class_name = ? ORDER BY class_id DESC LIMIT 1",
                            [section.trim()]
                        );
                        if (matchClass) {
                            await db.query(
                                "INSERT INTO class_students (class_id, student_id, sy_id) VALUES (?, ?, ?)",
                                [matchClass.class_id, userId, matchClass.sy_id || null]
                            );
                            await db.query(
                                "UPDATE classes SET enrolled_count = (SELECT COUNT(*) FROM class_students WHERE class_id = ?) WHERE class_id = ?",
                                [matchClass.class_id, matchClass.class_id]
                            );
                            // T-24: Notify Teacher of fallback auto-enrolled student
                            try {
                                const notificationService = require('./services/notificationService');
                                const [[clsInfo]] = await db.query(
                                    `SELECT c.teacher_id, c.class_name, s.subject_name
                                     FROM classes c LEFT JOIN subjects s ON c.subject_id = s.subject_id
                                     WHERE c.class_id = ?`,
                                    [matchClass.class_id]
                                );
                                if (clsInfo && clsInfo.teacher_id) {
                                    await notificationService.dispatch({
                                        recipientIds: clsInfo.teacher_id,
                                        actorId: userId,
                                        role: 'Teacher',
                                        category: 'academic',
                                        priority: 'normal',
                                        eventType: 'student_enrolled',
                                        title: `New Student Enrolled: ${clsInfo.class_name}`,
                                        message: `${first_name} ${last_name} joined ${clsInfo.class_name} (${clsInfo.subject_name || 'Course'}).`,
                                        targetUrl: `/teacher/class/${matchClass.class_id}?tab=students`,
                                        metadata: { classId: matchClass.class_id, studentId: userId }
                                    });
                                }
                            } catch (fNotifErr) {
                                console.error('[Finalize-Profile Teacher Enroll Notification Error]', fNotifErr.message);
                            }
                            if (matchClass.subject_id) {
                                const [existProg] = await db.query(
                                    "SELECT * FROM student_progress WHERE student_id = ? AND subject_id = ?",
                                    [userId, matchClass.subject_id]
                                );
                                if (existProg.length === 0) {
                                    await db.query(
                                        "INSERT INTO student_progress (student_id, subject_id, progress_percent) VALUES (?, ?, 0)",
                                        [userId, matchClass.subject_id]
                                    );
                                }
                            }
                        }
                    }
                } catch (enrollErr) {
                    console.error('[Finalize Profile Auto-Enrollment Fallback Error]', enrollErr);
                }
            }

            // Re-fetch updated user to synchronize passport session
            const [updatedRows] = await db.query("SELECT * FROM users WHERE user_id = ?", [userId]);
            if (updatedRows.length > 0) {
                req.login(updatedRows[0], (logErr) => {
                    if (logErr) console.error("Session re-login error:", logErr);
                    if (updatedRows[0].role === 'Teacher') {
                        return res.redirect('/teacher/dashboard');
                    } else if (updatedRows[0].role === 'Admin') {
                        return res.redirect('/admin/dashboard');
                    } else {
                        return res.redirect('/dashboard');
                    }
                });
            } else {
                return res.redirect('/dashboard');
            }
        } catch (dbErr) {
            console.error("Database error during profile finalize:", dbErr);
            return res.redirect('/registration-success?error=' + encodeURIComponent("Database error: " + dbErr.message));
        }
    });
});

// --- LOGIN & AUTHENTICATION ERROR FALLBACK ---
app.get('/login-error', (req, res) => {
    const user = (req.isAuthenticated && req.isAuthenticated()) ? req.user : null;
    res.status(403).render('404', {
        title: '403 - Access Not Authorized | Elementa LMS',
        user: user,
        role: user ? user.role : 'Guest',
        requestedPath: '/auth/google',
        errorCode: 403,
        errorBadge: 'HTTP 403 • Unregistered Account',
        errorTitle: 'Access Not Authorized',
        customMessage: 'Your Google account is not yet registered or invited to the Elementa Chemistry Arcade LMS. This system is restricted to officially enrolled students and authorized faculty at Mabini Colleges Inc. Please contact your subject instructor or the school administrator to request enrollment.',
        hideHeader: true
    });
});

// --- MATERIALS ROUTE (Needs to be after passport init) ---
const materialsRoutes = require('./routes/materials');
app.use('/material_uploads', materialsRoutes);
app.use('/uploads/materials', materialsRoutes);

// --- NOTIFICATIONS ROUTE ---
const notificationRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationRoutes);

// --- SESSION LIFECYCLE & SECURITY API ROUTES ---
const sessionRoutes = require('./routes/sessionRoutes');
app.use('/api/session', sessionRoutes);

// --- LANDING PAGE (Mabini Colleges Inc. SHS General Chemistry) ---
app.get('/', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
        if (req.user.role === 'Teacher') return res.redirect('/teacher/dashboard');
        if (req.user.role === 'Admin') return res.redirect('/admin/dashboard');
        return res.redirect('/dashboard');
    }
    res.render('landing', { user: null });
});
app.get('/landing', (req, res) => {
    res.render('landing', { user: (req.isAuthenticated && req.isAuthenticated()) ? req.user : null });
});

// --- ARCADE & STUDENT ROUTES ---
const studentRoutes = require('./routes/student');
app.use('/', studentRoutes); 

const elementaRoutes = require('./routes/elementaRoutes');
app.use('/api/elementa', express.json(), elementaRoutes);

const teacherRoutes = require('./routes/teacher');
app.use('/teacher', teacherRoutes);

const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

// --- SIMULATION ASSESSMENT QUIZ & EXP BONUS ROUTES ---
const simulationQuizRoutes = require('./routes/simulationQuizRoutes');
app.use('/api/simulation', simulationQuizRoutes.apiRouter);
app.use('/teacher/simulation-quizzes', simulationQuizRoutes.teacherRouter);
app.use('/admin/simulation-quizzes', simulationQuizRoutes.adminRouter);

// --- 404 NOT FOUND FALLBACK INTERCEPTOR ---
app.use((req, res, next) => {
    // 1. Differentiate API vs. UI navigation requests
    const isApi = Boolean(
        req.xhr ||
        req.path.startsWith('/api') ||
        req.originalUrl.includes('/api/') ||
        (req.headers.accept && req.headers.accept.includes('application/json'))
    );

    if (isApi) {
        return res.status(404).json({
            success: false,
            error: 'Endpoint not found',
            code: 'NOT_FOUND',
            path: req.originalUrl
        });
    }

    // 2. Render role-aware 404 fallback page
    const user = (req.isAuthenticated && req.isAuthenticated()) ? req.user : null;
    res.status(404).render('404', {
        title: '404 - Reagent Not Found | Elementa LMS',
        user: user,
        role: user ? user.role : 'Guest',
        requestedPath: req.originalUrl
    });
});

// --- GLOBAL 500 ERROR BOUNDARY MIDDLEWARE ---
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    console.error('🚨 [Global Error Boundary Catch]', err);

    const isApi = Boolean(
        req.xhr ||
        req.path.startsWith('/api') ||
        req.originalUrl.includes('/api/') ||
        (req.headers.accept && req.headers.accept.includes('application/json'))
    );

    if (isApi) {
        return res.status(err.status || 500).json({
            success: false,
            error: 'Internal Server Error',
            message: process.env.NODE_ENV === 'production' 
                ? 'An internal reaction failure occurred on the server.' 
                : (err.message || 'An internal reaction failure occurred on the server.'),
            code: 'SERVER_ERROR'
        });
    }

    const user = (req.isAuthenticated && req.isAuthenticated()) ? req.user : null;
    res.status(err.status || 500).render('404', {
        title: '500 - Laboratory Containment Breach | Elementa LMS',
        user: user,
        role: user ? user.role : 'Guest',
        requestedPath: req.originalUrl,
        errorCode: 500,
        errorBadge: 'HTTP 500 • Containment Breach',
        errorTitle: 'Internal Reaction Failure',
        customMessage: 'An unexpected reaction failure or system error occurred while processing this request. Our station lab engineers have logged the anomaly.'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on all interfaces at port ${PORT}`);
    // Initialize High-Capacity Cloud Storage Engine (Google Drive 15GB-45GB Vault)
    cloudStorageEngine.init().catch((err) => {
        console.warn('[CloudStorage Init Warning]', err.message);
    });
    // Only clear current_session_id for sessions that no longer exist or have expired in user_sessions
    db.query(`
        UPDATE users u
        LEFT JOIN user_sessions s ON u.current_session_id = s.session_id AND s.expires > ?
        SET u.current_session_id = NULL
        WHERE u.current_session_id IS NOT NULL AND s.session_id IS NULL
    `, [Date.now()]).then(() => {
        console.log('[Auth] Synchronized persistent MySQL session states on startup.');
    }).catch((err) => {
        console.error('[Auth] Session sync check warning on startup:', err.message);
    });
    try {
        const deadlineReminderService = require('./services/deadlineReminderService');
        deadlineReminderService.start();
    } catch (schedErr) {
        console.error('[Deadline Reminder Service Init Error]', schedErr.message);
    }
    try {
        const topicScheduleService = require('./services/topicScheduleService');
        topicScheduleService.start(5000);
    } catch (topicSchedErr) {
        console.error('[Topic Schedule Service Init Error]', topicSchedErr.message);
    }
});