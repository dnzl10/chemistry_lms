/**
 * Webhook Dispatcher: Zero-Queue Direct-to-Community Dispatch
 * Sends synchronous, non-blocking formatted announcements to configured Discord/Telegram webhooks.
 */

const db = require('../db');

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function dispatchToDiscord(url, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        return { success: res.ok, status: res.status };
    } finally {
        clearTimeout(timeout);
    }
}

async function dispatchToTelegram(url, text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        // If url is a custom webhook or standard Telegram Bot API sendMessage URL
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                parse_mode: 'HTML'
            }),
            signal: controller.signal
        });
        return { success: res.ok, status: res.status };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Dispatch announcement to relevant Discord and Telegram channels
 * @param {Object} options
 * @param {Object} options.announcement - { title, content, is_critical, due_date, scope }
 * @param {number|null} options.classId - target class ID (optional)
 * @param {string} options.authorName - author's full name
 * @param {string|null} options.className - target class or subject name
 */
async function dispatchAnnouncementWebhook({ announcement, classId = null, authorName = 'Instructor', className = '' }) {
    try {
        // Fetch active webhook configs for this class or global configs
        const [configs] = await db.query(
            `SELECT * FROM webhook_configs 
             WHERE is_active = 1 
               AND (scope = 'global' OR (scope = 'class' AND class_id = ?))`,
            [classId]
        );

        if (!configs || configs.length === 0) {
            return { dispatchedCount: 0, results: [] };
        }

        const isCritical = Boolean(announcement.is_critical);
        const titlePrefix = isCritical ? '🚨 [CRITICAL EMERGENCY] ' : '📢 ';
        const embedColor = isCritical ? 0xe11d48 : 0x06b6d4; // Rose red vs Cyan

        const deadlineField = announcement.due_date ? [{
            name: '⏳ Action Required By',
            value: new Date(announcement.due_date).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short'
            }),
            inline: true
        }] : [];

        const classField = className ? [{
            name: '🏫 Target Class / Subject',
            value: className,
            inline: true
        }] : [];

        const appBaseUrl = process.env.APP_URL || 'http://localhost:3000';
        const attachmentField = announcement.attachment_url ? [{
            name: '📎 Official Attachment',
            value: `[📄 View Document](${appBaseUrl}${announcement.attachment_url})`,
            inline: false
        }] : [];

        const embedObj = {
            title: `${titlePrefix}${announcement.title}`,
            description: announcement.content.length > 2000
                ? announcement.content.substring(0, 1997) + '...'
                : announcement.content,
            color: embedColor,
            fields: [
                { name: '👤 Author', value: authorName, inline: true },
                ...deadlineField,
                ...classField,
                ...attachmentField
            ],
            footer: { text: 'Elementa Learning Management System' },
            timestamp: new Date().toISOString()
        };

        if (announcement.attachment_url && /\.(png|jpe?g|webp|gif)$/i.test(announcement.attachment_url)) {
            embedObj.image = { url: `${appBaseUrl}${announcement.attachment_url}` };
        }

        const discordPayload = {
            username: isCritical ? 'Elementa Emergency Alert' : 'Elementa LMS Broadcast',
            embeds: [embedObj]
        };

        const telegramText = 
            `<b>${isCritical ? '🚨 CRITICAL EMERGENCY BROADCAST' : '📢 LMS ANNOUNCEMENT'}</b>\n\n` +
            `<b>${escapeHtml(announcement.title)}</b>\n` +
            `${escapeHtml(announcement.content)}\n\n` +
            (announcement.due_date ? `⏳ <b>Action Required:</b> ${new Date(announcement.due_date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}\n` : '') +
            (className ? `🏫 <b>Class:</b> ${escapeHtml(className)}\n` : '') +
            (announcement.attachment_url ? `📎 <b>Official Notice:</b> <a href="${appBaseUrl}${announcement.attachment_url}">View Attached File</a>\n` : '') +
            `👤 <i>Posted by ${escapeHtml(authorName)}</i>`;

        const dispatches = configs.map(async (cfg) => {
            try {
                if (cfg.platform === 'discord') {
                    return await dispatchToDiscord(cfg.webhook_url, discordPayload);
                } else if (cfg.platform === 'telegram') {
                    return await dispatchToTelegram(cfg.webhook_url, telegramText);
                }
            } catch (err) {
                console.error(`[Webhook Dispatch Error] Config #${cfg.config_id} (${cfg.platform}):`, err.message);
                return { success: false, error: err.message };
            }
        });

        const results = await Promise.allSettled(dispatches);
        return { dispatchedCount: configs.length, results };
    } catch (outerErr) {
        console.error('[Webhook Dispatcher System Error]:', outerErr);
        return { dispatchedCount: 0, error: outerErr.message };
    }
}

module.exports = {
    dispatchAnnouncementWebhook,
    dispatchToDiscord,
    dispatchToTelegram
};
