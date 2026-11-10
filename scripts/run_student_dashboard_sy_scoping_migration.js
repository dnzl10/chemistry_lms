/**
 * scripts/run_student_dashboard_sy_scoping_migration.js
 *
 * Phase 1 Migration for Student Dashboard School Year Scoping:
 * 1. Adds `sy_id` + index to `calendar_events` and backfills from classes / SY date bounds.
 * 2. Adds `sy_id` + index to `forum_topics` and backfills from classes / SY date bounds.
 * 3. Adds `sy_id` + index to `student_progress`, backfills per student enrollment / timestamp,
 *    creates `uniq_student_subject_sy (student_id, subject_id, sy_id)`, and drops legacy
 *    `unique_student_subject (student_id, subject_id)` safely (preserving FK index coverage).
 * 4. Backfills any NULL `sy_id` rows on `announcements` and `class_students`.
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
    console.log('  PHASE 1 MIGRATION: STUDENT DASHBOARD SCHOOL YEAR (sy_id) SCOPING        ');
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
        // Resolve Current SY and Baseline Earliest Non-Draft SY
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

        const nonDraftSYs = schoolYears.filter(sy => sy.status !== 'Draft');
        const baselineSY = nonDraftSYs[0] || currentSY;

        console.log(`Current SY: sy_id=${currentSY.sy_id} (${currentSY.sy_range})`);
        console.log(`Baseline SY: sy_id=${baselineSY.sy_id} (${baselineSY.sy_range})\n`);

        // ---------------------------------------------------------------------
        // 1. calendar_events
        // ---------------------------------------------------------------------
        console.log('--- [1/5] calendar_events ---');
        if (!(await hasColumn(conn, 'calendar_events', 'sy_id'))) {
            await conn.query(`ALTER TABLE calendar_events ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER class_id`);
            console.log('  + Added column calendar_events.sy_id');
        } else {
            console.log('  = Column calendar_events.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'calendar_events', 'idx_calendar_events_sy'))) {
            await conn.query(`ALTER TABLE calendar_events ADD INDEX idx_calendar_events_sy (sy_id)`);
            console.log('  + Added index idx_calendar_events_sy');
        } else {
            console.log('  = Index idx_calendar_events_sy already exists');
        }

        const [ceClassBackfill] = await conn.query(`
            UPDATE calendar_events ce
            JOIN classes c ON c.class_id = ce.class_id
            SET ce.sy_id = c.sy_id
            WHERE ce.sy_id IS NULL AND ce.class_id IS NOT NULL
        `);
        const [ceDateBackfill] = await conn.query(`
            UPDATE calendar_events ce
            SET ce.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND ce.event_date BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE ce.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled calendar_events: ${ceClassBackfill.affectedRows || 0} via class, ${ceDateBackfill.affectedRows || 0} via date/fallback`);

        // ---------------------------------------------------------------------
        // 2. forum_topics
        // ---------------------------------------------------------------------
        console.log('\n--- [2/5] forum_topics ---');
        if (!(await hasColumn(conn, 'forum_topics', 'sy_id'))) {
            await conn.query(`ALTER TABLE forum_topics ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER class_id`);
            console.log('  + Added column forum_topics.sy_id');
        } else {
            console.log('  = Column forum_topics.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'forum_topics', 'idx_forum_topics_sy'))) {
            await conn.query(`ALTER TABLE forum_topics ADD INDEX idx_forum_topics_sy (sy_id)`);
            console.log('  + Added index idx_forum_topics_sy');
        } else {
            console.log('  = Index idx_forum_topics_sy already exists');
        }

        const [ftClassBackfill] = await conn.query(`
            UPDATE forum_topics ft
            JOIN classes c ON c.class_id = ft.class_id
            SET ft.sy_id = c.sy_id
            WHERE ft.sy_id IS NULL AND ft.class_id IS NOT NULL
        `);
        const [ftDateBackfill] = await conn.query(`
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
        console.log(`  ~ Backfilled forum_topics: ${ftClassBackfill.affectedRows || 0} via class, ${ftDateBackfill.affectedRows || 0} via date/fallback`);

        // ---------------------------------------------------------------------
        // 3. student_progress
        // ---------------------------------------------------------------------
        console.log('\n--- [3/5] student_progress ---');
        if (!(await hasColumn(conn, 'student_progress', 'sy_id'))) {
            await conn.query(`ALTER TABLE student_progress ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER subject_id`);
            console.log('  + Added column student_progress.sy_id');
        } else {
            console.log('  = Column student_progress.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'student_progress', 'idx_student_progress_sy'))) {
            await conn.query(`ALTER TABLE student_progress ADD INDEX idx_student_progress_sy (sy_id)`);
            console.log('  + Added index idx_student_progress_sy');
        } else {
            console.log('  = Index idx_student_progress_sy already exists');
        }

        const [spEnrollBackfill] = await conn.query(`
            UPDATE student_progress sp
            SET sp.sy_id = (
                SELECT c.sy_id
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                JOIN school_years sy ON c.sy_id = sy.sy_id
                WHERE cs.student_id = sp.student_id
                  AND c.subject_id = sp.subject_id
                  AND sy.status <> 'Draft'
                ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                LIMIT 1
            )
            WHERE sp.sy_id IS NULL
        `);
        const [spDateBackfill] = await conn.query(`
            UPDATE student_progress sp
            SET sp.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND DATE(sp.last_accessed) BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE sp.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled student_progress: ${spEnrollBackfill.affectedRows || 0} via enrollment, ${spDateBackfill.affectedRows || 0} via date/fallback`);

        // Add new composite unique key FIRST so student_id FK stays indexed, then drop old unique key
        if (!(await hasIndex(conn, 'student_progress', 'uniq_student_subject_sy'))) {
            await conn.query(`
                ALTER TABLE student_progress
                ADD UNIQUE INDEX uniq_student_subject_sy (student_id, subject_id, sy_id)
            `);
            console.log('  + Added unique index uniq_student_subject_sy (student_id, subject_id, sy_id)');
        } else {
            console.log('  = Unique index uniq_student_subject_sy already exists');
        }

        if (await hasIndex(conn, 'student_progress', 'unique_student_subject')) {
            await conn.query(`ALTER TABLE student_progress DROP INDEX unique_student_subject`);
            console.log('  - Dropped legacy unique index unique_student_subject');
        } else {
            console.log('  = Legacy unique_student_subject already removed');
        }

        // ---------------------------------------------------------------------
        // 4. announcements (backfill any remaining NULL sy_id)
        // ---------------------------------------------------------------------
        console.log('\n--- [4/5] announcements ---');
        const [annClassBackfill] = await conn.query(`
            UPDATE announcements a
            JOIN classes c ON c.class_id = a.class_id
            SET a.sy_id = c.sy_id,
                a.subject_id = COALESCE(a.subject_id, c.subject_id)
            WHERE a.sy_id IS NULL AND a.class_id IS NOT NULL
        `);
        const [annDateBackfill] = await conn.query(`
            UPDATE announcements a
            SET a.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND DATE(a.created_at) BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE a.sy_id IS NULL
        `, [currentSY.sy_id]);
        console.log(`  ~ Backfilled announcements: ${annClassBackfill.affectedRows || 0} via class, ${annDateBackfill.affectedRows || 0} via date/fallback`);

        // ---------------------------------------------------------------------
        // 5. class_students (backfill any remaining NULL sy_id)
        // ---------------------------------------------------------------------
        console.log('\n--- [5/5] class_students ---');
        const [csBackfill] = await conn.query(`
            UPDATE class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            SET cs.sy_id = c.sy_id
            WHERE cs.sy_id IS NULL
        `);
        console.log(`  ~ Backfilled class_students: ${csBackfill.affectedRows || 0} via classes`);

        // ---------------------------------------------------------------------
        // Verification
        // ---------------------------------------------------------------------
        console.log('\n--- Verification Summary ---');
        for (const tbl of ['calendar_events', 'forum_topics', 'student_progress', 'announcements', 'class_students']) {
            const [[nullCnt]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${tbl}\` WHERE sy_id IS NULL`);
            const [[totCnt]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${tbl}\``);
            console.log(`  ${tbl}: total=${totCnt.cnt}, sy_id IS NULL=${nullCnt.cnt}`);
            if (Number(nullCnt.cnt) > 0) {
                throw new Error(`Verification failed: ${tbl} still has ${nullCnt.cnt} rows with sy_id IS NULL`);
            }
        }

        const [ftRows] = await conn.query(`SELECT forum_id, subject_id, class_id, sy_id, title FROM forum_topics`);
        console.log('\nforum_topics rows after backfill:');
        console.table(ftRows);

        const [spRows] = await conn.query(`SELECT progress_id, student_id, subject_id, sy_id, progress_percent FROM student_progress`);
        console.log('student_progress rows after backfill:');
        console.table(spRows);

        const [spIdx] = await conn.query(`SHOW INDEX FROM student_progress`);
        console.log('student_progress indexes:');
        console.table(spIdx.map(i => ({ Key_name: i.Key_name, Non_unique: i.Non_unique, Seq: i.Seq_in_index, Col: i.Column_name })));

        console.log('\nPhase 1 migration completed and verified successfully!');
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

