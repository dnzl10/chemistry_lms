/**
 * scripts/run_arcade_telemetry_sy_scoping_migration.js
 *
 * Phase 1 Migration for Teacher Arcade Telemetry School Year Scoping:
 * 1. Adds `sy_id` + indexes (`idx_egs_sy`, `idx_egs_sy_class`) to
 *    `elementa_game_sessions`.
 * 2. Backfills `elementa_game_sessions.sy_id` deterministically:
 *    - From `classes.sy_id` when `class_id` is set.
 *    - From `assessments.sy_id` when `assessment_id` is set.
 *    - Else matches `started_at` >= active Current SY `created_at`, or
 *      non-Draft `school_years` date bounds, falling back to Current SY.
 * 3. Verifies zero NULL `sy_id` rows and zero mismatches with `classes.sy_id`.
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
    console.log('  PHASE 1 MIGRATION: ARCADE TELEMETRY SCHOOL YEAR (sy_id) SCOPING         ');
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
            SELECT sy_id, sy_range, status, is_active, start_date, end_date, created_at
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

        console.log(`Current SY: sy_id=${currentSY.sy_id} (${currentSY.sy_range}, created_at=${currentSY.created_at})\n`);

        // ---------------------------------------------------------------------
        // 1. Schema & Indexes on elementa_game_sessions
        // ---------------------------------------------------------------------
        console.log('--- [1/3] elementa_game_sessions schema & indexes ---');
        if (!(await hasColumn(conn, 'elementa_game_sessions', 'sy_id'))) {
            await conn.query(`
                ALTER TABLE elementa_game_sessions
                ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER class_id
            `);
            console.log('  + Added column elementa_game_sessions.sy_id');
        } else {
            console.log('  = Column elementa_game_sessions.sy_id already exists');
        }

        const requiredIndexes = [
            { name: 'idx_egs_sy', ddl: 'ADD INDEX idx_egs_sy (sy_id)' },
            { name: 'idx_egs_sy_class', ddl: 'ADD INDEX idx_egs_sy_class (sy_id, class_id)' }
        ];

        for (const idx of requiredIndexes) {
            if (!(await hasIndex(conn, 'elementa_game_sessions', idx.name))) {
                await conn.query(`ALTER TABLE elementa_game_sessions ${idx.ddl}`);
                console.log(`  + Added index ${idx.name}`);
            } else {
                console.log(`  = Index ${idx.name} already exists`);
            }
        }

        // ---------------------------------------------------------------------
        // 2. Backfill elementa_game_sessions.sy_id
        // ---------------------------------------------------------------------
        console.log('\n--- [2/3] elementa_game_sessions sy_id backfill ---');

        const [classBackfill] = await conn.query(`
            UPDATE elementa_game_sessions gs
            JOIN classes c ON gs.class_id = c.class_id
            SET gs.sy_id = c.sy_id
            WHERE gs.class_id IS NOT NULL
              AND c.sy_id IS NOT NULL
              AND (gs.sy_id IS NULL OR gs.sy_id <> c.sy_id)
        `);
        console.log(`  ~ Backfilled via classes.sy_id: ${classBackfill.affectedRows || 0} row(s)`);

        const [assessmentBackfill] = await conn.query(`
            UPDATE elementa_game_sessions gs
            JOIN assessments a ON gs.assessment_id = a.assessment_id
            SET gs.sy_id = a.sy_id
            WHERE gs.sy_id IS NULL
              AND gs.assessment_id IS NOT NULL
              AND a.sy_id IS NOT NULL
        `);
        console.log(`  ~ Backfilled via assessments.sy_id: ${assessmentBackfill.affectedRows || 0} row(s)`);

        const [postActivationRes] = await conn.query(`
            UPDATE elementa_game_sessions gs
            SET gs.sy_id = ?
            WHERE gs.sy_id IS NULL
              AND ? IS NOT NULL
              AND gs.started_at >= ?
        `, [currentSY.sy_id, currentSY.created_at, currentSY.created_at]);

        const [dateFallbackRes] = await conn.query(`
            UPDATE elementa_game_sessions gs
            SET gs.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND DATE(gs.started_at) BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE gs.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled remaining NULL rows: ${postActivationRes.affectedRows || 0} post-Current-SY, ${dateFallbackRes.affectedRows || 0} via date/fallback`);

        // ---------------------------------------------------------------------
        // 3. Verification Summary
        // ---------------------------------------------------------------------
        console.log('\n--- [3/3] Verification Summary ---');
        const [[nullCheck]] = await conn.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions WHERE sy_id IS NULL`);
        const [[totCheck]] = await conn.query(`SELECT COUNT(*) AS cnt FROM elementa_game_sessions`);
        const [[mismatchCheck]] = await conn.query(`
            SELECT COUNT(*) AS cnt
            FROM elementa_game_sessions gs
            JOIN classes c ON gs.class_id = c.class_id
            WHERE gs.class_id IS NOT NULL AND c.sy_id IS NOT NULL AND gs.sy_id <> c.sy_id
        `);

        console.log(`  elementa_game_sessions: total=${totCheck.cnt}, sy_id IS NULL=${nullCheck.cnt}, class_sy_mismatch=${mismatchCheck.cnt}`);
        if (Number(nullCheck.cnt) > 0 || Number(mismatchCheck.cnt) > 0) {
            throw new Error(`Verification failed: nullCheck=${nullCheck.cnt}, mismatchCheck=${mismatchCheck.cnt}`);
        }

        const [rows] = await conn.query(`
            SELECT gs.session_id, gs.student_id_p1, gs.student_id_p2, gs.class_id, gs.assessment_id,
                   gs.sy_id, sy.sy_range, sy.status AS sy_status, gs.play_mode, gs.started_at
            FROM elementa_game_sessions gs
            LEFT JOIN school_years sy ON gs.sy_id = sy.sy_id
            ORDER BY gs.session_id
        `);
        console.log('\nelementa_game_sessions after backfill:');
        console.table(rows);

        console.log('Phase 1 Arcade Telemetry migration completed and verified successfully!');
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

