/**
 * SoundManager & Focus Mode Controller
 * Provides client-side audio cues (Web Audio API synthesis & HTML5 Audio)
 * and Focus Mode state management with localStorage persistence.
 */

(function() {
    'use strict';

    const STORAGE_FOCUS = 'elementa_focus_mode';
    const STORAGE_PACK  = 'elementa_sound_pack';

    let audioCtx = null;

    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    // Synthesized Audio Themes via Web Audio API (Zero external file dependencies)
    function playTone(freq, type, duration, delay = 0, gainLevel = 0.15) {
        const ctx = getAudioContext();
        if (!ctx) return;

        const startTime = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, startTime);

        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.exponentialRampToValueAtTime(gainLevel, startTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + duration);
    }

    const soundThemes = {
        'soft': () => {
            // Gentle double chime (E5 -> B5)
            playTone(659.25, 'sine', 0.35, 0, 0.12);
            playTone(987.77, 'sine', 0.45, 0.12, 0.10);
        },
        'modern': () => {
            // High-tech triangle chime (A5 -> C#6 -> E6)
            playTone(880.00, 'triangle', 0.20, 0, 0.15);
            playTone(1108.73, 'triangle', 0.22, 0.08, 0.15);
            playTone(1318.51, 'sine', 0.35, 0.16, 0.12);
        },
        'pop': () => {
            // Warm rounded pop
            playTone(523.25, 'sine', 0.15, 0, 0.20);
        },
        'mute': () => {
            /* Silent */
        }
    };

    const SoundManager = {
        isFocusMode() {
            return localStorage.getItem(STORAGE_FOCUS) === 'true';
        },

        setFocusMode(enable) {
            localStorage.setItem(STORAGE_FOCUS, enable ? 'true' : 'false');
            this.applyFocusModeStyles(enable);
            this.syncFocusModeInputs(enable);
        },

        toggleFocusMode() {
            const next = !this.isFocusMode();
            this.setFocusMode(next);
            return next;
        },

        getSoundPack() {
            return localStorage.getItem(STORAGE_PACK) || 'soft';
        },

        setSoundPack(themeKey) {
            if (soundThemes[themeKey] || themeKey === 'mute') {
                localStorage.setItem(STORAGE_PACK, themeKey);
                if (themeKey !== 'mute' && !this.isFocusMode()) {
                    this.playSound(themeKey);
                }
            }
        },

        playSound(themeOverride = null) {
            if (this.isFocusMode()) return; // Focus mode suppresses all audio cues

            const theme = themeOverride || this.getSoundPack();
            if (theme === 'mute') return;

            try {
                if (soundThemes[theme]) {
                    soundThemes[theme]();
                } else {
                    soundThemes['soft']();
                }
            } catch (err) {
                console.warn('[SoundManager Audio Error]:', err);
            }
        },

        applyFocusModeStyles(active) {
            if (active) {
                document.documentElement.classList.add('focus-mode-enabled');
            } else {
                document.documentElement.classList.remove('focus-mode-enabled');
            }
        },

        syncFocusModeInputs(active) {
            document.querySelectorAll('.focus-mode-toggle').forEach(el => {
                if (el.type === 'checkbox') {
                    el.checked = active;
                }
                const label = el.closest('.focus-mode-container')?.querySelector('.focus-mode-label');
                if (label) {
                    label.textContent = active ? 'Focus Mode ON' : 'Focus Mode OFF';
                }
            });
        },

        init() {
            // Apply initial focus mode state
            const focus = this.isFocusMode();
            this.applyFocusModeStyles(focus);
            this.syncFocusModeInputs(focus);

            // Inject CSS for Focus Mode badge & animation suppression
            if (!document.getElementById('focus-mode-styles')) {
                const style = document.createElement('style');
                style.id = 'focus-mode-styles';
                style.textContent = `
                    .focus-mode-enabled .notif-badge,
                    .focus-mode-enabled .notif-counter,
                    .focus-mode-enabled [data-focus-hide="true"] {
                        display: none !important;
                    }
                    .focus-mode-pill-active {
                        background: #3b82f6 !important;
                        color: #ffffff !important;
                    }
                `;
                document.head.appendChild(style);
            }

            // Bind any toggle switches in DOM
            document.querySelectorAll('.focus-mode-toggle').forEach(el => {
                el.addEventListener('change', (e) => {
                    this.setFocusMode(e.target.checked);
                });
            });
        }
    };

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => SoundManager.init());
    } else {
        SoundManager.init();
    }

    window.SoundManager = SoundManager;
})();
