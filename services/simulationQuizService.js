/**
 * simulationQuizService.js
 * ============================================================================
 * Production-ready business logic service for Elementa Interactive Simulation
 * Assessment Quiz Customizer, EXP Bonus Engine, 4-Type Automated Grading,
 * and Telemetry Analytics.
 * ============================================================================
 */

const pool = require('../db');
const levelProgressionService = require('./levelProgressionService');

/**
 * Authoritative registry of the 20 Elementa Interactive Simulations
 */
const SIMULATIONS_REGISTRY = [
    { id: 1,  slug: 'build-an-atom', title: 'Build an Atom', category: 'Atomic Structure & Quantum Models', thumb: '/images/simulations/build-an-atom.png' },
    { id: 2,  slug: 'isotopes-and-atomic-mass', title: 'Isotopes and Atomic Mass', category: 'Atomic Structure & Quantum Models', thumb: '/images/simulations/isotopes-and-atomic-mass.png' },
    { id: 3,  slug: 'models-of-the-hydrogen-atom', title: 'Models of the Hydrogen Atom', category: 'Atomic Structure & Quantum Models', thumb: '/images/simulations/models-of-the-hydrogen-atom.png' },
    { id: 4,  slug: 'rutherford-scattering', title: 'Rutherford Scattering', category: 'Atomic Structure & Quantum Models', thumb: '/images/simulations/rutherford-scattering.png' },
    { id: 5,  slug: 'build-a-molecule', title: 'Build a Molecule', category: 'Chemical Bonding & Molecular Structure', thumb: '/images/simulations/build-a-molecule.png' },
    { id: 6,  slug: 'molecule-shapes', title: 'Molecule Shapes', category: 'Chemical Bonding & Molecular Structure', thumb: '/images/simulations/molecule-shapes.png' },
    { id: 7,  slug: 'molecule-shapes-basics', title: 'Molecule Shapes: Basics', category: 'Chemical Bonding & Molecular Structure', thumb: '/images/simulations/molecule-shapes-basics.png' },
    { id: 8,  slug: 'molecule-polarity', title: 'Molecule Polarity', category: 'Chemical Bonding & Molecular Structure', thumb: '/images/simulations/molecule-polarity.png' },
    { id: 9,  slug: 'atomic-interactions', title: 'Atomic Interactions', category: 'Chemical Bonding & Molecular Structure', thumb: '/images/simulations/atomic-interactions.png' },
    { id: 10, slug: 'balancing-chemical-equations', title: 'Balancing Chemical Equations', category: 'Chemical Reactions & Stoichiometry', thumb: '/images/simulations/balancing-chemical-equations.png' },
    { id: 11, slug: 'reactants-products-and-leftovers', title: 'Reactants, Products and Leftovers', category: 'Chemical Reactions & Stoichiometry', thumb: '/images/simulations/reactants-products-and-leftovers.png' },
    { id: 12, slug: 'acid-base-solutions', title: 'Acid-Base Solutions', category: 'Solutions & Acid-Base Chemistry', thumb: '/images/simulations/acid-base-solutions.png' },
    { id: 13, slug: 'concentration', title: 'Concentration', category: 'Solutions & Acid-Base Chemistry', thumb: '/images/simulations/concentration.png' },
    { id: 14, slug: 'molarity', title: 'Molarity', category: 'Solutions & Acid-Base Chemistry', thumb: '/images/simulations/molarity.png' },
    { id: 15, slug: 'beers-law-lab', title: "Beer's Law Lab", category: 'Solutions & Acid-Base Chemistry', thumb: '/images/simulations/beers-law-lab.png' },
    { id: 16, slug: 'states-of-matter', title: 'States of Matter', category: 'States of Matter & Thermodynamics', thumb: '/images/simulations/states-of-matter.png' },
    { id: 17, slug: 'states-of-matter-basics', title: 'States of Matter: Basics', category: 'States of Matter & Thermodynamics', thumb: '/images/simulations/states-of-matter-basics.png' },
    { id: 18, slug: 'density', title: 'Density', category: 'States of Matter & Thermodynamics', thumb: '/images/simulations/density.png' },
    { id: 19, slug: 'molecules-and-light', title: 'Molecules and Light', category: 'Quantum Chemistry & Light Interactions', thumb: '/images/simulations/molecules-and-light.png' },
    { id: 20, slug: 'blackbody-spectrum', title: 'Blackbody Spectrum', category: 'Quantum Chemistry & Light Interactions', thumb: '/images/simulations/blackbody-spectrum.png' }
];

