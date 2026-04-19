import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const el = {
  courseIdInput: document.getElementById("courseIdInput"),
  loadCourseBtn: document.getElementById("loadCourseBtn"),
  lessonList: document.getElementById("lessonList"),
  playerFrame: document.getElementById("playerFrame"),
  streamNotice: document.getElementById("streamNotice"),
  usageInfo: document.getElementById("usageInfo"),
  resumeInfo: document.getElementById("resumeInfo"),
};

const state = {
  auth: null,
  user: null,
  courseId: 0,
  lessons: [],
  activeVideoId: 0,
  activeSessionId: 0,
  lastPosition: 0,
  heartbeatId: null,
};

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getIdToken() {
  if (!state.user) throw new Error("Not logged in");
  return state.user.getIdToken(true);
}

async function api(method, path, body = null) {
  const token = await getIdToken();
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { text: raw }; }
  }
  if (!res.ok) throw new Error(data?.detail || raw || `HTTP ${res.status}`);
  return data;
}

async function initAuth() {
  const cfgRes = await fetch("/config/firebase");
  const cfg = await cfgRes.json();
  const app = initializeApp({
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId: cfg.projectId,
    storageBucket: cfg.storageBucket,
    messagingSenderId: cfg.messagingSenderId,
    appId: cfg.appId,
    measurementId: cfg.measurementId,
  });
  state.auth = getAuth(app);
  onAuthStateChanged(state.auth, (user) => {
    state.user = user;
    el.streamNotice.textContent = user ? `Logged in as ${user.email || user.uid}` : "Please login in main app first.";
  });
}

function pickFirstReadyVideo(lessons) {
  for (const l of lessons || []) {
    const v = (l.videos || []).find((x) => x.ready);
    if (v) return v;
  }
  return null;
}

function renderLessons() {
  const html = (state.lessons || []).map((lesson) => {
    const items = (lesson.videos || []).map((v) => {
      const active = Number(v.lesson_video_id) === Number(state.activeVideoId);
      return `
        <div class="stream-item ${active ? "active" : ""}" data-video-id="${Number(v.lesson_video_id || 0)}">
          <div><strong>${escapeHtml(lesson.title)}</strong></div>
          <div class="meta">Video #${Number(v.lesson_video_id || 0)} | ${v.ready ? "Ready" : "Processing"}</div>
          <div class="meta">Duration: ${Math.max(0, Number(v.duration_seconds || 0))} sec</div>
        </div>
      `;
    }).join("");
    return items;
  }).join("");
  el.lessonList.innerHTML = html || "<div class='meta'>No lessons/videos found.</div>";
  document.querySelectorAll("[data-video-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const id = Number(node.getAttribute("data-video-id") || 0);
      if (id) startPlayback(id).catch((err) => { el.streamNotice.textContent = err.message || "Playback failed"; });
    });
  });
}

async function loadCourse() {
  const courseId = Number(el.courseIdInput.value || 0);
  if (!courseId) throw new Error("Enter course id");
  state.courseId = courseId;

  const entitlement = await api("GET", `/stream/courses/${courseId}/entitlement`);
  if (!entitlement.entitled) throw new Error("You have not purchased this course.");

  const out = await api("GET", `/stream/courses/${courseId}/lessons`);
  state.lessons = out.lessons || [];
  const first = pickFirstReadyVideo(state.lessons);
  state.activeVideoId = Number(first?.lesson_video_id || 0);
  renderLessons();
  if (state.activeVideoId) await startPlayback(state.activeVideoId);
}

async function startPlayback(lessonVideoId) {
  const tok = await api("POST", "/stream/playback/token", {
    lesson_video_id: Number(lessonVideoId),
    client_app: "web",
  });
  state.activeVideoId = Number(lessonVideoId);
  state.activeSessionId = Number(tok.session_id || 0);
  state.lastPosition = Number(tok.resume_position_seconds || 0);
  el.playerFrame.src = tok.playback?.iframe_url || "";
  el.resumeInfo.textContent = `Resume: ${state.lastPosition}s`;
  const usage = tok.fair_usage || {};
  const ratioPct = Math.round(Number(usage.ratio || 0) * 100);
  el.usageInfo.textContent = `Fair usage: ${ratioPct}% (${Math.round((Number(usage.consumed_seconds || 0) / 60))}m / ${Math.round((Number(usage.allowance_seconds || 0) / 60))}m)`;

  renderLessons();
  startHeartbeat();
}

function startHeartbeat() {
  if (state.heartbeatId) {
    clearInterval(state.heartbeatId);
    state.heartbeatId = null;
  }
  if (!state.activeSessionId || !state.activeVideoId) return;
  state.heartbeatId = setInterval(async () => {
    try {
      state.lastPosition += 10;
      const out = await api("POST", "/stream/watch/heartbeat", {
        session_id: state.activeSessionId,
        lesson_video_id: state.activeVideoId,
        watched_seconds_delta: 10,
        position_seconds: state.lastPosition,
        player_state: "playing",
        ended: false,
      });
      const usage = out.fair_usage || {};
      const ratioPct = Math.round(Number(usage.ratio || 0) * 100);
      const flags = (usage.status_flags || []).join(", ");
      el.usageInfo.textContent = `Fair usage: ${ratioPct}% (${Math.round((Number(usage.consumed_seconds || 0) / 60))}m / ${Math.round((Number(usage.allowance_seconds || 0) / 60))}m)${flags ? ` | ${flags}` : ""}`;
      el.resumeInfo.textContent = `Resume: ${Math.max(0, Number(out.resume_position_seconds || state.lastPosition))}s`;
    } catch (err) {
      el.streamNotice.textContent = `Progress save failed: ${err.message || err}`;
    }
  }, 10000);
}

el.loadCourseBtn?.addEventListener("click", () => {
  loadCourse().catch((err) => {
    el.streamNotice.textContent = err.message || "Failed to load course";
  });
});

(async function boot() {
  await initAuth();
})();
