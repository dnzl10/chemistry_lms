# Comprehensive System Audit Report: Elementa / Chemistry Arcade LMS

**Date of Audit:** August 11, 2026  
**Auditor:** Senior Full-Stack Auditor (AI Pair Programmer)  
**Scope:** 100% Full-Stack Scrutiny (Node.js/Express, MySQL Schema, EJS Views, Socket.IO, Static Assets, Environment Configs)  
**Target Workspace:** `chemistry_lms_backup`

---

## 1. Project Mapping & Architecture Overview

### Full Folder Structure (Tree View)
```
chemistry_lms_backup/
├── .env                                       # Environment secrets & credentials (DB, Email, Google OAuth, Gemini API)
├── .gitignore                                  # Git ignore specifications
├── app.js                                     # Express server entry point, Socket.IO setup, Auth & Static asset middleware
├── db.js                                      # mysql2 connection pool promise export
├── package.json / package-lock.json           # Node.js dependencies
├── chemistry_arcade_lms (newly...).sql        # Master MySQL Database DDL dump (~35 tables, triggers, views)
├── instruction.md                             # Comprehensive audit checklist & rules
├── audit_report.md                            # Comprehensive system audit findings report
│
├── routes/                                    # Express Backend API Routers
│   ├── admin.js                               # Admin dashboard & User Access Control (UAC) API (6,500+ lines)
│   ├── elementaRoutes.js                      # Arcade game API endpoints (sessions, attempts, clicks, telemetry)
│   ├── student.js                             # Student dashboard, profile, messaging, progress recalculation
│   ├── teacher.js                             # Teacher dashboard, question bank, class management, PDF report generation
│   └── teachertry.js                          # ⚠️ DUPLICATE / DRAFT version of teacher.js (4,250+ lines)
│
├── views/                                     # EJS View Templates
│   ├── admin/                                 # Admin UI (dashboard, UAC, academic, audit, qbank, etc.)
│   ├── arcade/                                # Web Arcade UI (game.ejs, game_proper.ejs, standby, welcome, guidelines)
│   ├── teacher/                               # Teacher UI (dashboard, question_bank, class_list, reports, forums)
│   │   ├── backupquestionbank.ejs             # ⚠️ Orphaned draft view
│   │   └── try.ejs                            # ⚠️ Orphaned draft view
│   ├── partials/                              # Reusable notification panels & UI headers
│   └── *.ejs                                  # Student & Auth views (login, profile, setup-profile, dashboard-student, etc.)
│
├── public/                                    # Static Web Assets (Publicly Accessible without Authentication)
│   ├── assets/                                # Logos & institutional images
│   ├── profile_uploads/                       # User profile pictures & subject thumbnails
│   ├── uploads/                               # Question bank media & choice images
│   └── sounds/                                # Audio files ⚠️ CRITICAL PUBLIC EXPOSURE LOCATION
│       ├── admin.js                           # 🚨 CRITICAL: 6,149-line backend source code exposed publicly!
│       ├── game_part1.ejs / setup-profile.ejs # 🚨 CRITICAL: EJS view templates exposed publicly!
│       └── report-card-*.pdf / class-list.pdf # 🚨 CRITICAL: Real student grade report PDFs exposed publicly!
│
├── scripts/                                   # Legacy / Utility Scripts
│   ├── pdf_class_list.py                      # ⚠️ Unused legacy Python PDF script
│   ├── pdf_header.py                          # ⚠️ Unused legacy Python PDF script
│   ├── pdf_profile_card.py                    # ⚠️ Unused legacy Python PDF script
│   └── pdf_report_card.py                     # ⚠️ Unused legacy Python PDF script
│
├── utils/                                     # Shared Node.js Utilities
│   ├── logger.js                              # Custom logger module
│   └── pdfLetterhead.js                       # PDFKit institutional header drawing helper
│
├── files/ & material_uploads/                 # Upload storage directories for forum attachments & learning materials
└── node_modules/                              # Installed npm dependencies
```