/**
 * Text normalization helper for identification and qualitative problem-solving
 */
function normalizeText(str) {
    if (str == null) return '';
    return String(str)
        .trim()
        .toLowerCase()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
        .replace(/\s+/g, ' ');
}

/**
 * Numerical comparison helper with flexible tolerance
 */
function isNumericMatch(studentVal, correctVal, tolerance = 0.01) {
    if (studentVal == null || correctVal == null) return false;
    
    // Extract numerical tokens, supporting scientific notation (e.g. 1.5e-3)
    const sClean = String(studentVal).replace(/[^0-9eE.\-+]/g, '').trim();
    const cClean = String(correctVal).replace(/[^0-9eE.\-+]/g, '').trim();
    
    const sNum = parseFloat(sClean);
    const cNum = parseFloat(cClean);
    
    if (isNaN(sNum) || isNaN(cNum)) return false;
    
    const tol = parseFloat(tolerance) || 0.01;
    const diff = Math.abs(sNum - cNum);
    
    // Allow either absolute difference <= tol, or 1% relative difference
    const allowedDiff = Math.max(tol, Math.abs(cNum * 0.01));
    return diff <= allowedDiff;
}

/**
 * Retrieves the active custom quiz status for a given simulation and student.
 * Anti-Cheat Guarantee: Correct answers are NEVER returned to the client.
 */
async function getQuizStatus(simSlug, studentId = null) {
    const slug = String(simSlug).trim().toLowerCase();
    
    // Find active quiz for simulation
    const [quizRows] = await pool.query(`
        SELECT q.quiz_id, q.simulation_slug, q.title, q.description, q.exp_per_question,
               q.total_bonus_exp, q.expires_at, q.is_active, q.created_at,
               u.first_name, u.last_name
        FROM elementa_simulation_custom_quizzes q
        JOIN users u ON q.created_by = u.user_id
        WHERE q.simulation_slug = ? AND q.is_active = 1
        ORDER BY q.quiz_id DESC
        LIMIT 1
    `, [slug]);

    if (quizRows.length === 0) {
        return {
            success: true,
            has_bonus: false,
            already_completed: false,
            is_expired: false,
            quiz: null
        };
    }

    const quiz = quizRows[0];
    const now = Date.now();
    const expiresAtMs = new Date(quiz.expires_at).getTime();
    const isExpired = expiresAtMs <= now;

    // Check if quiz has expired
    if (isExpired) {
        return {
            success: true,
            has_bonus: false,
            already_completed: false,
            is_expired: true,
            expires_at: quiz.expires_at,
            quiz: null
        };
    }

    // Check if the student has already claimed this quiz
    if (studentId) {
        const [subRows] = await pool.query(`
            SELECT submission_id, score, total_questions, correct_count, incorrect_count,
                   percentage, exp_earned, submitted_at
            FROM elementa_simulation_quiz_submissions
            WHERE quiz_id = ? AND student_id = ?
            LIMIT 1
        `, [quiz.quiz_id, studentId]);

        if (subRows.length > 0) {
            return {
                success: true,
                has_bonus: false,
                already_completed: true,
                is_expired: false,
                previous_submission: subRows[0],
                quiz: null
            };
        }
    }

    // Fetch quiz questions (Sanitized for Anti-Cheat: NO correct_answer, NO tolerance, NO synonyms)
    const [qRows] = await pool.query(`
        SELECT question_id, question_text, question_type, options_json,
               order_index, points, exp_value
        FROM elementa_simulation_custom_questions
        WHERE quiz_id = ?
        ORDER BY order_index ASC, question_id ASC
    `, [quiz.quiz_id]);

    const questions = qRows.map(q => {
        let opts = [];
        if (q.options_json) {
            try {
                opts = typeof q.options_json === 'string' ? JSON.parse(q.options_json) : q.options_json;
            } catch (e) {
                opts = [];
            }
        }
        return {
            question_id: q.question_id,
            question_text: q.question_text,
            question_type: q.question_type,
            options: opts,
            order_index: q.order_index,
            points: q.points,
            exp_value: q.exp_value
        };
    });

    return {
        success: true,
        has_bonus: true,
        already_completed: false,
        is_expired: false,
        quiz: {
            quiz_id: quiz.quiz_id,
            simulation_slug: quiz.simulation_slug,
            title: quiz.title,
            description: quiz.description,
            creator_name: `${quiz.first_name} ${quiz.last_name}`,
            exp_per_question: quiz.exp_per_question,
            total_bonus_exp: quiz.total_bonus_exp,
            expires_at: quiz.expires_at,
            total_questions: questions.length,
            questions: questions
        }
    };
}

