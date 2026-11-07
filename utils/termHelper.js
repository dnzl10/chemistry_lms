/**
 * utils/termHelper.js
 * ============================================================================
 * Centralized Domain Logic & Display Facade for Academic Terms & Grading Periods.
 * Supports:
 *   - Semestral (1st Sem, 2nd Sem, Summer/Midyear)
 *   - Trimester (1st, 2nd, 3rd Trim)
 *   - Quarterly / K–12 (Continuous shell, Q1–Q4 evaluation checkpoints)
 * ============================================================================
 */

const TERM_CONFIGS = {
    semestral: {
        id: 'semestral',
        label: 'Semestral',
        description: 'Two 18-week semesters with optional 6-week summer/midyear term.',
        defaultTerms: [
            { order: 1, name: '1st Semester', code: 'SEM1' },
            { order: 2, name: '2nd Semester', code: 'SEM2' },
            { order: 3, name: 'Summer / Midyear', code: 'SUMMER', isOptional: true }
        ],
        periods: [
            { number: 1, label: 'Midterm Period', code: 'MID' },
            { number: 2, label: 'Final Period', code: 'FIN' }
        ]
    },
    trimester: {
        id: 'trimester',
        label: 'Trimester',
        description: 'Three equal 12–14 week terms running consecutively throughout the year.',
        defaultTerms: [
            { order: 1, name: '1st Trimester', code: 'TRIM1' },
            { order: 2, name: '2nd Trimester', code: 'TRIM2' },
            { order: 3, name: '3rd Trimester', code: 'TRIM3' }
        ],
        periods: [
            { number: 1, label: 'Midterm Period', code: 'MID' },
            { number: 2, label: 'Final Period', code: 'FIN' }
        ]
    },
    quarterly: {
        id: 'quarterly',
        label: 'Quarterly (K–12)',
        description: 'Continuous course shells with four evaluation checkpoints (Q1 through Q4).',
        defaultTerms: [
            { order: 1, name: 'Academic Year', code: 'AY' }
        ],
        periods: [
            { number: 1, label: 'Quarter 1', code: 'Q1' },
            { number: 2, label: 'Quarter 2', code: 'Q2' },
            { number: 3, label: 'Quarter 3', code: 'Q3' },
            { number: 4, label: 'Quarter 4', code: 'Q4' }
        ]
    }
};

/**
 * Get configuration object for a term structure with safe fallback to quarterly.
 * @param {string} structure
 * @returns {object}
 */
function getTermStructureConfig(structure) {
    if (!structure) return TERM_CONFIGS.quarterly;
    const key = String(structure).toLowerCase().trim();
    return TERM_CONFIGS[key] || TERM_CONFIGS.quarterly;
}

/**
 * Resolves the display label for a quarter / grading period number.
 * If a custom display_label is stored in quarters.display_label, that takes precedence.
 *
 * @param {number|string} periodNumber
 * @param {string|null} customLabel
 * @param {string} termStructure - 'semestral', 'trimester', 'quarterly'
 * @returns {string}
 */
function getPeriodDisplayLabel(periodNumber, customLabel = null, termStructure = 'quarterly') {
    if (customLabel && typeof customLabel === 'string' && customLabel.trim()) {
        return customLabel.trim();
    }
    const num = Number(periodNumber);
    const cfg = getTermStructureConfig(termStructure);
    const match = cfg.periods.find(p => p.number === num);
    if (match) return match.label;
    return `Quarter ${periodNumber}`;
}

/**
 * Resolves a short code for badges (e.g. 'MID', 'FIN', 'Q1').
 * @param {number|string} periodNumber
 * @param {string} termStructure
 * @returns {string}
 */
function getPeriodShortCode(periodNumber, termStructure = 'quarterly') {
    const num = Number(periodNumber);
    const cfg = getTermStructureConfig(termStructure);
    const match = cfg.periods.find(p => p.number === num);
    if (match) return match.code;
    return `P${num}`;
}

/**
 * Checks if enrollment is active for a term (and optional class override).
 * @param {object} term
 * @param {object|null} classSettings
 * @param {Date} [now]
 * @returns {{ isOpen: boolean, reason: string }}
 */
