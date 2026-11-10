/**
 * utils/gradebookHelper.js
 * ============================================================================
 * Shared Master Class Gradebook & Assessment Analytics Calculation Engine.
 * 
 * Centralized calculation service for:
 *   - Teacher Gradebook exports (Excel & PDF)
 *   - Admin Class Performance Report exports (PDF & Web preview)
 *   - DepEd DO 8 Quarterly & Semestral composite calculations
 *   - General Chemistry 1 & 2 Quarter segregation:
 *       * Chemistry 1 (Semester 1): Quarters 1 & 2 -> Semestral Grade -> Chem 2 Prerequisite Gate
 *       * Chemistry 2 (Semester 2): Quarters 3 & 4 -> Semestral Grade -> Senior High Completion Standing
 *   - Elementa Interactive Simulations (Virtual Labs & Post-Lab Quiz EXP)
 *   - Attendance & Task Completion tracking
 * ============================================================================
 */

const db = require('../db');
const academicHelper = require('./academicHelper');

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

const SIMULATION_TITLE_MAP = {
    'build-an-atom': 'Build an Atom (Atomic Structure & Subatomic Particles)',
    'isotopes-and-atomic-mass': 'Isotopes and Atomic Mass (Isotopic Abundance)',
    'models-of-the-hydrogen-atom': 'Models of the Hydrogen Atom (Quantum Emission)',
    'rutherford-scattering': 'Rutherford Scattering (Nuclear Atom Model)',
    'states-of-matter': 'States of Matter (Phase Transitions & Thermal Kinetic)',
    'states-of-matter-basics': 'States of Matter: Basics (Thermal Expansion)',
    'density': 'Density Laboratory (Mass, Volume & Buoyancy)',
    'molecules-and-light': 'Molecules and Light (Photonic Absorption)',
    'blackbody-spectrum': 'Blackbody Spectrum (Planck Radiation Law)',
    'build-a-molecule': 'Build a Molecule (Covalent Bonding & Stoichiometry)',
    'molecule-shapes': 'Molecule Shapes (VSEPR Geometry & Bond Angles)',
    'molecule-shapes-basics': 'Molecule Shapes: Basics (Molecular Geometry)',
    'molecule-polarity': 'Molecule Polarity (Electronegativity & Dipole)',
    'atomic-interactions': 'Atomic Interactions (Van der Waals & London Forces)',
    'balancing-chemical-equations': 'Balancing Chemical Equations (Conservation of Mass)',
    'reactants-products-and-leftovers': 'Reactants, Products and Leftovers (Limiting Reagents)',
    'acid-base-solutions': 'Acid-Base Solutions (pH Scale & Autoionization)',
    'concentration': 'Concentration Lab (Solute Dissolution & Dilution)',
    'molarity': 'Molarity Lab (Molar Concentration Calculations)',
    'beers-law-lab': "Beer's Law Lab (Absorbance & Transmittance)"
};

/**
 * Shared Helper: Compute Master Class Gradebook & Assessment Summary Data
 * Evaluates comprehensive class standing across Coursework (Written Works, Performance Tasks, Forums),
 * Interactive Simulations (Arcade & Lab Quizzes), Attendance, and DepEd 75% Passing Threshold.
 * Scoped to a specific class (or all classes taught by teacher).
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
        SELECT c.class_id, c.class_name, c.subject_id, c.teacher_id, s.subject_name, s.subject_code, s.semester, sy.sy_range,
               CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
               COALESCE((SELECT GROUP_CONCAT(DISTINCT q.quarter_number ORDER BY q.quarter_number) FROM quarters q WHERE q.subject_id = c.subject_id), '1,2') AS quarters
        FROM classes c
        JOIN subjects s ON c.subject_id = s.subject_id
        JOIN school_years sy ON c.sy_id = sy.sy_id
        LEFT JOIN users u ON u.user_id = c.teacher_id
    `;
    const classParams = [];
    if (teacherId) {
        classQuery += ` WHERE c.teacher_id = ?`;
        classParams.push(teacherId);
    } else {
        classQuery += ` WHERE 1=1`;
    }

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

        // 7. Fetch Simulation Laboratory Quiz Submissions (Scoped to Class SY & Effective Quarter)
        if (studentIds.length > 0) {
            const clsSyId = cls.sy_id || null;
            const [sims] = await dbConn.query(`
                SELECT esqs.student_id, esqs.quiz_id, esqs.simulation_slug, esqs.score, esqs.total_questions,
                       esqs.percentage, esqs.exp_earned
                FROM elementa_simulation_quiz_submissions esqs
                WHERE esqs.student_id IN (?)
                  AND (? IS NULL OR esqs.sy_id = ?)
            `, [studentIds, clsSyId, clsSyId]);

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
                    simCount: qSims.length,
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
                sim: { count: simList.length, avg: arcadeAvg, exp: totalSimBonusExp },

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
 * Shared Helper: Compute Comprehensive Granular Dossier for an Individual Student
 * Tailored for Landscape A4 Student Dossier PDF and Granular Academic Profiling.
 *
 * @param {object} dbConn - MySQL pool or connection
 * @param {number} studentId - Target user_id
 * @param {number|null} classId - Optional specific class_id
 * @param {object} options - Optional config
 * @returns {Promise<object|null>}
 */