/**
 * Evaluates student answers, enforces expiration, prevents duplicate claims,
 * atomically records submission, and increments student total_exp and level.
 */
async function gradeAndSubmitQuiz(simSlug, studentId, quizId, submittedAnswers) {
    if (!studentId) {
        throw new Error('Authentication required to submit assessment quiz.');
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Fetch and lock quiz header
        const [quizRows] = await conn.query(`
            SELECT quiz_id, simulation_slug, title, exp_per_question, total_bonus_exp,
                   expires_at, is_active
            FROM elementa_simulation_custom_quizzes
            WHERE quiz_id = ? AND is_active = 1
            FOR UPDATE
        `, [quizId]);

        if (quizRows.length === 0) {
            await conn.rollback();
            return {
                success: false,
                is_locked: true,
                message: 'Assessment quiz is no longer active.'
            };
        }

        const quiz = quizRows[0];

        // 2. Check Expiration
        if (new Date(quiz.expires_at).getTime() <= Date.now()) {
            await conn.rollback();
            return {
                success: false,
                is_expired: true,
                is_locked: true,
                message: 'This assessment quiz has expired. EXP bonus is no longer claimable.'
            };
        }

        // 3. Check Single-Claim Enforcement
        const [existingSub] = await conn.query(`
            SELECT submission_id FROM elementa_simulation_quiz_submissions
            WHERE quiz_id = ? AND student_id = ?
            FOR UPDATE
        `, [quizId, studentId]);

        if (existingSub.length > 0) {
            await conn.rollback();
            return {
                success: false,
                already_claimed: true,
                is_locked: true,
                message: 'You have already completed this Assessment Quiz and claimed your EXP Bonus.'
            };
        }

        // 4. Fetch full questions with grading keys
        const [questionRows] = await conn.query(`
            SELECT question_id, question_text, question_type, options_json,
                   correct_answer, tolerance, accepted_synonyms, explanation,
                   exp_value, points
            FROM elementa_simulation_custom_questions
            WHERE quiz_id = ?
            ORDER BY order_index ASC, question_id ASC
        `, [quizId]);

        if (questionRows.length === 0) {
            await conn.rollback();
            return {
                success: false,
                message: 'No questions configured for this assessment quiz.'
            };
        }

        // Map submitted answers by question_id
        const answersMap = {};
        if (Array.isArray(submittedAnswers)) {
            submittedAnswers.forEach(ans => {
                if (ans && ans.question_id !== undefined) {
                    answersMap[ans.question_id] = ans.answer;
                }
            });
        } else if (typeof submittedAnswers === 'object' && submittedAnswers !== null) {
            Object.assign(answersMap, submittedAnswers);
        }

        let correctCount = 0;
        let incorrectCount = 0;
        let totalExpAwarded = 0;
        const answerBreakdowns = [];

        // 5. Automated Evaluation for all 4 Question Types
        for (const q of questionRows) {
            const studentRawAnswer = answersMap[q.question_id] !== undefined ? answersMap[q.question_id] : null;
            let isCorrect = false;

            if (studentRawAnswer !== null && studentRawAnswer !== '') {
                switch (q.question_type) {
                    case 'multiple_choice': {
                        // Compare selected option index (0, 1, 2, 3)
                        const sIdx = parseInt(studentRawAnswer, 10);
                        const cIdx = parseInt(q.correct_answer, 10);
                        if (!isNaN(sIdx) && !isNaN(cIdx)) {
                            isCorrect = (sIdx === cIdx);
                        } else {
                            isCorrect = (String(studentRawAnswer).trim() === String(q.correct_answer).trim());
                        }
                        break;
                    }

                    case 'true_false': {
                        // Normalize boolean comparisons
                        const sBool = String(studentRawAnswer).trim().toLowerCase();
                        const cBool = String(q.correct_answer).trim().toLowerCase();
                        isCorrect = (sBool === cBool) || (sBool === '1' && cBool === 'true') || (sBool === '0' && cBool === 'false');
                        break;
                    }

                    case 'identification': {
                        const sNorm = normalizeText(studentRawAnswer);
                        const cNorm = normalizeText(q.correct_answer);
                        if (sNorm && cNorm && sNorm === cNorm) {
                            isCorrect = true;
                        } else if (q.accepted_synonyms) {
                            // Check comma-delimited synonyms
                            const syns = q.accepted_synonyms.split(',').map(s => normalizeText(s));
                            isCorrect = syns.includes(sNorm);
                        }
                        break;
                    }

                    case 'problem_solving': {
                        // First attempt numerical comparison with tolerance
                        const numMatched = isNumericMatch(studentRawAnswer, q.correct_answer, q.tolerance);
                        if (numMatched) {
                            isCorrect = true;
                        } else {
                            // Fallback to normalized text equality
                            const sNorm = normalizeText(studentRawAnswer);
                            const cNorm = normalizeText(q.correct_answer);
                            isCorrect = (sNorm && cNorm && sNorm === cNorm);
                        }
                        break;
                    }

                    default:
                        isCorrect = false;
                        break;
                }
            }

            const expGain = isCorrect ? (q.exp_value || quiz.exp_per_question || 20) : 0;
            if (isCorrect) {
                correctCount++;
                totalExpAwarded += expGain;
            } else {
                incorrectCount++;
            }

            // Human-friendly display text for multiple choice, boolean, etc.
            let opts = [];
            if (q.options_json) {
                try {
                    opts = typeof q.options_json === 'string' ? JSON.parse(q.options_json) : (q.options_json || []);
                } catch(e) { opts = []; }
            }

            const letters = ['A', 'B', 'C', 'D', 'E'];
            let studentDisplay = 'No answer';
            let correctDisplay = String(q.correct_answer ?? '').trim();

            if (studentRawAnswer !== null && studentRawAnswer !== undefined && String(studentRawAnswer).trim() !== '') {
                if (q.question_type === 'multiple_choice') {
                    const sIdx = parseInt(studentRawAnswer, 10);
                    if (!isNaN(sIdx) && opts[sIdx] !== undefined) {
                        studentDisplay = `Option ${letters[sIdx] || (sIdx + 1)} (${opts[sIdx]})`;
                    } else if (letters.includes(String(studentRawAnswer).trim().toUpperCase())) {
                        studentDisplay = `Option ${String(studentRawAnswer).trim().toUpperCase()}`;
                    } else {
                        studentDisplay = String(studentRawAnswer).trim();
                    }
                } else if (q.question_type === 'true_false') {
                    const sBool = String(studentRawAnswer).trim().toLowerCase();
                    studentDisplay = (sBool === 'true' || sBool === '1') ? 'True' : 'False';
                } else {
                    studentDisplay = String(studentRawAnswer).trim();
                }
            }

            if (q.question_type === 'multiple_choice') {
                const cIdx = parseInt(q.correct_answer, 10);
                if (!isNaN(cIdx) && opts[cIdx] !== undefined) {
                    correctDisplay = `Option ${letters[cIdx] || (cIdx + 1)} (${opts[cIdx]})`;
                } else if (letters.includes(String(q.correct_answer).trim().toUpperCase())) {
                    correctDisplay = `Option ${String(q.correct_answer).trim().toUpperCase()}`;
                }
            } else if (q.question_type === 'true_false') {
                const cBool = String(q.correct_answer).trim().toLowerCase();
                correctDisplay = (cBool === 'true' || cBool === '1') ? 'True' : 'False';
            }

            answerBreakdowns.push({
                question_id: q.question_id,
                question_text: q.question_text,
                question_type: q.question_type,
                options_json: opts,
                student_answer: studentRawAnswer,
                student_answer_display: studentDisplay,
                correct_answer: q.correct_answer,
                correct_answer_display: correctDisplay,
                is_correct: isCorrect,
                exp_earned: expGain,
                explanation: q.explanation || ''
            });
        }

        const totalQuestions = questionRows.length;
        const score = correctCount;
        const percentage = Math.round((correctCount / totalQuestions) * 100);

        // 6. Record in elementa_simulation_quiz_submissions
        await conn.query(`
            INSERT INTO elementa_simulation_quiz_submissions
                (quiz_id, student_id, simulation_slug, score, total_questions, correct_count,
                 incorrect_count, percentage, exp_earned, answers_payload, submitted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            quizId,
            studentId,
            simSlug,
            score,
            totalQuestions,
            correctCount,
            incorrectCount,
            percentage,
            totalExpAwarded,
            JSON.stringify(answerBreakdowns)
        ]);

        // 7. Atomic EXP Increment in users table
        if (totalExpAwarded > 0) {
            await conn.query(`
                UPDATE users
                SET total_exp = total_exp + ?
                WHERE user_id = ?
            `, [totalExpAwarded, studentId]);
        }

        // 8. Recalculate level dynamically using LMS level progression service
        let levelStats = null;
        try {
            levelStats = await levelProgressionService.recalculateStudentLevel(studentId, conn);
        } catch (lvlErr) {
            console.warn('[simulationQuizService:recalculateStudentLevel]', lvlErr.message);
        }

        const [[userRow]] = await conn.query(`
            SELECT total_exp, current_level FROM users WHERE user_id = ?
        `, [studentId]);

        await conn.commit();

        return {
            success: true,
            passed: percentage >= 60,
            score: score,
            total_questions: totalQuestions,
            correct_questions: correctCount,
            incorrect_questions: incorrectCount,
            percentage: percentage,
            exp_awarded: totalExpAwarded,
            total_exp: userRow ? userRow.total_exp : 0,
            current_level: levelStats ? levelStats.current_level : (userRow?.current_level || 1),
            level_title: levelStats?.level_title || 'Cadet',
            breakdowns: answerBreakdowns
        };

    } catch (err) {
        await conn.rollback();
        console.error('[simulationQuizService.gradeAndSubmitQuiz]', err);
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Creates or updates a customized assessment quiz for a simulation.
 */
async function saveCustomQuiz(creatorId, quizData) {
    const {
        quiz_id,
        simulation_slug,
        title,
        description,
        section,
        exp_per_question,
        expires_at,
        is_active,
        questions
    } = quizData;

    if (!simulation_slug || !title || !expires_at) {
        throw new Error('simulation_slug, title, and expires_at are required.');
    }

    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('At least 1 question is required to save a quiz.');
    }

    const expPerQ = parseInt(exp_per_question, 10) || 20;
    const totalBonusExp = questions.reduce((sum, q) => {
        const val = parseInt(q.exp_value, 10);
        return sum + (val && val > 0 ? val : expPerQ);
    }, 0);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        let targetQuizId = quiz_id ? parseInt(quiz_id, 10) : null;

        if (targetQuizId) {
            // Update existing quiz header
            await conn.query(`
                UPDATE elementa_simulation_custom_quizzes
                SET simulation_slug = ?, title = ?, description = ?, section = ?,
                    exp_per_question = ?, total_bonus_exp = ?, expires_at = ?, is_active = ?
                WHERE quiz_id = ?
            `, [
                simulation_slug,
                title,
                description || null,
                section || null,
                expPerQ,
                totalBonusExp,
                new Date(expires_at),
                is_active !== undefined ? (is_active ? 1 : 0) : 1,
                targetQuizId
            ]);

            // Clear old questions to replace with updated list
            await conn.query(`DELETE FROM elementa_simulation_custom_questions WHERE quiz_id = ?`, [targetQuizId]);
        } else {
            // Deactivate any existing active quizzes for this simulation so only one is active at a time
            await conn.query(`
                UPDATE elementa_simulation_custom_quizzes
                SET is_active = 0
                WHERE simulation_slug = ?
            `, [simulation_slug]);

            // Insert new quiz header
            const [insertResult] = await conn.query(`
                INSERT INTO elementa_simulation_custom_quizzes
                    (simulation_slug, title, description, created_by, section, exp_per_question,
                     total_bonus_exp, expires_at, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                simulation_slug,
                title,
                description || null,
                creatorId,
                section || null,
                expPerQ,
                totalBonusExp,
                new Date(expires_at),
                is_active !== undefined ? (is_active ? 1 : 0) : 1
            ]);
            targetQuizId = insertResult.insertId;
        }

        // Insert questions
        for (let idx = 0; idx < questions.length; idx++) {
            const q = questions[idx];
            const optsJson = q.options ? JSON.stringify(q.options) : null;
            const qExp = parseInt(q.exp_value, 10) || expPerQ;

            await conn.query(`
                INSERT INTO elementa_simulation_custom_questions
                    (quiz_id, question_text, question_type, options_json, correct_answer,
                     tolerance, accepted_synonyms, explanation, order_index, points, exp_value)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                targetQuizId,
                q.question_text,
                q.question_type || 'multiple_choice',
                optsJson,
                String(q.correct_answer ?? '').trim(),
                q.tolerance !== undefined && q.tolerance !== null ? parseFloat(q.tolerance) : 0,
                q.accepted_synonyms ? String(q.accepted_synonyms).trim() : null,
                q.explanation ? String(q.explanation).trim() : null,
                idx,
                q.points ? parseInt(q.points, 10) : 1,
                qExp
            ]);
        }

        await conn.commit();
        return { success: true, quiz_id: targetQuizId };
    } catch (err) {
        await conn.rollback();
        console.error('[simulationQuizService.saveCustomQuiz]', err);
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Toggles a custom quiz's active state.
 */
async function toggleQuizStatus(quizId, isActive) {
    await pool.query(`
        UPDATE elementa_simulation_custom_quizzes
        SET is_active = ?
        WHERE quiz_id = ?
    `, [isActive ? 1 : 0, quizId]);
    return { success: true };
}

/**
 * Deletes a custom quiz.
 */
async function deleteCustomQuiz(quizId) {
    await pool.query(`DELETE FROM elementa_simulation_custom_quizzes WHERE quiz_id = ?`, [quizId]);
    return { success: true };
}

/**
 * Retrieves full telemetry analytics for a specific quiz.
 */
async function getQuizAnalytics(quizId) {
    const [quizRows] = await pool.query(`
        SELECT q.*, u.first_name, u.last_name
        FROM elementa_simulation_custom_quizzes q
        JOIN users u ON q.created_by = u.user_id
        WHERE q.quiz_id = ?
    `, [quizId]);

    if (quizRows.length === 0) {
        throw new Error('Quiz not found.');
    }
    const quiz = quizRows[0];

    // Fetch questions
    const [questions] = await pool.query(`
        SELECT * FROM elementa_simulation_custom_questions
        WHERE quiz_id = ?
        ORDER BY order_index ASC
    `, [quizId]);

    // Fetch submissions with student info
    const [submissions] = await pool.query(`
        SELECT s.*, u.first_name, u.last_name, u.lrn_number, u.section,
               u.total_exp AS current_profile_exp, u.current_level, u.profile_pic
        FROM elementa_simulation_quiz_submissions s
        JOIN users u ON s.student_id = u.user_id
        WHERE s.quiz_id = ?
        ORDER BY s.submitted_at DESC
    `, [quizId]);

    // Calculate Question-Level Accuracy
    const questionStats = questions.map(q => {
        let correctCount = 0;
        let totalAttempts = submissions.length;

        submissions.forEach(sub => {
            let payload = [];
            try {
                payload = typeof sub.answers_payload === 'string' ? JSON.parse(sub.answers_payload) : sub.answers_payload;
            } catch (e) { }

            const match = payload.find(item => item.question_id === q.question_id);
            if (match && match.is_correct) {
                correctCount++;
            }
        });

        const accuracyPct = totalAttempts > 0 ? Math.round((correctCount / totalAttempts) * 100) : 0;
        return {
            question_id: q.question_id,
            question_text: q.question_text,
            question_type: q.question_type,
            correct_answer: q.correct_answer,
            total_attempts: totalAttempts,
            correct_count: correctCount,
            accuracy_percentage: accuracyPct
        };
    });

    // Summary KPIs
    const totalSubmissions = submissions.length;
    const avgScore = totalSubmissions > 0 ? (submissions.reduce((acc, s) => acc + s.score, 0) / totalSubmissions).toFixed(1) : 0;
    const avgPercentage = totalSubmissions > 0 ? Math.round(submissions.reduce((acc, s) => acc + s.percentage, 0) / totalSubmissions) : 0;
    const totalExpGranted = submissions.reduce((acc, s) => acc + s.exp_earned, 0);
    const perfectScores = submissions.filter(s => s.score === s.total_questions).length;

    return {
        quiz,
        questions,
        submissions,
        questionStats,
        kpis: {
            totalSubmissions,
            avgScore,
            avgPercentage,
            totalExpGranted,
            perfectScores
        }
    };
}

/**
 * Lists all 20 simulations along with their current active or latest custom quiz status.
 */
async function getAllSimulationsWithQuizStatus() {
    const [quizzes] = await pool.query(`
        SELECT q.*, u.first_name, u.last_name,
               (SELECT COUNT(*) FROM elementa_simulation_quiz_submissions s WHERE s.quiz_id = q.quiz_id) AS submissions_count,
               (SELECT COUNT(*) FROM elementa_simulation_custom_questions cq WHERE cq.quiz_id = q.quiz_id) AS question_count
        FROM elementa_simulation_custom_quizzes q
        JOIN users u ON q.created_by = u.user_id
        ORDER BY q.created_at DESC
    `);

    // Group by simulation_slug
    const quizMap = {};
    quizzes.forEach(q => {
        if (!quizMap[q.simulation_slug]) {
            quizMap[q.simulation_slug] = q;
        }
    });

    const now = Date.now();

    return SIMULATIONS_REGISTRY.map(sim => {
        const customQuiz = quizMap[sim.slug] || null;
        let status = 'none'; // 'none' | 'active' | 'expired' | 'inactive'
        
        if (customQuiz) {
            const isExpired = new Date(customQuiz.expires_at).getTime() <= now;
            if (!customQuiz.is_active) {
                status = 'inactive';
            } else if (isExpired) {
                status = 'expired';
            } else {
                status = 'active';
            }
        }

        return {
            ...sim,
            status,
            quiz: customQuiz ? {
                quiz_id: customQuiz.quiz_id,
                title: customQuiz.title,
                description: customQuiz.description,
                creator_name: `${customQuiz.first_name} ${customQuiz.last_name}`,
                exp_per_question: customQuiz.exp_per_question,
                total_bonus_exp: customQuiz.total_bonus_exp,
                expires_at: customQuiz.expires_at,
                is_active: customQuiz.is_active === 1,
                question_count: customQuiz.question_count || 0,
                submissions_count: customQuiz.submissions_count || 0
            } : null
        };
    });
}

module.exports = {
    SIMULATIONS_REGISTRY,
    normalizeText,
    isNumericMatch,
    getQuizStatus,
    gradeAndSubmitQuiz,
    saveCustomQuiz,
    toggleQuizStatus,
    deleteCustomQuiz,
    getQuizAnalytics,
    getAllSimulationsWithQuizStatus
};

