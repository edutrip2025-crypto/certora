export function createAssessmentPrecheckUi({
  state,
  el,
  labels,
  createDefaultPrecheckChecklist,
}) {
  function renderPrecheckChecklist(activeKey = "") {
    if (!el.apPrecheckChecklist) return;
    const checks = state.assessmentPreview.proctor.precheckChecks || createDefaultPrecheckChecklist();
    const ordered = Object.entries(labels);
    const activeIndex = activeKey
      ? ordered.findIndex(([key]) => key === activeKey)
      : ordered.findIndex(([key]) => !checks[key]);
    const renderLimit = activeIndex >= 0 ? activeIndex : (state.assessmentPreview.proctor.precheckReady ? ordered.length - 1 : 0);
    const rows = ordered
      .filter((_, idx) => idx <= renderLimit)
      .map(([key, label]) => {
        const done = Boolean(checks[key]);
        const active = !done && key === activeKey;
        return `
      <div class="ap-precheck-checklist-row${done ? " done" : ""}${active ? " active" : ""}">
        <span class="ap-precheck-checklist-dot"></span>
        <span>${done ? "Done" : active ? "In progress" : "Pending"}: ${label}</span>
      </div>
    `;
      });
    if (state.assessmentPreview.proctor.precheckReady) {
      rows.push(`
      <div class="ap-precheck-checklist-row done">
        <span class="ap-precheck-checklist-dot"></span>
        <span>Done: All mandatory precheck stages completed.</span>
      </div>
    `);
    }
    el.apPrecheckChecklist.innerHTML = rows.join("");
    el.apPrecheckChecklist.scrollTop = el.apPrecheckChecklist.scrollHeight;
  }

  function setPrecheckInstruction(text, activeKey = "", detailText = "", voiceScript = "") {
    if (el.apPrecheckInstruction) el.apPrecheckInstruction.textContent = text;
    if (el.apPrecheckInstructionDetail) {
      el.apPrecheckInstructionDetail.textContent = detailText || "Keep your face centered, eyes on question area, and stay silent unless prompted.";
    }
    if (el.apPrecheckVoiceScript) {
      if (voiceScript) {
        el.apPrecheckVoiceScript.textContent = `Read exactly: "${voiceScript}"`;
        el.apPrecheckVoiceScript.classList.remove("hidden");
      } else {
        el.apPrecheckVoiceScript.classList.add("hidden");
      }
    }
    renderPrecheckChecklist(activeKey);
  }

  function showPrecheckChecksPage() {
    el.apPrecheckChecksPage?.classList.remove("hidden");
    el.apPrecheckRulesPage?.classList.add("hidden");
  }

  function showPrecheckRulesPage() {
    el.apPrecheckChecksPage?.classList.add("hidden");
    el.apPrecheckRulesPage?.classList.remove("hidden");
  }

  async function runRulesReadAloudVerification(audioBaselineRms) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let audioContext = null;
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const arr = new Uint8Array(analyser.fftSize);
      const start = Date.now();
      let activeFrames = 0;
      while (Date.now() - start < 4800) {
        analyser.getByteTimeDomainData(arr);
        let sum = 0;
        for (let i = 0; i < arr.length; i += 1) {
          const d = (arr[i] - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / arr.length);
        if (rms > Math.max(0.03, (audioBaselineRms || 0.03) * 1.35)) activeFrames += 1;
        await new Promise((r) => setTimeout(r, 110));
      }
      return activeFrames >= 9;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      if (audioContext) audioContext.close().catch(() => {});
    }
  }

  function updateAssessmentStartEligibility() {
    const p = state.assessmentPreview.proctor;
    const precheckReady = Boolean(p.precheckReady) && !p.precheckInProgress;
    const attested = Boolean(p.environmentAttested);
    const readReady = Boolean(p.readAloudReady);
    if (el.apPrecheckNextBtn) {
      el.apPrecheckNextBtn.disabled = !precheckReady;
    }
    if (el.apStartTestBtn) {
      el.apStartTestBtn.disabled = !(precheckReady && attested && readReady);
    }
    if (el.apEnvironmentStatus) {
      if (p.precheckInProgress) {
        el.apEnvironmentStatus.textContent = "Pre-check is in progress. Complete all checks to unlock Next.";
      } else if (!precheckReady) {
        el.apEnvironmentStatus.textContent = "Next is blocked until all mandatory proctor checks are completed.";
      } else if (!attested) {
        el.apEnvironmentStatus.textContent = "Assessment start remains blocked until you confirm the test machine is local-only.";
      } else if (!readReady) {
        el.apEnvironmentStatus.textContent = "Assessment start remains blocked until read-aloud verification is complete.";
      } else {
        el.apEnvironmentStatus.textContent = "All checks completed. You can start the assessment.";
      }
    }
  }

  return {
    renderPrecheckChecklist,
    setPrecheckInstruction,
    showPrecheckChecksPage,
    showPrecheckRulesPage,
    runRulesReadAloudVerification,
    updateAssessmentStartEligibility,
  };
}
