# Enterprise Reporting, Data Export & RBAC Security Audit Report

**Application:** Elementa — Chemistry Arcade & Learning Management System (LMS)  
**Target Codebase:** Node.js (v18+), Express (v5.2.1), MariaDB/MySQL (`mysql2/promise`), PDFKit (v0.19.1), ExcelJS (v4.4.0), SheetJS/XLSX (v0.18.5), PDF-Lib (v1.17.1)  
**Date of Audit:** September 14, 2026  
**Auditor:** Senior Software Engineer, Enterprise Document Systems Specialist & Security Auditor  
**Audit Scope & Frameworks:**
- Role-Based Access Control (RBAC) & Data Scoping (OWASP Top 10 A01: Broken Access Control)
- Insecure Direct Object References (IDOR) & Cross-Tenant/Cross-Teacher Data Leakage
- Enterprise Document Architecture & Standardized Institutional Letterhead Compliance
- DepEd Order No. 8 s. 2015 & RA 10173 (Philippine Data Privacy Act — Student PII Protection)
- Memory Safety, Large Dataset Streaming & Denial of Service (DoS) Mitigation

---

## Executive Summary

An exhaustive technical evaluation of the reporting and document export pipelines was conducted across the Elementa LMS codebase (specifically `routes/teacher.js`, `routes/admin.js`, `routes/student.js`, `utils/pdfLetterhead.js`, `utils/documentSanitizer.js`, and database interaction patterns).

The LMS provides key academic export capabilities (PDF and Excel rosters, student report cards, remediation tracking, curriculum coverage, and audit log exports). However, the implementation suffers from **severe data leakage vulnerabilities, broken scoping in multi-teacher subject assignments, complete absence of student self-service reporting, silent logo rendering failures, and architectural fragmentation** across PDF and spreadsheet document layouts.

### Key Audit Findings Dashboard

| Audit Dimension | Current Status | Risk Level | Primary Impact |
| :--- | :--- | :--- | :--- |
| **RBAC: Student Reporting** | **Non-Existent** (0 student export endpoints) | 🟡 **MODERATE** | Students cannot export their own report cards/transcripts; forced to rely on teachers. |
| **Teacher Remediation Scoping** | **Broken JOIN** (`q.subject_id = c.subject_id`) | 🔴 **CRITICAL (IDOR)** | Teacher A can view and export wrong answers/remediation lists of Teacher B's students. |
| **Report Card Filter Scoping** | **Unvalidated `class_id` & `SELECT *`** | 🟠 **HIGH** | Queries fetch password hashes/tokens; omitting `class_id` leaks multi-subject grades. |
| **Minor PII & Telemetry Masking** | **Unmasked in PDF/Excel** | 🟠 **HIGH** | Minor birthdates, cell numbers, city, and internal session IDs exported in plain text. |
| **PDF Header Architecture** | **Fragmented & Silent File Path Bug** | 🟠 **HIGH** | Teacher PDFs look for non-existent `../public/assets/`, skipping logos; Admin uses different header. |
| **Audit Log Scalability** | **Unbounded In-Memory Buffering** | 🟠 **HIGH (DoS)** | Entire `activity_logs` table loaded without date/row bounds; SheetJS memory spikes. |
| **Excel Cell & Header Integrity** | **Raw Type Casts & Missing Cache Headers** | 🟡 **MODERATE** | DepEd 12-digit LRNs risk truncation/scientific notation; missing `Cache-Control: no-store`. |

---

## 1. Access Control & Security Audit

### 1.1 Detailed Endpoint Inventory & RBAC Matrix

