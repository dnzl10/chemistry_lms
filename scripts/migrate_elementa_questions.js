/**
 * scripts/migrate_elementa_questions.js
 * ============================================================================
 * Safe migration script for Elementa Questions & Topic Alignment:
 * 1. Links Level 1 questions to topic_id = 1 (Scientific Measurement).
 * 2. Seeds Level 8 (Intermolecular Forces) and Level 9 (Organic Compounds)
 *    questions from Godot customers.json if missing.
 * 3. Ensures all seeded questions are is_active = 1 and verification_status = 'Approved'.
 *
 * Usage:
 *   node scripts/migrate_elementa_questions.js [--prod]
 *   By default, runs on DB_NAME or chemistry_lms_staging.
 * ============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function migrate() {
    const isProd = process.argv.includes('--prod');
    const dbName = isProd
        ? (process.env.CLOUD_DB_NAME || 'chemistry_lms')
        : (process.env.STAGING_DB_NAME || 'chemistry_lms_staging');

    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST || 'localhost';
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;

    const useSsl =
        process.env.DB_SSL === 'true' ||
        (host && (host.includes('tidbcloud.com') || host.includes('aivencloud.com')));

    console.log(`🔌 Connecting to MySQL (${host}:${port}) for DB: [${dbName}]...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database: dbName,
        ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
    });

    console.log(`✅ Connected to [${dbName}]. Starting migration...`);

    // 1. Link Level 1 questions to topic_id = 1 (Scientific Measurement)
    const [t1] = await conn.query('SELECT topic_id, topic_name FROM topics WHERE topic_id = 1');
    if (t1.length > 0) {
        const [updateRes] = await conn.query(
            'UPDATE elementa_questions SET topic_id = 1 WHERE level_number = 1 AND (topic_id IS NULL OR topic_id = 3)'
        );
        console.log(`✔ Linked Level 1 questions to topic_id = 1 (${updateRes.affectedRows} rows updated).`);
    }

    // 2. Load Level 8 and Level 9 questions from Godot customers.json
    const customersPath = path.join(__dirname, '..', '..', 'Elementa_Masterfile_Game', 'data', 'customers.json');
    if (!fs.existsSync(customersPath)) {
        console.warn(`⚠️ Warning: customers.json not found at ${customersPath}`);
    } else {
        const customers = JSON.parse(fs.readFileSync(customersPath, 'utf8'));
        const l8_9 = customers.filter(c => c.level === 8 || c.level === 9);

        let inserted = 0;
        let skipped = 0;

        for (const q of l8_9) {
            const qCode = String(q.id);
            const [existing] = await conn.query(
                'SELECT question_id FROM elementa_questions WHERE question_code = ? OR (level_number = ? AND prompt = ?)',
                [qCode, q.level, q.description]
            );

            if (existing.length > 0) {
                skipped++;
                continue;
            }

            await conn.query(`
                INSERT INTO elementa_questions (
                    question_code,
                    level_number,
                    topic_id,
                    topic,
                    machine_name,
                    machine_id,
                    difficulty,
                    prompt,
                    answer_text,
                    steps_json,
                    time_limit_s,
                    points,
                    display_order,
                    is_active,
                    verification_status,
                    created_at,
                    updated_at
                ) VALUES (?, ?, NULL, ?, ?, ?, 'Average', ?, ?, ?, ?, 1, ?, 1, 'Approved', NOW(), NOW())
            `, [
                qCode,
                q.level,
                q.topic,
                q.machine,
                q.machine_id || q.level,
                q.description,
                q.answer,
                JSON.stringify(q.steps || []),
                q.time_limit || 80.0,
                (q.id % 100)
            ]);
            inserted++;
        }
        console.log(`✔ Level 8 & 9 Questions: ${inserted} inserted, ${skipped} already existed.`);
    }

    // 3. Status summary
    const [counts] = await conn.query(`
        SELECT level_number, topic, COUNT(*) as total_questions,
               SUM(CASE WHEN verification_status = 'Approved' THEN 1 ELSE 0 END) as approved_count
        FROM elementa_questions
        WHERE is_active = 1
        GROUP BY level_number, topic
        ORDER BY level_number ASC
    `);
    console.log('\n📊 Current Elementa Question Bank Pool in [' + dbName + ']:');
    console.table(counts);

    await conn.end();
    console.log('🎉 Migration completed successfully.');
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
