/**
 * levelProgressionService.js
 * ============================================================================
 * Centralized Level Progression Service for Elementa Chemistry LMS.
 * 
 * Implements the curriculum-grounded 12-Topic Leveling Formula:
 * 
 *   Total Max EXP = \sum_{i=1}^{12} Max EXP of Topic i
 *   Bracket Size  = Total Max EXP / 12
 *   Student Level = min(12, max(1, floor((total_exp / Total Max EXP) * 12) + 1))
 * 
 * Connects student total_exp directly to their current_level across the LMS,
 * Gradebook, Teacher Reports, Student Profiles, and the Elementa Godot Arcade.
 * ============================================================================
 */

const pool = require('../db');

/**
 * 12 Discrete Cadet Level Titles and Chemical Tier Distinctions
 */
const LEVEL_TITLES = {
    1:  { title: 'Trainee Cadet', tier: 'Cadet', color: '#94a3b8', badgeClass: 'bg-slate-100 text-slate-700' },
    2:  { title: 'Junior Chemist', tier: 'Cadet', color: '#64748b', badgeClass: 'bg-slate-200 text-slate-800' },
    3:  { title: 'Lab Specialist', tier: 'Alkali Earth', color: '#10b981', badgeClass: 'bg-emerald-100 text-emerald-700' },
    4:  { title: 'Formula Analyst', tier: 'Alkali Earth', color: '#059669', badgeClass: 'bg-emerald-200 text-emerald-800' },
    5:  { title: 'Reagent Handler', tier: 'Transition Metal', color: '#0ea5e9', badgeClass: 'bg-sky-100 text-sky-700' },
    6:  { title: 'Molecular Architect', tier: 'Transition Metal', color: '#0284c7', badgeClass: 'bg-sky-200 text-sky-800' },
    7:  { title: 'Force Field Engineer', tier: 'Halogen', color: '#8b5cf6', badgeClass: 'bg-purple-100 text-purple-700' },
    8:  { title: 'Synthesis Technician', tier: 'Halogen', color: '#7c3aed', badgeClass: 'bg-purple-200 text-purple-800' },
    9:  { title: 'Reaction Commander', tier: 'Noble Gas', color: '#f59e0b', badgeClass: 'bg-amber-100 text-amber-700' },
    10: { title: 'Stoichiometry Master', tier: 'Noble Gas', color: '#d97706', badgeClass: 'bg-amber-200 text-amber-800' },
    11: { title: 'District Alchemist', tier: 'Grand Master', color: '#ec4899', badgeClass: 'bg-pink-100 text-pink-700' },
    12: { title: 'Guardian of Elementa', tier: 'Grand Master', color: '#f43f5e', badgeClass: 'bg-rose-100 text-rose-700' }
};

// In-memory cache for Total Max EXP calculations (TTL = 60s)
const maxExpCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

/**
 * Calculates the Total Max EXP by summing the Max EXP of each topic.
 *
 * Formula:
 *   Total Max EXP = \sum_{i=1}^{12} Max EXP of Topic i
 *
 * @param {number|null} subjectId - Optional subject scope (e.g. Chemistry 1 or Chemistry 2)
 * @param {object|null} dbConn - Optional connection for transaction scope
 * @returns {Promise<{ totalMaxExp: number, bracketSize: number, topics: Array, subjectId: number|null }>}
 */
