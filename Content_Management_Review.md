Act as an elite Senior LMS Solutions Architect, Lead Full-Stack Code Reviewer, and EdTech Cybersecurity Auditor.

Your task is to conduct a rigorous, end-to-end architectural and implementation audit of my Learning Management System (LMS) codebase, schema, and system workflows. 

You must systematically analyze whether the specific features listed below are fully implemented, partially implemented, mock/stubbed, or completely missing across all three User Roles:
1. Student (End-user consumption, interaction, and security restrictions)
2. Teacher / Instructor (Content authoring, configuration, asset upload, and override capabilities)
3. Admin / Superadmin (System-wide enforcement, security policies, token management, and audit logs)

---

### TARGET FEATURE AUDIT CHECKLIST:

1. Interactive Video Player & Streaming Architecture
   - In-Video Quizzing & Branching: Time-based event triggers, non-skippable gating, question overlays, branching decision paths, and state capture in the gradebook.
   - Clickable Chapters & Note-taking Markers: Timestamped markers on the video seekbar tied to personal or public notes.
   - Adaptive Bitrate Streaming (HLS): Transcoding pipeline, delivery via .m3u8 playlists and .ts segments, and auto-fallback based on client network bandwidth.

2. In-App Document Viewer & Smart Annotator
   - Multi-format In-Browser Rendering: Native rendering of PDF, DOCX, PPTX, and EPUB without forcing client-side file downloads.
   - Smart Annotation Toolkit: Inline text highlighting, persistent sticky notes, in-viewer search, and quick dictionary/definition lookup.

3. AI-Powered Summarizer & Resource Assistant
   - Backend Ingestion Pipeline: Text extraction from long PDFs and video transcripts.
   - Structured AI Generation: Generation of key takeaways, bullet points, and flashcard sets (Q&A JSON format).
   - Audio Recap: Text-to-Speech (TTS) conversion producing short (1-minute) digestible audio summaries.

4. Dynamic User-Specific Watermarking (Anti-Piracy)
   - Dynamic Overlay Engine: Dynamic, semi-transparent watermarking on both video streams (canvas/HTML overlay) and PDF pages (server-side burn-in or client-side canvas render).
   - Data Points: Current user's full name, email, dynamic IP address, and real-time timestamp.
   - Evasion Resistance: Watermark repositioning or dynamic motion to counter screen cropping.

5. Content Protection & Anti-Exfiltration Shields
   - Browser Action Gating: Prevention/toggling of right-click context menu, keyboard copy shortcuts (Ctrl+C/Cmd+C), text selection/highlighting, and direct printing (CSS print shields / window.print blocking).
   - Screen Recording & Capture Mitigation: Canvas obfuscation, visibility change hooks (`document.hidden`, blur events), or screen-shield scripts that darken/blur content upon capture or focus loss.

---

### YOUR AUDIT EXECUTION INSTRUCTIONS:

For each of the 5 features above, break down your evaluation into the following structured sections:

1. [Role Matrix & Access Verification]
   - Detail how this feature functions under Student, Teacher, and Admin permissions.
   - Verify if role-based controls (RBAC) properly segregate creation, enforcement, and viewing privileges.

2. [Implementation Status & Evidence]
   - Status: [Fully Implemented | Partially Implemented | Stubbed/Mock Only | Missing]
   - Identify exact files, functions, API endpoints, UI components, or database tables supporting the implementation.

3. [Vulnerability & Edge-Case Stress Test]
   - Point out security bypasses (e.g., inspecting network payloads, extracting signed URLs, bypassing client-side JavaScript restrictions, disabling devtools).
   - Highlight UX failures or backend bottlenecks (e.g., uncompressed file delivery, excessive AI API token consumption, unoptimized database writes on video progress).

4. [Concrete Remediation & Optimization Steps]
   - Provide precise code snippets, architectural patterns, or recommended npm/cloud modules to bridge missing logic and harden security.
