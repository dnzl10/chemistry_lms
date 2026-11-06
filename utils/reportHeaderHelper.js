const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Resolve institutional logo assets relative to application root
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const LOGO_LEFT = path.join(ASSETS_DIR, 'mabini_logo1.png');
const LOGO_RIGHT = path.join(ASSETS_DIR, 'mabini_logo2.png');
const LETTERHEAD_IMG = path.join(ASSETS_DIR, 'mabini_letterhead.png');

/**
 * Generates an auditable, cryptographically unique Document Reference ID.
 * Example: DOC-20260914-A3F9C1
 */
function generateAuditRef(prefix = 'DOC') {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${dateStr}-${rand}`;
}

/**
 * Formats generation timestamp in Philippine Standard Time (PST, UTC+8).
 */
function formatPstTimestamp(date = new Date()) {
    return new Date(date).toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }) + ' (PST)';
}

/**
 * Renders the standardized document header on a PDFKit document.
 * 
 * POLICY ENFORCEMENT:
 * - Teacher & Admin reports: Uses standard header.docx institutional letterhead
 *   (Mabini Colleges, Inc., High School Department, Flora A. Ibana Campus) with dual logos.
 * - Student reports: Strictly EXCLUDED from header.docx. Renders a modern
 *   "STUDENT COPY — UNOFFICIAL TRANSCRIPT" arcade header without institutional seal.
 * 
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {Object} opts - Header options
 * @returns {number} The y-coordinate where body content should start
 */
function drawPdfDocumentHeader(doc, opts = {}) {
    const {
        title = 'ACADEMIC REPORT',
        subtitle = '',
        scope = '',
        user = null,
        role = (user && user.role) ? user.role : 'System',
        classification = null,
        auditRef = generateAuditRef(),
        isContinuation = false,
        layout = 'portrait'
    } = opts;

    const pageW = doc.page.width;
    const margin = doc.page.margins.left;
    const contentW = pageW - (margin * 2);

    // Determine security classification banner if not explicitly passed
    let securityBanner = classification;
    if (!securityBanner) {
        if (role === 'Admin') {
            securityBanner = 'RESTRICTED — ADMIN EYES ONLY';
        } else if (role === 'Teacher') {
            securityBanner = 'CONFIDENTIAL — TEACHER COPY';
        } else {
            securityBanner = 'STUDENT COPY — UNOFFICIAL TRANSCRIPT';
        }
    }

    const isStudent = (role === 'Student');

    // ── CONTINUATION PAGES (Page 2+) ─────────────────────────────────
    if (isContinuation) {
        doc.rect(margin, 16, contentW, 24).fill('#f8fafc').stroke('#e2e8f0');
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1e293b')
           .text(isStudent ? `Elementa LMS  |  ${title} (Cont.)` : `Mabini Colleges, Inc.  |  ${title} (Cont.)`,
                 margin + 8, 23, { width: contentW - 150 });
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
           .text(`Ref: ${auditRef}`, margin + contentW - 140, 23, { width: 130, align: 'right' });
        doc.y = 48;
        return doc.y;
    }

    // ── PAGE 1: PRIMARY HEADER ───────────────────────────────────────
    if (!isStudent) {
        // =============================================================
        // TEACHER & ADMIN LEVEL: OFFICIAL INSTITUTIONAL LETTERHEAD
        // Matches official Mabini Colleges, Inc. High School Dept header
        // (Dual seals on left, Institution title in center-left,
        //  Vision / Mission / Core Values on right, double navy rule)
        // =============================================================
        const isLandscape = (layout === 'landscape' || pageW > doc.page.height);
        const headerH = 96;

        // Clean white institutional letterhead background
        doc.save();
        doc.rect(0, 0, pageW, headerH).fill('#ffffff');

        // 1. Left Composite Dual-Seal Logo (mabini_letterhead.png)
        const letterheadW = isLandscape ? 120 : 110;
        const letterheadH = Math.round(letterheadW * (183 / 321)); // ~63-68pt
        const letterheadY = 15;
        if (fs.existsSync(LETTERHEAD_IMG)) {
            try {
                doc.image(LETTERHEAD_IMG, margin, letterheadY, { width: letterheadW, height: letterheadH });
            } catch (_) {}
        } else {
            // Fallback to individual seals if composite asset is unavailable
            if (fs.existsSync(LOGO_RIGHT)) {
                try { doc.image(LOGO_RIGHT, margin, letterheadY, { width: 54, height: 54 }); } catch (_) {}
            }
            if (fs.existsSync(LOGO_LEFT)) {
                try { doc.image(LOGO_LEFT, margin + 46, letterheadY + 12, { width: 54, height: 54 }); } catch (_) {}
            }
        }

        // 2. Center-Left Institutional Name & Campus Address Block
        const leftTextX = margin + letterheadW + (isLandscape ? 10 : 6);
        const rightBlockW = isLandscape ? 295 : 215;
        const rightBlockX = pageW - margin - rightBlockW;
        const leftTextW = Math.max(150, rightBlockX - leftTextX - 6);

        doc.fillColor('#5b9bd5').font('Times-Bold').fontSize(isLandscape ? 16 : 13.5)
           .text('MABINI COLLEGES, INC.', leftTextX, 28, { width: leftTextW, lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Bold').fontSize(isLandscape ? 11.5 : 10)
           .text('HIGH SCHOOL DEPARTMENT', leftTextX, 45, { width: leftTextW, lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Italic').fontSize(isLandscape ? 10.5 : 9.2)
           .text('(Flora A. Ibana Campus)', leftTextX, 57.5, { width: leftTextW, lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Roman').fontSize(isLandscape ? 9.5 : 8.2)
           .text('Kapt. Isko St., Daet, Camarines Norte', leftTextX, 69.5, { width: leftTextW, lineBreak: false });

        // 3. Right Vision / Mission / Core Values Column
        doc.fillColor('#7f7f7f').font('Times-Bold').fontSize(isLandscape ? 7 : 6.4)
           .text('VISION', rightBlockX, 10, { width: rightBlockW, align: 'center', lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Italic').fontSize(isLandscape ? 5.6 : 5.1)
           .text('MABINI COLLEGES shall cultivate a CULTURE OF EXCELLENCE in education.',
                 rightBlockX, 17.5, { width: rightBlockW, align: 'center', lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Bold').fontSize(isLandscape ? 7 : 6.4)
           .text('MISSION', rightBlockX, 24.5, { width: rightBlockW, align: 'center', lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Italic').fontSize(isLandscape ? 5.4 : 4.9)
           .text('MABINI COLLEGES provide quality instruction, research and extension service programs at all educational levels as its monumental contribution to national growth and development, producing God-fearing, nation-loving, earth-caring, law-abiding, productive and globally competitive graduates.',
                 rightBlockX, 31.5, { width: rightBlockW, align: 'center', lineGap: -0.4 });

        doc.fillColor('#7f7f7f').font('Times-BoldItalic').fontSize(isLandscape ? 6 : 5.5)
           .text('CORE VALUES:', rightBlockX, 53, { width: rightBlockW, align: 'center', lineBreak: false });

        doc.fillColor('#7f7f7f').font('Times-Roman').fontSize(isLandscape ? 5.3 : 4.8)
           .text('The Mabini Colleges aims to develop, strengthen and promote the following Core Values:',
                 rightBlockX, 59.5, { width: rightBlockW, align: 'center', lineBreak: false });

        const coreValues = ['Integrity', 'Benevolence', 'Artistic', 'Nature Loving', 'Accountability'];
        let cvY = 65.5;
        for (const cv of coreValues) {
            doc.fillColor('#595959').font('Times-BoldItalic').fontSize(isLandscape ? 5.6 : 5.3)
               .text(cv, rightBlockX, cvY, { width: rightBlockW, align: 'center', lineBreak: false });
            cvY += 5.6;
        }

        // 4. Bottom Double Navy-Blue Horizontal Rule (#1f3864)
        const ruleY = 96;
        doc.moveTo(margin, ruleY).lineTo(pageW - margin, ruleY)
           .lineWidth(2.2).strokeColor('#1f3864').stroke();
        doc.moveTo(margin, ruleY + 2.6).lineTo(pageW - margin, ruleY + 2.6)
           .lineWidth(0.8).strokeColor('#1f3864').stroke();
        doc.restore();

        // 5. Report Title & Classification / Audit Metadata Strip below Letterhead
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10)
           .text(title.toUpperCase(), margin, ruleY + 6, { align: 'center', width: contentW, lineBreak: false });

        const stripY = ruleY + 19;
        const stripH = 20;
        doc.rect(margin, stripY, contentW, stripH).fill('#f1f5f9');

        // Security Classification Badge
        const badgeColor = role === 'Admin' ? '#991b1b' : '#312e81';
        doc.rect(margin + 4, stripY + 3, 175, 14).fill(badgeColor);
        doc.fontSize(6.8).font('Helvetica-Bold').fillColor('#ffffff')
           .text(securityBanner, margin + 8, stripY + 6.5, { width: 167, align: 'center', lineBreak: false });

        // Generation Metadata
        const actorName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'System';
        const metaText = `Generated by: ${actorName} (${role})   |   ${formatPstTimestamp()}   |   Ref: ${auditRef}`;
        doc.fontSize(6.8).font('Helvetica').fillColor('#475569')
           .text(metaText, margin + 185, stripY + 6.5, { width: contentW - 190, align: 'right' });

        // Subtitle / Active filter scope line if provided
        let currentY = stripY + stripH + 6;
        if (subtitle || scope) {
            const scopeText = [subtitle, scope].filter(Boolean).join('   •   ');
            doc.rect(margin, currentY, contentW, 15).fill('#f8fafc').stroke('#e2e8f0');
            doc.fontSize(7.5).font('Helvetica').fillColor('#0284c7')
               .text(`Scope / Filter: ${scopeText}`, margin + 8, currentY + 3.5, { width: contentW - 16, lineBreak: false });
            currentY += 20;
        }

        doc.y = currentY;
        return doc.y;

    } else {
        // =============================================================
        // STUDENT LEVEL: EXCLUDED FROM header.docx LETTERHEAD
        // Modern student copy banner without official school seal
        // =============================================================
        const bannerH = 72;
        doc.rect(0, 0, pageW, bannerH).fill('#0f172a'); // Slate dark
        doc.rect(0, bannerH, pageW, 3).fill('#10b981'); // Emerald accent

        // Platform Brand
        doc.fillColor('#34d399').fontSize(13).font('Helvetica-Bold')
           .text('ELEMENTA — CHEMISTRY ARCADE LMS', margin, 18, { width: contentW });

        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
           .text(title.toUpperCase(), margin, 35, { width: contentW });

        doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
           .text('Student Academic & Gaming Progress Record', margin, 50, { width: contentW });

        // Unofficial Student Badge on top-right
        doc.rect(pageW - margin - 190, 20, 190, 22).fill('#064e3b');
        doc.fillColor('#6ee7b7').fontSize(7.5).font('Helvetica-Bold')
           .text('STUDENT COPY — UNOFFICIAL', pageW - margin - 186, 26, { width: 182, align: 'center' });

        // Strip
        const stripY = bannerH + 3;
        doc.rect(0, stripY, pageW, 24).fill('#ecfdf5');

        const actorName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Student';
        const metaText = `Learner Copy: ${actorName}   |   ${formatPstTimestamp()}   |   Ref: ${auditRef}`;
        doc.fontSize(7).font('Helvetica').fillColor('#065f46')
           .text(metaText, margin, stripY + 7, { width: contentW });

        let currentY = stripY + 24 + 10;
        if (scope) {
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155').text(scope, margin, currentY);
            currentY = doc.y + 6;
        }

        doc.y = currentY;
        return doc.y;
    }
}

/**
 * Attaches multi-pass page numbers and confidentiality footer to all buffered pages.
 */
function attachPdfFooters(doc, auditRef, classification = 'CONFIDENTIAL') {
    const range = doc.bufferedPageRange();
    const margin = doc.page.margins.left;
    const contentW = doc.page.width - (margin * 2);
    const footerY = doc.page.height - 24;

    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.moveTo(margin, footerY - 4).lineTo(margin + contentW, footerY - 4).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
        doc.fontSize(7).font('Helvetica').fillColor('#64748b')
           .text(`Page ${i - range.start + 1} of ${range.count}   •   Doc ID: ${auditRef}   •   ${classification}`,
                 margin, footerY, { align: 'center', width: contentW, lineBreak: false });
        doc.page.margins.bottom = oldBottom;
    }
}

/**
 * Applies standardized Excel metadata header block.
 * - Teacher/Admin: Full Mabini Colleges institutional header
 * - Student: Excluded from Mabini Colleges letterhead
 */
function applyExcelMetadataHeader(worksheet, opts = {}) {
    const {
        title = 'ACADEMIC REPORT',
        scope = 'All Records',
        user = null,
        role = (user && user.role) ? user.role : 'System',
        classification = null,
        auditRef = generateAuditRef(),
        lastCol = 'L'
    } = opts;

    let securityBanner = classification;
    if (!securityBanner) {
        if (role === 'Admin') securityBanner = 'RESTRICTED — ADMIN EYES ONLY';
        else if (role === 'Teacher') securityBanner = 'CONFIDENTIAL — TEACHER COPY';
        else securityBanner = 'STUDENT COPY — UNOFFICIAL TRANSCRIPT';
    }

    const isStudent = (role === 'Student');

    if (!isStudent) {
        // Teacher / Admin Header matching header.docx
        worksheet.mergeCells(`A1:${lastCol}1`);
        worksheet.getCell('A1').value = 'MABINI COLLEGES, INC. — HIGH SCHOOL DEPARTMENT';
        worksheet.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FF0D1A2E' } };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };

        worksheet.mergeCells(`A2:${lastCol}2`);
        worksheet.getCell('A2').value = '(Flora A. Ibana Campus) • Kapt. Isko St., Daet, Camarines Norte';
        worksheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF475569' } };
        worksheet.getCell('A2').alignment = { horizontal: 'center' };

        worksheet.mergeCells(`A3:${lastCol}3`);
        worksheet.getCell('A3').value = `Elementa Chemistry Arcade LMS — ${title}`;
        worksheet.getCell('A3').font = { bold: true, size: 11, color: { argb: 'FF312E81' } };
        worksheet.getCell('A3').alignment = { horizontal: 'center' };

        worksheet.mergeCells(`A4:${lastCol}4`);
        worksheet.getCell('A4').value = `Scope: ${scope}   |   Classification: ${securityBanner}`;
        worksheet.getCell('A4').font = { italic: true, size: 9, color: { argb: 'FF0369A1' } };
        worksheet.getCell('A4').alignment = { horizontal: 'center' };

        const actor = user ? `${user.first_name || ''} ${user.last_name || ''} (${role})`.trim() : 'System';
        worksheet.mergeCells(`A5:${lastCol}5`);
        worksheet.getCell('A5').value = `Generated By: ${actor}   |   Date: ${formatPstTimestamp()}   |   Ref ID: ${auditRef}`;
        worksheet.getCell('A5').font = { size: 8, color: { argb: 'FF64748B' } };
        worksheet.getCell('A5').alignment = { horizontal: 'center' };

        worksheet.addRow([]); // Blank spacer at row 6
    } else {
        // Student Header (Excluded from header.docx)
        worksheet.mergeCells(`A1:${lastCol}1`);
        worksheet.getCell('A1').value = 'ELEMENTA CHEMISTRY ARCADE LMS — STUDENT REPORT';
        worksheet.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FF065F46' } };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };

        worksheet.mergeCells(`A2:${lastCol}2`);
        worksheet.getCell('A2').value = `Classification: STUDENT COPY — UNOFFICIAL TRANSCRIPT   |   Ref ID: ${auditRef}`;
        worksheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF047857' } };
        worksheet.getCell('A2').alignment = { horizontal: 'center' };

        worksheet.addRow([]); // Blank spacer
    }
}

/**
 * Sets anti-caching HTTP response headers for safe report downloads.
 */
function setExportHttpHeaders(res, filename, mimeType) {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

module.exports = {
    generateAuditRef,
    formatPstTimestamp,
    drawPdfDocumentHeader,
    attachPdfFooters,
    applyExcelMetadataHeader,
    setExportHttpHeaders,
    LOGO_LEFT,
    LOGO_RIGHT,
    LETTERHEAD_IMG
};
