/**
 * scripts/sync_staging_db.js
 * ============================================================================
 * Automated Production-to-Staging Cloud Database Cloner for Elementa LMS.
 * Creates an isolated `chemistry_lms_staging` database on your Cloud MySQL
 * cluster (TiDB Cloud / Aiven) and clones all tables, rows, and SQL views
 * from `chemistry_lms` (or local DB) into `chemistry_lms_staging` so you can
 * safely test on the Staging URL without ever risking live Production data.
 *
 * Usage:
 *   node scripts/sync_staging_db.js
 * ============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function syncStagingDatabase() {
    const host = process.env.CLOUD_DB_HOST || process.env.DB_HOST;
    const port = Number(process.env.CLOUD_DB_PORT || process.env.DB_PORT) || 4000;
    const user = process.env.CLOUD_DB_USER || process.env.DB_USER;
    const password = process.env.CLOUD_DB_PASS || process.env.DB_PASS;
    const prodDbName = process.env.CLOUD_DB_NAME || process.env.DB_NAME || 'chemistry_lms';
    const stagingDbName = process.env.STAGING_DB_NAME || `${prodDbName}_staging`;

    if (prodDbName === stagingDbName) {
        console.error('❌ Source and Staging database names must be different!');
        process.exit(1);
    }

    const useSsl =
        process.env.DB_SSL === 'true' ||
        (host && (host.includes('tidbcloud.com') || host.includes('aivencloud.com')));

    console.log(`🔌 Connecting to MySQL Host (${host}:${port})...`);
    const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
        multipleStatements: true
    });

    console.log(`🛠️  Ensuring isolated Staging Database [${stagingDbName}] exists...`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${stagingDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`);
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0;`);

    const [tables] = await conn.query(`SHOW FULL TABLES FROM \`${prodDbName}\` WHERE Table_type = 'BASE TABLE'`);
    const tableNames = tables.map(row => Object.values(row)[0]);

    console.log(`📦 Cloning ${tableNames.length} tables from [${prodDbName}] -> [${stagingDbName}]...\n`);

    for (const table of tableNames) {
        process.stdout.write(`  ➡️  Syncing table [${table}]... `);
        const [[createRow]] = await conn.query(`SHOW CREATE TABLE \`${prodDbName}\`.\`${table}\``);
        let createSql = createRow['Create Table'];
        createSql = createSql.replace(/^CREATE TABLE/i, `CREATE TABLE IF NOT EXISTS \`${stagingDbName}\`.`);

        await conn.query(`USE \`${stagingDbName}\`;`);
        await conn.query(`DROP TABLE IF EXISTS \`${stagingDbName}\`.\`${table}\`;`);
        await conn.query(createRow['Create Table']);

        if (table === 'user_sessions') {
            console.log(`✅ (0 rows - clean session table for staging)`);
            continue;
        }

        const [rows] = await conn.query(`SELECT * FROM \`${prodDbName}\`.\`${table}\``);
        if (rows.length > 0) {
            const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
            const batchSize = 150;
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const placeholders = batch.map(() => `(${Object.keys(rows[0]).map(() => '?').join(', ')})`).join(', ');
                const flatValues = [];
                for (const r of batch) {
                    for (const k of Object.keys(rows[0])) {
                        flatValues.push(r[k]);
                    }
                }
                await conn.query(
                    `REPLACE INTO \`${stagingDbName}\`.\`${table}\` (${cols}) VALUES ${placeholders}`,
                    flatValues
                );
            }
        }
        console.log(`✅ (${rows.length} rows)`);
    }

    // Clone SQL Views into staging database
    const [views] = await conn.query(`SHOW FULL TABLES FROM \`${prodDbName}\` WHERE Table_type = 'VIEW'`);
    const viewNames = views.map(row => Object.values(row)[0]);
    if (viewNames.length > 0) {
        console.log(`\n👁️  Cloning ${viewNames.length} SQL views into [${stagingDbName}]...`);
        await conn.query(`USE \`${stagingDbName}\`;`);
        for (const view of viewNames) {
            process.stdout.write(`  ➡️  Syncing view [${view}]... `);
            const [[createRow]] = await conn.query(`SHOW CREATE VIEW \`${prodDbName}\`.\`${view}\``);
            let createSql = createRow['Create View'];
            createSql = createSql.replace(/DEFINER=`[^`]+`@`[^`]+`/i, '');
            createSql = createSql.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ');
            // Replace any hardcoded prodDbName references inside the view definition with stagingDbName
            const dbRegex = new RegExp(`\`${prodDbName}\`\\.`, 'g');
            createSql = createSql.replace(dbRegex, `\`${stagingDbName}\`.`);
            await conn.query(createSql);
            console.log(`✅`);
        }
    }

    await conn.query(`SET FOREIGN_KEY_CHECKS = 1;`);
    await conn.end();
    console.log(`\n🎉 Staging Database [${stagingDbName}] is 100% synced and ready!`);
}

syncStagingDatabase().catch(err => {
    console.error('\n❌ Staging DB Sync Error:', err);
    process.exit(1);
});

