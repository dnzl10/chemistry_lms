const db = require('../db');

async function runMigration() {
    console.log('🚀 Running Calendar Events Subsystem Migration...');
    try {
        // 1. Modify event_type ENUM
        console.log('🔄 Updating event_type ENUM in calendar_events...');
        await db.query(`
            ALTER TABLE calendar_events 
            MODIFY COLUMN event_type ENUM('Material','Deadline','Exam','Holiday','Assignment','Arcade Session') NOT NULL DEFAULT 'Material'
        `);
        console.log('✅ event_type ENUM expanded.');

        // 2. Check if creator_role column exists
        const [roleCols] = await db.query(`SHOW COLUMNS FROM calendar_events LIKE 'creator_role'`);
        if (roleCols.length === 0) {
            console.log('➕ Adding creator_role column...');
            await db.query(`
                ALTER TABLE calendar_events 
                ADD COLUMN creator_role ENUM('Student','Teacher','Admin') NOT NULL DEFAULT 'Teacher' AFTER teacher_id
            `);
            console.log('✅ creator_role column added.');

            // Backfill creator_role from users table
            console.log('🔄 Backfilling creator_role based on user role in users table...');
            await db.query(`
                UPDATE calendar_events ce
                JOIN users u ON ce.teacher_id = u.user_id
                SET ce.creator_role = u.role
            `);
            console.log('✅ creator_role backfilled.');
        } else {
            console.log('ℹ️ creator_role already exists.');
        }

        // 3. Check if class_id column exists
        const [classCols] = await db.query(`SHOW COLUMNS FROM calendar_events LIKE 'class_id'`);
        if (classCols.length === 0) {
            console.log('➕ Adding class_id column...');
            await db.query(`
                ALTER TABLE calendar_events 
                ADD COLUMN class_id INT(11) NULL DEFAULT NULL AFTER subject_id
            `);
            console.log('✅ class_id column added.');
        } else {
            console.log('ℹ️ class_id already exists.');
        }

        // 4. Ensure index on (teacher_id, event_date)
        const [idxCreator] = await db.query(`SHOW INDEX FROM calendar_events WHERE Key_name = 'idx_cal_creator_date'`);
        if (idxCreator.length === 0) {
            console.log('➕ Creating index idx_cal_creator_date...');
            await db.query(`
                ALTER TABLE calendar_events 
                ADD KEY idx_cal_creator_date (teacher_id, event_date)
            `);
            console.log('✅ idx_cal_creator_date created.');
        }

        // 5. Ensure index on (subject_id, event_date)
        const [idxSubj] = await db.query(`SHOW INDEX FROM calendar_events WHERE Key_name = 'idx_cal_subject_date'`);
        if (idxSubj.length === 0) {
            console.log('➕ Creating index idx_cal_subject_date...');
            await db.query(`
                ALTER TABLE calendar_events 
                ADD KEY idx_cal_subject_date (subject_id, event_date)
            `);
            console.log('✅ idx_cal_subject_date created.');
        }

        console.log('🎉 Migration completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
}

runMigration();
