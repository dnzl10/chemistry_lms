/**
 * services/emailService.js
 * ============================================================================
 * Production Email Service for Chemistry Arcade LMS.
 * 
 * Supports:
 *   1. Brevo API v3 (REST over HTTPS - Port 443) [RECOMMENDED]
 *      - 300 emails/day 100% FREE.
 *      - NO CUSTOM DOMAIN NEEDED! You can send to ANY recipient (students/teachers)
 *        using your verified personal Gmail.
 *      - Activated when BREVO_API_KEY is present in process.env.
 *   2. Resend (HTTP/HTTPS REST API on port 443)
 *      - Activated when RESEND_API_KEY is present in process.env.
 *   3. Nodemailer (SMTP fallback)
 *      - Used when neither API key is set (e.g., local development).
 * ============================================================================
 */

const nodemailer = require('nodemailer');

function parseSender(fromStr) {
    const defaultEmail = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER || 'vbdenzel@gmail.com';
    const defaultName  = 'Chemistry Arcade LMS';

    if (!fromStr) {
        return { name: defaultName, email: defaultEmail };
    }

    const match = String(fromStr).match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
    if (match && match[2]) {
        return {
            name: (match[1] || '').trim() || defaultName,
            email: match[2].trim()
        };
    }
    return { name: defaultName, email: fromStr.trim() };
}

/**
 * Sends email via Brevo REST API v3 over standard HTTPS (Port 443).
 */
async function sendViaBrevo({ to, subject, html, text, from }) {
    const sender = parseSender(from || process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER);
    
    // Normalize recipients: array of { email, name? }
    const rawTo = Array.isArray(to) ? to : (typeof to === 'string' ? to.split(',').map(s => s.trim()) : []);
    const cleanTo = rawTo.filter(Boolean).map(item => {
        if (typeof item === 'object' && item.email) return item;
        const parsed = parseSender(item);
        return { email: parsed.email, name: parsed.name !== 'Chemistry Arcade LMS' ? parsed.name : undefined };
    });

    const payload = {
        sender: {
            name: sender.name,
            email: sender.email
        },
        to: cleanTo,
        subject: subject || 'Notification from Chemistry Arcade LMS',
        htmlContent: html || text || '<p>No content provided</p>'
    };

    if (text) {
        payload.textContent = text;
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': process.env.BREVO_API_KEY.trim(),
            'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const errorMsg = data.message || `Brevo API HTTP Error ${response.status}: ${response.statusText}`;
        console.error('[emailService:Brevo Error]', errorMsg, data);
        throw new Error(errorMsg);
    }

    return {
        success: true,
        provider: 'brevo',
        id: data.messageId
    };
}

/**
 * Sends email via Resend API over standard HTTPS (Port 443).
 */
let resendClient = null;
function getResendClient() {
    if (!resendClient && process.env.RESEND_API_KEY) {
        try {
            const { Resend } = require('resend');
            resendClient = new Resend(process.env.RESEND_API_KEY);
        } catch (e) {
            console.warn('[emailService] Failed to initialize Resend:', e.message);
        }
    }
    return resendClient;
}

async function sendViaResend({ to, subject, html, text, from }) {
    const resend = getResendClient();
    if (!resend) throw new Error('Resend client is not available');

    const rawTo = Array.isArray(to) ? to : (typeof to === 'string' ? to.split(',').map(s => s.trim()) : []);
    const cleanTo = rawTo.filter(Boolean);

    const sender = from || process.env.RESEND_FROM || process.env.EMAIL_FROM || 'Chemistry Arcade LMS <onboarding@resend.dev>';
    
    const response = await resend.emails.send({
        from: sender,
        to: cleanTo,
        subject: subject || 'Notification from Chemistry Arcade LMS',
        html: html || text || '',
        text: text
    });

    if (response && response.error) {
        console.error('[emailService:Resend API Error]', response.error);
        throw new Error(response.error.message || 'Resend API returned an error.');
    }

    return {
        success: true,
        provider: 'resend',
        id: response?.data?.id
    };
}

/**
 * Sends email via traditional SMTP (Gmail Nodemailer).
 */
function createSmtpTransporter() {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        return nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });
    }
    return null;
}

/**
 * Main sendEmail dispatcher:
 * 1. Brevo (HTTPS 443) -> if BREVO_API_KEY set (No custom domain needed!)
 * 2. Resend (HTTPS 443) -> if RESEND_API_KEY set
 * 3. Nodemailer (SMTP) -> fallback for localhost
 */
async function sendEmail({ to, subject, html, text, from }) {
    // 1. Try Brevo (Recommended for Render)
    if (process.env.BREVO_API_KEY) {
        try {
            return await sendViaBrevo({ to, subject, html, text, from });
        } catch (err) {
            console.error('[emailService] Brevo delivery failed:', err.message);
            // Fall through to other providers if Brevo fails
        }
    }

    // 2. Try Resend
    if (process.env.RESEND_API_KEY) {
        try {
            return await sendViaResend({ to, subject, html, text, from });
        } catch (err) {
            console.error('[emailService] Resend delivery failed:', err.message);
            // Fall through to SMTP if Resend fails
        }
    }

    // 3. Fallback to Nodemailer SMTP
    const smtp = createSmtpTransporter();
    if (smtp) {
        const rawTo = Array.isArray(to) ? to : (typeof to === 'string' ? to.split(',').map(s => s.trim()) : []);
        const sender = from || `"Chemistry Arcade LMS" <${process.env.EMAIL_USER}>`;
        const info = await smtp.sendMail({
            from: sender,
            to: rawTo.join(', '),
            subject,
            html,
            text
        });
        return {
            success: true,
            provider: 'smtp',
            id: info?.messageId
        };
    }

    throw new Error('No working email provider configured. Please set BREVO_API_KEY in your environment.');
}

/**
 * Transporter interface drop-in replacement for Nodemailer.
 * Allows existing `createTransporter().sendMail(options)` calls to work seamlessly.
 */
function createTransporter() {
    return {
        sendMail: async (mailOptions) => {
            return sendEmail({
                to: mailOptions.to,
                subject: mailOptions.subject,
                html: mailOptions.html,
                text: mailOptions.text,
                from: mailOptions.from
            });
        }
    };
}

module.exports = {
    sendEmail,
    createTransporter
};
