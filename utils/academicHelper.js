/**
 * utils/academicHelper.js
 * Centralized business logic for Academic Timeline, Enrollment Windows,
 * Grade Encoding Deadlines, and Chemistry 1 -> Chemistry 2 Prerequisite Verification.
 */

/**
 * Fetch the currently active School Year with all attributes.
 * @param {object} db - MySQL database connection/pool
 * @returns {Promise<object|null>}
 */
async function getActiveSchoolYear(db) {
    const [[activeSY]] = await db.query(
        `SELECT * FROM school_years WHERE is_active = 1 LIMIT 1`
    );
    if (activeSY) return activeSY;

    // Fallback to latest created if none active
    const [[latestSY]] = await db.query(
        `SELECT * FROM school_years ORDER BY sy_id DESC LIMIT 1`
    );
    return latestSY || null;
}

/**
 * Evaluates whether an institutional enrollment window is currently open for a semester.
 * @param {object} schoolYear - school_years row
 * @param {number|string} semester - 1 or 2
 * @param {Date} [currentDate] - override for testing
 * @returns {object} { isOpen: boolean, status: string, message: string, start: Date|null, end: Date|null }
 */
function isSemesterEnrollmentOpen(schoolYear, semester, currentDate = new Date()) {
    if (!schoolYear) {
        return { isOpen: true, status: 'unrestricted', message: 'No school year timeline configured.' };
    }

    const semNum = parseInt(semester, 10);
    const startRaw = semNum === 2 ? schoolYear.sem2_enrollment_start : schoolYear.sem1_enrollment_start;
    const endRaw   = semNum === 2 ? schoolYear.sem2_enrollment_end   : schoolYear.sem1_enrollment_end;

    if (!startRaw && !endRaw) {
        return { isOpen: true, status: 'unrestricted', message: 'Enrollment dates are unrestricted.' };
    }

    const now = currentDate instanceof Date ? currentDate : new Date(currentDate);
    const startDate = startRaw ? new Date(startRaw) : null;
    const endDate   = endRaw   ? new Date(endRaw)   : null;

    if (startDate && now < startDate) {
        const dateStr = startDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = startDate.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
        return {
            isOpen: false,
            status: 'upcoming',
            message: `Enrollment for Semester ${semNum} opens on ${dateStr} at ${timeStr}.`,
            startDate,
            endDate
        };
    }

    if (endDate && now > endDate) {
        const dateStr = endDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = endDate.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
        return {
            isOpen: false,
            status: 'closed',
            message: `Enrollment for Semester ${semNum} closed on ${dateStr} at ${timeStr}.`,
            startDate,
            endDate
        };
    }

    const closeStr = endDate ? endDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : 'further notice';
    return {
        isOpen: true,
        status: 'open',
        message: `Enrollment is currently open (closes ${closeStr}).`,
        startDate,
        endDate
    };
}

/**
 * Evaluates whether a quarter's grade encoding deadline has passed.
 * @param {object} schoolYear - school_years row
 * @param {number|string} quarterNumber - 1, 2, 3, or 4
 * @param {Date} [currentDate] - override for testing
 * @returns {object} { isAllowed: boolean, status: string, message: string, deadline: Date|null, remainingHours: number|null }
 */
function isQuarterGradingOpen(schoolYear, quarterNumber, currentDate = new Date()) {
    if (!schoolYear) {
        return { isAllowed: true, status: 'unrestricted', message: 'No grade encoding deadline set.' };
    }

    const qNum = parseInt(quarterNumber, 10);
    const deadlineRaw = schoolYear[`q${qNum}_grade_deadline`];

    if (!deadlineRaw) {
        return { isAllowed: true, status: 'unrestricted', message: 'Grading deadline is open.' };
    }

    const now = currentDate instanceof Date ? currentDate : new Date(currentDate);
    const deadline = new Date(deadlineRaw);

    if (now > deadline) {
        const deadlineStr = deadline.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        return {
            isAllowed: false,
            status: 'locked',
            message: `Grade encoding deadline for Quarter ${qNum} expired on ${deadlineStr}. Contact Academic Admin to unlock.`,
            deadline,
            remainingHours: 0
        };
    }

    const remainingMs = deadline.getTime() - now.getTime();
    const remainingHours = Math.max(0, Math.round(remainingMs / (1000 * 60 * 60)));
    const remainingDays = Math.ceil(remainingHours / 24);

    return {
        isAllowed: true,
        status: 'open',
        message: `Grade encoding open (${remainingDays} day${remainingDays === 1 ? '' : 's'} remaining).`,
        deadline,
        remainingHours,
        remainingDays
    };
}

