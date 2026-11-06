/**
 * Elementa LMS Unified Splash & Loading Screen
 * (C) Elementa Learning Management System
 * 
 * Modular, lightweight script providing a unified, science-themed
 * loading screen across all Elementa interactive simulations.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__ELEMENTA_SPLASH_INITIALIZED__) return;
  window.__ELEMENTA_SPLASH_INITIALIZED__ = true;

  // Detect Simulation Title and Category
  function getSimMetadata() {
    let title = '';
    let category = 'Interactive Laboratory Simulation';

    // Try extracting from document title
    if (document.title) {
      title = document.title
        .replace(/[\u202A\u202B\u202C\u8234\u8236]/g, '')
        .replace(/\s*\|\s*Elementa(\s*LMS)?(\s*Edition)?/gi, '')
        .trim();
    }

    // Try refining from breadcrumb if available
    const breadcrumbCurrent = document.querySelector('.lms-breadcrumb .current');
    if (breadcrumbCurrent && breadcrumbCurrent.textContent.trim()) {
      title = breadcrumbCurrent.textContent.trim();
    }

    const breadcrumbItems = document.querySelectorAll('.lms-breadcrumb span:not(.current)');
    if (breadcrumbItems.length > 0) {
      const parts = Array.from(breadcrumbItems)
        .map(el => el.textContent.trim())
        .filter(t => t && t !== '›' && t !== '>');
      if (parts.length > 0) {
        category = parts.join(' › ');
      }
    }

    if (!title) title = 'Elementa Science Lab';

    return { title, category };
  }

  // Inject CSS Styles
  const styleEl = document.createElement('style');
  styleEl.id = 'elementa-splash-styles';
  styleEl.textContent = `
    #elementa-splash-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: radial-gradient(circle at center, #0f172a 0%, #070a13 85%, #04060a 100%);
      color: #f1f5f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999999;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      opacity: 1;
      visibility: visible;
      transition: opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.4s ease;
      cursor: wait;
      user-select: none;
      -webkit-user-select: none;
    }

    #elementa-splash-overlay.fade-out {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .esp-particles-bg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0.35;
      background-image: 
        radial-gradient(rgba(56, 189, 248, 0.2) 1px, transparent 1px),
        radial-gradient(rgba(129, 140, 248, 0.15) 1px, transparent 1px);
      background-size: 40px 40px;
      background-position: 0 0, 20px 20px;
    }

    .esp-container {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      max-width: 540px;
      padding: 2.5rem;
      z-index: 10;
    }

    /* Science-Themed Atom Orbital Loader */
    .esp-atom-wrap {
      position: relative;
      width: 96px;
      height: 96px;
      margin-bottom: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .esp-atom-nucleus {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      box-shadow: 0 0 25px rgba(56, 189, 248, 0.8), 0 0 50px rgba(129, 140, 248, 0.4);
      animation: espPulseNucleus 2s ease-in-out infinite alternate;
      z-index: 3;
    }

    .esp-orbit {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      border: 1.5px solid rgba(56, 189, 248, 0.35);
      border-top-color: #38bdf8;
      box-sizing: border-box;
    }

    .esp-orbit:nth-child(1) {
      transform: rotate(0deg) rotateX(70deg);
      animation: espSpinOrbit1 2.2s linear infinite;
    }

    .esp-orbit:nth-child(2) {
      transform: rotate(60deg) rotateX(70deg);
      animation: espSpinOrbit2 2.6s linear infinite;
    }

    .esp-orbit:nth-child(3) {
      transform: rotate(120deg) rotateX(70deg);
      animation: espSpinOrbit3 3s linear infinite;
    }

    .esp-electron {
      position: absolute;
      top: -4px;
      left: 50%;
      margin-left: -4px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 0 10px #38bdf8, 0 0 18px #ffffff;
    }

    @keyframes espSpinOrbit1 {
      0% { transform: rotate(0deg) rotateX(70deg) rotateZ(0deg); }
      100% { transform: rotate(0deg) rotateX(70deg) rotateZ(360deg); }
    }
    @keyframes espSpinOrbit2 {
      0% { transform: rotate(60deg) rotateX(70deg) rotateZ(0deg); }
      100% { transform: rotate(60deg) rotateX(70deg) rotateZ(360deg); }
    }
    @keyframes espSpinOrbit3 {
      0% { transform: rotate(120deg) rotateX(70deg) rotateZ(0deg); }
      100% { transform: rotate(120deg) rotateX(70deg) rotateZ(360deg); }
    }

    @keyframes espPulseNucleus {
      0% { transform: scale(0.9); box-shadow: 0 0 20px rgba(56, 189, 248, 0.6); }
      100% { transform: scale(1.12); box-shadow: 0 0 32px rgba(56, 189, 248, 0.95), 0 0 60px rgba(129, 140, 248, 0.6); }
    }

    /* Elementa Brand Header */
    .esp-brand-row {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 0.6rem;
    }

    .esp-brand-icon {
      width: 26px;
      height: 26px;
      background: linear-gradient(135deg, #0284c7, #6366f1);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.4);
    }

    .esp-brand-name {
      font-size: 1.15rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .esp-brand-badge {
      font-size: 0.68rem;
      font-weight: 700;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Simulation Title & Category */
    .esp-sim-title {
      font-size: 1.45rem;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.35;
      margin-bottom: 0.35rem;
      letter-spacing: -0.01em;
    }

    .esp-sim-category {
      font-size: 0.8rem;
      color: #94a3b8;
      margin-bottom: 1.75rem;
      letter-spacing: 0.03em;
    }

    /* Progress Bar */
    .esp-progress-wrap {
      width: 280px;
      height: 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 0.75rem;
      position: relative;
    }

    .esp-progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      border-radius: 6px;
      transition: width 0.25s cubic-bezier(0.1, 0.9, 0.2, 1);
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.7);
    }

    .esp-status-text {
      font-size: 0.76rem;
      color: #64748b;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.02em;
    }
  `;

  // Inject Overlay HTML
  function createOverlay(metadata) {
    const overlay = document.createElement('div');
    overlay.id = 'elementa-splash-overlay';
    overlay.innerHTML = `
      <div class="esp-particles-bg"></div>
      <div class="esp-container">
        
        <!-- Science Atom Orbital Animation -->
        <div class="esp-atom-wrap">
          <div class="esp-orbit"><div class="esp-electron"></div></div>
          <div class="esp-orbit"><div class="esp-electron"></div></div>
          <div class="esp-orbit"><div class="esp-electron"></div></div>
          <div class="esp-atom-nucleus"></div>
        </div>

        <!-- Branding -->
        <div class="esp-brand-row">
          <div class="esp-brand-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2v7.31"></path>
              <path d="M14 9.3V1.99"></path>
              <path d="M8.5 2h7"></path>
              <path d="M14 9.3a6.5 6.5 0 1 1-4 0"></path>
              <path d="M5.52 16h12.96"></path>
            </svg>
          </div>
          <span class="esp-brand-name">ELEMENTA</span>
          <span class="esp-brand-badge">LMS Sim</span>
        </div>

        <!-- Title & Category -->
        <h1 class="esp-sim-title" id="espSimTitle">${metadata.title}</h1>
        <div class="esp-sim-category" id="espSimCategory">${metadata.category}</div>

        <!-- Progress Bar -->
        <div class="esp-progress-wrap">
          <div class="esp-progress-bar" id="espProgressBar"></div>
        </div>

        <!-- Status Text -->
        <div class="esp-status-text" id="espStatusText">Initializing simulation environment...</div>
      </div>
    `;
    return overlay;
  }

  // Orchestrate Initial Injection
  function initSplash() {
    if (document.getElementById('elementa-splash-overlay')) return;

    if (document.head) {
      document.head.appendChild(styleEl);
    } else {
      document.documentElement.appendChild(styleEl);
    }

    const metadata = getSimMetadata();
    const overlay = createOverlay(metadata);

    // Prepend to body or documentElement immediately
    if (document.body) {
      document.body.prepend(overlay);
    } else {
      document.documentElement.appendChild(overlay);
    }

    // Refresh title and category if breadcrumb elements parse after head
    function refreshMetadata() {
      const updated = getSimMetadata();
      const titleEl = document.getElementById('espSimTitle');
      const catEl = document.getElementById('espSimCategory');
      if (titleEl && updated.title) titleEl.textContent = updated.title;
      if (catEl && updated.category) catEl.textContent = updated.category;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', refreshMetadata);
    } else {
      refreshMetadata();
    }

    // Track start time and window load state
    const startTime = Date.now();
    let isWindowLoaded = (document.readyState === 'complete');
    window.addEventListener('load', () => {
      isWindowLoaded = true;
      refreshMetadata();
    });

    const bar = document.getElementById('espProgressBar');
    const statusText = document.getElementById('espStatusText');

    // Polished scientific loading progression (Target: ~2.2s total duration)
    const phases = [
      { at: 100,  pct: 22, msg: 'Initializing simulation environment...' },
      { at: 550,  pct: 46, msg: 'Allocating canvas & WebGL buffers...' },
      { at: 1050, pct: 72, msg: 'Loading thermodynamic & physics equations...' },
      { at: 1550, pct: 90, msg: 'Calibrating precision laboratory instrumentation...' },
      { at: 1950, pct: 100, msg: 'Laboratory Ready' }
    ];

    let currentPhase = 0;
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      
      // Advance to phase according to elapsed time
      while (currentPhase < phases.length && elapsed >= phases[currentPhase].at) {
        const p = phases[currentPhase];
        if (bar) bar.style.width = p.pct + '%';
        if (statusText) statusText.textContent = p.msg;
        currentPhase++;
      }

      // Once all phases are complete and window is loaded, dismiss smoothly
      if (currentPhase >= phases.length && isWindowLoaded && elapsed >= 2200) {
        clearInterval(progressTimer);
        dismissSplash();
      }
    }, 60);

    // Dismissal Logic with smooth 450ms fade-out
    let dismissed = false;
    function dismissSplash() {
      if (dismissed) return;
      dismissed = true;
      clearInterval(progressTimer);

      if (bar) bar.style.width = '100%';
      if (statusText) statusText.textContent = 'Laboratory Ready';

      setTimeout(() => {
        const ov = document.getElementById('elementa-splash-overlay');
        if (ov) {
          ov.classList.add('fade-out');
          setTimeout(() => {
            if (ov && ov.parentNode) {
              ov.parentNode.removeChild(ov);
            }
          }, 450); // 400ms fade-out + safety buffer
        }
      }, 250);
    }

    // Public API for manual control if requested
    window.ElementaSplash = {
      dismiss: dismissSplash,
      setProgress: function (pct, msg) {
        if (bar) bar.style.width = pct + '%';
        if (msg && statusText) statusText.textContent = msg;
        if (pct >= 100) dismissSplash();
      }
    };

    // Safety fallback timeout (4.5s max)
    setTimeout(dismissSplash, 4500);
  }

  // Execute immediately if DOM is ready, or on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSplash);
  } else {
    initSplash();
  }
})();

