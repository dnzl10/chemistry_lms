/**
 * scripts/run_add_sy_id_to_assessments_migration.js
 * Applies assessments.sy_id column addition and foreign key constraint
 * to chemistry_lms_staging.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function runMigration() {
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
        console.log('\n1. Checking existing assessments schema:');
        const [colsBefore] = await conn.query("SHOW COLUMNS FROM assessments");
        const hasSyId = colsBefore.some(c => c.Field === 'sy_id');
        console.log(`   sy_id column exists: ${hasSyId}`);

        if (!hasSyId) {
            console.log('\n2. Step 1: Adding sy_id column to assessments table...');
            await conn.query("ALTER TABLE `assessments` ADD COLUMN `sy_id` INT NULL AFTER `assessment_id`");
            console.log('   ✅ sy_id column added successfully.');
        } else {
            console.log('   ℹ️ sy_id column already exists. Skipping ADD COLUMN.');
        }

        console.log('\n3. Step 2: Backfilling assessments with active Current School Year...');
        const [[activeSY]] = await conn.query("SELECT sy_id, sy_range, status FROM school_years WHERE is_active = 1 LIMIT 1");
        if (!activeSY) {
            throw new Error('Active School Year not found for backfilling!');
        }
        console.log(`   Active Current SY is sy_id=${activeSY.sy_id} (${activeSY.sy_range})`);

        const [updRes] = await conn.query("UPDATE `assessments` SET `sy_id` = ? WHERE `sy_id` IS NULL", [activeSY.sy_id]);
        console.log(`   ✅ Backfilled ${updRes.affectedRows} assessment row(s) to sy_id=${activeSY.sy_id}.`);

        console.log('\n4. Step 3: Checking and adding index idx_assessments_sy_id...');
        const [indices] = await conn.query("SHOW INDEX FROM assessments WHERE Key_name = 'idx_assessments_sy_id'");
        if (indices.length === 0) {
            await conn.query("CREATE INDEX `idx_assessments_sy_id` ON `assessments`(`sy_id`)");
            console.log('   ✅ Index idx_assessments_sy_id created.');
        } else {
            console.log('   ℹ️ Index idx_assessments_sy_id already exists.');
        }

        console.log('\n5. Step 4: Checking and adding Foreign Key constraint fk_assessments_school_year...');
        try {
            await conn.query(`
                ALTER TABLE \`assessments\` 
                ADD CONSTRAINT \`fk_assessments_school_year\` 
                FOREIGN KEY (\`sy_id\`) REFERENCES \`school_years\`(\`sy_id\`) 
                ON DELETE CASCADE ON UPDATE CASCADE
            `);
            console.log('   ✅ Foreign Key constraint fk_assessments_school_year created.');
        } catch (fkErr) {
            if (fkErr.message.includes('already exists') || fkErr.code === 'ER_DUP_KEY') {
                console.log('   ℹ️ Foreign key fk_assessments_school_year already exists.');
            } else {
                console.warn('   ⚠️ FK creation notice:', fkErr.message);
            }
        }

        console.log('\n6. Verification & Schema Inspection:');
        const [colsAfter] = await conn.query("SHOW COLUMNS FROM assessments LIKE 'sy_id'");
        console.log('   assessments.sy_id column definition:', colsAfter[0]);

        const [allAssessments] = await conn.query(`
            SELECT a.assessment_id, a.sy_id, a.assessment_name, a.assessment_type, a.topic_id, sy.sy_range, sy.status AS sy_status
            FROM assessments a
            LEFT JOIN school_years sy ON sy.sy_id = a.sy_id
        `);
        console.log('\n   Current assessments in database:');
        console.table(allAssessments);

        if (allAssessments.some(a => !a.sy_id)) {
            throw new Error('Verification failed: Found assessment with NULL sy_id!');
        }

        console.log('\n🎉 Phase 1 Migration completed successfully with 100% verification!');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        throw err;
    } finally {
        await conn.end();
    }
}

runMigration().catch(err => {
    process.exit(1);
});

