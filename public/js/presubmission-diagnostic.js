/**
 * Pre-submission Smart Diagnostic (Self-Check Checklist)
 * Performs pre-flight client-side inspection before submission upload.
 */
(function () {
    class PreSubmissionDiagnostic {
        constructor(fileInput, options = {}) {
            this.fileInput = fileInput;
            this.options = Object.assign({
                minWords: 0,
                maxWords: null,
                disallowBlank: true,
                maxFileSizeMb: 25,
                allowedFormats: [
                    'pdf', 'docx', 'doc', 'txt', 'rtf', 'odt',
                    'pptx', 'ppt', 'xlsx', 'xls', 'csv',
                    'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
                    'zip', 'rar', '7z', 'tar', 'gz',
                    'mol', 'pdb', 'cif', 'cdx', 'xyz'
                ],
                onValidated: (file) => {}
            }, options);

            if (typeof this.options.allowedFormats === 'string') {
                this.options.allowedFormats = this.options.allowedFormats
                    .split(',')
                    .map(s => s.trim().toLowerCase().replace(/^\./, ''))
                    .filter(Boolean);
            }

            this.init();
        }

        init() {
            this.fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) this.runDiagnostics(file);
            });
            this.createModal();
        }

        createModal() {
            const modal = document.createElement('div');
            modal.id = 'diagnosticChecklistModal';
            modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[99999] hidden flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white rounded-3xl max-w-lg w-full shadow-2xl overflow-hidden border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
                    <div class="p-5 border-b border-slate-100 flex items-center justify-between bg-indigo-50/40">
                        <div class="flex items-center gap-3">
                            <span class="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-black text-lg">🛡️</span>
                            <div>
                                <h3 class="font-extrabold text-slate-900 text-base">Pre-Submission Smart Diagnostic</h3>
                                <p class="text-[11px] text-slate-500 font-medium">Automated integrity & quality verification</p>
                            </div>
                        </div>
                    </div>
                    <div class="p-6 space-y-4">
                        <div id="diagLoading" class="flex flex-col items-center justify-center py-6 gap-3">
                            <div class="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                            <p class="text-xs text-slate-500 font-bold">Scanning document structure & text density...</p>
                        </div>
                        <div id="diagResults" class="space-y-3 hidden">
                            <!-- Checklist items injected dynamically -->
                        </div>
                    </div>
                    <div class="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                        <button id="diagCancelBtn" class="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition">Select Different File</button>
                        <button id="diagConfirmBtn" class="px-5 py-2.5 rounded-xl text-xs font-black bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-200 transition flex items-center gap-2">
                            <span>Proceed to Submit</span>
                            <i class="fas fa-arrow-right text-[10px]"></i>
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            document.getElementById('diagCancelBtn').addEventListener('click', () => {
                this.fileInput.value = '';
                this.hideModal();
            });

            document.getElementById('diagConfirmBtn').addEventListener('click', () => {
                this.hideModal();
                if (this.currentFile && this.options.onValidated) {
                    this.options.onValidated(this.currentFile);
                }
            });
        }

        showModal() {
            document.getElementById('diagnosticChecklistModal').classList.remove('hidden');
            document.getElementById('diagLoading').classList.remove('hidden');
            document.getElementById('diagResults').classList.add('hidden');
        }

        hideModal() {
            document.getElementById('diagnosticChecklistModal').classList.add('hidden');
        }

        async runDiagnostics(file) {
            this.currentFile = file;
            this.showModal();

            const ext = file.name.split('.').pop().toLowerCase();
            const checks = [];

            // 1. Format Check (supports academic, chemistry, archive, media & custom formats)
            const isFormatAllowed = this.options.allowedFormats.includes(ext);
            checks.push({
                title: 'File Format Verification',
                detail: isFormatAllowed 
                    ? `Format .${ext.toUpperCase()} is allowed for this assignment.` 
                    : `Format .${ext.toUpperCase()} is not in the allowed list: ${this.options.allowedFormats.join(', ')}`,
                passed: isFormatAllowed,
                severity: isFormatAllowed ? 'ok' : 'error'
            });

            // 2. File Size Check (non-empty and within maxFileSizeMb)
            const maxBytes = (this.options.maxFileSizeMb || 25) * 1024 * 1024;
            const sizeNonEmpty = file.size > 50; // >50 bytes
            const withinSize = file.size <= maxBytes;
            const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
            checks.push({
                title: 'File Size & Boundary',
                detail: withinSize 
                    ? `${sizeMb} MB detected (Limit: ${this.options.maxFileSizeMb} MB)` 
                    : `Exceeds max limit of ${this.options.maxFileSizeMb} MB (${sizeMb} MB detected)`,
                passed: sizeNonEmpty && withinSize,
                severity: (!sizeNonEmpty || !withinSize) ? 'error' : 'ok'
            });

            let extractedWords = 0;
            let isBlank = false;

            // 3. Inspect PDF text if PDF.js is loaded
            if (ext === 'pdf' && window.pdfjsLib) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map(item => item.str).join(' ');
                        fullText += ' ' + pageText;
                    }
                    const words = fullText.trim().split(/\s+/).filter(w => w.length > 0);
                    extractedWords = words.length;
                    isBlank = extractedWords < 5;

                    checks.push({
                        title: 'Blank Page Detection',
                        detail: isBlank ? 'Document appears blank or has minimal text!' : `${pdf.numPages} page(s) with active text verified`,
                        passed: !isBlank,
                        severity: isBlank ? 'warning' : 'ok'
                    });
                } catch (e) {
                    console.warn('[PreSubmissionDiagnostic] PDF inspection warning:', e);
                }
            }

            // 4. Word Count Target Check (if minWords specified)
            if (this.options.minWords > 0) {
                const metWordCount = extractedWords >= this.options.minWords;
                checks.push({
                    title: 'Word Count Target',
                    detail: `${extractedWords} words (Requirement: min ${this.options.minWords})`,
                    passed: metWordCount,
                    severity: metWordCount ? 'ok' : 'warning'
                });
            }

            // 5. Zero-Footprint Sanitization Preview
            checks.push({
                title: 'Privacy & EXIF Sanitation',
                detail: 'EXIF camera tags & author metadata will be automatically scrubbed upon receipt',
                passed: true,
                severity: 'info'
            });

            this.renderResults(checks);
        }

        renderResults(checks) {
            document.getElementById('diagLoading').classList.add('hidden');
            const container = document.getElementById('diagResults');
            container.classList.remove('hidden');

            const hasErrors = checks.some(c => c.severity === 'error');
            const confirmBtn = document.getElementById('diagConfirmBtn');
            if (hasErrors) {
                confirmBtn.disabled = true;
                confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
            } else {
                confirmBtn.disabled = false;
                confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }

            container.innerHTML = checks.map(c => {
                let badge = `<span class="text-emerald-500"><i class="fas fa-check-circle text-base"></i></span>`;
                let bg = `bg-emerald-50/50 border-emerald-100`;

                if (c.severity === 'warning') {
                    badge = `<span class="text-amber-500"><i class="fas fa-exclamation-triangle text-base"></i></span>`;
                    bg = `bg-amber-50/50 border-amber-100`;
                } else if (c.severity === 'error') {
                    badge = `<span class="text-rose-500"><i class="fas fa-times-circle text-base"></i></span>`;
                    bg = `bg-rose-50/50 border-rose-100`;
                } else if (c.severity === 'info') {
                    badge = `<span class="text-indigo-500"><i class="fas fa-shield-alt text-base"></i></span>`;
                    bg = `bg-indigo-50/50 border-indigo-100`;
                }

                return `
                    <div class="p-3.5 rounded-2xl border ${bg} flex items-start gap-3">
                        <div class="mt-0.5">${badge}</div>
                        <div class="flex-1">
                            <h4 class="font-black text-slate-800 text-xs">${c.title}</h4>
                            <p class="text-[11px] text-slate-500 font-medium mt-0.5">${c.detail}</p>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    window.PreSubmissionDiagnostic = PreSubmissionDiagnostic;
})();