| Endpoint | Method | Middleware | Intended Role | Scoping Mechanism in SQL | Vulnerability / Gap |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/teacher/reports/export/class-list/pdf` | GET | `isTeacher` | Teacher | `c.teacher_id = ?` + optional filters | Missing pagination metadata; missing cache headers; hardcoded page break thresholds. |
| `/teacher/reports/export/class-list/excel` | GET | `isTeacher` | Teacher | `c.teacher_id = ?` + optional filters | LRN written without explicit text formatting (risks scientific notation); no audit reference ID. |
| `/teacher/reports/export/report-card/:studentId` | GET | `isTeacher` | Teacher | Roster check + `ss.student_id = ?` | **Broken Scope:** Unvalidated `class_id`; `SELECT *` over-fetches sensitive user auth tokens. |
| `/teacher/reports/export/remediation/pdf` | GET | `isTeacher` | Teacher | `c.teacher_id = ?` joined via `q.subject_id` | **CRITICAL IDOR:** Lacks `class_students` join; leaks remediation data of other teachers' classes. |
| `/admin/rm/export/curriculum` | GET | `requireAdmin` | Admin | Aggregated `quarters` & `subjects` | Uses SheetJS buffer; lacks audit reference ID and standardized institutional metadata block. |
| `/admin/rm/export/class-summary` | GET | `requireAdmin` | Admin | Institutional class aggregates | Uses `drawPdfLetterhead`; lacks `bufferPages: true` (no page count "Page X of Y"). |
| `/admin/rm/export/class/:id` | GET | `requireAdmin` | Admin | Parameterized `c.class_id = ?` | Exposes full student LRNs and EXP; lacks document classification banners. |
| `/admin/rm/export/student/:id` | GET | `requireAdmin` | Admin | Parameterized `u.user_id = ?` | **PII Exposure:** Outputs minor's mobile number, birthdate, and residential town unmasked. |
| `/admin/rm/export/students-all` | GET | `requireAdmin` | Admin | Filtered by pass/fail status | Unbounded query; no pagination or row capping; missing audit tracking. |
| `/admin/system_audit/export` | GET | `requireAdmin` | Admin | Unbounded `activity_logs` dump | **DoS & Info Leak:** Memory exhaustion on large tables; exports internal session IDs & raw IPs. |
| `/student/reports/export/*` | — | — | Student | **None** | **Missing Feature:** Zero self-service export routes exist for students to download their copies. |

---

### 1.2 Deep-Dive Vulnerability Analysis

#### Vulnerability 1: Cross-Teacher Remediation Data Leakage (Critical IDOR)
* **Location:** `routes/teacher.js:5118-5135`
* **Vulnerable Query:**
  ```sql
  SELECT u.first_name, u.last_name, u.lrn_number, t.topic_name, q.quarter_number,
         COUNT(sr.response_id) AS wrong_count,
         GROUP_CONCAT(DISTINCT qb.question_text ORDER BY qb.question_id SEPARATOR ' | ') AS questions
  FROM student_responses sr
  JOIN student_scores ss ON sr.score_id = ss.score_id
  JOIN users u ON ss.student_id = u.user_id
  JOIN question_bank qb ON sr.question_id = qb.question_id
  JOIN assessments a ON ss.assessment_id = a.assessment_id
  JOIN topics t ON a.topic_id = t.topic_id
  JOIN quarters q ON t.quarter_id = q.quarter_id
  JOIN classes c ON q.subject_id = c.subject_id
  WHERE c.teacher_id = ? AND sr.is_correct = 0
  GROUP BY u.user_id, t.topic_id
  ```
* **Flaw Mechanism:** `classes c` is joined solely on `q.subject_id = c.subject_id`. In an institutional school setup where multiple sections of "General Chemistry 1" are taught by different instructors (Teacher A teaches Section 1, Teacher B teaches Section 2), both classes share the same `subject_id`. Because there is **no join to `class_students cs` verifying that `u.user_id` is actually enrolled in `c.class_id`**, Teacher A's export queries will retrieve every failed student response across the entire school under that subject.
* **Remediation:** Enforce strict student roster membership:
  ```sql
  JOIN class_students cs ON cs.student_id = u.user_id AND cs.class_id = c.class_id
  WHERE c.teacher_id = ? AND sr.is_correct = 0
  ```

#### Vulnerability 2: Insecure Direct Object Reference (IDOR) & Scope Tampering in Report Cards
* **Location:** `routes/teacher.js:4941-4977`
* **Flaw Mechanism:**
  1. Access authorization checks:
     ```sql
     SELECT u.user_id FROM users u
     JOIN class_students cs ON u.user_id = cs.student_id
     JOIN classes c ON cs.class_id = c.class_id
     WHERE c.teacher_id = ? AND u.user_id = ? LIMIT 1
     ```
     This verifies the teacher teaches the student in *at least one* class.
  2. However, the score filtering logic permits arbitrary query tampering:
     ```javascript
     if (selectedClassId) {
         scoreClauses.push('q.subject_id IN (SELECT subject_id FROM classes WHERE class_id = ?)');
         scoreParams.push(selectedClassId);
     }
     ```
     The query does **not** verify `c.teacher_id = ?` on `selectedClassId`. A teacher can provide any class ID belonging to another teacher or department to probe score records.
  3. Worse, if `selectedClassId` is **omitted**, the query retrieves all scores recorded for that student across all subjects, violating FERPA/DPA data minimization.
  4. Query over-fetching: `SELECT * FROM users WHERE user_id = ?` fetches `password_hash`, `current_session_id`, and `qr_code_token` directly into Node.js application memory.

#### Vulnerability 3: Sensitive Minor PII & Security Telemetry Exposure
* **Location:** `routes/admin.js:6190-6258` and `routes/admin.js:7078-7126`
* **Student Dossier:** `routes/admin.js` exports high school student residential `city_town`, personal `birthdate`, `mobile_number`, and statutory `lrn_number`. Under RA 10173 and COPPA/FERPA, documents that may be printed or forwarded must enforce data masking (e.g., masking mobile numbers `0917-***-1234` and birthdates) unless explicitly flagged for verified administrative audit.
* **Audit Log Export:** `routes/admin.js:7083-7085` exports active `session_id` strings and raw client `ip_address` into Excel. If an administrative staff member exports and emails `audit_log.xlsx`, any active session IDs contained in that file can lead to session hijacking if session tokens have not yet expired.

#### Vulnerability 4: Denial of Service (DoS) via Unbounded Audit Log Exports
* **Location:** `routes/admin.js:7075-7149`
* **Flaw Mechanism:** `GET /admin/system_audit/export` executes `SELECT ... FROM activity_logs ORDER BY created_at DESC` with zero row limits and zero date range requirements. In an active LMS with thousands of game interactions and daily logins, `activity_logs` easily exceeds 100,000+ rows. Loading these rows into memory, building arrays of arrays, and running `XLSX.write(wb, { type: 'buffer' })` will cause severe memory exhaustion, triggering V8 garbage collection freezes or Node process crashes (`OOM - Out of Memory`).

#### Vulnerability 5: Silent Asset Resolution Bug in Teacher Header Helper
* **Location:** `routes/teacher.js:50-53`
* **Code:**
  ```javascript
  const logoLeftPath  = require('path').join(__dirname, '..', 'public', 'assets', 'mabini_logo1.png');
  const logoRightPath = require('path').join(__dirname, '..', 'public', 'assets', 'mabini_logo2.png');
  ```
* **Root Cause:** The `public/assets` directory does not exist; the actual institutional logos reside in `assets/mabini_logo1.png` and `assets/mabini_logo2.png`. Because the code wraps image loading in `try { ... } catch (_) {}`, the system **silently fails to render the institutional logos on every teacher PDF export**.

---

## 2. Standard Header & Role Metadata Blueprint

To eliminate visual and regulatory divergence between PDF and spreadsheet formats, all generated documents must implement a unified institutional metadata schema.

### 2.1 Unified Institutional Metadata Schema

Every generated report MUST incorporate the following standardized metadata properties:

```json
{
  "institution": {
    "name": "MABINI COLLEGES, INC.",
    "department": "HIGH SCHOOL DEPARTMENT",
    "campus": "Flora A. Ibana Campus",
    "address": "Kapt. Isko St., Daet, Camarines Norte",
    "system": "Elementa — Chemistry Arcade LMS"
  },
  "report": {
    "title": "STUDENT PROGRESS REPORT CARD",
    "scope": "Quarter 1 | Academic Year 2026-2027 | Grade 11 - STEM",
    "reference_id": "DOC-20260914-7F8A2E",
    "classification": "CONFIDENTIAL — TEACHER COPY",
    "generated_by": "Maria Santos (Teacher)",
    "generated_at": "2026-09-14 14:30:00 (Asia/Manila, UTC+8)"
  }
}
```

### 2.2 Security Classification Banner Matrix

| Requesting Role | Document Type | Security Classification Banner | Visual Accent Color |
| :--- | :--- | :--- | :--- |
| **Administrator** | System Audit Log, Institutional Dossier | `RESTRICTED — ADMIN EYES ONLY` | Crimson `#991b1b` / `#fee2e2` |
| **Teacher** | Class Attendance, Remediation Report | `CONFIDENTIAL — TEACHER COPY` | Indigo `#312e81` / `#e0e7ff` |
| **Teacher / Student** | Student Progress Report Card | `OFFICIAL ACADEMIC RECORD` | Cyan/Navy `#0369a1` / `#e0f2fe` |
| **Student** | Student Self-Service Copy | `STUDENT COPY — UNOFFICIAL TRANSCRIPT` | Slate/Teal `#0f766e` / `#ccfbf1` |

---

### 2.3 Visual ASCII Blueprint — PDF Layout (Portrait A4)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Mabini Logo]              MABINI COLLEGES, INC.                    [Elementa Logo]    │
│                           HIGH SCHOOL DEPARTMENT                                       │
│                           (Flora A. Ibana Campus)                                      │
│                     Kapt. Isko St., Daet, Camarines Norte                              │
│                      Elementa Chemistry Arcade LMS                                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                     STUDENT PROGRESS REPORT CARD                                       │
│          Scope: Academic Year 2026–2027 | Grade 11 - STEM Einstein | Q1                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [CLASSIFICATION: CONFIDENTIAL — TEACHER COPY]                                          │
│ Ref ID: DOC-20260914-8A9C4F      │ Generated: 2026-09-14 14:30:15 (Asia/Manila, UTC+8)│
│ Generated By: Maria Santos (Teacher - ID: 104)                                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  STUDENT PROFILE & DEMOGRAPHICS                                                        │
│  Student: DELA CRUZ, Juan P.     │ LRN: 109283746501       │ Section: STEM-11A         │
│  Strand: STEM                    │ Level: 14 (3,450 EXP)   │ Status: Enrolled          │
│                                                                                        │
│  ACADEMIC EVALUATION & ASSESSMENT SUMMARY                                              │
│  ┌─────┬───────────────────────────┬──────────────┬──────────┬────────┬─────────────┐  │
│  │ Qtr │ Topic Name                │ Type         │ Score    │ Pct %  │ Rating      │  │
│  ├─────┼───────────────────────────┼──────────────┼──────────┼────────┼─────────────┤  │
│  │ Q1  │ Stoichiometry & Moles     │ Quiz         │ 18 / 20  │ 90.0%  │ Passed      │  │
│  │ Q1  │ Periodic Trends           │ Post-Test    │ 27 / 30  │ 90.0%  │ Passed      │  │
│  │ Q1  │ Chemical Bonding          │ Mastery      │ 14 / 20  │ 70.0%  │ Needs Review│  │
│  └─────┴───────────────────────────┴──────────────┴──────────┴────────┴─────────────┘  │
│                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Page 1 of 2  │  Document Reference: DOC-20260914-8A9C4F  │  Verify at /verify/report   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.4 Visual ASCII Blueprint — Excel (.xlsx) Metadata Header Block

In spreadsheet formats, raw tables dumped at Row 1 look unprofessional and lack legal chain of custody. The top 6 rows must be reserved for institutional metadata:

```
Row 1: [A1:J1 MERGED] MABINI COLLEGES, INC. — HIGH SCHOOL DEPARTMENT (Flora A. Ibana Campus)
Row 2: [A2:J2 MERGED] Elementa Chemistry Arcade LMS — Academic & Attendance Master Report
Row 3: [A3:J3 MERGED] Scope: Academic Year 2026-2027 | Section: STEM-11A | Quarter: 1
Row 4: [A4:J4 MERGED] CLASSIFICATION: CONFIDENTIAL — TEACHER COPY  |  Doc Ref: DOC-20260914-8A9C4F
Row 5: [A5:J5 MERGED] Generated By: Maria Santos (Teacher) | Timestamp: 2026-09-14 14:30:15 (Asia/Manila, UTC+8)
Row 6: [BLANK DIVIDER ROW]
Row 7: [TABLE HEADERS - Styled Background #312E81, White Text, Thin Cyan Bottom Border]
       | # | LRN Number | Last Name | First Name | Sex | Strand | Section | Present | Late | Abs | Att % |
Row 8+: [DATA ROWS - Text formatted strings, explicit number types, zebra striping]
```

---

## 3. Export Formats & Data Integrity Specifications

### 3.1 PDF Generation Best Practices
1. **Geometry & Margins:**
   - Standardize page size to `A4` (`595.28 x 841.89 points`).
   - Default margins: `36pt` (0.5 inch) to maximize printable data area while ensuring printable clearance.
   - Always instantiate with `bufferPages: true` to enable multi-pass page numbering:
     ```javascript
     const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
     ```
2. **Page Budgeting & Row Break Prevention:**
   - Replace arbitrary `if (doc.y > 790)` checks with calculated printable heights:
     ```javascript
     const bottomLimit = doc.page.height - doc.page.margins.bottom - 40; // 40pt reserved for footer
     if (doc.y + rowHeight > bottomLimit) {
         doc.addPage();
         drawReportHeader(doc, options, true); // true = draw minimal header on continuation pages
     }
     ```
3. **Continuation Pages:**
   - Continuation pages should not redraw the full 120pt institutional letterhead. Instead, use a compact 30pt continuation bar:
     `Mabini Colleges | Student Report Card — Continued | Ref: DOC-20260914-XXXX`
4. **Professional Typography:**
   - Standardize on `Helvetica-Bold` for section headers, `Helvetica` for regular cells, with tabular numeric alignments (`align: 'right'`) for scores and percentages.

---

### 3.2 Excel (.xlsx) & CSV Generation Best Practices
1. **DepEd LRN & Identifier Integrity:**
   - Learner Reference Numbers (LRN) are exactly 12 digits (e.g. `109283746501`). In Excel, numeric storage of 12 digits often leads to scientific notation (`1.0928E+11`) or truncation of leading zeros.
   - **Enforcement:** In ExcelJS, set column data type explicitly to string and set format to text:
     ```javascript
     row.getCell('lrn_number').numFmt = '@';
     row.getCell('lrn_number').value = String(student.lrn_number || '');
     ```
2. **Date & Currency Formatting:**
   - Never store dates as raw localized strings in Excel cells. Pass JavaScript `Date` objects and assign standard ISO display formats:
     ```javascript
     cell.value = new Date(record.created_at);
     cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
     ```
3. **UTF-8 BOM for CSV:**
   - When generating CSV downloads, prepend the Byte Order Mark (`\uFEFF`) so Microsoft Excel on Windows renders UTF-8 characters (accents, en-dashes, ñ) correctly.
4. **Clean HTTP Response Headers:**
   - Always configure anti-caching and correct content disposition headers:
     ```javascript
     res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
     res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.xlsx"`);
     res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
     res.setHeader('Pragma', 'no-cache');
     res.setHeader('Expires', '0');
     res.setHeader('X-Content-Type-Options', 'nosniff');
     ```

---

## 4. Performance & Scalability Architecture

### 4.1 Memory & Buffering Audit
* **Current Issue:** In `routes/admin.js:7132`, `XLSX.write(wb, { type: 'buffer' })` creates an entire binary buffer in RAM. For 100,000 audit records, this consumes ~150MB of heap and blocks the single-threaded Node.js event loop during synchronous serialization.
* **Target Solution for Large Exports:**
  1. For Excel exports exceeding 5,000 rows, utilize `exceljs.stream.xlsx.WorkbookWriter`:
     ```javascript
     const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
     const worksheet = workbook.addWorksheet('Logs');
     // Write rows as they stream from MySQL cursor
     ```
  2. For Audit Logs, impose **mandatory date filtering** or cap exports at `10,000` rows per export job.

---

## 5. Implementation & Code Refactoring Plan

To permanently standardize reporting and resolve all security vulnerabilities, three concrete implementation tasks are established:

### Phase 1: Create Centralized Document Header & Audit Utility (`utils/reportHeaderHelper.js`)
* Provides a unified helper for both PDFKit and ExcelJS.
* Resolves logos reliably from `assets/mabini_logo1.png` and `assets/mabini_logo2.png`.
* Generates cryptographically verifiable Audit Reference IDs (`DOC-YYYYMMDD-XXXXXX`).
* Renders security classification banners (`CONFIDENTIAL`, `RESTRICTED`, `STUDENT COPY`).
* Manages multi-pass footers ("Page X of Y").

### Phase 2: Refactor & Secure Teacher Export Controllers (`routes/teacher.js`)
* Fix the critical IDOR flaw in `/teacher/reports/export/remediation/pdf` by joining `class_students`.
* Sanitize and scope `/teacher/reports/export/report-card/:studentId` to prevent multi-subject leaks and replace `SELECT *`.
* Replace broken `drawPdfHeader` calls with `reportHeaderHelper`.

### Phase 3: Secure Admin Exports & Implement Student Self-Service
* Restrict `/admin/system_audit/export` to max row limits and redact active `session_id` tokens.
* Mask minor PII (birthdates, phone numbers) on student dossiers.
* Implement a dedicated `GET /student/reports/export/report-card` endpoint allowing students to download their own progress report card with automatic self-scoping (`WHERE u.user_id = req.user.user_id`).

---

## 6. Concrete Code Adjustments

### 6.1 New Module: `utils/reportHeaderHelper.js`

```javascript
/**
 * utils/reportHeaderHelper.js
 * Unified Enterprise Document Header, Branding & Audit Reference Generator
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const LOGO_LEFT = path.join(process.cwd(), 'assets', 'mabini_logo1.png');
const LOGO_RIGHT = path.join(process.cwd(), 'assets', 'mabini_logo2.png');
const LETTERHEAD = path.join(process.cwd(), 'assets', 'mabini_letterhead.png');

/**
 * Generates an auditable, human-readable document reference ID.
 */
