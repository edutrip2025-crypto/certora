export function createCourseCatalogUi({
  state,
  el,
  api,
  toast,
  formatCourseRating,
  formatSecondsToClock,
  escapeHtmlAttr,
  openStudentCourseViewer,
  refreshStudentDashboard,
  findPrimaryLesson,
  findLiveLessons,
  resolveCourseThumbnail,
  canDeleteCourseFromUi,
  fetchVideoDuration,
  openCourseViewer,
  refreshProviderContent,
}) {
  function safeCourseTime(value) {
    const ts = Date.parse(String(value || ""));
    return Number.isFinite(ts) ? ts : 0;
  }

  function studentCourseFilterSort(items, searchRaw, sortKey) {
    const q = String(searchRaw || "").trim().toLowerCase();
    let out = Array.isArray(items) ? [...items] : [];
    if (q) {
      out = out.filter((c) => {
        const hay = [
          c?.title || "",
          c?.provider_name || "",
          c?.category || "",
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    const key = String(sortKey || "latest").toLowerCase();
    out.sort((a, b) => {
      if (key === "rating_desc") {
        const ar = Number(a?.average_rating || 0);
        const br = Number(b?.average_rating || 0);
        if (br !== ar) return br - ar;
      } else if (key === "title_asc") {
        return String(a?.title || "").localeCompare(String(b?.title || ""));
      } else if (key === "provider_asc") {
        return String(a?.provider_name || "").localeCompare(String(b?.provider_name || ""));
      } else if (key === "progress_desc") {
        const ap = Number(a?.progress_pct || 0);
        const bp = Number(b?.progress_pct || 0);
        if (bp !== ap) return bp - ap;
      }
      return safeCourseTime(b?.created_at || b?.enrolled_at) - safeCourseTime(a?.created_at || a?.enrolled_at);
    });
    return out;
  }

  function providerCourseFilterSort(items, searchRaw, sortKey) {
    const q = String(searchRaw || "").trim().toLowerCase();
    let out = Array.isArray(items) ? [...items] : [];
    if (q) {
      out = out.filter((c) => String(c?.title || "").toLowerCase().includes(q));
    }
    const key = String(sortKey || "latest").toLowerCase();
    out.sort((a, b) => {
      if (key === "rating_desc") {
        const ar = Number(a?.average_rating || 0);
        const br = Number(b?.average_rating || 0);
        if (br !== ar) return br - ar;
      } else if (key === "title_asc") {
        return String(a?.title || "").localeCompare(String(b?.title || ""));
      } else if (key === "status_active") {
        const aRank = a?.is_published ? 0 : 1;
        const bRank = b?.is_published ? 0 : 1;
        if (aRank !== bRank) return aRank - bRank;
      }
      return safeCourseTime(b?.created_at) - safeCourseTime(a?.created_at);
    });
    return out;
  }

  function toggleFilterPopover(menu, trigger, show) {
    if (!menu) return;
    const next = typeof show === "boolean" ? show : menu.classList.contains("hidden");
    [el.studentAvailableFilterMenu, el.studentEnrolledFilterMenu, el.providerCoursesFilterMenu].forEach((node) => {
      if (node && node !== menu) node.classList.add("hidden");
    });
    menu.classList.toggle("hidden", !next);
    if (trigger) trigger.classList.toggle("active", next);
  }

  function renderStudentCourseGrid(target, items, { enrolled = false } = {}) {
    if (!target) return;
    if (!items.length) {
      target.innerHTML = `<div class="item"><div class="meta">No items</div><div style="margin-top:4px;">No courses found for current search/filter.</div></div>`;
      return;
    }
    const cards = items.map((c) => {
      const progress = Math.max(0, Math.min(100, Number(c.progress_pct || 0)));
      const assessmentLine = c.assessment_available
        ? "Assessment available"
        : c.exam_eligible
          ? "Assessment not yet published"
          : "Assessment locked";
      return `
        <article class="course-tile">
          ${c.thumbnail_url ? `<img src="${escapeHtmlAttr(c.thumbnail_url)}" alt="" class="course-tile-thumb" />` : `<div class="course-tile-thumb"></div>`}
          <div class="course-tile-body">
            <h4 class="course-tile-title">${escapeHtmlAttr(c.title || "Untitled Course")}</h4>
            <div class="course-tile-provider">${escapeHtmlAttr(c.provider_name || "Provider")}</div>
            <div class="course-tile-meta">${escapeHtmlAttr(c.category || "-")} | ${escapeHtmlAttr(formatCourseRating(c.average_rating, c.rating_count))}</div>
            ${
              enrolled
                ? `
                  <div class="course-tile-progress">
                    <div class="course-tile-progress-bar" style="width:${progress}%;"></div>
                  </div>
                  <div class="course-tile-meta">${progress.toFixed(0)}% completed | ${escapeHtmlAttr(assessmentLine)}</div>
                `
                : ""
            }
            <div class="actions">
              ${
                enrolled
                  ? `<button class="btn small" data-student-view-course="${Number(c.course_id || 0)}">View Course</button>`
                  : `<button class="btn small" data-student-enroll="${Number(c.course_id || 0)}">Enroll</button>`
              }
            </div>
          </div>
        </article>
      `;
    }).join("");
    target.innerHTML = `<div class="course-tile-grid">${cards}</div>`;
  }

  function renderStudentCourseCatalogs() {
    const available = studentCourseFilterSort(
      state.studentDashboard.available || [],
      el.studentAvailableSearch?.value || "",
      el.studentAvailableSort?.value || "latest",
    );
    const enrolled = studentCourseFilterSort(
      state.studentDashboard.enrolled || [],
      el.studentEnrolledSearch?.value || "",
      el.studentEnrolledSort?.value || "latest",
    );
    renderStudentCourseGrid(el.studentAvailableCourses, available, { enrolled: false });
    renderStudentCourseGrid(el.studentEnrolledCourses, enrolled, { enrolled: true });

    document.querySelectorAll("[data-student-enroll]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api("POST", "/student/enroll", { course_id: Number(btn.dataset.studentEnroll) });
          toast("Enrollment successful");
          await refreshStudentDashboard();
        } catch {
          toast("Failed to enroll", "error");
        }
      });
    });
    document.querySelectorAll("[data-student-view-course]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await openStudentCourseViewer(Number(btn.dataset.studentViewCourse));
        } catch (err) {
          toast(err?.message || "Failed to open course", "error");
        }
      });
    });
  }

  function renderProviderCourseCatalog() {
    const courses = providerCourseFilterSort(
      state.providerCourses || [],
      el.providerCoursesSearch?.value || "",
      el.providerCoursesSort?.value || "latest",
    );
    if (!el.providerCoursesList) return;
    if (!courses.length) {
      el.providerCoursesList.innerHTML = `<div class="item"><div class="meta">No items</div><div style="margin-top:4px;">No courses found for current search/filter.</div></div>`;
      return;
    }
    const cards = courses.map((c) => {
      const firstLesson = findPrimaryLesson(c);
      const firstLiveLesson = findLiveLessons(c)[0] || null;
      const thumb = resolveCourseThumbnail(c, firstLesson);
      const durationLabel = firstLesson?.recorded_video_url
        ? (state.videoDurationByUrl[firstLesson.recorded_video_url] != null
          ? formatSecondsToClock(state.videoDurationByUrl[firstLesson.recorded_video_url])
          : "Loading...")
        : "-";
      return `
        <article class="course-tile">
          ${thumb ? `<img src="${escapeHtmlAttr(thumb)}" alt="" class="course-tile-thumb" />` : `<div class="course-tile-thumb"></div>`}
          <div class="course-tile-body">
            <h4 class="course-tile-title">${escapeHtmlAttr(c.title || "Untitled Course")}</h4>
            <div class="course-tile-provider">Provider: You</div>
            <div class="course-tile-meta">Status: ${c.is_published ? "Active" : "Inactive"} | Duration: <span data-course-duration="${c.id}">${durationLabel}</span></div>
            <div class="course-tile-meta">${escapeHtmlAttr(formatCourseRating(c.average_rating, c.rating_count))}</div>
            <div class="actions">
              <button class="btn small" data-view-course="${c.id}">View Course</button>
              ${firstLiveLesson?.live_class_url ? `<button class="btn small" data-open-live-course="${c.id}">Open Live Class</button>` : ""}
              ${!c.is_published ? `<button class="btn small" data-activate-course="${c.id}">Activate Course</button>` : ""}
              ${canDeleteCourseFromUi() ? `<button class="btn small danger" data-delete-course="${c.id}">Delete Course</button>` : ""}
            </div>
          </div>
        </article>
      `;
    }).join("");
    el.providerCoursesList.innerHTML = `<div class="course-tile-grid">${cards}</div>`;

    const durationTasks = courses.map(async (course) => {
      const lesson = findPrimaryLesson(course);
      if (!lesson?.recorded_video_url) return;
      const sec = await fetchVideoDuration(lesson.recorded_video_url);
      const label = document.querySelector(`[data-course-duration="${course.id}"]`);
      if (label) label.textContent = sec != null ? formatSecondsToClock(sec) : "-";
    });
    Promise.all(durationTasks).catch(() => {});

    document.querySelectorAll("[data-view-course]").forEach((btn) => {
      btn.addEventListener("click", () => openCourseViewer(Number(btn.dataset.viewCourse)));
    });
    document.querySelectorAll("[data-open-live-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const course = state.providerCourses.find((c) => Number(c.id) === Number(btn.dataset.openLiveCourse));
        const lesson = findLiveLessons(course)[0];
        if (!lesson?.live_class_url) return toast("No live class link available", "error");
        window.open(lesson.live_class_url, "_blank", "noopener,noreferrer");
      });
    });
    document.querySelectorAll("[data-activate-course]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const courseId = Number(btn.dataset.activateCourse || 0);
        if (!courseId) return;
        try {
          await api("POST", `/courses/${courseId}/publish`);
          toast("Course activated");
          await refreshProviderContent();
        } catch (err) {
          toast(err?.message || "Failed to activate course", "error");
        }
      });
    });
    document.querySelectorAll("[data-delete-course]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const courseId = Number(btn.dataset.deleteCourse || 0);
        const course = state.providerCourses.find((c) => Number(c.id) === courseId);
        const ok = confirm(`Delete course "${course?.title || courseId}"? This will remove its lessons, enrollments, exams, and related records.`);
        if (!ok) return;
        try {
          await api("DELETE", `/courses/${courseId}`);
          toast("Course deleted");
          await refreshProviderContent();
        } catch (err) {
          toast(err?.message || "Failed to delete course", "error");
        }
      });
    });
  }

  return {
    toggleFilterPopover,
    renderStudentCourseCatalogs,
    renderProviderCourseCatalog,
  };
}
