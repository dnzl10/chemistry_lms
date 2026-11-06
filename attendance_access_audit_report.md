# Comprehensive Attendance Monitoring & Access Tracking Technical Audit Report

**Application:** Elementa — Chemistry Arcade & Learning Management System (LMS)  
**Target Codebase:** Express.js, MariaDB/MySQL (`chemistry_arcade_lms`), Passport.js, Socket.IO, EJS Views  
**Date of Audit:** September 9, 2026  
**Auditor:** Senior Full-Stack Architect & LMS Technical Auditor  
**Audit Standard:** ISO/IEC 27001 (Access Control & Logging), DepEd Order No. 8 s. 2015 (Learner Attendance & Form 2), OWASP ASVS v4.0 (Authentication & Session Management)

---

## Executive Summary

An exhaustive, end-to-end technical audit of the Elementa codebase, database schema, and architectural assets was conducted to map out the **CURRENT** state of attendance monitoring, session tracking, and user access control across the **STUDENT**, **TEACHER**, and **ADMIN** roles.

### Core Audit Verdict: Architectural Disconnect Between Access Control and Attendance

| Assessment Dimension | Current Implementation Status | Compliance / Technical Risk Level |
| :--- | :--- | :--- |
| **Authentication & Session Control** | Implemented (Local + Google OAuth + Single Active Session Enforcement) | 🟡 **MODERATE RISK** (Suspension bypass in session, unauthenticated `/logout`) |
| **Attendance Capture Engine** | **NON-EXISTENT** (Zero attendance tables, routes, or check-in models) | 🔴 **CRITICAL GAP** (No attendance mechanism exists in LMS) |
| **Teacher Attendance Management** | **DECEPTIVE / PSEUDO-FEATURE** ("Class List & Attendance Summary" is an enrollment roster) | 🔴 **CRITICAL GAP** (Zero marking, zero status overrides, zero date filtering) |
| **Hardware & Kiosk Telemetry** | **DORMANT TOKENS ONLY** (`qr_code_token` generated but zero scanning endpoints exist) | 🔴 **CRITICAL GAP** (No kiosk, camera, RFID, or station binding) |
| **Admin Audit Trail** | Partial (`activity_logs` logs action & actor, but lacks IP, User-Agent, & Session ID) | 🟠 **HIGH RISK** (Non-compliant with cyber audit standards) |

While the application features well-engineered defenses against **concurrent account sharing** (via `users.current_session_id`) and **session fixation** (via `req.session.regenerate`), **it possesses NO operational attendance monitoring system**. Attendance is conflated with basic class enrollment rosters (`class_students`), while live session telemetry (`active_sessions`) is orphaned and never written to by client flows.

---

## Section A: Role-by-Role Workflow Map

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 CURRENT SYSTEM ACCESS WORKFLOW                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

   [STUDENT]                             [TEACHER]                             [ADMIN]
       │                                     │                                    │
       ├─► 1. Login (/login)                 ├─► 1. Login (/login)                ├─► 1. Login (/login)
       │   - Email + Password / Google       │   - Email + Password / Google      │   - Email + Password / Google
       │   - Rate limited (5 / 15 min)       │   - Sets current_session_id        │   - Sets current_session_id
       │   - Sets users.current_session_id   │   - Redirects /teacher/dashboard   │   - Redirects /admin/dashboard
       │   - Activity log: LOGIN_SUCCESS     │                                    │
       │                                     ├─► 2. View Reports                  ├─► 2. User Access Control (/admin/uac)
       ├─► 2. Dashboard (/dashboard)         │   - /teacher/reports               │   - Suspend/Activate users
       │   - Socket.IO connection            │   - Clicks "Class List &           │   - Reset QR tokens
       │   - emit('register-player')         │     Attendance Summary"            │   - Unlink Google accounts
       │   - In-memory activeSockets{}       │   - Export PDF/Excel:              │
       │                                     │     * Extracts roster only!        ├─► 3. Audit Logs (/admin/system_audit)
       ├─► 3. Material Interaction           │     * ZERO attendance data         │   - Filter activity_logs by role/action
       │   - POST /api/materials/:id/        │                                    │   - Export to Excel (.xlsx)
       │     interact                        ├─► 3. Live Sessions                 │   - Lacks IP, device, session ID
       │   - Logs to student_material_       │   - GET /api/live-sessions/:id     │
       │     interactions                    │   - Queries active_sessions        └─► 4. Global Stats (/admin/dashboard)
       │   - Updates student_progress        │   - Returns EMPTY (table unwritten)    - Active sessions count (always 0)
       │                                     │
       └─► 4. Logout (/logout)               └─► 4. Logout (/logout)
           - req.logout()                        - req.logout()
           - DOES NOT clear current_session_id   - DOES NOT clear current_session_id
           - DOES NOT log to activity_logs       - DOES NOT log to activity_logs
