/**
 * Zero-Click High-Speed Grading Keyboard Hotkeys Manager
 */
(function () {
    class GradingHotkeysManager {
        constructor(callbacks = {}) {
            this.callbacks = Object.assign({
                onNextStudent: () => {},
                onPrevStudent: () => {},
                onScoreRubric: (level) => {},
                onFocusFeedback: () => {},
                onSaveAndAdvance: () => {},
                onToggleHelp: () => {}
            }, callbacks);

            this.enabled = true;
            this.activeRubricCriterionIndex = 0;
            this.init();
        }

        init() {
            window.addEventListener('keydown', (e) => this.handleKey(e));
            this.createCheatSheetModal();
        }

        handleKey(e) {
            if (!this.enabled) return;

            const target = e.target;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            // Cheat sheet shortcut '?'
            if (e.key === '?' && !isInput) {
                e.preventDefault();
                this.toggleCheatSheet();
                return;
            }

            // If inside textarea, Escape unfocuses
            if (isInput) {
                if (e.key === 'Escape') {
                    target.blur();
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    target.blur();
                    this.callbacks.onSaveAndAdvance();
                }
                return; // Don't trigger other hotkeys while typing text
            }

            switch (e.key) {
                case 'j':
                case 'J':
                case 'ArrowDown':
                    e.preventDefault();
                    this.callbacks.onNextStudent();
                    break;

                case 'k':
                case 'K':
                case 'ArrowUp':
                    e.preventDefault();
                    this.callbacks.onPrevStudent();
                    break;

                case 'c':
                case 'C':
                    e.preventDefault();
                    this.callbacks.onFocusFeedback();
                    break;

                case 'Enter':
                    e.preventDefault();
                    this.callbacks.onSaveAndAdvance();
                    break;

                case '1':
                case '2':
                case '3':
                case '4':
                case '5':
                    e.preventDefault();
                    this.callbacks.onScoreRubric(parseInt(e.key));
                    break;
            }
        }

        createCheatSheetModal() {
            const modal = document.createElement('div');
            modal.id = 'hotkeyCheatSheetModal';
            modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[99999] hidden flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-200">
                    <div class="p-5 border-b border-slate-100 flex items-center justify-between bg-indigo-50/50">
                        <div class="flex items-center gap-2">
                            <span class="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-black text-sm">⌨️</span>
                            <h3 class="font-extrabold text-slate-800 text-base">Grading Hotkeys Guide</h3>
                        </div>
                        <button onclick="document.getElementById('hotkeyCheatSheetModal').classList.add('hidden')" class="text-slate-400 hover:text-slate-600 font-bold p-1">&times;</button>
                    </div>
                    <div class="p-6 space-y-4 text-xs">
                        <div class="grid grid-cols-2 gap-3">
                            <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                                <span class="font-semibold text-slate-600">Next Student</span>
                                <kbd class="px-2 py-1 bg-white rounded-md shadow-sm border border-slate-200 font-black text-indigo-600">J</kbd>
                            </div>
                            <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                                <span class="font-semibold text-slate-600">Previous Student</span>
                                <kbd class="px-2 py-1 bg-white rounded-md shadow-sm border border-slate-200 font-black text-indigo-600">K</kbd>
                            </div>
                            <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                                <span class="font-semibold text-slate-600">Rubric Levels</span>
                                <kbd class="px-2 py-1 bg-white rounded-md shadow-sm border border-slate-200 font-black text-indigo-600">1 – 5</kbd>
                            </div>
                            <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                                <span class="font-semibold text-slate-600">Focus Feedback</span>
                                <kbd class="px-2 py-1 bg-white rounded-md shadow-sm border border-slate-200 font-black text-indigo-600">C</kbd>
                            </div>
                            <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-100 col-span-2">
                                <span class="font-semibold text-slate-600">Commit Score & Advance</span>
                                <kbd class="px-3 py-1 bg-white rounded-md shadow-sm border border-slate-200 font-black text-indigo-600">Enter</kbd>
                            </div>
                        </div>
                        <p class="text-[11px] text-slate-400 italic text-center">Press <kbd class="font-bold text-slate-600">Esc</kbd> while typing feedback to return to keyboard navigation mode.</p>
                    </div>
                </div>
            `;
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
            document.body.appendChild(modal);
        }

        toggleCheatSheet() {
            const modal = document.getElementById('hotkeyCheatSheetModal');
            if (modal) modal.classList.toggle('hidden');
        }
    }

    window.GradingHotkeysManager = GradingHotkeysManager;
})();
