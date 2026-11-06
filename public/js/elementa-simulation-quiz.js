/**
 * elementa-simulation-quiz.js
 * ============================================================================
 * Universal Dynamic Assessment Quiz Engine for Elementa Interactive Simulations.
 * 
 * Capabilities:
 * 1. Automatically checks active teacher custom quiz & EXP bonus availability.
 * 2. Injects the glowing "EXP Bonus" badge on the simulation's Assessment Quiz tab.
 * 3. Renders all 4 automated question types (MC, TF, Identification, Problem-Solving).
 * 4. Coordinates server-side grading, atomic EXP awards, and level progression.
 * 5. Reverts to built-in default questions (0 EXP) upon completion or expiration.
 * 6. Zero disruption to simulation canvas loops, WebGL, or physics engines.
 * ============================================================================
 */

(function (window, document) {
  'use strict';

  // Prevent multiple initializations
  if (window.__ELEMENTA_SIM_QUIZ_INIT__) return;
  window.__ELEMENTA_SIM_QUIZ_INIT__ = true;

  const BRIDGE_SOURCE = 'ELEMENTA_SIMULATION_BRIDGE';

  const SimulationQuizEngine = {
    simSlug: '',
    quizData: null,
    currentQIndex: 0,
    studentAnswers: {},
    defaultQuizHTML: '',
    hasActiveBonus: false,
    isSubmitting: false,

    init: function () {
      this.simSlug = this.detectSlug();
      console.log(`[SimulationQuizEngine] Initializing for slug: "${this.simSlug}"`);

      // Ensure DOM is ready before querying elements
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.bootstrap());
      } else {
        this.bootstrap();
      }
    },

    detectSlug: function () {
      if (window.ELEMENTA_SIM_SLUG) return String(window.ELEMENTA_SIM_SLUG).trim();
      const path = window.location.pathname;
      const match = path.match(/([a-zA-Z0-9_\-]+)_elementa\.html/i) || path.match(/([a-zA-Z0-9_\-]+)\.html/i);
      if (match) return match[1].toLowerCase();
      return 'build-an-atom';
    },

    bootstrap: async function () {
      this.injectStyles();
      this.backupDefaultQuiz();
      await this.checkQuizStatus();
    },

    injectStyles: function () {
      if (document.getElementById('elementa-sim-quiz-styles')) return;

      const style = document.createElement('style');
      style.id = 'elementa-sim-quiz-styles';
      style.textContent = `
        /* EXP Bonus Badge on Tab */
        .badge-exp-bonus {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-left: 8px;
          padding: 2px 8px;
          border-radius: 9999px;
          font-size: 0.68rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          background: linear-gradient(135deg, #f59e0b, #fbbf24);
          color: #0f172a;
          box-shadow: 0 0 12px rgba(245, 158, 11, 0.6);
          animation: pulseExpBadge 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          vertical-align: middle;
          pointer-events: none;
        }

        @keyframes pulseExpBadge {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
            box-shadow: 0 0 12px rgba(245, 158, 11, 0.6);
          }
          50% {
            opacity: 0.85;
            transform: scale(1.04);
            box-shadow: 0 0 20px rgba(245, 158, 11, 0.9);
          }
        }

        /* Custom Quiz Layout & Cards */
        #modalQuiz.modal-backdrop {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          padding: 16px !important;
          box-sizing: border-box !important;
        }

        #modalQuiz .modal-dialog {
          width: 100% !important;
          max-width: 680px !important;
          max-height: 88vh !important;
          display: flex !important;
          flex-direction: column !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
          margin: auto !important;
        }

        #modalQuiz .modal-header {
          flex-shrink: 0 !important;
        }

        #modalQuiz #quizBody {
          flex: 1 1 auto !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          padding: 18px 22px !important;
          box-sizing: border-box !important;
          max-height: calc(88vh - 75px) !important;
          width: 100% !important;
        }

        .esq-wrap {
          display: flex;
          flex-direction: column;
          gap: 14px;
          color: #e2e8f0;
          font-family: inherit;
          width: 100% !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
        }

        .esq-header-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(15, 23, 42, 0.7);
          border: 1px solid rgba(56, 189, 248, 0.25);
          border-radius: 12px;
          backdrop-blur: 8px;
        }

        .esq-badge-exp {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: rgba(245, 158, 11, 0.15);
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-radius: 8px;
          color: #fbbf24;
          font-size: 0.75rem;
          font-weight: 700;
        }

        .esq-progress-container {
          width: 100%;
          height: 6px;
          background: rgba(51, 65, 85, 0.5);
          border-radius: 9999px;
          overflow: hidden;
        }

        .esq-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #38bdf8, #818cf8, #f59e0b);
          transition: width 0.3s ease;
        }

        .esq-card {
          background: rgba(15, 23, 42, 0.85);
          border: 1px solid rgba(148, 163, 184, 0.15);
          border-radius: 16px;
          padding: 20px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
        }

        .esq-q-title {
          font-size: 1.05rem;
          font-weight: 700;
          color: #f8fafc;
          line-height: 1.5;
          margin-bottom: 18px;
        }

        /* Multiple Choice & True/False Buttons */
        .esq-options-grid {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .esq-option-btn {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 12px 16px;
          background: rgba(30, 41, 59, 0.6);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 12px;
          color: #e2e8f0;
          font-size: 0.9rem;
          font-weight: 500;
          text-align: left;
          cursor: pointer;
          transition: all 0.18s ease;
        }

        .esq-option-btn:hover {
          background: rgba(51, 65, 85, 0.7);
          border-color: rgba(56, 189, 248, 0.5);
          transform: translateY(-1px);
        }

        .esq-option-btn.selected {
          background: rgba(14, 165, 233, 0.18);
          border-color: #38bdf8;
          color: #ffffff;
          box-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
        }

        .esq-opt-letter {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 8px;
          background: rgba(51, 65, 85, 0.8);
          color: #94a3b8;
          font-size: 0.75rem;
          font-weight: 700;
          flex-shrink: 0;
        }

        .esq-option-btn.selected .esq-opt-letter {
          background: #0284c7;
          color: #ffffff;
        }

        /* Identification & Problem-Solving Inputs */
        .esq-input-wrap {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .esq-text-input {
          width: 100%;
          padding: 14px 16px;
          background: rgba(30, 41, 59, 0.8);
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 12px;
          color: #ffffff;
          font-size: 0.95rem;
          font-family: inherit;
          outline: none;
          transition: all 0.2s ease;
        }

        .esq-text-input:focus {
          border-color: #38bdf8;
          box-shadow: 0 0 15px rgba(56, 189, 248, 0.35);
          background: rgba(15, 23, 42, 0.9);
        }

        .esq-input-hint {
          font-size: 0.75rem;
          color: #94a3b8;
        }

        /* Action Buttons Row */
        .esq-actions-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 20px;
          gap: 12px;
        }

        .esq-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 18px;
          border-radius: 12px;
          font-size: 0.86rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
          border: none;
        }

        .esq-btn-secondary {
          background: rgba(51, 65, 85, 0.6);
          color: #cbd5e1;
          border: 1px solid rgba(148, 163, 184, 0.2);
        }

        .esq-btn-secondary:hover:not(:disabled) {
          background: rgba(71, 85, 105, 0.8);
          color: #ffffff;
        }

        .esq-btn-primary {
          background: linear-gradient(135deg, #0ea5e9, #6366f1);
          color: #ffffff;
          box-shadow: 0 4px 14px rgba(14, 165, 233, 0.4);
        }

        .esq-btn-primary:hover:not(:disabled) {
          background: linear-gradient(135deg, #0284c7, #4f46e5);
          box-shadow: 0 6px 20px rgba(14, 165, 233, 0.6);
          transform: translateY(-1px);
        }

        .esq-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          transform: none !important;
        }

        /* Celebratory Results Screen */
        .esq-result-card {
          text-align: center;
          padding: 16px 12px;
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          width: 100% !important;
          box-sizing: border-box !important;
        }

        .esq-trophy-icon {
          font-size: 3rem;
          margin-bottom: 12px;
          display: inline-block;
          animation: floatTrophy 2s ease-in-out infinite;
        }

        @keyframes floatTrophy {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }

        .esq-result-title {
          font-size: 1.4rem;
          font-weight: 800;
          color: #ffffff;
          margin-bottom: 8px;
        }

        .esq-result-score {
          font-size: 1rem;
          color: #94a3b8;
          margin-bottom: 16px;
        }

        .esq-exp-gain-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 20px;
          border-radius: 9999px;
          background: linear-gradient(135deg, #f59e0b, #eab308);
          color: #0f172a;
          font-size: 1.1rem;
          font-weight: 900;
          box-shadow: 0 0 25px rgba(245, 158, 11, 0.6);
          margin-bottom: 24px;
        }

        .esq-breakdown-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          text-align: left;
          max-height: 280px;
          overflow-y: auto;
          margin-bottom: 20px;
          padding-right: 6px;
        }

        .esq-breakdown-item {
          padding: 12px 14px;
          border-radius: 10px;
          font-size: 0.82rem;
          line-height: 1.4;
        }

        .esq-breakdown-item.correct {
          background: rgba(16, 185, 129, 0.12);
          border: 1px solid rgba(16, 185, 129, 0.35);
          color: #6ee7b7;
        }

        .esq-breakdown-item.incorrect {
          background: rgba(244, 63, 94, 0.12);
          border: 1px solid rgba(244, 63, 94, 0.35);
          color: #fda4af;
        }
      `;
      document.head.appendChild(style);
    },

    backupDefaultQuiz: function () {
      const quizBody = document.getElementById('quizBody');
      if (quizBody && !this.defaultQuizHTML) {
        this.defaultQuizHTML = quizBody.innerHTML;
        window._defaultQuizBackup = this.defaultQuizHTML;
      }
    },

    checkQuizStatus: async function () {
      try {
        const response = await (window.fetch || fetch)(`/api/simulation/${encodeURIComponent(this.simSlug)}/quiz-status`, {
          credentials: 'include'
        });

        if (!response.ok) {
          console.warn('[SimulationQuizEngine] quiz-status request returned status:', response.status);
          return;
        }

        const data = await response.json();
        console.log('[SimulationQuizEngine] Quiz status received:', data);

        if (data.has_bonus && data.quiz && !data.already_completed && !data.is_expired) {
          this.hasActiveBonus = true;
          this.quizData = data.quiz;
          this.renderExpBonusBadge();
          this.attachTabInterceptor();
        } else {
          this.hasActiveBonus = false;
          this.removeExpBonusBadge();
          this.restoreDefaultQuiz();
        }
      } catch (err) {
        console.error('[SimulationQuizEngine.checkQuizStatus]', err);
      }
    },

    renderExpBonusBadge: function () {
      const btnQuiz = document.getElementById('btnModeQuiz') || 
                      document.querySelector('button[onclick*="quiz"]') ||
                      document.querySelector('button[onclick*="modalQuiz"]');

      if (!btnQuiz) return;

      let badge = btnQuiz.querySelector('#expBonusBadge');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'expBonusBadge';
        badge.className = 'badge-exp-bonus';
        badge.innerHTML = `<span>⚡</span> EXP Bonus`;
        btnQuiz.appendChild(badge);
      }
    },

    removeExpBonusBadge: function () {
      const badge = document.getElementById('expBonusBadge') || 
                    document.querySelector('#expBonusBadge') ||
                    (document.getElementById('btnModeQuiz') && document.getElementById('btnModeQuiz').querySelector('#expBonusBadge'));
      if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    },

    attachTabInterceptor: function () {
      const btnQuiz = document.getElementById('btnModeQuiz') || 
                      document.querySelector('button[onclick*="quiz"]') ||
                      document.querySelector('button[onclick*="modalQuiz"]');

      if (!btnQuiz) return;

      btnQuiz.addEventListener('click', () => {
        if (this.hasActiveBonus && this.quizData) {
          // Allow existing modal open trigger, then inject custom quiz markup
          setTimeout(() => this.renderCustomQuizView(), 50);
        }
      });
    },

    restoreDefaultQuiz: function () {
      const quizBody = document.getElementById('quizBody');
      if (quizBody && this.defaultQuizHTML) {
        quizBody.innerHTML = this.defaultQuizHTML;
      }
      // Restore native modal-footer in default practice mode
      const modalDialog = quizBody ? (quizBody.closest('.modal-dialog') || quizBody.closest('.modal-backdrop') || document.getElementById('modalQuiz')) : null;
      if (modalDialog) {
        const footer = modalDialog.querySelector('.modal-footer');
        if (footer) footer.style.display = '';
      }
      // Re-initialize native dynamic quiz engine if defined in the simulation
      if (typeof window.initQuiz === 'function') {
        try { window.initQuiz(); } catch (e) {}
      } else if (typeof window.renderQuiz === 'function') {
        try { window.renderQuiz(); } catch (e) {}
      } else if (typeof window.buildQuizUI === 'function') {
        try { window.buildQuizUI(); } catch (e) {}
      }
    },

    renderCustomQuizView: function () {
      const quizBody = document.getElementById('quizBody');
      if (!quizBody || !this.quizData) return;

      // Hide external native modal-footer while custom quiz is active to eliminate duplicate/overlapping buttons
      const modalDialog = quizBody.closest('.modal-dialog') || quizBody.closest('.modal-backdrop') || document.getElementById('modalQuiz');
      if (modalDialog) {
        const footer = modalDialog.querySelector('.modal-footer');
        if (footer) footer.style.display = 'none';
      }

      const q = this.quizData.questions[this.currentQIndex];
      if (!q) return;

      const totalQ = this.quizData.questions.length;
      const progressPct = Math.round(((this.currentQIndex + 1) / totalQ) * 100);
      const studentAns = this.studentAnswers[q.question_id] !== undefined ? this.studentAnswers[q.question_id] : '';

      let optionsMarkup = '';
      if (q.question_type === 'multiple_choice') {
        const letters = ['A', 'B', 'C', 'D', 'E'];
        optionsMarkup = `
          <div class="esq-options-grid">
            ${(q.options || []).map((opt, idx) => `
              <button type="button" class="esq-option-btn ${parseInt(studentAns, 10) === idx ? 'selected' : ''}"
                      onclick="window.SimulationQuizEngine.selectChoice(${q.question_id}, ${idx})">
                <span class="esq-opt-letter">${letters[idx] || (idx + 1)}</span>
                <span>${opt}</span>
              </button>
            `).join('')}
          </div>
        `;
      } else if (q.question_type === 'true_false') {
        const isTrueSelected = String(studentAns).toLowerCase() === 'true';
        const isFalseSelected = String(studentAns).toLowerCase() === 'false';
        optionsMarkup = `
          <div class="esq-options-grid" style="flex-direction: row; gap: 14px;">
            <button type="button" class="esq-option-btn ${isTrueSelected ? 'selected' : ''}" style="flex: 1;"
                    onclick="window.SimulationQuizEngine.selectChoice(${q.question_id}, 'true')">
              <span class="esq-opt-letter" style="color: #34d399;">✓</span>
              <span>True</span>
            </button>
            <button type="button" class="esq-option-btn ${isFalseSelected ? 'selected' : ''}" style="flex: 1;"
                    onclick="window.SimulationQuizEngine.selectChoice(${q.question_id}, 'false')">
              <span class="esq-opt-letter" style="color: #f87171;">✕</span>
              <span>False</span>
            </button>
          </div>
        `;
      } else if (q.question_type === 'identification') {
        optionsMarkup = `
          <div class="esq-input-wrap">
            <input type="text" class="esq-text-input" id="esqInputId"
                   value="${this.escapeHtml(studentAns)}"
                   placeholder="Type your chemical term or name..."
                   oninput="window.SimulationQuizEngine.saveTextInput(${q.question_id}, this.value)"
                   onkeydown="if(event.key === 'Enter'){ event.preventDefault(); window.SimulationQuizEngine.handleEnterKey(); }" />
            <span class="esq-input-hint">Exact term (case-insensitive, common synonyms accepted).</span>
          </div>
        `;
      } else if (q.question_type === 'problem_solving') {
        optionsMarkup = `
          <div class="esq-input-wrap">
            <input type="text" class="esq-text-input" id="esqInputProb"
                   value="${this.escapeHtml(studentAns)}"
                   placeholder="Enter numerical solution (e.g. 298.15)..."
                   oninput="window.SimulationQuizEngine.saveTextInput(${q.question_id}, this.value)"
                   onkeydown="if(event.key === 'Enter'){ event.preventDefault(); window.SimulationQuizEngine.handleEnterKey(); }" />
            <span class="esq-input-hint">Numerical calculation within standard tolerance (e.g. ±1%).</span>
          </div>
        `;
      }

      quizBody.innerHTML = `
        <div class="esq-wrap">
          <!-- Header Banner -->
          <div class="esq-header-banner">
            <div>
              <div style="font-size: 0.85rem; font-weight: 700; color: #38bdf8;">${this.quizData.title}</div>
              <div style="font-size: 0.72rem; color: #94a3b8;">Question ${this.currentQIndex + 1} of ${totalQ}</div>
            </div>
            <div class="esq-badge-exp">
              <span>⚡</span> +${this.quizData.total_bonus_exp} EXP Bonus
            </div>
          </div>

          <!-- Progress Bar -->
          <div class="esq-progress-container">
            <div class="esq-progress-bar" style="width: ${progressPct}%;"></div>
          </div>

          <!-- Question Card -->
          <div class="esq-card">
            <div class="esq-q-title">${q.question_text}</div>
            ${optionsMarkup}

            <!-- Navigation Actions -->
            <div class="esq-actions-row">
              <button type="button" class="esq-btn esq-btn-secondary"
                      ${this.currentQIndex === 0 ? 'disabled' : ''}
                      onclick="window.SimulationQuizEngine.prevQuestion()">
                ← Back
              </button>

              ${this.currentQIndex < totalQ - 1 ? `
                <button type="button" class="esq-btn esq-btn-primary"
                        onclick="window.SimulationQuizEngine.nextQuestion()">
                  Next Question →
                </button>
              ` : `
                <button type="button" class="esq-btn esq-btn-primary" style="background: linear-gradient(135deg, #10b981, #059669);"
                        ${this.isSubmitting ? 'disabled' : ''}
                        onclick="window.SimulationQuizEngine.submitAssessment()">
                  ${this.isSubmitting ? 'Grading...' : 'Submit Assessment Quiz 🚀'}
                </button>
              `}
            </div>
          </div>
        </div>
      `;
    },

    selectChoice: function (qId, choiceVal) {
      this.studentAnswers[qId] = choiceVal;
      this.renderCustomQuizView();
    },

    saveTextInput: function (qId, val) {
      this.studentAnswers[qId] = val;
    },

    handleEnterKey: function () {
      if (!this.quizData) return;
      const totalQ = this.quizData.questions.length;
      if (this.currentQIndex < totalQ - 1) {
        this.nextQuestion();
      } else {
        this.submitAssessment();
      }
    },

    prevQuestion: function () {
      if (this.currentQIndex > 0) {
        this.currentQIndex--;
        this.renderCustomQuizView();
      }
    },

    nextQuestion: function () {
      if (this.currentQIndex < this.quizData.questions.length - 1) {
        this.currentQIndex++;
        this.renderCustomQuizView();
      }
    },

    submitAssessment: async function () {
      if (this.isSubmitting) return;

      // Ensure all answers mapped to list
      const answersPayload = Object.keys(this.studentAnswers).map(qid => ({
        question_id: parseInt(qid, 10),
        answer: this.studentAnswers[qid]
      }));

      this.isSubmitting = true;
      this.renderCustomQuizView();

      try {
        const response = await (window.fetch || fetch)(`/api/simulation/${encodeURIComponent(this.simSlug)}/quiz-submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            quiz_id: this.quizData.quiz_id,
            answers: answersPayload
          })
        });

        const result = await response.json();
        console.log('[SimulationQuizEngine] Submission graded:', result);

        if (result.success) {
          this.renderCelebration(result);

          // Notify LMS Host Bridge
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              source: BRIDGE_SOURCE,
              action: 'QUIZ_RESULT',
              success: true,
              simSlug: this.simSlug,
              ...result
            }, '*');
          }

          // Mark bonus completed and remove badge
          this.hasActiveBonus = false;
          this.removeExpBonusBadge();
        } else {
          alert(result.message || result.error || 'Failed to submit quiz.');
          this.isSubmitting = false;
          this.renderCustomQuizView();
        }
      } catch (err) {
        console.error('[SimulationQuizEngine.submitAssessment]', err);
        alert('Network error while submitting assessment. Please check your connection.');
        this.isSubmitting = false;
        this.renderCustomQuizView();
      }
    },

    renderCelebration: function (res) {
      const quizBody = document.getElementById('quizBody');
      if (!quizBody) return;

      // Ensure native modal footer remains hidden during celebration view
      const modalDialog = quizBody.closest('.modal-dialog') || quizBody.closest('.modal-backdrop') || document.getElementById('modalQuiz');
      if (modalDialog) {
        const footer = modalDialog.querySelector('.modal-footer');
        if (footer) footer.style.display = 'none';
      }

      quizBody.innerHTML = `
        <div class="esq-wrap">
          <div class="esq-card esq-result-card">
            <div class="esq-trophy-icon">🏆</div>
            <div class="esq-result-title">Assessment Quiz Completed!</div>
            <div class="esq-result-score">
              Score: <strong>${res.correct_questions} / ${res.total_questions}</strong> (${res.percentage}%)
            </div>

            <div class="esq-exp-gain-pill">
              ⚡ +${res.exp_awarded} EXP Earned!
            </div>

            <div class="esq-breakdown-list">
              ${(res.breakdowns || []).map((b, idx) => {
                let ans = b.student_answer_display;
                if (!ans) {
                  if (b.student_answer !== null && b.student_answer !== undefined && String(b.student_answer).trim() !== '') {
                    const letters = ['A', 'B', 'C', 'D', 'E'];
                    const sIdx = parseInt(b.student_answer, 10);
                    if (b.question_type === 'multiple_choice' && !isNaN(sIdx) && sIdx >= 0 && sIdx < 5) {
                      const optText = (b.options_json && b.options_json[sIdx]) ? ` (${b.options_json[sIdx]})` : '';
                      ans = `Option ${letters[sIdx] || (sIdx + 1)}${optText}`;
                    } else if (b.question_type === 'true_false') {
                      const sBool = String(b.student_answer).trim().toLowerCase();
                      ans = (sBool === 'true' || sBool === '1') ? 'True' : 'False';
                    } else {
                      ans = String(b.student_answer).trim();
                    }
                  } else {
                    ans = 'No answer';
                  }
                }
                return `
                <div class="esq-breakdown-item ${b.is_correct ? 'correct' : 'incorrect'}">
                  <div><strong>Question ${idx + 1}:</strong> ${this.escapeHtml(b.question_text)}</div>
                  <div style="margin-top: 3px;">Your Answer: <em>${this.escapeHtml(ans)}</em> (${b.is_correct ? '✓ Correct' : '✕ Incorrect'})</div>
                  ${b.explanation ? `<div style="font-size:0.75rem; margin-top:4px; opacity:0.85;">ℹ️ ${this.escapeHtml(b.explanation)}</div>` : ''}
                </div>
              `;
              }).join('')}
            </div>

            <button type="button" class="esq-btn esq-btn-primary" style="width: 100%;"
                    onclick="window.SimulationQuizEngine.closeAndRestoreDefault()">
              Resume Interactive Lab Experiment
            </button>
          </div>
        </div>
      `;
    },

    closeAndRestoreDefault: function () {
      // Close modal if close function exists
      if (typeof window.closeModal === 'function') {
        window.closeModal('modalQuiz');
      } else if (typeof window.setAppMode === 'function') {
        window.setAppMode('sim');
      }

      // Revert #quizBody permanently to built-in default questions (0 EXP)
      this.restoreDefaultQuiz();
    },

    escapeHtml: function (str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  };

  // Expose to window
  window.SimulationQuizEngine = SimulationQuizEngine;
  SimulationQuizEngine.init();

})(window, document);