/**
 * Automated Prerequisite Check:
 * Enforces passing mark in Chemistry 1 (Semester 1) before Chemistry 2 (Semester 2) enrollment.
 * @param {object} db - MySQL database connection/pool
 * @param {number} studentId
 * @param {number} targetSubjectId - subject attempting to enroll in
 * @param {object} [activeSy] - active school year row (optional, fetches if omitted)
 * @returns {Promise<object>} { eligible: boolean, reason: string, chem1Grade: number|null, threshold: number }
 */
async function checkStudentPrerequisite(db, studentId, targetSubjectId, activeSy = null) {
    const sy = activeSy || await getActiveSchoolYear(db);
    const threshold = sy ? Number(sy.passing_threshold || 75.00) : 75.00;
    const isEnforced = sy ? (Number(sy.enforce_prerequisite) === 1) : true;

    // Fetch target subject details
    const [[targetSubject]] = await db.query(
        `SELECT subject_id, subject_name, subject_code, semester FROM subjects WHERE subject_id = ?`,
        [targetSubjectId]
    );

    if (!targetSubject) {
        return { eligible: false, reason: 'Target subject not found.', chem1Grade: null, threshold };
    }

    // Only 2nd Semester subjects (Chemistry 2) require Chemistry 1 prerequisite
    const isSemester2 = (Number(targetSubject.semester) === 2) || /chemistry\s*2/i.test(targetSubject.subject_name);
    if (!isSemester2) {
        return { eligible: true, reason: 'No prerequisite required for Semester 1.', chem1Grade: null, threshold };
    }

    // If prerequisite rule is toggled off by admin
    if (!isEnforced) {
        return { eligible: true, reason: 'Prerequisite requirement is disabled by administrator.', chem1Grade: null, threshold };
    }

    // Identify Chemistry 1 (Semester 1) subject
    const [[chem1Subject]] = await db.query(
        `SELECT subject_id, subject_name FROM subjects WHERE semester = 1 OR subject_name LIKE '%Chemistry 1%' ORDER BY subject_id ASC LIMIT 1`
    );

    if (!chem1Subject) {
        // No Chem 1 subject defined in curriculum; fail-safe open
        return { eligible: true, reason: 'Prerequisite course record not configured in system.', chem1Grade: null, threshold };
    }

    const chem1Id = chem1Subject.subject_id;

    // Check if student enrolled in Chem 1
    const [[progressRow]] = await db.query(
        `SELECT progress_percent FROM student_progress WHERE student_id = ? AND subject_id = ?`,
        [studentId, chem1Id]
    );

    // Compute composite student coursework score in Chem 1
    const [scoreRows] = await db.query(`
        SELECT ss.score_obtained, ss.total_items
        FROM student_scores ss
        JOIN assessments a ON a.assessment_id = ss.assessment_id
        JOIN quarters q ON q.quarter_id = a.quarter_id
        WHERE ss.student_id = ? AND q.subject_id = ? AND ss.total_items > 0
    `, [studentId, chem1Id]);

    // Compute arcade simulation grade percent in Chem 1
    const [gameRows] = await db.query(`
        SELECT esg.grade_percent
        FROM elementa_student_grades esg
        JOIN classes c ON esg.class_id = c.class_id
        WHERE esg.student_id = ? AND c.subject_id = ? AND esg.grade_percent IS NOT NULL
    `, [studentId, chem1Id]);

    if (!progressRow && scoreRows.length === 0 && gameRows.length === 0) {
        return {
            eligible: false,
            reason: `Prerequisite Requirement Not Met: You must complete ${chem1Subject.subject_name} before enrolling in ${targetSubject.subject_name}.`,
            chem1Grade: 0,
            threshold
        };
    }

    let totalPointsObtained = 0;
    let totalPointsPossible = 0;
    scoreRows.forEach(row => {
        totalPointsObtained += Number(row.score_obtained || 0);
        totalPointsPossible += Number(row.total_items || 0);
    });

    const courseworkPct = totalPointsPossible > 0 ? (totalPointsObtained / totalPointsPossible) * 100 : null;
    let arcadePct = null;
    if (gameRows.length > 0) {
        const sumGame = gameRows.reduce((acc, r) => acc + Number(r.grade_percent || 0), 0);
        arcadePct = sumGame / gameRows.length;
    }

    let finalGrade = 0;
    if (courseworkPct !== null && arcadePct !== null) {
        // Standard LMS 70% Coursework + 30% Simulation weighting
        finalGrade = (courseworkPct * 0.70) + (arcadePct * 0.30);
    } else if (courseworkPct !== null) {
        finalGrade = courseworkPct;
    } else if (arcadePct !== null) {
        finalGrade = arcadePct;
    } else if (progressRow) {
        finalGrade = Number(progressRow.progress_percent || 0);
    }

    finalGrade = Math.round(finalGrade * 100) / 100;

    if (finalGrade < threshold) {
        return {
            eligible: false,
            reason: `Prerequisite Requirement Not Met: Your final average in ${chem1Subject.subject_name} is ${finalGrade}%, which is below the passing threshold of ${threshold}%.`,
            chem1Grade: finalGrade,
            threshold
        };
    }

    return {
        eligible: true,
        reason: `Prerequisite satisfied with grade ${finalGrade}% in ${chem1Subject.subject_name}.`,
        chem1Grade: finalGrade,
        threshold
    };
}

