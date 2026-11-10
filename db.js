const mysql = require('mysql2');
require('dotenv').config();

const poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 20,
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    idleTimeout: 30000,
    maxIdle: 10,
    timezone: 'Z'
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

// Align database session timezone to UTC and relax ONLY_FULL_GROUP_BY on every new connection
pool.on('connection', (connection) => {
    connection.query("SET SESSION time_zone = '+00:00'", (err) => {
        if (err) {
            // Silently fall back if time_zone table or privilege is restricted
        }
    });
    connection.query("SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))", (err) => {
        if (err) {
            // Silently fall back if already relaxed or unsupported
        }
    });
});

module.exports = pool.promise();