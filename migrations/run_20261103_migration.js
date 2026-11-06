/**
 * run_20261103_migration.js
 * ============================================================================
 * Safe, idempotent migration runner for Elementa Simulation Assessment Quiz
 * Customizer, EXP Bonus, and Student Telemetry schema.
 * ============================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../db');

async function runMigration() {
    console.log('🚀 Running 20261103 Simulation Custom Quizzes Migration...');
    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        // 1. Create elementa_simulation_custom_quizzes
        console.log('➕ [1/3] Ensuring elementa_simulation_custom_quizzes table exists...');
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`elementa_simulation_custom_quizzes\` (
              \`quiz_id\` INT(11) NOT NULL AUTO_INCREMENT,
              \`simulation_slug\` VARCHAR(100) NOT NULL COMMENT 'Slug identifier e.g. states-of-matter-basics',
              \`title\` VARCHAR(255) NOT NULL COMMENT 'Display title of the custom assessment',
              \`description\` TEXT NULL COMMENT 'Instructions or educational guidelines',
              \`created_by\` INT(11) NOT NULL COMMENT 'FK to users.user_id (Teacher or Admin)',
              \`section\` VARCHAR(50) NULL COMMENT 'Target section scope, NULL for all sections',
              \`exp_per_question\` INT(11) NOT NULL DEFAULT 20 COMMENT 'Base EXP awarded per correct answer',
              \`total_bonus_exp\` INT(11) NOT NULL DEFAULT 100 COMMENT 'Max possible EXP bonus',
              \`expires_at\` DATETIME NOT NULL COMMENT 'Due date and time after which EXP bonus expires',
              \`is_active\` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = Active, 0 = Inactive',
              \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (\`quiz_id\`),
              KEY \`idx_sim_slug_active\` (\`simulation_slug\`, \`is_active\`, \`expires_at\`),
              KEY \`idx_sim_creator\` (\`created_by\`),
              CONSTRAINT \`fk_sim_quiz_creator\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`user_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('✅ elementa_simulation_custom_quizzes ready.');

        // 2. Create elementa_simulation_custom_questions
        console.log('➕ [2/3] Ensuring elementa_simulation_custom_questions table exists...');
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`elementa_simulation_custom_questions\` (
              \`question_id\` INT(11) NOT NULL AUTO_INCREMENT,
              \`quiz_id\` INT(11) NOT NULL COMMENT 'FK to elementa_simulation_custom_quizzes.quiz_id',
              \`question_text\` TEXT NOT NULL COMMENT 'The prompt or problem statement',
              \`question_type\` ENUM('multiple_choice', 'true_false', 'identification', 'problem_solving') NOT NULL COMMENT '4 supported automated types',
              \`options_json\` JSON NULL COMMENT 'Array of choices for multiple choice e.g. ["A", "B", "C", "D"]',
              \`correct_answer\` TEXT NOT NULL COMMENT 'Exact answer index or normalized string/number',
              \`tolerance\` DECIMAL(8, 4) NULL DEFAULT 0.0000 COMMENT 'Allowable margin of error for numerical calculations',
              \`accepted_synonyms\` TEXT NULL COMMENT 'Comma-separated accepted alternatives for identification',
              \`explanation\` TEXT NULL COMMENT 'Educational rationale shown after quiz submission',
              \`order_index\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Display sequence ordering',
              \`points\` INT(11) NOT NULL DEFAULT 1 COMMENT 'Score weight',
              \`exp_value\` INT(11) NOT NULL DEFAULT 20 COMMENT 'EXP awarded if answered correctly',
              \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (\`question_id\`),
              KEY \`idx_quiz_order\` (\`quiz_id\`, \`order_index\`),
              CONSTRAINT \`fk_sim_question_quiz\` FOREIGN KEY (\`quiz_id\`) REFERENCES \`elementa_simulation_custom_quizzes\` (\`quiz_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('✅ elementa_simulation_custom_questions ready.');

        // 3. Create elementa_simulation_quiz_submissions
        console.log('➕ [3/3] Ensuring elementa_simulation_quiz_submissions table exists...');
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`elementa_simulation_quiz_submissions\` (
              \`submission_id\` INT(11) NOT NULL AUTO_INCREMENT,
              \`quiz_id\` INT(11) NOT NULL COMMENT 'FK to elementa_simulation_custom_quizzes.quiz_id',
              \`student_id\` INT(11) NOT NULL COMMENT 'FK to users.user_id',
              \`simulation_slug\` VARCHAR(100) NOT NULL COMMENT 'Slug identifier e.g. states-of-matter-basics',
              \`score\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Total raw score achieved',
              \`total_questions\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Total question count',
              \`correct_count\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Count of correct items',
              \`incorrect_count\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Count of incorrect items',
              \`percentage\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Score percentage (0-100)',
              \`exp_earned\` INT(11) NOT NULL DEFAULT 0 COMMENT 'Total EXP bonus awarded to student',
              \`answers_payload\` JSON NOT NULL COMMENT 'Full telemetry breakdown per question',
              \`submitted_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (\`submission_id\`),
              UNIQUE KEY \`uq_student_quiz\` (\`quiz_id\`, \`student_id\`),
              KEY \`idx_sim_student\` (\`simulation_slug\`, \`student_id\`),
              KEY \`idx_sub_student\` (\`student_id\`),
              CONSTRAINT \`fk_sub_quiz\` FOREIGN KEY (\`quiz_id\`) REFERENCES \`elementa_simulation_custom_quizzes\` (\`quiz_id\`) ON DELETE CASCADE,
              CONSTRAINT \`fk_sub_student\` FOREIGN KEY (\`student_id\`) REFERENCES \`users\` (\`user_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('✅ elementa_simulation_quiz_submissions ready.');

        await conn.commit();
        console.log('🎉 Migration committed successfully!');

        // Verification query
        const [tables] = await conn.query(`SHOW TABLES LIKE 'elementa_simulation_%'`);
        console.log('📋 Verified simulation tables in database:');
        tables.forEach(t => console.log('   - ' + Object.values(t)[0]));

        return true;
    } catch (err) {
        await conn.rollback();
        console.error('❌ Migration failed and rolled back:', err.message);
        throw err;
    } finally {
        conn.release();
    }
}

if (require.main === module) {
    runMigration()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = runMigration;

