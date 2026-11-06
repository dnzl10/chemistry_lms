const db = require('../db');

async function runMigration() {
    try {
        console.log('[Migration] Checking columns in users table...');
        const [cols] = await db.query("SHOW COLUMNS FROM users LIKE 'is_ghost_mode'");
        if (cols.length === 0) {
            console.log('[Migration] Adding is_ghost_mode, ghost_name, ghost_avatar to users...');
            await db.query(`
                ALTER TABLE users
                  ADD COLUMN is_ghost_mode TINYINT(1) NOT NULL DEFAULT 0 AFTER is_ready_for_arcade,
                  ADD COLUMN ghost_name VARCHAR(100) DEFAULT NULL AFTER is_ghost_mode,
                  ADD COLUMN ghost_avatar VARCHAR(255) DEFAULT 'ghost_avatar_1.png' AFTER ghost_name
            `);
            console.log('[Migration] Migration successful! Columns added.');
        } else {
            console.log('[Migration] Columns already exist. No migration needed.');
        }
        process.exit(0);
    } catch (err) {
        console.error('[Migration Error]', err);
        process.exit(1);
    }
}

runMigration();