/**
 * Validates timeline chronology and formatting for School Year creation & edits.
 * @param {object} payload
 * @returns {{ valid: boolean, message?: string }}
 */
function validateSchoolYearTimeline(payload) {
    const {
        sy_range,
        start_date,
        end_date,
        sem1_start_date,
        sem1_end_date,
        sem1_enrollment_start,
        sem1_enrollment_end,
        q1_start_date,
        q1_end_date,
        q1_grade_deadline,
        q2_start_date,
        q2_end_date,
        q2_grade_deadline,
        sem2_start_date,
        sem2_end_date,
        sem2_enrollment_start,
        sem2_enrollment_end,
        q3_start_date,
        q3_end_date,
        q3_grade_deadline,
        q4_start_date,
        q4_end_date,
        q4_grade_deadline
    } = payload;

    if (!sy_range || !sy_range.trim()) {
        return { valid: false, message: 'Academic Year Range (e.g. 2026-2027) is required.' };
    }

    const cleanRange = sy_range.trim();
    if (!/^\d{4}-\d{4}$/.test(cleanRange)) {
        return { valid: false, message: 'SY Range must follow YYYY-YYYY format (e.g. 2026-2027).' };
    }

    const [startYear, endYear] = cleanRange.split('-').map(Number);
    if (endYear !== startYear + 1) {
        return { valid: false, message: 'The second year in SY Range must be exactly 1 year after the first (e.g. 2026-2027).' };
    }

    // Helper to compare dates
    const isAfter = (d1, d2) => new Date(d1).getTime() > new Date(d2).getTime();
    const isBeforeOrEqual = (d1, d2) => new Date(d1).getTime() <= new Date(d2).getTime();

    // 1. Overall SY Dates
    if (start_date && end_date && isAfter(start_date, end_date)) {
        return { valid: false, message: 'Overall School Year Start Date cannot be after End Date.' };
    }

    // 2. Semesters Chronology
    if (sem1_start_date && sem1_end_date && isAfter(sem1_start_date, sem1_end_date)) {
        return { valid: false, message: 'Semester 1 Start Date cannot be after Semester 1 End Date.' };
    }
    if (sem2_start_date && sem2_end_date && isAfter(sem2_start_date, sem2_end_date)) {
        return { valid: false, message: 'Semester 2 Start Date cannot be after Semester 2 End Date.' };
    }
    if (sem1_end_date && sem2_start_date && isAfter(sem1_end_date, sem2_start_date)) {
        return { valid: false, message: 'Semester 1 must conclude before Semester 2 begins.' };
    }

    // 3. Quarters within Semester 1
    if (q1_start_date && q1_end_date && isAfter(q1_start_date, q1_end_date)) {
        return { valid: false, message: 'Quarter 1 Start Date cannot be after Quarter 1 End Date.' };
    }
    if (q2_start_date && q2_end_date && isAfter(q2_start_date, q2_end_date)) {
        return { valid: false, message: 'Quarter 2 Start Date cannot be after Quarter 2 End Date.' };
    }
    if (q1_end_date && q2_start_date && isAfter(q1_end_date, q2_start_date)) {
        return { valid: false, message: 'Quarter 1 must conclude before Quarter 2 begins.' };
    }
    if (q1_end_date && q1_grade_deadline && isAfter(q1_end_date, q1_grade_deadline)) {
        return { valid: false, message: 'Quarter 1 Grade Encoding Deadline must be on or after Quarter 1 End Date.' };
    }
    if (q2_end_date && q2_grade_deadline && isAfter(q2_end_date, q2_grade_deadline)) {
        return { valid: false, message: 'Quarter 2 Grade Encoding Deadline must be on or after Quarter 2 End Date.' };
    }

    // 4. Quarters within Semester 2
    if (q3_start_date && q3_end_date && isAfter(q3_start_date, q3_end_date)) {
        return { valid: false, message: 'Quarter 3 Start Date cannot be after Quarter 3 End Date.' };
    }
    if (q4_start_date && q4_end_date && isAfter(q4_start_date, q4_end_date)) {
        return { valid: false, message: 'Quarter 4 Start Date cannot be after Quarter 4 End Date.' };
    }
    if (q3_end_date && q4_start_date && isAfter(q3_end_date, q4_start_date)) {
        return { valid: false, message: 'Quarter 3 must conclude before Quarter 4 begins.' };
    }
    if (q3_end_date && q3_grade_deadline && isAfter(q3_end_date, q3_grade_deadline)) {
        return { valid: false, message: 'Quarter 3 Grade Encoding Deadline must be on or after Quarter 3 End Date.' };
    }
    if (q4_end_date && q4_grade_deadline && isAfter(q4_end_date, q4_grade_deadline)) {
        return { valid: false, message: 'Quarter 4 Grade Encoding Deadline must be on or after Quarter 4 End Date.' };
    }

    // 5. Enrollment Windows
    if (sem1_enrollment_start && sem1_enrollment_end && isAfter(sem1_enrollment_start, sem1_enrollment_end)) {
        return { valid: false, message: 'Semester 1 Enrollment Start Date cannot be after Enrollment End Date.' };
    }
    if (sem2_enrollment_start && sem2_enrollment_end && isAfter(sem2_enrollment_start, sem2_enrollment_end)) {
        return { valid: false, message: 'Semester 2 Enrollment Start Date cannot be after Enrollment End Date.' };
    }

    return { valid: true };
}

