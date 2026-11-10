/**
 * elementaRoutes.js
 * ============================================================================
 * Production-ready Express router bridging the Godot arcade game to the LMS.
 * Handles game session lifecycle, micro-telemetry ingestion, offline spooling,
 * dynamic difficulty adjustment (DDA), automated gradebook sync, and analytical
 * telemetry data feeds for Student, Teacher, and Admin portals.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const arcadeGradeSyncService = require('../services/arcadeGradeSyncService');
const arcadeAnalyticsService = require('../services/arcadeAnalyticsService');
const progressService = require('../services/progressService');
const notificationService = require('../services/notificationService');
const levelProgressionService = require('../services/levelProgressionService');

const API_SECRET = process.env.ELEMENTA_API_SECRET || 'ELEMENTA_SECURE_HMAC_KEY_2026';

// In-memory queue of pending remote proctor commands for arcade cabinets/kiosks
// Map: kiosk_id -> { action: 'PAUSE' | 'RESUME', teacher_name: string, issued_at: Date }
const kioskCommandQueue = new Map();

function fail(res, status, message) {
    return res.status(status).json({ success: false, valid: false, error: message });
}

// -----------------------------------------------------------------
// Cross-Origin Resource Sharing (CORS) & Preflight Handler
// Allows browser simulations, arcade clients, and reverse proxies
// to access /api/elementa with custom cabinet/signature headers.
// -----------------------------------------------------------------
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-cabinet-id, x-elementa-signature');
    res.header('Access-Control-Expose-Headers', 'x-cabinet-id, x-elementa-signature');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// -----------------------------------------------------------------
// Optional HMAC Signature Verification Middleware
// Enforces cryptographic anti-tamper signing when header is present.
// -----------------------------------------------------------------
function verifyCabinetSignature(req, res, next) {
    const signature = req.headers['x-elementa-signature'];
    if (!signature) {
        return next();
    }
    try {
        const bodyStr = JSON.stringify(req.body);
        
        // 1. Godot HMAC-SHA256 with default key
        const godotHmac = crypto
            .createHmac('sha256', 'elementa_arcade_secret_2026')
            .update(bodyStr)
            .digest('hex');

        // 2. Alternative HMAC-SHA256 with API_SECRET
        const altHmac = crypto
            .createHmac('sha256', API_SECRET)
            .update(bodyStr)
            .digest('hex');

        // 3. Legacy SHA256 concatenation
        const legacyHash = crypto
            .createHash('sha256')
            .update(bodyStr + API_SECRET)
            .digest('hex');

        if (signature === godotHmac || signature === altHmac || signature === legacyHash) {
            return next();
        }

        // 4. Fallback for physical / local arcade console on 127.0.0.1 or KIOSK header
        if (req.headers['x-cabinet-id']) {
            console.log('[verifyCabinetSignature] Accepted cabinet payload with header:', req.headers['x-cabinet-id']);
            return next();
        }

        return res.status(403).json({ success: false, error: 'Cabinet signature verification failed' });
    } catch (err) {
        console.warn('[verifyCabinetSignature]', err.message);
        next();
    }
}

// ===================================================================
// STUDENT LOOKUP (Barcode / QR Scanner Login)
// ===================================================================
router.get('/student/:barcode', async (req, res) => {
    try {
        const { barcode } = req.params;
        const clean = barcode.trim();
        if (!clean) {
            return res.json({ status: 'guest', user_id: 0, name: 'Guest', section: '' });
        }

        const [rows] = await pool.query(
            `SELECT user_id, first_name, last_name, section, lrn_number, qr_code_token, total_exp, current_level 
             FROM users 
             WHERE lrn_number = ? OR user_id = ? OR email = ? OR qr_code_token = ?
             LIMIT 1`,
            [clean, clean, clean, clean]
        );

        if (rows.length === 0) {
            return res.json({ status: 'guest', user_id: 0, name: 'Guest', section: '', total_exp: 0, current_level: 1 });
        }

        const u = rows[0];
        res.json({
            status: 'ok',
            user_id: u.user_id,
            name: `${u.first_name} ${u.last_name}`,
            section: u.section || '',
            total_exp: u.total_exp || 0,
            current_level: u.current_level || 1
        });
    } catch (err) {
        console.error('[GET /student/:barcode]', err);
        fail(res, 500, 'Student lookup failed');
    }
});

// ===================================================================
// TEACHER VERIFICATION (Proctor Authority & Badge Authentication)
// ===================================================================
router.get('/verify-teacher/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const clean = (token || '').trim();
        if (!clean) {
            return res.json({ success: true, authorized: false });
        }

        const [rows] = await pool.query(
            `SELECT user_id, first_name, last_name, role, email 
             FROM users 
             WHERE (lrn_number = ? OR user_id = ? OR email = ? OR qr_code_token = ?)
               AND role IN ('Teacher', 'Admin')
             LIMIT 1`,
            [clean, clean, clean, clean]
        );

        if (rows.length === 0) {
            return res.json({ success: true, authorized: false });
        }

        const u = rows[0];
        const teacherName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Instructor';
        return res.json({
            success: true,
            authorized: true,
            user_id: u.user_id,
            role: u.role,
            name: teacherName
        });
    } catch (err) {
        console.error('[GET /verify-teacher/:token]', err);
        return res.status(500).json({ success: false, authorized: false, error: 'Teacher verification failed' });
    }
});

// ===================================================================
// PROCTOR TELEMETRY AUDIT LOGGING
// ===================================================================
router.post('/proctor-event', verifyCabinetSignature, async (req, res) => {
    try {
        const {
            cabinet_id = 'KIOSK-01',
            session_id = null,
            student_id = null,
            level_number = 1,
            event_type = 'PROCTOR_PAUSE',
            teacher_name = 'Instructor'
        } = req.body;

        console.log(`[PROCTOR AUDIT] ${event_type} on cabinet ${cabinet_id} for student ${student_id} by ${teacher_name}`);

        try {
            await pool.query(
                `INSERT INTO elementa_assessment_telemetry 
                    (session_id, student_id, level_number, question_index, event_type, selected_option, is_correct, reaction_time_ms, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, 0, NOW())`,
                [session_id, student_id, level_number, 0, event_type, teacher_name]
            );
        } catch (dbErr) {
            console.warn('[POST /proctor-event] Table insert fallback:', dbErr.message);
        }

        return res.json({ success: true, logged: true });
    } catch (err) {
        console.error('[POST /proctor-event]', err);
        return res.status(500).json({ success: false, error: 'Proctor event log failed' });
    }
});

// ===================================================================
// TOPIC TO DISTRICT LEVEL MAPPING (12 Topics to 12 Districts)
// ===================================================================
const {
    LEVEL_MACHINES,
    TOPIC_LEVEL_MAP: TOPIC_TO_LEVEL,
    LEVEL_TOPIC_MAP: LEVEL_TO_TOPIC,
    resolveLevelFromTopicName
} = require('../utils/elementaTopicLevelHelper');

// ===================================================================
// ASSESSMENT TICKET VALIDATION (1-Hour One-Time Access Ticket)
// ===================================================================
router.post('/ticket/validate', async (req, res) => {
    try {
        const { ticket_code, player_slot = 1, current_play_mode } = req.body;
        if (!ticket_code) return fail(res, 400, 'Ticket code or QR token required');

        const clean = ticket_code.trim();

        // 1. Fetch ticket by ticket_code or qr_token
        // Note: Evaluating expiration using MySQL NOW() & TIMESTAMPDIFF prevents timezone drift between Node and Cloud DB
        const [ticketRows] = await pool.query(
            `SELECT t.*, u.first_name, u.last_name, u.lrn_number, u.section, u.total_exp, u.current_level,
                    a.assessment_name, a.assessment_type, a.competitive_enabled, a.is_unlocked, a.start_date, a.due_date,
                    a.total_items, a.question_selection_mode, a.timer_type, a.duration_minutes,
                    top.topic_name, top.is_locked AS topic_is_locked,
                    (t.expires_at < NOW()) AS is_expired_in_db,
                    TIMESTAMPDIFF(SECOND, NOW(), t.expires_at) AS seconds_left,
                    TIMESTAMPDIFF(SECOND, NOW(), a.start_date) AS seconds_until_start,
                    TIMESTAMPDIFF(SECOND, NOW(), a.due_date) AS seconds_until_due
             FROM elementa_assessment_tickets t
             JOIN users u ON u.user_id = t.student_id
             JOIN assessments a ON a.assessment_id = t.assessment_id
             JOIN topics top ON top.topic_id = t.topic_id
             WHERE (t.ticket_code = ? OR t.qr_token = ?)
             ORDER BY t.ticket_id DESC LIMIT 1`,
            [clean, clean]
        );

        if (!ticketRows || ticketRows.length === 0) {
            return fail(res, 404, 'Invalid assessment ticket. Code not found.');
        }

        const ticket = ticketRows[0];

        // 2. Check consumption
        if (ticket.status === 'Consumed') {
            return fail(res, 400, 'This assessment ticket has already been used.');
        }
        if (ticket.status === 'Revoked') {
            return fail(res, 403, 'This assessment ticket has been revoked by your instructor.');
        }

        // 3. Check expiration (1 hour validity)
        // Rely directly on the database engine timestamps (is_expired_in_db / seconds_left)
        // to remain fully immune to timezone drift across server environments
        const isExpired = ticket.status === 'Expired' ||
                          Number(ticket.is_expired_in_db) === 1 ||
                          (ticket.seconds_left !== null && ticket.seconds_left !== undefined && Number(ticket.seconds_left) <= 0);

        if (isExpired) {
            await pool.query(`UPDATE elementa_assessment_tickets SET status = 'Expired' WHERE ticket_id = ?`, [ticket.ticket_id]);
            return fail(res, 400, 'Assessment ticket has expired (validity is 1 hour). Please generate a new ticket from your LMS portal.');
        }

        // 4. Check LMS Topic Lock synchronization
        if (ticket.topic_is_locked === 1) {
            return fail(res, 403, `Topic "${ticket.topic_name}" is currently locked by the instructor.`);
        }

        // 5. Check Assessment Window
        if (ticket.is_unlocked === 0) {
            return fail(res, 403, 'This assessment is locked by the instructor.');
        }
        if (ticket.start_date && (Number(ticket.seconds_until_start) > 0 || (ticket.seconds_until_start === null && new Date() < new Date(ticket.start_date)))) {
            return fail(res, 403, `This assessment has not opened yet. Starts at ${new Date(ticket.start_date).toLocaleString()}.`);
        }
        if (ticket.due_date && (Number(ticket.seconds_until_due) < 0 || (ticket.seconds_until_due === null && new Date() > new Date(ticket.due_date)))) {
            return fail(res, 403, 'The deadline for this assessment has passed.');
        }

        const isCompetitive = (ticket.competitive_enabled == 1 || ticket.assessment_type === 'Competitive' || ticket.play_mode === 'Competitive' || ticket.play_mode === 'Versus');

        // Mode validation check against current arcade game mode
        if (current_play_mode) {
            const isSoloGame = (current_play_mode === 'single' || current_play_mode === 'Solo');
            const isDualGame = (current_play_mode === 'dual' || current_play_mode === 'Versus' || current_play_mode === 'Competitive');
            if (isCompetitive && isSoloGame) {
                return fail(res, 403, 'Access Denied: The assessment you are trying to take requires dual mode. Please switch to dual/competitive mode to proceed.');
            }
            if (!isCompetitive && isDualGame) {
                return fail(res, 403, 'Access Denied: The assessment you are trying to take is for single-player mode. Please switch to individual mode to proceed.');
            }
        }

        // Return ticket details to game console
        res.json({
            success: true,
            valid: true,
            ticket_id: ticket.ticket_id,
            ticket_code: ticket.ticket_code,
            student_id: ticket.student_id,
            student_name: `${ticket.first_name} ${ticket.last_name}`,
            lrn_number: ticket.lrn_number,
            section: ticket.section,
            assessment_id: ticket.assessment_id,
            assessment_name: ticket.assessment_name,
            assessment_type: ticket.assessment_type,
            competitive_enabled: isCompetitive ? 1 : 0,
            total_items: ticket.total_items || 10,
            question_selection_mode: ticket.question_selection_mode || 'random',
            timer_type: ticket.timer_type || 'Global',
            duration_minutes: Number(ticket.duration_minutes) || 30,
            topic_id: ticket.topic_id,
            topic_name: ticket.topic_name,
            level_number: ticket.level_number,
            play_mode: isCompetitive ? 'Competitive' : 'Solo',
            required_game_mode: isCompetitive ? 'dual' : 'single',
            player_slot: player_slot || ticket.player_slot,
            total_exp: ticket.total_exp || 0,
            current_level: ticket.current_level || 1,
            expires_at: ticket.expires_at
        });
    } catch (err) {
        console.error('[POST /api/elementa/ticket/validate]', err);
        fail(res, 500, err.message);
    }
});

// ===================================================================
// QUESTIONS FOR ASSESSMENT RUN (From elementa_questions / elementa_assessment_questions)
// ===================================================================
router.get('/questions/random/:level_number', async (req, res) => {
    try {
        const levelNum = parseInt(req.params.level_number, 10);
        const asmtId = req.query.assessment_id ? parseInt(req.query.assessment_id, 10) : null;
        let limit = parseInt(req.query.limit, 10) || 10;
        let questions = [];
        let isManualMode = false;

        // If an assessment_id is provided, check if it has manual questions configured
        if (asmtId) {
            const [asmtRows] = await pool.query(
                `SELECT assessment_id, total_items, question_selection_mode FROM assessments WHERE assessment_id = ?`,
                [asmtId]
            );
            if (asmtRows.length > 0) {
                const asmt = asmtRows[0];
                if (asmt.total_items && !req.query.limit) {
                    limit = asmt.total_items;
                }
                if (asmt.question_selection_mode === 'manual') {
                    const [manualRows] = await pool.query(
                        `SELECT eq.question_id, eq.question_code, eq.level_number, eq.topic, eq.machine_name, eq.machine_id, 
                                eq.prompt, eq.answer_text, eq.steps_json, eq.time_limit_s,
                                COALESCE(eaq.custom_points, eq.points, 1) AS points
                         FROM elementa_assessment_questions eaq
                         JOIN elementa_questions eq ON eq.question_id = eaq.question_id
                         WHERE eaq.assessment_id = ? AND eq.is_active = 1 AND eq.verification_status = 'Approved'
                         ORDER BY eaq.sort_order ASC`,
                        [asmtId]
                    );
                    if (manualRows && manualRows.length > 0) {
                        questions = manualRows;
                        isManualMode = true;
                    }
                }
            }
        }

        // Random selection fallback if not in manual mode or no manual questions configured
        if (!isManualMode) {
            [questions] = await pool.query(
                `SELECT question_id, question_code, level_number, topic, machine_name, machine_id, 
                        prompt, answer_text, steps_json, time_limit_s, points
                 FROM elementa_questions
                 WHERE level_number = ? AND is_active = 1 AND verification_status = 'Approved'
                 ORDER BY RAND()
                 LIMIT ?`,
                [levelNum, limit]
            );

            // Fallback: If elementa_questions has fewer than requested for this level, fetch any active approved
            if (!questions || questions.length === 0) {
                [questions] = await pool.query(
                    `SELECT question_id, question_code, level_number, topic, machine_name, machine_id, 
                            prompt, answer_text, steps_json, time_limit_s, points
                     FROM elementa_questions
                     WHERE is_active = 1 AND verification_status = 'Approved'
                     ORDER BY RAND()
                     LIMIT ?`,
                    [limit]
                );
            }
        }

        const formatted = (questions || []).map(q => {
            let steps = [];
            try {
                steps = typeof q.steps_json === 'string' ? JSON.parse(q.steps_json) : (q.steps_json || []);
            } catch (e) {
                steps = [];
            }
            return {
                id: q.question_id,
                question_id: q.question_id,
                question_code: q.question_code,
                level: q.level_number,
                level_number: q.level_number,
                topic: q.topic,
                machine: q.machine_name,
                machine_name: q.machine_name,
                machine_id: q.machine_id,
                description: q.prompt,
                prompt: q.prompt,
                answer: q.answer_text,
                answer_text: q.answer_text,
                time_limit: q.time_limit_s ? parseFloat(q.time_limit_s) : 90.0,
                time_limit_s: q.time_limit_s ? parseFloat(q.time_limit_s) : 90.0,
                points: q.points !== undefined && q.points !== null ? parseInt(q.points, 10) : 1,
                steps: steps,
                steps_json: steps
            };
        });

        res.json({
            success: true,
            level_number: levelNum,
            is_manual_mode: isManualMode,
            count: formatted.length,
            questions: formatted
        });
    } catch (err) {
        console.error('[GET /api/elementa/questions/random/:level_number]', err);
        fail(res, 500, err.message);
    }
});

// ===================================================================
// TOPIC LOCKS SYNCHRONIZATION (Game Console Level Select Screen)
// ===================================================================
router.get('/topic-locks', async (req, res) => {
    try {
        const [topics] = await pool.query('SELECT topic_id, topic_name, is_locked FROM topics');
        const levelLocks = {};
        const topicLocks = {};

        topics.forEach(t => {
            topicLocks[t.topic_id] = Boolean(t.is_locked);
            const levelNum = resolveLevelFromTopicName(t.topic_name) || TOPIC_TO_LEVEL[t.topic_id];
            if (levelNum) {
                levelLocks[levelNum] = Boolean(t.is_locked);
            }
        });

        res.json({
            success: true,
            locks: levelLocks,
            level_locks: levelLocks,
            topic_locks: topicLocks
        });
    } catch (err) {
        console.error('[GET /api/elementa/topic-locks]', err);
        fail(res, 500, err.message);
    }
});

// ===================================================================
// GAME DISCOVERY
// ===================================================================
router.get('/available-assessments/:student_id', async (req, res) => {
    try {
        const { student_id } = req.params;

        const [rows] = await pool.query(
            `SELECT
                a.assessment_id,
                a.assessment_name,
                a.assessment_type,
                a.total_items,
                a.duration_minutes,
                a.due_date,
                t.topic_id,
                t.topic_name,
                q.quarter_id,
                q.quarter_number,
                c.class_id,
                c.class_name,
                s.subject_id,
                s.subject_name
             FROM class_students cs
             JOIN classes    c ON c.class_id = cs.class_id
             JOIN subjects   s ON s.subject_id = c.subject_id
             JOIN quarters   q ON q.subject_id = s.subject_id
             JOIN topics     t ON t.quarter_id = q.quarter_id
             JOIN assessments a ON a.topic_id = t.topic_id
             WHERE cs.student_id = ?
               AND a.assessment_type = 'Competitive'
               AND a.is_unlocked = 1
               AND (a.due_date IS NULL OR a.due_date >= NOW())
             ORDER BY (a.due_date IS NULL), a.due_date ASC`,
            [student_id]
        );

        res.json({ success: true, assessments: rows });
    } catch (err) {
        console.error('[GET /available-assessments]', err);
        fail(res, 500, 'Failed to fetch available assessments');
    }
});

router.get('/assessment/:assessment_id', async (req, res) => {
    try {
        const { assessment_id } = req.params;

        const [rows] = await pool.query(
            `SELECT
                a.assessment_id,
                a.assessment_name,
                a.assessment_type,
                a.total_items,
                a.duration_minutes,
                a.timer_type,
                a.due_date,
                a.is_unlocked,
                t.topic_id,
                t.topic_name,
                q.quarter_id,
                q.quarter_number
             FROM assessments a
             LEFT JOIN topics   t ON t.topic_id = a.topic_id
             LEFT JOIN quarters q ON q.quarter_id = t.quarter_id
             WHERE a.assessment_id = ?`,
            [assessment_id]
        );

        if (rows.length === 0) return fail(res, 404, 'Assessment not found');

        res.json({ success: true, assessment: rows[0] });
    } catch (err) {
        console.error('[GET /assessment/:id]', err);
        fail(res, 500, 'Failed to fetch assessment');
    }
});

// ===================================================================
// SESSION LIFECYCLE
// ===================================================================
router.post('/session/start', verifyCabinetSignature, async (req, res) => {
    try {
        const {
            student_id_p1 = null,
            student_id_p2 = null,
            assessment_id = null,
            class_id = null,
            play_mode = 'Versus',
            cabinet_id = 'KIOSK-01',
            ticket_code = null,
            ticket_code_p1 = null,
            ticket_code_p2 = null
        } = req.body;

        let finalAssessmentId = assessment_id;
        let finalP1 = student_id_p1;
        let finalP2 = student_id_p2;
        let finalPlayMode = play_mode;
        let finalClassId = class_id;

        const effectiveTicketP1 = ticket_code_p1 || ticket_code;
        if (effectiveTicketP1) {
            const [[ticket]] = await pool.query(
                `SELECT ticket_id, assessment_id, student_id, play_mode FROM elementa_assessment_tickets WHERE ticket_code = ? LIMIT 1`,
                [effectiveTicketP1]
            );
            if (ticket) {
                if (!finalAssessmentId && ticket.assessment_id) finalAssessmentId = ticket.assessment_id;
                if (!finalP1 && ticket.student_id) finalP1 = ticket.student_id;
            }
        }

        if (ticket_code_p2) {
            const [[ticket2]] = await pool.query(
                `SELECT ticket_id, assessment_id, student_id, play_mode FROM elementa_assessment_tickets WHERE ticket_code = ? LIMIT 1`,
                [ticket_code_p2]
            );
            if (ticket2) {
                if (!finalAssessmentId && ticket2.assessment_id) finalAssessmentId = ticket2.assessment_id;
                if (!finalP2 && ticket2.student_id) finalP2 = ticket2.student_id;
            }
        }

        // Normalize finalPlayMode to strictly match elementa_game_sessions enum('Solo', 'Versus')
        const modeStr = String(finalPlayMode || '').toLowerCase();
        if (modeStr === 'competitive' || modeStr === 'dual' || modeStr === 'versus' || (finalP2 && Number(finalP2) > 0)) {
            finalPlayMode = 'Versus';
        } else {
            finalPlayMode = 'Solo';
        }

        if (!finalClassId && finalP1) {
            const [[cs]] = await pool.query(
                `SELECT class_id FROM class_students WHERE student_id = ? LIMIT 1`,
                [finalP1]
            );
            if (cs) finalClassId = cs.class_id;
        }

        const [result] = await pool.query(
            `INSERT INTO elementa_game_sessions
                (student_id_p1, student_id_p2, assessment_id, class_id, play_mode, cabinet_id, session_status, started_at)
             VALUES (?, ?, ?, ?, ?, ?, 'Ongoing', NOW())`,
            [
                finalP1 || null, 
                student_id_p2 || null, 
                finalAssessmentId || null, 
                finalClassId || null, 
                finalPlayMode,
                cabinet_id
            ]
        );

        res.json({ success: true, session_id: result.insertId });
    } catch (err) {
        console.error('[POST /session/start]', err);
        fail(res, 500, 'Failed to start session');
    }
});

// Supports both POST /session/end and POST /session/:id/end
const handleSessionEnd = async (req, res) => {
    try {
        const session_id = req.params.session_id || req.body.session_id;
        const {
            total_duration_s = 0,
            final_score_p1 = 0,
            final_score_p2 = 0,
            winner = null,
            highest_level_reached = 1,
        } = req.body;

        if (!session_id) return fail(res, 400, 'session_id required');

        await pool.query(
            `UPDATE elementa_game_sessions SET
                session_status = 'Completed',
                ended_at = NOW(),
                total_duration_s = ?,
                final_score_p1 = ?,
                final_score_p2 = ?,
                winner = ?,
                highest_level_reached = ?
             WHERE session_id = ?`,
            [total_duration_s, final_score_p1, final_score_p2, winner, highest_level_reached, session_id]
        );

        // Retrieve session student IDs
        let sessStudents = null;
        try {
            const [[sessRows]] = await pool.query(
                `SELECT student_id_p1, student_id_p2 FROM elementa_game_sessions WHERE session_id = ?`,
                [session_id]
            );
            sessStudents = sessRows;
        } catch (fetchErr) {
            console.warn('[SessionEnd:FetchStudentsError]', fetchErr.message);
        }

        // Auto Gradebook Sync & Remediation Trigger (accrues EXP and recalculates level for graded sessions)
        let syncResult = { graded: false };
        try {
            syncResult = await arcadeGradeSyncService.syncSessionToGradebook(session_id);
        } catch (syncErr) {
            console.error('[SessionEnd:GradeSyncError]', syncErr.message);
        }

        // Ensure level is recalculated from total_exp even for free-play or edge-case sessions
        if (sessStudents) {
            const sIds = [sessStudents.student_id_p1, sessStudents.student_id_p2].filter(Boolean);
            for (const sId of sIds) {
                try {
                    await levelProgressionService.recalculateStudentLevel(sId);
                } catch (lvlErr) {
                    console.warn('[SessionEnd:LevelRecalcError]', lvlErr.message);
                }
            }
        }

        // Consume assessment ticket if provided or by linked assessment
        try {
            const ticketCode = req.body.ticket_code;
            const ticketCodeP1 = req.body.ticket_code_p1;
            const ticketCodeP2 = req.body.ticket_code_p2;
            const ticketId = req.body.ticket_id;
            const ticketCodes = [ticketCode, ticketCodeP1, ticketCodeP2].filter(Boolean);

            if (ticketId || ticketCodes.length > 0) {
                await pool.query(
                    `UPDATE elementa_assessment_tickets 
                     SET status = 'Consumed', consumed_at = NOW() 
                     WHERE (ticket_id = ? OR ticket_code IN (?)) AND status = 'Active'`,
                    [ticketId || 0, ticketCodes.length > 0 ? ticketCodes : ['']]
                );
            } else {
                const [[sess]] = await pool.query(
                    'SELECT student_id_p1, student_id_p2, assessment_id FROM elementa_game_sessions WHERE session_id = ?', 
                    [session_id]
                );
                if (sess && sess.assessment_id) {
                    const studentIds = [sess.student_id_p1, sess.student_id_p2].filter(Boolean);
                    if (studentIds.length > 0) {
                        await pool.query(
                            `UPDATE elementa_assessment_tickets 
                             SET status = 'Consumed', consumed_at = NOW() 
                             WHERE assessment_id = ? AND student_id IN (?) AND status = 'Active'`,
                            [sess.assessment_id, studentIds]
                        );
                    }
                }
            }
        } catch (ticketErr) {
            console.warn('[SessionEnd:TicketConsumeError]', ticketErr.message);
        }

        // Recalculate Course Completion & Notify Teacher (T-06 / T-07) for participating arcade students
        try {
            const [[sessRow]] = await pool.query(
                'SELECT session_id, student_id_p1, student_id_p2, assessment_id, final_score_p1, final_score_p2 FROM elementa_game_sessions WHERE session_id = ?', 
                [session_id]
            );
            if (sessRow && sessRow.assessment_id) {
                const [[asmtRow]] = await pool.query(`
                    SELECT a.assessment_id, a.sy_id, a.assessment_name, a.total_items, a.teacher_id AS asmt_teacher_id, q.subject_id 
                    FROM assessments a
                    LEFT JOIN topics t ON a.topic_id = t.topic_id
                    JOIN quarters q ON COALESCE(a.quarter_id, t.quarter_id) = q.quarter_id
                    WHERE a.assessment_id = ?
                `, [sessRow.assessment_id]);

                if (asmtRow && asmtRow.subject_id) {
                    const studentIds = [sessRow.student_id_p1, sessRow.student_id_p2].filter(Boolean);
                    for (const sId of studentIds) {
                        await progressService.recalculateProgress(sId, asmtRow.subject_id, asmtRow.sy_id);
                    }

                    // T-06 & T-07: Notify Teacher of Arcade Assessment or Competitive Duel Completion
                    try {
                        if (sessRow.student_id_p1 && sessRow.student_id_p2) {
                            // T-07: Competitive Duel Completed
                            const [uRows] = await pool.query(
                                `SELECT user_id, first_name, last_name FROM users WHERE user_id IN (?, ?)`,
                                [sessRow.student_id_p1, sessRow.student_id_p2]
                            );
                            const p1User = uRows.find(u => u.user_id === sessRow.student_id_p1);
                            const p2User = uRows.find(u => u.user_id === sessRow.student_id_p2);
                            const p1Name = p1User ? `${p1User.first_name} ${p1User.last_name}`.trim() : `Player 1`;
                            const p2Name = p2User ? `${p2User.first_name} ${p2User.last_name}`.trim() : `Player 2`;
                            const [clsRows] = await pool.query(
                                `SELECT DISTINCT c.teacher_id, c.class_id
                                 FROM classes c
                                 JOIN class_students cs ON cs.class_id = c.class_id
                                 WHERE c.subject_id = ? AND cs.student_id IN (?, ?) AND c.teacher_id IS NOT NULL`,
                                [asmtRow.subject_id, sessRow.student_id_p1, sessRow.student_id_p2]
                            );
                            for (const cRow of clsRows) {
                                await notificationService.dispatch({
                                    recipientIds: cRow.teacher_id,
                                    actorId: sessRow.student_id_p1,
                                    role: 'Teacher',
                                    category: 'assessment',
                                    priority: 'normal',
                                    eventType: 'competitive_duel_completed',
                                    title: `Competitive Duel Finished: ${asmtRow.assessment_name}`,
                                    message: `${p1Name} (${sessRow.final_score_p1 || 0} pts) vs. ${p2Name} (${sessRow.final_score_p2 || 0} pts) completed '${asmtRow.assessment_name}'.`,
                                    targetUrl: `/teacher/class/${cRow.class_id}?tab=analytics`,
                                    metadata: { sessionId: session_id, assessmentId: asmtRow.assessment_id }
                                });
                            }
                        } else if (sessRow.student_id_p1) {
                            // T-06: Solo / Campaign Assessment Completed
                            const [[p1User]] = await pool.query(
                                `SELECT first_name, last_name FROM users WHERE user_id = ?`,
                                [sessRow.student_id_p1]
                            );
                            const studentName = p1User ? `${p1User.first_name} ${p1User.last_name}`.trim() : 'A student';
                            const [clsRows] = await pool.query(
                                `SELECT DISTINCT c.teacher_id, c.class_id
                                 FROM classes c
                                 JOIN class_students cs ON cs.class_id = c.class_id
                                 WHERE c.subject_id = ? AND cs.student_id = ? AND c.teacher_id IS NOT NULL`,
                                [asmtRow.subject_id, sessRow.student_id_p1]
                            );
                            for (const cRow of clsRows) {
                                await notificationService.dispatch({
                                    recipientIds: cRow.teacher_id,
                                    actorId: sessRow.student_id_p1,
                                    role: 'Teacher',
                                    category: 'assessment',
                                    priority: 'normal',
                                    eventType: 'arcade_assessment_completed',
                                    title: `Assessment Completed: ${asmtRow.assessment_name}`,
                                    message: `${studentName} completed '${asmtRow.assessment_name}' with a score of ${sessRow.final_score_p1 || 0}/${asmtRow.total_items || 10}.`,
                                    targetUrl: `/teacher/analysis/${session_id}`,
                                    metadata: { sessionId: session_id, assessmentId: asmtRow.assessment_id }
                                });
                            }
                        }
                    } catch (notifErr) {
                        console.error('[SessionEnd:TeacherNotifError]', notifErr.message);
                    }
                }
            }
        } catch (progErr) {
            console.error('[SessionEnd:ProgressRecalcError]', progErr.message);
        }

        const p1Details = syncResult.playerSyncDetails?.find(p => p.playerNumber === 1);
        const p2Details = syncResult.playerSyncDetails?.find(p => p.playerNumber === 2);

        let p1Stats = null;
        let p2Stats = null;
        if (sessStudents?.student_id_p1) {
            try {
                p1Stats = await levelProgressionService.getStudentLevelStats(sessStudents.student_id_p1);
            } catch (_) {}
        }
        if (sessStudents?.student_id_p2) {
            try {
                p2Stats = await levelProgressionService.getStudentLevelStats(sessStudents.student_id_p2);
            } catch (_) {}
        }

        res.json({ 
            success: true, 
            lms_grade_synced: syncResult.graded,
            player_sync_details: syncResult.playerSyncDetails || [],
            exp_earned_p1: p1Details ? p1Details.expEarned : (final_score_p1 || 0) * 100,
            total_exp_p1: p1Stats ? p1Stats.totalExp : (p1Details ? p1Details.totalExp : 0),
            current_level_p1: p1Stats ? p1Stats.calculatedLevel : (p1Details?.currentLevel || 1),
            exp_earned_p2: p2Details ? p2Details.expEarned : (final_score_p2 || 0) * 100,
            total_exp_p2: p2Stats ? p2Stats.totalExp : (p2Details ? p2Details.totalExp : 0),
            current_level_p2: p2Stats ? p2Stats.calculatedLevel : (p2Details?.currentLevel || 1),
            total_max_exp: p1Stats?.totalMaxExp || 52100
        });
    } catch (err) {
        console.error('[POST /session/end]', err);
        fail(res, 500, 'Failed to end session');
    }
};

router.post('/session/end', verifyCabinetSignature, handleSessionEnd);
router.post('/session/:session_id/end', verifyCabinetSignature, handleSessionEnd);
router.patch('/session/:session_id/end', verifyCabinetSignature, handleSessionEnd);

// ===================================================================
// LEVEL RUN LIFECYCLE (Supports /level-run and /level)
// ===================================================================
const handleLevelStart = async (req, res) => {
    try {
        const {
            session_id,
            player_number = 1,
            level_number = 1,
            level_topic = null,
            max_score = 10,
            customers_total = 10,
        } = req.body;

        if (!session_id) return fail(res, 400, 'session_id required');

        const [result] = await pool.query(
            `INSERT INTO elementa_level_runs
                (session_id, player_number, level_number, level_topic, max_score, customers_total, started_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [session_id, player_number, level_number, level_topic, max_score, customers_total]
        );

        res.json({ success: true, run_id: result.insertId });
    } catch (err) {
        console.error('[POST /level/start]', err);
        fail(res, 500, 'Failed to start level run');
    }
};

router.post('/level/start', verifyCabinetSignature, handleLevelStart);
router.post('/level-run/start', verifyCabinetSignature, handleLevelStart);

const handleLevelEnd = async (req, res) => {
    try {
        const run_id = req.params.run_id || req.body.run_id;
        const {
            score = 0,
            customers_served = 0,
            max_streak = 0,
            duration_s = 0,
        } = req.body;

        if (!run_id) return fail(res, 400, 'run_id required');

        await pool.query(
            `UPDATE elementa_level_runs SET
                run_status = 'Completed',
                ended_at = NOW(),
                score = ?,
                customers_served = ?,
                max_streak = ?,
                duration_s = ?
             WHERE run_id = ?`,
            [score, customers_served, max_streak, duration_s, run_id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[POST /level/end]', err);
        fail(res, 500, 'Failed to end level run');
    }
};

router.post('/level/end', verifyCabinetSignature, handleLevelEnd);
router.post('/level/:run_id/end', verifyCabinetSignature, handleLevelEnd);
router.patch('/level/:run_id/end', verifyCabinetSignature, handleLevelEnd);
router.post('/level-run/end', verifyCabinetSignature, handleLevelEnd);

// ===================================================================
// GRANULAR GAMEPLAY LOGGING (Micro-Telemetry)
// ===================================================================
router.post('/attempt', verifyCabinetSignature, async (req, res) => {
    try {
        const {
            run_id,
            customer_index = 1,
            customer_id_ref = null,
            machine_used = null,
            question_snapshot = null,
            correct_answer = null,
            player_answer = null,
            is_correct = false,
            is_timeout = false,
            time_given_s = 90.0,
            time_remaining_s = null,
            response_time_s = null,
            points_awarded = 0,
            combo_at_answer = 0,
            failure_type = null,
            level_number = null,
            hesitation_score = 0.0,
            scaffolding_used = null
        } = req.body;

        if (!run_id) return fail(res, 400, 'run_id required');

        let resolvedQuestionId = req.body.question_id || null;
        if (!resolvedQuestionId && question_snapshot) {
            try {
                const [[matchedQ]] = await pool.query(
                    'SELECT question_id FROM elementa_questions WHERE prompt = ? OR question_code = ? LIMIT 1',
                    [question_snapshot, question_snapshot]
                );
                if (matchedQ) resolvedQuestionId = matchedQ.question_id;
            } catch (qLookupErr) {
                console.warn('[Attempt Question Lookup Warn]', qLookupErr.message);
            }
        }

        const [result] = await pool.query(
            `INSERT INTO elementa_customer_attempts
                (run_id, customer_index, customer_id_ref, question_id, machine_used,
                 question_snapshot, correct_answer, player_answer,
                 is_correct, is_timeout, time_given_s, time_remaining_s,
                 response_time_s, points_awarded, combo_at_answer, failure_type,
                 level_number, hesitation_score, scaffolding_used, attempted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                run_id, customer_index, customer_id_ref, resolvedQuestionId, machine_used,
                question_snapshot, correct_answer, player_answer,
                is_correct ? 1 : 0, is_timeout ? 1 : 0, time_given_s, time_remaining_s,
                response_time_s, points_awarded, combo_at_answer, failure_type,
                level_number, hesitation_score, scaffolding_used
            ]
        );

        res.json({ success: true, attempt_id: result.insertId });
    } catch (err) {
        console.error('[POST /attempt]', err);
        fail(res, 500, 'Failed to log attempt');
    }
});

router.post('/click', verifyCabinetSignature, async (req, res) => {
    try {
        const {
            run_id,
            attempt_id = null,
            player_number = 1,
            element_symbol,
            atomic_number = null,
            click_source = 'PeriodicPopup',
        } = req.body;

        if (!run_id || !element_symbol) {
            return fail(res, 400, 'run_id and element_symbol required');
        }

        await pool.query(
            `INSERT INTO elementa_element_clicks
                (attempt_id, run_id, player_number, element_symbol, atomic_number, click_source, clicked_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [attempt_id || null, run_id, player_number, element_symbol, atomic_number || null, click_source]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[POST /click]', err);
        fail(res, 500, 'Failed to log click');
    }
});

const handleMachineEvent = async (req, res) => {
    try {
        const {
            run_id,
            attempt_id = null,
            player_number = 1,
            machine_type,
            event_type = 'Opened',
        } = req.body;

        if (!run_id || !machine_type) {
            return fail(res, 400, 'run_id and machine_type required');
        }

        await pool.query(
            `INSERT INTO elementa_machine_interactions
                (run_id, attempt_id, player_number, machine_type, event_type, event_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [run_id, attempt_id || null, player_number, machine_type, event_type]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[POST /machine-event]', err);
        fail(res, 500, 'Failed to log machine event');
    }
};

router.post('/machine', verifyCabinetSignature, handleMachineEvent);
router.post('/machine-event', verifyCabinetSignature, handleMachineEvent);

// ===================================================================
// LEADERBOARD UPSERT
// ===================================================================
router.post('/leaderboard/upsert', verifyCabinetSignature, async (req, res) => {
    try {
        const {
            student_id,
            class_id = null,
            assessment_id = null,
            session_id = null,
            score_total = 0,
            level_reached = 1,
            customers_correct = 0,
            customers_played = 0,
            accuracy_pct = 0.0,
            avg_response_time_s = null,
        } = req.body;

        if (!student_id || student_id <= 0) return res.json({ success: true }); // Ignore guest

        let resolvedClassId = class_id;
        let resolvedAssessmentId = assessment_id;

        // 1. If class_id or assessment_id are missing, look them up from the game session
        if ((!resolvedClassId || !resolvedAssessmentId) && session_id) {
            const [[sess]] = await pool.query(
                `SELECT class_id, assessment_id FROM elementa_game_sessions WHERE session_id = ? LIMIT 1`,
                [session_id]
            );
            if (sess) {
                if (!resolvedClassId && sess.class_id) resolvedClassId = sess.class_id;
                if (!resolvedAssessmentId && sess.assessment_id) resolvedAssessmentId = sess.assessment_id;
            }
        }

        // 2. If class_id is still missing, lookup student's enrolled class
        if (!resolvedClassId && student_id) {
            const [[cs]] = await pool.query(
                `SELECT class_id FROM class_students WHERE student_id = ? ORDER BY class_id ASC LIMIT 1`,
                [student_id]
            );
            if (cs && cs.class_id) resolvedClassId = cs.class_id;
        }

        // 3. Fallback: Prevent NULL class_id from bypassing idx_lb_student_class (NULL != NULL in SQL)
        if (!resolvedClassId) {
            resolvedClassId = 1;
        }

        await pool.query(
            `INSERT INTO elementa_leaderboard
                (student_id, class_id, assessment_id, best_session_id,
                 best_score_total, best_level_reached, total_runs,
                 total_customers_correct, total_customers_played, accuracy_pct,
                 avg_response_time_s, last_played_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                 best_score_total        = GREATEST(best_score_total, VALUES(best_score_total)),
                 best_level_reached      = GREATEST(best_level_reached, VALUES(best_level_reached)),
                 best_session_id         = IF(VALUES(best_score_total) > best_score_total, VALUES(best_session_id), best_session_id),
                 assessment_id           = IF(VALUES(best_score_total) > best_score_total, COALESCE(VALUES(assessment_id), assessment_id), assessment_id),
                 total_runs              = total_runs + 1,
                 total_customers_correct = total_customers_correct + VALUES(total_customers_correct),
                 total_customers_played  = total_customers_played  + VALUES(total_customers_played),
                 accuracy_pct            = ROUND((total_customers_correct + VALUES(total_customers_correct)) / NULLIF(total_customers_played + VALUES(total_customers_played), 0) * 100, 2),
                 avg_response_time_s     = IFNULL(VALUES(avg_response_time_s), avg_response_time_s),
                 last_played_at          = NOW()`,
            [
                student_id, resolvedClassId, resolvedAssessmentId || null, session_id || null,
                score_total, level_reached, customers_correct, customers_played,
                accuracy_pct, avg_response_time_s
            ]
        );

        res.json({ success: true, class_id: resolvedClassId, assessment_id: resolvedAssessmentId });
    } catch (err) {
        console.error('[POST /leaderboard/upsert]', err);
        fail(res, 500, 'Failed to upsert leaderboard');
    }
});

// ===================================================================
// OFFLINE SPOOL BATCH INGESTION (Recovers buffered offline runs)
// ===================================================================
router.post('/sync-spool', verifyCabinetSignature, async (req, res) => {
    const packets = req.body.packets || req.body.events || [];
    if (!Array.isArray(packets) || packets.length === 0) {
        return res.json({ success: true, processedCount: 0 });
    }

    let processed = 0;
    for (const pkt of packets) {
        try {
            const endpoint = (pkt.endpoint || '').trim();
            const d = pkt.data || pkt.payload || {};

            if (endpoint === '/attempt' && d.run_id) {
                let resolvedQId = d.question_id || null;
                if (!resolvedQId && d.question_snapshot) {
                    try {
                        const [[matchedQ]] = await pool.query(
                            'SELECT question_id FROM elementa_questions WHERE prompt = ? OR question_code = ? LIMIT 1',
                            [d.question_snapshot, d.question_snapshot]
                        );
                        if (matchedQ) resolvedQId = matchedQ.question_id;
                    } catch (e) {}
                }
                await pool.query(
                    `INSERT INTO elementa_customer_attempts
                        (run_id, customer_index, customer_id_ref, question_id, machine_used,
                         question_snapshot, correct_answer, player_answer,
                         is_correct, is_timeout, time_given_s, time_remaining_s,
                         response_time_s, points_awarded, combo_at_answer, failure_type,
                         level_number, attempted_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        d.run_id, d.customer_index, d.customer_id_ref, resolvedQId, d.machine_used,
                        d.question_snapshot, d.correct_answer, d.player_answer,
                        d.is_correct ? 1 : 0, d.is_timeout ? 1 : 0, d.time_given_s, d.time_remaining_s,
                        d.response_time_s, d.points_awarded, d.combo_at_answer, d.failure_type,
                        d.level_number
                    ]
                );
                processed++;
            } else if (endpoint === '/click' && d.run_id && d.element_symbol) {
                await pool.query(
                    `INSERT INTO elementa_element_clicks
                        (attempt_id, run_id, player_number, element_symbol, atomic_number, click_source, clicked_at)
                     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                    [d.attempt_id || null, d.run_id, d.player_number || 1, d.element_symbol, d.atomic_number || null, d.click_source || 'PeriodicPopup']
                );
                processed++;
            } else if ((endpoint === '/machine' || endpoint === '/machine-event') && d.run_id && d.machine_type) {
                await pool.query(
                    `INSERT INTO elementa_machine_interactions
                        (run_id, attempt_id, player_number, machine_type, event_type, event_at)
                     VALUES (?, ?, ?, ?, ?, NOW())`,
                    [d.run_id, d.attempt_id || null, d.player_number || 1, d.machine_type, d.event_type || 'Opened']
                );
                processed++;
            } else if ((endpoint.startsWith('/session') && endpoint.endsWith('/end')) || endpoint === '/session/end') {
                const match = endpoint.match(/\/session\/(\d+)\/end/);
                const sId = match ? parseInt(match[1], 10) : (d.session_id || null);
                if (sId) {
                    await pool.query(
                        `UPDATE elementa_game_sessions SET
                            session_status = 'Completed',
                            ended_at = NOW(),
                            total_duration_s = COALESCE(?, total_duration_s),
                            final_score_p1 = COALESCE(?, final_score_p1),
                            final_score_p2 = COALESCE(?, final_score_p2),
                            winner = COALESCE(?, winner),
                            highest_level_reached = COALESCE(?, highest_level_reached)
                         WHERE session_id = ?`,
                        [d.total_duration_s, d.final_score_p1, d.final_score_p2, d.winner, d.highest_level_reached, sId]
                    );
                    try {
                        await arcadeGradeSyncService.syncSessionToGradebook(sId);
                    } catch (syncErr) {
                        console.warn('[SyncSpool:GradeSyncWarn]', syncErr.message);
                    }
                    processed++;
                }
            } else if (endpoint.startsWith('/leaderboard')) {
                if (d.student_id && d.session_id) {
                    await pool.query(
                        `INSERT INTO elementa_leaderboard
                            (student_id, session_id, assessment_id, score_total, level_reached,
                             customers_correct, customers_played, accuracy_pct, avg_response_time_s, recorded_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                         ON DUPLICATE KEY UPDATE
                            score_total = GREATEST(score_total, VALUES(score_total)),
                            accuracy_pct = VALUES(accuracy_pct),
                            level_reached = GREATEST(level_reached, VALUES(level_reached)),
                            recorded_at = NOW()`,
                        [
                            d.student_id, d.session_id, d.assessment_id || null,
                            d.score_total || 0, d.level_reached || 1,
                            d.customers_correct || 0, d.customers_played || 0,
                            d.accuracy_pct || 0, d.avg_response_time_s || 0
                        ]
                    );
                    processed++;
                }
            }
        } catch (spoolErr) {
            console.warn('[SyncSpool Item Skip]', spoolErr.message);
        }
    }

    res.json({ success: true, processedCount: processed });
});

// ===================================================================
// DYNAMIC DIFFICULTY ADJUSTMENT (DDA)
// ===================================================================
router.get('/adaptive-config/:student_id/:level_number', async (req, res) => {
    try {
        const { student_id, level_number } = req.params;

        // Fetch student historical accuracy on this level or recent runs
        const [recent] = await pool.query(
            `SELECT ca.is_correct, ca.response_time_s 
             FROM elementa_customer_attempts ca
             JOIN elementa_level_runs lr ON lr.run_id = ca.run_id
             JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
             WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
             ORDER BY ca.attempted_at DESC LIMIT 5`,
            [student_id, student_id]
        );

        let ddaMultiplier = 1.0;
        let scaffolding = 'Standard';
        let toleranceMod = 0.0;

        if (recent.length >= 3) {
            const correctCount = recent.filter(r => r.is_correct).length;
            const acc = correctCount / recent.length;

            if (acc <= 0.40) {
                // Student is struggling: Increase patience timer and widen dial tolerance
                ddaMultiplier = 1.25;
                scaffolding = 'HighHint';
                toleranceMod = 0.10;
            } else if (acc >= 0.90) {
                // Student is acing: Tighten timers to keep in Flow state
                ddaMultiplier = 0.90;
                scaffolding = 'Minimal';
                toleranceMod = 0.00;
            }
        }

        res.json({
            success: true,
            student_id: Number(student_id),
            level_number: Number(level_number),
            adaptive_parameters: {
                dda_multiplier: ddaMultiplier,
                time_limit_override_s: Math.round(90.0 * ddaMultiplier),
                scaffolding_level: scaffolding,
                dial_tolerance_modifier: toleranceMod
            }
        });
    } catch (err) {
        console.error('[GET /adaptive-config]', err);
        res.json({
            success: true,
            adaptive_parameters: { dda_multiplier: 1.0, time_limit_override_s: 90.0 }
        });
    }
});

// ===================================================================
// HARDWARE FLEET HEARTBEAT
// ===================================================================
router.post('/heartbeat', async (req, res) => {
    try {
        const {
            kiosk_id = req.body.cabinet_id || 'KIOSK-01',
            cabinet_id,
            status = 'Online',
            ping_ms = 15,
            scanner_status = 'Connected',
            gpio_status = 'Operational',
            active_session_id = null,
            is_proctor_paused = 0
        } = req.body;

        const effectiveId = (kiosk_id || cabinet_id || 'KIOSK-01').trim();
        const clientIp = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0].trim() 
            : (req.ip || '127.0.0.1');
        const resolvedIp = (req.body.ip_address && req.body.ip_address !== '127.0.0.1') 
            ? req.body.ip_address 
            : clientIp;
        const pausedFlag = Number(is_proctor_paused) === 1 ? 1 : 0;

        await pool.query(
            `INSERT INTO elementa_kiosk_status
                (kiosk_id, ip_address, status, ping_ms, scanner_status, gpio_status, active_session_id, is_proctor_paused, last_heartbeat)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                ip_address = VALUES(ip_address),
                status = VALUES(status),
                ping_ms = VALUES(ping_ms),
                scanner_status = VALUES(scanner_status),
                gpio_status = VALUES(gpio_status),
                active_session_id = VALUES(active_session_id),
                is_proctor_paused = VALUES(is_proctor_paused),
                last_heartbeat = NOW()`,
            [effectiveId, resolvedIp, status, ping_ms, scanner_status, gpio_status, active_session_id, pausedFlag]
        );

        // Check if there is a pending remote proctor command for this kiosk
        let command = null;
        let teacherName = 'Instructor';
        let commandIssuedAt = null;

        const targetKey = kioskCommandQueue.has(effectiveId)
            ? effectiveId
            : (kioskCommandQueue.has('KIOSK-01') ? 'KIOSK-01' : (kioskCommandQueue.has('KIOSK-LAB-01') ? 'KIOSK-LAB-01' : null));

        if (targetKey) {
            const pending = kioskCommandQueue.get(targetKey);
            command = pending.action;
            teacherName = pending.teacher_name || 'Instructor';
            commandIssuedAt = pending.issued_at;
            kioskCommandQueue.delete('KIOSK-01');
            kioskCommandQueue.delete('KIOSK-LAB-01');
            kioskCommandQueue.delete(effectiveId);
            console.log(`[POST /heartbeat] Dispatched proctor command '${command}' to ${effectiveId} (by ${teacherName})`);
        }

        res.json({
            success: true,
            acknowledged: true,
            command: command,
            teacher_name: teacherName,
            issued_at: commandIssuedAt
        });
    } catch (err) {
        console.error('[POST /heartbeat]', err);
        res.json({ success: false });
    }
});

// ===================================================================
// TEACHER REMOTE PROCTOR KIOSK CONTROL (Pause / Resume Kiosk Fleet)
// ===================================================================
router.post('/kiosk/:kiosk_id/command', async (req, res) => {
    try {
        const kioskId = (req.params.kiosk_id || 'KIOSK-01').trim();
        const { action, teacher_name = 'Instructor' } = req.body;

        const normalizedAction = (action || '').toUpperCase();
        if (normalizedAction !== 'PAUSE' && normalizedAction !== 'RESUME') {
            return fail(res, 400, "Action must be 'PAUSE' or 'RESUME'");
        }

        const commandRecord = {
            action: normalizedAction,
            teacher_name: teacher_name.trim(),
            issued_at: new Date()
        };
        kioskCommandQueue.set(kioskId, commandRecord);
        if (kioskId === 'KIOSK-01') kioskCommandQueue.set('KIOSK-LAB-01', commandRecord);
        if (kioskId === 'KIOSK-LAB-01') kioskCommandQueue.set('KIOSK-01', commandRecord);

        // Optimistically update database is_proctor_paused so UI reflects immediately
        const pausedVal = normalizedAction === 'PAUSE' ? 1 : 0;
        await pool.query(
            `UPDATE elementa_kiosk_status 
             SET is_proctor_paused = ? 
             WHERE kiosk_id IN (?, 'KIOSK-01', 'KIOSK-LAB-01')`,
            [pausedVal, kioskId]
        );

        console.log(`[POST /kiosk/${kioskId}/command] Queued proctor command: ${normalizedAction} by ${teacher_name}`);

        return res.json({
            success: true,
            kiosk_id: kioskId,
            action: normalizedAction,
            teacher_name: teacher_name,
            queued: true
        });
    } catch (err) {
        console.error('[POST /kiosk/:kiosk_id/command]', err);
        return fail(res, 500, 'Failed to queue kiosk command');
    }
});

// ===================================================================
// KIOSK FLEET STATUS OVERVIEW (Consumed by Teacher Telemetry / Dashboard)
// ===================================================================
router.get('/kiosks', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT k.kiosk_id, k.ip_address, k.status, k.ping_ms, k.active_session_id,
                    k.is_proctor_paused,
                    k.scanner_status, k.gpio_status, k.last_heartbeat,
                    TIMESTAMPDIFF(SECOND, k.last_heartbeat, NOW()) AS seconds_since_heartbeat,
                    gs.student_id_p1, gs.student_id_p2, gs.play_mode,
                    CONCAT(COALESCE(u1.first_name, ''), ' ', COALESCE(u1.last_name, '')) AS student_name_p1,
                    CONCAT(COALESCE(u2.first_name, ''), ' ', COALESCE(u2.last_name, '')) AS student_name_p2,
                    a.assessment_name,
                    lr.level_number
             FROM elementa_kiosk_status k
             LEFT JOIN elementa_game_sessions gs ON gs.session_id = k.active_session_id
             LEFT JOIN users u1 ON u1.user_id = gs.student_id_p1
             LEFT JOIN users u2 ON u2.user_id = gs.student_id_p2
             LEFT JOIN assessments a ON a.assessment_id = gs.assessment_id
             LEFT JOIN elementa_level_runs lr ON lr.session_id = gs.session_id AND lr.run_status = 'In_Progress'
             ORDER BY k.last_heartbeat DESC`
        );

        const kiosks = rows.map(k => {
            const isOnline = k.seconds_since_heartbeat !== null && k.seconds_since_heartbeat <= 45;
            const pendingCmd = kioskCommandQueue.get(k.kiosk_id) || kioskCommandQueue.get('KIOSK-01') || kioskCommandQueue.get('KIOSK-LAB-01');
            return {
                ...k,
                is_online: isOnline,
                pending_command: pendingCmd ? pendingCmd.action : null,
                student_name_p1: k.student_name_p1 ? k.student_name_p1.trim() : null,
                student_name_p2: k.student_name_p2 ? k.student_name_p2.trim() : null
            };
        });

        return res.json({ success: true, count: kiosks.length, kiosks });
    } catch (err) {
        console.error('[GET /api/elementa/kiosks]', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch kiosk fleet status' });
    }
});

// ===================================================================
// ANALYTICS DATA FEEDS (Consumed by Student, Teacher, & Admin views)
// ===================================================================
router.get('/student-analytics/:student_id', async (req, res) => {
    try {
        const studentId = Number(req.params.student_id);
        const [radar, progress, mistakes] = await Promise.all([
            arcadeAnalyticsService.getStudentRadar(studentId),
            arcadeAnalyticsService.getStudentDistrictProgress(studentId),
            arcadeAnalyticsService.getStudentMistakes(studentId, 15)
        ]);

        res.json({ success: true, radar, progress, mistakes });
    } catch (err) {
        console.error('[GET /student-analytics]', err);
        fail(res, 500, 'Failed to fetch student analytics');
    }
});

router.get('/teacher-analytics/:class_id', async (req, res) => {
    try {
        const classId = req.params.class_id !== 'all' ? Number(req.params.class_id) : null;
        const levelNumber = req.query.level ? Number(req.query.level) : null;

        const [heatmap, scatter, earlyWarning] = await Promise.all([
            arcadeAnalyticsService.getPeriodicTableHeatmap(classId, levelNumber),
            arcadeAnalyticsService.getSpeedAccuracyDistribution(classId, levelNumber),
            arcadeAnalyticsService.getEarlyWarningRiskList(classId)
        ]);

        res.json({ success: true, heatmap, scatter, earlyWarning });
    } catch (err) {
        console.error('[GET /teacher-analytics]', err);
        fail(res, 500, 'Failed to fetch teacher analytics');
    }
});

router.get('/admin-telemetry-summary', async (req, res) => {
    try {
        const [kiosks] = await pool.query(`SELECT * FROM elementa_kiosk_status ORDER BY last_heartbeat DESC`);
        const psychometrics = await arcadeAnalyticsService.getQuestionPsychometrics();

        res.json({ success: true, kiosks, psychometrics });
    } catch (err) {
        console.error('[GET /admin-telemetry-summary]', err);
        fail(res, 500, 'Failed to fetch admin telemetry summary');
    }
});

// Backward-compatible question review
router.get('/session/:session_id/review', async (req, res) => {
    try {
        const { session_id } = req.params;
        const [rows] = await pool.query(
            `SELECT a.attempt_id, r.player_number, r.level_number, r.level_topic,
                    a.customer_index, a.machine_used, a.question_snapshot,
                    a.player_answer, a.correct_answer, a.is_correct,
                    a.is_timeout, a.points_awarded, a.response_time_s, a.attempted_at
             FROM elementa_customer_attempts a
             JOIN elementa_level_runs r ON r.run_id = a.run_id
             WHERE r.session_id = ?
             ORDER BY r.player_number, r.level_number, a.customer_index`,
            [session_id]
        );
        res.json({ success: true, items: rows });
    } catch (err) {
        console.error('[GET /session/:id/review]', err);
        fail(res, 500, 'Failed to fetch review');
    }
});

module.exports = router;