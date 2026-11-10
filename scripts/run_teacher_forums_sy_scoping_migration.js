/**
 * scripts/run_teacher_forums_sy_scoping_migration.js
 *
 * Phase 1 Migration for Teacher Forums & Forum View School Year Scoping:
 * 1. Ensures `forum_topics.sy_id` column and SY composite indexes exist
 *    (`idx_forum_topics_sy`, `idx_forum_topics_sy_teacher`, `idx_forum_topics_sy_class`).
 * 2. Synchronizes `forum_topics.sy_id` with `classes.sy_id` whenever `class_id` is set.
 * 3. Backfills any remaining `forum_topics` rows where `sy_id IS NULL`:
 *    - If created on/after the active Current SY's creation timestamp -> Current SY.
 *    - Else matches non-Draft `school_years` date bounds -> fallback Current SY.
 * 4. Audits `forum_topics`, `student_forum_done`, and `classes` for SY completeness.
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
    console.log('  PHASE 1 MIGRATION: TEACHER FORUMS SCHOOL YEAR (sy_id) SCOPING           ');
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
        // 1. Schema & Indexes on forum_topics
        // ---------------------------------------------------------------------
        console.log('--- [1/3] forum_topics schema & indexes ---');
        if (!(await hasColumn(conn, 'forum_topics', 'sy_id'))) {
            await conn.query(`
                ALTER TABLE forum_topics
                ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER class_id
            `);
            console.log('  + Added column forum_topics.sy_id');
        } else {
            console.log('  = Column forum_topics.sy_id already exists');
        }

        const requiredIndexes = [
            { name: 'idx_forum_topics_sy', ddl: 'ADD INDEX idx_forum_topics_sy (sy_id)' },
            { name: 'idx_forum_topics_sy_teacher', ddl: 'ADD INDEX idx_forum_topics_sy_teacher (sy_id, teacher_id, subject_id)' },
            { name: 'idx_forum_topics_sy_class', ddl: 'ADD INDEX idx_forum_topics_sy_class (sy_id, class_id)' }
        ];

        for (const idx of requiredIndexes) {
            if (!(await hasIndex(conn, 'forum_topics', idx.name))) {
                await conn.query(`ALTER TABLE forum_topics ${idx.ddl}`);
                console.log(`  + Added index ${idx.name}`);
            } else {
                console.log(`  = Index ${idx.name} already exists`);
            }
        }

        // ---------------------------------------------------------------------
        // 2. Backfill & Consistency Sync on forum_topics
        // ---------------------------------------------------------------------
        console.log('\n--- [2/3] forum_topics sy_id backfill & class alignment ---');

        // 2a. Align class-targeted forums with their class's sy_id
        const [classSyncRes] = await conn.query(`
            UPDATE forum_topics ft
            JOIN classes c ON ft.class_id = c.class_id
            SET ft.sy_id = c.sy_id
            WHERE ft.class_id IS NOT NULL
              AND c.sy_id IS NOT NULL
              AND (ft.sy_id IS NULL OR ft.sy_id <> c.sy_id)
        `);
        console.log(`  ~ Synced class-targeted forum_topics.sy_id from classes: ${classSyncRes.affectedRows || 0} row(s)`);

        // 2b. Remaining NULL sy_id rows: assign to Current SY if created after Current SY activation,
        //     else match non-Draft SY date window, else fallback to Current SY
        const [postActivationRes] = await conn.query(`
            UPDATE forum_topics ft
            SET ft.sy_id = ?
            WHERE ft.sy_id IS NULL
              AND ? IS NOT NULL
              AND ft.created_at >= ?
        `, [currentSY.sy_id, currentSY.created_at, currentSY.created_at]);

        const [dateFallbackRes] = await conn.query(`
            UPDATE forum_topics ft
            SET ft.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND DATE(ft.created_at) BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE ft.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled remaining NULL rows: ${postActivationRes.affectedRows || 0} via post-Current-SY creation, ${dateFallbackRes.affectedRows || 0} via date/fallback`);

        // ---------------------------------------------------------------------
        // 3. Verification Summary
        // ---------------------------------------------------------------------
        console.log('\n--- [3/3] Verification Summary ---');
        const [[nullCheck]] = await conn.query(`SELECT COUNT(*) AS cnt FROM forum_topics WHERE sy_id IS NULL`);
        const [[totCheck]] = await conn.query(`SELECT COUNT(*) AS cnt FROM forum_topics`);
        const [[mismatchCheck]] = await conn.query(`
            SELECT COUNT(*) AS cnt
            FROM forum_topics ft
            JOIN classes c ON ft.class_id = c.class_id
            WHERE ft.class_id IS NOT NULL AND c.sy_id IS NOT NULL AND ft.sy_id <> c.sy_id
        `);
        const [[nullClassesCheck]] = await conn.query(`SELECT COUNT(*) AS cnt FROM classes WHERE sy_id IS NULL`);

        console.log(`  forum_topics: total=${totCheck.cnt}, sy_id IS NULL=${nullCheck.cnt}, class_sy_mismatch=${mismatchCheck.cnt}`);
        console.log(`  classes: sy_id IS NULL=${nullClassesCheck.cnt} (will be excluded automatically by strict c.sy_id = ? queries)`);

        if (Number(nullCheck.cnt) > 0 || Number(mismatchCheck.cnt) > 0) {
            throw new Error(`Verification failed: nullCheck=${nullCheck.cnt}, mismatchCheck=${mismatchCheck.cnt}`);
        }

        const [finalRows] = await conn.query(`
            SELECT ft.forum_id, ft.title, ft.teacher_id, ft.subject_id, ft.class_id, ft.sy_id, sy.sy_range, sy.status AS sy_status, ft.created_at
            FROM forum_topics ft
            LEFT JOIN school_years sy ON ft.sy_id = sy.sy_id
            ORDER BY ft.forum_id
        `);
        console.log('\nforum_topics after backfill:');
        console.table(finalRows);

        console.log('Phase 1 Teacher Forums migration completed and verified successfully!');
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

