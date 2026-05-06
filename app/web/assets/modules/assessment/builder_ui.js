export function createAssessmentBuilderUi({
  state,
  el,
  $, 
  toast,
  api,
  renderList,
  getSelectedAssessmentCourseId,
  isAssessmentDraftSourceSelected,
  getAssessmentSourceValue,
  persistAssessmentBuilderCache,
  resetAssessmentBuilder,
  tryRestoreAssessmentBuilderCache,
}) {
  const STEP2_REQUIRED_TEXT_FIELDS = [
    "abTitle",
    "abMaxAttempts",
    "abQuestionsPerAttempt",
    "abTimingMode",
    "abDurationMinutes",
    "abDurationSeconds",
    "abTimePerQuestionSeconds",
    "abDefaultNegativeMarks",
  ];
  const STEP2_REQUIRED_CHECKBOX_ROWS = [
    "abNegativeMarking",
  ];

  function markFieldInvalid(fieldId, invalid = true) {
    const node = $(fieldId);
    if (!node) return;
    node.classList.toggle("ab-field-invalid", Boolean(invalid));
  }

  function markCheckboxRowInvalid(checkboxId, invalid = true) {
    const node = $(checkboxId);
    const row = node?.closest?.(".checkbox-row");
    if (!row) return;
    row.classList.toggle("ab-field-invalid", Boolean(invalid));
  }

  function clearStep2InvalidStyles() {
    STEP2_REQUIRED_TEXT_FIELDS.forEach((id) => markFieldInvalid(id, false));
    STEP2_REQUIRED_CHECKBOX_ROWS.forEach((id) => markCheckboxRowInvalid(id, false));
  }

  function showStep2Error(message) {
    const node = $("abStep2Error");
    if (!node) return;
    if (!message) {
      node.textContent = "";
      node.classList.add("hidden");
      return;
    }
    node.textContent = message;
    node.classList.remove("hidden");
  }

  function setAssessmentBuilderStep(step, options = {}) {
    const normalized = Math.max(1, Math.min(3, Number(step || 1)));
    state.assessmentBuilderStep = normalized;
    const track = $("abStepTrack");
    if (track) {
      if (options.noAnimate) track.style.transition = "none";
      track.style.transform = `translateX(-${(normalized - 1) * (100 / 3)}%)`;
      if (options.noAnimate) {
        requestAnimationFrame(() => {
          track.style.transition = "";
        });
      }
    }
    document.querySelectorAll("[data-ab-step-indicator]").forEach((node) => {
      node.classList.toggle("active", Number(node.getAttribute("data-ab-step-indicator") || 0) === normalized);
    });
  }

  function goToAssessmentStep(step) {
    setAssessmentBuilderStep(step);
  }

  function validateAssessmentStep(step) {
    const s = Number(step || 1);
    if (s === 1) {
      const courseId = getSelectedAssessmentCourseId();
      if (!courseId || isAssessmentDraftSourceSelected()) {
        toast("Select an active/inactive course (draft is not allowed for assessment).", "error");
        return false;
      }
      return true;
    }
    if (s === 2) {
      showStep2Error("");
      clearStep2InvalidStyles();
      const title = $("abTitle")?.value?.trim() || "";
      if (!title) {
        markFieldInvalid("abTitle", true);
        showStep2Error("Assessment title is required.");
        return false;
      }
      const maxAttempts = Number($("abMaxAttempts")?.value);
      const questionsPerAttempt = Number($("abQuestionsPerAttempt")?.value);
      if (!Number.isFinite(maxAttempts) || maxAttempts <= 0 || maxAttempts > 3) {
        markFieldInvalid("abMaxAttempts", true);
        showStep2Error("Max attempts must be between 1 and 3.");
        return false;
      }
      if (![25, 30, 35, 40].includes(questionsPerAttempt)) {
        markFieldInvalid("abQuestionsPerAttempt", true);
        showStep2Error("Questions shown to student must be one of 25, 30, 35, or 40.");
        return false;
      }
      const timingMode = $("abTimingMode")?.value || "question";
      if (timingMode === "assessment") {
        const mins = Number($("abDurationMinutes")?.value || 0);
        const secs = Number($("abDurationSeconds")?.value || 0);
        if (!Number.isFinite(mins) || mins < 0 || !Number.isFinite(secs) || secs < 0 || secs >= 60 || (mins === 0 && secs === 0)) {
          markFieldInvalid("abDurationMinutes", true);
          markFieldInvalid("abDurationSeconds", true);
          showStep2Error("Duration is required. Enter valid minutes and/or seconds.");
          return false;
        }
      } else {
        const perQ = Number($("abTimePerQuestionSeconds")?.value);
        if (![25, 30, 35, 40, 45].includes(perQ)) {
          markFieldInvalid("abTimePerQuestionSeconds", true);
          showStep2Error("Time per question is required and must be 25, 30, 35, 40, or 45 seconds.");
          return false;
        }
      }
      if (Boolean($("abNegativeMarking")?.checked)) {
        const raw = String($("abDefaultNegativeMarks")?.value || "").trim();
        if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
          markFieldInvalid("abDefaultNegativeMarks", true);
          showStep2Error("Default negative marks must be 0 or a positive number.");
          return false;
        }
      }
      showStep2Error("");
      return true;
    }
    return true;
  }

  function openAssessmentBuilder(allowRestore = true) {
    resetAssessmentBuilder();
    showStep2Error("");
    clearStep2InvalidStyles();
    el.assessmentBuilderScreen?.classList.remove("hidden");
    if (allowRestore) tryRestoreAssessmentBuilderCache();
    setAssessmentBuilderStep(1, { noAnimate: true });
  }

  function closeAssessmentBuilder() {
    el.assessmentBuilderScreen?.classList.add("hidden");
    resetAssessmentBuilder();
  }

  function updateAssessmentSourceMeta() {
    const meta = $("abCourseMeta");
    const saveBtn = $("abSaveDraftBtn");
    const publishBtn = $("abPublishBtn");
    if (!meta) return;
    const raw = getAssessmentSourceValue();
    if (!raw) {
      meta.textContent = "No course selected.";
      if (saveBtn) saveBtn.disabled = true;
      if (publishBtn) publishBtn.disabled = true;
      return;
    }
    if (raw.startsWith("draft:")) {
      const draftId = Number(raw.split(":")[1] || 0);
      const d = (state.providerDrafts || []).find((x) => Number(x.draft_id) === draftId);
      meta.textContent = `Draft selected: ${d?.title || `Draft #${draftId}`}. Publish the course first to create an assessment.`;
      if (saveBtn) saveBtn.disabled = true;
      if (publishBtn) publishBtn.disabled = true;
      return;
    }
    const courseId = Number(raw.split(":")[1] || 0);
    const c = (state.providerCourses || []).find((x) => Number(x.id) === courseId);
    meta.textContent = c
      ? `Course selected: ${c.title} (${c.is_published ? "Active" : "Inactive"}).`
      : "Invalid selection.";
    if (saveBtn) saveBtn.disabled = false;
    if (publishBtn) publishBtn.disabled = false;
  }

  function renderAssessmentCourseOptions() {
    const selectNode = $("abCourseSelect");
    if (!selectNode) return;
    const filter = $("abCourseFilter")?.value || "all";
    const options = [];

    if (filter !== "draft") {
      (state.providerCourses || []).forEach((c) => {
        if (filter === "active" && !c.is_published) return;
        if (filter === "inactive" && c.is_published) return;
        options.push({
          value: `course:${c.id}`,
          label: `${c.title} (${c.is_published ? "Active" : "Inactive"})`,
        });
      });
    }
    if (filter === "draft" || filter === "all") {
      (state.providerDrafts || []).forEach((d) => {
        options.push({
          value: `draft:${d.draft_id}`,
          label: `${d.title || `Draft #${d.draft_id}`} (Draft video)`,
        });
      });
    }

    const previous = selectNode.value;
    const html = [`<option value="">Select course or draft video</option>`]
      .concat(options.map((o) => `<option value="${o.value}">${o.label}</option>`))
      .join("");
    selectNode.innerHTML = html;
    if (options.some((o) => o.value === previous)) {
      selectNode.value = previous;
    }
    updateAssessmentSourceMeta();
  }

  function renderAssessmentPool() {
    const list = state.assessmentDraftQuestions || [];
    const perAttempt = Number($("abQuestionsPerAttempt")?.value || 0);
    const recommendedPool = perAttempt > 0 ? perAttempt * 2 : 0;
    if (el.abPoolMeta) {
      const recommendation = recommendedPool > 0 ? ` Recommended pool: ${recommendedPool}+` : "";
      el.abPoolMeta.textContent = `${list.length} questions.${recommendation}`;
    }
    renderList(
      el.abQuestionPoolList,
      list,
      (q, idx) => `
        <div><strong>Q${idx + 1}</strong> (${q.question_type === "mcq_multiple_correct" ? "Multi" : "Single"})</div>
        <div style="margin-top:4px;">${q.question_text}</div>
        <div class="meta">Marks: ${q.marks} | Negative: ${q.negative_marks}</div>
        <div class="meta">Options: ${q.options.length} | Correct: ${q.options.filter((o) => o.is_correct).length}</div>
        <div class="actions"><button class="btn small danger" data-ab-remove-q="${idx}">Remove</button></div>
      `,
      "No questions added yet.",
    );
    document.querySelectorAll("[data-ab-remove-q]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.dataset.abRemoveQ || -1);
        if (idx < 0 || idx >= state.assessmentDraftQuestions.length) return;
        const q = state.assessmentDraftQuestions[idx];
        if (state.assessmentEditingExamId && q.question_id) {
          try {
            await api("DELETE", `/exams/${state.assessmentEditingExamId}/questions/${q.question_id}`);
          } catch (err) {
            toast(err?.message || "Failed to remove question", "error");
            return;
          }
        }
        state.assessmentDraftQuestions = state.assessmentDraftQuestions.filter((_, i) => i !== idx);
        if (!state.assessmentDraftQuestions.length) {
          state.assessmentQuestionDefaultMarks = null;
          state.assessmentQuestionDefaultNegativeMarks = null;
          $("abQuestionMarks").value = "";
          $("abQuestionNegativeMarks").value = "";
        }
        persistAssessmentBuilderCache();
        renderAssessmentPool();
      });
    });
  }

  return {
    setAssessmentBuilderStep,
    goToAssessmentStep,
    validateAssessmentStep,
    openAssessmentBuilder,
    closeAssessmentBuilder,
    renderAssessmentCourseOptions,
    updateAssessmentSourceMeta,
    renderAssessmentPool,
  };
}
