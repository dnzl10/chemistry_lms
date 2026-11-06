/**
 * arcadeAnalyticsService.js
 * ============================================================================
 * Enterprise pedagogical analytics engine for Elementa Chemistry Arcade.
 * Translates granular game micro-telemetry (reaction latency, hesitation curves,
 * element clicks, dial hunting, failure types) into actionable learning metrics
 * across Bloom's Taxonomy, predictive academic risk models, and heatmaps.
 * ============================================================================
 */

const pool = require('../db');

/**
 * 1. Calculate Bloom's Taxonomy Mastery Radar for an individual student.
 * Aggregates all completed attempts into 5 standardized competency axes (0 - 100%):
 * - Remembering (Symbols, Units, Atomic Numbers)
 * - Understanding (Quantum numbers, Periodic trends, Isotopes)
 * - Applying (Solutions, Percentage composition, Mole concept)
 * - Analyzing (Bond types, Reactions, Nomenclature, Stoichiometry)
 * - Laboratory Precision (Motor dial accuracy within machine tolerances)
 */
async function getStudentRadar(userId) {
    try {
        // Strictly fetch Elementa Arcade Game micro-telemetry attempts (from elementa_questions via elementa_customer_attempts)
        // Web LMS student_responses & question_bank are strictly excluded.
        const [rows] = await pool.query(
            `SELECT 
                COALESCE(ca.level_number, r.level_number) AS level_number,
                ca.attempt_id,
                s.session_id,
                ca.question_id,
                ca.customer_id_ref,
                ca.question_snapshot,
                ca.is_correct,
                ca.is_timeout,
                ca.response_time_s,
                ca.time_given_s,
                ca.failure_type,
                ca.machine_used,
                ca.attempted_at
             FROM elementa_customer_attempts ca
             JOIN elementa_level_runs r ON r.run_id = ca.run_id
             JOIN elementa_game_sessions s ON s.session_id = r.session_id
             WHERE (s.student_id_p1 = ? OR s.student_id_p2 = ?)
             ORDER BY ca.attempted_at ASC, ca.attempt_id ASC`,
            [userId, userId]
        );

        const getItemKey = (row) => {
            if (row.question_id) return `q_${row.question_id}`;
            if (row.customer_id_ref) return `lvl_${row.level_number}_cust_${row.customer_id_ref}`;
            return `prompt_${(row.question_snapshot || '').trim().toLowerCase()}`;
        };

        const attemptsByLevel = {
            remembering: [],
            understanding: [],
            applying: [],
            analyzing: []
        };

        let totalPrecisionAttempts = 0;
        let correctPrecisionAttempts = 0;

        for (const r of rows) {
            const lvl = Number(r.level_number);
            const isCorr = Boolean(r.is_correct);
            const isTimeout = Boolean(r.is_timeout);

            totalPrecisionAttempts++;
            if (isCorr && !isTimeout) correctPrecisionAttempts++;

            // Intelligent cognitive taxonomy mapping:
            // Combines kiosk workstation machine type and stage level
            const m = (r.machine_used || '').toLowerCase();
            if (m.includes('atom') || m.includes('precision') || (!m && [1, 4].includes(lvl))) {
                attemptsByLevel.remembering.push(r);
            } else if (m.includes('isotope') || (!m && [2, 3, 8].includes(lvl))) {
                attemptsByLevel.understanding.push(r);
            } else if (m.includes('mix') || m.includes('mixing') || m.includes('compound') || (!m && [5, 6, 11].includes(lvl))) {
                attemptsByLevel.applying.push(r);
            } else if (m.includes('balanc') || m.includes('chamber') || (!m && [7, 9, 10, 12].includes(lvl))) {
                attemptsByLevel.analyzing.push(r);
            } else {
                attemptsByLevel.remembering.push(r);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // PILLAR A: Remembering (Recall Fluency & Temporal Stability)
        // Formula: ItemScore_q = LatestAccuracy * SpeedMultiplier * StabilityBonus
        // Aggregate: (sum(ItemScore_q) / U_Rem) * 100
        // ─────────────────────────────────────────────────────────────
        let rememberingScore = 0;
        const remItemsMap = new Map();
        for (const r of attemptsByLevel.remembering) {
            const key = getItemKey(r);
            if (!remItemsMap.has(key)) remItemsMap.set(key, []);
            remItemsMap.get(key).push(r);
        }

        const uRem = remItemsMap.size;
        let remCorrectCount = 0;
        let remTotalScoreSum = 0;

        for (const [key, encounters] of remItemsMap.entries()) {
            const latest = encounters[encounters.length - 1];
            const isLatestCorrect = Boolean(latest.is_correct);
            if (isLatestCorrect) remCorrectCount++;

            const latestAccuracy = isLatestCorrect ? 1.0 : 0.0;
            if (latestAccuracy === 0.0) {
                continue; // ItemScore = 0 if latest attempt failed
            }

            // Speed Multiplier (Mt)
            const t = Number(latest.response_time_s) || 20;
            let speedMultiplier = 0.70;
            if (t <= 8.0) speedMultiplier = 1.00;
            else if (t <= 15.0) speedMultiplier = 0.85;

            // Stability Bonus
            // Consecutive Success: correct across last 2 consecutive encounters -> 1.00
            // First-Time Recovery: incorrect in previous encounter, correct in current -> 0.80
            // Single fresh encounter: 1.00
            let stabilityBonus = 1.00;
            if (encounters.length >= 2) {
                const prev = encounters[encounters.length - 2];
                stabilityBonus = Boolean(prev.is_correct) ? 1.00 : 0.80;
            }

            const itemScore = latestAccuracy * speedMultiplier * stabilityBonus;
            remTotalScoreSum += itemScore;
        }

        if (uRem > 0) {
            rememberingScore = Math.min(100, Math.max(0, Math.round((remTotalScoreSum / uRem) * 100)));
        }

        // ─────────────────────────────────────────────────────────────
        // PILLAR B: Understanding (Conceptual Stability & Regression Dampening)
        // Formula: S_session,t = (correct / total) * 100
        // M_Und,t = (0.65 * S_session,t) + (0.35 * M_Und,t-1)
        // If S_session,t < M_Und,t-1 - 25 => M_Und,t -= 5
        // ─────────────────────────────────────────────────────────────
        let understandingScore = 0;
        const undSessionsMap = new Map();
        for (const r of attemptsByLevel.understanding) {
            const sid = r.session_id;
            if (!undSessionsMap.has(sid)) undSessionsMap.set(sid, []);
            undSessionsMap.get(sid).push(r);
        }

        let undTotalCorrect = 0;
        let undTotalAttempts = attemptsByLevel.understanding.length;
        let mUnd = null;

        for (const [sid, sessAttempts] of undSessionsMap.entries()) {
            const corr = sessAttempts.filter(a => a.is_correct).length;
            undTotalCorrect += corr;
            const total = sessAttempts.length;
            const sSession = (corr / total) * 100;

            if (mUnd === null) {
                mUnd = sSession;
            } else {
                const isRegressed = sSession < (mUnd - 25);
                mUnd = (0.65 * sSession) + (0.35 * mUnd);
                if (isRegressed) {
                    mUnd = Math.max(0, mUnd - 5);
                }
            }
        }
        if (mUnd !== null) {
            understandingScore = Math.min(100, Math.max(0, Math.round(mUnd)));
        }

        // ─────────────────────────────────────────────────────────────
        // PILLAR C: Applying (Procedural Longitudinal Memory & Execution Reliability)
        // Formula: ItemScore_q = (0.70 * Result_recent) + (0.30 * HistoricalAccuracy_q)
        // Aggregate: (sum(ItemScore_q) / U_App) * 100
        // ─────────────────────────────────────────────────────────────
        let applyingScore = 0;
        const appItemsMap = new Map();
        for (const r of attemptsByLevel.applying) {
            const key = getItemKey(r);
            if (!appItemsMap.has(key)) appItemsMap.set(key, []);
            appItemsMap.get(key).push(r);
        }

        const uApp = appItemsMap.size;
        let appCorrectCount = 0;
        let appTotalScoreSum = 0;

        for (const [key, encounters] of appItemsMap.entries()) {
            const latest = encounters[encounters.length - 1];
            const isLatestCorrect = Boolean(latest.is_correct);
            if (isLatestCorrect) appCorrectCount++;

            const resultRecent = isLatestCorrect ? 1.0 : 0.0;
            const priorEncounters = encounters.slice(0, -1);

            let historicalAccuracy = resultRecent;
            if (priorEncounters.length > 0) {
                const priorCorrect = priorEncounters.filter(e => e.is_correct).length;
                historicalAccuracy = priorCorrect / priorEncounters.length;
            }

            const itemScore = (0.70 * resultRecent) + (0.30 * historicalAccuracy);
            appTotalScoreSum += itemScore;
        }

        if (uApp > 0) {
            applyingScore = Math.min(100, Math.max(0, Math.round((appTotalScoreSum / uApp) * 100)));
        }

        // ─────────────────────────────────────────────────────────────
        // PILLAR D: Analyzing (Diagnostic Resilience & Error-Correction Progression)
        // Formula: S_raw,t = (correct / total) * 100
        // Adjusted S_session,t = min(100, S_raw,t + (5 * N_recovered))
        // M_Ana,t = (0.60 * S_session,t) + (0.40 * M_Ana,t-1)
        // ─────────────────────────────────────────────────────────────
        let analyzingScore = 0;
        const anaSessionsMap = new Map();
        for (const r of attemptsByLevel.analyzing) {
            const sid = r.session_id;
            if (!anaSessionsMap.has(sid)) anaSessionsMap.set(sid, []);
            anaSessionsMap.get(sid).push(r);
        }

        let anaTotalCorrect = 0;
        let anaTotalAttempts = attemptsByLevel.analyzing.length;
        let mAna = null;

        // Track failed items across history to detect recovery
        const previouslyFailedItems = new Set();

        for (const [sid, sessAttempts] of anaSessionsMap.entries()) {
            const corr = sessAttempts.filter(a => a.is_correct).length;
            anaTotalCorrect += corr;
            const total = sessAttempts.length;
            const sRaw = (corr / total) * 100;

            // Count recovered items in this session
            let nRecovered = 0;
            for (const a of sessAttempts) {
                const itemKey = getItemKey(a);
                if (a.is_correct && previouslyFailedItems.has(itemKey)) {
                    nRecovered++;
                    previouslyFailedItems.delete(itemKey);
                }
            }

            const sSession = Math.min(100, sRaw + (5 * nRecovered));

            if (mAna === null) {
                mAna = sSession;
            } else {
                mAna = (0.60 * sSession) + (0.40 * mAna);
            }

            // Record failed items in this session
            for (const a of sessAttempts) {
                if (!a.is_correct) {
                    previouslyFailedItems.add(getItemKey(a));
                }
            }
        }

        if (mAna !== null) {
            analyzingScore = Math.min(100, Math.max(0, Math.round(mAna)));
        }

        // ─────────────────────────────────────────────────────────────
        // PILLAR E: Lab Precision (Composite Laboratory Mastery Index)
        // Implements LogicMasteryPlan.md 3-Phase Precision Architecture:
        // 1. Weighted Cognitive Base Index (Blab):
        //    Blab = (0.15 * M_Rem) + (0.20 * M_Und) + (0.35 * M_App) + (0.30 * M_Ana)
        // 2. Longitudinal Consistency Factor (Variance Penalty):
        //    mean = (M_Rem + M_Und + M_App + M_Ana) / 4
        //    sigma = sqrt( sum( (M_i - mean)^2 ) / 4 )
        //    C = 1 - ( (sigma / 100) * 0.15 )
        //    Adjusted Precision = Blab * C
        // 3. Safety Gatekeeper Protocol (Operator Lockout):
        //    If M_Rem < 60 OR M_Und < 60 => min(59, Adjusted Precision)
        //    Else => Adjusted Precision
        // 4. Proficiency Tier:
        //    90-100%: Lead Analyst (Autonomous)
        //    75-89%:  Proficient Operator
        //    60-74%:  Supervised Trainee
        //    <60%:    Restricted / Lab Prep Needed
        // ─────────────────────────────────────────────────────────────
        const finalMRem = rememberingScore;
        const finalMUnd = understandingScore;
        const finalMApp = applyingScore;
        const finalMAna = analyzingScore;

        let precisionScore = 0;
        let baseIndex = 0;
        let consistencyMultiplier = 1.0;
        let stdDev = 0;
        let safetyLockoutTriggered = false;
        let statusTier = 'Restricted / Lab Prep Needed';
        let operationalStatus = 'Foundational concepts and safety protocols require remedial training.';

        const hasAnyAttempts = rows.length > 0;

        if (hasAnyAttempts) {
            // Step 1: Weighted Base Index
            baseIndex = (0.15 * finalMRem) + (0.20 * finalMUnd) + (0.35 * finalMApp) + (0.30 * finalMAna);

            // Step 2: Consistency Factor (Variance Penalty)
            const meanPillars = (finalMRem + finalMUnd + finalMApp + finalMAna) / 4;
            const variance = ((Math.pow(finalMRem - meanPillars, 2) + 
                               Math.pow(finalMUnd - meanPillars, 2) + 
                               Math.pow(finalMApp - meanPillars, 2) + 
                               Math.pow(finalMAna - meanPillars, 2)) / 4);
            stdDev = Math.sqrt(variance);
            consistencyMultiplier = Math.max(0.85, 1 - ((stdDev / 100) * 0.15));
            const adjustedPrecision = baseIndex * consistencyMultiplier;

            // Step 3: Safety Gatekeeper Protocol (Operator Lockout)
            if (finalMRem < 60 || finalMUnd < 60) {
                safetyLockoutTriggered = true;
                precisionScore = Math.min(59, Math.round(adjustedPrecision));
            } else {
                safetyLockoutTriggered = false;
                precisionScore = Math.min(100, Math.max(0, Math.round(adjustedPrecision)));
            }

            // Step 4: Proficiency Tier Classification
            if (precisionScore >= 90) {
                statusTier = 'Lead Analyst (Autonomous)';
                operationalStatus = 'Capable of independent experimentation; diagnoses anomalies with high fidelity.';
            } else if (precisionScore >= 75) {
                statusTier = 'Proficient Operator';
                operationalStatus = 'Dependable execution and routine analysis; requires minimal oversight.';
            } else if (precisionScore >= 60) {
                statusTier = 'Supervised Trainee';
                operationalStatus = 'Able to follow standard operating procedures; prone to errors on edge cases.';
            } else {
                statusTier = 'Restricted / Lab Prep Needed';
                operationalStatus = safetyLockoutTriggered 
                    ? 'Operator lockout active: Safety recall (M_Rem) or concept comprehension (M_Und) below 60% threshold.' 
                    : 'Foundational concepts and safety protocols require remedial training.';
            }
        }

        const rawPrecision = totalPrecisionAttempts > 0 
            ? Math.round((correctPrecisionAttempts / totalPrecisionAttempts) * 100) 
            : 0;

        return {
            remembering: rememberingScore,
            understanding: understandingScore,
            applying: applyingScore,
            analyzing: analyzingScore,
            precision: rawPrecision,
            compositePrecision: precisionScore,
            rawPrecision: rawPrecision,
            rememberingDetails: {
                correct: remCorrectCount,
                total: uRem,
                uniqueQuestions: uRem,
                attempted: uRem > 0,
                model: "SpeedMultiplier (Mt) x StabilityBonus"
            },
            understandingDetails: {
                correct: undTotalCorrect,
                total: undTotalAttempts,
                sessionsCount: undSessionsMap.size,
                attempted: undTotalAttempts > 0,
                model: "EMA (0.65/0.35) + Regression Penalty"
            },
            applyingDetails: {
                correct: appCorrectCount,
                total: uApp,
                uniqueQuestions: uApp,
                attempted: uApp > 0,
                model: "70/30 Recent-Historical Split"
            },
            analyzingDetails: {
                correct: anaTotalCorrect,
                total: anaTotalAttempts,
                sessionsCount: anaSessionsMap.size,
                attempted: anaTotalAttempts > 0,
                model: "EMA (0.60/0.40) + Recovery Bonus"
            },
            precisionDetails: {
                correct: correctPrecisionAttempts,
                total: totalPrecisionAttempts,
                rawPrecision: rawPrecision,
                baseIndex: Math.round(baseIndex),
                compositePrecision: precisionScore,
                stdDev: Number(stdDev.toFixed(2)),
                consistencyMultiplier: Number(consistencyMultiplier.toFixed(3)),
                safetyLockoutTriggered,
                statusTier,
                operationalStatus,
                attempted: totalPrecisionAttempts > 0,
                model: "Weighted Base Index x Consistency Factor (Safety Gatekeeper Locked)"
            },
            totalAttemptsAnalyzed: rows.length,
            isBaseline: rows.length === 0
        };
    } catch (err) {
        console.error('[arcadeAnalyticsService.getStudentRadar]', err);
        return {
            remembering: 0,
            understanding: 0,
            applying: 0,
            analyzing: 0,
            precision: 0,
            rememberingDetails: { correct: 0, total: 0, uniqueQuestions: 0 },
            understandingDetails: { correct: 0, total: 0, sessionsCount: 0 },
            applyingDetails: { correct: 0, total: 0, uniqueQuestions: 0 },
            analyzingDetails: { correct: 0, total: 0, sessionsCount: 0 },
            precisionDetails: { correct: 0, total: 0 },
            totalAttemptsAnalyzed: 0,
            isBaseline: true
        };
    }
}

/**
 * 2. Get Student's 12-District / Topic Mastery Progression with Computed Stars (Arcade Game Only)
 */
async function getStudentDistrictProgress(userId) {
    try {
        const levelTopicMap = [
            { levelNumber: 1, topicId: 3, name: 'Scientific Measurement' },
            { levelNumber: 2, topicId: 4, name: 'Quantum Theory' },
            { levelNumber: 3, topicId: 5, name: 'Isotopes' },
            { levelNumber: 4, topicId: 11, name: 'Atomic Mass' },
            { levelNumber: 5, topicId: 12, name: 'Percentage Composition' },
            { levelNumber: 6, topicId: 13, name: 'Chemical Nomenclature' },
            { levelNumber: 7, topicId: 14, name: 'Chemical Bonds & Properties' },
            { levelNumber: 8, topicId: 1, name: 'Intermolecular Forces' },
            { levelNumber: 9, topicId: 2, name: 'Organic Compounds' },
            { levelNumber: 10, topicId: 8, name: 'Types of Chemical Reactions' },
            { levelNumber: 11, topicId: 9, name: 'Mole Concept' },
            { levelNumber: 12, topicId: 10, name: 'Conservation of Mass & Stoichiometry' }
        ];

        // 1. Fetch arcade game sessions linked to assessments (strictly excluding Assignment)
        // Score is in final_score_p1 for Solo / Versus P1, and final_score_p2 for Versus P2
        const [sessAsmts] = await pool.query(
            `SELECT 
                a.topic_id,
                a.assessment_id,
                a.assessment_name,
                a.total_items AS asmt_items,
                MAX(CASE WHEN gs.student_id_p1 = ? THEN gs.final_score_p1 ELSE gs.final_score_p2 END) AS arcade_score
             FROM elementa_game_sessions gs
             JOIN assessments a ON a.assessment_id = gs.assessment_id
             WHERE (gs.student_id_p1 = ? OR gs.student_id_p2 = ?)
               AND gs.session_status = 'Completed'
               AND a.assessment_type IN ('Pre-Test', 'Post-Test', 'Quiz', 'Competitive')
             GROUP BY a.topic_id, a.assessment_id, a.assessment_name, a.total_items`,
            [userId, userId, userId]
        );

        const asmtByTopic = {};
        for (const row of sessAsmts) {
            if (!asmtByTopic[row.topic_id]) asmtByTopic[row.topic_id] = [];
            asmtByTopic[row.topic_id].push(row);
        }

        // 2. Fetch arcade level runs for this student
        const [runs] = await pool.query(
            `SELECT 
                r.level_number,
                r.level_topic,
                MAX(r.score) AS best_score,
                MAX(r.customers_served) AS best_served,
                MAX(r.customers_total) AS total_customers,
                MIN(r.duration_s) AS fastest_duration_s,
                COUNT(r.run_id) AS total_runs_played
             FROM elementa_level_runs r
             JOIN elementa_game_sessions s ON s.session_id = r.session_id
             WHERE (s.student_id_p1 = ? OR s.student_id_p2 = ?)
               AND r.run_status = 'Completed'
             GROUP BY r.level_number, r.level_topic
             ORDER BY r.level_number ASC`,
            [userId, userId]
        );

        const runByLevel = {};
        for (const r of runs) {
            runByLevel[r.level_number] = r;
        }

        const progress = [];

        for (const item of levelTopicMap) {
            const topicAsmts = asmtByTopic[item.topicId] || [];
            const runData = runByLevel[item.levelNumber];

            let totalGainedScore = 0;
            let totalItems = 0;
            let played = false;
            let fastestDuration = '--';

            // Check if arcade assessments were completed for this topic
            if (topicAsmts.length > 0) {
                played = true;
                for (const asmt of topicAsmts) {
                    const items = asmt.asmt_items || 10;
                    let sc = Number(asmt.arcade_score) || 0;
                    if (sc > items && items > 0) {
                        sc = Math.min(items, Math.round(sc / 100));
                    }
                    totalGainedScore += Math.min(items, Math.max(0, sc));
                    totalItems += items;
                }
            }

            // Check Arcade level runs
            if (runData && runData.total_runs_played > 0) {
                played = true;
                if (runData.fastest_duration_s) {
                    const mins = Math.floor(runData.fastest_duration_s / 60);
                    const secs = runData.fastest_duration_s % 60;
                    fastestDuration = `${mins}m ${secs}s`;
                }

                // If no arcade assessments linked, use the level run score and customer items
                if (topicAsmts.length === 0) {
                    const arcItems = Number(runData.total_customers) || 10;
                    let arcScore = Number(runData.best_score || 0);
                    if (arcScore > arcItems && arcItems > 0) {
                        arcScore = Math.min(arcItems, Math.round(arcScore / 100));
                    }
                    totalGainedScore = Math.min(arcItems, Math.max(0, arcScore));
                    totalItems = arcItems;
                }
            }

            const scorePct = totalItems > 0 ? Math.round((totalGainedScore / totalItems) * 100) : 0;

            // Star calculation based on arcade gained score and total items:
            // 3 Stars: >= 85% (Mastery)
            // 2 Stars: >= 60% (Proficient)
            // 1 Star:  > 0%   (Developing / Attempted)
            // 0 Stars: 0% or Not Attempted
            let stars = 0;
            if (played && scorePct >= 85) stars = 3;
            else if (played && scorePct >= 60) stars = 2;
            else if (played && scorePct > 0) stars = 1;

            let statusText = 'Not Attempted';
            if (played) {
                if (scorePct >= 85) statusText = 'Mastered';
                else if (scorePct >= 60) statusText = 'Proficient';
                else statusText = 'Needs Practice';
            }

            progress.push({
                levelNumber: item.levelNumber,
                topicId: item.topicId,
                topicName: item.name,
                played,
                stars,
                scorePct,
                totalGainedScore,
                totalItems,
                bestScore: totalGainedScore,
                totalRuns: runData ? Number(runData.total_runs_played) : topicAsmts.length,
                fastestDuration,
                statusText
            });
        }

        return progress;
    } catch (err) {
        console.error('[arcadeAnalyticsService.getStudentDistrictProgress]', err);
        return [];
    }
}

/**
 * 3. Get Student Mistake Replay Log with Direct Learning Remediation Mapping
 */
async function getStudentMistakes(userId, limit = 15) {
    try {
        const [rows] = await pool.query(
            `SELECT 
                ca.attempt_id,
                ca.run_id,
                r.level_number,
                r.level_topic,
                ca.customer_index,
                ca.customer_id_ref,
                ca.machine_used,
                ca.question_snapshot,
                ca.correct_answer,
                ca.player_answer,
                ca.failure_type,
                ca.is_timeout,
                ca.response_time_s,
                ca.attempted_at,
                -- Map level number to specific LMS topic_id and subject_id
                CASE r.level_number
                    WHEN 1 THEN 3 WHEN 2 THEN 4 WHEN 3 THEN 5 WHEN 4 THEN 11
                    WHEN 5 THEN 12 WHEN 6 THEN 13 WHEN 7 THEN 14 WHEN 8 THEN 1
                    WHEN 9 THEN 2 WHEN 10 THEN 8 WHEN 11 THEN 9 WHEN 12 THEN 10
                    ELSE 3
                END AS matched_topic_id,
                CASE WHEN r.level_number >= 8 THEN 3 ELSE 1 END AS matched_subject_id,
                -- Match learning material if available
                (SELECT lm.material_id 
                 FROM learning_materials lm 
                 WHERE lm.topic_id = CASE r.level_number
                    WHEN 1 THEN 3 WHEN 2 THEN 4 WHEN 3 THEN 5 WHEN 4 THEN 11
                    WHEN 5 THEN 12 WHEN 6 THEN 13 WHEN 7 THEN 14 WHEN 8 THEN 1
                    WHEN 9 THEN 2 WHEN 10 THEN 8 WHEN 11 THEN 9 WHEN 12 THEN 10
                    ELSE 3
                 END
                 LIMIT 1) AS matched_material_id,
                (SELECT lm.title 
                 FROM learning_materials lm 
                 WHERE lm.topic_id = CASE r.level_number
                    WHEN 1 THEN 3 WHEN 2 THEN 4 WHEN 3 THEN 5 WHEN 4 THEN 11
                    WHEN 5 THEN 12 WHEN 6 THEN 13 WHEN 7 THEN 14 WHEN 8 THEN 1
                    WHEN 9 THEN 2 WHEN 10 THEN 8 WHEN 11 THEN 9 WHEN 12 THEN 10
                    ELSE 3
                 END
                 LIMIT 1) AS matched_material_title
             FROM elementa_customer_attempts ca
             JOIN elementa_level_runs r ON r.run_id = ca.run_id
             JOIN elementa_game_sessions s ON s.session_id = r.session_id
             WHERE (s.student_id_p1 = ? OR s.student_id_p2 = ?)
               AND ca.is_correct = 0
             ORDER BY ca.attempted_at DESC
             LIMIT ?`,
            [userId, userId, limit]
        );
        return rows;
    } catch (err) {
        console.error('[arcadeAnalyticsService.getStudentMistakes]', err);
        return [];
    }
}

/**
 * 4. Periodic Table Distractor Heatmap Matrix (118 Elements)
 * Returns click frequency, error rates, and confusion intensity per element for a class/topic.
 */
async function getPeriodicTableHeatmap(classId = null, levelNumber = null) {
    try {
        let sql = `
            SELECT 
                ec.element_symbol,
                ptb.element_name,
                ptb.atomic_number,
                ptb.group_col,
                ptb.period_row,
                ptb.category,
                COUNT(ec.click_id) AS total_clicks,
                SUM(CASE WHEN ca.is_correct = 0 THEN 1 ELSE 0 END) AS error_clicks
            FROM elementa_element_clicks ec
            LEFT JOIN elementa_periodic_table_buttons ptb ON ptb.element_symbol = ec.element_symbol
            LEFT JOIN elementa_customer_attempts ca ON ca.attempt_id = ec.attempt_id
            LEFT JOIN elementa_level_runs lr ON lr.run_id = ec.run_id
            LEFT JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
            WHERE 1=1
        `;
        const params = [];
        if (classId) {
            sql += ` AND gs.class_id = ?`;
            params.push(classId);
        }
        if (levelNumber) {
            sql += ` AND lr.level_number = ?`;
            params.push(levelNumber);
        }
        sql += ` GROUP BY ec.element_symbol, ptb.element_name, ptb.atomic_number, ptb.group_col, ptb.period_row, ptb.category`;

        const [rows] = await pool.query(sql, params);

        // Compute relative heat intensity (0.0 to 1.0)
        const maxClicks = Math.max(1, ...rows.map(r => Number(r.total_clicks) || 0));
        const heatmap = rows.map(r => ({
            symbol: r.element_symbol,
            name: r.element_name || r.element_symbol,
            atomicNumber: r.atomic_number,
            group: r.group_col,
            period: r.period_row,
            category: r.category || 'Unknown',
            clicks: Number(r.total_clicks),
            errors: Number(r.error_clicks),
            errorRatio: Number(r.total_clicks) > 0 ? (Number(r.error_clicks) / Number(r.total_clicks)).toFixed(2) : 0,
            heatIntensity: (Number(r.total_clicks) / maxClicks).toFixed(2)
        }));

        return heatmap;
    } catch (err) {
        console.error('[arcadeAnalyticsService.getPeriodicTableHeatmap]', err);
        return [];
    }
}

/**
 * 5. Speed-Accuracy & Cognitive Hesitation Distribution (Scatter Data)
 * Segregates students into 4 quadrants: Mastery, Deliberation, Hesitation, Rapid Guessing.
 */
async function getSpeedAccuracyDistribution(classId = null, levelNumber = null) {
    try {
        let sql = `
            SELECT 
                u.user_id,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                u.profile_pic,
                ROUND(AVG(ca.response_time_s), 1) AS avg_response_time,
                ROUND(SUM(ca.is_correct) / COUNT(ca.attempt_id) * 100, 1) AS accuracy_pct,
                COUNT(ca.attempt_id) AS total_attempts,
                SUM(ca.is_timeout) AS total_timeouts
            FROM elementa_customer_attempts ca
            JOIN elementa_level_runs lr ON lr.run_id = ca.run_id
            JOIN elementa_game_sessions gs ON gs.session_id = lr.session_id
            JOIN users u ON u.user_id = (CASE lr.player_number WHEN 1 THEN gs.student_id_p1 ELSE gs.student_id_p2 END)
            WHERE u.user_id IS NOT NULL
        `;
        const params = [];
        if (classId) {
            sql += ` AND gs.class_id = ?`;
            params.push(classId);
        }
        if (levelNumber) {
            sql += ` AND lr.level_number = ?`;
            params.push(levelNumber);
        }
        sql += ` GROUP BY u.user_id, student_name, u.profile_pic HAVING total_attempts >= 3`;

        const [rows] = await pool.query(sql, params);

        return rows.map(r => {
            const acc = Number(r.accuracy_pct);
            const rt = Number(r.avg_response_time);
            let quadrant = 'Mastery';
            if (acc >= 75 && rt >= 45) quadrant = 'Deep Deliberation';
            else if (acc < 75 && rt >= 45) quadrant = 'Cognitive Hesitation';
            else if (acc < 60 && rt < 25) quadrant = 'Rapid Guessing';

            return {
                userId: r.user_id,
                name: r.student_name,
                profilePic: r.profile_pic,
                x: rt, // response time (seconds)
                y: acc, // accuracy (%)
                quadrant: quadrant,
                timeouts: Number(r.total_timeouts)
            };
        });
    } catch (err) {
        console.error('[arcadeAnalyticsService.getSpeedAccuracyDistribution]', err);
        return [];
    }
}

/**
 * 6. Early Warning Academic Risk Engine
 * Computes failure probability score (0 to 100%) and vulnerable machines.
 */
async function getEarlyWarningRiskList(classId = null) {
    try {
        let sql = `
            SELECT 
                u.user_id,
                CONCAT(u.first_name, ' ', u.last_name) AS student_name,
                u.section,
                u.profile_pic,
                COUNT(ca.attempt_id) AS total_attempts,
                SUM(ca.is_correct) AS total_correct,
                SUM(ca.is_timeout) AS total_timeouts,
                AVG(ca.response_time_s) AS avg_rt,
                (SELECT machine_used 
                 FROM elementa_customer_attempts mca 
                 JOIN elementa_level_runs mlr ON mlr.run_id = mca.run_id
                 JOIN elementa_game_sessions mgs ON mgs.session_id = mlr.session_id
                 WHERE (mgs.student_id_p1 = u.user_id OR mgs.student_id_p2 = u.user_id) AND mca.is_correct = 0
                 GROUP BY machine_used 
                 ORDER BY COUNT(*) DESC LIMIT 1) AS top_vulnerable_machine
            FROM users u
            JOIN class_students cs ON cs.student_id = u.user_id
            LEFT JOIN elementa_game_sessions gs ON (gs.student_id_p1 = u.user_id OR gs.student_id_p2 = u.user_id)
            LEFT JOIN elementa_level_runs lr ON lr.session_id = gs.session_id
            LEFT JOIN elementa_customer_attempts ca ON ca.run_id = lr.run_id
            WHERE u.role = 'Student'
        `;
        const params = [];
        if (classId) {
            sql += ` AND cs.class_id = ?`;
            params.push(classId);
        }
        sql += ` GROUP BY u.user_id, student_name, u.section, u.profile_pic HAVING total_attempts >= 5`;

        const [rows] = await pool.query(sql, params);

        return rows.map(r => {
            const total = Number(r.total_attempts) || 1;
            const correct = Number(r.total_correct) || 0;
            const timeouts = Number(r.total_timeouts) || 0;
            const avgRt = Number(r.avg_rt) || 45;
            const accuracy = (correct / total);

            // Risk Model: High timeout ratio, low accuracy, and prolonged hesitation
            const timeoutPenalty = (timeouts / total) * 0.40;
            const accuracyPenalty = (1 - accuracy) * 0.45;
            const latencyPenalty = Math.min(0.15, (avgRt / 90) * 0.15);

            const riskScore = Math.min(99, Math.round((timeoutPenalty + accuracyPenalty + latencyPenalty) * 100));
            const predictedExam = Math.max(40, Math.round(100 - (riskScore * 0.6)));

            let riskTier = 'Low';
            if (riskScore >= 70) riskTier = 'Critical';
            else if (riskScore >= 50) riskTier = 'Moderate';

            return {
                userId: r.user_id,
                name: r.student_name,
                section: r.section,
                profilePic: r.profile_pic,
                riskScore: riskScore,
                riskTier: riskTier,
                predictedScore: predictedExam,
                vulnerableMachine: r.top_vulnerable_machine || 'General Laboratory',
                totalTimeouts: timeouts,
                accuracyPct: Math.round(accuracy * 100)
            };
        }).sort((a, b) => b.riskScore - a.riskScore);
    } catch (err) {
        console.error('[arcadeAnalyticsService.getEarlyWarningRiskList]', err);
        return [];
    }
}

/**
 * 7. Question Bank Psychometrics (Item Difficulty P & Discrimination D)
 */
async function getQuestionPsychometrics(levelNumber = null) {
    try {
        let sql = `
            SELECT 
                ca.customer_id_ref,
                ca.level_number,
                ca.machine_used,
                ca.question_snapshot,
                ca.correct_answer,
                COUNT(ca.attempt_id) AS total_attempts,
                SUM(ca.is_correct) AS total_correct,
                SUM(ca.is_timeout) AS total_timeouts,
                ROUND(AVG(ca.response_time_s), 1) AS avg_response_time_s
            FROM elementa_customer_attempts ca
            WHERE ca.customer_id_ref IS NOT NULL
        `;
        const params = [];
        if (levelNumber) {
            sql += ` AND ca.level_number = ?`;
            params.push(levelNumber);
        }
        sql += ` GROUP BY ca.customer_id_ref, ca.level_number, ca.machine_used, ca.question_snapshot, ca.correct_answer HAVING total_attempts >= 3`;

        const [rows] = await pool.query(sql, params);

        return rows.map(r => {
            const attempts = Number(r.total_attempts);
            const correct = Number(r.total_correct);
            const pIndex = Number((correct / attempts).toFixed(2)); // Difficulty (0 to 1)

            // Approximation of Discrimination Index D based on error distribution
            const timeouts = Number(r.total_timeouts);
            let dIndex = Number((0.35 + (pIndex > 0.3 && pIndex < 0.8 ? 0.25 : -0.15) - (timeouts / attempts * 0.3)).toFixed(2));
            dIndex = Math.max(-0.2, Math.min(0.85, dIndex));

            let status = 'Optimal';
            if (pIndex < 0.30) status = 'Too Difficult / Ambiguous';
            else if (pIndex > 0.90) status = 'Too Easy';
            if (dIndex < 0.15) status = 'Poor Discrimination (Check Phrasing)';

            return {
                id: r.customer_id_ref,
                level: r.level_number,
                machine: r.machine_used,
                prompt: r.question_snapshot,
                answer: r.correct_answer,
                attempts: attempts,
                difficultyP: pIndex,
                discriminationD: dIndex,
                status: status,
                avgTime: r.avg_response_time_s,
                timeouts: timeouts
            };
        });
    } catch (err) {
        console.error('[arcadeAnalyticsService.getQuestionPsychometrics]', err);
        return [];
    }
}

/**
 * 8. Step-by-Step Problem-Solving Replay for a Game Session
 * Constructs a chronological timeline of interactions (periodic lookups, customer orders,
 * machine configurations, hesitation pauses, and outcomes) for teacher inspection.
 */
async function getSessionReplay(sessionId) {
    try {
        const [[session]] = await pool.query(
            `SELECT s.*, 
                    u1.first_name AS p1_first, u1.last_name AS p1_last, u1.lrn_number AS p1_lrn,
                    u2.first_name AS p2_first, u2.last_name AS p2_last
             FROM elementa_game_sessions s
             LEFT JOIN users u1 ON u1.user_id = s.student_id_p1
             LEFT JOIN users u2 ON u2.user_id = s.student_id_p2
             WHERE s.session_id = ?`,
            [sessionId]
        );

        if (!session) return null;

        const isDual = session.play_mode === 'Versus' || Boolean(session.student_id_p2);

        const [attempts] = await pool.query(
            `SELECT ca.*, r.level_number, r.player_number
             FROM elementa_customer_attempts ca
             JOIN elementa_level_runs r ON r.run_id = ca.run_id
             WHERE r.session_id = ?
             ORDER BY ca.customer_index ASC, r.player_number ASC, ca.attempted_at ASC`,
            [sessionId]
        );

        const [clicks] = await pool.query(
            `SELECT ec.*, r.player_number FROM elementa_element_clicks ec
             JOIN elementa_level_runs r ON r.run_id = ec.run_id
             WHERE r.session_id = ?
             ORDER BY ec.clicked_at ASC`,
            [sessionId]
        );

        // Merge attempts and clicks into a unified timeline
        const events = [];

        attempts.forEach(att => {
            const playerNum = att.player_number || 1;
            const isP1 = playerNum === 1;
            const pName = isP1
                ? `${session.p1_first} ${session.p1_last}`
                : ((session.p2_first && session.p2_last) ? `${session.p2_first} ${session.p2_last}` : 'Player 2');

            events.push({
                type: 'attempt',
                isDual: isDual,
                playerNumber: playerNum,
                playerName: pName,
                timestamp: att.attempted_at,
                level: att.level_number,
                customerIndex: att.customer_index,
                customer: att.customer_name || att.customer_id_ref || (`Customer #${att.customer_index}`),
                question: att.question_snapshot,
                machine: att.machine_used,
                studentAnswer: att.player_answer || att.student_answer,
                correctAnswer: att.correct_answer,
                isCorrect: Boolean(att.is_correct),
                isTimeout: Boolean(att.is_timeout),
                failureType: att.failure_type,
                responseTime: att.response_time_s,
                timeGiven: att.time_given_s,
                hesitationScore: att.hesitation_score || 0,
                scaffoldingUsed: att.scaffolding_used && att.scaffolding_used !== '0'
            });
        });

        clicks.forEach(clk => {
            const playerNum = clk.player_number || 1;
            const isP1 = playerNum === 1;
            const pName = isP1
                ? `${session.p1_first} ${session.p1_last}`
                : ((session.p2_first && session.p2_last) ? `${session.p2_first} ${session.p2_last}` : 'Player 2');

            events.push({
                type: 'periodic_lookup',
                isDual: isDual,
                playerNumber: playerNum,
                playerName: pName,
                timestamp: clk.clicked_at,
                symbol: clk.element_symbol,
                atomicNumber: clk.atomic_number,
                source: clk.click_source || clk.source,
                durationMs: clk.view_duration_ms || null
            });
        });

        // In a dual assessment: ensure for each question (customerIndex), Player 1 answered first, followed by Player 2
        if (isDual) {
            events.sort((a, b) => {
                if (a.customerIndex != null && b.customerIndex != null && a.customerIndex !== b.customerIndex) {
                    return a.customerIndex - b.customerIndex;
                }
                if (a.customerIndex != null && b.customerIndex != null && a.playerNumber !== b.playerNumber) {
                    return a.playerNumber - b.playerNumber; // Player 1 answered first, followed by Player 2
                }
                return new Date(a.timestamp) - new Date(b.timestamp);
            });
        } else {
            // Solo: sort chronologically
            events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        }

        return {
            session,
            events
        };
    } catch (err) {
        console.error('[arcadeAnalyticsService.getSessionReplay]', err);
        return null;
    }
}

module.exports = {
    getStudentRadar,
    getStudentDistrictProgress,
    getStudentMistakes,
    getPeriodicTableHeatmap,
    getSpeedAccuracyDistribution,
    getEarlyWarningRiskList,
    getQuestionPsychometrics,
    getSessionReplay
};

