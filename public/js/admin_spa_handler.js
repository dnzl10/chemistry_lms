/**
 * Admin SPA Engine — Zero-Reload Handler
 * Eliminates full-page reloads across all admin pages while preserving
 * active tabs, scroll position, state, and providing sleek micro-animations.
 */
(function() {
    'use strict';

    // Inject CSS for top progress bar and loading card
    const style = document.createElement('style');
    style.id = 'admin-spa-styles';
    style.textContent = `
        #adminTopProgressBar {
            position: fixed;
            top: 0;
            left: 0;
            height: 3px;
            width: 0%;
            background: linear-gradient(90deg, #06b6d4, #6366f1, #a855f7);
            box-shadow: 0 0 12px rgba(6, 182, 212, 0.8), 0 0 4px rgba(99, 102, 241, 0.8);
            z-index: 999999;
            transition: width 0.25s ease, opacity 0.3s ease;
            pointer-events: none;
        }
        #adminActionLoader {
            position: fixed;
            bottom: 24px;
            left: 24px;
            z-index: 999999;
            background: rgba(15, 23, 42, 0.92);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #f8fafc;
            border-radius: 9999px;
            padding: 10px 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 12px;
            font-weight: 700;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.28);
            transform: translateY(20px);
            opacity: 0;
            pointer-events: none;
            transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
        }
        #adminActionLoader.show {
            transform: translateY(0);
            opacity: 1;
        }
    `;
    if (!document.getElementById('admin-spa-styles')) {
        document.head.appendChild(style);
    }

    // Ensure elements exist in DOM
    function ensureLoaderElements() {
        if (!document.getElementById('adminTopProgressBar')) {
            const bar = document.createElement('div');
            bar.id = 'adminTopProgressBar';
            document.body.appendChild(bar);
        }
        if (!document.getElementById('adminActionLoader')) {
            const loader = document.createElement('div');
            loader.id = 'adminActionLoader';
            loader.innerHTML = `
                <i class="fas fa-circle-notch fa-spin text-cyan-400 text-sm"></i>
                <span id="adminActionLoaderText">Updating changes...</span>
                <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span>
            `;
            document.body.appendChild(loader);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureLoaderElements);
    } else {
        ensureLoaderElements();
    }

    window.showAdminLoader = function(msg) {
        ensureLoaderElements();
        const bar = document.getElementById('adminTopProgressBar');
        const loader = document.getElementById('adminActionLoader');
        const text = document.getElementById('adminActionLoaderText');
        if (text && msg) text.textContent = msg;

        if (bar) {
            bar.style.opacity = '1';
            bar.style.width = '25%';
            setTimeout(() => { if (bar && bar.style.opacity === '1') bar.style.width = '70%'; }, 150);
        }
        if (loader) {
            loader.classList.add('show');
        }
    };

    window.hideAdminLoader = function() {
        const bar = document.getElementById('adminTopProgressBar');
        const loader = document.getElementById('adminActionLoader');
        if (bar) {
            bar.style.width = '100%';
            setTimeout(() => {
                bar.style.opacity = '0';
                setTimeout(() => { bar.style.width = '0%'; }, 300);
            }, 180);
        }
        if (loader) {
            loader.classList.remove('show');
        }
    };

    /**
     * Seamless Admin Content Refresh
     * Fetches current page HTML in the background, updates relevant DOM nodes,
     * preserves active tabs, scroll position, and re-executes page initializers.
     */
    window.refreshAdminContent = async function(options = {}) {
        const message = options.message || 'Applying changes...';
        window.showAdminLoader(message);

        try {
            // 1. Capture current state before update
            // Check active tab
            let currentTabId = null;
            let currentTabBtn = null;

            // Pattern A: .re-tab.active / .re-pane.active (resources_engagement.ejs)
            const activeRePane = document.querySelector('.re-pane.active');
            if (activeRePane && activeRePane.id) {
                currentTabId = activeRePane.id;
            }

            // Pattern B: .tab-btn.active / .tab-content.active (gaming_qbank.ejs, user_access_control.ejs)
            const activeTabContent = document.querySelector('.tab-content.active');
            if (!currentTabId && activeTabContent && activeTabContent.id) {
                currentTabId = activeTabContent.id;
            }

            // Pattern C: tab buttons with data-tab or onclick="switchTab('...')"
            const activeTabBtn = document.querySelector('.re-tab.active, .tab-btn.active, .nav-tab.active, .audit-tab.active');
            if (activeTabBtn) {
                currentTabBtn = activeTabBtn;
                if (!currentTabId) {
                    const onclickAttr = activeTabBtn.getAttribute('onclick') || '';
                    const match = onclickAttr.match(/switchTab\(['"]([^'"]+)['"]/);
                    if (match) currentTabId = match[1];
                }
            }

            // Capture scroll position
            const scrollContainers = [
                document.querySelector('.overflow-y-auto'),
                document.querySelector('.main-content'),
                document.documentElement,
                document.body
            ].filter(Boolean);

            const scrollPositions = scrollContainers.map(el => ({ el, top: el.scrollTop || window.scrollY }));

            // 2. Fetch fresh page HTML
            const response = await fetch(window.location.href, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                cache: 'no-store'
            });

            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const newDoc = parser.parseFromString(html, 'text/html');

            // 3. Update Dynamic Target Containers
            // Priority 1: #adminMainContent
            const oldMain = document.getElementById('adminMainContent');
            const newMain = newDoc.getElementById('adminMainContent');

            if (oldMain && newMain) {
                oldMain.innerHTML = newMain.innerHTML;
            } else {
                // Fallback: update known high-value sections
                const selectorsToUpdate = options.targetSelectors || [
                    '.glass-card.rounded-2xl',
                    '.stat-card',
                    '#pillar1', '#pillar2', '#pillar3', '#pillar4',
                    '#tab-assessments', '#tab-questions', '#tab-remediation', '#tab-bulk',
                    '#tab-users', '#tab-invites',
                    '#subjectGrid', '#classGrid',
                    '#academicAccordion',
                    'tbody'
                ];

                selectorsToUpdate.forEach(sel => {
                    const oldEl = document.querySelector(sel);
                    const newEl = newDoc.querySelector(sel);
                    if (oldEl && newEl) {
                        oldEl.innerHTML = newEl.innerHTML;
                    }
                });

                // Update KPI stats strip if present
                const oldKpi = document.querySelector('.grid.grid-cols-2');
                const newKpi = newDoc.querySelector('.grid.grid-cols-2');
                if (oldKpi && newKpi) {
                    oldKpi.innerHTML = newKpi.innerHTML;
                }
            }

            // Also synchronize modal contents/drawers if updated on server
            const modalIds = [
                'modalAddMaterial', 'modalEditMaterial', 'modalAddForum', 'modalEditForum',
                'modalAssessmentDrawer', 'modalQuestion', 'modalRemediation',
                'modalInviteUser', 'modalEditUser', 'modalAddSubject', 'modalEditSubject',
                'modalAddSY', 'modalEditSY'
            ];
            modalIds.forEach(mId => {
                const oldM = document.getElementById(mId);
                const newM = newDoc.getElementById(mId);
                if (oldM && newM && !oldM.classList.contains('open') && !oldM.classList.contains('active')) {
                    oldM.innerHTML = newM.innerHTML;
                }
            });

            // 4. Restore Active Tab
            if (currentTabId && typeof window.switchTab === 'function') {
                try {
                    // Find new tab button matching currentTabId
                    const newBtn = document.querySelector(
                        `#btn-tab-${currentTabId}, [onclick*="'${currentTabId}'"], [onclick*='"${currentTabId}"']`
                    );
                    window.switchTab(currentTabId, newBtn || undefined);
                } catch (e) {
                    console.warn('[SPA Handler] switchTab restore failed:', e);
                }
            }

            // 5. Restore Scroll Position
            scrollPositions.forEach(({ el, top }) => {
                if (el) {
                    if (el === document.documentElement || el === document.body) {
                        window.scrollTo(0, top);
                    } else {
                        el.scrollTop = top;
                    }
                }
            });

            // 6. Re-run Page-Specific Initializers
            if (typeof window.renderMilestonePagination === 'function') window.renderMilestonePagination();
            if (typeof window.renderStudentLeaderboardPagination === 'function') window.renderStudentLeaderboardPagination();
            if (typeof window.renderInteractionTable === 'function') window.renderInteractionTable();
            if (typeof window.filterMaterials === 'function') window.filterMaterials();
            if (typeof window.filterClassesBreakdown === 'function') window.filterClassesBreakdown();
            if (typeof window.filterStudentLeaderboard === 'function') window.filterStudentLeaderboard();

            if (typeof window.filterAssessmentsTable === 'function') window.filterAssessmentsTable();
            if (typeof window.filterQuestionsTable === 'function') window.filterQuestionsTable();
            if (typeof window.filterSubjects === 'function') window.filterSubjects();
            if (typeof window.filterUsersTable === 'function') window.filterUsersTable();
            if (typeof window.renderInvitesPagination === 'function') window.renderInvitesPagination();

            // Fire custom event for any other listeners
            window.dispatchEvent(new CustomEvent('adminContentRefreshed', { detail: { url: window.location.href } }));

            if (typeof options.onSuccess === 'function') {
                options.onSuccess();
            }

        } catch (err) {
            console.error('[Admin SPA Handler] Background refresh error:', err);
            // Non-breaking fallback: don't crash
        } finally {
            setTimeout(window.hideAdminLoader, 250);
        }
    };

    // Safe alias
    window.reloadAdminPage = window.refreshAdminContent;

})();
