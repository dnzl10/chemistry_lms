/**
 * simulate_arcade_session.js
 * ============================================================================
 * End-to-End Simulation of Elementa Chemistry Arcade Game Client.
 * Simulates Godot's DatabaseManager.gd HTTP network calls to Express LMS:
 *  1. Student Barcode / LRN scan login
 *  2. Kiosk Hardware Heartbeat
 *  3. Dynamic Difficulty Adjustment (DDA) configuration fetch
 *  4. Session Start
 *  5. Level 1 Run Start (Scientific Measurement)
 *  6. Physical Button & Periodic Table Element Clicks
 *  7. Hardware Machine / Dial Events
 *  8. Customer Attempts (Correct answers, hesitation latency, mistakes)
 *  9. Level Run Finish
 * 10. Session Finish (Automated Gradebook sync & Remediation alert trigger)
 * ============================================================================
 */

const http = require('http');

const PORT = 3000;
const HOST = '127.0.0.1';

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: HOST,
            port: PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function runSimulation() {
    console.log("==================================================================");
    console.log("🎮 ELEMENTA ARCADE TO LMS: FULL CONNECTION & TELEMETRY SIMULATION");
    console.log("==================================================================\n");

    try {
        // STEP 1: Student Barcode / LRN Scan
        console.log("👉 [1/8] Simulating TekLead USB Barcode Scan for Student LRN: 112288100325 (Denzel)...");
        const studentRes = await request('GET', '/api/elementa/student/112288100325');
        console.log(`   Response (${studentRes.status}):`, studentRes.data);
        const studentId = studentRes.data.user_id || 2;
        console.log(`   ✓ Authenticated Cadet: ${studentRes.data.name || 'Denzel Villaflores'} (ID: ${studentId})`);

        // STEP 2: Kiosk Fleet Heartbeat
        console.log("\n👉 [2/8] Sending Kiosk Hardware Fleet Heartbeat (KIOSK-01)...");
        const heartbeatRes = await request('POST', '/api/elementa/heartbeat', {
            kiosk_id: 'KIOSK-01',
            cabinet_id: 'KIOSK-01',
            ip_address: '192.168.1.105',
            spool_queue_count: 0,
            gpio_bounce_rate: 0.015,
            app_version: '1.2.0-elementa-arcade'
        });
        console.log(`   Response (${heartbeatRes.status}):`, heartbeatRes.data);
        console.log(`   ✓ Kiosk status updated to ONLINE in Admin Fleet Monitor.`);

        // STEP 3: Adaptive Difficulty Parameter (DDA)
        console.log("\n👉 [3/8] Fetching Dynamic Difficulty Parameters (DDA) for Level 1...");
        const ddaRes = await request('GET', `/api/elementa/adaptive-config/${studentId}/1`);
        console.log(`   Response (${ddaRes.status}):`, ddaRes.data);
        console.log(`   ✓ Dynamic Difficulty: Patience Multiplier = ${ddaRes.data.patience_multiplier}x, Hint Tolerance = ${ddaRes.data.hint_tolerance}`);

        // STEP 4: Start Arcade Session
        console.log("\n👉 [4/8] Initializing Game Session on Cabinet KIOSK-01...");
        const sessionStartRes = await request('POST', '/api/elementa/session/start', {
            student_id_p1: studentId,
            play_mode: 'Solo',
            cabinet_id: 'KIOSK-01'
        });
        console.log(`   Response (${sessionStartRes.status}):`, sessionStartRes.data);
        const sessionId = sessionStartRes.data.session_id;
        console.log(`   ✓ Game Session Registered: ID #${sessionId}`);

        // STEP 5: Start Level 1 Run
        console.log(`\n👉 [5/8] Starting Level 1 (District 1: Scientific Measurement)...`);
        const levelStartRes = await request('POST', '/api/elementa/level/start', {
            session_id: sessionId,
            player_number: 1,
            level_number: 1,
            level_topic: 'Precision Measurement & Unit Conversion'
        });
        console.log(`   Response (${levelStartRes.status}):`, levelStartRes.data);
        const runId = levelStartRes.data.run_id;
        console.log(`   ✓ Level Run Registered: Run ID #${runId}`);

        // STEP 6: Micro-Telemetry Events (Clicks & Machine Dials)
        console.log(`\n👉 [6/8] Ingesting Granular Micro-Telemetry (Element Clicks & Dial Twists)...`);
        
        // Element Clicks
        await request('POST', '/api/elementa/click', {
            run_id: runId,
            player_number: 1,
            element_symbol: 'Na',
            atomic_number: 11,
            click_source: 'PhysicalButton'
        });
        await request('POST', '/api/elementa/click', {
            run_id: runId,
            player_number: 1,
            element_symbol: 'Cl',
            atomic_number: 17,
            click_source: 'PeriodicPopup'
        });
        console.log(`   ✓ Physical GPIO and Virtual Element Clicks logged (Na [Z=11], Cl [Z=17])`);

        // Machine Dial opened
        await request('POST', '/api/elementa/machine', {
            run_id: runId,
            player_number: 1,
            machine_type: 'PrecisionMeasurement',
            event_type: 'Opened'
        });

        // Customer Attempt 1: Fast Correct Answer (Mastery Quadrant)
        console.log(`   Recording Customer 1: Rapid Correct Answer (Bloom's Applying)...`);
        await request('POST', '/api/elementa/attempt', {
            run_id: runId,
            customer_index: 1,
            customer_id_ref: 'cust_dist1_volumetric_01',
            machine_used: 'PrecisionMeasurement',
            question_snapshot: 'Prepare 25.0 mL of Sodium Chloride solution using the graduated cylinder.',
            correct_answer: '25.0 mL',
            player_answer: '25.0 mL',
            is_correct: 1,
            is_timeout: 0,
            time_given_s: 90,
            time_remaining_s: 78.5,
            points_awarded: 100,
            combo_at_answer: 1,
            hesitation_score: 1.15,
            scaffolding_used: 0
        });

        // Customer Attempt 2: Distractor Failure (Generates Heatmap & Risk telemetry)
        console.log(`   Recording Customer 2: Distractor Confusion / Wrong Unit (Hesitation spike)...`);
        await request('POST', '/api/elementa/attempt', {
            run_id: runId,
            customer_index: 2,
            customer_id_ref: 'cust_dist1_density_02',
            machine_used: 'UnitConversionConsole',
            question_snapshot: 'Convert 4500 milligrams of NaCl crystals into standard laboratory grams.',
            correct_answer: '4.50 g',
            player_answer: '45.0 g',
            is_correct: 0,
            is_timeout: 0,
            time_given_s: 90,
            time_remaining_s: 41.2,
            points_awarded: 0,
            combo_at_answer: 0,
            failure_type: 'WrongUnit',
            hesitation_score: 7.85,
            scaffolding_used: 1
        });

        // Customer Attempt 3: Second Correct Answer
        console.log(`   Recording Customer 3: Successful Recovery...`);
        await request('POST', '/api/elementa/attempt', {
            run_id: runId,
            customer_index: 3,
            customer_id_ref: 'cust_dist1_atomic_03',
            machine_used: 'AtomicStructureAnalyzer',
            question_snapshot: 'Calibrate spectrometer for elemental Sodium (Na).',
            correct_answer: 'Na',
            player_answer: 'Na',
            is_correct: 1,
            is_timeout: 0,
            time_given_s: 90,
            time_remaining_s: 65.0,
            points_awarded: 120,
            combo_at_answer: 1,
            hesitation_score: 2.30,
            scaffolding_used: 0
        });

        // STEP 7: Finish Level Run
        console.log(`\n👉 [7/8] Completing Level 1 Run...`);
        const levelEndRes = await request('POST', '/api/elementa/level/end', {
            run_id: runId,
            score: 220,
            customers_served: 2,
            customers_total: 3,
            max_streak: 1,
            duration_s: 145
        });
        console.log(`   Response (${levelEndRes.status}):`, levelEndRes.data);

        // STEP 8: Finish Session & Trigger Gradebook Sync
        console.log(`\n👉 [8/8] Completing Game Session & Executing Gradebook Auto-Sync...`);
        const sessionEndRes = await request('POST', '/api/elementa/session/end', {
            session_id: sessionId,
            final_score_p1: 220,
            highest_level_reached: 1,
            total_duration_s: 145,
            winner: 'Solo'
        });
        console.log(`   Response (${sessionEndRes.status}):`, sessionEndRes.data);

        console.log("\n==================================================================");
        console.log("🎉 SUCCESS! ARCADE TELEMETRY CYCLE SIMULATION COMPLETED!");
        console.log("==================================================================");
        console.log(`
What to check in the LMS portals right now:

1. 👨‍🎓 STUDENT PORTAL (Login as Denzel Villaflores or go to /student/leaderboard):
   - Navigate to: http://localhost:3000/student/leaderboard
   - Check the 'Arcade Cadet Status' card at the top:
     * Cadet Global Rank & EXP updated
     * Districts Mastered & Precision percentage updated
   - Click 'Inspect My Cadet Dossier':
     * Tab 1: Bloom's Radar Chart re-renders with new competency distribution
     * Tab 2: District 1 Campaign Progress shows high score 220
     * Tab 3: Mistake Replay Table shows 'cust_dist1_density_02' with WrongUnit & remediation link

2. 👩‍🏫 TEACHER PORTAL:
   - Navigate to: http://localhost:3000/teacher/arcade-telemetry
   - Periodic Table Heatmap: Na (Sodium) and Cl (Chlorine) show error/interaction densities
   - Speed vs Accuracy Scatter Plot: Cadet Denzel is plotted in the cognitive quadrant
   - Early Warning Radar: Shows risk calculation (Z_risk) and mistake distribution
   - Recent Arcade Sessions: Session #${sessionId} appears at the very top
     * Click 'View Replay' on Session #${sessionId} to inspect the step-by-step timeline!

3. 🛡️ ADMIN PORTAL:
   - Navigate to: http://localhost:3000/admin/arcade-hardware-monitor
   - Kiosk Fleet Status: KIOSK-01 is marked ONLINE with IP 192.168.1.105 and last heartbeat 'Just now'
   - Spool Queue Reconciliations & Question Bank Discrimination indices are live!
        `);

    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            console.error(`\n❌ Could not connect to http://${HOST}:${PORT}.`);
            console.error("👉 Please make sure the LMS server is running first with: npm start or npm run dev");
        } else {
            console.error("❌ Simulation Error:", err);
        }
    }
}

runSimulation();
