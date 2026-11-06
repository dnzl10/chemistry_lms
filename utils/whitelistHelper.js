const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { createTransporter } = require('../services/emailService');

// Use unified email transporter (Resend HTTPS + SMTP fallback)
const transporter = createTransporter();

async function processWhitelistEntries(db, classId, entries, expirationDateStr) {
    const expiresAt = new Date(expirationDateStr);
    if (isNaN(expiresAt)) throw new Error("Invalid expiration date provided.");

    // 1. Get Subject info for the email
    const [classRows] = await db.query(
        `SELECT s.subject_name, c.subject_id 
         FROM classes c 
         JOIN subjects s ON c.subject_id = s.subject_id 
         WHERE c.class_id = ?`, 
        [classId]
    );
    const subjectName = classRows.length > 0 ? classRows[0].subject_name : 'the class';
    const subjectId = classRows.length > 0 ? classRows[0].subject_id : '';

    const validEmails = [];
    const invalidEmails = [];
    const registeredUsers = [];

    // Extract emails safely
    const emailsToProcess = entries.filter(e => e.email).map(e => e.email.toLowerCase());
    
    // 2. Query valid users in one go
    if (emailsToProcess.length > 0) {
        const placeholders = emailsToProcess.map(() => '?').join(',');
        const [users] = await db.query(
            `SELECT user_id, email, first_name, last_name FROM users WHERE email IN (${placeholders})`,
            emailsToProcess
        );
        
        const userMap = new Map();
        for (const u of users) {
            userMap.set(u.email.toLowerCase(), u);
        }

        for (const entry of entries) {
            const email = entry.email.toLowerCase();
            if (userMap.has(email)) {
                validEmails.push(entry);
                registeredUsers.push(userMap.get(email));
            } else {
                invalidEmails.push(email);
            }
        }
    }

    let addedCount = 0;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        for (let i = 0; i < validEmails.length; i++) {
            const entry = validEmails[i];
            const user = registeredUsers[i];

            // Insert into whitelist
            const [wlResult] = await conn.execute(
                'INSERT IGNORE INTO class_whitelists (class_id, email, student_name, status) VALUES (?, ?, ?, ?)',
                [classId, entry.email, entry.student_name || user.first_name, 'PENDING']
            );

            // If it wasn't ignored (meaning they weren't already pending/enrolled)
            if (wlResult.affectedRows > 0) {
                // Generate Token
                const rawToken = crypto.randomBytes(32).toString('hex');
                const tokenHash = await bcrypt.hash(rawToken, 12);
                
                await conn.execute(`
                    INSERT INTO enrollment_tokens (class_id, user_id, token_hash, expires_at, is_used) 
                    VALUES (?, ?, ?, ?, 0)
                `, [classId, user.user_id, tokenHash, expiresAt]);

                const [[{id: tokenId}]] = await conn.query("SELECT LAST_INSERT_ID() as id");

                // Send email asynchronously
                const verifyLink = `${process.env.BASE_URL || 'http://localhost:3000'}/enroll/verify?tId=${tokenId}&token=${rawToken}&subjectId=${subjectId}`;
                
                transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: entry.email,
                    subject: `Enrollment Invitation: ${subjectName}`,
                    html: `<h3>You have been invited!</h3>
                           <p>Hello ${user.first_name},</p>
                           <p>You have been invited to enroll in <b>${subjectName}</b>.</p>
                           <p>Click the link below to accept the invitation and finalize your enrollment. This link expires on <b>${expiresAt.toLocaleString()}</b>.</p>
                           <a href="${verifyLink}" style="padding:10px; background:#4f46e5; color:white; border-radius:5px; text-decoration:none; display:inline-block; margin-top:10px;">Accept Invitation</a>`
                }).catch(err => console.error("Email failed to send to", entry.email, err));

                addedCount++;
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }

    return { addedCount, invalidEmails };
}

module.exports = { processWhitelistEntries };
