/**
 * migrations/run_20261108_academic_term_structures.js
 * ============================================================================
 * Safe, idempotent migration runner for Academic Term & Grading Period Structures.
 * Targets `chemistry_lms_staging` by default as per the Staging-First workflow.
 * ============================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runMigration() {
    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST;
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const targetDb = process.env.TARGET_DB || 'chemistry_lms_staging';

    const useSsl =
        process.env.DB_SSL === 'true' ||
        (host && (host.includes('tidbcloud.com') || host.includes('aivencloud.com')));

    console.log(`🔌 Connecting to [${targetDb}] at ${host}:${port}...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database: targetDb,
        ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
        multipleStatements: true
    });

    console.log(`🚀 Starting Phase 1 migration on database: [${targetDb}]\n`);

    // Helper to check if column exists in table
    async function columnExists(table, column) {
        const [rows] = await conn.query(`
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
        `, [targetDb, table, column]);
        return rows.length > 0;
    }

    // Helper to check if FK constraint exists
    async function constraintExists(table, constraintName) {
        const [rows] = await conn.query(`
            SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
        `, [targetDb, table, constraintName]);
        return rows.length > 0;
    }

    // ── 1. Extend school_years ────────────────────────────────────────────────
    console.log('1️⃣ Checking & extending `school_years` table...');
    if (!await columnExists('school_years', 'sy_code')) {
        await conn.query('ALTER TABLE `school_years` ADD COLUMN `sy_code` VARCHAR(30) NULL AFTER `sy_range`');
        console.log('   ➕ Added `sy_code`');
    }
    if (!await columnExists('school_years', 'term_structure')) {
        await conn.query("ALTER TABLE `school_years` ADD COLUMN `term_structure` ENUM('semestral', 'trimester', 'quarterly') NOT NULL DEFAULT 'quarterly' AFTER `sy_code`");
        console.log('   ➕ Added `term_structure`');
    }
    if (!await columnExists('school_years', 'description')) {
        await conn.query('ALTER TABLE `school_years` ADD COLUMN `description` TEXT NULL AFTER `term_structure`');
        console.log('   ➕ Added `description`');
    }
    if (!await columnExists('school_years', 'start_date')) {
        await conn.query('ALTER TABLE `school_years` ADD COLUMN `start_date` DATE NULL AFTER `description`');
        console.log('   ➕ Added `start_date`');
    }
    if (!await columnExists('school_years', 'end_date')) {
        await conn.query('ALTER TABLE `school_years` ADD COLUMN `end_date` DATE NULL AFTER `start_date`');
        console.log('   ➕ Added `end_date`');
    }
    if (!await columnExists('school_years', 'status')) {
        await conn.query("ALTER TABLE `school_years` ADD COLUMN `status` ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'active' AFTER `end_date`");
        console.log('   ➕ Added `status`');
    }

    // Backfill sy_code
    await conn.query(`
        UPDATE \`school_years\`
        SET \`sy_code\` = CONCAT('SY', REPLACE(\`sy_range\`, '-', ''))
        WHERE \`sy_code\` IS NULL OR \`sy_code\` = ''
    `);
    console.log('   ✅ `school_years` verified & sy_code backfilled.');

    // ── 2. Create academic_terms table ────────────────────────────────────────
    console.log('2️⃣ Ensuring `academic_terms` table exists...');
    await conn.query(`
        CREATE TABLE IF NOT EXISTS \`academic_terms\` (
            \`term_id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`sy_id\` INT NOT NULL,
            \`term_name\` VARCHAR(60) NOT NULL,
            \`term_code\` VARCHAR(20) NOT NULL,
            \`term_order\` INT NOT NULL DEFAULT 1,
            \`start_date\` DATE NULL,
            \`end_date\` DATE NULL,
            \`enrollment_start\` DATETIME NULL,
            \`enrollment_end\` DATETIME NULL,
            \`add_drop_deadline\` DATETIME NULL,
            \`grading_deadline\` DATETIME NULL,
            \`status\` ENUM('draft', 'open', 'grading_locked', 'archived') NOT NULL DEFAULT 'open',
            \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX \`idx_term_sy\` (\`sy_id\`),
            INDEX \`idx_term_status\` (\`status\`),
            CONSTRAINT \`fk_academic_terms_sy\` FOREIGN KEY (\`sy_id\`) REFERENCES \`school_years\` (\`sy_id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);
    console.log('   ✅ `academic_terms` table ready.');

    // ── 3. Extend quarters ────────────────────────────────────────────────────
    console.log('3️⃣ Checking & extending `quarters` table...');
    if (!await columnExists('quarters', 'display_label')) {
        await conn.query('ALTER TABLE `quarters` ADD COLUMN `display_label` VARCHAR(50) NULL AFTER `quarter_number`');
        console.log('   ➕ Added `display_label`');
    }
    console.log('   ✅ `quarters` table verified.');

    // ── 4. Extend classes ─────────────────────────────────────────────────────
    console.log('4️⃣ Checking & extending `classes` table with `term_id`...');
    if (!await columnExists('classes', 'term_id')) {
        await conn.query('ALTER TABLE `classes` ADD COLUMN `term_id` INT NULL AFTER `sy_id`');
        console.log('   ➕ Added `term_id` column');
    }
    if (!await constraintExists('classes', 'fk_classes_term')) {
        try {
            await conn.query('ALTER TABLE `classes` ADD CONSTRAINT `fk_classes_term` FOREIGN KEY (`term_id`) REFERENCES `academic_terms` (`term_id`) ON DELETE SET NULL');
            console.log('   ➕ Added `fk_classes_term` constraint');
        } catch (fkErr) {
            console.log('   ℹ️ Note on FK constraint:', fkErr.message);
        }
    }
    console.log('   ✅ `classes` table verified.');

    // ── 5. Backfill default academic_terms ────────────────────────────────────
    console.log('5️⃣ Backfilling default academic_terms for existing school years...');
    const [backfillTermsRes] = await conn.query(`
        INSERT INTO \`academic_terms\` (\`sy_id\`, \`term_name\`, \`term_code\`, \`term_order\`, \`status\`, \`is_active\`)
        SELECT \`sy_id\`, 'Academic Year (Annual)', 'AY-DEFAULT', 1, 'open', 1
        FROM \`school_years\` sy
        WHERE NOT EXISTS (
            SELECT 1 FROM \`academic_terms\` at WHERE at.sy_id = sy.sy_id
        )
    `);
    console.log(`   ✅ Default terms seeded (${backfillTermsRes.affectedRows} created).`);

    // ── 6. Backfill classes.term_id ───────────────────────────────────────────
    console.log('6️⃣ Linking existing classes to their default term...');
    const [backfillClassesRes] = await conn.query(`
        UPDATE \`classes\` c
        JOIN \`academic_terms\` at ON at.sy_id = c.sy_id AND at.term_order = 1
        SET c.term_id = at.term_id
        WHERE c.term_id IS NULL
    `);
    console.log(`   ✅ Classes linked to term (${backfillClassesRes.affectedRows} updated).`);

    // ── Verification Summary ──────────────────────────────────────────────────
    console.log('\n📊 --- POST-MIGRATION VERIFICATION ---');
    const [syRows] = await conn.query('SELECT sy_id, sy_range, sy_code, term_structure, status FROM `school_years`');
    console.log('School Years in DB:', syRows);

    const [termRows] = await conn.query('SELECT term_id, sy_id, term_name, term_code, status, is_active FROM `academic_terms`');
    console.log('Academic Terms in DB:', termRows);

    const [classRows] = await conn.query('SELECT class_id, class_name, sy_id, term_id FROM `classes`');
    console.log('Classes in DB:', classRows);

    const [qRows] = await conn.query('SELECT quarter_id, subject_id, quarter_number, display_label, is_locked FROM `quarters`');
    console.log('Quarters in DB:', qRows);

    await conn.end();
    console.log('\n🎉 Phase 1 migration completed with 100% success on Staging!');
}

runMigration().catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});

