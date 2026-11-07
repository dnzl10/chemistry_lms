/**
 * scripts/run_school_year_migration.js
 * Applies migrations/20261108_school_year_comprehensive_architecture.sql
 * to chemistry_lms_staging.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runMigration() {
    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST;
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const database = 'chemistry_lms_staging';

    console.log(`🔌 Connecting to Cloud DB: ${host}:${port}/${database}...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database,
        ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        multipleStatements: true
    });

    try {
        console.log('🚀 Checking current school_years schema...');
        const [existingCols] = await conn.query('DESCRIBE school_years');
        const colNames = new Set(existingCols.map(c => c.Field));

        const columnsToAdd = [
            { name: 'sy_code', def: 'VARCHAR(20) NULL AFTER sy_range' },
            { name: 'start_date', def: 'DATE NULL AFTER sy_code' },
            { name: 'end_date', def: 'DATE NULL AFTER start_date' },
            { name: 'status', def: "ENUM('Draft', 'Active', 'Archived') NOT NULL DEFAULT 'Draft' AFTER end_date" },
            { name: 'sem1_start_date', def: 'DATE NULL' },
            { name: 'sem1_end_date', def: 'DATE NULL' },
            { name: 'sem1_enrollment_start', def: 'DATETIME NULL' },
            { name: 'sem1_enrollment_end', def: 'DATETIME NULL' },
            { name: 'q1_start_date', def: 'DATE NULL' },
            { name: 'q1_end_date', def: 'DATE NULL' },
            { name: 'q1_grade_deadline', def: 'DATETIME NULL' },
            { name: 'q2_start_date', def: 'DATE NULL' },
            { name: 'q2_end_date', def: 'DATE NULL' },
            { name: 'q2_grade_deadline', def: 'DATETIME NULL' },
            { name: 'sem2_start_date', def: 'DATE NULL' },
            { name: 'sem2_end_date', def: 'DATE NULL' },
            { name: 'sem2_enrollment_start', def: 'DATETIME NULL' },
            { name: 'sem2_enrollment_end', def: 'DATETIME NULL' },
            { name: 'q3_start_date', def: 'DATE NULL' },
            { name: 'q3_end_date', def: 'DATE NULL' },
            { name: 'q3_grade_deadline', def: 'DATETIME NULL' },
            { name: 'q4_start_date', def: 'DATE NULL' },
            { name: 'q4_end_date', def: 'DATE NULL' },
            { name: 'q4_grade_deadline', def: 'DATETIME NULL' },
            { name: 'enforce_prerequisite', def: 'TINYINT(1) NOT NULL DEFAULT 1' },
            { name: 'passing_threshold', def: 'DECIMAL(5,2) NOT NULL DEFAULT 75.00' },
            { name: 'source_sy_id', def: 'INT(11) NULL' },
            { name: 'rollover_materials', def: 'TINYINT(1) NOT NULL DEFAULT 1' },
            { name: 'rollover_assessments', def: 'TINYINT(1) NOT NULL DEFAULT 0' },
            { name: 'rollover_question_bank', def: 'TINYINT(1) NOT NULL DEFAULT 0' },
            { name: 'rollover_announcements', def: 'TINYINT(1) NOT NULL DEFAULT 0' },
            { name: 'default_rollover_visibility', def: "ENUM('visible', 'hidden') NOT NULL DEFAULT 'visible'" }
        ];

        for (const col of columnsToAdd) {
            if (!colNames.has(col.name)) {
                console.log(`  ➕ Adding column: ${col.name}...`);
                await conn.query(`ALTER TABLE school_years ADD COLUMN \`${col.name}\` ${col.def}`);
            } else {
                console.log(`  ⏭️ Column already exists: ${col.name}`);
            }
        }

        console.log('\n🔄 Backfilling active school year (sy_id = 1)...');
        await conn.query(`
            UPDATE school_years
            SET 
                sy_code = COALESCE(sy_code, 'SY26-27'),
                status = CASE WHEN is_active = 1 THEN 'Active' ELSE 'Draft' END,
                start_date = COALESCE(start_date, '2026-08-24'),
                end_date = COALESCE(end_date, '2027-05-28'),
                sem1_start_date = COALESCE(sem1_start_date, '2026-08-24'),
                sem1_end_date = COALESCE(sem1_end_date, '2026-12-18'),
                sem1_enrollment_start = COALESCE(sem1_enrollment_start, '2026-08-01 08:00:00'),
                sem1_enrollment_end = COALESCE(sem1_enrollment_end, '2026-09-15 23:59:59'),
                q1_start_date = COALESCE(q1_start_date, '2026-08-24'),
                q1_end_date = COALESCE(q1_end_date, '2026-10-23'),
                q1_grade_deadline = COALESCE(q1_grade_deadline, '2026-10-30 23:59:59'),
                q2_start_date = COALESCE(q2_start_date, '2026-10-26'),
                q2_end_date = COALESCE(q2_end_date, '2026-12-18'),
                q2_grade_deadline = COALESCE(q2_grade_deadline, '2027-01-08 23:59:59'),
                sem2_start_date = COALESCE(sem2_start_date, '2027-01-11'),
                sem2_end_date = COALESCE(sem2_end_date, '2027-05-28'),
                sem2_enrollment_start = COALESCE(sem2_enrollment_start, '2027-01-04 08:00:00'),
                sem2_enrollment_end = COALESCE(sem2_enrollment_end, '2027-01-29 23:59:59'),
                q3_start_date = COALESCE(q3_start_date, '2027-01-11'),
                q3_end_date = COALESCE(q3_end_date, '2027-03-19'),
                q3_grade_deadline = COALESCE(q3_grade_deadline, '2027-03-26 23:59:59'),
                q4_start_date = COALESCE(q4_start_date, '2027-03-22'),
                q4_end_date = COALESCE(q4_end_date, '2027-05-28'),
                q4_grade_deadline = COALESCE(q4_grade_deadline, '2027-06-04 23:59:59'),
                enforce_prerequisite = 1,
                passing_threshold = 75.00,
                default_rollover_visibility = 'visible'
            WHERE sy_id = 1
        `);

        console.log('\n🔍 Verifying final columns on school_years:');
        const [updatedCols] = await conn.query('DESCRIBE school_years');
        console.table(updatedCols.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Default: c.Default })));

        const [activeSY] = await conn.query('SELECT * FROM school_years WHERE is_active = 1');
        console.log('\n✨ Active School Year Record:');
        console.log(JSON.stringify(activeSY[0], null, 2));

        console.log('\n🎉 Phase 1 Database Migration completed successfully!');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        throw err;
    } finally {
        await conn.end();
    }
}

runMigration().catch(err => {
    process.exit(1);
});
