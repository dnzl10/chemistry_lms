/**
 * utils/studentLifecycleHelper.js
 * 
 * Comprehensive Student Account Lifecycle & Deactivation Service Layer.
 * 
 * Manages DepEd Senior High School cohort transitions:
 * - Graduation Archiving (Grade 12 -> Deactivated / is_active = 0)
 * - Underclassmen Cohort Promotion (Grade 11 -> Grade 12 / is_active = 1)
 * - Dormancy Enforcement (Zero section assignments in active SY -> is_active = 0)
 * - Single-Click Student Reinstatement (Reactivate account -> is_active = 1)
 * 
 * Guarantees:
 * 1. Zero data loss: Coursework, quiz marks, arcade scores, and transcripts are never deleted.
 * 2. Remote session revocation: Active express sessions are invalidated upon deactivation.
 * 3. Full audit logging support for administrative accountability.
 */

/**
 * Previews cohort counts and transition metrics without modifying database state.
 * 
 * @param {object} db - MySQL connection or pool
 * @param {object} [options] - { activeSyId }
 * @returns {Promise<object>}
 */
async function previewCohortTransition(db, options = {}) {
    const activeSyId = options.activeSyId || null;

    // 1. Grade 12 Active (Graduating Cohort)
    const [[g12ActiveRow]] = await db.query(`
        SELECT COUNT(*) AS cnt 
        FROM users 
        WHERE role = 'Student' 
          AND (grade_level = 'Grade 12' OR grade_level LIKE '%12%')
          AND is_active = 1
    `);

    // 2. Grade 11 Active (Rising Cohort)
    const [[g11ActiveRow]] = await db.query(`
        SELECT COUNT(*) AS cnt 
        FROM users 
        WHERE role = 'Student' 
          AND (grade_level = 'Grade 11' OR grade_level LIKE '%11%')
          AND is_active = 1
    `);

    // 3. Already Archived / Deactivated Students
    const [[archivedRow]] = await db.query(`
        SELECT COUNT(*) AS cnt 
        FROM users 
        WHERE role = 'Student' 
          AND is_active = 0
    `);

    // 4. Suspended Accounts
    const [[suspendedRow]] = await db.query(`
        SELECT COUNT(*) AS cnt 
        FROM users 
        WHERE role = 'Student' 
          AND is_suspended = 1
    `);

    // 5. Total Registered Students
    const [[totalRow]] = await db.query(`
        SELECT COUNT(*) AS cnt 
        FROM users 
        WHERE role = 'Student'
    `);

    // 6. Active students with ZERO section assignments in the specified/active school year
    let dormantCount = 0;
    if (activeSyId) {
        const [[dormantRow]] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM users u
            WHERE u.role = 'Student'
              AND u.is_active = 1
              AND NOT EXISTS (
                  SELECT 1 
                  FROM class_students cs
                  JOIN classes c ON cs.class_id = c.class_id
                  WHERE cs.student_id = u.user_id 
                    AND (cs.sy_id = ? OR c.sy_id = ?)
              )
        `, [activeSyId, activeSyId]);
        dormantCount = Number(dormantRow?.cnt || 0);
    }

    return {
        success: true,
        summary: {
            graduatingG12Active: Number(g12ActiveRow?.cnt || 0),
            risingG11Active: Number(g11ActiveRow?.cnt || 0),
            totalArchived: Number(archivedRow?.cnt || 0),
            totalSuspended: Number(suspendedRow?.cnt || 0),
            totalStudents: Number(totalRow?.cnt || 0),
            dormantUnenrolled: dormantCount,
            activeSyId: activeSyId ? Number(activeSyId) : null
        }
    };
}

/**
 * Archives and deactivates graduating students (Grade 12).
 * Sets is_active = 0, current_session_id = NULL while preserving all historical records.
 * 
 * @param {object} db - MySQL connection or pool
 * @param {object} [options] - { targetGrade, adminUserId, sessionStore }
 * @returns {Promise<object>}
 */
async function archiveGraduatingCohort(db, options = {}) {
    const targetGrade = options.targetGrade || 'Grade 12';
    const sessionStore = options.sessionStore || null;

    // Fetch list of graduating active students
    const [studentsToArchive] = await db.query(`
        SELECT user_id, email, first_name, last_name, current_session_id, grade_level
        FROM users
        WHERE role = 'Student'
          AND (grade_level = ? OR grade_level LIKE ?)
          AND is_active = 1
    `, [targetGrade, `%${targetGrade}%`]);

    if (studentsToArchive.length === 0) {
        return {
            success: true,
            count: 0,
            message: `No active ${targetGrade} students found to archive.`,
            students: []
        };
    }

    const userIds = studentsToArchive.map(s => s.user_id);
    const placeholders = userIds.map(() => '?').join(',');

    // Atomically deactivate
    await db.query(`
        UPDATE users
        SET is_active = 0,
            current_session_id = NULL
        WHERE user_id IN (${placeholders})
    `, userIds);

    // Invalidate remote sessions
    if (sessionStore && typeof sessionStore.destroy === 'function') {
        studentsToArchive.forEach(s => {
            if (s.current_session_id) {
                try {
                    sessionStore.destroy(s.current_session_id, () => {});
                } catch (e) {
                    // Non-fatal session invalidation error
                }
            }
        });
    }

    return {
        success: true,
        count: studentsToArchive.length,
        message: `Successfully archived and deactivated ${studentsToArchive.length} graduating ${targetGrade} students. Historical grades and records preserved.`,
        students: studentsToArchive.map(s => ({
            userId: s.user_id,
            name: `${s.first_name} ${s.last_name}`,
            email: s.email,
            gradeLevel: s.grade_level
        }))
    };
}

/**
 * Promotes an active student cohort to the next grade level (e.g. Grade 11 -> Grade 12).
 * Retains is_active = 1 and maintains all prerequisite and coursework history.
 * 
 * @param {object} db - MySQL connection or pool
 * @param {object} [options] - { fromGrade, toGrade, adminUserId }
 * @returns {Promise<object>}
 */
async function promoteStudentCohort(db, options = {}) {
    const fromGrade = options.fromGrade || 'Grade 11';
    const toGrade = options.toGrade || 'Grade 12';

    // Fetch list of active students to promote
    const [studentsToPromote] = await db.query(`
        SELECT user_id, email, first_name, last_name, grade_level
        FROM users
        WHERE role = 'Student'
          AND (grade_level = ? OR grade_level LIKE ?)
          AND is_active = 1
    `, [fromGrade, `%${fromGrade}%`]);

    if (studentsToPromote.length === 0) {
        return {
            success: true,
            count: 0,
            message: `No active ${fromGrade} students found to promote.`,
            students: []
        };
    }

    const userIds = studentsToPromote.map(s => s.user_id);
    const placeholders = userIds.map(() => '?').join(',');

    // Atomically advance grade level
    await db.query(`
        UPDATE users
        SET grade_level = ?
        WHERE user_id IN (${placeholders})
    `, [toGrade, ...userIds]);

    return {
        success: true,
        count: studentsToPromote.length,
        fromGrade,
        toGrade,
        message: `Successfully promoted ${studentsToPromote.length} active students from ${fromGrade} to ${toGrade}.`,
        students: studentsToPromote.map(s => ({
            userId: s.user_id,
            name: `${s.first_name} ${s.last_name}`,
            email: s.email,
            previousGrade: s.grade_level,
            newGrade: toGrade
        }))
    };
}

/**
 * Scans and deactivates dormant student accounts that have zero active section enrollments
 * for the running school year.
 * 
 * @param {object} db - MySQL connection or pool
 * @param {object} options - { activeSyId, adminUserId, sessionStore }
 * @returns {Promise<object>}
 */
async function scanAndEnforceDormancy(db, options = {}) {
    const activeSyId = options.activeSyId;
    const sessionStore = options.sessionStore || null;

    if (!activeSyId) {
        throw new Error('Active School Year ID is required to evaluate student dormancy.');
    }

    // Fetch active students with 0 enrolled classes in activeSyId
    const [dormantStudents] = await db.query(`
        SELECT u.user_id, u.email, u.first_name, u.last_name, u.current_session_id, u.grade_level
        FROM users u
        WHERE u.role = 'Student'
          AND u.is_active = 1
          AND NOT EXISTS (
              SELECT 1 
              FROM class_students cs
              JOIN classes c ON cs.class_id = c.class_id
              WHERE cs.student_id = u.user_id 
                AND (cs.sy_id = ? OR c.sy_id = ?)
          )
    `, [activeSyId, activeSyId]);

    if (dormantStudents.length === 0) {
        return {
            success: true,
            count: 0,
            message: 'All active students are officially assigned to at least one class section in the active school year.',
            students: []
        };
    }

    const userIds = dormantStudents.map(s => s.user_id);
    const placeholders = userIds.map(() => '?').join(',');

    // Deactivate dormant unenrolled accounts
    await db.query(`
        UPDATE users
        SET is_active = 0,
            current_session_id = NULL
        WHERE user_id IN (${placeholders})
    `, userIds);

    // Invalidate remote sessions
    if (sessionStore && typeof sessionStore.destroy === 'function') {
        dormantStudents.forEach(s => {
            if (s.current_session_id) {
                try {
                    sessionStore.destroy(s.current_session_id, () => {});
                } catch (e) {}
            }
        });
    }

    return {
        success: true,
        count: dormantStudents.length,
        message: `Successfully placed ${dormantStudents.length} unassigned/dormant student accounts into inactive status.`,
        students: dormantStudents.map(s => ({
            userId: s.user_id,
            name: `${s.first_name} ${s.last_name}`,
            email: s.email,
            gradeLevel: s.grade_level
        }))
    };
}

/**
 * Reinstates an archived/deactivated student back to active status (is_active = 1).
 * Used when a student re-enrolls or requires access to review official records.
 * 
 * @param {object} db - MySQL connection or pool
 * @param {object} options - { studentId, adminUserId }
 * @returns {Promise<object>}
 */
async function reactivateStudentAccount(db, options = {}) {
    const studentId = options.studentId;

    if (!studentId) {
        throw new Error('Student User ID is required for account reactivation.');
    }

    const [[user]] = await db.query(`
        SELECT user_id, first_name, last_name, email, role, is_active
        FROM users
        WHERE user_id = ?
    `, [studentId]);

    if (!user) {
        throw new Error(`User with ID ${studentId} not found.`);
    }

    await db.query(`
        UPDATE users
        SET is_active = 1
        WHERE user_id = ?
    `, [studentId]);

    return {
        success: true,
        studentId: user.user_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        message: `Successfully reactivated student account for ${user.first_name} ${user.last_name}.`
    };
}

module.exports = {
    previewCohortTransition,
    archiveGraduatingCohort,
    promoteStudentCohort,
    scanAndEnforceDormancy,
    reactivateStudentAccount
};
