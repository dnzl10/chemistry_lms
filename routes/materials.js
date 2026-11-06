const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const cloudStorageEngine = require('../utils/cloudStorageEngine');

// Available directories where materials and related assets may reside
const SEARCH_DIRS = [
    path.join(__dirname, '..', 'public', 'material_uploads'),
    path.join(__dirname, '..', 'material_uploads'),
    path.join(__dirname, '..', 'material_uploads', 'audio_notes'),
    path.join(__dirname, '..', 'files')
];

/**
 * Robust asset resolution:
 * 1. Checks exact file in all known upload directories.
 * 2. Checks sanitized / normalized filename variations (spaces, parentheses, double underscores).
 * 3. Consults database `learning_materials` table for mapped file paths.
 * 4. Fuzzy searches by core semantic name across directories.
 */
router.get('/:filename', ensureAuthenticated, async (req, res) => {
    try {
        let rawFilename = req.params.filename || req.params[0] || '';
        let filename = decodeURIComponent(rawFilename).trim();

        // Strip leading folder prefixes if present in URL
        filename = filename.replace(/^(\/?(material_uploads|uploads\/materials|files)\/)+/, '');

        // Prevent path traversal
        if (!filename || filename.includes('..')) {
            return res.status(403).send('Forbidden: Invalid file path');
        }

        // ── 1. Direct File System Check ─────────────────────────────
        for (const dir of SEARCH_DIRS) {
            const fullPath = path.join(dir, filename);
            if (fs.existsSync(fullPath)) {
                try {
                    if (fs.statSync(fullPath).isFile()) {
                        return res.sendFile(path.resolve(fullPath));
                    }
                } catch (_) {}
            }
        }

        // ── 2. Common Sanitization Variations ───────────────────────
        const variants = [
            filename.replace(/\(/g, '_').replace(/\)/g, '_'),
            filename.replace(/\(/g, '__').replace(/\)/g, '_'),
            filename.replace(/__/g, '_'),
            filename.replace(/_/g, ' '),
            filename.replace(/ /g, '_'),
            filename.replace(/\+/g, ' ')
        ];

        for (const variant of variants) {
            for (const dir of SEARCH_DIRS) {
                const fullPath = path.join(dir, variant);
                if (fs.existsSync(fullPath)) {
                    try {
                        if (fs.statSync(fullPath).isFile()) {
                            return res.sendFile(path.resolve(fullPath));
                        }
                    } catch (_) {}
                }
            }
        }

        // ── 3. Database Metadata Lookup ─────────────────────────────
        try {
            const [rows] = await db.query(
                `SELECT file_path_or_url, title FROM learning_materials 
                 WHERE file_path_or_url = ? 
                    OR file_path_or_url LIKE ? 
                    OR title = ? 
                 LIMIT 5`,
                [filename, `%${filename}%`, filename]
            );

            for (const row of rows) {
                if (row.file_path_or_url) {
                    const dbBare = row.file_path_or_url.replace(/^(\/?(material_uploads|uploads\/materials|files)\/)+/, '');
                    for (const dir of SEARCH_DIRS) {
                        const fullPath = path.join(dir, dbBare);
                        if (fs.existsSync(fullPath)) {
                            try {
                                if (fs.statSync(fullPath).isFile()) {
                                    return res.sendFile(path.resolve(fullPath));
                                }
                            } catch (_) {}
                        }
                    }
                }
            }
        } catch (dbErr) {
            console.error('[materials.js DB Lookup Error]', dbErr.message);
        }

        // ── 4. Core Name Partial Search ─────────────────────────────
        const ext = path.extname(filename).toLowerCase();
        const coreName = path.basename(filename, ext)
            .replace(/^[0-9]+[-_]/, '')
            .replace(/^mat_[0-9]+_/, '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase();

        if (coreName.length >= 4) {
            for (const dir of SEARCH_DIRS) {
                if (fs.existsSync(dir)) {
                    try {
                        const files = fs.readdirSync(dir);
                        const match = files.find(f => {
                            if (ext && !f.toLowerCase().endsWith(ext)) return false;
                            const normalizedF = f.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                            return normalizedF.includes(coreName);
                        });
                        if (match) {
                            const fullPath = path.join(dir, match);
                            if (fs.statSync(fullPath).isFile()) {
                                return res.sendFile(path.resolve(fullPath));
                            }
                        }
                    } catch (_) {}
                }
            }
        }

        // ── 4.5. Cloud Storage Vault Lookup & Stream Fallback ───────
        if (cloudStorageEngine.isEnabled()) {
            try {
                const cloudRecord = await cloudStorageEngine.findCloudRecord(filename, [
                    'material_uploads',
                    'public/material_uploads',
                    'material_uploads/audio_notes',
                    'files'
                ]);
                if (cloudRecord) {
                    const streamed = await cloudStorageEngine.streamCloudRecordToResponse(cloudRecord, req, res);
                    if (streamed) return;
                }
            } catch (cloudErr) {
                console.warn('[materials.js Cloud Lookup Warning]', cloudErr.message);
            }
        }

        // ── 5. File Not Found Fallback ──────────────────────────────
        if (!req.xhr && (!req.headers.accept || !req.headers.accept.includes('application/json'))) {
            return res.status(404).render('404', {
                title: 'Material Not Found | Elementa LMS',
                user: req.user,
                role: req.user ? req.user.role : 'Guest',
                requestedPath: req.originalUrl,
                customMessage: 'The requested learning material or file attachment could not be located in server storage.'
            });
        }
        return res.status(404).send('Material not found.');
    } catch (err) {
        console.error('[materials.js Error]', err);
        return res.status(500).send('Error retrieving material asset.');
    }
});

module.exports = router;
