const fs = require('fs');

// ─────────────────────────────────────────────────────────────
// 1. UPDATE routes/admin.js
// ─────────────────────────────────────────────────────────────
let adminCode = fs.readFileSync('routes/admin.js', 'utf8');

// A. In GET /admin/user_access_control, add existingFacultyIdsMap, pendingFacultyIdsMap, existingLrnsMap, pendingLrnsMap
const renderUacOld = `        res.render('admin/user_access_control', {
            user: req.user,
            users,
            flaggedUsers,
            invitations,
            uacStats,
            classesList,
            subjectsList,
            currentSchoolYear,
        });`;

const renderUacNew = `        // ── Maps for client-side duplicate verification (LRN & Faculty ID) ───
        const [usersWithFid] = await db.query(
            \`SELECT faculty_id, CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE faculty_id IS NOT NULL AND faculty_id != ''\`
        );
        const existingFacultyIdsMap = {};
        usersWithFid.forEach(u => { if (u.faculty_id) existingFacultyIdsMap[u.faculty_id.trim()] = u.full_name; });

        const [pendingWithFid] = await db.query(
            \`SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role IN ('Teacher', 'Admin') AND prefill_data LIKE '%facultyId%'\`
        );
        const pendingFacultyIdsMap = {};
        pendingWithFid.forEach(p => {
            try {
                const parsed = JSON.parse(p.prefill_data);
                if (parsed.facultyId) pendingFacultyIdsMap[parsed.facultyId.trim()] = p.email;
            } catch (_) {}
        });

        const [usersWithLrn] = await db.query(
            \`SELECT lrn_number, CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE lrn_number IS NOT NULL AND lrn_number != ''\`
        );
        const existingLrnsMap = {};
        usersWithLrn.forEach(u => { if (u.lrn_number) existingLrnsMap[u.lrn_number.trim()] = u.full_name; });

        const [pendingWithLrn] = await db.query(
            \`SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role = 'Student' AND prefill_data LIKE '%lrn%'\`
        );
        const pendingLrnsMap = {};
        pendingWithLrn.forEach(p => {
            try {
                const parsed = JSON.parse(p.prefill_data);
                if (parsed.lrn) pendingLrnsMap[parsed.lrn.trim()] = p.email;
            } catch (_) {}
        });

        res.render('admin/user_access_control', {
            user: req.user,
            users,
            flaggedUsers,
            invitations,
            uacStats,
            classesList,
            subjectsList,
            currentSchoolYear,
            existingFacultyIdsMap,
            pendingFacultyIdsMap,
            existingLrnsMap,
            pendingLrnsMap
        });`;

if (adminCode.includes(renderUacOld)) {
    adminCode = adminCode.replace(renderUacOld, renderUacNew);
}

// B. In GET /admin/uac/bulk-template, update teacherHeaders and sample rows
const oldTeacherHeadersBlock = `        const teacherHeaders = [
            'first_name*',
            'middle_name',
            'last_name*',
            'suffix',
            'email*',
            'faculty_id',
            'department',
            'sex',
            'birthdate(YYYY-MM-DD)',
            'mobile_number',
            'city_town',
        ];`;

const newTeacherHeadersBlock = `        const teacherHeaders = [
            'first_name*',
            'middle_name',
            'last_name*',
            'suffix',
            'email*',
            'faculty_id*',
            'department',
            'assigned_classes',
            'sex',
            'birthdate(YYYY-MM-DD)',
            'mobile_number',
            'city_town',
        ];`;

adminCode = adminCode.replace(oldTeacherHeadersBlock, newTeacherHeadersBlock);

const oldSampleTeacher = `        const sampleTeacher1 = [
            'Maria', '', 'Santos', '',
            'teacher.santos@gmail.com',
            'FAC-001', 'Science Department',
            'Female', '1990-03-22', '+63 917 000 0000', 'Batangas City',
        ];

        const sheetData = type === 'teacher' 
            ? [headers, sampleTeacher1] 
            : [headers, sampleStudent1, sampleStudent2];`;

