/**
 * public/js/session-guard.js
 * Client-side Session Guardian Controller for Elementa LMS.
 * Manages idle timers, real-time concurrent login handshakes, server reboot detection,
 * administrative holds, and confirmation prompts for all session lifecycle states.
 */

(function () {
    'use strict';

    // Prevent duplicate initialization
    if (window.__elementaSessionGuardInitialized) return;
    window.__elementaSessionGuardInitialized = true;

    // Configuration Constants
    const IDLE_LIMIT_MS = 30 * 60 * 1000;       // 30 Minutes
    const IDLE_WARN_THRESHOLD_MS = 28 * 60 * 1000; // 28 Minutes (triggers 2-min countdown)
    const HEARTBEAT_INTERVAL_MS = 15 * 1000;    // Poll status every 15s
    const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 Hours
    const MAX_WARN_THRESHOLD_MS = MAX_LIFETIME_MS - (5 * 60 * 1000); // 11h 55m

    // State Variables
    let lastActiveTime = Date.now();
    let isIdleWarningActive = false;
    let idleCountdownInterval = null;
    let knownServerBootId = null;
    let isSuspendedActive = false;
    let isConcurrentActive = false;
    let activePendingRequestId = null;
    let concurrentCountdownInterval = null;
    let maxLifetimeWarned = false;

    // Multi-tab synchronization channel
    let broadcastChannel = null;
    try {
        if ('BroadcastChannel' in window) {
            broadcastChannel = new BroadcastChannel('elementa_session_sync');
            broadcastChannel.onmessage = (event) => handleBroadcastMessage(event.data);
        }
    } catch (_) {}

    function handleBroadcastMessage(msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'SESSION_EXTENDED') {
            resetIdleTimer(false);
            if (isIdleWarningActive) {
                closeInactivityModal();
            }
        } else if (msg.type === 'FORCE_LOGOUT') {
            window.location.href = '/login';
        }
    }

    function notifyTabs(type, payload = {}) {
        if (broadcastChannel) {
            broadcastChannel.postMessage({ type, ...payload, timestamp: Date.now() });
        }
    }

    // ========================================================
    // 1. ACTIVITY & IDLE TRACKER
    // ========================================================

    function onUserActivity() {
        if (isIdleWarningActive || isSuspendedActive) return;
        const now = Date.now();
        // Throttle updates to at most once every 5 seconds
        if (now - lastActiveTime > 5000) {
            lastActiveTime = now;
        }
    }

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    activityEvents.forEach((evt) => {
        window.addEventListener(evt, onUserActivity, { passive: true });
    });

    function checkIdleState() {
        if (isSuspendedActive) return;
        const now = Date.now();
        const idleDuration = now - lastActiveTime;

        if (idleDuration >= IDLE_WARN_THRESHOLD_MS && !isIdleWarningActive) {
            triggerInactivityWarning();
        }
    }

    function triggerInactivityWarning() {
        isIdleWarningActive = true;
        const remainingMs = Math.max(0, IDLE_LIMIT_MS - (Date.now() - lastActiveTime));
        let remainingSeconds = Math.round(remainingMs / 1000);

        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.show('sessionInactivityModal');
        }

        updateIdleCountdownDisplay(remainingSeconds);

        clearInterval(idleCountdownInterval);
        idleCountdownInterval = setInterval(() => {
            remainingSeconds--;
            if (remainingSeconds <= 0) {
                clearInterval(idleCountdownInterval);
                updateIdleCountdownDisplay(0);
                // Inactivity limit fully exceeded
                onInactivityExpired();
            } else {
                updateIdleCountdownDisplay(remainingSeconds);
            }
        }, 1000);
    }

    function updateIdleCountdownDisplay(totalSecs) {
        const display = document.getElementById('idleCountdownDisplay');
        if (!display) return;
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        display.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function resetIdleTimer(shouldNotify = true) {
        lastActiveTime = Date.now();
        if (shouldNotify) {
            notifyTabs('SESSION_EXTENDED');
        }
    }

    function closeInactivityModal() {
        isIdleWarningActive = false;
        clearInterval(idleCountdownInterval);
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.hide('sessionInactivityModal');
        }
    }

    async function extendSession() {
        try {
            const btn = document.getElementById('btnExtendSession');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="animate-spin mr-2">⚙</span> Extending...`;
            }

            const res = await fetch('/api/session/keep-alive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            });

            if (res.ok) {
                resetIdleTimer(true);
                closeInactivityModal();
            } else {
                window.location.href = '/login?error=' + encodeURIComponent('Session expired. Please log in again.');
            }
        } catch (err) {
            console.error('[Session Guard] Failed to extend session:', err);
        } finally {
            const btn = document.getElementById('btnExtendSession');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `Keep Working (Extend Session)`;
            }
        }
    }

    function onInactivityExpired() {
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.hideAll();
        }
        window.location.href = '/login?error=' + encodeURIComponent('Your session has ended due to 30 minutes of inactivity.');
    }

    // ========================================================
    // 2. PERIODIC HEARTBEAT POLLING (/api/session/status)
    // ========================================================

    async function pollSessionStatus() {
        try {
            const res = await fetch('/api/session/status', {
                headers: { 'Accept': 'application/json' }
            });

            if (!res.ok) {
                if (res.status === 401) {
                    // Session no longer valid
                    return;
                }
            }

            const data = await res.json();

            // Skip handling if unauthenticated page
            if (!data.authenticated) {
                return;
            }

            // 1. Server Reboot Check
            if (data.serverBootId) {
                if (knownServerBootId && knownServerBootId !== data.serverBootId) {
                    triggerServerRebootModal();
                    return;
                }
                knownServerBootId = data.serverBootId;
            }

            // 2. Admin Suspension / Deactivation Check
            if (data.status === 'suspended' || data.suspended) {
                triggerSuspensionModal(data.reason);
                return;
            }

            // 3. Displaced Session Check (User logged in elsewhere without grant)
            if (data.status === 'displaced' || data.sessionMismatch) {
                triggerDisplacedSessionModal(data.reason);
                return;
            }

            // 4. Concurrent Login Handshake Check (Device B asking Device A)
            if (data.pendingConcurrentRequest) {
                triggerConcurrentHandshakeModal(data.pendingConcurrentRequest);
            } else if (isConcurrentActive) {
                // If previously active but no longer pending, close modal
                closeConcurrentModal();
            }

            // 5. 12-Hour Daily Cap Warning Check
            if (data.elapsedMs && data.elapsedMs >= MAX_WARN_THRESHOLD_MS && !maxLifetimeWarned) {
                triggerMaxLifetimeModal(data.elapsedMs);
            }

        } catch (err) {
            // Network glitch or offline — do not abruptly disconnect user
            console.debug('[Session Guard] Heartbeat tick failed:', err.message);
        }
    }

    // ========================================================
    // 3. MODAL TRIGGERS & RESOLUTION HANDLERS
    // ========================================================

    function triggerConcurrentHandshakeModal(request) {
        if (isConcurrentActive && activePendingRequestId === request.requestId) {
            return; // Already open for this request
        }

        isConcurrentActive = true;
        activePendingRequestId = request.requestId;

        const devLabel = document.getElementById('concurrentDeviceLabel');
        const ipLabel = document.getElementById('concurrentIpLabel');
        const countdownLabel = document.getElementById('concurrentCountdown');

        if (devLabel) devLabel.textContent = request.deviceInfo?.label || 'External Device';
        if (ipLabel) ipLabel.textContent = request.deviceInfo?.ip || 'Remote IP';

        let remaining = request.expiresInSeconds || 60;
        if (countdownLabel) countdownLabel.textContent = `${remaining}s remaining`;

        clearInterval(concurrentCountdownInterval);
        concurrentCountdownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(concurrentCountdownInterval);
                closeConcurrentModal();
            } else if (countdownLabel) {
                countdownLabel.textContent = `${remaining}s remaining`;
            }
        }, 1000);

        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.show('sessionConcurrentModal');
        }
    }

    function closeConcurrentModal() {
        isConcurrentActive = false;
        activePendingRequestId = null;
        clearInterval(concurrentCountdownInterval);
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.hide('sessionConcurrentModal');
        }
    }

    async function resolveConcurrent(decision) {
        if (!activePendingRequestId) return;
        const reqId = activePendingRequestId;

        try {
            const btnDeny = document.getElementById('btnDenyConcurrent');
            const btnGrant = document.getElementById('btnGrantConcurrent');
            if (btnDeny) btnDeny.disabled = true;
            if (btnGrant) btnGrant.disabled = true;

            const res = await fetch('/api/session/resolve-concurrent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ requestId: reqId, decision })
            });

            closeConcurrentModal();

            if (decision === 'grant') {
                // If user granted login on other device, cleanly log out here
                notifyTabs('FORCE_LOGOUT');
                window.location.href = '/login?error=' + encodeURIComponent('You granted account access to your other device.');
            }
        } catch (err) {
            console.error('[Session Guard] Failed to resolve concurrent request:', err);
            closeConcurrentModal();
        } finally {
            const btnDeny = document.getElementById('btnDenyConcurrent');
            const btnGrant = document.getElementById('btnGrantConcurrent');
            if (btnDeny) btnDeny.disabled = false;
            if (btnGrant) btnGrant.disabled = false;
        }
    }

    function triggerSuspensionModal(reason) {
        isSuspendedActive = true;
        const msgEl = document.getElementById('suspendedMessage');
        if (msgEl && reason) {
            msgEl.textContent = reason;
        }
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.show('sessionSuspendedModal');
        }
    }

    function triggerServerRebootModal() {
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.show('sessionRebootModal');
        }
    }

    function triggerDisplacedSessionModal(reason) {
        window.location.href = '/login?error=' + encodeURIComponent(reason || 'Your session has ended because your account was logged in from another device.');
    }

    function triggerMaxLifetimeModal(elapsedMs) {
        maxLifetimeWarned = true;
        const remainingMs = Math.max(0, MAX_LIFETIME_MS - elapsedMs);
        const mins = Math.floor(remainingMs / 60000);
        const countdownEl = document.getElementById('maxLifetimeCountdown');
        if (countdownEl) {
            countdownEl.textContent = `${mins}:00`;
        }
        if (window.ElementaSessionModals) {
            window.ElementaSessionModals.show('sessionMaxLifetimeModal');
        }
    }

    // ========================================================
    // 4. MANUAL LOGOUT CLICK INTERCEPTION
    // ========================================================

    function initLogoutInterception() {
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href="/logout"], a[href="/auth/logout"], [data-action="logout"]');
            if (link) {
                // Ignore if clicked within the confirmation modal itself!
                if (link.id === 'btnConfirmLogout') {
                    return; // Let standard navigation proceed
                }
                e.preventDefault();
                e.stopPropagation();
                if (window.ElementaSessionModals) {
                    window.ElementaSessionModals.show('sessionLogoutModal');
                }
            }
        }, true);
    }

    // ========================================================
    // 5. DOM READY WIREUP & EVENT BINDINGS
    // ========================================================

    function initDomListeners() {
        // Inactivity Extend Button
        const btnExtend = document.getElementById('btnExtendSession');
        if (btnExtend) {
            btnExtend.addEventListener('click', extendSession);
        }

        // Inactivity Sign Out Button
        const btnIdleLogout = document.getElementById('btnIdleLogout');
        if (btnIdleLogout) {
            btnIdleLogout.addEventListener('click', () => {
                window.location.href = '/logout';
            });
        }

        // Concurrent Deny Button
        const btnDeny = document.getElementById('btnDenyConcurrent');
        if (btnDeny) {
            btnDeny.addEventListener('click', () => resolveConcurrent('deny'));
        }

        // Concurrent Grant Button
        const btnGrant = document.getElementById('btnGrantConcurrent');
        if (btnGrant) {
            btnGrant.addEventListener('click', () => resolveConcurrent('grant'));
        }

        // Max Lifetime Dismiss Button
        const btnDismissMax = document.getElementById('btnDismissMaxWarning');
        if (btnDismissMax) {
            btnDismissMax.addEventListener('click', () => {
                if (window.ElementaSessionModals) {
                    window.ElementaSessionModals.hide('sessionMaxLifetimeModal');
                }
            });
        }

        // Logout Cancel Button
        const btnCancelLogout = document.getElementById('btnCancelLogout');
        if (btnCancelLogout) {
            btnCancelLogout.addEventListener('click', () => {
                if (window.ElementaSessionModals) {
                    window.ElementaSessionModals.hide('sessionLogoutModal');
                }
            });
        }

        initLogoutInterception();
    }

    // Initialization lifecycle
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initDomListeners();
            setInterval(checkIdleState, 5000);
            setInterval(pollSessionStatus, HEARTBEAT_INTERVAL_MS);
            pollSessionStatus();
        });
    } else {
        initDomListeners();
        setInterval(checkIdleState, 5000);
        setInterval(pollSessionStatus, HEARTBEAT_INTERVAL_MS);
        pollSessionStatus();
    }

})();