async function calculateTotalMaxExp(subjectId = null, dbConn = null) {
    const cacheKey = subjectId != null ? `subj_${subjectId}` : 'curriculum_all';
    const cached = maxExpCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        return cached.data;
    }

    const conn = dbConn || pool;
    let query = '';
    const params = [];

    if (subjectId != null) {
        query = `
            SELECT 
                t.topic_id,
                t.topic_name,
                qtr.subject_id,
                s.subject_name,
                COUNT(DISTINCT a.assessment_id) AS assessment_count,
                COALESCE(SUM(
                    COALESCE(
                        (SELECT SUM(COALESCE(qb.base_exp, 100)) 
                         FROM elementa_assessment_questions eaq 
                         LEFT JOIN question_bank qb ON eaq.question_id = qb.question_id 
                         WHERE eaq.assessment_id = a.assessment_id),
                        a.total_items * 100,
                        1000
                    )
                ), 0) AS topic_max_exp
            FROM quarters qtr
            JOIN topics t ON qtr.quarter_id = t.quarter_id
            LEFT JOIN subjects s ON qtr.subject_id = s.subject_id
            LEFT JOIN assessments a ON t.topic_id = a.topic_id
            WHERE qtr.subject_id = ?
            GROUP BY t.topic_id, t.topic_name, qtr.subject_id, s.subject_name
            ORDER BY t.topic_id ASC
        `;
        params.push(subjectId);
    } else {
        query = `
            SELECT 
                t.topic_id,
                t.topic_name,
                qtr.subject_id,
                s.subject_name,
                COUNT(DISTINCT a.assessment_id) AS assessment_count,
                COALESCE(SUM(
                    COALESCE(
                        (SELECT SUM(COALESCE(qb.base_exp, 100)) 
                         FROM elementa_assessment_questions eaq 
                         LEFT JOIN question_bank qb ON eaq.question_id = qb.question_id 
                         WHERE eaq.assessment_id = a.assessment_id),
                        a.total_items * 100,
                        1000
                    )
                ), 0) AS topic_max_exp
            FROM topics t
            JOIN quarters qtr ON t.quarter_id = qtr.quarter_id
            LEFT JOIN subjects s ON qtr.subject_id = s.subject_id
            LEFT JOIN assessments a ON t.topic_id = a.topic_id
            GROUP BY t.topic_id, t.topic_name, qtr.subject_id, s.subject_name
            ORDER BY t.topic_id ASC
        `;
    }

    const [rows] = await conn.query(query, params);

    // Sum the Max EXP of each topic to compute Total Max EXP
    let totalMaxExp = 0;
    const formattedTopics = rows.map(r => {
        let topicExp = Number(r.topic_max_exp) || 0;
        // Ensure every topic provides a baseline ceiling (at least 1000 EXP)
        if (topicExp <= 0) {
            topicExp = 1000;
        }
        totalMaxExp += topicExp;
        return {
            topicId: r.topic_id,
            topicName: r.topic_name,
            subjectId: r.subject_id,
            subjectName: r.subject_name,
            assessmentCount: Number(r.assessment_count) || 0,
            maxExp: topicExp
        };
    });

    // Fallback safeguard: default minimum ceiling of 12,000 EXP (1,000 EXP per level)
    if (totalMaxExp <= 0) {
        totalMaxExp = 12000;
    }

    const bracketSize = Math.max(1, Math.round(totalMaxExp / 12));

    const result = {
        totalMaxExp,
        bracketSize,
        subjectId,
        topicCount: formattedTopics.length,
        topics: formattedTopics
    };

    maxExpCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
}

/**
 * Computes a student's level and progression metrics from their total_exp.
 *
 * Level Formula:
 *   Level = min(12, max(1, floor((total_exp / Total Max EXP) * 12) + 1))
 *
 * @param {number} totalExp - Student's current cumulative EXP
 * @param {number} totalMaxExp - Total Max EXP ceiling across the 12 topics
 * @returns {object} Level progression metrics
 */
function computeLevelFromExp(totalExp = 0, totalMaxExp = 12000) {
    const exp = Math.max(0, Number(totalExp) || 0);
    const maxExp = Math.max(1, Number(totalMaxExp) || 12000);
    const bracketSize = Math.max(1, Math.round(maxExp / 12));

    let level = 1;
    if (exp >= maxExp) {
        level = 12;
    } else {
        level = Math.min(12, Math.max(1, Math.floor((exp / maxExp) * 12) + 1));
    }

    const lowerThreshold = (level - 1) * bracketSize;
    const upperThreshold = level === 12 ? maxExp : level * bracketSize;
    const expInLevel = Math.max(0, exp - lowerThreshold);
    const expToNextLevel = Math.max(0, upperThreshold - exp);
    const progressPct = level === 12 ? 100 : Math.min(100, Math.max(0, Math.round((expInLevel / bracketSize) * 100)));

    return {
        level,
        totalExp: exp,
        totalMaxExp: maxExp,
        bracketSize,
        lowerThreshold,
        upperThreshold,
        expInLevel,
        expToNextLevel,
        progressPct,
        levelTitle: LEVEL_TITLES[level]?.title || 'Trainee Cadet',
        tier: LEVEL_TITLES[level]?.tier || 'Cadet',
        color: LEVEL_TITLES[level]?.color || '#94a3b8',
        badgeClass: LEVEL_TITLES[level]?.badgeClass || 'bg-slate-100 text-slate-700'
    };
}

