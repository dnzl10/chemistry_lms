/**
 * scripts/migrate_to_cloud_db.js
 * ============================================================================
 * Automated Local-to-Cloud MySQL Database Cloner for Elementa Chemistry LMS.
 * Copies all tables, schemas, and rows from your local MySQL database directly
 * into your free Cloud MySQL database (TiDB Cloud Serverless / Aiven) without
 * needing mysqldump or external GUI tools.
 *
 * Usage:
 *   1. Add CLOUD_DB_HOST, CLOUD_DB_PORT, CLOUD_DB_USER, CLOUD_DB_PASS, CLOUD_DB_NAME
 *      to your .env file (or pass them as environment variables).
 *   2. Run: node scripts/migrate_to_cloud_db.js
 * ============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrateToCloud() {
    const cloudHost = process.env.CLOUD_DB_HOST;
    const cloudPort = Number(process.env.CLOUD_DB_PORT) || 4000;
    const cloudUser = process.env.CLOUD_DB_USER;
    const cloudPass = process.env.CLOUD_DB_PASS;
    const cloudDbName = process.env.CLOUD_DB_NAME || process.env.DB_NAME || 'chemistry_lms';

    if (!cloudHost || !cloudUser || !cloudPass) {
        console.error('\n❌ Missing Cloud DB credentials!');
        console.error('Please add the following to your .env file before running this script:\n');
        console.error('CLOUD_DB_HOST=gateway01.ap-southeast-1.prod.aws.tidbcloud.com');
        console.error('CLOUD_DB_PORT=4000');
        console.error('CLOUD_DB_USER=your_tidb_user');
        console.error('CLOUD_DB_PASS=your_tidb_password');
        console.error('CLOUD_DB_NAME=chemistry_lms\n');
        process.exit(1);
    }

    console.log('🔌 Connecting to Local MySQL...');
    const localConn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });

    console.log(`☁️  Connecting to Cloud MySQL (${cloudHost}:${cloudPort})...`);
    const cloudConn = await mysql.createConnection({
        host: cloudHost,
        port: cloudPort,
        user: cloudUser,
        password: cloudPass,
        ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        multipleStatements: true
    });

    await cloudConn.query(`CREATE DATABASE IF NOT EXISTS \`${cloudDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`);
    await cloudConn.query(`USE \`${cloudDbName}\`;`);
    await cloudConn.query(`SET FOREIGN_KEY_CHECKS = 0;`);

    const [tables] = await localConn.query(`SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'`);
    const tableNames = tables.map(row => Object.values(row)[0]);

    console.log(`📦 Found ${tableNames.length} tables to migrate...`);

    for (const table of tableNames) {
        process.stdout.write(`  ➡️  Migrating table [${table}]... `);
        const [[createRow]] = await localConn.query(`SHOW CREATE TABLE \`${table}\``);
        let createSql = createRow['Create Table'];

        // Ensure idempotency
        createSql = createSql.replace(/^CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS');
        await cloudConn.query(createSql);

        const [rows] = await localConn.query(`SELECT * FROM \`${table}\``);
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
                await cloudConn.query(
                    `REPLACE INTO \`${table}\` (${cols}) VALUES ${placeholders}`,
                    flatValues
                );
            }
        }
        console.log(`✅ (${rows.length} rows)`);
    }

    // Migrate SQL Views as well
    const [views] = await localConn.query(`SHOW FULL TABLES WHERE Table_type = 'VIEW'`);
    const viewNames = views.map(row => Object.values(row)[0]);
    if (viewNames.length > 0) {
        console.log(`\n👁️  Found ${viewNames.length} views to migrate...`);
        for (const view of viewNames) {
            process.stdout.write(`  ➡️  Migrating view [${view}]... `);
            const [[createRow]] = await localConn.query(`SHOW CREATE VIEW \`${view}\``);
            let createSql = createRow['Create View'];
            // Strip definer to ensure compatibility across different DB users
            createSql = createSql.replace(/DEFINER=`[^`]+`@`[^`]+`/i, '');
            createSql = createSql.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ');
            await cloudConn.query(createSql);
            console.log(`✅`);
        }
    }

    await cloudConn.query(`SET FOREIGN_KEY_CHECKS = 1;`);
    await localConn.end();
    await cloudConn.end();
    console.log('\n🎉 Cloud Database Migration Completed Successfully!');
}

migrateToCloud().catch(err => {
    console.error('\n❌ Migration Error:', err);
    process.exit(1);
});