async function computeStudentGranularDossier(dbConn, studentId, classId = null, options = {}) {
    const sid = parseInt(studentId, 10);
    if (isNaN(sid)) return null;

    // 1. Fetch Student Profile
    const [[student]] = await dbConn.query(`
        SELECT
            user_id, first_name, middle_name, last_name, email,
            role, grade_level, section, strand, lrn_number,
            current_level, total_exp, sex, birthdate,
            mobile_number, city_town, profile_pic, created_at
        FROM users
        WHERE user_id = ? AND role = 'Student'
        LIMIT 1
    `, [sid]);

    if (!student) return null;

    const fullName = `${student.last_name}, ${student.first_name}${student.middle_name ? ' ' + student.middle_name[0] + '.' : ''}`;

    // 2. Resolve Class Enrollment & Subject Context
    let cls = null;
    if (classId) {
        const cid = parseInt(classId, 10);
        if (!isNaN(cid)) {
            const [[foundClass]] = await dbConn.query(`
                SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id, c.sy_id,
                       s.subject_name, s.semester, sy.sy_range,
                       CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                       t.email AS teacher_email
                FROM classes c
                JOIN class_students cs ON cs.class_id = c.class_id
                JOIN subjects s ON s.subject_id = c.subject_id
                LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
                LEFT JOIN users t ON t.user_id = c.teacher_id
                WHERE cs.student_id = ? AND c.class_id = ?
                LIMIT 1
            `, [sid, cid]);
            if (foundClass) cls = foundClass;
        }
    }

    if (!cls) {
        const [[foundClass]] = await dbConn.query(`
            SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id, c.sy_id,
                   s.subject_name, s.semester, sy.sy_range,
                   CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                   t.email AS teacher_email
            FROM class_students cs
            JOIN classes c ON c.class_id = cs.class_id
            JOIN subjects s ON s.subject_id = c.subject_id
            LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
            LEFT JOIN users t ON t.user_id = c.teacher_id
            WHERE cs.student_id = ?
            ORDER BY (sy.is_active = 1) DESC, c.class_id DESC
            LIMIT 1
        `, [sid]);
        if (foundClass) cls = foundClass;
    }

    if (!cls) {
        const [[defaultSubj]] = await dbConn.query(`
            SELECT s.subject_id, s.subject_name, s.semester,
                   (SELECT sy_range FROM school_years WHERE is_active = 1 LIMIT 1) AS sy_range,
                   (SELECT sy_id FROM school_years WHERE is_active = 1 LIMIT 1) AS sy_id
            FROM subjects s
            WHERE s.subject_name LIKE '%Chemistry%'
            ORDER BY s.subject_id ASC
            LIMIT 1
        `);
        cls = {
            class_id: null,
            class_name: student.section || 'General Class',
            teacher_id: null,
            teacher_name: 'Subject Teacher',
            teacher_email: '',
            subject_id: defaultSubj ? defaultSubj.subject_id : 1,
            subject_name: defaultSubj ? defaultSubj.subject_name : 'General Chemistry 1',
            semester: defaultSubj ? defaultSubj.semester : 1,
            sy_id: defaultSubj ? defaultSubj.sy_id : null,
            sy_range: defaultSubj ? defaultSubj.sy_range : 'Current SY'
        };
    }

    const isSem1 = Number(cls.semester) === 1 || (cls.subject_name && cls.subject_name.toLowerCase().includes('chemistry 1'));
    const targetQuarters = isSem1 ? [1, 2] : [3, 4];

    // 3. Fetch Syllabus Progress & Interactions Count
    const clsSyId = cls.sy_id || null;
    const [[progRow]] = await dbConn.query(
        `SELECT progress_percent FROM student_progress WHERE student_id = ? AND subject_id = ? AND (? IS NULL OR sy_id = ?) LIMIT 1`,
        [sid, cls.subject_id, clsSyId, clsSyId]
    );
    const syllabusProgress = progRow ? Number(progRow.progress_percent || 0) : 0;

    const [[intRow]] = await dbConn.query(
        `SELECT COUNT(*) AS cnt FROM student_material_interactions WHERE student_id = ?`,
        [sid]
    );
    const interactionCount = intRow ? Number(intRow.cnt || 0) : 0;

    // 4. Fetch All Quarters and Topics for this Subject
    const [quartersRaw] = await dbConn.query(
        `SELECT quarter_id, quarter_number FROM quarters WHERE subject_id = ? ORDER BY quarter_number ASC`,
        [cls.subject_id]
    );
    const quarterIdMap = new Map();
    quartersRaw.forEach(q => quarterIdMap.set(q.quarter_number, q.quarter_id));

    const quarterResults = {};
    const validQuarterGrades = [];

    for (const qNum of targetQuarters) {
        const qId = quarterIdMap.get(qNum);
        if (!qId) {
            quarterResults[qNum] = {
                quarter_number: qNum,
                quarter_name: `Quarter ${qNum}`,
                quarter_grade: null,
                standing: 'Incomplete',
                is_passed: false,
                kpis: { quarter_grade: null, written_works_pct: null, performance_tasks_pct: null, forums_pct: null, virtual_labs_pct: null, progress_pct: syllabusProgress, level: student.current_level || 1, total_exp: student.total_exp || 0 },
                writtenWorks: [],
                performanceTasks: [],
                forums: [],
                simulations: []
            };
            continue;
        }

        // 4a. Topics for Quarter
        const [topics] = await dbConn.query(
            `SELECT topic_id, topic_name FROM topics WHERE quarter_id = ? ORDER BY topic_id ASC`,
            [qId]
        );
        const topicIds = topics.map(t => t.topic_id);

        let asmtsRaw = [];
        let forumsRaw = [];

        if (topicIds.length > 0) {
            const [asmtList] = await dbConn.query(`
                SELECT a.assessment_id, a.quarter_id, a.topic_id, a.assessment_name,
                       a.assessment_type, a.total_items, a.due_date, a.allow_grace,
                       a.grace_period_minutes, a.created_at, t.topic_name
                FROM assessments a
                JOIN topics t ON a.topic_id = t.topic_id
                WHERE a.topic_id IN (?) AND (a.sy_id = ? OR a.sy_id IS NULL)
                ORDER BY a.assessment_id ASC
            `, [topicIds, cls.sy_id]);
            asmtsRaw = asmtList;

            const [forumList] = await dbConn.query(`
                SELECT ft.forum_id, ft.title AS topic_title, ft.topic_id, t.quarter_id, t.topic_name, ft.created_at
                FROM forum_topics ft
                JOIN topics t ON ft.topic_id = t.topic_id
                WHERE (? IS NULL OR ft.class_id = ? OR ft.class_id IS NULL) AND t.quarter_id = ?
                ORDER BY ft.forum_id ASC
            `, [cls.class_id, cls.class_id, qId]);
            forumsRaw = forumList;
        }

        const asmtIds = asmtsRaw.map(a => a.assessment_id);

        // 4b. Fetch Student Scores for this quarter's assessments
        let scoresMap = new Map();
        let arcadeMap = new Map();

        if (asmtIds.length > 0) {
            const [scores] = await dbConn.query(`
                SELECT ss.assessment_id, ss.score_obtained, ss.total_possible_score,
                       ss.total_items, ss.exp_gained, ss.feedback, ss.submitted_at,
                       ss.date_recorded, ss.is_grace_period, ss.attempt_number,
                       ss.original_filename
                FROM student_scores ss
                WHERE ss.student_id = ? AND ss.assessment_id IN (?)
            `, [sid, asmtIds]);
            scores.forEach(s => scoresMap.set(s.assessment_id, s));

            const [arcScores] = await dbConn.query(`
                SELECT esg.assessment_id, esg.correct_answers AS score_obtained,
                       esg.points_possible AS total_items, esg.points_earned AS exp_gained,
                       esg.grade_percent, esg.started_at
                FROM elementa_student_grades esg
                WHERE esg.student_id = ? AND esg.assessment_id IN (?) AND esg.run_status = 'Completed'
            `, [sid, asmtIds]);
            arcScores.forEach(a => arcadeMap.set(a.assessment_id, a));
        }

        // 4c. Fetch Forum completions & replies
        const forumIds = forumsRaw.map(f => f.forum_id);
        const forumDoneMap = new Map();
        const forumReplyMap = new Map();

        if (forumIds.length > 0) {
            const [fDone] = await dbConn.query(`
                SELECT sfd.forum_id, sfd.exp_awarded, sfd.done_at AS created_at
                FROM student_forum_done sfd
                WHERE sfd.student_id = ? AND sfd.forum_id IN (?)
            `, [sid, forumIds]);
            fDone.forEach(fd => forumDoneMap.set(fd.forum_id, fd));

            const [fReplies] = await dbConn.query(`
                SELECT fr.topic_id AS forum_id, COUNT(*) AS cnt
                FROM forum_replies fr
                WHERE fr.user_id = ? AND fr.topic_id IN (?)
                GROUP BY fr.topic_id
            `, [sid, forumIds]);
            fReplies.forEach(fr => forumReplyMap.set(fr.forum_id, Number(fr.cnt || 0)));
        }

        // 4d. Fetch Virtual Simulations for Quarter Q
        const quarterSimSlugs = Object.entries(SIMULATION_QUARTER_MAP)
            .filter(([_, q]) => q === qNum)
            .map(([slug, _]) => slug);

        let activeQuizzesMap = new Map();
        let simSubmissionsMap = new Map();

        if (quarterSimSlugs.length > 0) {
            // Only fetch simulation quizzes for this class's School Year that actually have questions created!
            const [activeQuizzes] = await dbConn.query(`
                SELECT q.simulation_slug, q.quiz_id, q.title, COUNT(ques.question_id) AS question_count
                FROM elementa_simulation_custom_quizzes q
                JOIN elementa_simulation_custom_questions ques ON ques.quiz_id = q.quiz_id
                WHERE q.simulation_slug IN (?)
                  AND q.is_active = 1
                  AND (? IS NULL OR q.sy_id = ?)
                GROUP BY q.quiz_id, q.simulation_slug
                HAVING question_count > 0
            `, [quarterSimSlugs, clsSyId, clsSyId]);

            activeQuizzes.forEach(aq => {
                if (!activeQuizzesMap.has(aq.simulation_slug)) {
                    activeQuizzesMap.set(aq.simulation_slug, aq);
                }
            });

            const [simSubs] = await dbConn.query(`
                SELECT esqs.quiz_id, esqs.simulation_slug, esqs.score, esqs.total_questions,
                       esqs.percentage, esqs.exp_earned, esqs.submitted_at
                FROM elementa_simulation_quiz_submissions esqs
                WHERE esqs.student_id = ?
                  AND esqs.simulation_slug IN (?)
                  AND (? IS NULL OR esqs.sy_id = ?)
                ORDER BY esqs.submitted_at DESC
            `, [sid, quarterSimSlugs, clsSyId, clsSyId]);

            simSubs.forEach(s => {
                if (!simSubmissionsMap.has(s.simulation_slug)) {
                    simSubmissionsMap.set(s.simulation_slug, s);
                }
            });
        }

        // Filter quarter simulations: ONLY include simulations that have custom questions created OR student submissions!
        const configuredSimSlugs = quarterSimSlugs.filter(slug => activeQuizzesMap.has(slug) || simSubmissionsMap.has(slug));

        // ── Synthesize Written Works ─────────────────────────────────────────
        const writtenWorks = [];
        let asmtScoreSum = 0;
        let asmtTotalSum = 0;
        let asmtExpSum = 0;
        let asmtTakenCount = 0;

        asmtsRaw.filter(a => a.assessment_type !== 'Assignment').forEach((asmt, idx) => {
            const sc = scoresMap.get(asmt.assessment_id);
            const arc = arcadeMap.get(asmt.assessment_id);
            const totalItems = Number(asmt.total_items) || (sc ? Number(sc.total_possible_score || sc.total_items) : 10);

            let score = null;
            let scorePct = null;
            let dateTaken = null;
            let exp = 0;
            let status = 'UNTAKEN';

            if (sc && sc.score_obtained !== null) {
                score = Number(sc.score_obtained);
                scorePct = totalItems > 0 ? Math.round((score / totalItems) * 1000) / 10 : 0;
                dateTaken = sc.submitted_at || sc.date_recorded;
                exp = Number(sc.exp_gained || 0);
                status = scorePct >= 75 ? 'PASSED' : 'FAILED';
                asmtScoreSum += score;
                asmtTotalSum += totalItems;
                asmtExpSum += exp;
                asmtTakenCount++;
            } else if (arc && arc.score_obtained !== null) {
                score = Number(arc.score_obtained);
                scorePct = Number(arc.grade_percent || 0);
                dateTaken = arc.started_at;
                exp = Number(arc.exp_gained || 0);
                status = scorePct >= 75 ? 'PASSED' : 'FAILED';
                asmtScoreSum += score;
                asmtTotalSum += totalItems;
                asmtExpSum += exp;
                asmtTakenCount++;
            }

            writtenWorks.push({
                index: idx + 1,
                assessment_id: asmt.assessment_id,
                assessment_name: asmt.assessment_name,
                topic_name: asmt.topic_name,
                date_taken: dateTaken ? new Date(dateTaken).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
                score_obtained: score,
                total_items: totalItems,
                score_pct: scorePct,
                status,
                exp_gained: exp
            });
        });

        // ── Synthesize Performance Tasks (Assignments) ──────────────────────
        const performanceTasks = [];
        let asgnScoreSum = 0;
        let asgnTotalSum = 0;
        let asgnExpSum = 0;
        let asgnTakenCount = 0;

        asmtsRaw.filter(a => a.assessment_type === 'Assignment').forEach((asgn, idx) => {
            const sc = scoresMap.get(asgn.assessment_id);
            const totalItems = Number(asgn.total_items) || (sc ? Number(sc.total_possible_score || sc.total_items) : 100);

            let score = null;
            let scorePct = null;
            let submittedAt = null;
            let attemptNumber = 1;
            let isGrace = false;
            let exp = 0;
            let status = 'UNSUBMITTED';
            let originalFilename = null;

            if (sc) {
                attemptNumber = sc.attempt_number || 1;
                isGrace = sc.is_grace_period === 1 || sc.is_grace_period === true;
                originalFilename = sc.original_filename || null;
                submittedAt = sc.submitted_at || sc.date_recorded;

                if (sc.score_obtained !== null) {
                    score = Number(sc.score_obtained);
                    scorePct = totalItems > 0 ? Math.round((score / totalItems) * 1000) / 10 : 0;
                    exp = Number(sc.exp_gained || 0);
                    status = scorePct >= 75 ? 'PASSED' : 'FAILED';
                    asgnScoreSum += score;
                    asgnTotalSum += totalItems;
                    asgnExpSum += exp;
                    asgnTakenCount++;
                } else if (submittedAt) {
                    status = 'PENDING_GRADING';
                }
            }

            performanceTasks.push({
                index: idx + 1,
                assessment_id: asgn.assessment_id,
                assessment_name: asgn.assessment_name,
                topic_name: asgn.topic_name,
                due_date: asgn.due_date ? new Date(asgn.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
                submitted_at: submittedAt ? new Date(submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
                attempt_number: attemptNumber,
                is_grace_period: isGrace,
                original_filename: originalFilename,
                score_obtained: score,
                total_items: totalItems,
                score_pct: scorePct,
                status,
                exp_gained: exp
            });
        });

        // ── Synthesize Forums ────────────────────────────────────────────────
        const forums = [];
        let forumsDoneCount = 0;
        let forumExpSum = 0;

        forumsRaw.forEach((f, idx) => {
            const fd = forumDoneMap.get(f.forum_id);
            const replies = forumReplyMap.get(f.forum_id) || 0;
            const isDone = !!fd;
            const exp = fd ? Number(fd.exp_awarded || 0) : 0;
            if (isDone) {
                forumsDoneCount++;
                forumExpSum += exp;
            }

            forums.push({
                index: idx + 1,
                forum_id: f.forum_id,
                topic_title: f.topic_title,
                topic_name: f.topic_name,
                is_completed: isDone,
                reply_count: replies,
                exp_awarded: exp,
                completed_at: fd && fd.created_at ? new Date(fd.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
                status: isDone ? 'COMPLETED' : 'PENDING'
            });
        });

        // ── Synthesize Virtual Simulations ──────────────────────────────────
        // Only include simulations that have active custom questions created or student submissions
        const simulations = [];
        let simPctSum = 0;
        let simTakenCount = 0;
        let simExpSum = 0;

        configuredSimSlugs.forEach((slug, idx) => {
            const title = SIMULATION_TITLE_MAP[slug] || slug.replace(/-/g, ' ').toUpperCase();
            const sub = simSubmissionsMap.get(slug);
            const qInfo = activeQuizzesMap.get(slug);

            let score = null;
            let totalQ = qInfo ? Number(qInfo.question_count) : (sub ? Number(sub.total_questions || 1) : 1);
            let pct = null;
            let exp = 0;
            let completedAt = null;
            let status = 'UNTAKEN';

            if (sub) {
                score = Number(sub.score || 0);
                totalQ = Number(sub.total_questions || totalQ);
                pct = Number(sub.percentage != null ? sub.percentage : (totalQ > 0 ? (score / totalQ) * 100 : 0));
                pct = Math.round(pct * 10) / 10;
                exp = Number(sub.exp_earned || 0);
                completedAt = sub.submitted_at;
                status = pct >= 90 ? 'MASTERY' : (pct >= 75 ? 'PASSED' : 'RETRY');
                simPctSum += pct;
                simTakenCount++;
                simExpSum += exp;
            }

            simulations.push({
                index: idx + 1,
                simulation_slug: slug,
                simulation_title: title,
                score,
                total_questions: totalQ,
                percentage: pct,
                exp_earned: exp,
                completed_at: completedAt ? new Date(completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
                status
            });
        });

        // ── DepEd Quarter Grade Computation ──────────────────────────────────
        const asmtPct = asmtTotalSum > 0 ? (asmtScoreSum / asmtTotalSum) * 100 : null;
        const asgnPct = asgnTotalSum > 0 ? (asgnScoreSum / asgnTotalSum) * 100 : null;
        const forumPct = forumsRaw.length > 0 ? (forumsDoneCount / forumsRaw.length) * 100 : null;
        const simAvg = simTakenCount > 0 ? simPctSum / simTakenCount : null;

        // Weighting: 70% Coursework + 30% Simulation
        const courseworkComponents = [asmtPct, asgnPct, forumPct].filter(p => p !== null);
        const courseworkPct = courseworkComponents.length > 0
            ? courseworkComponents.reduce((a, b) => a + b, 0) / courseworkComponents.length
            : null;

        let finalQuarterGrade = null;
        if (courseworkPct !== null && simAvg !== null) {
            finalQuarterGrade = Math.round(((courseworkPct * 0.70) + (simAvg * 0.30)) * 10) / 10;
        } else if (courseworkPct !== null) {
            finalQuarterGrade = Math.round(courseworkPct * 10) / 10;
        } else if (simAvg !== null) {
            finalQuarterGrade = Math.round(simAvg * 10) / 10;
        }

        const isPassed = finalQuarterGrade !== null && finalQuarterGrade >= 75;
        const standing = finalQuarterGrade === null ? 'Incomplete' : (isPassed ? 'Passed' : 'At-Risk');

        if (finalQuarterGrade !== null) {
            validQuarterGrades.push(finalQuarterGrade);
        }

        quarterResults[qNum] = {
            quarter_number: qNum,
            quarter_name: `Quarter ${qNum}`,
            quarter_grade: finalQuarterGrade,
            standing,
            is_passed: isPassed,
            kpis: {
                quarter_grade: finalQuarterGrade,
                written_works_pct: asmtPct !== null ? Math.round(asmtPct * 10) / 10 : null,
                performance_tasks_pct: asgnPct !== null ? Math.round(asgnPct * 10) / 10 : null,
                forums_pct: forumPct !== null ? Math.round(forumPct * 10) / 10 : null,
                virtual_labs_pct: simAvg !== null ? Math.round(simAvg * 10) / 10 : null,
                progress_pct: syllabusProgress,
                level: student.current_level || 1,
                total_exp: student.total_exp || (asmtExpSum + asgnExpSum + forumExpSum + simExpSum)
            },
            summaries: {
                asmt: { score: asmtScoreSum, total: asmtTotalSum, count: asmtsRaw.filter(a => a.assessment_type !== 'Assignment').length, submitted: asmtTakenCount, exp: asmtExpSum },
                asgn: { score: asgnScoreSum, total: asgnTotalSum, count: asmtsRaw.filter(a => a.assessment_type === 'Assignment').length, submitted: asgnTakenCount, exp: asgnExpSum },
                forum: { completed: forumsDoneCount, total: forumsRaw.length, exp: forumExpSum },
                sim: { count: simTakenCount, total: configuredSimSlugs.length, avg: simAvg !== null ? Math.round(simAvg * 10) / 10 : null, exp: simExpSum }
            },
            writtenWorks,
            performanceTasks,
            forums,
            simulations
        };
    }

    // 5. Compute Semestral Composite Grade & Chemistry 2 Prerequisite Gate
    const semestralGrade = validQuarterGrades.length > 0
        ? Math.round((validQuarterGrades.reduce((a, b) => a + b, 0) / validQuarterGrades.length) * 10) / 10
        : null;

    let chem2Eligibility = null;
    if (isSem1) {
        if (semestralGrade !== null) {
            const isEligible = semestralGrade >= 75.0;
            chem2Eligibility = {
                status: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
                threshold: 75.0,
                chem1Grade: semestralGrade,
                reason: isEligible
                    ? `Prerequisite Satisfied: Student achieved a cumulative final average of ${semestralGrade}% in General Chemistry 1, meeting the DepEd minimum passing threshold of 75.0% required for General Chemistry 2.`
                    : `Prerequisite Requirement Not Met: Cumulative final average in General Chemistry 1 is ${semestralGrade}%, which is below the DepEd 75.0% passing threshold.`
            };
        } else {
            chem2Eligibility = {
                status: 'PENDING_QUARTERS',
                threshold: 75.0,
                chem1Grade: null,
                reason: 'Prerequisite Gate Evaluation Pending: Quarter grades for General Chemistry 1 are currently in progress.'
            };
        }
    } else {
        chem2Eligibility = {
            status: semestralGrade !== null ? (semestralGrade >= 75 ? 'COMPLETED' : 'AT-RISK') : 'PENDING_QUARTERS',
            threshold: 75.0,
            chem1Grade: semestralGrade,
            reason: semestralGrade !== null
                ? `Senior High Chemistry Standing: Cumulative semester final grade is ${semestralGrade}%.`
                : 'Evaluation Pending: Semester 2 grading is in progress.'
        };
    }

    return {
        student: {
            user_id: student.user_id,
            lrn_number: student.lrn_number || '—',
            first_name: student.first_name,
            middle_name: student.middle_name,
            last_name: student.last_name,
            full_name: fullName,
            email: student.email || '—',
            grade_level: student.grade_level || 'Grade 12',
            section: student.section || 'STEM',
            strand: student.strand || 'STEM',
            sex: student.sex || '—',
            birthdate: student.birthdate ? new Date(student.birthdate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
            mobile_number: student.mobile_number || '—',
            city_town: student.city_town || '—',
            current_level: student.current_level || 1,
            total_exp: student.total_exp || 0,
            profile_pic: student.profile_pic || 'default_avatar.png',
            interaction_count: interactionCount
        },
        classInfo: {
            class_id: cls.class_id,
            class_name: cls.class_name,
            teacher_id: cls.teacher_id,
            teacher_name: cls.teacher_name,
            teacher_email: cls.teacher_email,
            subject_id: cls.subject_id,
            subject_name: cls.subject_name,
            semester: cls.semester,
            sy_id: cls.sy_id,
            sy_range: cls.sy_range,
            is_sem1: isSem1
        },
        targetQuarters,
        quarters: quarterResults,
        semestral_grade: semestralGrade,
        chem2_eligibility: chem2Eligibility
    };
}

module.exports = {
    SIMULATION_QUARTER_MAP,
    SIMULATION_TITLE_MAP,
    computeClassGradebookData,
    computeStudentGranularDossier,
    sanitizeGradebookQueryParams
};