/**
 * Retrieves comprehensive level stats for a student.
 * Automatically resolves the student's primary subject enrollment.
 *
 * @param {number} studentId
 * @param {number|null} subjectId
 * @param {object|null} dbConn
 * @returns {Promise<object>} Complete student level stats
 */
async function getStudentLevelStats(studentId, subjectId = null, dbConn = null) {
    const conn = dbConn || pool;

    // 1. Fetch student user data
    const [[user]] = await conn.query(
        `SELECT user_id, first_name, last_name, current_level, total_exp, grade_level, section 
         FROM users WHERE user_id = ?`,
        [studentId]
    );

    if (!user) {
        throw new Error(`Student ${studentId} not found`);
    }

    // 2. Resolve subject scope if not explicitly passed
    let effectiveSubjectId = subjectId;
    if (effectiveSubjectId == null) {
        const [[enrolledSubj]] = await conn.query(`
            SELECT c.subject_id 
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            WHERE cs.student_id = ?
            ORDER BY c.class_id ASC LIMIT 1
        `, [studentId]);
        effectiveSubjectId = enrolledSubj?.subject_id || null;
    }

    // 3. Compute Total Max EXP
    const maxExpData = await calculateTotalMaxExp(effectiveSubjectId, conn);

    // 4. Calculate Level Metrics
    const levelMetrics = computeLevelFromExp(user.total_exp, maxExpData.totalMaxExp);

    return {
        userId: user.user_id,
        name: `${user.first_name} ${user.last_name}`,
        gradeLevel: user.grade_level,
        section: user.section,
        subjectId: effectiveSubjectId,
        storedLevel: user.current_level,
        calculatedLevel: levelMetrics.level,
        ...levelMetrics,
        topics: maxExpData.topics
    };
}

/**
 * Recalculates and updates a student's current_level in the users table based on their total_exp.
 * Call this whenever a student's EXP increases.
 *
 * @param {number} studentId
 * @param {object|null} dbConn - Optional connection for transaction scope
 * @returns {Promise<object>} Updated level progression stats
 */
async function recalculateStudentLevel(studentId, dbConn = null) {
    const conn = dbConn || pool;

    const stats = await getStudentLevelStats(studentId, null, conn);
    const newLevel = stats.calculatedLevel;

    // Update users table with calculated level
    await conn.query(
        `UPDATE users SET current_level = ? WHERE user_id = ?`,
        [newLevel, studentId]
    );

    return {
        userId: studentId,
        current_level: newLevel,
        total_exp: stats.totalExp,
        total_max_exp: stats.totalMaxExp,
        bracket_size: stats.bracketSize,
        progress_pct: stats.progressPct,
        level_title: stats.levelTitle,
        tier: stats.tier
    };
}

/**
 * Batch recalibration: Recomputes and updates current_level for all students in the database.
 * Ideal for migrations or system updates.
 *
 * @param {object|null} dbConn
 * @returns {Promise<{ updatedCount: number, students: Array }>}
 */
async function recalibrateAllStudents(dbConn = null) {
    const conn = dbConn || pool;
    const [students] = await conn.query(
        `SELECT user_id, first_name, last_name, total_exp, current_level FROM users WHERE role = 'Student'`
    );

    const updated = [];
    for (const s of students) {
        const result = await recalculateStudentLevel(s.user_id, conn);
        updated.push({
            userId: s.user_id,
            name: `${s.first_name} ${s.last_name}`,
            oldLevel: s.current_level,
            newLevel: result.current_level,
            totalExp: result.total_exp,
            totalMaxExp: result.total_max_exp
        });
    }

    return {
        updatedCount: updated.length,
        students: updated
    };
}

module.exports = {
    LEVEL_TITLES,
    calculateTotalMaxExp,
    computeLevelFromExp,
    getStudentLevelStats,
    recalculateStudentLevel,
    recalibrateAllStudents
};

