const db = require('../db');

async function runDecoupleAnnouncementsMigration() {
    console.log('--- Starting Announcements Decouple Migration ---');

    try {
        // 1. Check if fk_ann_topic foreign key exists
        const [fks] = await db.query(`
            SELECT CONSTRAINT_NAME 
            FROM information_schema.TABLE_CONSTRAINTS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'announcements' 
              AND CONSTRAINT_NAME = 'fk_ann_topic'
        `);

        if (fks.length > 0) {
            console.log('Dropping foreign key fk_ann_topic...');
            await db.query(`ALTER TABLE announcements DROP FOREIGN KEY fk_ann_topic`);
            console.log('Foreign key fk_ann_topic dropped.');
        } else {
            console.log('Foreign key fk_ann_topic does not exist, skipping.');
        }

        // 2. Check if topic_id column exists
        const [cols] = await db.query(`
            SELECT COLUMN_NAME 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'announcements' 
              AND COLUMN_NAME = 'topic_id'
        `);

        if (cols.length > 0) {
            console.log('Dropping column topic_id from announcements...');
            await db.query(`ALTER TABLE announcements DROP COLUMN topic_id`);
            console.log('Column topic_id dropped successfully.');
        } else {
            console.log('Column topic_id does not exist, skipping.');
        }

        console.log('--- Migration completed successfully! ---');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

runDecoupleAnnouncementsMigration();
