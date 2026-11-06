Act as a Senior Full-Stack Architect and LMS Technical Auditor. I need you to perform an exhaustive, end-to-end audit of my codebase, database schema, and project files to map out our CURRENT attendance monitoring and access tracking implementation.

Specifically, you must evaluate the system across three distinct perspectives: STUDENT, TEACHER/INSTRUCTOR, and ADMIN.

Analyze all provided files and provide a detailed assessment on the following areas:

1. Student-Side Access & Attendance Capture
- Authentication & Login Methods: How do students enter the system (credentials, QR code scans, hardware/kiosk terminals, persistent sessions)?
- Presence & Activity Triggers: How is "attendance" recorded? Is it purely upon login, per class/module session, or tied to interactive activity/module engagement?
- Time & Duration Tracking: Does the system record login timestamps, logout timestamps, idle time, or total time spent inside the platform/station?
- Disconnection Handling: What happens if a student abruptly closes the browser, loses internet connection, or leaves a physical terminal?

2. Teacher/Instructor-Side Monitoring & Management
- Visibility & Dashboards: What real-time or historical attendance views exist for instructors (e.g., student lists, present/absent status, login logs, time-in/time-out)?
- Filtering & Scoping: Can teachers filter attendance by section, subject, date range, or specific learning activity?
- Overrides & Adjustments: Do teachers have mechanisms to manually mark students present/excused/late, or is the log strictly read-only/automated?
- Reporting & Exports: Are there built-in features to export attendance sheets (CSV, Excel, PDF) or generate summary analytics per student/class?

3. Admin-Side Oversight, Audit, & System Controls
- Global Access Logs: Can admins inspect system-wide logins across all roles (Students, Teachers, Admins) including IP addresses, device/terminal metadata, and session IDs?
- Configuration & Policies: Are there admin controls for session timeouts, attendance lock-in windows (e.g., cut-off times), or terminal/hardware registration?
- Anomaly & Fraud Detection: Does the system check for duplicate active logins, simultaneous multi-device access, or proxy attendance?

4. Technical Architecture, Backend & Database
- Identify the exact database tables, collections, or columns storing these logs (e.g., sessions, attendance records, audit trails) and their relational foreign keys.
- Identify the backend routes, middleware, controllers, and frontend views (EJS/HTML/templates) governing this workflow.
- Identify any hardware or client-side scripts involved (e.g., scanners, serial readers, WebSockets, or polling intervals).

5. Required Deliverables
Please format your response into the following clear sections:
A. Role-by-Role Workflow Map: Step-by-step breakdown of how attendance is captured (Student), reviewed (Teacher), and audited/configured (Admin).
B. File & Component Inventory: Exact list of controllers, models, routes, and views handling attendance per role.
C. Database Model Evaluation: Active tables/columns and how relationships connect students to teachers/classes for attendance.
D. Gap Analysis & Vulnerabilities: Missing features per role (e.g., lack of teacher manual override, no export feature, no auto-logout on student dropouts, potential for spoofing).
E. Recommended Action Plan: Concrete steps to bridge these gaps and produce an enterprise-grade attendance tracking system.

Here are the project files, schemas, and configurations to inspect:
[PASTE YOUR CODE / SCHEMA / CONFIG HERE]