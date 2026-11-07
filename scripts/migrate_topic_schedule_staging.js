/**
 * scripts/migrate_topic_schedule_staging.js
 * ============================================================================
 * Phase 1 Migration: Adds `auto_unlock_at` and `auto_lock_at` columns to the
 * `topics` table in `chemistry_lms_staging`.
 *
 * Safe & idempotent: checks existing columns before running ALTER TABLE.
 * ============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrateTopicScheduleStaging() {
    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST || 'localhost';
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 3306;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER || 'root';
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const stagingDbName = process.env.STAGING_DB_NAME || 'chemistry_lms_staging';

    const useSsl =
        process.env.DB_SSL === 'true' ||
        (host && (host.includes('tidbcloud.com') || host.includes('aivencloud.com')));

    console.log(`🔌 Connecting to MySQL Host (${host}:${port}), Database: [${stagingDbName}]...`);

    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database: stagingDbName,
        ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
    });

    try {
        const [cols] = await conn.query(`SHOW COLUMNS FROM \`topics\``);
        const colNames = new Set(cols.map(c => c.Field));

        console.log('📋 Current `topics` columns:', Array.from(colNames).join(', '));

        if (!colNames.has('auto_unlock_at')) {
            console.log('➕ Adding column `auto_unlock_at` (DATETIME NULL DEFAULT NULL) to `topics`...');
            await conn.query(`ALTER TABLE \`topics\` ADD COLUMN \`auto_unlock_at\` DATETIME NULL DEFAULT NULL`);
            console.log('✅ Added `auto_unlock_at`.');
        } else {
            console.log('ℹ️  Column `auto_unlock_at` already exists.');
        }

        if (!colNames.has('auto_lock_at')) {
            console.log('➕ Adding column `auto_lock_at` (DATETIME NULL DEFAULT NULL) to `topics`...');
            await conn.query(`ALTER TABLE \`topics\` ADD COLUMN \`auto_lock_at\` DATETIME NULL DEFAULT NULL`);
            console.log('✅ Added `auto_lock_at`.');
        } else {
            console.log('ℹ️  Column `auto_lock_at` already exists.');
        }

        const [updatedCols] = await conn.query(`SHOW COLUMNS FROM \`topics\``);
        console.log('🎉 Updated `topics` columns:', updatedCols.map(c => `${c.Field} (${c.Type})`).join(', '));
    } finally {
        await conn.end();
    }
}

migrateTopicScheduleStaging().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});