/**
 * Previews what content will be transferred or reset from a source school year.
 * @param {object} db - MySQL database connection/pool
 * @param {number} sourceSyId - source school year ID
 * @returns {Promise<object>}
 */
async function previewContentRollover(db, sourceSyId) {
    const [[sourceSy]] = await db.query(
        `SELECT sy_id, sy_range, sy_code FROM school_years WHERE sy_id = ?`,
        [sourceSyId]
    );

    if (!sourceSy) {
        return { success: false, message: 'Source school year not found.' };
    }

    // 1. Classes count
    const [classes] = await db.query(
        `SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id, s.subject_name,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count
         FROM classes c
         JOIN subjects s ON s.subject_id = c.subject_id
         WHERE c.sy_id = ?`,
        [sourceSyId]
    );

    // 2. Learning materials count under these subjects
    const [[matRow]] = await db.query(`
        SELECT COUNT(lm.material_id) as mat_count
        FROM learning_materials lm
        JOIN topics t ON t.topic_id = lm.topic_id
        JOIN quarters q ON q.quarter_id = t.quarter_id
        WHERE q.subject_id IN (SELECT DISTINCT subject_id FROM classes WHERE sy_id = ?)
    `, [sourceSyId]);

    // 3. Question bank items count
    const [[qbRow]] = await db.query(`
        SELECT COUNT(qb.question_id) as qb_count
        FROM question_bank qb
        JOIN topics t ON t.topic_id = qb.topic_id
        JOIN quarters q ON q.quarter_id = t.quarter_id
        WHERE q.subject_id IN (SELECT DISTINCT subject_id FROM classes WHERE sy_id = ?)
    `, [sourceSyId]);

    // 4. Past assessments count (to confirm exclusion/retention)
    const [[assRow]] = await db.query(`
        SELECT COUNT(a.assessment_id) as ass_count
        FROM assessments a
        JOIN quarters q ON q.quarter_id = a.quarter_id
        WHERE q.subject_id IN (SELECT DISTINCT subject_id FROM classes WHERE sy_id = ?)
    `, [sourceSyId]);

    // 5. Announcements to exclude
    const [[annRow]] = await db.query(`
        SELECT COUNT(announcement_id) as ann_count
        FROM announcements
        WHERE class_id IN (SELECT class_id FROM classes WHERE sy_id = ?)
    `, [sourceSyId]);

    return {
        success: true,
        sourceSy,
        classesCount: classes.length,
        classesList: classes.map(c => ({
            name: c.class_name,
            subject: c.subject_name,
            priorStudents: c.student_count
        })),
        materialsCount: matRow ? matRow.mat_count : 0,
        questionBankCount: qbRow ? qbRow.qb_count : 0,
        assessmentsCount: assRow ? assRow.ass_count : 0,
        announcementsCount: annRow ? annRow.ann_count : 0
    };
}

