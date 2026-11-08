/**
 * scripts/run_add_announcements_sy_scoping_migration.js
 *
 * Adds `sy_id` and `subject_id` columns to `announcements` table with indexes.
 * Backfills existing announcements with sy_id and subject_id from their linked classes.
 * Strictly adheres to staging-workflow.md rule.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runAnnouncementsSyScopingMigration() {
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log('   MIGRATION: ADD sy_id & subject_id TO announcements TABLE               ');
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
        // 1. Inspect existing columns
        const [cols] = await conn.query('SHOW COLUMNS FROM announcements');
        const colNames = cols.map(c => c.Field);
        console.log('Current announcements columns:', colNames);

        // 2. Add sy_id column if not exists
        if (!colNames.includes('sy_id')) {
            console.log('Adding sy_id column to announcements...');
            await conn.query(`
                ALTER TABLE announcements
                ADD COLUMN sy_id INT(11) NULL DEFAULT NULL AFTER teacher_id
            `);
            console.log('sy_id column added.');
        } else {
            console.log('sy_id column already exists.');
        }

        // 3. Add subject_id column if not exists
        if (!colNames.includes('subject_id')) {
            console.log('Adding subject_id column to announcements...');
            await conn.query(`
                ALTER TABLE announcements
                ADD COLUMN subject_id INT(11) NULL DEFAULT NULL AFTER sy_id
            `);
            console.log('subject_id column added.');
        } else {
            console.log('subject_id column already exists.');
        }

        // 4. Ensure indexes
        const [indexes] = await conn.query('SHOW INDEX FROM announcements');
        const indexNames = indexes.map(i => i.Key_name);

        if (!indexNames.includes('idx_announcements_sy')) {
            console.log('Adding index idx_announcements_sy...');
            await conn.query(`ALTER TABLE announcements ADD INDEX idx_announcements_sy (sy_id)`);
            console.log('Index idx_announcements_sy added.');
        }

        if (!indexNames.includes('idx_announcements_subject')) {
            console.log('Adding index idx_announcements_subject...');
            await conn.query(`ALTER TABLE announcements ADD INDEX idx_announcements_subject (subject_id)`);
            console.log('Index idx_announcements_subject added.');
        }

        // 5. Backfill existing announcements that have class_id
        console.log('Backfilling sy_id and subject_id from classes...');
        const [backfillResult] = await conn.query(`
            UPDATE announcements a
            JOIN classes c ON c.class_id = a.class_id
            SET a.sy_id = c.sy_id, a.subject_id = c.subject_id
            WHERE a.sy_id IS NULL AND a.class_id IS NOT NULL
        `);
        console.log(`Backfilled ${backfillResult.affectedRows || 0} announcements from classes.`);

        // 6. Verify final schema
        const [verifyCols] = await conn.query('SHOW COLUMNS FROM announcements');
        console.log('Final announcements columns:', verifyCols.map(c => c.Field));

        console.log('\nMigration completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
        throw err;
    } finally {
        await conn.end();
    }
}

if (require.main === module) {
    runAnnouncementsSyScopingMigration()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = { runAnnouncementsSyScopingMigration };