```

### 1. Student Perspective: Access & Activity Telemetry

#### Step 1: Ingress & Authentication
1. **Entry Gate:** Students arrive at [`GET /login`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L557).
2. **Credential Processing:**
   * Local authentication via [`POST /login`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L582): Uses `express-rate-limit` (5 requests / 15 minutes by email key), `bcrypt.compare()` with dummy-hash timing attack mitigation, and checks `user.is_active === 1` and `user.is_suspended === 0`.
   * Google OAuth 2.0 via [`GET /auth/google`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L517): Requires a pre-existing email in the `users` table created via Admin invitation.
3. **Session Genesis:**
   * Calls `req.session.regenerate()` (mitigating session fixation).
   * Generates Express session cookie `connect.sid` with `maxAge: 30 minutes` sliding window.
   * Records absolute session start in `req.session.createdAt = Date.now()`.
   * Updates database column [`users.current_session_id = req.sessionID`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L635).
   * Inserts an audit log record in `activity_logs` with action `'LOGIN_SUCCESS'`.

#### Step 2: Session Enforcing & Gatekeeping
* On every subsequent HTTP request to any student route (`/dashboard`, `/opensubject`, `/forum`), [`middleware/auth.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/middleware/auth.js#L3) executes:
  1. Checks `req.isAuthenticated()`.
  2. Absolute Timeout: If `Date.now() - req.session.createdAt > 12 hours`, destroys session and redirects to `/login`.
  3. Concurrent Access Defense: Compares `req.user.current_session_id` against `req.sessionID`. If mismatched (because the student logged in on another device), the older session is destroyed and ejected.

#### Step 3: Real-Time Socket Connection & Arcade Presence
* When the student lands on the dashboard or game pages, client-side scripts establish a Socket.IO connection to `app.js`.
* Client emits `socket.emit('register-player', studentId)`.
* Server assigns `activeSockets[studentId] = socket.id` in a transient Node.js in-memory dictionary.
* **Flaw:** This registration is completely volatile. It does not update MariaDB, does not verify whether `studentId` matches the authenticated session user, and disappears upon server restart.

