const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function migrateIndexes() {
    console.log('--- Migrating elementa_questions Unique Indexes to include sy_id ---');
    const conn = await mysql.createConnection({
        host: process.env.CLOUD_DB_HOST || process.env.DB_HOST,
        port: Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000,
        user: process.env.CLOUD_DB_USER || process.env.DB_USER,
        password: process.env.CLOUD_DB_PASS || process.env.DB_PASS,
        database: 'chemistry_lms_staging',
        ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
    });

    try {
        console.log('1. Updating uq_elementa_question_code to (sy_id, question_code)...');
        await conn.query('ALTER TABLE elementa_questions DROP INDEX uq_elementa_question_code');
        await conn.query('ALTER TABLE elementa_questions ADD UNIQUE KEY uq_elementa_question_code (sy_id, question_code)');
        console.log('✓ uq_elementa_question_code updated successfully.');

        console.log('2. Updating uq_elementa_level_order to (sy_id, level_number, display_order)...');
        await conn.query('ALTER TABLE elementa_questions DROP INDEX uq_elementa_level_order');
        await conn.query('ALTER TABLE elementa_questions ADD UNIQUE KEY uq_elementa_level_order (sy_id, level_number, display_order)');
        console.log('✓ uq_elementa_level_order updated successfully.');

        console.log('Index migration complete!');
        await conn.end();
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        try { await conn.end(); } catch (_) {}
        process.exit(1);
    }
}

migrateIndexes();
