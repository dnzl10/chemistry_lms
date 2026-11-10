/**
 * scripts/run_student_strict_sy_scoping_migration.js
 *
 * Phase 2 Migration for Student Portal Strict School Year (sy_id) Scoping:
 * 1. Adds `sy_id` + `idx_el_sy` to `elementa_leaderboard` and backfills from
 *    `assessments.sy_id`, `elementa_game_sessions.sy_id`, `classes.sy_id`,
 *    and `school_years` date bounds.
 * 2. Updates `leaderboard_history` SQL VIEW to expose `el.sy_id AS sy_id`.
 * 3. Adds `sy_id` + `idx_eat_sy` to `elementa_assessment_tickets` and backfills
 *    from `assessments.sy_id`.
 * 4. Updates `question_bank` SQL VIEW to expose `elementa_questions.sy_id`.
 * 5. Backfills any remaining `NULL` `sy_id` rows on `classes` and `class_students`.
 * 6. Runs a full SY coverage audit across all student-scoped tables and views.
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
    console.log('  PHASE 2 MIGRATION: STUDENT PORTAL STRICT SCHOOL YEAR (sy_id) SCOPING    ');
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

        if (!schoolYears.length) {
            throw new Error('No school_years records found. Cannot backfill sy_id.');
        }

        const currentSY =
            schoolYears.find(sy => sy.status === 'Current' && Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status === 'Current' || Number(sy.is_active) === 1) ||
            schoolYears.find(sy => sy.status !== 'Draft') ||
            schoolYears[0];

        const nonDraftSYs = schoolYears.filter(sy => sy.status !== 'Draft');
        const baselineSY = nonDraftSYs[0] || currentSY;

        console.log(`Current SY:  sy_id=${currentSY.sy_id} (${currentSY.sy_range})`);
        console.log(`Baseline SY: sy_id=${baselineSY.sy_id} (${baselineSY.sy_range})\n`);

        // ---------------------------------------------------------------------
        // 1. elementa_leaderboard + leaderboard_history VIEW
        // ---------------------------------------------------------------------
        console.log('--- [1/5] elementa_leaderboard & leaderboard_history VIEW ---');
        if (!(await hasColumn(conn, 'elementa_leaderboard', 'sy_id'))) {
            await conn.query(`ALTER TABLE elementa_leaderboard ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER class_id`);
            console.log('  + Added column elementa_leaderboard.sy_id');
        } else {
            console.log('  = Column elementa_leaderboard.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'elementa_leaderboard', 'idx_el_sy'))) {
            await conn.query(`ALTER TABLE elementa_leaderboard ADD INDEX idx_el_sy (sy_id, class_id)`);
            console.log('  + Added index idx_el_sy');
        } else {
            console.log('  = Index idx_el_sy already exists');
        }

        const [elAsmBackfill] = await conn.query(`
            UPDATE elementa_leaderboard el
            JOIN assessments a ON el.assessment_id = a.assessment_id
            SET el.sy_id = a.sy_id
            WHERE el.sy_id IS NULL AND a.sy_id IS NOT NULL
        `);
        const [elSessionBackfill] = await conn.query(`
            UPDATE elementa_leaderboard el
            JOIN elementa_game_sessions gs ON el.best_session_id = gs.session_id
            SET el.sy_id = gs.sy_id
            WHERE el.sy_id IS NULL AND gs.sy_id IS NOT NULL
        `);
        const [elClassBackfill] = await conn.query(`
            UPDATE elementa_leaderboard el
            JOIN classes c ON el.class_id = c.class_id
            SET el.sy_id = c.sy_id
            WHERE el.sy_id IS NULL AND c.sy_id IS NOT NULL
        `);
        const [elFallback] = await conn.query(`
            UPDATE elementa_leaderboard el
            SET el.sy_id = COALESCE(
                (
                    SELECT sy.sy_id
                    FROM school_years sy
                    WHERE sy.status <> 'Draft'
                      AND sy.start_date IS NOT NULL
                      AND sy.end_date IS NOT NULL
                      AND el.last_played_at BETWEEN sy.start_date AND sy.end_date
                    ORDER BY (sy.status = 'Current') DESC, sy.start_date DESC, sy.sy_id DESC
                    LIMIT 1
                ),
                ?
            )
            WHERE el.sy_id IS NULL
        `, [baselineSY.sy_id]);
        console.log(
            `  ~ Backfilled elementa_leaderboard: ${elAsmBackfill.affectedRows || 0} via assessment, ` +
            `${elSessionBackfill.affectedRows || 0} via session, ${elClassBackfill.affectedRows || 0} via class, ` +
            `${elFallback.affectedRows || 0} via date/baseline`
        );

        await conn.query(`
            CREATE OR REPLACE VIEW \`leaderboard_history\` AS
            SELECT
                \`el\`.\`lb_id\` AS \`history_id\`,
                \`el\`.\`student_id\` AS \`student_id\`,
                (SELECT \`c\`.\`subject_id\` FROM \`classes\` AS \`c\` WHERE \`c\`.\`class_id\` = \`el\`.\`class_id\` LIMIT 1) AS \`subject_id\`,
                \`el\`.\`sy_id\` AS \`sy_id\`,
                ROW_NUMBER() OVER (ORDER BY \`el\`.\`best_score_total\` DESC) AS \`rank_achieved\`,
                \`el\`.\`best_score_total\` AS \`total_exp_snapshot\`,
                \`el\`.\`last_played_at\` AS \`awarded_date\`
            FROM \`elementa_leaderboard\` AS \`el\`
        `);
        console.log('  + Updated leaderboard_history VIEW with sy_id column');

        // ---------------------------------------------------------------------
        // 2. elementa_assessment_tickets
        // ---------------------------------------------------------------------
        console.log('\n--- [2/5] elementa_assessment_tickets ---');
        if (!(await hasColumn(conn, 'elementa_assessment_tickets', 'sy_id'))) {
            await conn.query(`ALTER TABLE elementa_assessment_tickets ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER assessment_id`);
            console.log('  + Added column elementa_assessment_tickets.sy_id');
        } else {
            console.log('  = Column elementa_assessment_tickets.sy_id already exists');
        }

        if (!(await hasIndex(conn, 'elementa_assessment_tickets', 'idx_eat_sy'))) {
            await conn.query(`ALTER TABLE elementa_assessment_tickets ADD INDEX idx_eat_sy (sy_id)`);
            console.log('  + Added index idx_eat_sy');
        } else {
            console.log('  = Index idx_eat_sy already exists');
        }

        const [eatAsmBackfill] = await conn.query(`
            UPDATE elementa_assessment_tickets eat
            JOIN assessments a ON eat.assessment_id = a.assessment_id
            SET eat.sy_id = a.sy_id
            WHERE eat.sy_id IS NULL AND a.sy_id IS NOT NULL
        `);
        const [eatFallback] = await conn.query(`
            UPDATE elementa_assessment_tickets
            SET sy_id = ?
            WHERE sy_id IS NULL
        `, [baselineSY.sy_id]);
        console.log(`  ~ Backfilled elementa_assessment_tickets: ${eatAsmBackfill.affectedRows || 0} via assessments, ${eatFallback.affectedRows || 0} via baseline`);

        // ---------------------------------------------------------------------
        // 3. question_bank VIEW (expose elementa_questions.sy_id)
        // ---------------------------------------------------------------------
        console.log('\n--- [3/5] question_bank VIEW ---');
        await conn.query(`
            CREATE OR REPLACE VIEW \`question_bank\` AS
            SELECT 
                \`question_id\`,
                \`topic_id\`,
                \`teacher_id\`,
                \`prompt\` AS \`question_text\`,
                NULL AS \`instruction_override\`,
                NULL AS \`media_path\`,
                NULL AS \`media_type\`,
                \`difficulty\`,
                'Standard' AS \`input_mode\`,
                'standard_mcq' AS \`mechanic_type\`,
                \`points\` * 100 AS \`base_exp\`,
                \`points\`,
                \`time_limit_s\` AS \`time_limit\`,
                0 AS \`is_multiple_answer\`,
                1 AS \`required_answers_count\`,
                NULL AS \`option_a\`,
                NULL AS \`option_a_image\`,
                NULL AS \`option_b\`,
                NULL AS \`option_b_image\`,
                NULL AS \`option_c\`,
                NULL AS \`option_c_image\`,
                NULL AS \`option_d\`,
                NULL AS \`option_d_image\`,
                \`answer_text\` AS \`correct_answer\`,
                NULL AS \`numeric_answer\`,
                0.0000 AS \`numeric_tolerance\`,
                0 AS \`is_ai_generated\`,
                \`verification_status\`,
                \`verified_by\`,
                \`verified_at\`,
                \`rejection_reason\`,
                \`created_at\`,
                \`updated_at\`,
                \`sy_id\`
            FROM \`elementa_questions\`
        `);
        console.log('  + Updated question_bank VIEW with sy_id column');

        // ---------------------------------------------------------------------
        // 4. Backfill any remaining NULL sy_id rows on classes & class_students
        // ---------------------------------------------------------------------
        console.log('\n--- [4/5] Remaining NULL sy_id Backfills ---');
        const [classesBackfill] = await conn.query(`
            UPDATE classes c
            SET c.sy_id = COALESCE(
                (SELECT MAX(cs.sy_id) FROM class_students cs WHERE cs.class_id = c.class_id AND cs.sy_id IS NOT NULL),
                ?
            )
            WHERE c.sy_id IS NULL
        `, [baselineSY.sy_id]);
        console.log(`  ~ classes backfilled: ${classesBackfill.affectedRows || 0}`);

        const [csBackfill] = await conn.query(`
            UPDATE class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            SET cs.sy_id = c.sy_id
            WHERE cs.sy_id IS NULL AND c.sy_id IS NOT NULL
        `);
        console.log(`  ~ class_students backfilled: ${csBackfill.affectedRows || 0}`);

        // ---------------------------------------------------------------------
        // 5. Full Student Portal SY Coverage Audit
        // ---------------------------------------------------------------------
        console.log('\n--- [5/5] Student Portal SY Coverage Audit ---');
        const auditTargets = [
            'classes',
            'class_students',
            'announcements',
            'calendar_events',
            'forum_topics',
            'learning_materials',
            'assessments',
            'student_progress',
            'elementa_game_sessions',
            'elementa_leaderboard',
            'leaderboard_history',
            'elementa_assessment_tickets',
            'elementa_questions',
            'question_bank'
        ];

        for (const tbl of auditTargets) {
            const [[row]] = await conn.query(`
                SELECT COUNT(*) AS total, SUM(CASE WHEN sy_id IS NULL THEN 1 ELSE 0 END) AS null_sy
                FROM \`${tbl}\`
            `);
            console.log(`  - ${tbl.padEnd(28)} total=${String(row.total).padEnd(4)} null_sy=${row.null_sy || 0}`);
        }

        console.log('\n[OK] Phase 2 Student Portal Strict SY migration completed on chemistry_lms_staging!');
    } catch (err) {
        console.error('\n[ERROR] Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
}

runMigration();
