/**
 * utils/academicHelper.js
 * Centralized business logic for Academic Timeline, Enrollment Windows,
 * Grade Encoding Deadlines, and Chemistry 1 -> Chemistry 2 Prerequisite Verification.
 */

/**
 * Fetch the single Current active School Year with all attributes.
 * Prioritizes status = 'Current' AND is_active = 1.
 * @param {object} db - MySQL database connection/pool
 * @returns {Promise<object|null>}
 */
async function getCurrentSchoolYear(db) {
    const [[currentSY]] = await db.query(
        `SELECT * FROM school_years WHERE status = 'Current' AND is_active = 1 LIMIT 1`
    );
    if (currentSY) return currentSY;

    // Fallback if status or is_active was updated separately
    const [[activeSY]] = await db.query(
        `SELECT * FROM school_years WHERE is_active = 1 OR status = 'Current' ORDER BY is_active DESC, sy_id DESC LIMIT 1`
    );
    if (activeSY) return activeSY;

    // Fallback to latest created if none active/current
    const [[latestSY]] = await db.query(
        `SELECT * FROM school_years ORDER BY sy_id DESC LIMIT 1`
    );
    return latestSY || null;
}

/**
 * Fetch the currently active School Year (alias for getCurrentSchoolYear).
 * @param {object} db - MySQL database connection/pool
 * @returns {Promise<object|null>}
 */
async function getActiveSchoolYear(db) {
    return getCurrentSchoolYear(db);
}

/**
 * Normalizes status strings from UI or legacy payloads to canonical ('Current', 'Draft', 'Archive').
 * @param {string} status
 * @param {boolean|number} [isActive]
 * @returns {'Current'|'Draft'|'Archive'}
 */
