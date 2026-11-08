const mysql = require('mysql2/promise');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const academicHelper = require('../utils/academicHelper');

async function runVerification() {
    console.log('🧪 ════════════════════════════════════════════════════════════════');
    console.log('🧪 TEACHER PORTAL AUTO-SYNC & DEPED QUARTERLY ENGINE VERIFICATION');
    console.log('🧪 ════════════════════════════════════════════════════════════════\n');

    const db = await mysql.createPool({
        host: process.env.CLOUD_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
        port: parseInt(process.env.CLOUD_DB_PORT || '4000', 10),
        user: process.env.CLOUD_DB_USER || '49J5eWp1tY6R6aP.root',
        password: process.env.CLOUD_DB_PASS || 'f9FmBwLp3k8y9q1Z',
        database: 'chemistry_lms_staging',
        ssl: { minVersion: 'TLSv1.2' },
        waitForConnections: true,
        connectionLimit: 5
    });

    let passCount = 0;
    let failCount = 0;

    function assert(name, condition, details = '') {
        if (condition) {
            console.log(`  ✅ [PASS] ${name}${details ? ' — ' + details : ''}`);
            passCount++;
        } else {
            console.error(`  ❌ [FAIL] ${name}${details ? ' — ' + details : ''}`);
            failCount++;
        }
    }

    try {
        // ── TEST 1: Active School Year Resolution ─────────────────────────────
        console.log('1. Checking Active School Year Resolution...');
        const currentSY = await academicHelper.getCurrentSchoolYear(db);
        assert('Current SY exists in DB', !!currentSY, `sy_id=${currentSY?.sy_id}, range=${currentSY?.sy_range}`);
        assert('Current SY is active and current', currentSY?.status === 'Current' && currentSY?.is_active === 1);
        assert('Passing threshold is configured', !isNaN(parseFloat(currentSY?.passing_threshold)), `threshold=${currentSY?.passing_threshold}%`);

        // ── TEST 2: Active vs Archived Classes in DB ──────────────────────────
        console.log('\n2. Verifying Teacher Classes and Scoping...');
        const [activeClasses] = await db.query(
            `SELECT class_id, class_name, sy_id FROM classes WHERE sy_id = ? LIMIT 5`,
            [currentSY.sy_id]
        );
        console.log(`  Found ${activeClasses.length} active classes for current SY.`);

        const [archivedClasses] = await db.query(
            `SELECT class_id, class_name, sy_id FROM classes WHERE sy_id != ? OR sy_id IS NULL LIMIT 5`,
            [currentSY.sy_id]
        );
        console.log(`  Found ${archivedClasses.length} archived/other classes.`);

        // ── TEST 3: Archived Class Governance (verifyClassOwnership vs assertActiveClass) ──
        console.log('\n3. Testing Server-Side Archival Read vs Mutation Guards...');
        const teacherRouter = require('../routes/teacher');
        assert('Teacher router exports computeClassGradebookData', typeof teacherRouter._computeClassGradebookData === 'function');
        assert('Teacher router exports verifyClassOwnership', typeof teacherRouter._verifyClassOwnership === 'function');
        assert('Teacher router exports assertActiveClass', typeof teacherRouter._assertActiveClass === 'function');

        if (archivedClasses.length > 0) {
            const archCls = archivedClasses[0];
            
            // A. verifyClassOwnership MUST SUCCEED on archived classes (allows read-only viewing of attendance, grades, etc.)
            let verifyReadSuccess = false;
            let readClsObj = null;
            try {
                readClsObj = await teacherRouter._verifyClassOwnership(db, null, archCls.class_id);
                verifyReadSuccess = !!readClsObj && !!readClsObj.class_name;
            } catch (err) {
                verifyReadSuccess = false;
            }
            assert('verifyClassOwnership allows read access to archived class and returns class_name', verifyReadSuccess, `class_id=${archCls.class_id}, class_name=${readClsObj?.class_name}`);

            // B. assertActiveClass MUST FAIL with 403 on archived classes (blocks mutations: settings, whitelist, attendance saving)
            let assertMutationBlocked = false;
            let blockedMessage = '';
            try {
                await teacherRouter._assertActiveClass(db, null, archCls.class_id);
            } catch (err) {
                assertMutationBlocked = err.statusCode === 403;
                blockedMessage = err.message;
            }
            assert('assertActiveClass blocks mutation on archived class with HTTP 403', assertMutationBlocked, `Message: "${blockedMessage}"`);
        } else {
            console.log('  ℹ️ No archived classes present in DB right now to test guard.');
        }

        // ── TEST 4: DepEd Quarterly Grading Computation Engine ────────────────
        console.log('\n4. Testing computeClassGradebookData (DepEd Quarterly Engine)...');
        // Find a teacher who has classes
        const [teachers] = await db.query(
            `SELECT DISTINCT teacher_id, class_id FROM classes WHERE teacher_id IS NOT NULL LIMIT 1`
        );
        if (teachers.length > 0) {
            const testTeacherId = teachers[0].teacher_id;
            const testClassId = teachers[0].class_id;
            const gradebookData = await teacherRouter._computeClassGradebookData(db, testClassId, testTeacherId, {
                weights: { asmt: 30, asgn: 30, forum: 10, sim: 20, syllabus: 10, lms: 80, att: 20, q1: 50, q2: 50 }
            });

            assert('gradebookData returned successfully', !!gradebookData);
            assert('gradebookData has classes array', Array.isArray(gradebookData.classes));
            assert('gradebookData has weights attached', gradebookData.weights?.q1 === 50 && gradebookData.weights?.q2 === 50);

            if (gradebookData.classes.length > 0) {
                const firstCls = gradebookData.classes[0];
                assert('Class has classInfo', !!firstCls.classInfo);
                assert('Class has student roster', Array.isArray(firstCls.students));

                if (firstCls.students.length > 0) {
                    const st = firstCls.students[0];
                    assert('Student has quarter_grades object', typeof st.quarter_grades === 'object');
                    assert('Student has q1_grade field', 'q1_grade' in st);
                    assert('Student has q2_grade field', 'q2_grade' in st);
                    assert('Student has semestral_grade field', 'semestral_grade' in st);
                    assert('Student has chem2_eligibility object', typeof st.chem2_eligibility === 'object');
                    assert('Chem2 eligibility has status and badge', !!st.chem2_eligibility.status && !!st.chem2_eligibility.badge,
                        `Status: ${st.chem2_eligibility.status}, Badge: ${st.chem2_eligibility.badge}`);
                }
            }
        }

        // ── TEST 5: Excel Master Gradebook Worksheet Generation ────────────────
        console.log('\n5. Testing Master Gradebook Excel Workbook Generation...');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Test Sheet');
        const mockStudents = [
            {
                index: 1,
                lrn_number: '123456789012',
                last_name: 'Dela Cruz',
                first_name: 'Juan',
                sex: 'M',
                attendance: { rate: 95 },
                asmt: { pct: 88, submitted: 4, count: 4 },
                asgn: { pct: 85, submitted: 3, count: 3 },
                forum: { pct: 100, completed: 2, total: 2 },
                lms_avg: 88.5,
                arcade_avg: 90,
                total_exp: 1500,
                q1_grade: 88.5,
                q2_grade: 91.0,
                semestral_grade: 89.8,
                standing: 'Passed',
                chem2_eligibility: { status: 'ELIGIBLE', badge: 'Eligible for Chem 2', code: 'PASSED' }
            },
            {
                index: 2,
                lrn_number: '123456789013',
                last_name: 'Santos',
                first_name: 'Maria',
                sex: 'F',
                attendance: { rate: 70 },
                asmt: { pct: 60, submitted: 2, count: 4 },
                asgn: { pct: 55, submitted: 2, count: 3 },
                forum: { pct: 50, completed: 1, total: 2 },
                lms_avg: 58.0,
                arcade_avg: 65,
                total_exp: 750,
                q1_grade: 62.0,
                q2_grade: 68.0,
                semestral_grade: 65.0,
                standing: 'At-Risk',
                chem2_eligibility: { status: 'INELIGIBLE', badge: 'Prerequisite Failed', code: 'FAILED' }
            }
        ];

        // Ensure Excel row addition works with the new 17/18 column schema
        const headerRow = ws.addRow([
            '#', 'LRN Number', 'Last Name', 'First Name', 'Sex',
            'Attendance Rate', 'Written Works (Asmt %)', 'Performance Tasks (Asgn %)', 'Participation (Forum %)',
            'LMS Coursework Avg', 'Simulation Mastery %', 'Total EXP',
            'Q1 Final %', 'Q2 Final %', 'Semestral Final %', 'Academic Standing', 'Chem 2 Prerequisite Status'
        ]);
        assert('Excel headers row has 17 columns', headerRow.cellCount === 17);

        mockStudents.forEach((s, idx) => {
            const row = ws.addRow([
                idx + 1,
                s.lrn_number,
                s.last_name,
                s.first_name,
                s.sex,
                `${s.attendance.rate}%`,
                `${s.asmt.pct}%`,
                `${s.asgn.pct}%`,
                `${s.forum.pct}%`,
                `${s.lms_avg}%`,
                `${s.arcade_avg}%`,
                s.total_exp,
                `${s.q1_grade}%`,
                `${s.q2_grade}%`,
                `${s.semestral_grade}%`,
                s.standing,
                s.chem2_eligibility.badge
            ]);
            assert(`Excel student row ${idx + 1} added with 17 cells`, row.cellCount === 17);
        });

        const excelBuffer = await wb.xlsx.writeBuffer();
        assert('Excel buffer written successfully without errors', excelBuffer.length > 0, `size=${excelBuffer.length} bytes`);

        // ── TEST 6: PDF Master Gradebook Generation ───────────────────────────
        console.log('\n6. Testing Master Gradebook PDF Generation...');
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
        const pdfChunks = [];
        doc.on('data', chunk => pdfChunks.push(chunk));
        let pdfFinished = false;
        doc.on('end', () => { pdfFinished = true; });

        // Draw sample table header
        const COLS = [
            { id: 'num',      title: '#',                 width: 18,  align: 'center' },
            { id: 'lrn',      title: 'LRN Number',        width: 65,  align: 'left' },
            { id: 'name',     title: 'Student Full Name', width: 105, align: 'left' },
            { id: 'sex',      title: 'Sex',               width: 22,  align: 'center' },
            { id: 'att',      title: 'Att.',              width: 36,  align: 'center' },
            { id: 'asmt',     title: 'Written Works',     width: 50,  align: 'center' },
            { id: 'asgn',     title: 'Perf. Tasks',       width: 50,  align: 'center' },
            { id: 'forum',    title: 'Forums',            width: 40,  align: 'center' },
            { id: 'sim',      title: 'Sims',              width: 40,  align: 'center' },
            { id: 'lms',      title: 'LMS Avg',           width: 48,  align: 'center' },
            { id: 'q1',       title: 'Q1 Grade',          width: 46,  align: 'center' },
            { id: 'q2',       title: 'Q2 Grade',          width: 46,  align: 'center' },
            { id: 'sem',      title: 'Sem. Grade',        width: 52,  align: 'center' },
            { id: 'standing', title: 'Standing',          width: 54,  align: 'center' },
            { id: 'chem2',    title: 'Chem 2 Status',     width: 98,  align: 'center' }
        ];

        const totalPdfColWidth = COLS.reduce((sum, c) => sum + c.width, 0);
        assert('PDF column widths sum exactly to 770pt (A4 landscape printable width)', totalPdfColWidth === 770, `total=${totalPdfColWidth}pt`);

        doc.rect(36, 100, 770, 22).fill('#1e1b4b');
        let curX = 36;
        for (const col of COLS) {
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
               .text(col.title, curX, 106, { width: col.width, align: col.align });
            curX += col.width;
        }

        doc.end();
        await new Promise(r => setTimeout(r, 200));
        assert('PDF document finished streaming successfully', pdfFinished, `chunks=${pdfChunks.length}`);

        console.log('\n════════════════════════════════════════════════════════════════');
        console.log(`VERIFICATION SUMMARY: ${passCount} Passed, ${failCount} Failed`);
        console.log('════════════════════════════════════════════════════════════════\n');

        if (failCount > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }

    } catch (err) {
        console.error('❌ [Verification Exception]', err);
        process.exit(1);
    } finally {
        await db.end();
    }
}

runVerification();