const newSampleTeacher = `        const sampleTeacher1 = [
            'Maria', '', 'Santos', '',
            'teacher.santos@gmail.com',
            'FAC-101', 'Science Department',
            'Chemistry 1: Atom, Molecule; Chemistry 2: Atom',
            'Female', '1990-03-22', '+63 917 000 0000', 'Batangas City',
        ];

        const sampleTeacher2 = [
            'Roberto', 'M.', 'Dela Cruz', '',
            'teacher.delacruz@gmail.com',
            'FAC-102', 'Science Department',
            'Chemistry 1: Molecule',
            'Male', '1988-11-15', '+63 918 111 2222', 'Batangas City',
        ];

        const sheetData = type === 'teacher' 
            ? [headers, sampleTeacher1, sampleTeacher2] 
            : [headers, sampleStudent1, sampleStudent2];`;

adminCode = adminCode.replace(oldSampleTeacher, newSampleTeacher);

// C. In POST /admin/uac/bulk-import, support teacher JSON payload with class assignments & conflict replacements
const oldBulkImportRowsParse = `        let rows = [];
        if (req.body.students_json) {
            try {
                rows = JSON.parse(req.body.students_json);
            } catch (_) {
                rows = [];
            }
        }`;

const newBulkImportRowsParse = `        let rows = [];
        if (type === 'student' && req.body.students_json) {
            try {
                rows = JSON.parse(req.body.students_json);
            } catch (_) {
                rows = [];
            }
        } else if (type === 'teacher' && req.body.teachers_json) {
            try {
                rows = JSON.parse(req.body.teachers_json);
            } catch (_) {
                rows = [];
            }
        }`;

adminCode = adminCode.replace(oldBulkImportRowsParse, newBulkImportRowsParse);

// Update teacher validation block in bulk import
const oldTeacherValidationBlock = `                // ── TEACHER-SPECIFIC VALIDATION ──────────────────────────────
                if (type === 'teacher' && row.faculty_id) {
                    const [[fidEx]] = await db.query(
                        \`SELECT user_id FROM users WHERE faculty_id = ?\`, [row.faculty_id]
                    );
                    if (fidEx) {
                        const reason = \`Faculty ID "\${row.faculty_id}" is already in use by another teacher.\`;
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }
                    seenEmailsInBatch.add(cleanEmail);
                }`;

