/**
 * utils/elementaTopicLevelHelper.js
 * ============================================================================
 * Canonical Level, Topic, and Machine Resolution for Elementa Chemistry Arcade.
 *
 * Keeps the Express LMS and the Godot 4 Elementa Arcade Masterfile strictly in
 * lockstep across all 12 districts/levels:
 *   Level 1 : Scientific Measurement           (Chemical Mixing Station)
 *   Level 2 : Quantum Theory                   (Atom Builder)
 *   Level 3 : Isotopes                         (Isotope Modifier)
 *   Level 4 : Atomic Mass                      (Atomic Balance Machine)
 *   Level 5 : Percentage Composition           (Compound Assembly)
 *   Level 6 : Chemical Nomenclature            (Compound Naming Machine)
 *   Level 7 : Chemical Bonds & Properties      (Bond Mixing Laboratory)
 *   Level 8 : Intermolecular Forces            (Molecular Mixing Laboratory)
 *   Level 9 : Organic Compounds                (Organic Reaction Laboratory)
 *   Level 10: Types of Chemical Reactions      (Reaction Chamber)
 *   Level 11: Mole Concept                     (Mole Distribution Machine)
 *   Level 12: Law of Conservation of Mass      (Reaction Balancer)
 * ============================================================================
 */

const LEVEL_MACHINES = {
    1: { name: "Chemical Mixing Station", id: 1, topic: "Scientific Measurement" },
    2: { name: "Atom Builder", id: 2, topic: "Quantum Theory" },
    3: { name: "Isotope Modifier", id: 3, topic: "Isotopes" },
    4: { name: "Atomic Balance Machine", id: 4, topic: "Atomic Mass" },
    5: { name: "Compound Assembly", id: 5, topic: "Percentage Composition" },
    6: { name: "Compound Naming Machine", id: 6, topic: "Chemical Nomenclature" },
    7: { name: "Bond Mixing Laboratory", id: 7, topic: "Chemical Bonds & Properties" },
    8: { name: "Molecular Mixing Laboratory", id: 8, topic: "Intermolecular Forces" },
    9: { name: "Organic Reaction Laboratory", id: 9, topic: "Organic Compounds" },
    10: { name: "Reaction Chamber", id: 10, topic: "Types of Chemical Reactions" },
    11: { name: "Mole Distribution Machine", id: 11, topic: "Mole Concept" },
    12: { name: "Reaction Balancer", id: 12, topic: "Law of Conservation of Mass & Stoichiometry" }
};

// Fallback topic_id -> level mapping for existing databases
const TOPIC_LEVEL_MAP = {
    1: 1,   // Scientific Measurement (active DB topic_id = 1)
    3: 1,   // Scientific Measurement (legacy dump topic_id = 3)
    4: 2,   // Quantum Theory
    5: 3,   // Isotopes
    11: 4,  // Atomic mass
    12: 5,  // Percentage composition
    13: 6,  // Chemical nomenclature
    14: 7,  // Chemical bonds
    2: 9,   // Organic compounds
    8: 10,  // Types of chemical reactions
    9: 11,  // The Mole Concept
    10: 12  // Conservation of Mass & Stoichiometry
};

// Reverse map: Level -> Topic ID
const LEVEL_TOPIC_MAP = {
    1: 1,
    2: 4,
    3: 5,
    4: 11,
    5: 12,
    6: 13,
    7: 14,
    8: 1,
    9: 2,
    10: 8,
    11: 9,
    12: 10
};

/**
 * Normalizes and resolves canonical level number (1-12) from any topic title string.
 * @param {string} topicName 
 * @returns {number|null} 1 to 12, or null if unrecognized
 */
function resolveLevelFromTopicName(topicName) {
    if (!topicName || typeof topicName !== 'string') return null;
    const norm = topicName.toLowerCase().trim();

    if (norm.includes('measurement')) return 1;
    if (norm.includes('quantum')) return 2;
    if (norm.includes('isotope')) return 3;
    if (norm.includes('atomic mass')) return 4;
    if (norm.includes('percentage') || norm.includes('composition')) return 5;
    if (norm.includes('nomenclature') || norm.includes('naming')) return 6;
    if (norm.includes('bond')) return 7;
    if (norm.includes('intermolecular')) return 8;
    if (norm.includes('organic')) return 9;
    if (norm.includes('conservation') || norm.includes('stoichiometry')) return 12;
    if (norm.includes('mole')) return 11;
    if (norm.includes('reaction')) return 10;

    return null;
}

/**
 * Resolves the accurate level number (1-12) for a given topic ID by querying
 * the topics table in the active database connection.
 * @param {object} db - mysql2 pool/promise connection
 * @param {number|string} topicId
 * @returns {Promise<number>} Level number (1-12), defaults to 1 if not found
 */
async function resolveLevelForTopicId(db, topicId) {
    const tid = parseInt(topicId, 10);
    if (isNaN(tid) || tid <= 0) return 1;

    try {
        const [rows] = await db.query('SELECT topic_id, topic_name FROM topics WHERE topic_id = ? LIMIT 1', [tid]);
        if (rows && rows.length > 0 && rows[0].topic_name) {
            const resolved = resolveLevelFromTopicName(rows[0].topic_name);
            if (resolved) return resolved;
        }
    } catch (_) {
        // Fall back to static map on query failure
    }

    return TOPIC_LEVEL_MAP[tid] || 1;
}

/**
 * Resolves the topic_id for a given level number from the database.
 * @param {object} db - mysql2 pool/promise connection
 * @param {number|string} levelNumber
 * @returns {Promise<number|null>}
 */
async function resolveTopicIdForLevel(db, levelNumber) {
    const lvl = parseInt(levelNumber, 10);
    if (isNaN(lvl) || lvl <= 0 || lvl > 12) return null;

    try {
        const [topics] = await db.query('SELECT topic_id, topic_name FROM topics');
        for (const t of topics) {
            if (resolveLevelFromTopicName(t.topic_name) === lvl) {
                return t.topic_id;
            }
        }
    } catch (_) {
        // Fall back to static map
    }

    return LEVEL_TOPIC_MAP[lvl] || null;
}

module.exports = {
    LEVEL_MACHINES,
    TOPIC_LEVEL_MAP,
    LEVEL_TOPIC_MAP,
    resolveLevelFromTopicName,
    resolveLevelForTopicId,
    resolveTopicIdForLevel
};
