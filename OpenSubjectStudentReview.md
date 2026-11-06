This is by far the biggest of the three files (3,200+ lines — a single page doing PDF viewing, annotation, AI summaries, quizzes, and submissions all at once). Here's the full breakdown.

## 🔴 Critical bugs

1. **Unclosed `<a>` tag in the user dropdown** (around line 443–447):
```html
<a href="/profile" class="...">
    <i class="far fa-user w-5 text-center"></i> View Profile
<hr class="my-2 border-slate-50">
<a href="/logout" ...>
```
There's no `</a>` after "View Profile." This means the "Log Out" link ends up nested inside the "View Profile" anchor in the DOM — invalid HTML (anchors can't nest), and browser auto-correction behavior for this is unpredictable across browsers. This is a straightforward missing-closing-tag bug, easy to fix, but it should be patched immediately since it affects a menu on every subject page.

2. **YouTube topic videos load with no `loading="lazy"`** (line 679), unlike the PhET simulation page which did use lazy-loading. If a subject has multiple quarters with multiple topics, each with its own embedded video, every single iframe fires an immediate network request on page load — none of them wait until scrolled into view. On a subject with, say, 4 quarters × 4 topics each, that's potentially 16 YouTube iframes loading at once before the student has scrolled past the hero banner.

3. **`data.ai_summary` and flashcard Q&A text are injected via raw `innerHTML`** without any escaping (lines 2738, 2742, 2753). If the AI-generated summary or flashcard text ever contains characters that look like HTML/script tags — which can happen if the source document text itself contains such characters, or if the AI model echoes formatting oddly — this becomes a stored XSS vector. Any time server-returned text is inserted into the page, it needs to go through a sanitizer or be inserted as `textContent`, not raw `innerHTML`.

## 🟠 A genuinely unusual design choice worth flagging: the anti-copying system

This file includes real "DRM-style" protections: a `@media print` block that blanks the page during printing, a `visibilitychange` listener that blurs the entire page when the tab loses focus (labeled "Screen Record Mitigation"), and a client-side watermark overlay with a `MutationObserver` that force-reloads the page if it detects the watermark was hidden or removed ("Security Violation: Watermark tampering detected"). I want to flag this carefully because it's a legitimate UX/trust problem, not just a nitpick:

- **None of these actually stop content theft.** A photo of the screen defeats the watermark and the blur entirely. Disabling JavaScript before the page loads (trivial in any browser) skips the watermark and the tamper-detection both. Print-to-PDF can be replicated via a screenshot tool regardless of the `@media print` block. This is security theater — it adds real friction without providing real protection.
- **It actively punishes normal, innocent behavior.** Alt-tabbing to check a calculator or notes app while studying triggers the same `visibilitychange` blur as an actual screen recorder would. A student using a legitimate accessibility extension (screen reader tools, high-contrast extensions, some ad blockers) that modifies the DOM can trigger the `MutationObserver` and get hit with a jarring "Security Violation" alert and a forced page reload — treating an assistive-tech user like an attacker.
- **From an HCI standpoint**, this violates the basic principle of not punishing users for behavior they didn't intend to be "wrong." A forced reload with an accusatory alert is a hostile response to what is, for the vast majority of triggers, completely normal computer use.
- My recommendation: keep the print-disable as a soft deterrent if you want it, but drop the forced-reload/accusation pattern — it will generate support tickets from confused, innocent students far more often than it will ever stop a determined one.

## 🟡 Structural / information architecture

- **Very deep nesting: Quarter (accordion) → Topic (card) → Tab (6 tabs: Announcements/Forums/Resources/Links/Assessments/Assignments) → content.** To reach a single assignment, a student expands a quarter, scrolls to the right topic, then clicks the correct one of six tabs. That's a lot of interaction steps for something that, in most LMS platforms, is one or two clicks away. Worth considering a global search or a flattened "everything due this week across all topics" view as an escape hatch from this depth.
- **If there are many topics, this nesting means dozens of duplicate tab-panel DOM structures render at once** (unless something server-side limits it) — each topic gets its own full 6-tab set in the DOM simultaneously, none of it appears to be conditionally rendered only when expanded. Combined with the un-lazy video iframes, this could make the page genuinely heavy for a subject with a lot of content.
- **Three parallel styling systems fighting each other in one file:** Tailwind utility classes, a custom `<style>` block with hand-written CSS classes (`.quarter-card`, `.tab-pill`, `.resource-chip`, etc.), and large blocks of raw inline `style="..."` attributes (the Attendance Card and Teacher Card sections, for example, are almost entirely inline styles instead of Tailwind classes). This is a step backward in consistency compared to the dashboard and subjects list files — pick one system and stick to it, at minimum within a single file.
- **Two empty placeholder sections left in production markup**: "Quick stats row" (line 512) and "Leaderboard Card" (line 566) are just comments with no actual content — promised features that were never wired up. Not harmful, but worth tracking so they don't get forgotten before a defense/demo.

## 🟢 What's genuinely strong here

- **In-browser PDF annotation system** (highlighting, sticky notes, "Ask Teacher" inline questions tied to specific text selections) is a real, sophisticated feature — most student-facing LMS tools don't offer this level of interactivity with reading material. Letting a student ask a question anchored to the exact sentence they're confused about is excellent, concrete pedagogical UX.
- **Rubric preview before submission** — showing grading criteria and point values before the student submits is exactly the kind of transparency that reduces submission anxiety and helps students self-check their work. Strong choice.
- **Pre-flight diagnostics on the submission modal** (word count checks, blank-content checks) catch errors *before* submission rather than rejecting after the fact — this is Nielsen's "error prevention" heuristic applied correctly, and it visibly reduces the "did I mess this up?" uncertainty for students.
- **The submission receipt / non-repudiation modal** directly answers a real student anxiety ("did my file actually go through?") with a concrete confirmation artifact. Good instinct.
- **Locked/unlocked topic and resource states** use a consistent visual language (grayscale + reduced opacity + a lock badge) that matches how "locked" content is communicated elsewhere in your ecosystem — good cross-page consistency.
- **The assessment result modal reuses the same element-card visual language** (green = correct, red = wrong, orange = student's answer) as your arcade's Periodic Builder mechanic. That's a genuinely thoughtful piece of design-system thinking — a student who's played the arcade version immediately recognizes the same color grammar when reviewing a web assessment.
- **YouTube URL normalization** (handling both `youtube.com/watch?v=` and `youtu.be/` link formats automatically) removes a common point of teacher error — they don't need to manually grab an embed URL.
- **AI-generated flip flashcards** with a simple click-to-reveal interaction is a clean, well-understood pattern that needs no onboarding or explanation.
