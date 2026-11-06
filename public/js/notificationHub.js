/**
 * public/js/notificationHub.js
 * Universal, production-grade notification hub for Elementa LMS.
 * Works across Student, Teacher, and Admin views.
 * Handles badge counters, click-to-redirect deep links, mark-as-read, and modal rendering.
 */

(function() {
    'use strict';

    if (window.NotificationHub) return;

    const NotificationHub = {
        state: {
            unreadCount: 0,
            notifications: [],
            isLoading: false,
            pollTimer: null
        },

        escapeHtml: function(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },

        // Category UI config mapping
        categoryConfig: {
            assessment: {
                label: 'Assessment',
                icon: 'fa-file-lines',
                badgeBg: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
                darkBadgeBg: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
                borderLeft: 'border-l-rose-500',
                iconBg: 'bg-rose-50 text-rose-500'
            },
            academic: {
                label: 'Academic',
                icon: 'fa-book-open',
                badgeBg: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
                darkBadgeBg: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
                borderLeft: 'border-l-blue-500',
                iconBg: 'bg-blue-50 text-blue-500'
            },
            forum: {
                label: 'Discussion',
                icon: 'fa-comments',
                badgeBg: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
                darkBadgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                borderLeft: 'border-l-emerald-500',
                iconBg: 'bg-emerald-50 text-emerald-500'
            },
            integrity: {
                label: 'Integrity Alert',
                icon: 'fa-triangle-exclamation',
                badgeBg: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
                darkBadgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
                borderLeft: 'border-l-amber-500',
                iconBg: 'bg-amber-50 text-amber-500'
            },
            system: {
                label: 'System',
                icon: 'fa-gear',
                badgeBg: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
                darkBadgeBg: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
                borderLeft: 'border-l-purple-500',
                iconBg: 'bg-purple-50 text-purple-500'
            },
            social: {
                label: 'Message',
                icon: 'fa-envelope',
                badgeBg: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
                darkBadgeBg: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
                borderLeft: 'border-l-cyan-500',
                iconBg: 'bg-cyan-50 text-cyan-500'
            }
        },

        init: function() {
            this.updateBadge();
            this.startPolling();
            this.bindGlobalEvents();
        },

        /**
         * Formats ISO timestamp to human relative time.
         */
        timeAgo: function(dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            const seconds = Math.floor((new Date() - date) / 1000);
            if (seconds < 60) return 'Just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            if (days < 7) return `${days}d ago`;
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        },

        /**
         * Fetch unread count and update all badge targets across Student, Teacher, and Admin navbars.
         */
        updateBadge: async function() {
            try {
                const res = await fetch('/api/notifications/unread-count');
                if (!res.ok) return;
                const data = await res.json();
                if (data.success && typeof data.unreadCount === 'number') {
                    // Play non-intrusive sound effect if unread count increases (respects Focus Mode)
                    if (data.unreadCount > this.state.unreadCount && window.SoundManager) {
                        try { window.SoundManager.playSound(); } catch (sndErr) { /* ignore sound error */ }
                    }
                    this.state.unreadCount = data.unreadCount;
                    this.renderBadgeUI(data.unreadCount);
                }
            } catch (err) {
                // Silently absorb background network errors
            }
        },

        renderBadgeUI: function(count) {
            // 1. Admin badges
            const notifDot = document.getElementById('notifDot');
            const notifCount = document.getElementById('notifCount');
            if (notifDot && notifCount) {
                if (count > 0) {
                    notifDot.classList.remove('hidden');
                    notifCount.textContent = count > 99 ? '99+' : count;
                    notifCount.classList.remove('hidden');
                } else {
                    notifDot.classList.add('hidden');
                    notifCount.classList.add('hidden');
                }
            }

            // 2. Student badges (typically .notif-badge container)
            const studentBadges = document.querySelectorAll('.notif-badge, [data-notif-badge]');
            studentBadges.forEach(badge => {
                if (count > 0) {
                    badge.classList.remove('hidden');
                    badge.style.display = 'flex';
                    const textEl = badge.querySelector('.notif-badge-count');
                    if (textEl) textEl.textContent = count > 9 ? '9+' : count;
                } else {
                    badge.classList.add('hidden');
                    badge.style.display = 'none';
                }
            });

            // 3. Teacher badges
            const teacherBadges = document.querySelectorAll('[data-teacher-badge], #teacherNotifCount');
            teacherBadges.forEach(badge => {
                if (count > 0) {
                    badge.classList.remove('hidden');
                    badge.textContent = count > 99 ? '99+' : count;
                } else {
                    badge.classList.add('hidden');
                }
            });

            // 4. Update panel subtitle if open
            const subtitle = document.getElementById('notifSubtitle');
            if (subtitle) {
                subtitle.textContent = count > 0 ? `${count} unread update${count !== 1 ? 's' : ''}` : 'All caught up';
            }
        },

        startPolling: function() {
            if (this.state.pollTimer) clearInterval(this.state.pollTimer);
            // Polling every 60s when document is visible
            this.state.pollTimer = setInterval(() => {
                if (!document.hidden) {
                    this.updateBadge();
                }
            }, 60000);
        },

        /**
         * Fetch notifications and render into container.
         */
        loadNotifications: async function(containerId, isDarkTheme = false) {
            const list = document.getElementById(containerId);
            if (!list) return;

            this.state.isLoading = true;
            list.innerHTML = `
                <div class="flex flex-col items-center justify-center h-48 py-10 text-slate-400">
                    <div class="animate-spin rounded-full h-7 w-7 border-2 border-cyan-500 border-t-transparent mb-3"></div>
                    <p class="text-[11px] font-bold uppercase tracking-widest text-slate-400">Loading notifications...</p>
                </div>
            `;

            try {
                const res = await fetch('/api/notifications?limit=30');
                if (!res.ok) throw new Error('Network error');
                const data = await res.json();
                this.state.notifications = data.notifications || [];
                this.renderNotificationList(containerId, this.state.notifications, isDarkTheme);
                this.renderBadgeUI(data.unreadCount || 0);
            } catch (err) {
                list.innerHTML = `
                    <div class="py-12 text-center text-rose-500 px-4">
                        <i class="fas fa-circle-exclamation text-2xl mb-2 block opacity-60"></i>
                        <p class="text-xs font-bold">Failed to load updates</p>
                        <button onclick="NotificationHub.loadNotifications('${containerId}', ${isDarkTheme})" class="mt-2 text-[11px] text-cyan-600 hover:underline font-bold">
                            Try Again
                        </button>
                    </div>
                `;
            } finally {
                this.state.isLoading = false;
            }
        },

        renderNotificationList: function(containerId, notifications, isDarkTheme = false) {
            const list = document.getElementById(containerId);
            if (!list) return;

            if (!notifications || notifications.length === 0) {
                list.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 text-center px-4">
                        <div class="w-14 h-14 rounded-2xl ${isDarkTheme ? 'bg-white/5 text-indigo-400' : 'bg-slate-100 text-slate-400'} flex items-center justify-center mb-3">
                            <i class="fas fa-check-circle text-2xl opacity-60"></i>
                        </div>
                        <p class="text-xs font-bold uppercase tracking-widest ${isDarkTheme ? 'text-indigo-300' : 'text-slate-700'}">All caught up!</p>
                        <p class="text-[11px] ${isDarkTheme ? 'text-indigo-500' : 'text-slate-400'} mt-1">You have no active notifications.</p>
                    </div>
                `;
                return;
            }

            let html = '';
            notifications.forEach(notif => {
                const config = this.categoryConfig[notif.category] || this.categoryConfig.academic;
                const timeAgo = this.timeAgo(notif.created_at);
                const isUnread = !notif.is_read;
                const safeTitle = this.escapeHtml(notif.title || 'Update');
                const safeMessage = this.escapeHtml(notif.message || '');
                const safePic = notif.actor_pic ? this.escapeHtml(notif.actor_pic) : '';

                // CLICK-TO-REDIRECT DESTINATION LINK
                const navigateUrl = `/api/notifications/${notif.notification_id}/navigate`;

                if (isDarkTheme) {
                    // Dark theme for Teacher panel
                    html += `
                        <a href="${navigateUrl}" 
                           class="flex items-start gap-3 p-3.5 rounded-2xl transition group relative cursor-pointer border ${isUnread ? 'bg-white/10 border-cyan-500/40 shadow-lg shadow-cyan-950/20' : 'bg-white/5 hover:bg-white/10 border-white/5'}">
                            ${isUnread ? '<span class="absolute top-3 right-3 w-2 h-2 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400/80"></span>' : ''}
                            
                            <div class="flex-shrink-0 mt-0.5">
                                ${safePic ? `
                                    <img src="/profile_uploads/${safePic}" class="w-9 h-9 rounded-xl object-cover ring-1 ring-white/10 group-hover:ring-cyan-400/50 transition" onerror="this.src='/profile_uploads/default_avatar.png'">
                                ` : `
                                    <div class="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-cyan-400">
                                        <i class="fas ${config.icon} text-sm"></i>
                                    </div>
                                `}
                            </div>

                            <div class="flex-1 min-w-0 pr-4">
                                <div class="flex items-center gap-2 mb-1 flex-wrap">
                                    <span class="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-lg border ${config.darkBadgeBg}">
                                        ${config.label}
                                    </span>
                                    <span class="text-[9px] font-semibold text-indigo-400">${timeAgo}</span>
                                </div>
                                <p class="text-xs font-bold text-white group-hover:text-cyan-300 transition leading-snug line-clamp-2">
                                    ${safeTitle}
                                </p>
                                <p class="text-[11px] text-slate-300/80 mt-0.5 line-clamp-2 leading-tight">
                                    ${safeMessage}
                                </p>
                            </div>

                            <div class="flex-shrink-0 self-center text-indigo-500 group-hover:text-cyan-400 transition ml-auto">
                                <i class="fas fa-chevron-right text-[10px]"></i>
                            </div>
                        </a>
                    `;
                } else {
                    // Light theme for Student & Admin panels
                    html += `
                        <a href="${navigateUrl}" 
                           class="flex items-start gap-3.5 p-3.5 rounded-xl transition group relative cursor-pointer border ${isUnread ? 'bg-blue-50/70 border-blue-200 shadow-sm' : 'bg-white hover:bg-slate-50 border-slate-200'}">
                            ${isUnread ? '<span class="absolute top-3 right-3 w-2 h-2 rounded-full bg-blue-600"></span>' : ''}

                            <div class="flex-shrink-0 mt-0.5">
                                ${safePic ? `
                                    <img src="/profile_uploads/${safePic}" class="w-9 h-9 rounded-xl object-cover ring-1 ring-slate-200 group-hover:ring-blue-400 transition" onerror="this.src='/profile_uploads/default_avatar.png'">
                                ` : `
                                    <div class="w-9 h-9 rounded-xl ${config.iconBg} flex items-center justify-center">
                                        <i class="fas ${config.icon} text-sm"></i>
                                    </div>
                                `}
                            </div>

                            <div class="flex-1 min-w-0 pr-4">
                                <div class="flex items-center justify-between gap-2 mb-1">
                                    <span class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${config.badgeBg}">
                                        ${config.label}
                                    </span>
                                    <span class="text-[10px] text-slate-400 font-medium">${timeAgo}</span>
                                </div>
                                <p class="text-xs font-bold text-slate-800 group-hover:text-blue-600 transition leading-snug">
                                    ${safeTitle}
                                </p>
                                <p class="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-tight">
                                    ${safeMessage}
                                </p>
                            </div>

                            <div class="flex-shrink-0 self-center text-slate-300 group-hover:text-blue-600 transition ml-auto">
                                <i class="fas fa-chevron-right text-[10px]"></i>
                            </div>
                        </a>
                    `;
                }
            });

            list.innerHTML = html;
        },

        /**
         * Mark all notifications as read for current user.
         */
        markAllRead: async function(containerId, isDarkTheme = false) {
            try {
                const res = await fetch('/api/notifications/mark-all-read', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (res.ok) {
                    this.state.unreadCount = 0;
                    this.renderBadgeUI(0);
                    // Reload container to clear unread highlights
                    if (containerId) {
                        this.loadNotifications(containerId, isDarkTheme);
                    }
                }
            } catch (err) {
                console.error('[NotificationHub.markAllRead Error]', err);
            }
        },

        bindGlobalEvents: function() {
            // Re-check badge when user refocuses page
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) this.updateBadge();
            });
        }
    };

    // Auto-init on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => NotificationHub.init());
    } else {
        NotificationHub.init();
    }

    // Expose to window
    window.NotificationHub = NotificationHub;

})();