const newTeacherValidationBlock = `                // ── TEACHER-SPECIFIC VALIDATION & TEACHING LOAD ASSIGNMENT ───
                let assignedTeacherClasses = [];
                let cleanFacultyId = '';
                if (type === 'teacher') {
                    cleanFacultyId = String(row.faculty_id || row.facultyid || '').trim();

                    // Rule 1: Faculty ID is mandatory for teachers
                    if (!cleanFacultyId) {
                        const reason = 'Faculty ID is required for teachers and must be unique.';
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 2: Check duplicate Faculty ID within current batch
                    if (seenLrnsInBatch.has(cleanFacultyId)) {
                        const reason = \`Duplicate Faculty ID "\${cleanFacultyId}" detected across multiple rows in this import batch.\`;
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 3: Check duplicate Faculty ID in users table
                    const [[fidEx]] = await db.query(
                        \`SELECT user_id, first_name, last_name FROM users WHERE faculty_id = ?\`, [cleanFacultyId]
                    );
                    if (fidEx) {
                        const reason = \`Faculty ID "\${cleanFacultyId}" is already registered to "\${fidEx.first_name} \${fidEx.last_name}".\`;
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 4: Check duplicate Faculty ID in pending invitations
                    const [pendingWithFid] = await db.query(
                        \`SELECT email, prefill_data FROM account_invitations WHERE is_used = 0 AND role IN ('Teacher', 'Admin') AND prefill_data LIKE ?\`,
                        [\`%\${cleanFacultyId}%\`]
                    );
                    const matchingFid = pendingWithFid.find(p => {
                        try { return JSON.parse(p.prefill_data).facultyId === cleanFacultyId; } catch (_) { return false; }
                    });
                    if (matchingFid) {
                        const reason = \`Faculty ID "\${cleanFacultyId}" is already reserved in a pending invitation for "\${matchingFid.email}".\`;
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Rule 5: Resolve Assigned Classes / Teaching Load
                    let targetClassIds = [];
                    if (Array.isArray(row.class_ids) && row.class_ids.length > 0) {
                        targetClassIds = row.class_ids.map(Number).filter(n => !isNaN(n));
                    } else if (Array.isArray(row.classIds) && row.classIds.length > 0) {
                        targetClassIds = row.classIds.map(Number).filter(n => !isNaN(n));
                    } else {
                        // Parse from text column (e.g. assigned_classes / sections / classes)
                        const rawClassesText = String(row.assigned_classes || row.classes || row.sections || '').trim();
                        if (rawClassesText && allClasses.length > 0) {
                            // Extract possible section tokens separated by comma or semicolon
                            const tokens = rawClassesText.split(/[;,]/).map(t => t.trim().toLowerCase()).filter(Boolean);
                            tokens.forEach(tok => {
                                // Match section name (strip any "Chemistry 1:" prefix)
                                const cleanSecName = tok.includes(':') ? tok.split(':')[1].trim() : tok;
                                const matched = allClasses.find(c => c.class_name.toLowerCase().trim() === cleanSecName);
                                if (matched && !targetClassIds.includes(matched.class_id)) {
                                    targetClassIds.push(matched.class_id);
                                }
                            });
                        }
                    }

                    if (targetClassIds.length === 0) {
                        const reason = 'Teacher must be assigned to at least one class / section.';
                        log.push({ ok: false, msg: \`Teacher "\${fullName}" (\${cleanEmail}): \${reason}\` });
                        failedRows.push({ row: rowIdx + 1, name: fullName, email: cleanEmail, reason });
                        skipped++;
                        continue;
                    }

                    // Query class & subject details for target class IDs
                    const [matchedClsRows] = await db.query(
                        \`SELECT c.class_id, c.class_name, c.teacher_id, c.subject_id,
                                s.subject_name, s.subject_code,
                                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name
                         FROM classes c
                         LEFT JOIN users u ON c.teacher_id = u.user_id
                         LEFT JOIN subjects s ON c.subject_id = s.subject_id
                         WHERE c.class_id IN (?)\`,
                        [targetClassIds]
                    );
                    assignedTeacherClasses = matchedClsRows;

                    // Unlink previous teachers if conflict replacement confirmed
                    for (const cls of assignedTeacherClasses) {
                        if (cls.teacher_id) {
                            await logActivity(req.user.user_id, 'Admin', 'REPLACE_CLASS_TEACHER',
                                \`Replaced existing teacher "\${cls.teacher_name}" (User ID: \${cls.teacher_id}) on course "\${cls.subject_name}" - section "\${cls.class_name}" with bulk invite for "\${cleanEmail}"\`);
                            await db.query('UPDATE classes SET teacher_id = NULL WHERE class_id = ?', [cls.class_id]);
                        }
                    }

                    seenLrnsInBatch.add(cleanFacultyId);
                    seenEmailsInBatch.add(cleanEmail);
                }`;

adminCode = adminCode.replace(oldTeacherValidationBlock, newTeacherValidationBlock);

// Update prefill and email generation in bulk import
const oldBulkPrefillFaculty = `                    facultyId   : type === 'teacher' ? (row.faculty_id || null) : null,
                    department  : type === 'teacher' ? (row.department || null) : null,`;

const newBulkPrefillFaculty = `                    facultyId   : type === 'teacher' ? cleanFacultyId : null,
                    department  : type === 'teacher' ? (row.department || null) : null,
                    classIds    : type === 'teacher' ? assignedTeacherClasses.map(c => c.class_id) : null,
                    subjectIds  : type === 'teacher' ? [...new Set(assignedTeacherClasses.map(c => c.subject_id))] : null,
                    courseName  : type === 'teacher' ? [...new Set(assignedTeacherClasses.map(c => c.subject_name))].join(', ') : null,`;

adminCode = adminCode.replace(oldBulkPrefillFaculty, newBulkPrefillFaculty);