#### Step 4: Activity & Learning Material Triggers
* **Material Viewing/Download:** Triggered when a student accesses a resource via [`POST /api/materials/:id/interact`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/student.js#L1807). This inserts a row into `student_material_interactions` with `interaction_type = 'viewed' | 'downloaded'` and recalculates `student_progress.progress_percent`.
* **Assessment Execution:** When a quiz/test is submitted, rows are inserted into `student_scores` and `student_responses`.
* **Disconnection / Egress:**
  * If the student closes the browser tab: The Socket.IO connection drops, deleting `activeSockets[studentId]` in RAM. **No database disconnect event or time-out is recorded.**
  * If the student clicks "Logout" ([`GET /logout`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L682)): `req.logout()` is called and redirects to `/login`. **The database column `users.current_session_id` is NOT cleared, and NO `LOGOUT` audit log is written.**

---

### 2. Teacher Perspective: Monitoring & Management

#### Step 1: Instructor Dashboard Inspection
* Teachers access [`GET /teacher/dashboard`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L356) protected by `isTeacher` middleware.
* The dashboard displays aggregate statistics: enrolled students count, total assessments, total forum topics, and class breakdown. **There is NO attendance KPI, NO daily present count, and NO absent student alerts.**

#### Step 2: Inspection of the Pseudo "Attendance Summary"
* Teachers navigate to [`GET /teacher/reports`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L4112).
* In Tab 1 ("Export Hub"), Card A is prominently labeled:
  ```html
  <p class="text-sm font-black text-indigo-900">Class List & Attendance Summary</p>
  <p class="text-[11px] text-slate-400 mt-0.5 leading-relaxed max-w-lg">
      Master list with LRN Number, Full Name, Sex, Strand, and Section. Use PDF for formal printing or Excel for editing.
  </p>
  ```
* When the teacher clicks the **PDF** or **Excel** export buttons, the system calls:
  * [`GET /teacher/reports/export/class-list/pdf`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L4540)
  * [`GET /teacher/reports/export/class-list/excel`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L4653)
* **Code Reality:** The backend queries `users u JOIN class_students cs JOIN classes c` and prints columns: `#`, `LRN Number`, `Last Name`, `First Name`, `Middle Name`, `Sex`, `Grade Level`, `Strand`, `Section`, `Class / Subject`.
* **Zero Attendance Data:** There are no dates, no attendance statuses, no timestamps, and no check-in records. It is solely an enrollment masterlist.

#### Step 3: Live Session Monitoring (Dead Circuit)
* Teachers can view live student assessment status inside [`views/teacher/class-view.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/teacher/class-view.ejs), which polls [`GET /teacher/api/live-sessions/:classId`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L1650).
* The route executes:
  ```sql
  SELECT acs.session_id, acs.player_mode, acs.current_item_index, acs.accumulated_score, 
         acs.session_status, acs.start_time, u.first_name, u.last_name, a.assessment_name
  FROM active_sessions acs
  JOIN users u ON acs.student_id = u.user_id
  JOIN assessments a ON acs.assessment_id = a.assessment_id
  JOIN class_students cs ON u.user_id = cs.student_id
  WHERE cs.class_id = ? AND acs.session_status = 'Ongoing'
  ```
* **Audit Finding:** The query **permanently returns an empty array `[]`** because no route in `routes/student.js` or `routes/elementaRoutes.js` ever inserts into `active_sessions`. Teachers are looking at a permanent zero-state dashboard.

---

### 3. Admin Perspective: Oversight, Audit, & System Controls

#### Step 1: User & Access Control Management
* Administrators access [`views/admin/user_access_control.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/admin/user_access_control.ejs) via [`GET /admin/uac`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js).
* Controls available per user:
  1. **Account Suspension & Deactivation:** Triggered via [`POST /admin/users/:id/toggle-status`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js#L453) (`suspend`, `activate_suspension`, `deactivate`, `activate`). Sets `is_suspended = 1` or `is_active = 0`.
  2. **QR Code Token Invalidation:** Triggered via [`POST /admin/uac/users/:id/reset-qr`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js#L1239). Generates 32 random bytes, updates `users.qr_code_token`, and logs `RESET_QR` in `activity_logs`.
  3. **Google OAuth Disconnect:** Clears `users.google_id` via [`POST /admin/uac/users/:id/unlink-google`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js).
  4. **Password Reset Initiation:** Generates a 1-hour reset token and emails the student/teacher via Nodemailer.

#### Step 2: System Audit Log Inspection
* Admins navigate to [`GET /admin/system_audit`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js#L6662).
* UI presents paginated table (50 per page), dynamic date filters (`from`, `to`), role filters (`Admin`, `Teacher`, `Student`), and full-text action search.
* Full log export is available via [`GET /admin/system_audit/export`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js#L7075), generating an Excel workbook (`audit_log_YYYY-MM-DD.xlsx`).
* **Audit Deficiency:** The exported columns are strictly: `Log ID`, `Actor Name`, `Actor Role`, `Action`, `Description`, `Date & Time`. Zero network metadata or terminal identifiers are recorded.

---

## Section B: File & Component Inventory

| File / Component Path | Primary Responsibility | Attendance & Access Functionality |
| :--- | :--- | :--- |
| [`app.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js) | Server Ingress & Auth Gate | Configures session store (30-min idle cookie), Passport serialization, Google OAuth 2.0, `/login` rate limiter, concurrent session conflict detection, and volatile `activeSockets` tracker. |
| [`middleware/auth.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/middleware/auth.js) | Session Guard & Access Control | Enforces `ensureAuthenticated`: checks 12-hr absolute expiration (`MAX_LIFETIME`) and validates `users.current_session_id === req.sessionID`. Defines `requireRole()`. |
| [`utils/logger.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/utils/logger.js) | Shared Activity Logger | Asynchronously inserts into `activity_logs` (`actor_id`, `actor_role`, `action`, `description`). Omits IP, User-Agent, and session telemetry. |
| [`routes/admin.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js) | Admin Command & Audit Router | Handles `/admin/system_audit` log inspection, `/admin/system_audit/export` Excel generation, account lifecycle toggling (`/users/:id/toggle-status`), and QR token invalidation (`/uac/users/:id/reset-qr`). |
| [`views/admin/user_access_control.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/admin/user_access_control.ejs) | Admin Access Control UI | Interface for suspending/activating accounts, generating invitation tokens, resetting passwords, and regenerating student QR tokens. |
| [`views/admin/system_audit.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/admin/system_audit.ejs) | System-Wide Audit Log View | Tabulated view of `activity_logs` with role filters, time charts, and action type breakdowns. |
| [`routes/teacher.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js) | Teacher Portal Router | Handles class management, student roster retrieval, PDF/Excel class list export, and polls orphaned `active_sessions` table. |
| [`views/teacher/reports.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/teacher/reports.ejs) | Teacher Analytics & Export Hub | Contains the mislabeled "Class List & Attendance Summary" card and export buttons. |
| [`routes/student.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/student.js) | Student Learning Router | Logs learning material interactions (`POST /api/materials/:id/interact`), renders profile with QR token display, and handles assessment submissions. |
| [`views/profile.ejs`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/views/profile.ejs) | Student Profile View | Displays the student's unique QR code generated from `users.qr_code_token`. |
| [`routes/elementaRoutes.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/elementaRoutes.js) | Godot Arcade REST API | Unauthenticated endpoints for `/session/start`, `/session/end`, and gameplay telemetry logging into `elementa_game_sessions`. |

---

## Section C: Database Model Evaluation

The database schema DDL [`chemistry_arcade_lms (newly and updated without data).sql`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/chemistry_arcade_lms%20%28newly%20and%20updated%20without%20data%29.sql) was audited across all 53 tables.

```
                               ┌──────────────────────────┐
                               │          users           │
                               ├──────────────────────────┤
                               │ user_id (PK)             │
                               │ email                    │
                               │ qr_code_token (UNIQUE)   │
                               │ current_session_id       │
                               │ is_active, is_suspended │
                               └────────────┬─────────────┘
                                            │
               ┌────────────────────────────┼───────────────────────────┐
               │ 1:N                        │ 1:N                       │ 1:N
               ▼                            ▼                           ▼
 ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
 │      activity_logs       │ │      class_students      │ │student_material_interact.│
 ├──────────────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
 │ log_id (PK)              │ │ class_id (FK -> classes) │ │ interaction_id (PK)      │
 │ actor_id (FK -> users)   │ │ student_id (FK -> users) │ │ student_id (FK -> users) │
 │ actor_role               │ │ sy_id (FK -> school_yrs) │ │ material_id (FK -> mat.) │
 │ action                   │ └─────────────┬────────────┘ │ interaction_type         │
 │ description              │               │ N:1          │ interacted_at            │
 │ created_at               │               ▼              └──────────────────────────┘
 └──────────────────────────┘ ┌──────────────────────────┐
                              │         classes          │
                              ├──────────────────────────┤
                              │ class_id (PK)            │
                              │ class_name               │
                              │ teacher_id (FK -> users) │
                              │ subject_id (FK -> subj.) │
                              └──────────────────────────┘
```

### Evaluation of Active Tables Relevant to Access & Attendance

#### 1. `users` Table
* **Active Columns:** `user_id`, `email`, `password_hash`, `role`, `is_active`, `is_suspended`, `qr_code_token`, `current_session_id`, `created_at`.
* **Strengths:** 
  * `current_session_id` enables single-session enforcement across devices.
  * `qr_code_token` has a unique constraint `UNIQUE KEY (qr_code_token)`, preventing token overlap.
* **Flaws:**
  * No `last_login_at` or `last_logout_at` timestamp columns.
  * No `failed_login_attempts` counter or `lockout_until` timestamp (rate-limiting is currently done in Node memory via `express-rate-limit`, which resets on server restart).

#### 2. `activity_logs` Table
* **Active Columns:** `log_id` (PK, INT AUTO_INCREMENT), `actor_id` (INT NULL, FK to `users`), `actor_role` (ENUM `'Admin'`, `'Teacher'`, `'Student'`), `action` (VARCHAR 100), `description` (TEXT), `created_at` (TIMESTAMP).
* **Missing Essential Audit Attributes:**
  * `ip_address` (VARCHAR 45) — completely absent.
  * `user_agent` (VARCHAR 255) — completely absent.
  * `session_id` (VARCHAR 255) — completely absent.
  * `terminal_id` or `device_fingerprint` — completely absent.

#### 3. `student_material_interactions` & `student_progress`
* **Columns:** `interaction_id`, `student_id`, `material_id`, `interaction_type` (`'viewed'`, `'downloaded'`), `interacted_at`.
* **Evaluation:** Can serve as indirect proof of asynchronous student engagement, but does not capture session duration, active screen time, or daily presence.

#### 4. `active_sessions` (Orphaned Table)
* **Columns:** `session_id`, `student_id` (FK), `assessment_id` (FK), `player_mode`, `current_item_index`, `accumulated_score`, `session_status`, `start_time`.
* **Evaluation:** Completely abandoned. No route executes `INSERT INTO active_sessions`. The teacher monitoring endpoint querying this table is dead code.

#### 5. `attendance_records` Table
* **STATUS: MISSING FROM SCHEMA ENTIRELY.**
* The database contains **ZERO tables** for recording daily attendance, subject attendance, check-in timestamps, check-out timestamps, attendance status (`Present`, `Late`, `Absent`, `Excused`), or teacher verification notes.

---

## Section D: Gap Analysis & Vulnerabilities

### Critical Security Vulnerabilities

#### VULN-01: In-Flight Session Hijacking Post-Suspension
* **Mechanism:** When an administrator toggles an account to `is_suspended = 1` or `is_active = 0` via [`/admin/users/:id/toggle-status`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/admin.js#L453), the database is updated, but **the user's active session is never invalidated or terminated**.
* **Flaw Location:** [`middleware/auth.js:3-24`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/middleware/auth.js#L3). The middleware only checks `req.isAuthenticated()`, `req.session.createdAt`, and `user.current_session_id !== req.sessionID`. It **NEVER checks `req.user.is_suspended` or `req.user.is_active`**.
* **Impact:** A suspended student or terminated teacher who already has an active browser session can continue browsing, downloading course files, posting in forums, or submitting grades until the 12-hour session window expires.

#### VULN-02: Silent Unauthenticated Logout & Session Leaks
* **Mechanism:** In [`app.js:682-687`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js#L682):
  ```javascript
  app.get('/logout', (req, res, next) => {
      req.logout((err) => {
          if (err) return next(err);
          res.redirect('/login');
      });
  });
  ```
* **Flaw:** 
  1. `req.session.destroy()` is NOT called.
  2. `users.current_session_id` is NOT set to `NULL` in the database.
  3. No `LOGOUT` audit log is inserted into `activity_logs`.
* **Impact:** If a student on a shared or kiosk terminal clicks logout, their session token is not destroyed in the session store, leaving their account vulnerable to session fixation and kiosk hijacking by the next terminal user.

#### VULN-03: Unauthenticated Arcade API & Telemetry Forgery
* **Mechanism:** [`routes/elementaRoutes.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/elementaRoutes.js) mounts all game session endpoints without any authentication middleware (`ensureAuthenticated` or API key validation).
* **Flaw:** Any user or script can execute `POST /api/elementa/session/start` or `POST /api/elementa/session/end` passing arbitrary `student_id_p1`, `final_score_p1`, and `total_duration_s`.
* **Impact:** Any student can fake hours of arcade attendance and inject false high scores or game completion data into teacher gradebooks without ever playing the game.

---

### Functional & Operational Gaps

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 FUNCTIONAL GAP SCORECARD                                         │
├────────────────────────────────┬────────────────────────────┬────────────────────────────────────┤
│ Required Capability            │ Current Status             │ Technical Assessment               │
├────────────────────────────────┼────────────────────────────┼────────────────────────────────────┤
│ QR Code Station Check-In       │ ❌ Dormant Token Only      │ Token displayed; zero reader routes│
│ Daily / Class Roll Call        │ ❌ Missing Completely      │ No attendance table or teacher UI  │
│ Teacher Status Overrides       │ ❌ Missing Completely      │ Cannot mark Late/Excused/Absent    │
│ Attendance Analytics / DepEd   │ ❌ Misleading Label        │ Reports export simple class roster │
│ Hardware / Kiosk Binding       │ ❌ Missing Completely      │ No terminal ID or MAC verification │
│ Session Duration Tracking      │ ❌ Missing Completely      │ No login/logout time diff computed │
│ Network Telemetry Audit        │ ❌ Incomplete Audit Trail  │ activity_logs lacks IP & UserAgent │
└────────────────────────────────┴────────────────────────────┴────────────────────────────────────┘
```

1. **Student-Side Gaps:**
   * **Dormant QR Token Generation:** `users.qr_code_token` is generated on registration and displayed on `profile.ejs`, but there is **no scanner interface, camera endpoint, or kiosk endpoint** anywhere in the system to accept or validate this token.
   * **No Presence Proof:** The system has no concept of being "in class." A student could be logged in for 8 hours without touching a course module, yet the system has no idle detection or activity heartbeat to verify attentiveness.
2. **Teacher-Side Gaps:**
   * **Mislabeled Roster Export:** The "Class List & Attendance Summary" in `reports.ejs` generates a blank roster with student demographic fields. It provides zero DepEd School Form 2 (SF2) attendance tracking data.
   * **No Manual Attendance Overrides:** Teachers cannot excuse an absence, record a tardy slip, or adjust a student's attendance record.
   * **Dead Real-Time Sessions Widget:** The live session tracking widget relies on an unpopulated table (`active_sessions`).
3. **Admin-Side Gaps:**
   * **No Hardware / Terminal Registration:** No management of physical kiosk stations, classroom lab terminals, or approved IP ranges.
   * **Audit Blindness:** The `activity_logs` table does not capture IP addresses, User-Agent strings, or HTTP request paths, making forensic tracing of account hijacking or proxy attendance impossible.

---

## Section E: Recommended Action Plan

To transition Elementa from its current state to an **enterprise-grade, DepEd-compliant LMS attendance tracking and access control platform**, execute the following structured implementation phases:

### Phase 1: Database Architecture Overhaul (Mandatory DDL)

Create an official `attendance_records` table and a `kiosk_terminals` table in MariaDB:

```sql
-- 1. Create Dedicated Attendance Records Table
CREATE TABLE `attendance_records` (
  `attendance_id` INT(11) NOT NULL AUTO_INCREMENT,
  `student_id` INT(11) NOT NULL,
  `class_id` INT(11) NOT NULL,
  `session_date` DATE NOT NULL,
  `check_in_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `check_out_time` DATETIME DEFAULT NULL,
  `status` ENUM('Present', 'Late', 'Absent', 'Excused') NOT NULL DEFAULT 'Present',
  `attendance_method` ENUM('QR_Scan', 'Kiosk', 'Manual_Teacher', 'System_Activity') NOT NULL DEFAULT 'QR_Scan',
  `terminal_id` INT(11) DEFAULT NULL,
  `teacher_id` INT(11) DEFAULT NULL COMMENT 'ID of teacher if manually marked/overridden',
  `override_reason` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`attendance_id`),
  UNIQUE KEY `uniq_student_class_date` (`student_id`, `class_id`, `session_date`),
  KEY `idx_class_date` (`class_id`, `session_date`),
  CONSTRAINT `fk_att_student` FOREIGN KEY (`student_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_att_class` FOREIGN KEY (`class_id`) REFERENCES `classes` (`class_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 2. Create Authorized Kiosk / Station Registry
CREATE TABLE `kiosk_terminals` (
  `terminal_id` INT(11) NOT NULL AUTO_INCREMENT,
  `terminal_code` VARCHAR(50) NOT NULL UNIQUE,
  `terminal_name` VARCHAR(100) NOT NULL,
  `room_location` VARCHAR(100) NOT NULL,
  `ip_whitelist` VARCHAR(255) DEFAULT NULL,
  `api_secret_key` VARCHAR(255) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `last_heartbeat` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`terminal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. Upgrade Audit Logs to Capture Network Telemetry
ALTER TABLE `activity_logs`
  ADD COLUMN `ip_address` VARCHAR(45) NULL AFTER `actor_role`,
  ADD COLUMN `user_agent` VARCHAR(255) NULL AFTER `ip_address`,
  ADD COLUMN `session_id` VARCHAR(255) NULL AFTER `user_agent`;
```

---

### Phase 2: Security & Middleware Remediation

#### 1. Fix Session Middleware ([`middleware/auth.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/middleware/auth.js))
Enforce real-time account status verification on every request:
```javascript
// Add immediate check for suspended or deactivated accounts
if (Number(req.user.is_active) === 0 || Number(req.user.is_suspended) === 1) {
    return req.logout(() => {
        req.session.destroy();
        res.redirect('/login?error=' + encodeURIComponent('Your account has been deactivated or suspended.'));
    });
}
```

#### 2. Fix Logout Cleanup ([`app.js`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/app.js))
Ensure full database state cleanup and audit logging upon logout:
```javascript
app.get('/logout', async (req, res, next) => {
    if (req.user) {
        await db.query("UPDATE users SET current_session_id = NULL WHERE user_id = ?", [req.user.user_id]);
        logActivity(req, 'LOGOUT_SUCCESS', `User ${req.user.email} logged out.`, req.user.user_id, req.user.role).catch(()=>{});
    }
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.redirect('/login');
        });
    });
});
```

#### 3. Enrich `utils/logger.js` with Client Telemetry
```javascript
async function logActivity(req, action, description = null, overrideActorId = null, overrideActorRole = null) {
    try {
        const actorId   = overrideActorId || req.user?.user_id || null;
        const actorRole = overrideActorRole || req.user?.role  || 'Student';
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        const userAgent = (req.headers['user-agent'] || '').slice(0, 255);
        const sessionId = req.sessionID || null;

        await db.query(
            `INSERT INTO activity_logs (actor_id, actor_role, ip_address, user_agent, session_id, action, description)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [actorId, actorRole, ipAddress, userAgent, sessionId, action, description]
        );
    } catch (_) {}
}
```

---

### Phase 3: QR Scanner & Physical Kiosk Implementation

1. **Station Kiosk API (`POST /api/kiosk/check-in`):**
   * Endpoint accepts `{ qr_token, class_id, terminal_secret }`.
   * Verifies `kiosk_terminals.api_secret_key` and checks terminal IP against `ip_whitelist`.
   * Resolves student by `users.qr_code_token`.
   * Verifies enrollment via `class_students`.
   * Inserts or updates `attendance_records` for today (`session_date = CURDATE()`).
   * Broadcasts real-time attendance ping via Socket.IO to the teacher's classroom view:
     ```javascript
     io.to(`class_${classId}`).emit('student-checked-in', {
         student_id: user.user_id,
         student_name: `${user.first_name} ${user.last_name}`,
         timestamp: new Date()
     });
     ```
2. **Webcam / Mobile QR Scanner UI (`views/teacher/attendance-scanner.ejs`):**
   * Integrate standard HTML5 camera scanner (`html5-qrcode` library) directly into the teacher's class view, allowing teachers to use their laptop camera or tablet as a check-in station at the classroom door.

---

### Phase 4: Teacher Attendance Portal & DepEd Reporting

1. **Daily Attendance Grid (`/teacher/class/:id/attendance`):**
   * Interactive calendar / date picker allowing teachers to view present, late, absent, and excused students per class day.
   * Single-click toggle switches to change a student's status with an audit note modal.
2. **DepEd School Form 2 (SF2) Compliant Export:**
   * Upgrade [`routes/teacher.js:4540`](file:///c:/Users/althe/OneDrive/Videos/Antigravity%20platform/chemistry_lms_backup%20-%20Copy/routes/teacher.js#L4540) to export actual monthly attendance sheets:
     * Columns: Student Name, Days 1–31 status code (`P`, `A`, `L`, `E`), Total Days Absent, Total Days Present.
     * Complies with official Philippine Department of Education grading and reporting regulations.

---

### Phase 5: Arcade Telemetry Hardening (`routes/elementaRoutes.js`)

1. **Harden Arcade Endpoints:**
   * Require authenticated session cookie or HMAC station API key for `/api/elementa/session/start` and `/api/elementa/session/end`.
2. **Server-Side Session Time Calculation:**
   * Replace client-reported `total_duration_s` with `TIMESTAMPDIFF(SECOND, started_at, NOW())` executed directly in the database update statement to prevent cheating.
3. **Socket Disconnect Reaper:**
   * On Socket.IO `disconnect` in `app.js`, look up ongoing sessions for that student and mark them as `'Abandoned'` after a 3-minute grace period.

---

## Conclusion

The Elementa platform features solid foundations in **single-session enforcement** and **identity lifecycle handling**, but it currently **lacks an operational attendance engine**. The feature advertised to instructors as an "Attendance Summary" is actually a class enrollment roster, and the physical arcade check-in tokens (`qr_code_token`) are dormant.

By adopting the **Phase 1–5 Action Plan**—introducing the `attendance_records` model, patching session suspension bypasses, activating QR check-in endpoints, and outputting true monthly attendance registers—Elementa will provide an airtight, enterprise-grade attendance and access architecture ready for real-world school deployment.