### Component Mapping & Data Flow Analysis
1. **Backend Server Engine:** Built using Node.js / Express (v5.2.1) connected to MySQL via `mysql2` connection pooling promise wrapper ([db.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/db.js)). Authentication uses `passport-google-oauth20` and `express-session`.
2. **Arcade Client Interface:** Web-based EJS arcade frontend views ([views/arcade/](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/views/arcade/)) interact with Express backend routes in [routes/elementaRoutes.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/elementaRoutes.js) and real-time Socket.IO events for live game sessions, item responses, and student telemetry. *(Note: Standalone Godot GDScript client files `.gd` are not stored inside this backup repository; game telemetry and UI flows are driven via web API endpoints and Socket.IO messages).*
3. **Database Schema:** Single MySQL database ([chemistry_arcade_lms (newly and updated without data).sql](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql)) containing 35+ tables managing LMS core entities (`users`, `classes`, `subjects`, `assessments`, `question_bank`) and game analytics (`elementa_game_sessions`, `elementa_level_runs`, `elementa_customer_attempts`, `elementa_element_clicks`, `active_sessions`).
4. **Parallel / Conflicting Systems Identified:**
   - **Exposed Source Code Copy:** Full copy of [routes/admin.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/admin.js) located inside `public/sounds/admin.js`.
   - **Parallel Backend Implementations:** [routes/teachertry.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/teachertry.js) (4,250 lines) is a redundant, unmaintained copy of [routes/teacher.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/teacher.js) (4,270 lines).
   - **Admin Invite Route Duplication:** `app.js` handles `POST /admin/invite` directly inserting into `users`, whereas `routes/admin.js` handles `POST /admin/uac/invite` inserting into `account_invitations`.
   - **PDF Generation Redundancy:** Legacy Python scripts (`scripts/pdf_*.py`) exist alongside active Node.js `PDFKit` implementations (`utils/pdfLetterhead.js`).

---

## 2. Comprehensive Audit Findings

### 🔴 CRITICAL (Could Cause Data Corruption, System Crash, Security Breach, or Student Lockout)

1. **[public/sounds/admin.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/public/sounds/admin.js), [public/sounds/report-card-*.pdf](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/public/sounds/report-card-1783084323282.pdf)**
   - **Description:** Sensitive backend source code (`admin.js` — 6,149 lines), EJS templates (`game_part1.ejs`, `setup-profile.ejs`), and confidential student report card PDFs containing student names, grades, and section data are stored inside `public/sounds/`.
   - **Why it's Critical:** Express serves `public/` statically via `app.use(express.static('public'))` in [app.js:L137](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/app.js#L137). ANY unauthenticated user on the internet can read sensitive backend logic, database queries, and confidential student performance records via direct browser URL requests without logging in.