function isEnrollmentOpen(term, classSettings = null, now = new Date()) {
    // 1. Check term status
    if (term) {
        if (term.status === 'draft') {
            return { isOpen: false, reason: 'Term is currently in draft mode.' };
        }
        if (term.status === 'grading_locked' || term.status === 'archived') {
            return { isOpen: false, reason: 'Term enrollment has concluded.' };
        }
        if (term.enrollment_start && now < new Date(term.enrollment_start)) {
            return { isOpen: false, reason: `Enrollment opens on ${new Date(term.enrollment_start).toLocaleDateString('en-PH')}.` };
        }
        if (term.enrollment_end && now > new Date(term.enrollment_end)) {
            return { isOpen: false, reason: `Enrollment closed on ${new Date(term.enrollment_end).toLocaleDateString('en-PH')}.` };
        }
    }

    // 2. Class-level override check (if provided)
    if (classSettings) {
        if (classSettings.enrollment_start && now < new Date(classSettings.enrollment_start)) {
            return { isOpen: false, reason: `Class enrollment opens on ${new Date(classSettings.enrollment_start).toLocaleDateString('en-PH')}.` };
        }
        if (classSettings.enrollment_end && now > new Date(classSettings.enrollment_end)) {
            return { isOpen: false, reason: `Class enrollment closed on ${new Date(classSettings.enrollment_end).toLocaleDateString('en-PH')}.` };
        }
        if (classSettings.max_capacity !== null && classSettings.max_capacity !== undefined) {
            const cap = Number(classSettings.max_capacity);
            const count = Number(classSettings.enrolled_count || 0);
            if (cap > 0 && count >= cap) {
                return { isOpen: false, reason: 'Class has reached maximum enrollment capacity.' };
            }
        }
    }

    return { isOpen: true, reason: 'Enrollment is active.' };
}

/**
 * Checks if Add/Drop deadline has passed.
 * @param {object} term
 * @param {Date} [now]
 * @returns {boolean} true if students can still add/drop
 */
function isAddDropOpen(term, now = new Date()) {
    if (!term || !term.add_drop_deadline) return true; // No deadline set = always open
    return now <= new Date(term.add_drop_deadline);
}

/**
 * Checks whether instructors are allowed to encode or edit student grades.
 * @param {object} term
 * @param {Date} [now]
 * @returns {{ isAllowed: boolean, reason: string }}
 */
function isGradingAllowed(term, now = new Date()) {
    if (!term) return { isAllowed: true, reason: 'No term constraints.' };

    if (term.status === 'grading_locked') {
        return { isAllowed: false, reason: 'Grading is officially locked for this term.' };
    }
    if (term.status === 'archived') {
        return { isAllowed: false, reason: 'This term is archived (read-only).' };
    }
    if (term.grading_deadline && now > new Date(term.grading_deadline)) {
        return { isAllowed: false, reason: `Grading deadline passed on ${new Date(term.grading_deadline).toLocaleString('en-PH')}.` };
    }

    return { isAllowed: true, reason: 'Grading is open.' };
}

/**
 * Builds the default array of terms to seed when creating a new school year.
 * @param {string} termStructure - 'semestral', 'trimester', 'quarterly'
 * @param {string} syRange - e.g. '2026-2027'
 * @param {boolean} [includeSummer=false]
 * @returns {Array<{ term_name: string, term_code: string, term_order: number, is_active: number }>}
 */
function getDefaultTermsForStructure(termStructure, syRange, includeSummer = false) {
    const cfg = getTermStructureConfig(termStructure);
    const results = [];

    cfg.defaultTerms.forEach(t => {
        if (t.isOptional && !includeSummer) return;
        results.push({
            term_name: `${t.name} (${syRange})`,
            term_code: t.code,
            term_order: t.order,
            is_active: t.order === 1 ? 1 : 0
        });
    });

    return results;
}

/**
 * UI helper: Returns visual CSS classes and text for term status badges.
 * @param {string} status
 * @returns {{ label: string, badgeClass: string, icon: string }}
 */
function getStatusBadgeMeta(status) {
    const s = String(status || 'open').toLowerCase();
    switch (s) {
        case 'draft':
            return {
                label: 'Draft',
                badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
                icon: 'fas fa-pencil-ruler'
            };
        case 'open':
        case 'active':
            return {
                label: 'Active / Open',
                badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                icon: 'fas fa-check-circle'
            };
        case 'grading_locked':
            return {
                label: 'Grading Locked',
                badgeClass: 'bg-orange-50 text-orange-700 border-orange-200',
                icon: 'fas fa-lock'
            };
        case 'archived':
            return {
                label: 'Archived (Read-Only)',
                badgeClass: 'bg-slate-100 text-slate-600 border-slate-300',
                icon: 'fas fa-archive'
            };
        default:
            return {
                label: s,
                badgeClass: 'bg-slate-100 text-slate-600 border-slate-200',
                icon: 'fas fa-info-circle'
            };
    }
}

module.exports = {
    TERM_CONFIGS,
    getTermStructureConfig,
    getPeriodDisplayLabel,
    getPeriodShortCode,
    isEnrollmentOpen,
    isAddDropOpen,
    isGradingAllowed,
    getDefaultTermsForStructure,
    getStatusBadgeMeta
};

