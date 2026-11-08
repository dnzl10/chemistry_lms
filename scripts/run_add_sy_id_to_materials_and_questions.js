/**
 * scripts/run_add_sy_id_to_materials_and_questions.js
 *
 * Adds sy_id column and index to:
 * 1. learning_materials
 * 2. elementa_questions
 *
 * Backfills existing legacy records to the baseline school year (SY 60008 - 2025-2026).
 * Follows staging-workflow.md rule.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runMigration() {
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log('   MIGRATION: ADD sy_id TO learning_materials & elementa_questions       ');
    console.log('══════════════════════════════════════════════════════════════════════════\n');

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
        ssl: { rejectUnauthorized: false }
    });

    try {
        // Find baseline school year (SY 60008 or the earliest SY)
        const [sys] = await conn.query(`SELECT sy_id, sy_range FROM school_years ORDER BY sy_id ASC LIMIT 1`);
        const baselineSyId = sys[0] ? sys[0].sy_id : 60008;
        console.log(`Baseline School Year for existing legacy records: SY ${baselineSyId} (${sys[0]?.sy_range || 'Unknown'})`);

        // 1. learning_materials
        console.log('\n--- Checking learning_materials ---');
        const [lmCols] = await conn.query('SHOW COLUMNS FROM learning_materials');
        const lmColNames = lmCols.map(c => c.Field);

        if (!lmColNames.includes('sy_id')) {
            console.log('Adding sy_id to learning_materials...');
            await conn.query(`ALTER TABLE learning_materials ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER topic_id`);
            await conn.query(`ALTER TABLE learning_materials ADD INDEX idx_learning_materials_sy (sy_id)`);
            console.log('sy_id added to learning_materials.');
        } else {
            console.log('sy_id already exists on learning_materials.');
        }

        // Backfill legacy learning_materials
        const [lmBackfill] = await conn.query(`
            UPDATE learning_materials SET sy_id = ? WHERE sy_id IS NULL
        `, [baselineSyId]);
        console.log(`Backfilled ${lmBackfill.affectedRows || 0} learning_materials to SY ${baselineSyId}.`);

        // 2. elementa_questions
        console.log('\n--- Checking elementa_questions ---');
        const [eqCols] = await conn.query('SHOW COLUMNS FROM elementa_questions');
        const eqColNames = eqCols.map(c => c.Field);

        if (!eqColNames.includes('sy_id')) {
            console.log('Adding sy_id to elementa_questions...');
            await conn.query(`ALTER TABLE elementa_questions ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER teacher_id`);
            await conn.query(`ALTER TABLE elementa_questions ADD INDEX idx_elementa_questions_sy (sy_id)`);
            console.log('sy_id added to elementa_questions.');
        } else {
            console.log('sy_id already exists on elementa_questions.');
        }

        // Backfill legacy elementa_questions
        const [eqBackfill] = await conn.query(`
            UPDATE elementa_questions SET sy_id = ? WHERE sy_id IS NULL
        `, [baselineSyId]);
        console.log(`Backfilled ${eqBackfill.affectedRows || 0} elementa_questions to SY ${baselineSyId}.`);

        console.log('\n✅ Migration completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
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
