/**
 * Reusable Comment Bank & Keyboard Text Expander
 * Listens for slash commands (e.g. /cite, /units) in textareas and expands them.
 */
(function () {
    let snippetsCache = null;

    async function loadSnippets() {
        if (snippetsCache) return snippetsCache;
        try {
            const res = await fetch('/teacher/api/comment-bank');
            if (res.ok) {
                const data = await res.json();
                snippetsCache = data.snippets || [];
            }
        } catch (e) {
            console.warn('[TextExpander] Failed to load snippets:', e);
            snippetsCache = [];
        }
        return snippetsCache;
    }

    class TextExpander {
        constructor(textarea, options = {}) {
            this.textarea = textarea;
            this.options = options;
            this.activeMatch = null;
            this.selectedIndex = 0;
            this.menu = null;

            this.init();
        }

        async init() {
            this.snippets = await loadSnippets();
            this.createMenu();
            this.bindEvents();
        }

        createMenu() {
            this.menu = document.createElement('div');
            this.menu.className = 'absolute z-[9999] bg-white border border-slate-200 rounded-xl shadow-2xl p-1 w-80 max-h-64 overflow-y-auto hidden text-xs';
            document.body.appendChild(this.menu);
        }

        bindEvents() {
            this.textarea.addEventListener('input', () => this.handleInput());
            this.textarea.addEventListener('keydown', (e) => this.handleKeydown(e));
            this.textarea.addEventListener('blur', () => {
                setTimeout(() => this.hideMenu(), 200);
            });
        }

        handleInput() {
            const val = this.textarea.value;
            const cursorPos = this.textarea.selectionStart;
            const beforeCursor = val.slice(0, cursorPos);

            // Match last occurrence of /word
            const match = beforeCursor.match(/\/([a-zA-Z0-9_-]*)$/);

            if (match) {
                const query = match[1].toLowerCase();
                const matchedSnippets = this.snippets.filter(s =>
                    s.shortcut.toLowerCase().startsWith(query) ||
                    s.expanded_text.toLowerCase().includes(query)
                );

                if (matchedSnippets.length > 0) {
                    this.activeMatch = {
                        start: cursorPos - match[0].length,
                        end: cursorPos,
                        query
                    };
                    this.renderMenu(matchedSnippets);
                    this.positionMenu();
                    return;
                }
            }

            this.hideMenu();
        }

        renderMenu(matchedSnippets) {
            this.currentMatches = matchedSnippets;
            this.selectedIndex = Math.min(this.selectedIndex, matchedSnippets.length - 1);
            if (this.selectedIndex < 0) this.selectedIndex = 0;

            this.menu.innerHTML = matchedSnippets.map((s, idx) => `
                <div class="px-3 py-2 rounded-lg cursor-pointer flex flex-col gap-0.5 transition ${idx === this.selectedIndex ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'hover:bg-slate-50'}" data-index="${idx}">
                    <div class="flex items-center justify-between">
                        <span class="font-black text-indigo-700">/${s.shortcut}</span>
                        <span class="text-[10px] text-slate-400 font-bold uppercase">${s.category || 'General'}</span>
                    </div>
                    <p class="text-slate-600 truncate text-[11px] font-medium">${s.expanded_text}</p>
                </div>
            `).join('');

            // Click listener for menu items
            this.menu.querySelectorAll('[data-index]').forEach(el => {
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.applySnippet(this.currentMatches[parseInt(el.dataset.index)]);
                });
            });

            this.menu.classList.remove('hidden');
        }

        positionMenu() {
            const rect = this.textarea.getBoundingClientRect();
            this.menu.style.top = `${window.scrollY + rect.bottom + 4}px`;
            this.menu.style.left = `${window.scrollX + rect.left}px`;
        }

        hideMenu() {
            if (this.menu) this.menu.classList.add('hidden');
            this.activeMatch = null;
        }

        handleKeydown(e) {
            if (!this.menu || this.menu.classList.contains('hidden')) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedIndex = (this.selectedIndex + 1) % this.currentMatches.length;
                this.renderMenu(this.currentMatches);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedIndex = (this.selectedIndex - 1 + this.currentMatches.length) % this.currentMatches.length;
                this.renderMenu(this.currentMatches);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                if (this.currentMatches[this.selectedIndex]) {
                    this.applySnippet(this.currentMatches[this.selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                this.hideMenu();
            }
        }

        applySnippet(snippet) {
            if (!this.activeMatch) return;
            const val = this.textarea.value;
            const before = val.slice(0, this.activeMatch.start);
            const after = val.slice(this.activeMatch.end);

            this.textarea.value = before + snippet.expanded_text + ' ' + after;
            const newCursor = this.activeMatch.start + snippet.expanded_text.length + 1;
            this.textarea.setSelectionRange(newCursor, newCursor);
            this.textarea.focus();

            this.hideMenu();

            // Track usage count
            fetch(`/teacher/api/comment-bank/${snippet.snippet_id}/use`, { method: 'POST' }).catch(() => {});
        }
    }

    // Auto-attach to textareas with attribute [data-text-expander]
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('textarea[data-text-expander]').forEach(ta => {
            new TextExpander(ta);
        });
    });

    window.TextExpander = TextExpander;
    window.refreshSnippetsCache = () => { snippetsCache = null; loadSnippets(); };
})();
