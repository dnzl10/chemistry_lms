require('dotenv').config();
const express = require('express');
const http = require('http'); // 1. I-require ang http module
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

const server = http.createServer(app);
const io = require('socket.io')(server);

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
        const filename = 'profile-' + Date.now() + path.extname(file.originalname);
        console.log('Profile pic filename:', filename);
        cb(null, filename);
    }
});

// 2️⃣ File type check
function checkProfileFile(file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    console.log('Profile file type check:', file.originalname, mimetype, extname);

    if (mimetype && extname) cb(null, true);
    else cb(new Error('Error: Images Only!'));
}

// 3️⃣ Init Multer
const uploadProfile = multer({
    storage: profileStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: checkProfileFile
}).single('profilePic');

// 4️⃣ Serve profile pics statically
app.use('/profile_uploads', express.static(path.join(__dirname, 'profile_pics')));


// 1. I-set ang socketio instance para ma-access ng routers
app.set('socketio', io);

// In app.js / server.js, store sockets by studentId:
const activeSockets = {};
io.on('connection', (socket) => {
    socket.on('register-player', (studentId) => {
        activeSockets[studentId] = socket.id;
        console.log(`[Socket] Student ${studentId} registered → ${socket.id}`);
    });
    socket.on('disconnect', () => {
        for (const id in activeSockets) {
            if (activeSockets[id] === socket.id) delete activeSockets[id];
        }
    });
});
app.set('activeSockets', activeSockets); // make available to routers

// Idagdag ito sa app.js
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Ito ang magsasabi sa Express na payagan ang access sa folder na ito
app.use('/material_uploads', express.static(path.join(__dirname, 'material_uploads')));

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

    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|ppt|pptx|mp4|mov/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());

    console.log('Forum file type check:', file.originalname, ext);

    if (ext) cb(null, true);
    else cb(new Error("File type not allowed"));
}

// 3️⃣ Init Multer
const forumUpload = multer({
    storage: forumStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: checkForumFile
}).single('file'); // must match <input name="file">

// 4️⃣ Serve forum files statically
app.use('/forum_uploads', express.static(path.join(__dirname, 'files')));

// ================= PUBLIC =================
app.use(express.static(path.join(__dirname, 'public')));

// ================= EXPORT =================
// if you plan to use forumUpload in routes
module.exports = { forumUpload, uploadProfile };



// --- END OF FORUM FILE UPLOAD SETUP ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); // Para mabasa ang data mula sa forms
app.use(express.json()); // <--- Ito ang missing piece para mabasa ang JSON fetch

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
}));

//I-configure ang Session (Temporary Memory)
//Kailangan ng server ng paraan para "matandaan" na naka-login na ang user habang lumilipat sila ng pages.
app.use(passport.initialize());
app.use(passport.session());

// Pag-save ng user info sa session
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));


// Route para ipakita ang Invite Form
app.get('/admin-invite', (req, res) => {
    res.render('admin-invite');
});

// --- ARCADE & STUDENT ROUTES ---
// Siguraduhin na ang file path ay tama (./routes/student.js)
const studentRoutes = require('./routes/student');
app.use('/', studentRoutes); // Siguraduhin na tama ang path papunta sa db.js

// Sa app.js, ilagay ito sa tabi ng studentRoutes
const teacherRoutes = require('./routes/teacher');
app.use('/teacher', teacherRoutes);

// Sa app.js, ilagay ito sa tabi ng studentRoutes
const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

