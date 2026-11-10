/**
 * scripts/run_simulation_quizzes_sy_scoping_migration.js
 *
 * Phase 1 Migration for Teacher Simulation Quizzes School Year Scoping:
 * 1. Adds `sy_id` + indexes (`idx_sim_quiz_sy`, `idx_sim_quiz_slug_sy`) to
 *    `elementa_simulation_custom_quizzes` and backfills from `school_years`
 *    date bounds (excluding Draft), falling back to the Current SY.
 * 2. Adds `sy_id` + index (`idx_sim_sub_sy`) to
 *    `elementa_simulation_quiz_submissions` and backfills from parent quiz `sy_id`.
 *
 * Strictly targets `chemistry_lms_staging` per staging-workflow.md.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function hasColumn(conn, tableName, colName) {
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return cols.some(c => c.Field === colName);
}

async function hasIndex(conn, tableName, indexName) {
    const [indexes] = await conn.query(`SHOW INDEX FROM \`${tableName}\``);
    return indexes.some(i => i.Key_name === indexName);
}

async function runMigration() {
    console.log('==========================================================================');
    console.log('  PHASE 1 MIGRATION: SIMULATION QUIZZES SCHOOL YEAR (sy_id) SCOPING       ');
    console.log('==========================================================================\n');

    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST;
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const targetDatabase = 'chemistry_lms_staging';

    console.log(`Connecting to database: ${targetDatabase} on ${host}:${port}...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database: targetDatabase,
        ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false }
    });

    try {
        const [schoolYears] = await conn.query(`
            SELECT sy_id, sy_range, status, is_active, start_date, end_date
            FROM school_years
            ORDER BY sy_id ASC
        `);

        if (schoolYears.length === 0) {
            throw new Error('No school_years records found. Cannot backfill sy_id.');
        }

        const currentSY =
            schoolYears.find(sy => sy.status === 'Current' && Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status === 'Current' || Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status !== 'Draft') ||
            schoolYears[0];

        console.log(`Current SY: sy_id=${currentSY.sy_id} (${currentSY.sy_range})\n`);

        // ---------------------------------------------------------------------
        // 1. elementa_simulation_custom_quizzes
        // ---------------------------------------------------------------------
        console.log('--- [1/2] elementa_simulation_custom_quizzes ---');
        if (!(await hasColumn(conn, 'elementa_simulation_custom_quizzes', 'sy_id'))) {
            await conn.query(`
                ALTER TABLE elementa_simulation_custom_quizzes
                ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER created_by
            `);
            console.log('  + Added column elementa_simulation_custom_quizzes.sy_id');
        } else {
            console.log('  = Column elementa_simulation_custom_quizzes.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'elementa_simulation_custom_quizzes', 'idx_sim_quiz_sy'))) {
            await conn.query(`
                ALTER TABLE elementa_simulation_custom_quizzes
                ADD INDEX idx_sim_quiz_sy (sy_id)
            `);
            console.log('  + Added index idx_sim_quiz_sy');
        } else {
            console.log('  = Index idx_sim_quiz_sy already exists');
        }

        if (!(await hasIndex(conn, 'elementa_simulation_custom_quizzes', 'idx_sim_quiz_slug_sy'))) {
            await conn.query(`
                ALTER TABLE elementa_simulation_custom_quizzes
                ADD INDEX idx_sim_quiz_slug_sy (simulation_slug, sy_id, is_active)
            `);
            console.log('  + Added index idx_sim_quiz_slug_sy');
        } else {
            console.log('  = Index idx_sim_quiz_slug_sy already exists');
        }

        const [quizBackfill] = await conn.query(`
            UPDATE elementa_simulation_custom_quizzes q
            SET q.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND DATE(q.created_at) BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE q.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled elementa_simulation_custom_quizzes: ${quizBackfill.affectedRows || 0} row(s)`);

        // ---------------------------------------------------------------------
        // 2. elementa_simulation_quiz_submissions
        // ---------------------------------------------------------------------
        console.log('\n--- [2/2] elementa_simulation_quiz_submissions ---');
        if (!(await hasColumn(conn, 'elementa_simulation_quiz_submissions', 'sy_id'))) {
            await conn.query(`
                ALTER TABLE elementa_simulation_quiz_submissions
                ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER quiz_id
            `);
            console.log('  + Added column elementa_simulation_quiz_submissions.sy_id');
        } else {
            console.log('  = Column elementa_simulation_quiz_submissions.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'elementa_simulation_quiz_submissions', 'idx_sim_sub_sy'))) {
            await conn.query(`
                ALTER TABLE elementa_simulation_quiz_submissions
                ADD INDEX idx_sim_sub_sy (sy_id)
            `);
            console.log('  + Added index idx_sim_sub_sy');
        } else {
            console.log('  = Index idx_sim_sub_sy already exists');
        }

        const [subQuizBackfill] = await conn.query(`
            UPDATE elementa_simulation_quiz_submissions s
            JOIN elementa_simulation_custom_quizzes q ON s.quiz_id = q.quiz_id
            SET s.sy_id = q.sy_id
            WHERE s.sy_id IS NULL AND q.sy_id IS NOT NULL
        `);
        const [subFallbackBackfill] = await conn.query(`
            UPDATE elementa_simulation_quiz_submissions s
            SET s.sy_id = ?
            WHERE s.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled elementa_simulation_quiz_submissions: ${subQuizBackfill.affectedRows || 0} via quiz, ${subFallbackBackfill.affectedRows || 0} via fallback`);

        // ---------------------------------------------------------------------
        // Verification
        // ---------------------------------------------------------------------
        console.log('\n--- Verification Summary ---');
        for (const tbl of ['elementa_simulation_custom_quizzes', 'elementa_simulation_quiz_submissions']) {
            const [[nullCnt]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${tbl}\` WHERE sy_id IS NULL`);
            const [[totCnt]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${tbl}\``);
            console.log(`  ${tbl}: total=${totCnt.cnt}, sy_id IS NULL=${nullCnt.cnt}`);
            if (Number(nullCnt.cnt) > 0) {
                throw new Error(`Verification failed: ${tbl} still has ${nullCnt.cnt} rows with sy_id IS NULL`);
            }
        }

        const [quizRows] = await conn.query(`
            SELECT quiz_id, simulation_slug, title, sy_id, is_active, created_at
            FROM elementa_simulation_custom_quizzes
            ORDER BY quiz_id
        `);
        console.log('\nelementa_simulation_custom_quizzes after backfill:');
        console.table(quizRows);

        const [subRows] = await conn.query(`
            SELECT submission_id, quiz_id, student_id, sy_id, simulation_slug, score, exp_earned
            FROM elementa_simulation_quiz_submissions
            ORDER BY submission_id
        `);
        console.log('elementa_simulation_quiz_submissions after backfill:');
        console.table(subRows);

        console.log('\nPhase 1 simulation quizzes migration completed and verified successfully!');
    } catch (err) {
        console.error('\nPhase 1 migration failed:', err);
        throw err;
    } finally {
        await conn.end();
    }
}

if (require.main === module) {
    runMigration()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = { runMigration };

