const db = require('../db');

async function createCompatibilityView() {
    try {
        console.log('Creating compatibility view `question_bank` -> `elementa_questions`...');
        await db.query(`
            CREATE OR REPLACE VIEW question_bank AS
            SELECT 
                question_id,
                topic_id,
                teacher_id,
                prompt AS question_text,
                NULL AS instruction_override,
                NULL AS media_path,
                NULL AS media_type,
                difficulty,
                'Standard' AS input_mode,
                'standard_mcq' AS mechanic_type,
                points * 100 AS base_exp,
                points,
                time_limit_s AS time_limit,
                0 AS is_multiple_answer,
                1 AS required_answers_count,
                NULL AS option_a,
                NULL AS option_a_image,
                NULL AS option_b,
                NULL AS option_b_image,
                NULL AS option_c,
                NULL AS option_c_image,
                NULL AS option_d,
                NULL AS option_d_image,
                answer_text AS correct_answer,
                NULL AS numeric_answer,
                0.0000 AS numeric_tolerance,
                0 AS is_ai_generated,
                verification_status,
                verified_by,
                verified_at,
                rejection_reason,
                created_at,
                updated_at
            FROM elementa_questions
        `);
        console.log('Compatibility view `question_bank` created successfully!');

        // Test querying question_bank view
        const [rows] = await db.query('SELECT question_id, question_text, verification_status FROM question_bank LIMIT 3');
        console.log('Test query on `question_bank` view succeeded! Sample rows:', rows);

        process.exit(0);
    } catch (err) {
        console.error('Error creating view:', err);
        process.exit(1);
    }
}

createCompatibilityView();
