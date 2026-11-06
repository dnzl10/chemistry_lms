const db = require('../db');

async function checkAnnouncements() {
    try {
        const [rows] = await db.query("SELECT announcement_id, title, teacher_id, class_id FROM announcements");
        console.log('Announcements in DB:', rows);
        const [users] = await db.query("SELECT user_id, first_name, last_name, role FROM users WHERE role IN ('Teacher', 'Admin')");
        console.log('Teachers/Admins:', users);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

checkAnnouncements();
