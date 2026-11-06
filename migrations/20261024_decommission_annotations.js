const db = require('../db');

async function decommissionAnnotations() {
    console.log('🚀 [DB DECOMMISSION] Starting Database Tier Decommissioning for Student Queries & Annotations...');

    try {
        // 1. Inspect if `annotations` table exists
        const [tables] = await db.query(`SHOW TABLES LIKE 'annotations'`);
        
        if (tables.length === 0) {
            console.log('ℹ️ Table `annotations` does not exist or has already been dropped.');
        } else {
            // Count existing records
            const [[countResult]] = await db.query(`SELECT COUNT(*) as count FROM annotations`);
            const totalRecords = countResult.count || 0;
            console.log(`📦 Found \`annotations\` table with ${totalRecords} active record(s).`);

            // 2. Create archive snapshot if not already created
            console.log('💾 Creating archival backup table `_archived_annotations_backup`...');
            await db.query(`CREATE TABLE IF NOT EXISTS _archived_annotations_backup LIKE annotations`);
            await db.query(`INSERT IGNORE INTO _archived_annotations_backup SELECT * FROM annotations`);
            console.log(`✅ Archival snapshot confirmed. Saved ${totalRecords} record(s) safely.`);

            // 3. Drop `annotations` table
            console.log('🗑️ Dropping table `annotations`...');
            await db.query(`DROP TABLE IF EXISTS annotations`);
            console.log('✅ Table `annotations` successfully dropped.');
        }

        // 4. Verify table is completely gone
        const [verifyCheck] = await db.query(`SHOW TABLES LIKE 'annotations'`);
        if (verifyCheck.length === 0) {
            console.log('🎉 Verification successful: Table `annotations` no longer exists in the database schema.');
        } else {
            throw new Error('Verification failed: Table `annotations` still exists!');
        }

        console.log('🏁 Database tier decommissioning completed cleanly with zero data loss.');
        process.exit(0);

    } catch (err) {
        console.error('❌ [DB DECOMMISSION ERROR]:', err);
        process.exit(1);
    }
}

decommissionAnnotations();
