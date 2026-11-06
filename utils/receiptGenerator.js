const crypto = require('crypto');
const db = require('../db');
const { createTransporter } = require('../services/emailService');

// Use unified email transporter (Resend HTTPS + SMTP fallback)
const transporter = createTransporter();

/**
 * Calculates SHA-256 cryptographic digest for a buffer or string payload.
 * @param {Buffer|string} content 
 * @returns {string} 64-char hex SHA-256 hash
 */
function calculateSHA256(content) {
    const hash = crypto.createHash('sha256');
    if (Buffer.isBuffer(content)) {
        hash.update(content);
    } else {
        hash.update(String(content || ''), 'utf8');
    }
    return hash.digest('hex');
}

/**
 * Generates and stores a digital submission receipt.
 * @param {Object} params
 * @param {number} params.scoreId
 * @param {number} params.studentId
 * @param {number} params.assessmentId
 * @param {Buffer|string} [params.content]
 * @param {string} [params.originalFilename]
 * @param {string} [params.clientIp]
 * @param {string} [params.studentEmail]
 * @param {string} [params.assessmentTitle]
 * @returns {Promise<Object>} Receipt details
 */
async function generateReceipt(params = {}) {
    const scoreId = params.scoreId !== undefined ? params.scoreId : params.score_id;
    const studentId = params.studentId !== undefined ? params.studentId : params.student_id;
    const assessmentId = params.assessmentId !== undefined ? params.assessmentId : params.assessment_id;
    const content = params.content !== undefined ? params.content : (params.file_buffer !== undefined ? params.file_buffer : '');
    const originalFilename = params.originalFilename || params.original_filename || 'submission_payload.json';
    const clientIp = params.clientIp || params.client_ip || null;
    const studentEmail = params.studentEmail || params.student_email || null;
    const assessmentTitle = params.assessmentTitle || params.assessment_title || 'Assessment Submission';

    const sha256Hash = calculateSHA256(content);
    const fileSizeBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ''), 'utf8');

    let receiptId = null;
    let serverTimestamp = new Date();

    try {
        const [result] = await db.query(`
            INSERT INTO submission_receipts 
            (score_id, student_id, assessment_id, sha256_hash, file_size_bytes, original_filename, client_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [scoreId, studentId, assessmentId, sha256Hash, fileSizeBytes, originalFilename, clientIp]);

        receiptId = result.insertId;

        const [[savedRow]] = await db.query(`
            SELECT server_timestamp FROM submission_receipts WHERE receipt_id = ?
        `, [receiptId]);
        if (savedRow && savedRow.server_timestamp) {
            serverTimestamp = savedRow.server_timestamp;
        }
    } catch (err) {
        console.error('[ReceiptGenerator] DB Error saving receipt:', err.message);
    }

    const receiptData = {
        receipt_id: receiptId,
        sha256_hash: sha256Hash,
        file_size_bytes: fileSizeBytes,
        original_filename: originalFilename,
        server_timestamp: serverTimestamp
    };

    // Asynchronously dispatch transactional confirmation email if email available
    if (transporter && studentEmail) {
        const mailOptions = {
            from: `"Chemistry LMS Academic Integrity" <${process.env.EMAIL_USER}>`,
            to: studentEmail,
            subject: `Official Submission Receipt: ${assessmentTitle}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; background-color: #ffffff;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <h2 style="color: #4338ca; margin: 0;">Submission Receipt (Tamper-Proof)</h2>
                        <p style="color: #64748b; font-size: 13px;">Official proof of timely submission</p>
                    </div>
                    <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Assessment:</strong> ${assessmentTitle}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Receipt ID:</strong> #${receiptId || 'PENDING'}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Server Timestamp:</strong> ${new Date(serverTimestamp).toUTCString()}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Payload Size:</strong> ${(fileSizeBytes / 1024).toFixed(2)} KB</p>
                    </div>
                    <div style="background-color: #f1f5f9; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px; word-break: break-all; margin-bottom: 20px;">
                        <span style="font-size: 11px; text-transform: uppercase; color: #475569; font-weight: bold; display: block; margin-bottom: 4px;">SHA-256 Digital Fingerprint:</span>
                        <code style="font-family: monospace; font-size: 13px; color: #0f172a;">${sha256Hash}</code>
                    </div>
                    <p style="font-size: 12px; color: #94a3b8; text-align: center;">Retain this receipt for your records. This hash can be verified in the student dashboard or by academic administrators.</p>
                </div>
            `
        };

        transporter.sendMail(mailOptions).catch(mailErr => {
            console.warn('[ReceiptGenerator] Email dispatch notice:', mailErr.message);
        });
    }

    return receiptData;
}

/**
 * Verifies a SHA-256 hash against stored records.
 * @param {string} hash 
 * @returns {Promise<Object|null>}
 */
async function verifyReceipt(hash) {
    if (!hash || typeof hash !== 'string') return null;
    const cleanHash = hash.trim().toLowerCase();
    try {
        const [rows] = await db.query(`
            SELECT sr.*, u.first_name, u.last_name, u.email, a.assessment_name
            FROM submission_receipts sr
            JOIN users u ON sr.student_id = u.user_id
            JOIN assessments a ON sr.assessment_id = a.assessment_id
            WHERE LOWER(sr.sha256_hash) = ?
            LIMIT 1
        `, [cleanHash]);
        return rows.length ? rows[0] : null;
    } catch (err) {
        console.error('[ReceiptGenerator] Error verifying hash:', err.message);
        return null;
    }
}

module.exports = {
    calculateSHA256,
    generateReceipt,
    verifyReceipt
};
