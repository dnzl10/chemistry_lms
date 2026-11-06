const db = require('../db');

async function runMigration() {
    console.log('Starting Announcement Architecture Migration...');
    try {
        // 1. Check & add columns to announcements table
        const [columns] = await db.query(`SHOW COLUMNS FROM announcements`);
        const colNames = columns.map(c => c.Field);
        console.log('Existing columns in announcements:', colNames);

        if (!colNames.includes('scope')) {
            console.log('Adding column `scope` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`scope\` ENUM('global', 'subject', 'class') NOT NULL DEFAULT 'class' AFTER \`class_id\``);
        }
        if (!colNames.includes('is_critical')) {
            console.log('Adding column `is_critical` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`is_critical\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`is_priority\``);
        }
        if (!colNames.includes('due_date')) {
            console.log('Adding column `due_date` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`due_date\` DATETIME NULL DEFAULT NULL AFTER \`content\``);
        }
        if (!colNames.includes('allow_replies')) {
            console.log('Adding column `allow_replies` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`allow_replies\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`due_date\``);
        }
        if (!colNames.includes('webhook_dispatched')) {
            console.log('Adding column `webhook_dispatched` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`webhook_dispatched\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`allow_replies\``);
        }
        if (!colNames.includes('attachment_url')) {
            console.log('Adding column `attachment_url` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`attachment_url\` VARCHAR(255) NULL DEFAULT NULL AFTER \`webhook_dispatched\``);
        }
        if (!colNames.includes('attachment_name')) {
            console.log('Adding column `attachment_name` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`attachment_name\` VARCHAR(255) NULL DEFAULT NULL AFTER \`attachment_url\``);
        }
        if (!colNames.includes('attachment_type')) {
            console.log('Adding column `attachment_type` to announcements...');
            await db.query(`ALTER TABLE \`announcements\` ADD COLUMN \`attachment_type\` VARCHAR(50) NULL DEFAULT NULL AFTER \`attachment_name\``);
        }

        // 2. Create announcement_acknowledgments table
        console.log('Creating table announcement_acknowledgments if not exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS \`announcement_acknowledgments\` (
                \`ack_id\` INT(11) NOT NULL AUTO_INCREMENT,
                \`announcement_id\` INT(11) NOT NULL,
                \`user_id\` INT(11) NOT NULL,
                \`response_state\` ENUM('understood', 'clarification_needed') NOT NULL,
                \`note\` VARCHAR(255) NULL DEFAULT NULL,
                \`acknowledged_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (\`ack_id\`),
                UNIQUE KEY \`uniq_ann_user\` (\`announcement_id\`, \`user_id\`),
                CONSTRAINT \`fk_ack_announcement\` FOREIGN KEY (\`announcement_id\`) REFERENCES \`announcements\` (\`announcement_id\`) ON DELETE CASCADE,
                CONSTRAINT \`fk_ack_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`user_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);

        // 3. Create announcement_comments table
        console.log('Creating table announcement_comments if not exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS \`announcement_comments\` (
                \`comment_id\` INT(11) NOT NULL AUTO_INCREMENT,
                \`announcement_id\` INT(11) NOT NULL,
                \`user_id\` INT(11) NOT NULL,
                \`comment_text\` TEXT NOT NULL,
                \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`comment_id\`),
                KEY \`announcement_id\` (\`announcement_id\`),
                CONSTRAINT \`fk_comm_announcement\` FOREIGN KEY (\`announcement_id\`) REFERENCES \`announcements\` (\`announcement_id\`) ON DELETE CASCADE,
                CONSTRAINT \`fk_comm_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`user_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);

        // 4. Create webhook_configs table
        console.log('Creating table webhook_configs if not exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS \`webhook_configs\` (
                \`config_id\` INT(11) NOT NULL AUTO_INCREMENT,
                \`scope\` ENUM('global', 'class') NOT NULL DEFAULT 'class',
                \`class_id\` INT(11) NULL DEFAULT NULL,
                \`platform\` ENUM('discord', 'telegram') NOT NULL,
                \`webhook_url\` TEXT NOT NULL,
                \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
                \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`config_id\`),
                KEY \`class_id\` (\`class_id\`),
                CONSTRAINT \`fk_webhook_class\` FOREIGN KEY (\`class_id\`) REFERENCES \`classes\` (\`class_id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);

        console.log('✅ Migration completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
}

runMigration();
