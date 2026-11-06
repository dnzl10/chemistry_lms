# SYSTEM DIRECTIVE: FULL-STACK REVERSE-ENGINEERING & DUAL-SIDED PORTAL ARCHITECTURE SPECIFICATION

## I. MISSION OVERVIEW
You are operating as a Principal Systems Architect and Lead Full-Stack Engineer. The **Student Access Level** for this application is completely implemented across the Frontend, Backend, Database schemas, State Management, and API layers.

Your objective is to execute an exhaustive, zero-assumption audit of the entire codebase to design and scaffold the **Teacher Access Level**. The Teacher Portal must achieve 100% operational parity, seamless data reactivity, and relational integrity with the existing Student Portal without breaking existing contracts.

---

## II. SYSTEM CONSTRAINTS & EXECUTION PROTOCOLS
1. **Zero Hallucination Policy:** Do not assume variable names, table schemas, or endpoint routes. Every extraction must reference exact file paths, exported signatures, and database models found in this repository.
2. **Backward Compatibility:** All Teacher-side architectural additions (schemas, tables, columns, routes) must be strictly non-breaking to the existing Student ecosystem.
3. **Multi-Tenant Isolation:** Audit and identify boundaries ensuring teachers only mutate and observe records for classes, sections, and subjects assigned directly to them.

---

## III. AUDIT & EXTRACTION DELIVERABLES

Execute the following 6-step deep scan and deliver a comprehensive architectural document:

### STEP 1: STUDENT RUNTIME & SURFACE REVERSE-ENGINEERING
Analyze every existing Student route, page, and module (Dashboard, Home, Subject Page, Calendar, Leaderboard, Submissions, Quizzes/Assessments, Profiles):
- Map the view-layer architecture: Form components, interactive widgets, local/global state stores (e.g., Redux, Pinia, Context, Zustand, session storage), and event hooks.
- Classify all student operations strictly into:
  - **Read-Only Ingestion:** Data consumed by students that requires Teacher authoring.
  - **Mutation/Write Payloads:** Data emitted by students that requires Teacher review, grading, or state transition.

### STEP 2: REVERSE DATA SCHEMA & ORM INSPECTION
Scan all migrations, schema definition files, ORM models, or raw SQL queries:
- Document all core entities: users, roles/permissions, subjects/classes, enrollments, assignments/quizzes, submissions, grades, logs, calendar events, and point systems.
- Identify current authorization patterns: How are roles currently differentiated? Locate existing flags (e.g., `role_id`, `role === 'student'`, ENUMs) and evaluate how to extend them cleanly for `teacher` or `instructor`.
- Detect missing relational links: Where are foreign keys absent for class assignments or teacher-to-student associations?

### STEP 3: API SURFACE & DATA MUTATION INVERSION MATRIX
Extract every existing backend route serving the Student client, then define its exact operational inverse:
- Build a structured matrix with the following columns:
  | Student Surface / Module | Existing Student Endpoint(s) & Methods | Consumed / Produced Data Fields | Counterpart Teacher Endpoint Required | Required Teacher Mutation (CRUD/Approve/Grade) |
  |---|---|---|---|---|
  | *(e.g., /leaderboard)* | *(e.g., GET /api/v1/scores)* | *(e.g., score, xp, rank, badge_id)* | *(e.g., POST /api/v1/teacher/scores/override)* | *(e.g., Manual XP adjustment, bonus assignment)* |

### STEP 4: ACTIONABLE TEACHER ANALYTICS & MONITORING ENGINE
Based exclusively on existing data telemetry and student activity columns (timestamps, attempt counters, completion flags, score aggregates):
- **Predictive Risk & Diagnostic Metrics:** Define formulas and SQL/Aggregation queries to compute at-risk indicators (e.g., inactivity thresholds, persistent low quiz mastery, non-submission trends).
- **Classroom Velocity Metrics:** Class-wide median completion rates, bottleneck assessments (questions with abnormal failure rates), and grade distributions.
- **Workflow Accelerators:** Specify requirements for batch processing (bulk scoring, mass due-date extensions, section-wide announcements).

### STEP 5: RBAC & SECURITY GAP AUDIT
- Identify existing authentication and authorization middlewares. 
- Detail the exact implementation required to build a hardened `TeacherGuard` or role-validation middleware.
- Map data isolation boundaries: Detail the query-level validation needed to prevent IDOR (Insecure Direct Object Reference) vulnerabilities (e.g., Teacher X modifying submissions belonging to Teacher Y's section).

### STEP 6: PRODUCTION EXECUTION ROADMAP
Deliver an ordered, step-by-step implementation sequence:
1. **Database Layer:** Required migrations, index updates, new tables, foreign keys.
2. **Backend/API Layer:** Controller endpoints, validation schemas, business logic services, role guards.
3. **Frontend Architecture:** Reusable component extractions from the Student UI, new Teacher views, forms, state hydration routines, and analytics dashboards.

---

## IV. OUTPUT FORMATTING
Present the audit results clearly using Markdown, structured with exact file references (`path/to/file.ext`), precise code snippets for proposed schemas/endpoints, and clean tabular data for the Inversion Matrix.