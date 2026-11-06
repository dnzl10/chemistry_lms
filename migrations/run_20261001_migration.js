const db = require('../db');

async function runMigration() {
    console.log('🚀 Running Forum View Enhancements Migration...');
    try {
        // 1. Check if reply_title column already exists in forum_replies
        const [replyCols] = await db.query(`SHOW COLUMNS FROM forum_replies LIKE 'reply_title'`);
        if (replyCols.length === 0) {
            console.log('➕ Adding reply_title to forum_replies...');
            await db.query(`
                ALTER TABLE forum_replies
                ADD COLUMN reply_title VARCHAR(255) NULL AFTER parent_reply_id
            `);
            console.log('✅ reply_title added.');
        } else {
            console.log('ℹ️ reply_title column already exists in forum_replies.');
        }

        // 2. Check if index idx_parent_topic exists
        const [indices] = await db.query(`SHOW INDEX FROM forum_replies WHERE Key_name = 'idx_parent_topic'`);
        if (indices.length === 0) {
            console.log('➕ Creating index idx_parent_topic...');
            await db.query(`
                ALTER TABLE forum_replies
                ADD KEY idx_parent_topic (topic_id, parent_reply_id)
            `);
            console.log('✅ idx_parent_topic index created.');
        } else {
            console.log('ℹ️ idx_parent_topic index already exists.');
        }

        // 3. Create forum_reply_stars
        console.log('➕ Ensuring forum_reply_stars table exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS forum_reply_stars (
              star_id     INT(11) NOT NULL AUTO_INCREMENT,
              user_id     INT(11) NOT NULL,
              reply_id    INT(11) NOT NULL,
              created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (star_id),
              UNIQUE KEY uq_user_reply_star (user_id, reply_id),
              KEY fk_star_reply (reply_id),
              CONSTRAINT fk_star_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
              CONSTRAINT fk_star_reply FOREIGN KEY (reply_id) REFERENCES forum_replies (reply_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);
        console.log('✅ forum_reply_stars ready.');

        // 4. Create forum_reply_hidden
        console.log('➕ Ensuring forum_reply_hidden table exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS forum_reply_hidden (
              hide_id     INT(11) NOT NULL AUTO_INCREMENT,
              user_id     INT(11) NOT NULL,
              reply_id    INT(11) NOT NULL,
              created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (hide_id),
              UNIQUE KEY uq_user_reply_hide (user_id, reply_id),
              KEY fk_hide_reply (reply_id),
              CONSTRAINT fk_hide_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
              CONSTRAINT fk_hide_reply FOREIGN KEY (reply_id) REFERENCES forum_replies (reply_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);
        console.log('✅ forum_reply_hidden ready.');

        // 5. Create forum_reports
        console.log('➕ Ensuring forum_reports table exists...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS forum_reports (
              report_id   INT(11) NOT NULL AUTO_INCREMENT,
              reporter_id INT(11) NOT NULL,
              reply_id    INT(11) NOT NULL,
              reason      VARCHAR(100) NOT NULL,
              details     TEXT NULL,
              status      ENUM('pending', 'reviewed', 'dismissed', 'actioned') NOT NULL DEFAULT 'pending',
              created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (report_id),
              KEY fk_report_reply (reply_id),
              KEY fk_report_user (reporter_id),
              CONSTRAINT fk_report_user FOREIGN KEY (reporter_id) REFERENCES users (user_id) ON DELETE CASCADE,
              CONSTRAINT fk_report_reply FOREIGN KEY (reply_id) REFERENCES forum_replies (reply_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);
        console.log('✅ forum_reports ready.');

        console.log('\n🎉 ALL DATABASE MIGRATIONS COMPLETED SUCCESSFULLY!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration error:', err);
        process.exit(1);
    }
}

runMigration();
