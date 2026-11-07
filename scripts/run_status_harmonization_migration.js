/**
 * scripts/run_status_harmonization_migration.js
 * Applies status harmonization: ENUM('Current', 'Draft', 'Archive')
 * to chemistry_lms_staging.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runHarmonizationMigration() {
    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST;
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const database = 'chemistry_lms_staging';

    console.log(`🔌 Connecting to TiDB Cloud (${host}:${port}/${database})...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database,
        ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        multipleStatements: true
    });

    try {
        console.log('\n1. Checking existing school_years status column definition:');
        const [colsBefore] = await conn.query("SHOW COLUMNS FROM school_years LIKE 'status'");
        console.log('  Current column:', colsBefore[0]);

        console.log('\n2. Step 1: Temporarily expanding ENUM to include both legacy and new statuses...');
        await conn.query("ALTER TABLE `school_years` MODIFY COLUMN `status` ENUM('Current', 'Draft', 'Archive', 'Active', 'Archived') NOT NULL DEFAULT 'Draft'");
        console.log('  ✅ Expanded ENUM applied successfully.');

        console.log('\n3. Step 2: Harmonizing existing rows...');
        const [updActive] = await conn.query("UPDATE `school_years` SET `status` = 'Current' WHERE `is_active` = 1 OR `status` = 'Active'");
        console.log(`  ✅ Updated ${updActive.affectedRows} active row(s) to 'Current'.`);

        const [updArchived] = await conn.query("UPDATE `school_years` SET `status` = 'Archive' WHERE `status` = 'Archived' OR (`is_active` = 0 AND `status` != 'Draft' AND `status` != 'Current')");
        console.log(`  ✅ Updated ${updArchived.affectedRows} archived row(s) to 'Archive'.`);

        console.log('\n4. Step 3: Shrinking ENUM to canonical 3 statuses: ENUM(\'Current\', \'Draft\', \'Archive\')...');
        await conn.query("ALTER TABLE `school_years` MODIFY COLUMN `status` ENUM('Current', 'Draft', 'Archive') NOT NULL DEFAULT 'Draft'");
        console.log('  ✅ Final canonical ENUM applied successfully.');

        console.log('\n5. Verification & Schema Inspection:');
        const [colsAfter] = await conn.query("SHOW COLUMNS FROM school_years LIKE 'status'");
        console.log('  New column definition:', colsAfter[0]);

        const [allSY] = await conn.query("SELECT sy_id, sy_range, sy_code, status, is_active FROM school_years ORDER BY is_active DESC, sy_range ASC");
        console.log('\n  Current School Years in database:');
        console.table(allSY);

        // Assertions
        const currentCount = allSY.filter(s => s.status === 'Current').length;
        if (currentCount > 1) {
            console.warn('⚠️ Warning: Multiple Current school years detected. Normalizing...');
            const latestCurrentId = allSY.find(s => s.status === 'Current').sy_id;
            await conn.query("UPDATE school_years SET status = 'Archive', is_active = 0 WHERE status = 'Current' AND sy_id != ?", [latestCurrentId]);
        }

        console.log('\n🎉 PHASE 1 DATABASE MIGRATION COMPLETED SUCCESSFULLY!');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    } finally {
        await conn.end();
    }
}

runHarmonizationMigration();
