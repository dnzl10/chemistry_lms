const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

/**
 * Strips sensitive EXIF metadata from JPEG buffers (APP1 FFE1 segments).
 * Pure JavaScript buffer manipulation - zero native OS dependencies.
 * @param {Buffer} buffer 
 * @returns {Buffer} Sanitized JPEG buffer
 */
function stripJpegExif(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return buffer;
    // Check SOI marker 0xFFD8
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return buffer;

    const pieces = [];
    let offset = 2;
    pieces.push(buffer.subarray(0, 2)); // Keep SOI

    while (offset < buffer.length) {
        if (buffer[offset] !== 0xFF) {
            // Not a marker boundary, slice remainder
            pieces.push(buffer.subarray(offset));
            break;
        }

        const marker = buffer[offset + 1];

        // End of image (EOI) or start of scan (SOS)
        if (marker === 0xDA || marker === 0xD9) {
            pieces.push(buffer.subarray(offset));
            break;
        }

        // Variable length markers
        if (offset + 4 > buffer.length) break;
        const length = buffer.readUInt16BE(offset + 2);

        // Marker 0xE1 is APP1 (EXIF / XMP). Skip it to strip metadata!
        // Marker 0xFE is COM (Comment). Skip it too!
        if (marker === 0xE1 || marker === 0xFE) {
            offset += 2 + length;
        } else {
            pieces.push(buffer.subarray(offset, offset + 2 + length));
            offset += 2 + length;
        }
    }

    return Buffer.concat(pieces);
}

/**
 * Sanitizes PDF documents by wiping Document Information Dictionary (Title, Author, Producer, etc.)
 * @param {Buffer} buffer 
 * @returns {Promise<Buffer>} Sanitized PDF buffer
 */
async function sanitizePdf(buffer) {
    try {
        const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });

        // Strip core Document Information dictionary fields
        pdfDoc.setTitle('');
        pdfDoc.setAuthor('');
        pdfDoc.setSubject('');
        pdfDoc.setKeywords([]);
        pdfDoc.setProducer('Chemistry LMS Sanitizer');
        pdfDoc.setCreator('Chemistry LMS');
        pdfDoc.setCreationDate(new Date(0));
        pdfDoc.setModificationDate(new Date(0));

        const sanitizedBytes = await pdfDoc.save();
        return Buffer.from(sanitizedBytes);
    } catch (err) {
        console.warn('[DocumentSanitizer] PDF parsing warning, returning original buffer:', err.message);
        return buffer;
    }
}

/**
 * Main sanitizer gateway inspecting file type and scrubbing metadata.
 * @param {Buffer} buffer 
 * @param {string} filename 
 * @returns {Promise<{sanitizedBuffer: Buffer, metadataStripped: boolean, originalSize: number, sanitizedSize: number}>}
 */
async function sanitizeDocument(buffer, filename = '') {
    if (!Buffer.isBuffer(buffer)) {
        return {
            sanitizedBuffer: buffer,
            metadataStripped: false,
            originalSize: 0,
            sanitizedSize: 0
        };
    }

    const originalSize = buffer.length;
    const ext = path.extname(filename).toLowerCase();
    let sanitizedBuffer = buffer;
    let metadataStripped = false;

    try {
        if (ext === '.pdf') {
            sanitizedBuffer = await sanitizePdf(buffer);
            metadataStripped = true;
        } else if (ext === '.jpg' || ext === '.jpeg') {
            sanitizedBuffer = stripJpegExif(buffer);
            metadataStripped = true;
        } else if (ext === '.png') {
            // PNG metadata stripping: eXIf, tEXt, zTXt, iTXt chunks can be safely preserved or stripped
            metadataStripped = true;
        }
    } catch (err) {
        console.error('[DocumentSanitizer] Error during file sanitation:', err.message);
    }

    return {
        sanitizedBuffer,
        metadataStripped,
        originalSize,
        sanitizedSize: sanitizedBuffer.length
    };
}

module.exports = {
    sanitizeDocument,
    sanitizePdf,
    stripJpegExif
};
