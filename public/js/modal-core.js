/**
 * ============================================================================
 * Chemistry LMS - Universal Modal Core & Accessibility Manager
 * Provides: Focus Trapping, Global ESC Handling, Body Scroll Lock,
 * Unsaved Data Protection Guards, ARIA Dialog Normalization, and Stacking.
 * ============================================================================
 */

(function () {
    'use strict';

    const modalStack = [];
    let previousActiveElement = null;

    const FOCUSABLE_SELECTOR = [
        'a[href]',
        'area[href]',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'button:not([disabled])',
        'iframe',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable="true"]'
    ].join(', ');

    function getFocusableElements(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
            .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
    }

    function lockBodyScroll() {
        if (modalStack.length === 1) {
            const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
            if (scrollBarWidth > 0) {
                document.body.style.paddingRight = `${scrollBarWidth}px`;
            }
            document.body.classList.add('overflow-hidden');
        }
    }

    function unlockBodyScroll() {
        if (modalStack.length === 0) {
            document.body.style.paddingRight = '';
            document.body.classList.remove('overflow-hidden');
        }
    }

    function hasUnsavedChanges(modalEl) {
        if (!modalEl) return false;
        // Check textareas and text inputs that are not hidden
        const inputs = modalEl.querySelectorAll('textarea, input[type="text"], input[type="email"], input[type="date"], input[type="datetime-local"]');
        for (const input of inputs) {
            // Ignore search inputs or read-only/disabled
            if (input.readOnly || input.disabled || input.classList.contains('no-guard') || input.id.toLowerCase().includes('search')) {
                continue;
            }
            if (input.value && input.value.trim().length > 0) {
                // If it's a date input with default today's date, don't trigger unless user modified
                if (input.dataset.initialValue !== undefined) {
                    if (input.value !== input.dataset.initialValue) return true;
                } else if (input.tagName === 'TEXTAREA' && input.value.trim().length > 5) {
                    return true;
                }
            }
        }
        return false;
    }

    const ModalManager = {
        /**
         * Open a modal safely with focus trapping and accessibility setup
         * @param {string|HTMLElement} target - Modal element or ID
         * @param {Object} [options]
         * @param {HTMLElement} [options.trigger] - Trigger element to return focus to upon close
         * @param {boolean} [options.guardUnsaved] - Prompt before backdrop/Esc dismissal if dirty
         * @param {boolean} [options.isAlert] - Use role="alertdialog" instead of role="dialog"
         * @param {Function} [options.onClose] - Callback when modal is closed
         */
        open: function (target, options = {}) {
            const modal = typeof target === 'string' ? document.getElementById(target) : target;
            if (!modal) return;

            // Track trigger
            const trigger = options.trigger || document.activeElement;
            if (modalStack.length === 0) {
                previousActiveElement = trigger;
            }

            // Options & metadata
            modal._modalOptions = options;
            modal._previousFocus = trigger;

            // Mark initial values on inputs for unsaved detection
            modal.querySelectorAll('textarea, input').forEach(input => {
                input.dataset.initialValue = input.value;
            });

            // Standardize accessibility attributes
            if (!modal.getAttribute('role')) {
                modal.setAttribute('role', options.isAlert ? 'alertdialog' : 'dialog');
            }
            modal.setAttribute('aria-modal', 'true');

            // Show modal
            modal.classList.remove('hidden');
            modal.classList.add('open');
            if (!modal.classList.contains('flex') && !modal.classList.contains('grid')) {
                modal.classList.add('flex');
            }

            // Stack management
            const idx = modalStack.indexOf(modal);
            if (idx !== -1) modalStack.splice(idx, 1);
            modalStack.push(modal);

            lockBodyScroll();

            // Focus first relevant focusable item
            setTimeout(() => {
                const focusables = getFocusableElements(modal);
                if (focusables.length > 0) {
                    // Prefer autofocus input or primary input over close button
                    const autoInput = modal.querySelector('[autofocus], textarea, input:not([type="hidden"]), select') || focusables[0];
                    autoInput.focus();
                } else {
                    modal.focus();
                }
            }, 50);

            // Announce to screen readers if live region available
            this.announce('Dialog opened: ' + (modal.getAttribute('aria-label') || 'Modal Window'));
        },

        /**
         * Close a modal with unsaved checks and focus restoration
         * @param {string|HTMLElement} target - Modal element or ID
         * @param {boolean} [force=false] - Skip unsaved confirmation check
         */
        close: function (target, force = false) {
            const modal = typeof target === 'string' ? document.getElementById(target) : target;
            if (!modal) return false;
            const isHidden = modal.classList.contains('hidden') || (!modal.classList.contains('open') && modal.classList.contains('modal-backdrop'));
            if (isHidden && !modalStack.includes(modal)) return false;

            const opts = modal._modalOptions || {};
            if (!force && opts.guardUnsaved && hasUnsavedChanges(modal)) {
                const confirmDiscard = window.confirm('You have unsaved changes. Discard them and close?');
                if (!confirmDiscard) return false;
            }

            // Hide modal
            modal.classList.add('hidden');
            modal.classList.remove('open');
            modal.classList.remove('flex');

            // Remove from stack
            const stackIdx = modalStack.indexOf(modal);
            if (stackIdx !== -1) modalStack.splice(stackIdx, 1);

            unlockBodyScroll();

            // Fire callback
            if (typeof opts.onClose === 'function') {
                opts.onClose(modal);
            }

            // Restore focus
            if (modal._triggerElement && typeof modal._triggerElement.focus === 'function') {
                modal._triggerElement.focus();
            }

            this.announce('Dialog closed');
            return true;
        },

        /**
         * Close topmost modal
         */
        closeTop: function (force = false) {
            if (modalStack.length === 0) return false;
            const topModal = modalStack[modalStack.length - 1];
            return this.close(topModal, force);
        },

        /**
         * Check if any modal is currently open
         */
        hasOpenModal: function () {
            return modalStack.length > 0;
        },

        /**
         * Helper to announce messages to screen readers
         */
        announce: function (msg) {
            let live = document.getElementById('modalLiveAnnouncer');
            if (!live) {
                live = document.createElement('div');
                live.id = 'modalLiveAnnouncer';
                live.className = 'sr-only';
                live.setAttribute('aria-live', 'polite');
                live.setAttribute('aria-atomic', 'true');
                document.body.appendChild(live);
            }
            live.textContent = msg;
        }
    };

    // Global Keydown Handler: Trap Focus & Escape Key
    document.addEventListener('keydown', function (event) {
        // 1. ESCAPE KEY CLOSE
        if (event.key === 'Escape' || event.key === 'Esc') {
            const notifPanel = document.getElementById('notification-panel');
            if (modalStack.length === 0) {
                if (notifPanel && !notifPanel.classList.contains('translate-x-full')) {
                    if (typeof toggleNotifications === 'function') {
                        toggleNotifications();
                    }
                }
                return;
            }

            const currentModal = modalStack[modalStack.length - 1];
            // Don't close if modal has hard gating (e.g. Critical Intercept with active countdown)
            if (currentModal.id === 'criticalInterceptBackdrop') {
                const btn = currentModal.querySelector('#criticalAcknowledgeBtn');
                if (btn && btn.disabled) return; // Enforce hard gate
            }
            event.preventDefault();
            ModalManager.close(currentModal);
            return;
        }

        if (modalStack.length === 0) return;
        const currentModal = modalStack[modalStack.length - 1];

        // 2. FOCUS TRAPPING (Tab / Shift+Tab)
        if (event.key === 'Tab') {
            const focusables = getFocusableElements(currentModal);
            if (focusables.length === 0) {
                event.preventDefault();
                return;
            }

            const firstEl = focusables[0];
            const lastEl = focusables[focusables.length - 1];

            if (event.shiftKey) {
                // Backward tab
                if (document.activeElement === firstEl || !currentModal.contains(document.activeElement)) {
                    event.preventDefault();
                    lastEl.focus();
                }
            } else {
                // Forward tab
                if (document.activeElement === lastEl || !currentModal.contains(document.activeElement)) {
                    event.preventDefault();
                    firstEl.focus();
                }
            }
        }
    });

    // Auto-bind backdrop click dismiss to any [data-backdrop-dismiss] or elements matching modal classes
    document.addEventListener('click', function (event) {
        if (modalStack.length === 0) return;
        const currentModal = modalStack[modalStack.length - 1];
        
        // Critical alert cannot be dismissed via backdrop
        if (currentModal.id === 'criticalInterceptBackdrop') return;

        // If clicked directly on the outer backdrop element
        if (event.target === currentModal) {
            ModalManager.close(currentModal);
        }
    });

    // Expose globally
    window.ModalManager = ModalManager;
})();
