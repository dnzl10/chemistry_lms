const db = require('./db');

async function runSmokeTests() {
    console.log('====================================================');
    console.log('🧪 ARCADE UNIFICATION SMOKE TEST SUITE (TC-01 to TC-06)');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    // Helper
    async function assertTest(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}: ${err.message}`);
            failed++;
        }
    }

    // TC-01: Student Stats & Arcade Scores Query
    await assertTest('TC-01: Student Stats & Arcade Gradebook View Queries', async () => {
        const [[student]] = await db.query(`SELECT user_id, current_level, total_exp FROM users WHERE role = 'Student' LIMIT 1`);
        if (!student) throw new Error('No student user found in DB');

        const [arcadeGrades] = await db.query(`
            SELECT * FROM elementa_student_grades
            WHERE student_id = ?
            ORDER BY started_at DESC
            LIMIT 5
        `, [student.user_id]);

        const [[maxLvlRow]] = await db.query(`
            SELECT COALESCE(MAX(highest_level_reached), 1) AS max_lvl
            FROM elementa_game_sessions
            WHERE (student_id_p1 = ? OR student_id_p2 = ?)
        `, [student.user_id, student.user_id]);

        if (maxLvlRow.max_lvl < 1) throw new Error('Invalid max level calculated');
    });

    // TC-02: Leaderboard & Arcade Fleet Queries
    await assertTest('TC-02: Leaderboard & Arcade Fleet Queries', async () => {
        const [lb] = await db.query(`
            SELECT u.user_id, u.first_name, u.last_name, u.current_level, u.total_exp,
                   COALESCE(el.best_score_total, 0) AS arcade_score
            FROM users u
            LEFT JOIN elementa_leaderboard el ON el.student_id = u.user_id
            WHERE u.role = 'Student'
            ORDER BY u.total_exp DESC
            LIMIT 10
        `);
        if (!Array.isArray(lb)) throw new Error('Leaderboard query failed');
    });

    // TC-03: Teacher Gradebook & Analytics Retargeting Queries
    await assertTest('TC-03: Teacher Gradebook & Analytics Retargeting Queries', async () => {
        const [teacherScores] = await db.query(`
            SELECT 
                sg.student_id, sg.assessment_id, sg.assessment_number, sg.grade_percent,
                sg.points_earned, sg.points_possible, sg.started_at
            FROM elementa_student_grades sg
            LIMIT 10
        `);

        const [itemStats] = await db.query(`
            SELECT 
                ca.question_id,
                COUNT(*) AS total_attempts,
                SUM(ca.is_correct) AS correct_count,
                ROUND(AVG(ca.response_time_s), 2) AS avg_time
            FROM elementa_customer_attempts ca
            GROUP BY ca.question_id
            LIMIT 10
        `);
    });

    // TC-04: Admin Dashboard, Reports Monitoring & System Audit Queries
    await assertTest('TC-04: Admin Dashboard, Reports Monitoring & System Audit Queries', async () => {
        // Active arcade sessions
        const [sessions] = await db.query(`
            SELECT session_id, play_mode, session_status, started_at, final_score_p1, final_score_p2
            FROM elementa_game_sessions
            ORDER BY started_at DESC
            LIMIT 5
        `);

        // Class performance mapping
        const [classMapping] = await db.query(`
            SELECT
                c.class_id, c.class_name,
                COUNT(DISTINCT cs.student_id) AS studentCount,
                AVG(sg.grade_percent) AS avgScore
            FROM classes c
            LEFT JOIN class_students cs ON cs.class_id = c.class_id
            LEFT JOIN elementa_student_grades sg ON (sg.class_id = c.class_id OR sg.student_id = cs.student_id)
            GROUP BY c.class_id
            LIMIT 5
        `);

        // Test paper questions
        const [questions] = await db.query(`
            SELECT question_id, prompt, machine_name, difficulty
            FROM elementa_questions
            WHERE is_active = 1
            LIMIT 5
        `);

        // Match log
        const [matches] = await db.query(`
            SELECT session_id, final_score_p1 AS score_p1, final_score_p2 AS score_p2, started_at AS session_start
            FROM elementa_game_sessions
            WHERE play_mode = 'Versus'
            LIMIT 5
        `);
    });

    // TC-05: Confirm Dead Tables Do Not Exist & Triggers are Dropped
    await assertTest('TC-05: Confirm Dead Tables Do Not Exist & Trigger Dropped', async () => {
        const deadTables = [
            'student_responses',
            'answer_sequences',
            'assessment_questions',
            'question_bank',
            'competitive_matches',
            'active_sessions',
            'leaderboard_history',
            'level_thresholds',
            'student_forum_views',
            'notification_preferences'
        ];
        const [tables] = await db.query('SHOW TABLES');
        const existing = tables.map(r => Object.values(r)[0]);
        for (const t of deadTables) {
            if (existing.includes(t)) {
                throw new Error(`Dead table ${t} is still present in the database!`);
            }
        }

        const [triggers] = await db.query('SHOW TRIGGERS');
        const trigNames = triggers.map(t => t.Trigger);
        if (trigNames.includes('update_total_exp')) {
            throw new Error('Trigger update_total_exp is still present!');
        }
    });

    // TC-06: Verify Syntax of All Application Routes
    await assertTest('TC-06: Syntax Verification for Core Routes', async () => {
        // Require routes to ensure clean module loading
        require('./routes/admin');
        require('./routes/student');
        require('./routes/teacher');
        require('./routes/elementaRoutes');
        require('./services/arcadeGradeSyncService');
    });

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
}

runSmokeTests().catch(err => {
    console.error('Smoke test runner error:', err);
    process.exit(1);
});