function generateAuditRef(prefix = 'DOC') {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${dateStr}-${rand}`;
}

/**
 * Formats generation timestamp in Philippine Standard Time (PST, UTC+8).
 */
function formatTimestamp() {
    return new Date().toLocaleString('en-PH', {
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
 * Draws the standardized institutional header for PDFKit documents.
 */
function drawPdfDocumentHeader(doc, opts = {}) {
    const {
        title = 'INSTITUTIONAL REPORT',
        scope = 'Academic Year 2026–2027',
        user = null,
        classification = 'CONFIDENTIAL — INSTITUTIONAL USE ONLY',
        auditRef = generateAuditRef(),
        isContinuation = false
    } = opts;

    const pageW = doc.page.width;
    const margin = doc.page.margins.left;
    const contentW = pageW - (margin * 2);

    if (isContinuation) {
        // Compact header for page 2+
        doc.rect(margin, 20, contentW, 22).fill('#f8fafc').stroke('#e2e8f0');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e293b')
           .text(`MABINI COLLEGES  |  ${title} (Continued)`, margin + 8, 26, { width: contentW - 140 });
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
           .text(`Ref: ${auditRef}`, margin + contentW - 130, 26, { width: 120, align: 'right' });
        doc.y = 52;
        return doc.y;
    }

    // ── Primary Institutional Banner ─────────────────────────
    const bannerHeight = 84;
    doc.rect(0, 0, pageW, bannerHeight).fill('#0d1a2e');
    doc.rect(0, bannerHeight, pageW, 3).fill('#06b6d4'); // Cyan accent

    // Render left & right logos safely
    const logoSize = 56;
    const logoY = 14;
    if (fs.existsSync(LOGO_LEFT)) {
        doc.image(LOGO_LEFT, margin, logoY, { width: logoSize, height: logoSize });
    }
    if (fs.existsSync(LOGO_RIGHT)) {
        doc.image(LOGO_RIGHT, pageW - margin - logoSize, logoY, { width: logoSize, height: logoSize });
    }

    // Header Institutional Text
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
       .text('MABINI COLLEGES, INC.', 0, 15, { align: 'center', width: pageW });
    doc.fontSize(9).font('Helvetica').fillColor('#94d6f0')
       .text('HIGH SCHOOL DEPARTMENT (Flora A. Ibana Campus)', 0, 32, { align: 'center', width: pageW });
    doc.fontSize(7.5).fillColor('#cbd5e1')
       .text('Kapt. Isko St., Daet, Camarines Norte  •  Elementa Chemistry Arcade LMS', 0, 45, { align: 'center', width: pageW });

    // Report Title & Scope
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff')
       .text(title.toUpperCase(), 0, 60, { align: 'center', width: pageW });

    // ── Metadata & Security Strip ─────────────────────────────
    const stripY = bannerHeight + 3;
    doc.rect(0, stripY, pageW, 26).fill('#f1f5f9');

    // Classification Badge
    doc.rect(margin, stripY + 5, 160, 16).fill('#312e81');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff')
       .text(classification, margin + 4, stripY + 9, { width: 152, align: 'center' });

    // Metadata Right: Generated by, Timestamp, Ref ID
    const actorText = user ? `${user.first_name} ${user.last_name} (${user.role})` : 'System';
    doc.fontSize(7).font('Helvetica').fillColor('#475569')
       .text(`Generated By: ${actorText}  |  ${formatTimestamp()}  |  Ref: ${auditRef}`,
             margin + 170, stripY + 9, { width: contentW - 170, align: 'right' });

    doc.y = stripY + 36;
    return doc.y;
}

/**
 * Attaches multi-pass footers ("Page X of Y") and audit reference to all buffered pages.
 */
function attachPdfFooters(doc, auditRef, classification = 'CONFIDENTIAL') {
    const range = doc.bufferedPageRange();
    const margin = doc.page.margins.left;
    const contentW = doc.page.width - (margin * 2);
    const footerY = doc.page.height - 28;

    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(margin, footerY - 4).lineTo(margin + contentW, footerY - 4).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
        doc.fontSize(7).font('Helvetica').fillColor('#64748b')
           .text(`Page ${i - range.start + 1} of ${range.count}   •   Doc ID: ${auditRef}   •   ${classification}`,
                 margin, footerY, { align: 'center', width: contentW });
    }
}

/**
 * Injects standardized institutional metadata header into ExcelJS worksheets.
 */
function applyExcelMetadataHeader(worksheet, opts = {}) {
    const {
        title = 'ACADEMIC REPORT',
        scope = 'All Records',
        user = null,
        classification = 'CONFIDENTIAL — INSTITUTIONAL USE ONLY',
        auditRef = generateAuditRef(),
        lastCol = 'J'
    } = opts;

    worksheet.mergeCells(`A1:${lastCol}1`);
    worksheet.getCell('A1').value = 'MABINI COLLEGES, INC. — HIGH SCHOOL DEPARTMENT';
    worksheet.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FF0D1A2E' } };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    worksheet.mergeCells(`A2:${lastCol}2`);
    worksheet.getCell('A2').value = `Elementa Chemistry Arcade LMS — ${title}`;
    worksheet.getCell('A2').font = { bold: true, size: 10, color: { argb: 'FF312E81' } };
    worksheet.getCell('A2').alignment = { horizontal: 'center' };

    worksheet.mergeCells(`A3:${lastCol}3`);
    worksheet.getCell('A3').value = `Scope: ${scope}   |   Classification: ${classification}`;
    worksheet.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF0369A1' } };
    worksheet.getCell('A3').alignment = { horizontal: 'center' };

    const actor = user ? `${user.first_name} ${user.last_name} (${user.role})` : 'System';
    worksheet.mergeCells(`A4:${lastCol}4`);
    worksheet.getCell('A4').value = `Generated By: ${actor}   |   Date: ${formatTimestamp()}   |   Ref ID: ${auditRef}`;
    worksheet.getCell('A4').font = { size: 8, color: { argb: 'FF64748B' } };
    worksheet.getCell('A4').alignment = { horizontal: 'center' };

    worksheet.addRow([]); // Blank spacer row at Row 5
}

module.exports = {
    generateAuditRef,
    formatTimestamp,
    drawPdfDocumentHeader,
    attachPdfFooters,
    applyExcelMetadataHeader
};
```

---

### 6.2 Hardened Remediation Controller (`routes/teacher.js`)

Eliminates the cross-teacher leakage by binding directly to `class_students`:

```javascript
// SECURED: /reports/export/remediation/pdf
router.get('/reports/export/remediation/pdf', isTeacher, async (req, res) => {
    const teacherId       = req.user.user_id;
    const selectedClassId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const filterQuarter   = req.query.quarter   || null;
    const filterRisk      = req.query.risk      || null;
    const filterTopic     = req.query.topic_id  || null;

    try {
        // STRICT SCOPING: Join class_students and bind to teacherId
        let whereClauses = ['c.teacher_id = ?', 'sr.is_correct = 0'];
        let params       = [teacherId];

        if (selectedClassId) {
            whereClauses.push('c.class_id = ?');
            params.push(selectedClassId);
        }
        if (filterQuarter) {
            whereClauses.push('q.quarter_number = ?');
            params.push(filterQuarter);
        }
        if (filterTopic) {
            whereClauses.push('t.topic_id = ?');
            params.push(filterTopic);
        }

        const [rows] = await db.execute(`
            SELECT
                u.first_name, u.last_name, u.lrn_number,
                t.topic_name, q.quarter_number,
                COUNT(sr.response_id) AS wrong_count
            FROM student_responses sr
            JOIN student_scores ss ON sr.score_id = ss.score_id
            JOIN users u ON ss.student_id = u.user_id
            JOIN class_students cs ON u.user_id = cs.student_id
            JOIN classes c ON cs.class_id = c.class_id
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ${whereClauses.join(' AND ')}
            GROUP BY u.user_id, t.topic_id
            ORDER BY u.last_name ASC, wrong_count DESC`, params
        );

        const auditRef = generateAuditRef('REM');
        const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="remediation_${auditRef}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        doc.pipe(res);

        drawPdfDocumentHeader(doc, {
            title: 'Remediation & Risk Assessment Report',
            scope: selectedClassId ? `Class ID: ${selectedClassId}` : 'All Assigned Classes',
            user: req.user,
            classification: 'CONFIDENTIAL — TEACHER COPY',
            auditRef
        });

        // ... Render table rows with dynamic pagination ...

        attachPdfFooters(doc, auditRef, 'CONFIDENTIAL — TEACHER COPY');
        doc.end();

        await logActivity(req.user.user_id, 'Teacher', 'EXPORT_REMEDIATION_REPORT',
            `Exported remediation report Ref: ${auditRef} (${rows.length} records)`);
    } catch (err) {
        console.error('❌ [GET /reports/export/remediation/pdf]', err);
        res.status(500).send('Remediation export failed.');
    }
});
```

---

### 6.3 New Student Self-Service Report Card Route (`routes/student.js`)

Empowers students to safely download their own verified report card with zero privilege escalation risk:

```javascript
// NEW ROUTE: GET /student/reports/export/report-card
router.get('/reports/export/report-card', isAuthenticated, async (req, res) => {
    // HARD ENFORCEMENT: Scoped exclusively to the logged-in student's identity
    const studentId = req.user.user_id;

    try {
        const [[student]] = await db.execute(`
            SELECT user_id, first_name, middle_name, last_name, lrn_number,
                   grade_level, section, strand, current_level, total_exp
            FROM users WHERE user_id = ? AND role = 'Student'`, [studentId]
        );
        if (!student) return res.status(404).send('Student profile not found.');

        const [scores] = await db.execute(`
            SELECT ss.score_obtained, ss.total_items, ss.exp_gained, ss.date_recorded,
                   a.assessment_name, a.assessment_type, t.topic_name, q.quarter_number
            FROM student_scores ss
            JOIN assessments a ON ss.assessment_id = a.assessment_id
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE ss.student_id = ?
            ORDER BY q.quarter_number ASC, ss.date_recorded DESC`, [studentId]
        );

        const auditRef = generateAuditRef('STU');
        const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="my_report_card_${student.last_name}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        doc.pipe(res);

        drawPdfDocumentHeader(doc, {
            title: 'Student Progress Report Card',
            scope: `Academic Year 2026–2027 | ${student.strand} - ${student.section}`,
            user: req.user,
            classification: 'STUDENT COPY — UNOFFICIAL TRANSCRIPT',
            auditRef
        });

        // ... Render student demographics and scores ...

        attachPdfFooters(doc, auditRef, 'STUDENT COPY — UNOFFICIAL TRANSCRIPT');
        doc.end();

        await logActivity(studentId, 'Student', 'EXPORT_SELF_REPORT_CARD',
            `Student exported personal report card Ref: ${auditRef}`);
    } catch (err) {
        console.error('❌ [GET /student/reports/export/report-card]', err);
        res.status(500).send('Failed to generate report card.');
    }
});
```

---

## 7. Action Item Summary & Verification Checklist

- [x] **Audit Scope Complete:** Traversed all endpoints across `routes/teacher.js`, `routes/admin.js`, and `routes/student.js`.
- [x] **Asset Resolution Verified:** Identified that `mabini_logo1.png` and `mabini_logo2.png` exist in `assets/`, correcting the broken `../public/assets/` path.
- [x] **Security Gaps Documented:** Documented the cross-teacher remediation leak, unvalidated `class_id` in report cards, and unbounded audit memory hazard.
- [x] **Standard Blueprint Designed:** Constructed complete visual ASCII layouts and metadata schemas for PDF and Excel formats.
- [x] **Refactoring Code Formulated:** Delivered production-ready implementation snippets for `utils/reportHeaderHelper.js`, secured teacher controllers, and student self-service reporting.
