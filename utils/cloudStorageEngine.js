/**
 * utils/cloudStorageEngine.js
 * ============================================================================
 * High-Capacity Cloud Storage Engine (15 GB to 45 GB+ Free via Google Drive API v3)
 * with Multi-Account Sharding, Zero-RAM Stream Uploads, On-Demand Cloud Streaming,
 * and Automatic LRU Local Disk Cache Eviction for Free PaaS Hosts (Render/Koyeb).
 *
 * Works 100% transparently alongside existing Multer diskStorage routes,
 * routes/materials.js, AI document parsers (pdf-parse / officeparser), and
 * the Admin Storage Audit & Cleanup subsystem.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../db');

const ROOT_DIR = path.join(__dirname, '..');

// Maximum local disk space (in MB) allowed for cached uploads before LRU eviction removes
// old local copies of files that are already safely backed up in Cloud Storage.
const MAX_LOCAL_CACHE_MB = Number(process.env.MAX_LOCAL_CACHE_MB) || 200;
const MIN_AGE_BEFORE_EVICT_MS = 5 * 60 * 1000; // Keep local file for at least 5 mins after upload for AI parsing
const MAX_SHARD_BYTES = 14.2 * 1024 * 1024 * 1024; // 14.2 GB safe cap per 15 GB Google Drive account

// All upload directories across the LMS and their corresponding public URL prefixes
const MANAGED_DIRS = [
    { relDir: 'profile_pics', urlPrefixes: ['/profile_uploads'] },
    { relDir: 'public/profile_uploads', urlPrefixes: ['/profile_uploads'] },
    { relDir: 'files', urlPrefixes: ['/forum_uploads'] },
    { relDir: 'material_uploads', urlPrefixes: ['/material_uploads', '/uploads/materials'] },
    { relDir: 'public/material_uploads', urlPrefixes: ['/material_uploads', '/uploads/materials'] },
    { relDir: 'material_uploads/audio_notes', urlPrefixes: ['/material_uploads/audio_notes', '/uploads/materials/audio_notes'] },
    { relDir: 'public/announcement_uploads', urlPrefixes: ['/announcement_uploads'] },
    { relDir: 'public/assignment_templates', urlPrefixes: ['/assignment_templates'] },
    { relDir: 'public/assignment_samples', urlPrefixes: ['/assignment_samples'] },
    { relDir: 'public/uploads/question_media', urlPrefixes: ['/uploads/question_media'] },
    { relDir: 'public/uploads/choice_images', urlPrefixes: ['/uploads/choice_images'] },
    { relDir: 'public/forum_banners', urlPrefixes: ['/forum_banners'] }
];

const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4'
};

function getMimeType(filename) {
    const ext = path.extname(filename || '').toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}

// ============================================================================
// GOOGLE DRIVE API v3 MULTI-ACCOUNT SHARD MANAGER
// ============================================================================
class CloudStorageEngine {
    constructor() {
        this.initialized = false;
        this.syncInProgress = false;
        this.uploadingSet = new Set();
        this.shards = [];
        this._loadShardsFromEnv();
    }

    _loadShardsFromEnv() {
        const clientId = process.env.GDRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GDRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

        if (!clientId || !clientSecret) return;

        const tokens = [
            { id: 'gdrive_1', token: process.env.GDRIVE_REFRESH_TOKEN },
            { id: 'gdrive_2', token: process.env.GDRIVE_REFRESH_TOKEN_2 },
            { id: 'gdrive_3', token: process.env.GDRIVE_REFRESH_TOKEN_3 }
        ].filter(t => t.token && t.token.trim() !== '');

        this.shards = tokens.map(t => ({
            id: t.id,
            clientId,
            clientSecret,
            refreshToken: t.token.trim(),
            accessToken: null,
            tokenExpiresAt: 0,
            vaultFolderId: null
        }));
    }

    isEnabled() {
        return this.shards.length > 0;
    }

    async init() {
        if (this.initialized) return;
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS \`cloud_file_registry\` (
                    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                    \`rel_dir\` VARCHAR(120) NOT NULL,
                    \`filename\` VARCHAR(255) NOT NULL,
                    \`cloud_provider\` VARCHAR(32) NOT NULL DEFAULT 'gdrive_1',
                    \`cloud_file_id\` VARCHAR(255) NOT NULL,
                    \`size_bytes\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    \`mime_type\` VARCHAR(120) DEFAULT 'application/octet-stream',
                    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY \`uq_rel_dir_filename\` (\`rel_dir\`, \`filename\`),
                    INDEX \`idx_cloud_filename\` (\`filename\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `);
            this.initialized = true;

            if (this.isEnabled()) {
                console.log(`[CloudStorage] Initialized with ${this.shards.length} Google Drive storage shard(s) (${this.shards.length * 15} GB capacity).`);
                // Start background sync loop every 25 seconds
                this.syncTimer = setInterval(() => {
                    this.syncAllDirectories().catch(err => {
                        console.warn('[CloudStorage Sync Warning]', err.message);
                    });
                }, 25 * 1000);
                if (this.syncTimer.unref) this.syncTimer.unref();

                // Trigger initial scan 5 seconds after boot
                setTimeout(() => {
                    this.syncAllDirectories().catch(() => { });
                }, 5000);
            } else {
                console.log('[CloudStorage] Running in local-disk mode (set GDRIVE_REFRESH_TOKEN in .env to enable 15GB-45GB cloud vault).');
            }
        } catch (err) {
            console.warn('[CloudStorage] Table initialization error:', err.message);
        }
    }

    async _getAccessToken(shard) {
        if (shard.accessToken && Date.now() < shard.tokenExpiresAt - 60000) {
            return shard.accessToken;
        }

        const params = new URLSearchParams({
            client_id: shard.clientId,
            client_secret: shard.clientSecret,
            refresh_token: shard.refreshToken,
            grant_type: 'refresh_token'
        });

        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Google Drive OAuth token refresh failed (${shard.id}): ${errText}`);
        }

        const data = await resp.json();
        shard.accessToken = data.access_token;
        shard.tokenExpiresAt = Date.now() + ((data.expires_in || 3599) * 1000);
        return shard.accessToken;
    }

    async _ensureVaultFolder(shard) {
        if (shard.vaultFolderId) return shard.vaultFolderId;
        const token = await this._getAccessToken(shard);
        const folderName = process.env.GDRIVE_VAULT_FOLDER || (process.env.APP_ENV === 'staging' ? 'Elementa_LMS_Cloud_Vault_Staging' : 'Elementa_LMS_Cloud_Vault');

        const q = encodeURIComponent(`name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (searchResp.ok) {
            const searchData = await searchResp.json();
            if (searchData.files && searchData.files.length > 0) {
                shard.vaultFolderId = searchData.files[0].id;
                return shard.vaultFolderId;
            }
        }

        const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            })
        });

        if (!createResp.ok) {
            throw new Error(`Failed to create Drive vault folder: ${await createResp.text()}`);
        }
        const created = await createResp.json();
        shard.vaultFolderId = created.id;
        return shard.vaultFolderId;
    }

    async _pickBestShard(fileSizeBytes = 0) {
        if (this.shards.length === 1) return this.shards[0];

        try {
            const [rows] = await db.query(
                `SELECT cloud_provider, SUM(size_bytes) AS used_bytes
                 FROM cloud_file_registry
                 GROUP BY cloud_provider`
            );
            const usageMap = new Map();
            rows.forEach(r => usageMap.set(r.cloud_provider, Number(r.used_bytes) || 0));

            for (const shard of this.shards) {
                const used = usageMap.get(shard.id) || 0;
                if (used + fileSizeBytes < MAX_SHARD_BYTES) {
                    return shard;
                }
            }
        } catch (_) { }

        return this.shards[0];
    }

    /**
     * Streams a file from local disk to Google Drive using Resumable Upload API
     * so large 100MB files never consume Node.js heap RAM.
     */
    async uploadFileToCloud(relDir, filename, absFilePath) {
        if (!this.isEnabled()) return null;
        await this.init();

        const normalizedDir = relDir.replace(/\\/g, '/');
        const lockKey = `${normalizedDir}/${filename}`;
        if (this.uploadingSet.has(lockKey)) return null;

        this.uploadingSet.add(lockKey);
        try {
            if (!fs.existsSync(absFilePath)) return null;
            const stat = fs.statSync(absFilePath);
            if (!stat.isFile() || stat.size === 0) return null;

            const shard = await this._pickBestShard(stat.size);
            const token = await this._getAccessToken(shard);
            const folderId = await this._ensureVaultFolder(shard);
            const mimeType = getMimeType(filename);

            // Step 1: Initiate Resumable Upload Session
            const initResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Type': mimeType,
                    'X-Upload-Content-Length': String(stat.size)
                },
                body: JSON.stringify({
                    name: `${normalizedDir.replace(/\//g, '__')}__${filename}`,
                    parents: [folderId],
                    description: `Elementa LMS (${normalizedDir}/${filename})`
                })
            });

            if (!initResp.ok) {
                throw new Error(`Resumable upload init failed: ${await initResp.text()}`);
            }

            const uploadUrl = initResp.headers.get('location');
            if (!uploadUrl) {
                throw new Error('No resumable upload location header returned from Google Drive');
            }

            // Step 2: Stream file bytes via native https request
            const uploadedMeta = await new Promise((resolve, reject) => {
                const urlObj = new URL(uploadUrl);
                const req = https.request({
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'PUT',
                    headers: {
                        'Content-Type': mimeType,
                        'Content-Length': stat.size
                    }
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(body));
                            } catch (e) {
                                reject(new Error(`Invalid JSON from Drive upload: ${body}`));
                            }
                        } else {
                            reject(new Error(`Drive stream upload failed (${res.statusCode}): ${body}`));
                        }
                    });
                });

                req.on('error', reject);
                const readStream = fs.createReadStream(absFilePath);
                readStream.on('error', reject);
                readStream.pipe(req);
            });

            if (uploadedMeta && uploadedMeta.id) {
                await db.query(
                    `INSERT INTO cloud_file_registry (rel_dir, filename, cloud_provider, cloud_file_id, size_bytes, mime_type)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        cloud_provider = VALUES(cloud_provider),
                        cloud_file_id = VALUES(cloud_file_id),
                        size_bytes = VALUES(size_bytes),
                        mime_type = VALUES(mime_type)`,
                    [normalizedDir, filename, shard.id, uploadedMeta.id, stat.size, mimeType]
                );
                return uploadedMeta.id;
            }
            return null;
        } catch (err) {
            console.warn(`[CloudStorage] Upload failed for ${normalizedDir}/${filename}:`, err.message);
            return null;
        } finally {
            this.uploadingSet.delete(lockKey);
        }
    }

    /**
     * Background scan: uploads any new local files to Cloud Storage and runs LRU disk cache eviction.
     */
    async syncAllDirectories() {
        if (!this.isEnabled() || this.syncInProgress) return;
        this.syncInProgress = true;
        try {
            await this.init();
            const [existingRows] = await db.query(`SELECT rel_dir, filename FROM cloud_file_registry`);
            const syncedSet = new Set(existingRows.map(r => `${r.rel_dir}/${r.filename}`));

            const localFilesForEvictionCheck = [];
            let totalLocalBytes = 0;

            for (const dirDef of MANAGED_DIRS) {
                const absDir = path.join(ROOT_DIR, dirDef.relDir);
                if (!fs.existsSync(absDir)) continue;

                const entries = fs.readdirSync(absDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) continue;
                    const fname = entry.name;
                    if (fname === '.gitkeep' || fname === '.DS_Store' || fname === 'Thumbs.db') continue;

                    const absPath = path.join(absDir, fname);
                    let stat;
                    try {
                        stat = fs.statSync(absPath);
                    } catch (_) {
                        continue;
                    }

                    const key = `${dirDef.relDir}/${fname}`;
                    if (!syncedSet.has(key)) {
                        const cloudId = await this.uploadFileToCloud(dirDef.relDir, fname, absPath);
                        if (cloudId) {
                            syncedSet.add(key);
                        }
                    }

                    if (syncedSet.has(key)) {
                        totalLocalBytes += stat.size;
                        localFilesForEvictionCheck.push({
                            absPath,
                            size: stat.size,
                            mtimeMs: stat.mtimeMs
                        });
                    }
                }
            }

            // LRU Local Disk Guard: If local cache exceeds MAX_LOCAL_CACHE_MB, remove oldest synced local files
            const maxBytes = MAX_LOCAL_CACHE_MB * 1024 * 1024;
            if (totalLocalBytes > maxBytes) {
                localFilesForEvictionCheck.sort((a, b) => a.mtimeMs - b.mtimeMs);
                const now = Date.now();
                for (const item of localFilesForEvictionCheck) {
                    if (totalLocalBytes <= maxBytes * 0.8) break; // Evict down to 80% threshold
                    if (now - item.mtimeMs < MIN_AGE_BEFORE_EVICT_MS) continue; // Keep recent files for AI parsing
                    try {
                        fs.unlinkSync(item.absPath);
                        totalLocalBytes -= item.size;
                    } catch (_) { }
                }
            }
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * Looks up a file in cloud_file_registry by exact or sanitized filename.
     */
    async findCloudRecord(filename, preferredRelDirs = null) {
        await this.init();
        const cleanName = path.basename(filename || '').trim();
        if (!cleanName) return null;

        const variants = Array.from(new Set([
            cleanName,
            cleanName.replace(/\(/g, '_').replace(/\)/g, '_'),
            cleanName.replace(/\(/g, '__').replace(/\)/g, '_'),
            cleanName.replace(/__/g, '_'),
            cleanName.replace(/_/g, ' '),
            cleanName.replace(/ /g, '_')
        ]));

        const placeholders = variants.map(() => '?').join(',');
        let sql = `SELECT * FROM cloud_file_registry WHERE filename IN (${placeholders})`;
        const params = [...variants];

        if (Array.isArray(preferredRelDirs) && preferredRelDirs.length > 0) {
            const dirPlaceholders = preferredRelDirs.map(() => '?').join(',');
            sql += ` ORDER BY FIELD(rel_dir, ${dirPlaceholders}) DESC, id DESC LIMIT 1`;
            params.push(...preferredRelDirs);
        } else {
            sql += ` ORDER BY id DESC LIMIT 1`;
        }

        const [rows] = await db.query(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Ensures a file exists on local disk (downloading from Cloud Storage if evicted/missing).
     * Useful when routes/materials.js or a parser needs the file on disk.
     */
    async ensureFileOnLocalDisk(filename, preferredRelDirs = null) {
        if (!this.isEnabled()) return null;
        const record = await this.findCloudRecord(filename, preferredRelDirs);
        if (!record) return null;

        const shard = this.shards.find(s => s.id === record.cloud_provider) || this.shards[0];
        if (!shard) return null;

        const targetDir = path.join(ROOT_DIR, record.rel_dir);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        const targetPath = path.join(targetDir, record.filename);
        if (fs.existsSync(targetPath)) return targetPath;

        try {
            const token = await this._getAccessToken(shard);
            const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.cloud_file_id)}?alt=media`;

            await new Promise((resolve, reject) => {
                const urlObj = new URL(driveUrl);
                https.get({
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    headers: { Authorization: `Bearer ${token}` }
                }, (res) => {
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`Drive download returned HTTP ${res.statusCode}`));
                    }
                    const fileStream = fs.createWriteStream(targetPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => {
                        fileStream.close(resolve);
                    });
                    fileStream.on('error', (err) => {
                        try { fs.unlinkSync(targetPath); } catch (_) { }
                        reject(err);
                    });
                }).on('error', reject);
            });

            return targetPath;
        } catch (err) {
            console.warn(`[CloudStorage] Failed to restore ${record.filename} to disk:`, err.message);
            return null;
        }
    }

    /**
     * Streams a cloud file directly to an Express HTTP response (with Range support for audio/video).
     */
    async streamCloudRecordToResponse(record, req, res) {
        const shard = this.shards.find(s => s.id === record.cloud_provider) || this.shards[0];
        if (!shard) return false;

        const token = await this._getAccessToken(shard);
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.cloud_file_id)}?alt=media`;
        const urlObj = new URL(driveUrl);

        const headers = { Authorization: `Bearer ${token}` };
        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        return new Promise((resolve) => {
            https.get({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers
            }, (driveRes) => {
                if (driveRes.statusCode !== 200 && driveRes.statusCode !== 206) {
                    driveRes.resume();
                    return resolve(false);
                }

                res.status(driveRes.statusCode);
                res.setHeader('Content-Type', record.mime_type || getMimeType(record.filename));
                res.setHeader('Accept-Ranges', 'bytes');
                if (driveRes.headers['content-length']) {
                    res.setHeader('Content-Length', driveRes.headers['content-length']);
                }
                if (driveRes.headers['content-range']) {
                    res.setHeader('Content-Range', driveRes.headers['content-range']);
                }
                res.setHeader('Cache-Control', 'public, max-age=3600');

                driveRes.pipe(res);
                driveRes.on('end', () => resolve(true));
                driveRes.on('error', () => resolve(false));
            }).on('error', () => resolve(false));
        });
    }

    /**
     * Express middleware that intercepts requests to upload URL prefixes and streams
     * from Cloud Storage whenever a file is not present in the local container cache.
     */
    middleware() {
        return async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            if (!this.isEnabled()) return next();

            const reqPath = decodeURIComponent(req.path || '');
            let matchedDirs = [];

            for (const dirDef of MANAGED_DIRS) {
                for (const prefix of dirDef.urlPrefixes) {
                    if (reqPath.startsWith(prefix + '/')) {
                        const relFile = reqPath.slice(prefix.length + 1);
                        if (relFile && !relFile.includes('..')) {
                            const localCandidate = path.join(ROOT_DIR, dirDef.relDir, relFile);
                            if (fs.existsSync(localCandidate)) {
                                // File is already on local disk; let express.static or materials.js serve it
                                return next();
                            }
                            matchedDirs.push({ relDir: dirDef.relDir, filename: path.basename(relFile) });
                        }
                    }
                }
            }

            if (matchedDirs.length === 0) return next();

            try {
                const targetFilename = matchedDirs[0].filename;
                const preferredRelDirs = matchedDirs.map(m => m.relDir);
                const record = await this.findCloudRecord(targetFilename, preferredRelDirs);
                if (!record) return next();

                // Stream directly from Cloud Storage to client
                const streamed = await this.streamCloudRecordToResponse(record, req, res);
                if (streamed) return;
            } catch (err) {
                console.warn('[CloudStorage Middleware Error]', err.message);
            }

            return next();
        };
    }

    /**
     * Deletes a file from both Google Drive and cloud_file_registry (used by Admin orphan cleanup).
     */
    async deleteCloudFile(relDir, filename) {
        await this.init();
        const normalizedDir = relDir.replace(/\\/g, '/');
        try {
            const [rows] = await db.query(
                `SELECT * FROM cloud_file_registry WHERE rel_dir = ? AND filename = ? LIMIT 1`,
                [normalizedDir, filename]
            );
            if (rows.length > 0 && this.isEnabled()) {
                // Safety guard: in Staging, never physically delete files from Google Drive unless explicitly overridden,
                // so cloned cloud_file_registry rows pointing to Production Drive files are 100% protected.
                const isStaging = (process.env.APP_ENV || '').toLowerCase() === 'staging';
                if (!isStaging || process.env.STAGING_ALLOW_DRIVE_DELETE === 'true') {
                    const record = rows[0];
                    const shard = this.shards.find(s => s.id === record.cloud_provider) || this.shards[0];
                    if (shard) {
                        const token = await this._getAccessToken(shard);
                        await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.cloud_file_id)}`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${token}` }
                        }).catch(() => { });
                    }
                } else {
                    console.log(`[CloudStorage Staging Guard] Skipped physical Drive deletion for ${normalizedDir}/${filename}`);
                }
            }
            await db.query(
                `DELETE FROM cloud_file_registry WHERE rel_dir = ? AND filename = ?`,
                [normalizedDir, filename]
            );
        } catch (err) {
            console.warn(`[CloudStorage] Failed to delete cloud record ${normalizedDir}/${filename}:`, err.message);
        }
    }
}

const cloudStorageEngine = new CloudStorageEngine();
module.exports = cloudStorageEngine;