/**
 * Executes cohort content rollover from sourceSyId to targetSyId.
 * Clones section environments with clean student rosters, applies initial material visibility,
 * and handles question bank/assessments according to admin flags.
 * @param {object} db - MySQL database connection/pool
 * @param {object} options
 * @returns {Promise<object>}
 */
async function executeContentRollover(db, options) {
    const {
        sourceSyId,
        targetSyId,
        rolloverMaterials = true,
        rolloverAssessments = false,
        rolloverQuestionBank = false,
        rolloverAnnouncements = false,
        defaultVisibility = 'visible',
        adminUserId = null
    } = options;

    if (!sourceSyId || !targetSyId) {
        throw new Error('Both source and target school year IDs are required for rollover.');
    }

    const [[sourceSy]] = await db.query(`SELECT sy_id, sy_range FROM school_years WHERE sy_id = ?`, [sourceSyId]);
    const [[targetSy]] = await db.query(`SELECT sy_id, sy_range FROM school_years WHERE sy_id = ?`, [targetSyId]);

    if (!sourceSy || !targetSy) {
        throw new Error('Source or target school year record not found.');
    }

    // 1. Roll over Class Sections with clean rosters
    const [sourceClasses] = await db.query(`
        SELECT class_name, teacher_id, subject_id, max_capacity
        FROM classes
        WHERE sy_id = ?
    `, [sourceSyId]);

    let classesCloned = 0;
    for (const cls of sourceClasses) {
        // Check if class with same name, subject, and sy already exists in target
        const [[existing]] = await db.query(`
            SELECT class_id FROM classes
            WHERE sy_id = ? AND subject_id = ? AND class_name = ?
        `, [targetSyId, cls.subject_id, cls.class_name]);

        if (!existing) {
            await db.query(`
                INSERT INTO classes (class_name, teacher_id, subject_id, sy_id, max_capacity, enrolled_count)
                VALUES (?, ?, ?, ?, ?, 0)
            `, [cls.class_name, cls.teacher_id, cls.subject_id, targetSyId, cls.max_capacity]);
            classesCloned++;
        }
    }

    // 2. Learning Materials Visibility
    let materialsUpdated = 0;
    if (rolloverMaterials) {
        const lockValue = defaultVisibility === 'hidden' ? 1 : 0;
        const [updateRes] = await db.query(`
            UPDATE learning_materials lm
            JOIN topics t ON t.topic_id = lm.topic_id
            JOIN quarters q ON q.quarter_id = t.quarter_id
            SET lm.is_locked = ?
            WHERE q.subject_id IN (SELECT DISTINCT subject_id FROM classes WHERE sy_id = ?)
        `, [lockValue, sourceSyId]);
        materialsUpdated = updateRes.affectedRows || 0;
    }

    // 3. Question Bank items retention
    let questionsRetained = 0;
    if (rolloverQuestionBank) {
        // Base table for question bank is elementa_questions
        const [qbRes] = await db.query(`
            UPDATE elementa_questions eq
            JOIN topics t ON t.topic_id = eq.topic_id
            JOIN quarters q ON q.quarter_id = t.quarter_id
            SET eq.verification_status = 'verified'
            WHERE q.subject_id IN (SELECT DISTINCT subject_id FROM classes WHERE sy_id = ?)
        `, [sourceSyId]);
        questionsRetained = qbRes.affectedRows || 0;
    }

    return {
        success: true,
        sourceSyRange: sourceSy.sy_range,
        targetSyRange: targetSy.sy_range,
        classesCloned,
        materialsUpdated,
        questionsRetained,
        defaultVisibility,
        assessmentsExcluded: !rolloverAssessments,
        announcementsExcluded: !rolloverAnnouncements
    };
}

module.exports = {
    getActiveSchoolYear,
    isSemesterEnrollmentOpen,
    isQuarterGradingOpen,
    checkStudentPrerequisite,
    validateSchoolYearTimeline,
    previewContentRollover,
    executeContentRollover
};

