const mysql = require('mysql2');
require('dotenv').config();

const poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
};

// Automatically enable TLS/SSL when connecting to Cloud MySQL (TiDB Cloud, Aiven, etc.)
if (
    process.env.DB_SSL === 'true' ||
    (process.env.DB_HOST && (
        process.env.DB_HOST.includes('tidbcloud.com') ||
        process.env.DB_HOST.includes('aivencloud.com')
    ))
) {
    poolConfig.ssl = {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
    };
}

const pool = mysql.createPool(poolConfig);

module.exports = pool.promise();