function normalizeSchoolYearStatus(status, isActive = null) {
    if (isActive === 1 || isActive === true || isActive === '1') {
        return 'Current';
    }
    const clean = String(status || '').trim();
    if (clean === 'Current' || clean === 'Active') return 'Current';
    if (clean === 'Archive' || clean === 'Archived') return 'Archive';
    return 'Draft';
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
 * Checks whether enrollment is open for a class, respecting both the School Year's
 * semestral enrollment window (Sem 1 vs Sem 2) and any class-level dates.
 * @param {object} db - database connection pool
 * @param {number} classId - class_id to check
 * @param {Date} [currentDate] - override date for testing
 * @returns {Promise<object>} { isOpen, status, message, cls, semNum, semLabel }
 */
async function checkClassEnrollmentOpen(db, classId, currentDate = new Date()) {
    if (!classId) return { isOpen: false, status: 'error', message: 'No class specified.' };

    const [[cls]] = await db.query(`
        SELECT 
            c.class_id, c.class_name, c.subject_id, c.sy_id, c.max_capacity,
            COALESCE(c.enrollment_start, IF(s.semester = 2, sy.sem2_enrollment_start, sy.sem1_enrollment_start)) AS enrollment_start,
            COALESCE(c.enrollment_end,   IF(s.semester = 2, sy.sem2_enrollment_end,   sy.sem1_enrollment_end))   AS enrollment_end,
            s.subject_name, s.subject_code, s.semester,
            sy.sy_range, sy.status AS sy_status, sy.is_active AS sy_is_active,
            sy.sem1_enrollment_start, sy.sem1_enrollment_end,
            sy.sem2_enrollment_start, sy.sem2_enrollment_end,
            (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
        FROM classes c
        LEFT JOIN subjects s ON s.subject_id = c.subject_id
        LEFT JOIN school_years sy ON sy.sy_id = c.sy_id
        WHERE c.class_id = ?
    `, [classId]);

    if (!cls) return { isOpen: false, status: 'not_found', message: 'Class not found.' };

    const semNum = (cls.semester == 2 || cls.semester === '2' || cls.semester === '2nd Semester') ? 2 : 1;
    const semLabel = semNum === 2 ? '2nd Semester' : '1st Semester';

    const now = currentDate instanceof Date ? currentDate : new Date(currentDate);

    if (cls.enrollment_start && now < new Date(cls.enrollment_start)) {
        const openStr = new Date(cls.enrollment_start).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        return {
            isOpen: false,
            status: 'upcoming',
            message: `Enrollment for class "${cls.class_name}" (${cls.subject_name || 'Subject'} - ${semLabel}) has not opened yet (Opens on ${openStr}).`,
            cls,
            semNum,
            semLabel
        };
    }

    if (cls.enrollment_end && now > new Date(cls.enrollment_end)) {
        const closeStr = new Date(cls.enrollment_end).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        return {
            isOpen: false,
            status: 'closed',
            message: `Enrollment period for class "${cls.class_name}" (${cls.subject_name || 'Subject'} - ${semLabel}) has already ended (Closed on ${closeStr}). Students cannot be enrolled after the enrollment period has closed.`,
            cls,
            semNum,
            semLabel
        };
    }

    return {
        isOpen: true,
        status: 'open',
        message: 'Enrollment is open.',
        cls,
        semNum,
        semLabel
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
    if (!schoolYear || !quarterNumber) {
        return { isAllowed: true, status: 'unrestricted', message: 'No grade encoding deadline set.' };
    }

    const qNum = parseInt(quarterNumber, 10);
    if (isNaN(qNum) || qNum < 1 || qNum > 4) {
        return { isAllowed: true, status: 'unrestricted', message: 'No grade encoding deadline set.' };
    }

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
 * Resolves the quarter number (1, 2, 3, or 4) and quarter info for an assessment or score record.
 * @param {object} db - MySQL database connection/pool
 * @param {object} params - { assessmentId, scoreId }
 * @returns {Promise<{ quarterNumber: number|null, quarterId: number|null, assessmentId: number|null, assessmentName: string|null }>}
 */
async function resolveAssessmentQuarter(db, { assessmentId = null, scoreId = null } = {}) {
    if (assessmentId) {
        const [rows] = await db.query(`
            SELECT COALESCE(q1.quarter_number, q2.quarter_number) AS quarter_number,
                   COALESCE(q1.quarter_id, q2.quarter_id) AS quarter_id,
                   a.assessment_id, a.assessment_name
            FROM assessments a
            LEFT JOIN quarters q1 ON a.quarter_id = q1.quarter_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN quarters q2 ON t.quarter_id = q2.quarter_id
            WHERE a.assessment_id = ?
            LIMIT 1
        `, [assessmentId]);

        if (rows.length > 0) {
            return {
                quarterNumber: rows[0].quarter_number ? Number(rows[0].quarter_number) : null,
                quarterId: rows[0].quarter_id ? Number(rows[0].quarter_id) : null,
                assessmentId: Number(rows[0].assessment_id),
                assessmentName: rows[0].assessment_name
            };
        }
    }

    if (scoreId && scoreId !== 'new' && scoreId !== '0') {
        const [rows] = await db.query(`
            SELECT COALESCE(q1.quarter_number, q2.quarter_number) AS quarter_number,
                   COALESCE(q1.quarter_id, q2.quarter_id) AS quarter_id,
                   a.assessment_id, a.assessment_name
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            LEFT JOIN quarters q1 ON a.quarter_id = q1.quarter_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN quarters q2 ON t.quarter_id = q2.quarter_id
            WHERE ss.score_id = ?
            LIMIT 1
        `, [scoreId]);

        if (rows.length > 0) {
            return {
                quarterNumber: rows[0].quarter_number ? Number(rows[0].quarter_number) : null,
                quarterId: rows[0].quarter_id ? Number(rows[0].quarter_id) : null,
                assessmentId: Number(rows[0].assessment_id),
                assessmentName: rows[0].assessment_name
            };
        }
    }

    return { quarterNumber: null, quarterId: null, assessmentId: null, assessmentName: null };
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

    if (!studentId) {
        return {
            eligible: false,
            reason: `Prerequisite Requirement Not Met: Student has not taken ${chem1Subject.subject_name}. Enrolling into ${targetSubject.subject_name} requires passing ${chem1Subject.subject_name} with at least ${threshold}%.`,
            chem1Grade: 0,
            threshold
        };
    }

    const chem1Id = chem1Subject.subject_id;

    // Check if student was enrolled in Chem 1 via class_students
    const [[chem1Enrollment]] = await db.query(
        `SELECT cs.class_id, c.class_name, c.sy_id 
         FROM class_students cs 
         JOIN classes c ON c.class_id = cs.class_id 
         WHERE cs.student_id = ? AND c.subject_id = ? 
         LIMIT 1`,
        [studentId, chem1Id]
    );

    // Check if student enrolled in Chem 1 progress table
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

    if (!chem1Enrollment && !progressRow && scoreRows.length === 0 && gameRows.length === 0) {
        return {
            eligible: false,
            reason: `Prerequisite Requirement Not Met: Student has not taken ${chem1Subject.subject_name}. Completion of ${chem1Subject.subject_name} (Passing Threshold: ${threshold}%) is strictly required before enrolling in ${targetSubject.subject_name}.`,
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

    if (payload.status) {
        const allowedStatuses = ['Current', 'Draft', 'Archive', 'Active', 'Archived'];
        if (!allowedStatuses.includes(payload.status)) {
            return { valid: false, message: 'Invalid School Year status. Must be Current, Draft, or Archive.' };
        }
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
    if (!sourceSyId) {
        return {
            success: true,
            isFreshStart: true,
            classesCount: 0,
            classesList: [],
            materialsCount: 0,
            questionBankCount: 0,
            assessmentsCount: 0,
            announcementsCount: 0,
            message: 'No rollover source selected. School year will start fresh.'
        };
    }

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

    // 2. Learning materials count under sourceSyId
    const [[matRow]] = await db.query(`
        SELECT COUNT(lm.material_id) as mat_count
        FROM learning_materials lm
        WHERE lm.sy_id = ?
    `, [sourceSyId]);

    // 3. Question bank items count under sourceSyId
    const [[qbRow]] = await db.query(`
        SELECT COUNT(eq.question_id) as qb_count
        FROM elementa_questions eq
        WHERE eq.sy_id = ? AND eq.is_active = 1
    `, [sourceSyId]);

    // 4. Past assessments count under sourceSyId
    const [[assRow]] = await db.query(`
        SELECT COUNT(a.assessment_id) as ass_count
        FROM assessments a
        WHERE a.sy_id = ?
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

    if (!sourceSyId) {
        return {
            success: true,
            isFreshStart: true,
            classesCloned: 0,
            materialsUpdated: 0,
            questionsRetained: 0,
            message: 'Fresh start: No cohort structures cloned.'
        };
    }

    if (!targetSyId) {
        throw new Error('Target school year ID is required for rollover.');
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

    // 2. Learning Materials Rollover (Clone to targetSyId with defaultVisibility)
    let materialsUpdated = 0;
    if (rolloverMaterials) {
        const lockValue = defaultVisibility === 'hidden' ? 1 : 0;
        const [sourceMats] = await db.query(`
            SELECT topic_id, title, material_type, file_path_or_url, uploaded_by,
                   ai_summary, ai_flashcards, ai_status
            FROM learning_materials
            WHERE sy_id = ?
        `, [sourceSyId]);

        for (const m of sourceMats) {
            const [[existingMat]] = await db.query(`
                SELECT material_id FROM learning_materials
                WHERE sy_id = ? AND topic_id = ? AND title = ?
            `, [targetSyId, m.topic_id, m.title]);

            if (!existingMat) {
                await db.query(`
                    INSERT INTO learning_materials (
                        sy_id, topic_id, title, material_type, file_path_or_url,
                        is_locked, uploaded_by, ai_summary, ai_flashcards, ai_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    targetSyId, m.topic_id, m.title, m.material_type, m.file_path_or_url,
                    lockValue, m.uploaded_by, m.ai_summary, m.ai_flashcards, m.ai_status
                ]);
                materialsUpdated++;
            }
        }
    }

    // 3. Question Bank items retention (Clone to targetSyId as verified)
    let questionsRetained = 0;
    if (rolloverQuestionBank) {
        const [sourceQs] = await db.query(`
            SELECT teacher_id, question_code, level_number, topic_id, topic,
                   machine_name, machine_id, difficulty, prompt, answer_text, steps_json,
                   time_limit_s, points, display_order
            FROM elementa_questions
            WHERE sy_id = ? AND is_active = 1
        `, [sourceSyId]);

        for (const q of sourceQs) {
            const [[existingQ]] = await db.query(`
                SELECT question_id FROM elementa_questions
                WHERE sy_id = ? AND prompt = ?
            `, [targetSyId, q.prompt]);

            if (!existingQ) {
                await db.query(`
                    INSERT INTO elementa_questions (
                        sy_id, teacher_id, question_code, level_number, topic_id, topic,
                        machine_name, machine_id, difficulty, prompt, answer_text, steps_json,
                        time_limit_s, points, display_order, is_active, verification_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Approved')
                `, [
                    targetSyId, q.teacher_id, q.question_code, q.level_number, q.topic_id, q.topic,
                    q.machine_name, q.machine_id, q.difficulty, q.prompt, q.answer_text, q.steps_json,
                    q.time_limit_s, q.points, q.display_order
                ]);
                questionsRetained++;
            }
        }
    }

    // 4. Assessments Rollover (Clone to targetSyId with is_unlocked = 0)
    let assessmentsCloned = 0;
    if (rolloverAssessments) {
        const [sourceAsmts] = await db.query(`
            SELECT quarter_id, topic_id, assessment_name, assessment_type, total_items,
                   question_selection_mode, duration_minutes, timer_type, competitive_enabled,
                   sound_bg, sound_correct, sound_wrong, sound_result_pass, sound_result_fail,
                   speech_enabled, teacher_id
            FROM assessments
            WHERE sy_id = ?
        `, [sourceSyId]);

        for (const a of sourceAsmts) {
            const [[existingAsm]] = await db.query(`
                SELECT assessment_id FROM assessments
                WHERE sy_id = ? AND topic_id = ? AND assessment_name = ?
            `, [targetSyId, a.topic_id, a.assessment_name]);

            if (!existingAsm) {
                await db.query(`
                    INSERT INTO assessments 
                    (sy_id, quarter_id, topic_id, assessment_name, assessment_type, total_items,
                     question_selection_mode, duration_minutes, timer_type, competitive_enabled,
                     is_unlocked, sound_bg, sound_correct, sound_wrong, sound_result_pass,
                     sound_result_fail, speech_enabled, teacher_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    targetSyId, a.quarter_id, a.topic_id, a.assessment_name, a.assessment_type, a.total_items,
                    a.question_selection_mode, a.duration_minutes, a.timer_type, a.competitive_enabled,
                    a.sound_bg, a.sound_correct, a.sound_wrong, a.sound_result_pass,
                    a.sound_result_fail, a.speech_enabled, a.teacher_id
                ]);
                assessmentsCloned++;
            }
        }
    }

    return {
        success: true,
        sourceSyRange: sourceSy.sy_range,
        targetSyRange: targetSy.sy_range,
        classesCloned,
        materialsUpdated,
        questionsRetained,
        assessmentsCloned,
        defaultVisibility,
        assessmentsExcluded: !rolloverAssessments,
        announcementsExcluded: true // Announcements & forums are cohort-specific and permanently excluded from rollover
    };
}

/**
 * Resolves the operational School Year context for Admin Portal pages.
 * Supports viewing historical (Archive) or preparation (Draft) years via query param `?sy_id=`.
 * Defaults safely to the live `Current` school year.
 *
 * @param {object} db - Database connection/pool
 * @param {number|string|null} [reqQuerySyId] - Optional sy_id from req.query.sy_id
 * @returns {Promise<{
 *   selectedSY: object,
 *   currentSY: object,
 *   allSchoolYears: Array<object>,
 *   isCurrentSY: boolean,
 *   isHistoricalSY: boolean,
 *   isDraftSY: boolean
 * }>}
 */
async function resolveAdminSchoolYearContext(db, reqQuerySyId = null) {
    const [allSchoolYears] = await db.query(
        `SELECT * FROM school_years ORDER BY is_active DESC, sy_range DESC`
    );

    let currentSY = allSchoolYears.find(sy => sy.status === 'Current' || sy.is_active === 1);
    if (!currentSY) {
        currentSY = allSchoolYears[0] || {
            sy_id: 1,
            sy_range: '2026-2027',
            sy_code: 'SY26-27',
            status: 'Current',
            is_active: 1
        };
    }

    let selectedSY = currentSY;
    const parsedId = parseInt(reqQuerySyId, 10);
    if (!isNaN(parsedId) && parsedId > 0) {
        const found = allSchoolYears.find(sy => sy.sy_id === parsedId);
        if (found) {
            selectedSY = found;
        }
    }

    const isCurrentSY = (selectedSY.sy_id === currentSY.sy_id);
    const isHistoricalSY = (selectedSY.status === 'Archive' || (!isCurrentSY && selectedSY.is_active === 0 && selectedSY.status !== 'Draft'));
    const isDraftSY = (selectedSY.status === 'Draft');

    return {
        selectedSY,
        currentSY,
        allSchoolYears,
        isCurrentSY,
        isHistoricalSY,
        isDraftSY
    };
}

const studentLifecycleHelper = require('./studentLifecycleHelper');

module.exports = {
    getCurrentSchoolYear,
    getActiveSchoolYear,
    resolveAdminSchoolYearContext,
    normalizeSchoolYearStatus,
    isSemesterEnrollmentOpen,
    checkClassEnrollmentOpen,
    isQuarterGradingOpen,
    resolveAssessmentQuarter,
    checkStudentPrerequisite,
    validateSchoolYearTimeline,
    previewContentRollover,
    executeContentRollover,
    // Student Account Lifecycle
    studentLifecycleHelper,
    previewCohortTransition: studentLifecycleHelper.previewCohortTransition,
    archiveOutgoingCohort: studentLifecycleHelper.archiveOutgoingCohort,
    archiveGraduatingCohort: studentLifecycleHelper.archiveGraduatingCohort, // alias
    scanAndEnforceDormancy: studentLifecycleHelper.scanAndEnforceDormancy,
    reactivateStudentAccount: studentLifecycleHelper.reactivateStudentAccount
};

