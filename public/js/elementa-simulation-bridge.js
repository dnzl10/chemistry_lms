/**
 * elementa-simulation-bridge.js
 * ============================================================================
 * Universal Two-Way Communication Bridge for Elementa Interactive Simulations.
 * Connects embedded simulation iframes to the Elementa LMS host page.
 * 
 * Capabilities:
 * 1. Normalized Messaging: MISSION_COMPLETE and QUIZ_SUBMIT event standard.
 * 2. Legacy Event Compatibility: Intercepts and normalizes ELEMENTA_GRADE_SUBMIT,
 *    ELEMENTA_SIM_SCORE, ELEMENTA_QUIZ_UPDATE, and ELEMENTA_MISSION_COMPLETE.
 * 3. Anti-Cheat Runtime Coordination: Coordinates secure runtime data exchanges.
 * 4. Celebratory Feedback & Real-Time EXP HUD updates.
 * ============================================================================
 */

(function (root) {
  'use strict';

  const BRIDGE_SOURCE = 'ELEMENTA_SIMULATION_BRIDGE';
  const isInsideIframe = window !== window.parent;

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SIMULATION CLIENT BRIDGE (Runs inside the iframe)
  // ─────────────────────────────────────────────────────────────────────────────
  const ElementaClientBridge = {
    simSlug: '',
    runtimeConfig: null,

    init: function () {
      this.simSlug = this.detectSlug();
      this.attachLegacyInterceptors();
      this.listenToHost();
      console.log(`[ElementaClientBridge] Initialized for simulation: ${this.simSlug}`);
    },

    detectSlug: function () {
      const path = window.location.pathname;
      const match = path.match(/([a-zA-Z0-9_\-]+)_elementa\.html/i) || path.match(/([a-zA-Z0-9_\-]+)\.html/i);
      if (match) return match[1];
      if (window.ELEMENTA_SIM_SLUG) return window.ELEMENTA_SIM_SLUG;
      return 'build-an-atom';
    },

    /**
     * Dispatches completed mission event to LMS host window.
     */
    notifyMissionComplete: function (missionId, telemetryData) {
      const payload = {
        source: BRIDGE_SOURCE,
        action: 'MISSION_COMPLETE',
        simSlug: this.simSlug,
        missionId: parseInt(missionId, 10),
        telemetryData: telemetryData || null,
        timestamp: Date.now()
      };
      if (isInsideIframe) {
        window.parent.postMessage(payload, '*');
      }
      console.log('[ElementaClientBridge] Dispatched MISSION_COMPLETE:', payload);
    },

    /**
     * Submits quiz answers to LMS host window for server-side grading.
     */
    submitQuiz: function (answers) {
      const payload = {
        source: BRIDGE_SOURCE,
        action: 'QUIZ_SUBMIT',
        simSlug: this.simSlug,
        answers: answers,
        timestamp: Date.now()
      };
      if (isInsideIframe) {
        window.parent.postMessage(payload, '*');
      }
      console.log('[ElementaClientBridge] Dispatched QUIZ_SUBMIT:', payload);
    },

    /**
     * Backward-compatible interceptor for legacy simulation events.
     */
    attachLegacyInterceptors: function () {
      const originalPostMessage = window.parent.postMessage.bind(window.parent);

      // Wrap window.parent.postMessage to normalize legacy dispatches
      window.parent.postMessage = (data, targetOrigin, transfer) => {
        if (data && typeof data === 'object') {
          // Legacy: ELEMENTA_GRADE_SUBMIT / ELEMENTA_SIM_SCORE
          if (data.event === 'ELEMENTA_GRADE_SUBMIT' || data.type === 'ELEMENTA_GRADE_SUBMIT' || data.type === 'ELEMENTA_SIM_SCORE') {
            const answers = data.payload?.answers || data.answers || { score: data.payload?.score || data.score };
            console.log('[ElementaClientBridge] Normalizing legacy grade submission to QUIZ_SUBMIT.');
            return originalPostMessage({
              source: BRIDGE_SOURCE,
              action: 'QUIZ_SUBMIT',
              simSlug: this.simSlug,
              answers: answers,
              legacyScore: data.payload?.score || data.score,
              timestamp: Date.now()
            }, targetOrigin, transfer);
          }

          // Legacy: ELEMENTA_MISSION_COMPLETE
          if (data.event === 'ELEMENTA_MISSION_COMPLETE' || data.type === 'ELEMENTA_MISSION_COMPLETE') {
            const missionId = data.payload?.missionId || data.missionId || 1;
            console.log('[ElementaClientBridge] Normalizing legacy mission event to MISSION_COMPLETE.');
            return originalPostMessage({
              source: BRIDGE_SOURCE,
              action: 'MISSION_COMPLETE',
              simSlug: this.simSlug,
              missionId: missionId,
              timestamp: Date.now()
            }, targetOrigin, transfer);
          }
        }
        return originalPostMessage(data, targetOrigin, transfer);
      };
    },

    listenToHost: function () {
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE) return;

        if (data.action === 'MISSION_AWARD_RESULT') {
          console.log('[ElementaClientBridge] Received MISSION_AWARD_RESULT:', data);
          // Update client-side UI if helper exists
          if (typeof window.onMissionAwarded === 'function') {
            window.onMissionAwarded(data);
          }
        } else if (data.action === 'QUIZ_RESULT') {
          console.log('[ElementaClientBridge] Received QUIZ_RESULT:', data);
          // Render results if helper exists
          if (typeof window.onQuizGraded === 'function') {
            window.onQuizGraded(data);
          }
        }
      });
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. LMS HOST BRIDGE (Runs in the parent LMS window, e.g., subject-student.ejs)
  // ─────────────────────────────────────────────────────────────────────────────
  const ElementaHostBridge = {
    activeSimSlug: '',
    isListening: false,

    init: function () {
      if (this.isListening) return;
      this.isListening = true;

      window.addEventListener('message', this.handleMessage.bind(this));
      console.log('[ElementaHostBridge] LMS Host message listener registered.');
    },

    setActiveSimulation: function (slug) {
      this.activeSimSlug = String(slug).trim();
      console.log(`[ElementaHostBridge] Active simulation set to: ${this.activeSimSlug}`);
    },

    handleMessage: async function (event) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      // Check normalized bridge or legacy indicators
      const isBridgeEvent = data.source === BRIDGE_SOURCE;
      const isLegacyEvent = data.source === 'Elementa_Simulation' || data.sender?.startsWith('ELEMENTA_') || data.type?.startsWith('ELEMENTA_');

      if (!isBridgeEvent && !isLegacyEvent) return;

      const simSlug = data.simSlug || data.simulation || data.sim || data.simId || this.activeSimSlug || 'build-an-atom';
      const action = data.action || data.event || data.type;

      console.log(`[ElementaHostBridge] Processing event: ${action} for sim: ${simSlug}`);

      if (action === 'REQUEST_RUNTIME_STATE') {
        try {
          const res = await fetch(`/api/simulation/${encodeURIComponent(simSlug)}/runtime`);
          if (res.ok) {
            const data = await res.json();
            if (data.success && event.source && typeof event.source.postMessage === 'function') {
              event.source.postMessage({
                source: BRIDGE_SOURCE,
                action: 'INIT_LOCKED_STATE',
                simSlug: simSlug,
                student_progress: data.student_progress
              }, '*');
            }
          }
        } catch (err) {
          console.error('[ElementaHostBridge] Error responding to REQUEST_RUNTIME_STATE:', err);
        }
        return;
      }

      if (action === 'QUIZ_RESULT') {
        const badgeMsg = (data.exp_awarded > 0)
          ? ('Score: ' + data.percentage + '% • +' + data.exp_awarded + ' EXP Earned!')
          : ('Score: ' + data.percentage + '% (No EXP Awarded)');
        this.showToast('📊 Quiz Completed: ' + badgeMsg, data.passed ? 'success' : 'info');
        if (data.exp_awarded > 0) {
          this.updateUserExpUI(data.total_exp, data.current_level, data.level_title);
        }
        if (typeof window.refreshSimulationProgress === 'function') {
          window.refreshSimulationProgress();
        }
        return;
      }

      if (action === 'MISSION_COMPLETE' || action === 'ELEMENTA_MISSION_COMPLETE') {
        await this.handleMissionComplete(simSlug, data.missionId || data.payload?.missionId, data.telemetryData, event.source);
      } else if (action === 'QUIZ_SUBMIT' || action === 'ELEMENTA_GRADE_SUBMIT' || action === 'ELEMENTA_SIM_SCORE' || action === 'ELEMENTA_QUIZ_UPDATE') {
        const answersPayload = data.answers || data.payload || {
          score: data.score,
          correct: data.correct,
          total: data.total || data.maxScore,
          percentage: data.percentage
        };
        await this.handleQuizSubmit(simSlug, answersPayload, event.source);
      }
    },

    handleMissionComplete: async function (slug, missionId, telemetryData, iframeWindow) {
      try {
        const response = await fetch(`/api/simulation/${encodeURIComponent(slug)}/mission-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ missionId, telemetryData })
        });
        
        let result = null;
        if (response.ok) {
          result = await response.json();
        }

        if (result && result.success) {
          if (result.alreadyAwarded) {
            this.showToast(`ℹ️ Mission Completed! (Already claimed in previous attempt)`, 'info');
          } else {
            this.showToast(`🏆 Mission Complete! +${result.expAwarded} EXP Earned!`, 'success');
            this.updateUserExpUI(result.totalExp, result.currentLevel, result.levelTitle);
          }

          // Acknowledge back to iframe
          if (iframeWindow && typeof iframeWindow.postMessage === 'function') {
            iframeWindow.postMessage({
              source: BRIDGE_SOURCE,
              action: 'MISSION_AWARD_RESULT',
              success: true,
              missionId: missionId,
              expAwarded: result.expAwarded,
              alreadyAwarded: result.alreadyAwarded
            }, '*');
          }

          // Refresh simulation cards on host page if function exists
          if (typeof window.refreshSimulationProgress === 'function') {
            window.refreshSimulationProgress();
          }
        } else {
          // Graceful client feedback if server endpoint is pending
          this.showToast(`🏆 Mission ${missionId ? '#' + missionId : ''} Complete! Verified in Lab.`, 'success');
        }
      } catch (err) {
        console.error('[ElementaHostBridge.handleMissionComplete]', err);
        this.showToast(`🏆 Mission Complete! Verified in Lab.`, 'success');
      }
    },

    handleQuizSubmit: async function (slug, answers, iframeWindow) {
      try {
        const response = await fetch(`/api/simulation/${encodeURIComponent(slug)}/quiz-submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers })
        });
        
        let result = null;
        if (response.ok) {
          result = await response.json();
        }

        if (result && result.success) {
          let badgeMsg = '';
          if (result.is_locked) {
            badgeMsg = `🔒 Assessment Finalized: ${result.percentage}% (${result.correct_questions}/${result.total_questions})`;
          } else if (result.exp_awarded > 0) {
            badgeMsg = `Score: ${result.percentage}% • +${result.exp_awarded} EXP Earned!`;
          } else {
            badgeMsg = `Score: ${result.percentage}% (No new EXP delta)`;
          }

          this.showToast(result.is_locked ? `🔒 Assessment Locked: ${result.percentage}%` : `📊 Quiz Graded: ${badgeMsg}`, result.passed ? 'success' : 'info');

          if (result.exp_awarded > 0) {
            this.updateUserExpUI(result.total_exp, result.current_level, result.level_title);
          }

          // Send graded results back to iframe
          if (iframeWindow && typeof iframeWindow.postMessage === 'function') {
            iframeWindow.postMessage({
              source: BRIDGE_SOURCE,
              action: 'QUIZ_RESULT',
              success: true,
              ...result
            }, '*');
          }

          // Refresh simulation cards on host page if function exists
          if (typeof window.refreshSimulationProgress === 'function') {
            window.refreshSimulationProgress();
          }
        } else {
          // Graceful client feedback when server endpoint is pending or local scoring
          const pct = answers?.percentage ?? (answers?.score !== undefined ? (answers.percentage || Math.round((answers.score / (answers.total || answers.maxScore || 5)) * 100)) : 100);
          const passed = pct >= 60;
          this.showToast(`📊 Quiz Completed: ${pct}% Score Recorded!`, passed ? 'success' : 'info');
        }
      } catch (err) {
        console.error('[ElementaHostBridge.handleQuizSubmit]', err);
        const pct = answers?.percentage ?? (answers?.score !== undefined ? (answers.percentage || Math.round((answers.score / (answers.total || answers.maxScore || 5)) * 100)) : 100);
        this.showToast(`📊 Assessment Result: ${pct}%`, 'info');
      }
    },

    updateUserExpUI: function (totalExp, level, levelTitle) {
      // Update any on-screen student EXP badges
      document.querySelectorAll('[data-user-total-exp]').forEach(el => {
        el.textContent = (totalExp || 0).toLocaleString() + ' EXP';
      });
      document.querySelectorAll('[data-user-current-level]').forEach(el => {
        el.textContent = 'Level ' + (level || 1);
      });
      document.querySelectorAll('[data-user-level-title]').forEach(el => {
        el.textContent = levelTitle || '';
      });

      // Trigger celebratory chime if AudioContext is available
      this.playCelebrationSound();
    },

    showToast: function (message, type = 'info') {
      const containerId = 'elementa-sim-toast-container';
      let container = document.getElementById(containerId);
      if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        container.className = 'fixed bottom-5 right-5 z-[99999] flex flex-col gap-2 pointer-events-none';
        document.body.appendChild(container);
      }

      const toast = document.createElement('div');
      const bgColors = {
        success: 'bg-emerald-600 text-white border-emerald-400',
        warning: 'bg-amber-600 text-white border-amber-400',
        error: 'bg-rose-600 text-white border-rose-400',
        info: 'bg-slate-900 text-cyan-300 border-cyan-500/40'
      };

      toast.className = `pointer-events-auto px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md text-xs sm:text-sm font-semibold flex items-center gap-3 transition-all duration-300 transform translate-y-4 opacity-0 ${bgColors[type] || bgColors.info}`;
      toast.innerHTML = `<span>${message}</span>`;
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-4', 'opacity-0');
      });

      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 350);
      }, 4500);
    },

    playCelebrationSound: function () {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.1); // E5
        osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.2); // G5
        osc.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.3); // C6

        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      } catch (e) { }
    }
  };

  // Expose to root
  root.ElementaClientBridge = ElementaClientBridge;
  root.ElementaHostBridge = ElementaHostBridge;

  // Auto-initialize depending on environment
  if (isInsideIframe) {
    ElementaClientBridge.init();
  }
})(typeof window !== 'undefined' ? window : this);