// Update teacher email info block in bulk import
const oldEmailClassInfo = `                let emailClassInfo = '';
                if (type === 'student' && targetClass) {
                    emailClassInfo = \`
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>LRN:</b></td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">\${cleanLrn}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Section:</b></td><td style="padding:4px 8px;font-size:13px;font-weight:bold;">\${targetClass.class_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Subject:</b></td><td style="padding:4px 8px;font-size:13px;">\${targetClass.subject_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Teacher:</b></td><td style="padding:4px 8px;font-size:13px;">\${targetClass.teacher_name || 'Assigned Faculty'}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Track:</b></td><td style="padding:4px 8px;font-size:13px;">\${finalTrack}</td></tr>
                    \`;
                }`;

const newEmailClassInfo = `                let emailClassInfo = '';
                if (type === 'student' && targetClass) {
                    emailClassInfo = \`
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>LRN:</b></td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">\${cleanLrn}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Section:</b></td><td style="padding:4px 8px;font-size:13px;font-weight:bold;">\${targetClass.class_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Subject:</b></td><td style="padding:4px 8px;font-size:13px;">\${targetClass.subject_name}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Teacher:</b></td><td style="padding:4px 8px;font-size:13px;">\${targetClass.teacher_name || 'Assigned Faculty'}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Track:</b></td><td style="padding:4px 8px;font-size:13px;">\${finalTrack}</td></tr>
                    \`;
                } else if (type === 'teacher' && assignedTeacherClasses.length > 0) {
                    const sectionsBySubj = {};
                    assignedTeacherClasses.forEach(c => {
                        const sName = c.subject_name || 'General';
                        if (!sectionsBySubj[sName]) sectionsBySubj[sName] = [];
                        sectionsBySubj[sName].push(c.class_name);
                    });
                    const loadHtml = Object.entries(sectionsBySubj).map(([sName, secs]) => \`<b>\${sName}:</b> \${secs.join(', ')}\`).join('<br>');
                    emailClassInfo = \`
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Faculty ID:</b></td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">\${cleanFacultyId}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;"><b>Department:</b></td><td style="padding:4px 8px;font-size:13px;">\${row.department || 'Science Department'}</td></tr>
                        <tr><td style="padding:4px 0;color:#64748b;font-size:13px;vertical-align:top;"><b>Assigned Load:</b></td><td style="padding:4px 8px;font-size:13px;">\${loadHtml}</td></tr>
                    \`;
                }`;

adminCode = adminCode.replace(oldEmailClassInfo, newEmailClassInfo);

// Also ensure allClasses is loaded for teacher type too (not just student)
adminCode = adminCode.replace(
    `if (type === 'student') {\n            const [[syRow]] = await db.query(`,
    `// Pre-fetch Classes for both Student & Teacher bulk import\n        const [clsRows] = await db.query(\`
            SELECT 
                c.class_id, c.class_name, c.teacher_id, c.subject_id, c.sy_id,
                c.max_capacity, c.enrollment_start, c.enrollment_end,
                s.subject_name, s.subject_code,
                CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                u.first_name AS teacher_first, u.last_name AS teacher_last,
                u.faculty_id AS teacher_faculty_id,
                sy.sy_range, sy.is_active AS sy_is_active,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
            FROM classes c
            LEFT JOIN users u ON u.user_id = c.teacher_id
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
        \`);
        allClasses = clsRows;

        if (type === 'student') {\n            const [[syRow]] = await db.query(`
);

// Remove duplicate clsRows fetch inside if (type === 'student')
adminCode = adminCode.replace(
    `            const [clsRows] = await db.query(\`
                SELECT 
                    c.class_id, c.class_name, c.teacher_id, c.subject_id, c.sy_id,
                    c.max_capacity, c.enrollment_start, c.enrollment_end,
                    s.subject_name, s.subject_code,
                    CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS teacher_name,
                    u.first_name AS teacher_first, u.last_name AS teacher_last,
                    u.faculty_id AS teacher_faculty_id,
                    sy.sy_range, sy.is_active AS sy_is_active,
                    (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) AS current_enrolled
                FROM classes c
                LEFT JOIN users u ON u.user_id = c.teacher_id
                LEFT JOIN subjects s ON c.subject_id = s.subject_id
                LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
            \`);
            allClasses = clsRows;`,
    `            // allClasses already pre-fetched above`
);

fs.writeFileSync('routes/admin.js', adminCode, 'utf8');
console.log('routes/admin.js updated for Teacher Bulk Import successfully!');