2. **[.env](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/.env#L7-L14)**
   - **Description:** Plain-text production credentials, including Google OAuth Client Secret (`GOOGLE_CLIENT_SECRET`), Google OAuth Client ID, Gmail SMTP App Password (`EMAIL_PASS`), and Google Gemini API Key (`GEMINI_API_KEY`), are stored directly in the root `.env` file without placeholder templates.
   - **Why it's Critical:** Hardcoded credentials allow malicious actors to compromise institutional email servers, steal API quotas, or manipulate Google OAuth credentials if the codebase is exposed or shared.

3. **[chemistry_arcade_lms...sql:L826](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql#L826)**
   - **Description:** The `active_sessions` database table includes a global `ADD UNIQUE KEY student_id (student_id)` constraint.
   - **Why it's Critical:** This constraint limits a student to only 1 row in `active_sessions` for the lifetime of their account. Once a row is created, any subsequent session creation attempt throws an `ER_DUP_ENTRY` database error, permanently locking students out from taking assessments or launching arcade games.

4. **[app.js:L75-L80](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/app.js#L75-L80) & [routes/student.js:L94](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/student.js#L94)**
   - **Description:** When a student closes their browser tab or suffers a network drop, Socket.IO disconnect fires in `app.js` and removes `activeSockets[id]` in memory, but fails to update `active_sessions` or `elementa_game_sessions` status in MySQL.
   - **Why it's Critical:** Session rows remain stuck in `'Ongoing'` state indefinitely, causing database bloat and preventing re-entry due to leftover session guards.

5. **[app.js:L188-L265](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/app.js#L188-L265) vs [routes/admin.js:L470-L635](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/admin.js#L470-L635)**
   - **Description:** Dual conflicting invitation handling implementations. `app.js` routes `POST /admin/invite` by directly creating incomplete records in `users` with dummy values, while `routes/admin.js` handles `POST /admin/uac/invite` by writing tokens into `account_invitations`.
   - **Why it's Critical:** Mounting both routers creates conflicting endpoints, leading to broken invitation links, failed user registrations, and corrupted user profiles.

---

### 🟠 HIGH (Functional Bugs Affecting Core Features & Data Integrity)

1. **[routes/teachertry.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/teachertry.js#L1-L4252)**
   - **Description:** A 4,250-line duplicate draft router file (`teachertry.js`) exists alongside `teacher.js`.
   - **Impact:** High technical debt and risk of importing or modifying the wrong file, leading to silent bugs and out-of-sync route handlers.

2. **[chemistry_arcade_lms...sql:L1332-L1538](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql#L1332-L1538)**
   - **Description:** Foreign key constraints between child tables (`student_scores`, `calendar_events`, `learning_materials`, `announcements`) and parent tables (`users`, `subjects`, `assessments`, `classes`) omit `ON DELETE CASCADE` or `ON DELETE SET NULL`.
   - **Impact:** Deleting a user, class, or assessment fails with MySQL `ER_ROW_IS_REFERENCED_2` foreign key errors or leaves orphaned child records.

3. **[app.js:L150-L154](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/app.js#L150-L154)**
   - **Description:** `express-session` uses default `MemoryStore` without a persistent store like `express-mysql-session`.
   - **Impact:** All active user sessions are destroyed whenever the server restarts, and high concurrent user traffic leads to server memory leaks.

4. **[chemistry_arcade_lms...sql:L627-L637](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql#L627-L637)**
   - **Description:** The database trigger `update_total_exp` blindly adds `NEW.exp_gained` to `users.total_exp` on every `INSERT` into `student_scores`.
   - **Impact:** Retaking or re-submitting an assessment repeatedly adds EXP to a student's total, causing extreme XP inflation on leaderboards.

5. **[routes/elementaRoutes.js:L200-L222](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/elementaRoutes.js#L200-L222)**
   - **Description:** `elementa_game_sessions` permits `class_id` to be `NULL`.
   - **Impact:** Arcade sessions launched without explicitly specifying a `class_id` are excluded from analytics database views (`v_elementa_student_accuracy`), breaking teacher dashboard reporting.

---

### 🟡 MEDIUM (Code Quality, Maintainability & Edge Case Failures)

1. **[profile_pics/04 Case Analysis.pdf](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/profile_pics/04%20Case%20Analysis.pdf)**
   - **Description:** An academic PDF document (`04 Case Analysis.pdf`) is misplaced inside `profile_pics/`, which is statically served at `/profile_uploads`.
   - **Impact:** Clutters profile picture directories and exposes arbitrary files over static routes.

2. **[scripts/pdf_class_list.py](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/scripts/pdf_class_list.py)**
   - **Description:** Legacy Python scripts (`pdf_class_list.py`, `pdf_header.py`, `pdf_profile_card.py`, `pdf_report_card.py`) reside in `scripts/` but are never executed by Node.js.
   - **Impact:** Obsolete codebase clutter; Express handles PDF rendering natively via `PDFKit` ([utils/pdfLetterhead.js](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/utils/pdfLetterhead.js)).

3. **[views/arcade/game.ejs:L27](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/views/arcade/game.ejs#L27)**
   - **Description:** Howler sound objects are instantiated and played immediately on page load without checking browser user-gesture restrictions.
   - **Impact:** Autoplay policy errors in Chrome/Edge cause uncaught console exceptions and muted audio playback.

4. **[routes/student.js:L115-L277](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/student.js#L115-L277)**
   - **Description:** `GET /dashboard` executes 8 parallel database queries containing multiple `UNION ALL` statements and unindexed `COALESCE` filters.
   - **Impact:** High database server query load and slow dashboard response times during concurrent class access.

5. **[chemistry_arcade_lms...sql:L871-L875](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql#L871-L875)**
   - **Description:** Table `button_mappings` lacks a composite index on `(button_pin, player_side)`.
   - **Impact:** Arcade hardware input mapping lookups perform full table scans during input events.

---

### 🟢 LOW (Style, Naming, & Minor Code Hygiene)

1. **[app.js:L141](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/app.js#L141)**
   - **Description:** `module.exports = { forumUpload, uploadProfile };` is placed in the middle of `app.js` (line 141) prior to route definitions and HTTP server initialization.
   - **Impact:** Non-standard module structure that can cause confusion during maintenance.

2. **[views/teacher/try.ejs](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/views/teacher/try.ejs) & [views/teacher/backupquestionbank.ejs](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/views/teacher/backupquestionbank.ejs)**
   - **Description:** Orphaned backup and test view templates remain in `views/teacher/`.
   - **Impact:** View directory bloat and potential confusion for frontend developers.

3. **[routes/admin.js:L67-L68](file:///c:/Users/althe/OneDrive/Videos/chemistry_lms_backup%20-%20Copy/routes/admin.js#L67-L68)**
   - **Description:** Inconsistent hex token string lengths across routers (`generateQRToken` produces 32-byte hex strings, `generateInviteToken` produces 24-byte hex strings, `app.js` generates 16-byte hex strings).
   - **Impact:** Minor inconsistency in database string length expectations and security margin uniformness.

---

## 3. Recommended Remediation Roadmap

1. **Phase 1 (Security & System Lockout Prevention):**
   - **Remove Exposed Sensitive Static Files:** Instantly delete `public/sounds/admin.js`, public EJS files, and confidential student PDFs from `public/sounds/`.
   - **Environment Variable Protection:** Clean `.env` of hardcoded production secrets and establish an `.env.example` template.
   - **Database Constraint Repair:** Drop the global `UNIQUE` constraint on `active_sessions.student_id` and replace with a composite or status-aware condition (`student_id`, `assessment_id`, `session_status`).
   - **Socket Disconnect Handler:** Update Socket.IO disconnect listener to clean up database state (`active_sessions` & `elementa_game_sessions`).
   - **Admin Invite Consolidation:** Deprecate the legacy `POST /admin/invite` route in `app.js` and standardize on `routes/admin.js`.

2. **Phase 2 (Data Integrity & Foreign Keys):**
   - **Add Missing Foreign Key Cascade Rules:** Update DDL constraints with `ON DELETE CASCADE` across LMS core tables.
   - **XP Inflation Prevention:** Fix `update_total_exp` database trigger logic or enforce composite uniqueness on `(student_id, assessment_id)`.
   - **Mandatory Class ID Propagation:** Enforce non-null `class_id` validation in `routes/elementaRoutes.js` session start endpoints.

3. **Phase 3 (Technical Debt & Performance Cleanup):**
   - **File System Cleanup:** Delete `routes/teachertry.js`, legacy `scripts/pdf_*.py`, and orphan views (`try.ejs`, `backupquestionbank.ejs`).
   - **Persistent Session Store:** Transition `express-session` to `express-mysql-session`.
   - **Dashboard Query Optimization:** Refactor student dashboard SQL queries with proper composite indexing.