// --- UPDATED ADMIN INVITE ROUTE ---
app.post('/admin/invite', async (req, res) => {
    const { 
        role, first_name, middle_name, last_name, suffix, 
        id_number, affiliation, sex, birthdate, email 
    } = req.body;

    const crypto = require('crypto');
    const qrToken = crypto.randomBytes(16).toString('hex');
    const inviteToken = crypto.randomBytes(32).toString('hex'); 

    try {
        // 1. Dynamic Logic for ID and Affiliation
        const lrn = (role === 'Student') ? id_number : null;
        const faculty_id = (role === 'Teacher' || role === 'Admin') ? id_number : null;
        
        // Handle Section vs Department logic
        // If Student, 'affiliation' is the Section. If Teacher, it's the Department.
        const section = (role === 'Student') ? affiliation : null;
        const strand = (role === 'Teacher') ? affiliation : 'Academic Track'; // Using 'strand' or adding a 'department' column

        // 2. I-save sa Database
        // Note: I added 'strand' here to store the Teacher's Department for now, 
        // unless you add a specific 'department' column to your users table.
        const sql = `INSERT INTO users 
            (role, first_name, middle_name, last_name, suffix, lrn_number, faculty_id, section, strand, sex, birthdate, email, qr_code_token, is_ready_for_arcade) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        await db.query(sql, [
            role, first_name, middle_name, last_name, suffix, 
            lrn, faculty_id, section, strand, sex, birthdate, email, qrToken, false
        ]);

        // 3. Setup Nodemailer (Transporter remains the same as your original code)
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const inviteLink = `http://localhost:3000/setup-profile?token=${inviteToken}&email=${email}`;
        const displayName = `${first_name} ${last_name}`;

        // 4. Email Content (Personalized based on Role)
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: `Invitation to Join Chemistry Arcade as a ${role}`,
            html: `
                <div style="font-family: sans-serif; border: 1px solid #eee; padding: 25px; border-radius: 15px; max-width: 500px; margin: auto;">
                    <h2 style="color: #2563eb; text-align: center;">Chemistry Arcade LMS</h2>
                    <p>Hello <b>${displayName}</b>,</p>
                    <p>You have been officially invited to join our platform as a <b>${role}</b>.</p>
                    <div style="background: #f8fafc; padding: 15px; border-radius: 10px; margin: 15px 0;">
                        <p style="margin: 5px 0;"><b>ID Number:</b> ${id_number}</p>
                        <p style="margin: 5px 0;"><b>Affiliation:</b> ${affiliation}</p>
                    </div>
                    <p>Click the button below to secure your account and set your password:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${inviteLink}" style="background: #2563eb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Complete Registration</a>
                    </div>
                    <p style="font-size: 11px; color: #94a3b8; text-align: center;">This link will take you to our secure profile setup page.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.send(`<h1>Success!</h1><p>Invitation sent to ${email}.</p><a href="/admin-invite">Invite another one</a>`);

    } catch (err) {
        console.error("FULL ERROR DETAILS:", err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send("Error: This Email or ID number is already registered.");
        }
        res.status(500).send("Invitation Failed: " + err.message);
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

        const hashedPassword = await bcrypt.hash(password, 10);
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
            prefill.strand     || null,   // no hardcoded default — trust what admin set
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

        req.login(newUser, async (err) => {
            if (err) return res.redirect('/login');
            try {
                const qrCodeData = await QRCode.toDataURL(newUser.qr_code_token);
                res.render('registration-success', { user: newUser, email, qrCodeData });
            } catch {
                res.render('registration-success', { user: newUser, email, qrCodeData: null });
            }
        });

    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).send("Nagkaroon ng error: " + err.message);
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

        const hashedPassword = await bcrypt.hash(password, 10);

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

//Ang Google Strategy Logic
//Dito natin gagamitin ang Client ID at Client Secret na kinuha mo sa Google Cloud Console kanina.

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
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
  (req, res) => {
    // Kinukuha natin ang role mula sa user object na galing sa DB
    const role = req.user.role;

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
    res.render('login', { error: null });
});

// 2. Manual Login Logic (Email & Password)
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

        if (users.length > 0) {
            const user = users[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);

            if (isMatch) {
                req.login(user, (err) => {
                    if (err) return next(err);
                    
                    // ROLE-BASED REDIRECT DITO:
                    if (user.role === 'Teacher') {
                        return res.redirect('/teacher/dashboard');
                    } else if (user.role === 'Admin') {
                        return res.redirect('/admin/dashboard');
                    } else {
                        return res.redirect('/dashboard');
                    }
                });
            } else {
                res.render('login', { error: 'Maling password.' });
            }
        } else {
            res.render('login', { error: 'Hindi nahanap ang email.' });
        }
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

// 3. Logout Route
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/login');
    });
});

//
// BAGONG ROUTE: Pinagsamang Image Upload at Profile Data Update
app.post('/finalize-profile', (req, res) => {
    uploadProfile(req, res, async (err) => {
        if (err) return res.status(400).send("Upload error: " + err);

        const { 
            city_town, self_description, fname_phonetic, mname_phonetic, lname_phonetic, 
            alt_name, interests, mobile, address, pic_description 
        } = req.body;
        
        const userEmail = req.user.email;

        try {
            // Kunin ang filename kung may in-upload, kung wala ay panatilihin ang dati
            let profilePicPath = req.user.profile_pic; 
            if (req.file) {
                profilePicPath = req.file.filename; 
            }

            const sql = `UPDATE users SET 
                city_town = ?, self_description = ?, first_name_phonetic = ?, middle_name_phonetic = ?, 
                last_name_phonetic = ?, alternative_name = ?, interests = ?, 
                mobile_number = ?, home_address = ?, pic_description = ?, profile_pic = ?
                WHERE email = ?`;

            await db.query(sql, [
                city_town, self_description, fname_phonetic, mname_phonetic, lname_phonetic, 
                alt_name, interests, mobile, address, pic_description, 
                profilePicPath, userEmail
            ]);

            if (req.user.role === 'Teacher') {
                res.redirect('/teacher/dashboard');
            } else {
                res.redirect('/dashboard');
            }
        } catch (dbErr) {
            console.error(dbErr);
            res.status(500).send("Database error.");
        }
    });
});

app.get('/login-error', (req, res) => res.send("Hindi ka invited o may mali sa login mo."));

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on all interfaces at port ${PORT}`);
});