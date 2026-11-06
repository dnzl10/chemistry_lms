/**
 * simulationQuizRoutes.js
 * ============================================================================
 * Production-ready Express router for Elementa Simulation Assessment Quiz
 * Customizer, EXP Bonus, and Student Telemetry.
 * ============================================================================
 */

const express = require('express');
const { ensureAuthenticated, requireRole } = require('../middleware/auth');
const simulationQuizService = require('../services/simulationQuizService');

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUBLIC / STUDENT SIMULATION API ROUTER (Mounts at /api/simulation)
// ─────────────────────────────────────────────────────────────────────────────
const apiRouter = express.Router();

/**
 * Helper to extract current student ID from session or authenticated user
 */
function getStudentId(req) {
    if (req.user && req.user.user_id) return req.user.user_id;
    if (req.session && req.session.userId) return req.session.userId;
    if (req.session && req.session.user && req.session.user.user_id) return req.session.user.user_id;
    return null;
}

/**
 * GET /api/simulation/:slug/quiz-status
 * Simulation iframe requests current quiz status and checks for active EXP bonus.
 * Sanitized for anti-cheat: questions are provided without answers.
 */
apiRouter.get('/:slug/quiz-status', async (req, res) => {
    try {
        const studentId = getStudentId(req);
        const result = await simulationQuizService.getQuizStatus(req.params.slug, studentId);
        return res.json(result);
    } catch (err) {
        console.error('[API /api/simulation/:slug/quiz-status]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/simulation/:slug/quiz-submit
 * Submits student answers, verifies single-claim & expiration, grades algorithmically,
 * records submission, and increments users.total_exp & level.
 */
apiRouter.post('/:slug/quiz-submit', async (req, res) => {
    try {
        const studentId = getStudentId(req);
        if (!studentId) {
            return res.status(401).json({
                success: false,
                error: 'Please log in to your Elementa account to submit assessment quizzes and earn EXP.'
            });
        }

        const { quiz_id, answers } = req.body;
        if (!quiz_id) {
            return res.status(400).json({ success: false, error: 'Missing required quiz_id parameter.' });
        }

        const result = await simulationQuizService.gradeAndSubmitQuiz(
            req.params.slug,
            studentId,
            quiz_id,
            answers
        );

        return res.json(result);
    } catch (err) {
        console.error('[API /api/simulation/:slug/quiz-submit]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/simulation/:slug/runtime
 * Backward compatibility with ElementaHostBridge REQUEST_RUNTIME_STATE.
 */
apiRouter.get('/:slug/runtime', async (req, res) => {
    try {
        const studentId = getStudentId(req);
        const status = await simulationQuizService.getQuizStatus(req.params.slug, studentId);
        return res.json({
            success: true,
            sim_slug: req.params.slug,
            student_progress: {
                has_bonus: status.has_bonus,
                already_completed: status.already_completed,
                is_expired: status.is_expired
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TEACHER SIMULATION QUIZ ROUTER (Mounts at /teacher/simulation-quizzes)
// ─────────────────────────────────────────────────────────────────────────────
const teacherRouter = express.Router();

teacherRouter.use(ensureAuthenticated);
teacherRouter.use(requireRole(['Teacher', 'Admin']));

/**
 * GET /teacher/simulation-quizzes
 * Main management page: displays all 20 simulations with status cards and quiz creator.
 */
teacherRouter.get('/', async (req, res) => {
    try {
        const simulations = await simulationQuizService.getAllSimulationsWithQuizStatus();
        return res.render('teacher/simulation_quizzes', {
            user: req.user,
            activeNav: 'simulation_quizzes',
            simulations: simulations,
            pageTitle: 'Simulation Assessment Quizzes'
        });
    } catch (err) {
        console.error('[Teacher /simulation-quizzes]', err);
        return res.status(500).send('Error loading simulation quizzes page: ' + err.message);
    }
});

/**
 * GET /teacher/simulation-quizzes/api/simulations
 * Returns JSON list of all 20 simulations with quiz statuses.
 */
teacherRouter.get('/api/simulations', async (req, res) => {
    try {
        const simulations = await simulationQuizService.getAllSimulationsWithQuizStatus();
        return res.json({ success: true, simulations });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /teacher/simulation-quizzes/api/quiz/:quiz_id
 * Returns quiz details and its complete questions for editing.
 */
teacherRouter.get('/api/quiz/:quiz_id', async (req, res) => {
    try {
        const analytics = await simulationQuizService.getQuizAnalytics(parseInt(req.params.quiz_id, 10));
        return res.json({
            success: true,
            quiz: analytics.quiz,
            questions: analytics.questions
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /teacher/simulation-quizzes/save
 * Creates or updates custom quiz questions for a simulation.
 */
teacherRouter.post('/save', async (req, res) => {
    try {
        const creatorId = req.user.user_id;
        const result = await simulationQuizService.saveCustomQuiz(creatorId, req.body);
        return res.json(result);
    } catch (err) {
        console.error('[Teacher /simulation-quizzes/save]', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /teacher/simulation-quizzes/toggle
 * Toggles a quiz's active state.
 */
teacherRouter.post('/toggle', async (req, res) => {
    try {
        const { quiz_id, is_active } = req.body;
        const result = await simulationQuizService.toggleQuizStatus(quiz_id, is_active);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /teacher/simulation-quizzes/delete
 * Deletes a custom quiz.
 */
teacherRouter.post('/delete', async (req, res) => {
    try {
        const { quiz_id } = req.body;
        const result = await simulationQuizService.deleteCustomQuiz(quiz_id);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * GET /teacher/simulation-quizzes/api/analytics/:quiz_id
 * Telemetry endpoint: returns submission logs, timestamps, score breakdowns,
 * EXP earned, student profile total EXP, and per-question accuracy.
 */
teacherRouter.get('/api/analytics/:quiz_id', async (req, res) => {
    try {
        const analytics = await simulationQuizService.getQuizAnalytics(parseInt(req.params.quiz_id, 10));
        return res.json({ success: true, ...analytics });
    } catch (err) {
        console.error('[Teacher /simulation-quizzes/api/analytics]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /teacher/simulation-quizzes/export-csv/:quiz_id
 * Generates and downloads DepEd-aligned CSV telemetry report
 */
teacherRouter.get('/export-csv/:quiz_id', async (req, res) => {
    try {
        const quizId = parseInt(req.params.quiz_id, 10);
        const data = await simulationQuizService.getQuizAnalytics(quizId);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${data.quiz.simulation_slug}_quiz_${quizId}_telemetry.csv"`);

        let csv = 'Student Name,LRN,Section,Submitted At,Score,Total Items,Correct,Incorrect,Percentage,EXP Earned,Student Total EXP,Cadet Level\r\n';

        data.submissions.forEach(sub => {
            const name = `"${(sub.first_name + ' ' + sub.last_name).replace(/"/g, '""')}"`;
            const lrn = `"${(sub.lrn_number || 'N/A').replace(/"/g, '""')}"`;
            const section = `"${(sub.section || 'All').replace(/"/g, '""')}"`;
            const date = `"${new Date(sub.submitted_at).toLocaleString().replace(/"/g, '""')}"`;
            csv += `${name},${lrn},${section},${date},${sub.score},${sub.total_questions},${sub.correct_count},${sub.incorrect_count},${sub.percentage}%,+${sub.exp_earned},${sub.current_profile_exp || 0},Level ${sub.current_level || 1}\r\n`;
        });

        return res.send(csv);
    } catch (err) {
        console.error('[CSV Export Error]', err);
        return res.status(500).send('Error generating CSV telemetry report: ' + err.message);
    }
});

// 3. ADMIN SIMULATION QUIZ ROUTER (Mounts at /admin/simulation-quizzes)
// ─────────────────────────────────────────────────────────────────────────────
const adminRouter = express.Router();

adminRouter.use(ensureAuthenticated);
adminRouter.use(requireRole(['Admin']));

adminRouter.get('/', async (req, res) => {
    try {
        const simulations = await simulationQuizService.getAllSimulationsWithQuizStatus();
        return res.render('teacher/simulation_quizzes', {
            user: req.user,
            activeNav: 'simulation_quizzes',
            simulations: simulations,
            pageTitle: 'Admin - Simulation Assessment Quizzes'
        });
    } catch (err) {
        return res.status(500).send('Error loading admin simulation quizzes: ' + err.message);
    }
});

adminRouter.get('/api/simulations', async (req, res) => {
    try {
        const simulations = await simulationQuizService.getAllSimulationsWithQuizStatus();
        return res.json({ success: true, simulations });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

adminRouter.get('/api/analytics/:quiz_id', async (req, res) => {
    try {
        const analytics = await simulationQuizService.getQuizAnalytics(parseInt(req.params.quiz_id, 10));
        return res.json({ success: true, ...analytics });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

adminRouter.get('/api/quiz/:quiz_id', async (req, res) => {
    try {
        const analytics = await simulationQuizService.getQuizAnalytics(parseInt(req.params.quiz_id, 10));
        return res.json({
            success: true,
            quiz: analytics.quiz,
            questions: analytics.questions
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

adminRouter.post('/save', async (req, res) => {
    try {
        const creatorId = req.user.user_id;
        const result = await simulationQuizService.saveCustomQuiz(creatorId, req.body);
        return res.json(result);
    } catch (err) {
        console.error('[Admin /simulation-quizzes/save]', err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

adminRouter.post('/toggle', async (req, res) => {
    try {
        const { quiz_id, is_active } = req.body;
        const result = await simulationQuizService.toggleQuizStatus(quiz_id, is_active);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

adminRouter.post('/delete', async (req, res) => {
    try {
        const { quiz_id } = req.body;
        const result = await simulationQuizService.deleteCustomQuiz(quiz_id);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

adminRouter.get('/export-csv/:quiz_id', async (req, res) => {
    try {
        const quizId = parseInt(req.params.quiz_id, 10);
        const data = await simulationQuizService.getQuizAnalytics(quizId);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${data.quiz.simulation_slug}_quiz_${quizId}_telemetry.csv"`);

        let csv = 'Student Name,LRN,Section,Submitted At,Score,Total Items,Correct,Incorrect,Percentage,EXP Earned,Student Total EXP,Cadet Level\r\n';

        data.submissions.forEach(sub => {
            const name = `"${(sub.first_name + ' ' + sub.last_name).replace(/"/g, '""')}"`;
            const lrn = `"${(sub.lrn_number || 'N/A').replace(/"/g, '""')}"`;
            const section = `"${(sub.section || 'All').replace(/"/g, '""')}"`;
            const date = `"${new Date(sub.submitted_at).toLocaleString().replace(/"/g, '""')}"`;
            csv += `${name},${lrn},${section},${date},${sub.score},${sub.total_questions},${sub.correct_count},${sub.incorrect_count},${sub.percentage}%,+${sub.exp_earned},${sub.current_profile_exp || 0},Level ${sub.current_level || 1}\r\n`;
        });

        return res.send(csv);
    } catch (err) {
        console.error('[Admin CSV Export Error]', err);
        return res.status(500).send('Error generating CSV telemetry report: ' + err.message);
    }
});

module.exports = {
    apiRouter,
    teacherRouter,
    adminRouter
};

