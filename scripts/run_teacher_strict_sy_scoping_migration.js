/**
 * scripts/run_teacher_strict_sy_scoping_migration.js
 *
 * Phase 1 Migration for Teacher Portal Strict SY Scoping:
 * 1. Updates `elementa_student_grades` SQL VIEW to expose `s.sy_id AS sy_id`
 *    directly from `elementa_game_sessions.sy_id`.
 * 2. Deduplicates & backfills any remaining `student_progress` rows with
 *    `sy_id IS NULL` (merging safely with existing `uniq_student_subject_sy` rows).
 * 3. Audits SY coverage across all core Teacher Portal tables.
 *
 * Strictly targets `chemistry_lms_staging` per staging-workflow.md.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runMigration() {
    console.log('==========================================================================');
    console.log('  PHASE 1 MIGRATION: TEACHER PORTAL STRICT SCHOOL YEAR (sy_id) SCOPING    ');
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

        if (!schoolYears.length) {
            throw new Error('No school_years records found.');
        }

        const currentSY =
            schoolYears.find(sy => sy.status === 'Current' && Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status === 'Current' || Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status !== 'Draft') ||
            schoolYears[0];

        console.log(`Current SY: sy_id=${currentSY.sy_id} (${currentSY.sy_range})\n`);

        // ---------------------------------------------------------------------
        // 1. Update elementa_student_grades VIEW to expose sy_id
        // ---------------------------------------------------------------------
        console.log('--- [1/3] elementa_student_grades VIEW ---');
        await conn.query(`
            CREATE OR REPLACE VIEW \`elementa_student_grades\` AS
            SELECT
                \`s\`.\`session_id\` AS \`session_id\`,
                \`s\`.\`class_id\` AS \`class_id\`,
                \`s\`.\`sy_id\` AS \`sy_id\`,
                \`s\`.\`assessment_id\` AS \`assessment_id\`,
                (CASE \`r\`.\`player_number\` WHEN 1 THEN \`s\`.\`student_id_p1\` ELSE \`s\`.\`student_id_p2\` END) AS \`student_id\`,
                \`r\`.\`player_number\` AS \`player_number\`,
                \`r\`.\`level_number\` AS \`assessment_number\`,
                \`r\`.\`level_topic\` AS \`level_topic\`,
                \`s\`.\`play_mode\` AS \`play_mode\`,
                \`r\`.\`run_status\` AS \`run_status\`,
                COUNT(\`a\`.\`attempt_id\`) AS \`questions_attempted\`,
                SUM((CASE WHEN (\`a\`.\`is_correct\` = 1) THEN 1 ELSE 0 END)) AS \`correct_answers\`,
                COALESCE(SUM(\`a\`.\`points_awarded\`), 0) AS \`points_earned\`,
                COUNT(\`a\`.\`attempt_id\`) AS \`points_possible\`,
                ROUND(((COALESCE(SUM(\`a\`.\`points_awarded\`), 0) / NULLIF(COUNT(\`a\`.\`attempt_id\`), 0)) * 100), 2) AS \`grade_percent\`,
                ROUND(AVG(\`a\`.\`response_time_s\`), 2) AS \`avg_response_time_s\`,
                SUM((CASE WHEN (\`a\`.\`is_timeout\` = 1) THEN 1 ELSE 0 END)) AS \`timeouts\`,
                \`r\`.\`started_at\` AS \`started_at\`,
                \`r\`.\`ended_at\` AS \`ended_at\`
            FROM (\`elementa_level_runs\` \`r\`
            JOIN \`elementa_game_sessions\` \`s\` ON (\`s\`.\`session_id\` = \`r\`.\`session_id\`))
            LEFT JOIN \`elementa_customer_attempts\` \`a\` ON (\`a\`.\`run_id\` = \`r\`.\`run_id\`)
            GROUP BY
                \`s\`.\`session_id\`,
                \`s\`.\`class_id\`,
                \`s\`.\`sy_id\`,
                \`s\`.\`assessment_id\`,
                (CASE \`r\`.\`player_number\` WHEN 1 THEN \`s\`.\`student_id_p1\` ELSE \`s\`.\`student_id_p2\` END),
                \`r\`.\`player_number\`,
                \`r\`.\`level_number\`,
                \`r\`.\`level_topic\`,
                \`s\`.\`play_mode\`,
                \`r\`.\`run_status\`,
                \`r\`.\`started_at\`,
                \`r\`.\`ended_at\`
        `);
        console.log('  + Updated elementa_student_grades view with sy_id column');

        // ---------------------------------------------------------------------
        // 2. Backfill / Deduplicate student_progress NULL sy_id rows
        // ---------------------------------------------------------------------
        console.log('\n--- [2/3] student_progress NULL sy_id cleanup ---');
        const [nullProgRows] = await conn.query(`
            SELECT sp.progress_id, sp.student_id, sp.subject_id, sp.progress_percent, sp.last_accessed,
                   (SELECT c.sy_id
                    FROM class_students cs
                    JOIN classes c ON cs.class_id = c.class_id
                    LEFT JOIN school_years sy ON c.sy_id = sy.sy_id
                    WHERE cs.student_id = sp.student_id AND c.subject_id = sp.subject_id AND c.sy_id IS NOT NULL
                    ORDER BY (sy.status = 'Current') DESC, c.sy_id DESC
                    LIMIT 1) AS enrolled_sy_id
            FROM student_progress sp
            WHERE sp.sy_id IS NULL
        `);

        let mergedCount = 0;
        let updatedCount = 0;
        for (const row of nullProgRows) {
            const targetSyId = row.enrolled_sy_id || currentSY.sy_id;
            const [[existing]] = await conn.query(
                `SELECT progress_id, progress_percent, last_accessed
                 FROM student_progress
                 WHERE student_id = ? AND subject_id = ? AND sy_id = ?
                 LIMIT 1`,
                [row.student_id, row.subject_id, targetSyId]
            );
            if (existing) {
                const maxPct = Math.max(Number(existing.progress_percent || 0), Number(row.progress_percent || 0));
                const latestAccess = new Date(existing.last_accessed || 0) >= new Date(row.last_accessed || 0)
                    ? existing.last_accessed
                    : row.last_accessed;
                await conn.query(
                    `UPDATE student_progress SET progress_percent = ?, last_accessed = ? WHERE progress_id = ?`,
                    [maxPct, latestAccess, existing.progress_id]
                );
                await conn.query(`DELETE FROM student_progress WHERE progress_id = ?`, [row.progress_id]);
                mergedCount++;
            } else {
                await conn.query(
                    `UPDATE student_progress SET sy_id = ? WHERE progress_id = ?`,
                    [targetSyId, row.progress_id]
                );
                updatedCount++;
            }
        }
        console.log(`  ~ student_progress cleanup: merged=${mergedCount}, updated=${updatedCount}`);

        // ---------------------------------------------------------------------
        // 3. Verification Summary
        // ---------------------------------------------------------------------
        console.log('\n--- [3/3] Verification Summary ---');
        const syTables = [
            'elementa_student_grades',
            'student_progress',
            'assessments',
            'learning_materials',
            'announcements',
            'calendar_events',
            'forum_topics',
            'elementa_game_sessions',
            'elementa_questions'
        ];
        for (const tbl of syTables) {
            const [[cntRow]] = await conn.query(`SELECT COUNT(*) AS total, SUM(sy_id IS NULL) AS null_sy FROM \`${tbl}\``);
            console.log(`  ${tbl}: total=${cntRow.total}, sy_id IS NULL=${cntRow.null_sy || 0}`);
            if (Number(cntRow.null_sy || 0) > 0) {
                throw new Error(`Verification failed: ${tbl} still has ${cntRow.null_sy} NULL sy_id rows`);
            }
        }

        const [esgSample] = await conn.query(`SELECT session_id, class_id, sy_id, assessment_id, student_id, run_status FROM elementa_student_grades ORDER BY session_id, player_number`);
        console.log('\nelementa_student_grades view check:');
        console.table(esgSample);

        const [spRows] = await conn.query(`SELECT progress_id, student_id, subject_id, sy_id, progress_percent, last_accessed FROM student_progress ORDER BY progress_id`);
        console.log('student_progress after cleanup:');
        console.table(spRows);

        console.log('Phase 1 Teacher Portal Strict SY migration completed and verified successfully!');
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

