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

        // 7. Fetch Simulation Laboratory Quiz Submissions (Scoped to Effective Quarter or Class Subject's Valid Quarters)
        if (studentIds.length > 0) {
            const [sims] = await dbConn.query(`
                SELECT esqs.student_id, esqs.quiz_id, esqs.simulation_slug, esqs.score, esqs.total_questions,
                       esqs.percentage, esqs.exp_earned
                FROM elementa_simulation_quiz_submissions esqs
                WHERE esqs.student_id IN (?)
            `, [studentIds]);

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
 * Shared Helper: Fetch Filtered Report Data For A Student in a Class & Subject
 */

module.exports = {
    SIMULATION_QUARTER_MAP,
    computeClassGradebookData,
    sanitizeGradebookQueryParams
};
