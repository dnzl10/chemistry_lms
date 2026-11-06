const path = require('path');

const LOGO_PATH = path.join(process.cwd(), 'assets', 'mabini_letterhead.png');

/**
 * Draws the standard Mabini Colleges letterhead at the top of a pdfkit doc.
 * Call this immediately after `new PDFDocument(...)`, before any other content.
 *
 * @param {PDFDocument} doc
 * @param {string} subtitle   e.g. "Class & Teacher Mapping — Summary Report"
 * @param {object} opts       { logoWidth, showGeneratedDate }
 * @returns {number} the y-coordinate where content should start below the header
 */
function drawPdfLetterhead(doc, subtitle, opts = {}) {
    const logoWidth = opts.logoWidth || 60;
    const startX = doc.page.margins.left;
    const startY = doc.page.margins.top;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Logo (top-left)
    doc.image(LOGO_PATH, startX, startY, { width: logoWidth });

    // Institutional text block, to the right of the logo
    const textX = startX + logoWidth + 14;
    const textWidth = pageWidth - logoWidth - 14;

    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(13)
       .text('MABINI COLLEGES, INC.', textX, startY, { width: textWidth, align: 'center' });
    doc.font('Helvetica').fontSize(10)
       .text('HIGH SCHOOL DEPARTMENT', { width: textWidth, align: 'center' });
    doc.fontSize(9).fillColor('#475569')
       .text('(Flora A. Ibana Campus)', { width: textWidth, align: 'center' })
       .text('Kapt. Isko St., Daet, Camarines Norte', { width: textWidth, align: 'center' });

    let y = Math.max(doc.y, startY + logoWidth) + 6;

    // Divider rule
    doc.moveTo(startX, y).lineTo(startX + pageWidth, y).lineWidth(1.2).strokeColor('#4f46e5').stroke();
    y += 8;

    // Report subtitle + timestamp
    doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(11)
       .text(subtitle, startX, y, { width: pageWidth, align: 'center' });
    y = doc.y + 2;

    if (opts.showGeneratedDate !== false) {
        doc.fillColor('#64748b').font('Helvetica').fontSize(8)
           .text(`Generated: ${new Date().toLocaleString('en-PH')}`, startX, y, { width: pageWidth, align: 'center' });
        y = doc.y;
    }

    doc.fillColor('#000000');
    return y + 10; // caller starts drawing content from this y
}

module.exports = { drawPdfLetterhead, LOGO_PATH };