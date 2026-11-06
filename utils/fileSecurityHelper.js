const path = require('path');
const fs = require('fs');

// Blacklist of hazardous executable and script extensions
const DANGEROUS_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.sh', '.bash', '.vbs', '.vbe',
    '.ps1', '.ps2', '.scr', '.pif', '.application', '.gadget',
    '.msi', '.msp', '.com', '.hta', '.cpl', '.msc', '.jar',
    '.php', '.php3', '.php4', '.php5', '.phtml', '.phps',
    '.asp', '.aspx', '.cer', '.asa', '.jsp', '.jspx', '.cgi',
    '.pl', '.py', '.rb', '.reg', '.wsf', '.wsh'
]);

/**
 * Sanitizes a filename to prevent directory traversal and injection.
 * @param {string} originalName 
 * @returns {string} Safe cleaned filename
 */
function sanitizeFileName(originalName) {
    if (!originalName) return 'unnamed_file';
    const base = path.basename(originalName);
    // Replace dangerous or non-standard characters with underscore
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Prevent hidden files (starting with dot) or multiple dots
    return safe.replace(/^\.+/, 'file_').replace(/\.{2,}/g, '.');
}

/**
 * Validates if the given file has an extension permitted by the assignment's rule.
 * @param {string} filename 
 * @param {string} allowedExtensionsString e.g. ".pdf,.docx,.xlsx"
 * @returns {boolean}
 */
function isExtensionAllowed(filename, allowedExtensionsString) {
    if (!filename) return false;
    const ext = path.extname(filename).toLowerCase();
    
    // First, verify against dangerous extensions
    if (DANGEROUS_EXTENSIONS.has(ext)) {
        return false;
    }

    // If no restriction specified or wildcard present, allow all non-dangerous files
    if (!allowedExtensionsString || allowedExtensionsString.trim() === '' || allowedExtensionsString.includes('*/*') || allowedExtensionsString.includes('*')) {
        return true;
    }

    const allowed = allowedExtensionsString
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)
        .map(e => e.startsWith('.') ? e : '.' + e);

    return allowed.includes(ext);
}

/**
 * Checks if a filename has a known dangerous/executable extension.
 * @param {string} filename 
 * @returns {boolean}
 */
function isDangerousFile(filename) {
    if (!filename) return false;
    const ext = path.extname(filename).toLowerCase();
    return DANGEROUS_EXTENSIONS.has(ext);
}

/**
 * Ensures an array of directory paths exist on disk.
 * @param {string[]} dirs 
 */
function ensureDirectoriesExist(dirs) {
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

module.exports = {
    DANGEROUS_EXTENSIONS,
    sanitizeFileName,
    isExtensionAllowed,
    isDangerousFile,
    ensureDirectoriesExist
};
