const db = require('../db');

async function run() {
    try {
        const [tables] = await db.query("SHOW TABLES LIKE 'announcement%'");
        console.log('Current announcement tables:', tables);

        const [columns] = await db.query("SHOW COLUMNS FROM announcements");
        console.log('Current announcements columns:', columns.map(c => c.Field));

        console.log('Dropping announcement_acknowledgments if exists...');
        await db.query("DROP TABLE IF EXISTS `announcement_acknowledgments`");

        console.log('Dropping announcement_comments if exists...');
        await db.query("DROP TABLE IF EXISTS `announcement_comments`");

        const hasAllowReplies = columns.some(c => c.Field === 'allow_replies');
        if (hasAllowReplies) {
            console.log('Dropping allow_replies column from announcements...');
            await db.query("ALTER TABLE `announcements` DROP COLUMN `allow_replies`");
        } else {
            console.log('allow_replies column not present or already dropped.');
        }

        const [newTables] = await db.query("SHOW TABLES LIKE 'announcement%'");
        console.log('Post-migration announcement tables:', newTables);

        const [newColumns] = await db.query("SHOW COLUMNS FROM announcements");
        console.log('Post-migration announcements columns:', newColumns.map(c => c.Field));

        console.log('Database migration completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('Migration Error:', err);
        process.exit(1);
    }
}

run();
