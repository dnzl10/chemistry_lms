const db = require('../db');

async function checkClasses() {
    try {
        const [rows] = await db.query("SELECT class_id, class_name, teacher_id FROM classes");
        console.log('Classes:', rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

checkClasses();
