import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  setPersistence,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const state = {
  auth: null,
  context: null,
  authLoginInFlight: false,
  authLoginFallbackTimer: null,
  authRoleSetupInFlight: false,
  moderationMode: "reports",
  approvalsTab: "students",
  reports: [],
  complaints: [],
  adminPollingId: null,
  courseWizardStep: "details",
  draftTopics: [],
  activeDraftId: null,
  providerCourses: [],
  providerDrafts: [],
  providerAssessments: [],
  viewerTopics: [],
  studentViewerTopics: [],
  studentActiveCourseId: null,
  studentVideoCompletionSent: {},
  videoDurationByUrl: {},
  assessmentDraftQuestions: [],
  assessmentEditingExamId: null,
  assessmentPreview: {
    mode: "preview",
    attemptId: null,
    exam: null,
    questions: [],
    index: 0,
    answers: {},
    latestResult: null,
    trainingFeedbackChoice: "",
    timerId: null,
    remainingSec: 0,
    timerPaused: false,
    warningPauseCount: 0,
    proctor: defaultProctorState(),
  },
};

window.__certoraDebug = {
  getState() {
    return state;
  },
  getCurrentUser() {
    return state.auth?.currentUser ?? null;
  },
  async getIdToken(forceRefresh = false) {
    const user = state.auth?.currentUser;
    if (!user) throw new Error("No signed-in user found");
    return user.getIdToken(forceRefresh);
  },
};

function formatAuthError(err, fallback) {
  const code = String(err?.code || "").trim();
  const message = String(err?.message || "").trim();
  if (!code && message) {
    try {
      const parsed = JSON.parse(message);
      if (parsed?.status === 500) {
        return "Account was created in Firebase but profile setup failed on server. Retry once or login and complete role setup.";
      }
      if (parsed?.status === 409) {
        return String(parsed?.data?.detail || "Account setup conflict. Please login and retry.");
      }
    } catch {}
  }
  if (code === "auth/invalid-credential") {
    return "Invalid email/password. If account exists, use correct password or reset password.";
  }
  if (code === "auth/email-already-in-use") {
    return "Email already exists. Use Login, or continue Signup with the same existing password.";
  }
  if (code === "auth/invalid-api-key") {
    return "Authentication config error (invalid Firebase API key).";
  }
  if (code) return `${fallback}: ${code}`;
  if (message) return `${fallback}: ${message}`;
  return fallback;
}

function isPlayableVideoElement(video) {
  return Boolean(
    video
    && Number(video.videoWidth) > 0
    && Number(video.videoHeight) > 0
    && video.readyState >= 2,
  );
}

function isRoleRegistrationRequiredError(err) {
  return String(err?.message || "").includes("Account role not registered");
}

function openAccountSetupForCurrentUser() {
  showView("auth");
  showAuthMode("signup");
  if (el.signupName && state.auth?.currentUser?.displayName) el.signupName.value = state.auth.currentUser.displayName;
  if (el.signupEmail && state.auth?.currentUser?.email) el.signupEmail.value = state.auth.currentUser.email;
}

const $ = (id) => document.getElementById(id);
let faceLandmarkerCachePromise = null;
let phoneDetectorCachePromise = null;
let handLandmarkerCachePromise = null;

function defaultProctorState() {
  return {
    sessionId: null,
    warnings: 0,
    maxWarnings: 3,
    penaltyPerWarningPct: 5,
    stream: null,
    audioContext: null,
    analyser: null,
    monitorId: null,
    lastFrame: null,
    lastFaceMetrics: null,
    movementFrames: 0,
    faceModel: null,
    faceModelError: "",
    faceAbsentFrames: 0,
    faceAwayFrames: 0,
    faceMismatchFrames: 0,
    gazeAwayFrames: 0,
    faceTooFarFrames: 0,
    multiFaceFrames: 0,
    speechFrames: 0,
    loudVoiceFrames: 0,
    candidateSpeechFrames: 0,
    backgroundVoiceFrames: 0,
    sideHandFrames: 0,
    handNearFaceFrames: 0,
    lookAwaySinceMs: 0,
    faceReference: null,
    behaviorSignature: null,
    behaviorDriftFrames: 0,
    challengeActive: false,
    challengeTarget: "",
    challengeStartMs: 0,
    challengeDeadlineMs: 0,
    challengeCooldownUntil: 0,
    challengeNextAtMs: 0,
    challengePasses: 0,
    challengeFailures: 0,
    environmentAttested: false,
    precheckReady: false,
    calibrated: false,
    audioBaselineRms: 0.03,
    baselineEvidenceReady: false,
    monitorTick: 0,
    phoneFrames: 0,
    phoneModelReady: false,
    handModel: null,
    handModelReady: false,
    startingUp: false,
    warnCooldownMs: 8000,
    lastWarnAt: {},
    visibilityHandler: null,
    blurHandler: null,
    focusHandler: null,
    fullscreenHandler: null,
    gazeGraceUntilMs: 0,
    gazeLastTickMs: 0,
    gazeAllowedUiZones: { primary: true, secondary: true, tertiary: true },
    gazeAllowedRect: { left: 0, right: 1, top: 0, bottom: 1 },
    gazeSmoothedTarget: null,
    gazeSuspicionPoints: [],
    gazeEscalationStageMax: 0,
    gazeFlagReviewEmitted: false,
    gazeLastEmitAt: {},
    gazeSuspiciousDwellMs: 0,
    gazeLastZone: "",
    gazeVarianceSamples: [],
    gazeStaticSuspiciousMs: 0,
    gazeClusterDwellTotals: {},
    gazeSuspiciousEnterCount: {},
    gazeQuestionAwayEpisodes: 0,
    gazeQuestionAwayMarked: false,
    gazeQuestionsWithAwayPattern: 0,
    gazeQuestionPatternWarningsIssued: 0,
    gazeLaptopAwayMarked: false,
    gazeContinuousWarningCount: 0,
    gazeNextContinuousWarningMs: 0,
    gazeDominantClusterHistory: [],
    gazeCrossPatternLastEmit: 0,
    gazeLayer1LogMs: 0,
  };
}

function detectAudioRms() {
  const p = state.assessmentPreview.proctor;
  if (!p.analyser) return 0;
  const arr = new Uint8Array(p.analyser.fftSize);
  p.analyser.getByteTimeDomainData(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const d = (arr[i] - 128) / 128;
    sum += d * d;
  }
  return Math.sqrt(sum / arr.length);
}

function computeFaceMetrics(lm) {
  const leftEye = lm?.[33];
  const rightEye = lm?.[263];
  const nose = lm?.[1];
  const upperLip = lm?.[13];
  const lowerLip = lm?.[14];
  const mouthLeft = lm?.[78];
  const mouthRight = lm?.[308];
  const leftEyeInner = lm?.[133];
  const rightEyeInner = lm?.[362];
  const leftEyeUpper = lm?.[159];
  const leftEyeLower = lm?.[145];
  const rightEyeUpper = lm?.[386];
  const rightEyeLower = lm?.[374];
  const leftIris = [lm?.[468], lm?.[469], lm?.[470], lm?.[471], lm?.[472]].filter(Boolean);
  const rightIris = [lm?.[473], lm?.[474], lm?.[475], lm?.[476], lm?.[477]].filter(Boolean);
  if (!leftEye || !rightEye || !nose) return null;
  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const eyeDist = Math.hypot(eyeDx, eyeDy);
  if (!Number.isFinite(eyeDist) || eyeDist < 0.00001) return null;
  const noseLeft = Math.hypot(nose.x - leftEye.x, nose.y - leftEye.y) / eyeDist;
  const noseRight = Math.hypot(nose.x - rightEye.x, nose.y - rightEye.y) / eyeDist;
  const ratio = (nose.x - leftEye.x) / (rightEye.x - leftEye.x || 0.000001);
  const faceCenterX = (leftEye.x + rightEye.x + nose.x) / 3;
  const faceCenterY = (leftEye.y + rightEye.y + nose.y) / 3;
  const leftEyeOpenRatio = leftEyeUpper && leftEyeLower ? Math.abs(leftEyeLower.y - leftEyeUpper.y) / eyeDist : null;
  const rightEyeOpenRatio = rightEyeUpper && rightEyeLower ? Math.abs(rightEyeLower.y - rightEyeUpper.y) / eyeDist : null;
  let leftGazeX = null;
  let rightGazeX = null;
  let leftGazeY = null;
  let rightGazeY = null;
  let mouthOpenRatio = null;
  if (leftEyeInner && leftIris.length) {
    const irisX = leftIris.reduce((acc, p) => acc + p.x, 0) / leftIris.length;
    leftGazeX = (irisX - leftEye.x) / ((leftEyeInner.x - leftEye.x) || 0.000001);
    if (leftEyeUpper && leftEyeLower) {
      const irisY = leftIris.reduce((acc, p) => acc + p.y, 0) / leftIris.length;
      leftGazeY = (irisY - leftEyeUpper.y) / ((leftEyeLower.y - leftEyeUpper.y) || 0.000001);
    }
  }
  if (rightEyeInner && rightIris.length) {
    const irisX = rightIris.reduce((acc, p) => acc + p.x, 0) / rightIris.length;
    rightGazeX = (irisX - rightEyeInner.x) / ((rightEye.x - rightEyeInner.x) || 0.000001);
    if (rightEyeUpper && rightEyeLower) {
      const irisY = rightIris.reduce((acc, p) => acc + p.y, 0) / rightIris.length;
      rightGazeY = (irisY - rightEyeUpper.y) / ((rightEyeLower.y - rightEyeUpper.y) || 0.000001);
    }
  }
  if (upperLip && lowerLip && mouthLeft && mouthRight) {
    const mouthHeight = Math.hypot(lowerLip.x - upperLip.x, lowerLip.y - upperLip.y);
    const mouthWidth = Math.hypot(mouthRight.x - mouthLeft.x, mouthRight.y - mouthLeft.y);
    mouthOpenRatio = mouthHeight / (mouthWidth || 0.000001);
  }
  return {
    eyeDist,
    noseLeft,
    noseRight,
    ratio,
    faceCenterX,
    faceCenterY,
    leftEyeOpenRatio,
    rightEyeOpenRatio,
    leftGazeX,
    rightGazeX,
    leftGazeY,
    rightGazeY,
    mouthOpenRatio,
  };
}

/** Three-layer gaze policy: raw zones → scored suspicion events → rolling-window thresholds (no instant “looked away” warnings). */
const GAZE_ROLLING_MS = 120000;
const GAZE_UI_GRACE_MS = 1800;
const GAZE_QUESTION_OPTIONS_AWAY_MARK_MS = 1400;
const GAZE_QUESTION_OPTIONS_AWAY_REPEAT_COUNT = 2;
const GAZE_LAPTOP_AWAY_LIMIT_MS = 2500;
const GAZE_CONTINUOUS_WARNING_INITIAL_MS = 2600;
const GAZE_CONTINUOUS_WARNING_REPEAT_MS = 3200;
const GAZE_STATIC_LOW_VAR = 0.034;
const GAZE_STATIC_PTS_MS = 2000;
const GAZE_EVENT_DEBOUNCE_MS = 14000;

function computeQuestionPanelAllowedGazeZones() {
  const screenRect = el.assessmentPreviewScreen?.getBoundingClientRect?.();
  const contentRect = el.apQuestionContent?.getBoundingClientRect?.();
  const questionRect = el.apQuestionText?.getBoundingClientRect?.();
  const optionsRect = el.apOptionsList?.getBoundingClientRect?.();
  let panelRect = null;
  if (questionRect && optionsRect) {
    panelRect = {
      left: Math.min(questionRect.left, optionsRect.left),
      right: Math.max(questionRect.right, optionsRect.right),
      top: Math.min(questionRect.top, optionsRect.top),
      bottom: Math.max(questionRect.bottom, optionsRect.bottom),
      width: Math.max(questionRect.right, optionsRect.right) - Math.min(questionRect.left, optionsRect.left),
    };
  } else {
    panelRect = contentRect || el.apQuestionPanel?.getBoundingClientRect?.();
  }
  if (!screenRect || !panelRect || screenRect.width < 60 || panelRect.width < 40) {
    return {
      zones: { primary: true, secondary: true, tertiary: true },
      rect: { left: 0, right: 1, top: 0, bottom: 1 },
    };
  }
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const left = clamp(panelRect.left - screenRect.left, 0, screenRect.width);
  const right = clamp(panelRect.right - screenRect.left, 0, screenRect.width);
  const top = clamp(panelRect.top - screenRect.top, 0, screenRect.height || 1);
  const bottom = clamp(panelRect.bottom - screenRect.top, 0, screenRect.height || 1);
  const padX = Math.min(28, screenRect.width * 0.025);
  const padY = Math.min(24, (screenRect.height || 1) * 0.03);
  const zoneLeft = Math.max(0, left - padX);
  const zoneRight = Math.min(screenRect.width, right + padX);
  const zoneTop = Math.max(0, top - padY);
  const zoneBottom = Math.min(screenRect.height || 1, bottom + padY);
  const third = screenRect.width / 3;
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const minimumOverlap = Math.max(24, third * 0.16);
  const secondary = overlap(zoneLeft, zoneRight, 0, third) >= minimumOverlap;
  const primary = overlap(zoneLeft, zoneRight, third, third * 2) >= minimumOverlap;
  const tertiary = overlap(zoneLeft, zoneRight, third * 2, screenRect.width) >= minimumOverlap;
  return {
    zones: {
      primary: primary || (!secondary && !tertiary),
      secondary,
      tertiary,
    },
    rect: {
      left: zoneLeft / screenRect.width,
      right: zoneRight / screenRect.width,
      top: zoneTop / Math.max(1, screenRect.height || 1),
      bottom: zoneBottom / Math.max(1, screenRect.height || 1),
    },
  };
}

function refreshQuestionPanelGazeZones() {
  const cfg = computeQuestionPanelAllowedGazeZones();
  state.assessmentPreview.proctor.gazeAllowedUiZones = cfg.zones;
  state.assessmentPreview.proctor.gazeAllowedRect = cfg.rect;
}

function estimateGazeTarget(metrics, ref) {
  if (!metrics || !ref) return null;
  const ratio = Number(metrics.ratio);
  const lg = Number(metrics.leftGazeX);
  const rg = Number(metrics.rightGazeX);
  const lgy = Number(metrics.leftGazeY);
  const rgy = Number(metrics.rightGazeY);
  const lb = Number(ref.leftGazeX);
  const rb = Number(ref.rightGazeX);
  const lby = Number(ref.leftGazeY);
  const rby = Number(ref.rightGazeY);
  const faceYNow = Number(metrics.faceCenterY);
  const faceYBase = Number(ref.faceCenterY);
  const leftOpen = Number(metrics.leftEyeOpenRatio);
  const rightOpen = Number(metrics.rightEyeOpenRatio);
  const leftOpenBase = Number(ref.leftEyeOpenRatio);
  const rightOpenBase = Number(ref.rightEyeOpenRatio);
  if (!Number.isFinite(ratio) || !Number.isFinite(lg) || !Number.isFinite(rg) || !Number.isFinite(lb) || !Number.isFinite(rb)) return null;
  const eyeDeltaX = ((lg - lb) + (rg - rb)) / 2;
  const headDeltaX = ratio - Number(ref.ratio || 0.5);
  let x = 0.5 + eyeDeltaX * 1.6 + headDeltaX * 2.2;
  let y = 0.5;
  if (Number.isFinite(lgy) && Number.isFinite(rgy) && Number.isFinite(lby) && Number.isFinite(rby)) {
    const eyeDeltaY = ((lgy - lby) + (rgy - rby)) / 2;
    const headDeltaY = Number.isFinite(faceYNow) && Number.isFinite(faceYBase) ? faceYNow - faceYBase : 0;
    y = 0.5 + eyeDeltaY * 1.25 + headDeltaY * 1.9;
  }
  let confidence = 1;
  if (Number.isFinite(leftOpen) && Number.isFinite(rightOpen)) {
    const openMin = Math.min(leftOpen, rightOpen);
    const openBase = Math.max(0.0001, Math.min(
      Number.isFinite(leftOpenBase) ? leftOpenBase : openMin,
      Number.isFinite(rightOpenBase) ? rightOpenBase : openMin,
    ));
    if (openMin < openBase * 0.58) confidence -= 0.32;
    if (Math.abs(leftOpen - rightOpen) > 0.012) confidence -= 0.16;
  }
  if (Math.abs(headDeltaX) > 0.16) confidence -= 0.18;
  if (Math.abs(eyeDeltaX) > 0.22) confidence -= 0.08;
  if (!(Number.isFinite(lgy) && Number.isFinite(rgy) && Number.isFinite(lby) && Number.isFinite(rby))) confidence -= 0.08;
  return {
    x: clamp01(x),
    y: clamp01(y),
    eyeDeltaX,
    headDeltaX,
    confidence: clamp01(confidence),
  };
}

function getSmoothedGazeTarget(p, target) {
  if (!target) return null;
  const current = p.gazeSmoothedTarget;
  const alpha = target.confidence >= 0.8 ? 0.42 : target.confidence >= 0.6 ? 0.28 : 0.16;
  if (!current) {
    p.gazeSmoothedTarget = { ...target };
    return p.gazeSmoothedTarget;
  }
  p.gazeSmoothedTarget = {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    eyeDeltaX: target.eyeDeltaX,
    headDeltaX: target.headDeltaX,
    confidence: current.confidence + (target.confidence - current.confidence) * 0.35,
  };
  return p.gazeSmoothedTarget;
}

function classifyGazeUiZone(p, metrics, ref, allowedZones = null, allowedRect = null) {
  const rawTarget = estimateGazeTarget(metrics, ref);
  const target = getSmoothedGazeTarget(p, rawTarget);
  if (!target) return "neutral";
  if (allowedRect) {
    const marginX = target.confidence >= 0.82 ? 0.018 : target.confidence >= 0.65 ? 0.04 : 0.07;
    const marginY = target.confidence >= 0.82 ? 0.022 : target.confidence >= 0.65 ? 0.05 : 0.08;
    const insideRect = (
      target.x >= Number(allowedRect.left ?? 0) &&
      target.x <= Number(allowedRect.right ?? 1) &&
      target.y >= Number(allowedRect.top ?? 0) &&
      target.y <= Number(allowedRect.bottom ?? 1)
    );
    const nearRect = (
      target.x >= Number(allowedRect.left ?? 0) - marginX &&
      target.x <= Number(allowedRect.right ?? 1) + marginX &&
      target.y >= Number(allowedRect.top ?? 0) - marginY &&
      target.y <= Number(allowedRect.bottom ?? 1) + marginY
    );
    if (!insideRect && nearRect) return "neutral";
    if (!insideRect) return "suspicious";
    if (target.confidence < 0.45) return "neutral";
  }
  let zone = "primary";
  if (target.x < 1 / 3) zone = "secondary";
  else if (target.x > 2 / 3) zone = "tertiary";
  if (!allowedZones || !["primary", "secondary", "tertiary"].includes(zone)) return zone;
  return allowedZones[zone] ? zone : "suspicious";
}

function gazeSuspicionClusterKey(metrics) {
  if (!metrics) return "";
  const x = Math.round(Number(metrics.faceCenterX || 0) * 8) / 8;
  const y = Math.round(Number(metrics.faceCenterY || 0) * 8) / 8;
  return `${x}_${y}`;
}

function sumGazeSuspicionWindow(p) {
  const now = Date.now();
  const arr = p.gazeSuspicionPoints || [];
  return arr.filter((e) => now - e.t <= GAZE_ROLLING_MS).reduce((a, e) => a + e.pts, 0);
}

function canEmitGazeEvent(p, code) {
  const last = p.gazeLastEmitAt[code] || 0;
  return Date.now() - last >= GAZE_EVENT_DEBOUNCE_MS;
}

function markGazeEventEmitted(p, code) {
  p.gazeLastEmitAt[code] = Date.now();
}

function addGazeSuspicionPoints(p, pts, code, details = {}) {
  if (!pts) return;
  const now = Date.now();
  p.gazeSuspicionPoints.push({ t: now, pts, code, details });
  const cutoff = now - GAZE_ROLLING_MS - 5000;
  p.gazeSuspicionPoints = p.gazeSuspicionPoints.filter((e) => e.t >= cutoff);
  logProctorEvent("info", "gaze_suspicion_layer2", {
    layer2_code: code,
    points_added: pts,
    rolling_score: sumGazeSuspicionWindow(p),
    ...details,
  }).catch(() => {});
  reapGazeSuspicionEscalation(p);
}

function reapGazeSuspicionEscalation(p) {
  const s = sumGazeSuspicionWindow(p);
  const stage = p.gazeEscalationStageMax || 0;
  if (s >= 9 && !p.gazeFlagReviewEmitted) {
    p.gazeFlagReviewEmitted = true;
    p.gazeEscalationStageMax = Math.max(stage, 9);
    logProctorEvent("warning", "gaze_pattern_review_flag", { rolling_score: s }).catch(() => {});
    pushProctorWarning(
      "Repeated off-screen gaze pattern noted. This session may be reviewed.",
      "gaze_pattern_review",
      "warning",
    );
  } else if (s >= 7 && stage < 7) {
    p.gazeEscalationStageMax = 7;
    toast("Please keep your attention on the test screen.");
    logProctorEvent("info", "gaze_soft_attention_notice", { rolling_score: s }).catch(() => {});
  } else if (s >= 5 && stage < 5) {
    p.gazeEscalationStageMax = 5;
    logProctorEvent("info", "gaze_suspicion_internal", { rolling_score: s }).catch(() => {});
  } else if (s >= 3 && stage < 3) {
    p.gazeEscalationStageMax = 3;
    logProctorEvent("info", "gaze_suspicion_silent_log", { rolling_score: s }).catch(() => {});
  }
}

function resetPerQuestionGazeAccumulators(p) {
  p.gazeSuspiciousDwellMs = 0;
  p.gazeSuspiciousEnterCount = {};
  p.gazeClusterDwellTotals = {};
  p.gazeSmoothedTarget = null;
  p.gazeQuestionAwayEpisodes = 0;
  p.gazeQuestionAwayMarked = false;
  p.gazeLaptopAwayMarked = false;
  p.gazeContinuousWarningCount = 0;
  p.gazeNextContinuousWarningMs = 0;
  p.gazeVarianceSamples = [];
  p.gazeStaticSuspiciousMs = 0;
  p.gazeLastZone = "";
}

function resetGazeSuspicionSessionState(p) {
  p.gazeGraceUntilMs = 0;
  p.gazeLastTickMs = 0;
  p.gazeSuspicionPoints = [];
  p.gazeEscalationStageMax = 0;
  p.gazeFlagReviewEmitted = false;
  p.gazeLastEmitAt = {};
  resetPerQuestionGazeAccumulators(p);
  p.gazeQuestionsWithAwayPattern = 0;
  p.gazeQuestionPatternWarningsIssued = 0;
  p.gazeDominantClusterHistory = [];
  p.gazeCrossPatternLastEmit = 0;
  p.gazeLayer1LogMs = 0;
}

function beginGazeQuestionGrace(p) {
  refreshQuestionPanelGazeZones();
  p.gazeGraceUntilMs = Date.now() + GAZE_UI_GRACE_MS;
}

function finalizeGazeQuestionForNavigation(preview, leavingForward) {
  const p = preview.proctor;
  if (!leavingForward) {
    resetPerQuestionGazeAccumulators(p);
    beginGazeQuestionGrace(p);
    return;
  }
  const q = preview.questions[preview.index];
  if (q) {
    const correctIds = (q.options || []).filter((o) => o.is_correct).map((o) => o.option_id).sort((a, b) => a - b);
    const selected = (preview.answers[q.question_id] || []).slice().sort((a, b) => a - b);
    const ok = selected.length === correctIds.length && selected.every((v, i) => v === correctIds[i]);
    const now = Date.now();
    const recent = (p.gazeSuspicionPoints || []).filter((e) => now - e.t <= 5000);
    const recentPts = recent.reduce((a, e) => a + e.pts, 0);
    if (ok && recentPts > 0 && canEmitGazeEvent(p, "fast_correct_after_suspicion")) {
      markGazeEventEmitted(p, "fast_correct_after_suspicion");
      const hard = Number(q.marks || 1) >= 2;
      addGazeSuspicionPoints(p, hard ? 2 : 1, "fast_correct_after_suspicion", { question_id: q.question_id });
    }
  }
  if ((p.gazeQuestionAwayEpisodes || 0) > 0) {
    p.gazeQuestionsWithAwayPattern = (p.gazeQuestionsWithAwayPattern || 0) + 1;
    const expectedWarnings = Math.floor((p.gazeQuestionsWithAwayPattern || 0) / 2);
    if (expectedWarnings > (p.gazeQuestionPatternWarningsIssued || 0)) {
      p.gazeQuestionPatternWarningsIssued = expectedWarnings;
      pushProctorWarning(
        "Repeated gaze away from the question text was detected across multiple questions.",
        "repeated_question_text_gaze_pattern",
        "warning",
      );
      logProctorEvent("warning", "repeated_question_text_gaze_pattern_detail", {
        questions_with_away_pattern: p.gazeQuestionsWithAwayPattern,
        warnings_issued: p.gazeQuestionPatternWarningsIssued,
      }).catch(() => {});
    }
  }
  const totals = p.gazeClusterDwellTotals || {};
  let dominant = "";
  let maxD = 0;
  for (const [k, v] of Object.entries(totals)) {
    if (v > maxD) {
      maxD = v;
      dominant = k;
    }
  }
  if (dominant && maxD > 1200) {
    p.gazeDominantClusterHistory = (p.gazeDominantClusterHistory || []).concat([dominant]).slice(-10);
    const h = p.gazeDominantClusterHistory;
    if (h.length >= 3 && h[h.length - 1] === h[h.length - 2] && h[h.length - 2] === h[h.length - 3]) {
      const now = Date.now();
      if (now - (p.gazeCrossPatternLastEmit || 0) > 60000 && canEmitGazeEvent(p, "cross_question_zone_pattern")) {
        p.gazeCrossPatternLastEmit = now;
        markGazeEventEmitted(p, "cross_question_zone_pattern");
        addGazeSuspicionPoints(p, 3, "cross_question_zone_pattern", { cluster: dominant });
      }
    }
  }
  resetPerQuestionGazeAccumulators(p);
  beginGazeQuestionGrace(p);
}

function tickGazeThreeLayerModel(p, metrics, now) {
  if (!p.faceReference || !metrics) return;
  if (now < (p.gazeGraceUntilMs || 0)) return;
  const dt = p.gazeLastTickMs ? Math.min(900, Math.max(80, now - p.gazeLastTickMs)) : 500;
  p.gazeLastTickMs = now;

  const zone = classifyGazeUiZone(metrics, p.faceReference, p.gazeAllowedUiZones, p.gazeAllowedRect);
  const suspicious = zone === "suspicious";
  const cluster = suspicious ? gazeSuspicionClusterKey(metrics) : "";

  if (suspicious && cluster) {
    p.gazeClusterDwellTotals[cluster] = (p.gazeClusterDwellTotals[cluster] || 0) + dt;
  }

  const prev = p.gazeLastZone || "";
  p.gazeLastZone = zone;
  if (suspicious && prev !== "suspicious" && cluster) {
    p.gazeSuspiciousEnterCount[cluster] = (p.gazeSuspiciousEnterCount[cluster] || 0) + 1;
    const n = p.gazeSuspiciousEnterCount[cluster];
    if (n >= 3 && canEmitGazeEvent(p, `revisit_${cluster}`)) {
      markGazeEventEmitted(p, `revisit_${cluster}`);
      addGazeSuspicionPoints(p, 2, "suspicious_zone_revisited", { cluster, visits: n });
    }
  }

  if (suspicious) {
    p.gazeSuspiciousDwellMs = (p.gazeSuspiciousDwellMs || 0) + dt;
  } else {
    p.gazeSuspiciousDwellMs = 0;
    p.gazeQuestionAwayMarked = false;
    p.gazeLaptopAwayMarked = false;
    p.gazeContinuousWarningCount = 0;
    p.gazeNextContinuousWarningMs = 0;
  }
  if (
    p.gazeSuspiciousDwellMs >= GAZE_QUESTION_OPTIONS_AWAY_MARK_MS &&
    !p.gazeQuestionAwayMarked
  ) {
    p.gazeQuestionAwayMarked = true;
    p.gazeQuestionAwayEpisodes = (p.gazeQuestionAwayEpisodes || 0) + 1;
    addGazeSuspicionPoints(p, 1, "gaze_outside_question_options", {
      dwell_ms: Math.round(p.gazeSuspiciousDwellMs),
      episodes_this_question: p.gazeQuestionAwayEpisodes,
    });
    if (p.gazeQuestionAwayEpisodes >= GAZE_QUESTION_OPTIONS_AWAY_REPEAT_COUNT) {
      logProctorEvent("info", "repeated_question_options_gaze_away", {
        episodes_this_question: p.gazeQuestionAwayEpisodes,
        dwell_ms: Math.round(p.gazeSuspiciousDwellMs),
      }).catch(() => {});
      addGazeSuspicionPoints(p, 1, "repeated_question_options_gaze_away", {
        episodes_this_question: p.gazeQuestionAwayEpisodes,
      });
    }
  }
  if (
    p.gazeSuspiciousDwellMs >= GAZE_LAPTOP_AWAY_LIMIT_MS &&
    !p.gazeLaptopAwayMarked &&
    canEmitGazeEvent(p, "gaze_away_over_3s")
  ) {
    p.gazeLaptopAwayMarked = true;
    markGazeEventEmitted(p, "gaze_away_over_3s");
    addGazeSuspicionPoints(p, 2, "gaze_away_over_3s", {
      dwell_ms: Math.round(p.gazeSuspiciousDwellMs),
    });
  }
  if (
    p.gazeSuspiciousDwellMs >= GAZE_CONTINUOUS_WARNING_INITIAL_MS &&
    (p.gazeNextContinuousWarningMs || 0) <= p.gazeSuspiciousDwellMs
  ) {
    p.gazeContinuousWarningCount = 1;
    p.gazeNextContinuousWarningMs = p.gazeSuspiciousDwellMs + GAZE_CONTINUOUS_WARNING_REPEAT_MS;
    logProctorEvent("info", "continuous_question_area_gaze_detail", {
      continuous_warning_count: 1,
      dwell_ms: Math.round(p.gazeSuspiciousDwellMs),
    }).catch(() => {});
  }

  const lg = Number(metrics.leftGazeX);
  const rg = Number(metrics.rightGazeX);
  if (Number.isFinite(lg) && Number.isFinite(rg)) {
    const g = (lg + rg) / 2;
    const samples = p.gazeVarianceSamples || [];
    samples.push(g);
    while (samples.length > 18) samples.shift();
    p.gazeVarianceSamples = samples;
    if (samples.length >= 10 && suspicious) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const v = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
      if (v < GAZE_STATIC_LOW_VAR) p.gazeStaticSuspiciousMs = (p.gazeStaticSuspiciousMs || 0) + dt;
      else p.gazeStaticSuspiciousMs = Math.max(0, (p.gazeStaticSuspiciousMs || 0) - dt * 0.5);
    } else {
      p.gazeStaticSuspiciousMs = 0;
    }
    if (p.gazeStaticSuspiciousMs >= GAZE_STATIC_PTS_MS && canEmitGazeEvent(p, "static_gaze_suspicious")) {
      markGazeEventEmitted(p, "static_gaze_suspicious");
      addGazeSuspicionPoints(p, 1, "static_gaze_suspicious_zone", {});
      p.gazeStaticSuspiciousMs = 0;
    }
  }

  if (now - (p.gazeLayer1LogMs || 0) > 12000 && suspicious) {
    p.gazeLayer1LogMs = now;
    const target = estimateGazeTarget(metrics, p.faceReference);
    logProctorEvent("info", "gaze_layer1_observation", {
      zone,
      cluster,
      ratio: metrics.ratio,
      leftGazeX: metrics.leftGazeX,
      rightGazeX: metrics.rightGazeX,
      leftGazeY: metrics.leftGazeY,
      rightGazeY: metrics.rightGazeY,
      estimatedTargetX: target?.x,
      estimatedTargetY: target?.y,
    }).catch(() => {});
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function buildBehaviorSignature(faceRef, audioBaselineRms) {
  if (!faceRef) return null;
  return {
    faceCenterX: Number(faceRef.faceCenterX || 0.5),
    faceCenterY: Number(faceRef.faceCenterY || 0.5),
    eyeDist: Number(faceRef.eyeDist || 0),
    leftGazeX: Number(faceRef.leftGazeX || 0.5),
    rightGazeX: Number(faceRef.rightGazeX || 0.5),
    leftGazeY: Number(faceRef.leftGazeY || 0.5),
    rightGazeY: Number(faceRef.rightGazeY || 0.5),
    mouthOpenRatio: Number(faceRef.mouthOpenRatio || 0.02),
    audioBaselineRms: Number(audioBaselineRms || 0.03),
  };
}

function evaluateBehaviorDrift() {
  const p = state.assessmentPreview.proctor;
  const sig = p.behaviorSignature;
  const metrics = p.lastFaceMetrics;
  if (!sig || !metrics) return { score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  const faceShift = Math.hypot(
    Number(metrics.faceCenterX || 0) - Number(sig.faceCenterX || 0),
    Number(metrics.faceCenterY || 0) - Number(sig.faceCenterY || 0),
  );
  if (faceShift > 0.09) {
    score += 0.8;
    reasons.push("face_position_shift");
  }

  const eyeDist = Number(metrics.eyeDist || 0);
  const eyeBase = Number(sig.eyeDist || 0);
  const faceScaleDrift = eyeBase > 0 ? Math.abs(eyeDist - eyeBase) / eyeBase : 0;
  if (faceScaleDrift > 0.24) {
    score += 0.9;
    reasons.push("face_scale_drift");
  }

  const leftBase = Number(sig.leftGazeX || 0.5);
  const rightBase = Number(sig.rightGazeX || 0.5);
  const leftNow = Number(metrics.leftGazeX || leftBase);
  const rightNow = Number(metrics.rightGazeX || rightBase);
  const gazeDrift = Math.max(Math.abs(leftNow - leftBase), Math.abs(rightNow - rightBase));
  if (gazeDrift > 0.2) {
    score += 1.1;
    reasons.push("gaze_drift");
  }

  const rms = detectAudioRms();
  const audioBase = Number(sig.audioBaselineRms || 0.03);
  const audioDrift = audioBase > 0 ? rms / audioBase : 0;
  if (audioDrift > 2.4) {
    score += 0.7;
    reasons.push("audio_drift");
  }

  if (p.sideHandFrames >= 2) {
    score += 0.9;
    reasons.push("side_hand_pattern");
  }
  if (p.handNearFaceFrames >= 2) {
    score += 0.8;
    reasons.push("hand_near_face_pattern");
  }
  const mouthBase = Number(sig.mouthOpenRatio || 0.02);
  const mouthNow = Number(metrics.mouthOpenRatio || mouthBase);
  if (mouthNow > mouthBase + 0.045 && audioDrift > 1.7) {
    score += 0.7;
    reasons.push("mouth_audio_sync");
  }

  return { score, reasons };
}

function detectCandidateSpeech() {
  const p = state.assessmentPreview.proctor;
  const metrics = p.lastFaceMetrics;
  const sig = p.behaviorSignature;
  if (!metrics || !sig) return false;
  const rms = detectAudioRms();
  const audioBase = Number(sig.audioBaselineRms || p.audioBaselineRms || 0.03);
  const mouthBase = Number(sig.mouthOpenRatio || 0.02);
  const mouthNow = Number(metrics.mouthOpenRatio || mouthBase);
  const voiceActive = rms > Math.max(0.05, audioBase * 1.8);
  const mouthActive = mouthNow > mouthBase + 0.04;
  return voiceActive && mouthActive;
}

function detectBackgroundVoice() {
  const p = state.assessmentPreview.proctor;
  const metrics = p.lastFaceMetrics;
  const sig = p.behaviorSignature;
  const rms = detectAudioRms();
  const audioBase = Number(sig?.audioBaselineRms || p.audioBaselineRms || 0.03);
  const mouthBase = Number(sig?.mouthOpenRatio || 0.02);
  const mouthNow = Number(metrics?.mouthOpenRatio || mouthBase);
  const voiceActive = rms > Math.max(0.05, audioBase * 1.7);
  const mouthStill = mouthNow <= mouthBase + 0.025;
  return voiceActive && mouthStill;
}

function clearAttentionChallengeOverlay() {
  el.apAttentionChallenge?.classList.add("hidden");
  el.apAttentionChallenge?.classList.remove("left", "right");
  if (el.apAttentionChallengeText) {
    el.apAttentionChallengeText.textContent = "Quick focus check";
  }
}

function scheduleNextAttentionChallenge(minDelayMs = 18000, maxDelayMs = 32000) {
  const p = state.assessmentPreview.proctor;
  const span = Math.max(1000, maxDelayMs - minDelayMs);
  p.challengeNextAtMs = Date.now() + minDelayMs + Math.floor(Math.random() * span);
}

function getAttentionChallengeWindow() {
  const p = state.assessmentPreview.proctor;
  const gazeRoll = sumGazeSuspicionWindow(p);
  const suspicionScore = [
    gazeRoll >= 4 ? 2 : gazeRoll >= 1 ? 1 : 0,
    p.sideHandFrames >= 1 ? 1 : 0,
    p.handNearFaceFrames >= 1 ? 1 : 0,
    p.behaviorDriftFrames >= 1 ? 2 : 0,
    p.challengeFailures >= 1 ? 2 : 0,
    p.warnings >= 1 ? 1 : 0,
  ].reduce((acc, value) => acc + value, 0);

  if (suspicionScore >= 4) {
    return { minDelayMs: 18000, maxDelayMs: 28000 };
  }
  if (suspicionScore >= 2) {
    return { minDelayMs: 30000, maxDelayMs: 45000 };
  }
  return { minDelayMs: 45000, maxDelayMs: 75000 };
}

function beginAttentionChallenge() {
  const p = state.assessmentPreview.proctor;
  if (!p.faceReference || !p.lastFaceMetrics || !el.apAttentionChallenge || !el.apAttentionChallengeText) return;
  const target = Math.random() < 0.5 ? "left" : "right";
  p.challengeActive = true;
  p.challengeTarget = target;
  p.challengeStartMs = Date.now();
  p.challengeDeadlineMs = p.challengeStartMs + 1600;
  p.challengeCooldownUntil = p.challengeDeadlineMs + 14000;
  el.apAttentionChallenge.classList.remove("hidden", "left", "right");
  el.apAttentionChallenge.classList.add(target);
  el.apAttentionChallengeText.textContent = target === "left"
    ? "Focus check: glance at the amber marker on the left edge"
    : "Focus check: glance at the amber marker on the right edge";
  logProctorEvent("info", "attention_challenge_started", { target }).catch(() => {});
}

function completeAttentionChallenge(passed) {
  const p = state.assessmentPreview.proctor;
  const target = p.challengeTarget || "unknown";
  const reactionMs = p.challengeStartMs ? Date.now() - p.challengeStartMs : null;
  p.challengeActive = false;
  p.challengeTarget = "";
  p.challengeStartMs = 0;
  p.challengeDeadlineMs = 0;
  clearAttentionChallengeOverlay();
  const window = getAttentionChallengeWindow();
  scheduleNextAttentionChallenge(window.minDelayMs, window.maxDelayMs);
  if (passed) {
    p.challengePasses += 1;
    logProctorEvent("info", "attention_challenge_passed", {
      target,
      reaction_ms: reactionMs,
    }).catch(() => {});
    return;
  }
  p.challengeFailures += 1;
  pushProctorWarning(
    "Attention focus check failed. Keep your eyes on the laptop screen during the exam.",
    "attention_challenge_failed",
    "critical",
  );
}

function evaluateAttentionChallengeResponse() {
  const p = state.assessmentPreview.proctor;
  if (!p.challengeActive || !p.faceReference || !p.lastFaceMetrics) return;
  const ref = p.faceReference;
  const metrics = p.lastFaceMetrics;
  const leftBase = Number(ref.leftGazeX || 0.5);
  const rightBase = Number(ref.rightGazeX || 0.5);
  const leftNow = Number(metrics.leftGazeX || leftBase);
  const rightNow = Number(metrics.rightGazeX || rightBase);
  const leftShift = leftBase - leftNow;
  const rightShift = rightNow - rightBase;
  const passed = p.challengeTarget === "left"
    ? leftShift > 0.08 && rightShift < 0.22
    : rightShift > 0.08 && leftShift < 0.22;
  if (passed) {
    completeAttentionChallenge(true);
    return;
  }
  if (Date.now() >= p.challengeDeadlineMs) {
    completeAttentionChallenge(false);
  }
}

function maybeRunAttentionChallenge() {
  const p = state.assessmentPreview.proctor;
  if (!p.calibrated || !p.faceReference || !p.lastFaceMetrics) return;
  if (p.challengeActive) {
    evaluateAttentionChallengeResponse();
    return;
  }
  const now = Date.now();
  if (!p.challengeNextAtMs) {
    const window = getAttentionChallengeWindow();
    scheduleNextAttentionChallenge(window.minDelayMs, window.maxDelayMs);
    return;
  }
  if (now < p.challengeNextAtMs || now < p.challengeCooldownUntil) return;
  beginAttentionChallenge();
}

const el = {
  loginEmail: $("loginEmail"),
  loginPassword: $("loginPassword"),
  loginCard: $("loginCard"),
  signupName: $("signupName"),
  signupEmail: $("signupEmail"),
  signupPassword: $("signupPassword"),
  signupRole: $("signupRole"),
  signupCard: $("signupCard"),
  showSignupBtn: $("showSignupBtn"),
  showLoginBtn: $("showLoginBtn"),
  workspaceBrand: $("workspaceBrand"),
  workspaceExpandFab: $("workspaceExpandFab"),
  settingsToggles: Array.from(document.querySelectorAll(".js-settings-toggle")),
  settingsMenus: Array.from(document.querySelectorAll(".settings-menu")),
  collapseWorkspaceBtns: Array.from(document.querySelectorAll(".js-collapse-workspace-btn")),
  sessionBadges: Array.from(document.querySelectorAll(".js-session-badge")),
  userUidBadges: Array.from(document.querySelectorAll(".js-user-uid-badge")),
  logoutBtns: Array.from(document.querySelectorAll(".js-logout-btn")),
  authView: $("authView"),
  studentView: $("studentView"),
  providerView: $("providerView"),
  nonAdminView: $("nonAdminView"),
  nonAdminText: $("nonAdminText"),
  nonAdminRoleFix: $("nonAdminRoleFix"),
  nonAdminRoleSelect: $("nonAdminRoleSelect"),
  nonAdminUpdateRoleBtn: $("nonAdminUpdateRoleBtn"),
  adminView: $("adminView"),
  analyticsGrid: $("analyticsGrid"),
  adminProctorSessionsList: $("adminProctorSessionsList"),
  adminTrainingReviewsList: $("adminTrainingReviewsList"),
  refreshTrainingReviewsBtn: $("refreshTrainingReviewsBtn"),
  moderationSummary: $("moderationSummary"),
  moderationTypeCounts: $("moderationTypeCounts"),
  moderationList: $("moderationList"),
  moderationSearch: $("moderationSearch"),
  moderationStatusFilter: $("moderationStatusFilter"),
  reportsBadge: $("reportsBadge"),
  approvalsBadge: $("approvalsBadge"),
  approvalSummary: $("approvalSummary"),
  pendingStudents: $("pendingStudents"),
  pendingProviders: $("pendingProviders"),
  studentsApprovalPane: $("studentsApprovalPane"),
  providersApprovalPane: $("providersApprovalPane"),
  billingPanel: $("billingPanel"),
  refreshProctorSessionsBtn: $("refreshProctorSessionsBtn"),
  loginBtn: $("loginBtn"),
  googleBtn: $("googleBtn"),
  signupBtn: $("signupBtn"),
  providerHomeStats: $("providerHomeStats"),
  studentStats: $("studentStats"),
  studentCertificatesList: $("studentCertificatesList"),
  studentAvailableCourses: $("studentAvailableCourses"),
  studentEnrolledCourses: $("studentEnrolledCourses"),
  studentCourseViewer: $("studentCourseViewer"),
  scvTitle: $("scvTitle"),
  scvMeta: $("scvMeta"),
  scvTopicList: $("scvTopicList"),
  scvLiveClassList: $("scvLiveClassList"),
  scvResourceList: $("scvResourceList"),
  scvProgressBar: $("scvProgressBar"),
  scvProgressText: $("scvProgressText"),
  scvAssessmentPanel: $("scvAssessmentPanel"),
  scvAssessmentStatus: $("scvAssessmentStatus"),
  providerCoursesList: $("providerCoursesList"),
  providerDraftsPage: $("providerDraftsPage"),
  providerCourseViewer: $("providerCourseViewer"),
  pcvTitle: $("pcvTitle"),
  pcvTopicList: $("pcvTopicList"),
  pcvLiveClassList: $("pcvLiveClassList"),
  courseWizard: $("courseWizard"),
  courseWizardTitle: $("courseWizardTitle"),
  cwStepDetails: $("cwStepDetails"),
  cwStepVideo: $("cwStepVideo"),
  cwStepTopics: $("cwStepTopics"),
  cwTopicsDraftList: $("cwTopicsDraftList"),
  cwTimelineMarkers: $("cwTimelineMarkers"),
  cwMarkerTooltip: $("cwMarkerTooltip"),
  providerDraftsList: $("providerDraftsList"),
  providerAssessmentsList: $("providerAssessmentsList"),
  assessmentBuilderScreen: $("assessmentBuilderScreen"),
  abCourseFilter: $("abCourseFilter"),
  abCourseSelect: $("abCourseSelect"),
  abCourseMeta: $("abCourseMeta"),
  abTimingMode: $("abTimingMode"),
  abDurationMinutes: $("abDurationMinutes"),
  abTimePerQuestionSeconds: $("abTimePerQuestionSeconds"),
  abQuestionPoolList: $("abQuestionPoolList"),
  abPoolMeta: $("abPoolMeta"),
  assessmentPreviewScreen: $("assessmentPreviewScreen"),
  apMeta: $("apMeta"),
  apProctorBadge: $("apProctorBadge"),
  apPrecheckPanel: $("apPrecheckPanel"),
  apPrecheckStatus: $("apPrecheckStatus"),
  apProctorVideo: $("apProctorVideo"),
  apProctorHints: $("apProctorHints"),
  apEnvironmentAttest: $("apEnvironmentAttest"),
  apEnvironmentStatus: $("apEnvironmentStatus"),
  apRerunChecksBtn: $("apRerunChecksBtn"),
  apStartTestBtn: $("apStartTestBtn"),
  apQuestionPanel: $("apQuestionPanel"),
  apAttentionChallenge: $("apAttentionChallenge"),
  apAttentionChallengeText: $("apAttentionChallengeText"),
  apAttentionChallengeDot: $("apAttentionChallengeDot"),
  apProgressText: $("apProgressText"),
  apTimerText: $("apTimerText"),
  apQuestionContent: $("apQuestionContent"),
  apQuestionText: $("apQuestionText"),
  apOptionsList: $("apOptionsList"),
  apResultPanel: $("apResultPanel"),
  apResultSummary: $("apResultSummary"),
  apWarningsSummary: $("apWarningsSummary"),
  apTrainingFeedbackPanel: $("apTrainingFeedbackPanel"),
  apTrainingPassBtn: $("apTrainingPassBtn"),
  apTrainingFailBtn: $("apTrainingFailBtn"),
  apTrainingComment: $("apTrainingComment"),
  apTrainingSaveBtn: $("apTrainingSaveBtn"),
  apTrainingFeedbackStatus: $("apTrainingFeedbackStatus"),
  proctorWarningModal: $("proctorWarningModal"),
  proctorWarningBody: $("proctorWarningBody"),
  proctorWarningCountdown: $("proctorWarningCountdown"),
  proctorWarningAcknowledgeBtn: $("proctorWarningAcknowledgeBtn"),
  providerCommentsList: $("providerCommentsList"),
  providerRatingsList: $("providerRatingsList"),
  providerNotificationsList: $("providerNotificationsList"),
  providerCertsList: $("providerCertsList"),
  toastStack: $("toastStack"),
};

function log(label, payload) {
  console.log(`[${label}]`, payload);
}

function toast(message, type = "ok") {
  if (!el.toastStack) return;
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.textContent = message;
  el.toastStack.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

async function getHeaders(authRequired = true) {
  const headers = { "Content-Type": "application/json" };
  if (!authRequired) return headers;
  if (!state.auth?.currentUser) throw new Error("Please login first.");
  headers.Authorization = `Bearer ${await state.auth.currentUser.getIdToken()}`;
  return headers;
}

async function api(method, path, body, authRequired = true) {
  const request = async (forceRefreshToken = false) => fetch(path, {
    method,
    cache: "no-store",
    headers: authRequired
      ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await state.auth.currentUser.getIdToken(forceRefreshToken)}`,
      }
      : await getHeaders(false),
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await request(false);
  if (authRequired && res.status === 401 && state.auth?.currentUser) {
    // Retry once with forced token refresh to handle transient auth races.
    res = await request(true);
  }
  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { text: raw };
    }
  } else {
    data = {};
  }
  if (!res.ok) throw new Error(JSON.stringify({ status: res.status, data }, null, 2));
  return data;
}

function showView(mode) {
  [el.authView, el.adminView, el.providerView, el.studentView, el.nonAdminView].forEach((n) => n && n.classList.add("hidden"));
  if (mode === "auth") el.authView?.classList.remove("hidden");
  if (mode === "admin") el.adminView?.classList.remove("hidden");
  if (mode === "provider") el.providerView?.classList.remove("hidden");
  if (mode === "student") el.studentView?.classList.remove("hidden");
  if (mode === "non-admin") el.nonAdminView?.classList.remove("hidden");
  el.workspaceBrand?.classList.toggle("hidden", mode === "auth");
  if (mode === "auth") {
    el.workspaceExpandFab?.classList.add("hidden");
  } else {
    const collapsed = document.body.classList.contains("workspace-collapsed");
    el.workspaceExpandFab?.classList.toggle("hidden", !collapsed);
  }
  if (mode === "auth") el.settingsMenus.forEach((m) => m.classList.add("hidden"));
}

function showAuthMode(mode = "login") {
  const loginMode = mode !== "signup";
  el.loginCard?.classList.toggle("hidden", !loginMode);
  el.signupCard?.classList.toggle("hidden", loginMode);
}

function renderNonAdminRoleFix(context = null) {
  const role = String(context?.role || "").toLowerCase();
  const show = role === "student" || role === "provider";
  el.nonAdminRoleFix?.classList.toggle("hidden", !show);
  if (show && el.nonAdminRoleSelect) {
    el.nonAdminRoleSelect.value = role;
  }
}

function setAuthActionState(ready) {
  [el.loginBtn, el.googleBtn, el.signupBtn].forEach((btn) => {
    if (btn) btn.disabled = !ready;
  });
}

function ensureAuthReady() {
  if (state.auth) return true;
  toast("Authentication is still loading. Wait a moment and try again.", "error");
  return false;
}

function setSessionBadge(text) {
  el.sessionBadges.forEach((b) => {
    b.textContent = text;
  });
}

function setUserUidBadge(publicUid) {
  const uid = String(publicUid || "").trim();
  el.userUidBadges.forEach((b) => {
    if (!uid) {
      b.classList.add("hidden");
      b.textContent = "UID: -";
      return;
    }
    b.classList.remove("hidden");
    b.textContent = `UID: ${uid}`;
  });
}

function applyWorkspaceCollapse(collapsed) {
  document.body.classList.toggle("workspace-collapsed", collapsed);
  el.collapseWorkspaceBtns.forEach((btn) => {
    btn.textContent = collapsed ? "Expand Workspace" : "Collapse Workspace";
  });
  const onAuth = !el.authView || !el.authView.classList.contains("hidden");
  el.workspaceExpandFab?.classList.toggle("hidden", !collapsed || onAuth);
}

function toggleWorkspaceCollapse() {
  const collapsed = !document.body.classList.contains("workspace-collapsed");
  applyWorkspaceCollapse(collapsed);
  try {
    localStorage.setItem("certora_workspace_collapsed", collapsed ? "1" : "0");
  } catch {}
}

function stopAdminPolling() {
  if (state.adminPollingId) {
    clearInterval(state.adminPollingId);
    state.adminPollingId = null;
  }
}

function setBadge(node, value) {
  if (!node) return;
  const v = Number(value || 0);
  node.textContent = String(v);
  node.classList.toggle("hidden", v <= 0);
}

function renderList(target, items, renderer, empty = "No data.") {
  if (!target) return;
  target.innerHTML = "";
  if (!items.length) {
    target.innerHTML = `<div class="item"><div class="meta">No items</div><div style="margin-top:4px;">${empty}</div></div>`;
    return;
  }
  items.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = renderer(item, index);
    target.appendChild(div);
  });
}

function renderAnalyticsCards(target, stats) {
  if (!target) return;
  const meta = [
    { key: "Onboarded Providers", cls: "t1", icon: "PR" },
    { key: "Students", cls: "t2", icon: "ST" },
    { key: "Enrolled Courses", cls: "t3", icon: "EN" },
    { key: "Issued Certificates", cls: "t4", icon: "CF" },
    { key: "Pass Percentage", cls: "t5", icon: "PP" },
  ];
  target.innerHTML = "";
  meta.forEach((m) => {
    const div = document.createElement("div");
    div.className = `stat analytics ${m.cls}`;
    div.innerHTML = `<div class="icon">${m.icon}</div><div class="text"><div class="k">${m.key}</div><div class="v">${stats[m.key] ?? "-"}</div></div>`;
    target.appendChild(div);
  });
}

function renderProviderHomeCards(target, data) {
  if (!target) return;
  const cards = [
    { key: "Total Courses", value: data.total_courses, cls: "t1", icon: "CR" },
    { key: "Published Courses", value: data.published_courses, cls: "t2", icon: "PB" },
    { key: "Total Enrollments", value: data.total_enrollments, cls: "t3", icon: "EN" },
    { key: "Assessments", value: data.exams_created, cls: "t4", icon: "AS" },
    { key: "Pass Percentage", value: `${data.pass_percentage}%`, cls: "t5", icon: "PP" },
    { key: "Certificates Issued", value: data.certificates_issued, cls: "t1", icon: "CF" },
    { key: "Unread Notifications", value: data.unread_notifications, cls: "t2", icon: "NT" },
  ];
  target.innerHTML = "";
  cards.forEach((card) => {
    const div = document.createElement("div");
    div.className = `stat analytics ${card.cls}`;
    div.innerHTML = `<div class="icon">${card.icon}</div><div class="text"><div class="k">${card.key}</div><div class="v">${card.value ?? "-"}</div></div>`;
    target.appendChild(div);
  });
}

function renderSimpleStats(target, map) {
  if (!target) return;
  target.innerHTML = "";
  Object.entries(map).forEach(([k, v]) => {
    const div = document.createElement("div");
    div.className = "stat";
    div.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
    target.appendChild(div);
  });
}

function activateAdminSubView(name) {
  document.querySelectorAll(".nav-btn:not(.provider-nav-btn)").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll('[id^="view-"]').forEach((v) => v.classList.add("hidden"));
  const pane = document.getElementById(`view-${name}`);
  if (pane) pane.classList.remove("hidden");
}

function activateProviderSubView(name) {
  if (name !== "assessments") {
    el.assessmentBuilderScreen?.classList.add("hidden");
    closeAssessmentPreview();
  }
  document.querySelectorAll(".provider-nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.providerView === name));
  document.querySelectorAll('[id^="provider-view-"]').forEach((v) => v.classList.add("hidden"));
  const pane = document.getElementById(`provider-view-${name}`);
  if (pane) pane.classList.remove("hidden");
}

function activateStudentSubView(name) {
  if (name !== "enrolled") {
    el.studentCourseViewer?.classList.add("hidden");
  }
  document.querySelectorAll(".student-nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.studentView === name));
  document.querySelectorAll('[id^="student-view-"]').forEach((v) => v.classList.add("hidden"));
  const pane = document.getElementById(`student-view-${name}`);
  if (pane) pane.classList.remove("hidden");
}

function renderApprovalsTab() {
  const isStudents = state.approvalsTab === "students";
  el.studentsApprovalPane?.classList.toggle("hidden", !isStudents);
  el.providersApprovalPane?.classList.toggle("hidden", isStudents);
  document.querySelectorAll(".approval-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.approvalTab === state.approvalsTab));
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value || "-";
  }
}

function parseTimeToSeconds(raw) {
  const value = String(raw || "").trim();
  if (!value) return NaN;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split(":").map((x) => x.trim());
  if (parts.some((p) => p === "" || Number.isNaN(Number(p)))) return NaN;
  if (parts.length === 2) {
    const [mm, ss] = parts.map(Number);
    return mm * 60 + ss;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts.map(Number);
    return hh * 3600 + mm * 60 + ss;
  }
  return NaN;
}

function formatSecondsToClock(totalSeconds) {
  const n = Number(totalSeconds || 0);
  const hh = Math.floor(n / 3600);
  const mm = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  const two = (x) => String(x).padStart(2, "0");
  return hh > 0 ? `${two(hh)}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

function ensureCourseVideoPreview() {
  const video = $("cwVideoPreview");
  const url = $("cwVideoUrl")?.value?.trim();
  if (!video || !url) return;
  if (video.getAttribute("src") !== url) {
    video.setAttribute("src", url);
    video.load();
  }
}

function updateVideoTimeMeta() {
  const video = $("cwVideoPreview");
  const meta = $("cwVideoTimeMeta");
  if (!video || !meta) return;
  const current = Math.floor(video.currentTime || 0);
  const duration = Math.floor(video.duration || 0);
  meta.textContent = `${formatSecondsToClock(current)} / ${formatSecondsToClock(duration)}`;
  syncScrubberUi("cwVideoPreview", "cwProgress", "cwBuffered", "cwThumb");
  syncActiveTopic("cwTopicsDraftList", "cwCurrentTopic", state.draftTopics, current);
}

function updateViewerTimeMeta() {
  const video = $("pcvVideo");
  const meta = $("pcvTimeMeta");
  if (!video || !meta) return;
  const current = Math.floor(video.currentTime || 0);
  const duration = Math.floor(video.duration || 0);
  meta.textContent = `${formatSecondsToClock(current)} / ${formatSecondsToClock(duration)}`;
  syncScrubberUi("pcvVideo", "pcvProgress", "pcvBuffered", "pcvThumb");
  syncActiveTopic("pcvTopicList", "pcvCurrentTopic", state.viewerTopics || [], current);
}

function updateStudentViewerTimeMeta() {
  const video = $("scvVideo");
  const meta = $("scvTimeMeta");
  if (!video || !meta) return;
  const total = Number(video.duration || 0);
  const current = Math.floor(Number(video.currentTime || 0));
  const progress = $("scvProgress");
  if (progress) progress.style.width = `${total > 0 ? (current / total) * 100 : 0}%`;
  meta.textContent = `${formatSecondsToClock(current)} / ${formatSecondsToClock(Math.floor(total))}`;
  syncActiveTopic("scvTopicList", "scvCurrentTopic", state.studentViewerTopics || [], current);
}

async function maybeUnlockAssessmentFromPlayback() {
  const courseId = Number(state.studentActiveCourseId || 0);
  if (!courseId) return;
  if (state.studentVideoCompletionSent[courseId]) return;
  const video = $("scvVideo");
  if (!video || !video.duration) return;
  const remaining = Number(video.duration) - Number(video.currentTime || 0);
  if (remaining > 5) return;
  state.studentVideoCompletionSent[courseId] = true;
  try {
    await api("POST", `/student/courses/${courseId}/complete`);
    if (el.scvProgressBar) el.scvProgressBar.style.width = "100%";
    if (el.scvProgressText) el.scvProgressText.textContent = "100%";
    await refreshStudentAssessmentPanel(courseId, true);
    toast("Assessment unlocked");
    refreshStudentDashboard().catch(() => {});
  } catch {
    state.studentVideoCompletionSent[courseId] = false;
  }
}

function syncScrubberUi(videoId, progressId, bufferedId, thumbId) {
  const video = $(videoId);
  const progress = $(progressId);
  const buffered = $(bufferedId);
  const thumb = $(thumbId);
  if (!video || !progress || !thumb) return;
  const duration = Number(video.duration || 0);
  const current = Number(video.currentTime || 0);
  const pct = duration > 0 ? (current / duration) * 100 : 0;
  progress.style.width = `${pct}%`;
  thumb.style.left = `${pct}%`;
  if (buffered && duration > 0 && video.buffered?.length) {
    const end = video.buffered.end(video.buffered.length - 1);
    buffered.style.width = `${Math.max(0, Math.min(100, (end / duration) * 100))}%`;
  } else if (buffered) {
    buffered.style.width = "0%";
  }
}

function syncActiveTopic(listId, labelId, topics, currentSeconds) {
  const list = $(listId);
  const label = $(labelId);
  if (!list || !Array.isArray(topics)) return;
  const sorted = [...topics].sort((a, b) => a.time_seconds - b.time_seconds);
  let active = null;
  for (const t of sorted) {
    if (Number(t.time_seconds) <= currentSeconds) active = t;
    else break;
  }
  list.querySelectorAll("[data-topic-item]").forEach((n) => n.classList.remove("active-topic"));
  if (active) {
    const node = list.querySelector(`[data-topic-item="${active.time_seconds}"]`);
    node?.classList.add("active-topic");
    if (label) label.textContent = `Topic: ${active.title}`;
  } else if (label) {
    label.textContent = "Topic: -";
  }
}

function findPrimaryLesson(course) {
  const modules = course?.modules || [];
  for (const m of modules) {
    for (const l of (m.lessons || [])) {
      if (l.lesson_type === "recorded_video" && l.recorded_video_url) return l;
    }
  }
  return null;
}

function findLiveLessons(course) {
  const items = [];
  const modules = course?.modules || [];
  for (const m of modules) {
    for (const l of (m.lessons || [])) {
      if (l.lesson_type === "live_class_link" && l.live_class_url) {
        items.push({ ...l, module_title: m.title || "" });
      }
    }
  }
  return items;
}

function canDeleteCourseFromUi() {
  const role = String(state.context?.role || "").toLowerCase();
  const email = String(state.context?.email || "").trim().toLowerCase();
  return role === "provider" || (role === "admin" && email === "admin@certora.in");
}

async function fetchVideoDuration(url) {
  if (!url) return null;
  if (state.videoDurationByUrl[url] !== undefined) return state.videoDurationByUrl[url];
  const duration = await new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.onloadedmetadata = () => resolve(Math.floor(Number(v.duration || 0)));
    v.onerror = () => resolve(null);
  });
  state.videoDurationByUrl[url] = duration;
  return duration;
}

function resolveCourseThumbnail(course, lesson) {
  if (course?.thumbnail_url) return course.thumbnail_url;
  const firstTopicThumb = lesson?.topics?.find((t) => t.thumbnail_data_url)?.thumbnail_data_url;
  return firstTopicThumb || "";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isDraftAlreadyPosted(draft, courses) {
  const dTitle = normalizeText(draft.title);
  const dVideo = normalizeText(draft.video_url);
  if (!courses?.length) return false;
  return courses.some((course) => {
    const titleMatch = dTitle && normalizeText(course.title) === dTitle;
    if (titleMatch) return true;
    const modules = course.modules || [];
    for (const mod of modules) {
      for (const lesson of (mod.lessons || [])) {
        if (dVideo && normalizeText(lesson.recorded_video_url) === dVideo) return true;
      }
    }
    return false;
  });
}

function formatEventTypeLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown";
  return raw.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function severityTone(value) {
  const v = String(value || "").toLowerCase();
  if (v === "critical") return "status-open";
  if (v === "warning" || v === "manual_review") return "status-in_review";
  return "status-resolved";
}

function showMarkerTooltip(tooltip, marker, topic, thumbnail) {
  if (!tooltip || !marker) return;
  const rect = marker.getBoundingClientRect();
  tooltip.innerHTML = `
    ${thumbnail ? `<img src="${thumbnail}" alt="" />` : ""}
    <div><strong>${topic.title}</strong></div>
    <div class="meta">${formatSecondsToClock(topic.time_seconds)}</div>
  `;
  tooltip.style.left = `${window.scrollX + rect.left - 80}px`;
  tooltip.style.top = `${window.scrollY + rect.top - 110}px`;
  tooltip.classList.remove("hidden");
}

function hideMarkerTooltip(tooltip) {
  tooltip?.classList.add("hidden");
}

function bindCustomPlayerControls({
  videoId,
  shellId,
  playBtnId,
  back10BtnId,
  fwd10BtnId,
  scrubberId,
  hoverPreviewId,
  hoverTimeId,
  speedId,
  volumeId,
  fullscreenBtnId,
  topicsGetter,
  updateTimeFn,
}) {
  const video = $(videoId);
  const shell = $(shellId);
  const playBtn = $(playBtnId);
  const back10Btn = $(back10BtnId);
  const fwd10Btn = $(fwd10BtnId);
  const scrubber = $(scrubberId);
  const hoverPreview = $(hoverPreviewId);
  const hoverTime = $(hoverTimeId);
  const speed = $(speedId);
  const volume = $(volumeId);
  const fullscreenBtn = $(fullscreenBtnId);
  if (!video) return;

  const refreshPlayLabel = () => {
    if (playBtn) playBtn.textContent = video.paused ? "▶" : "❚❚";
  };
  const refreshFullscreenIcon = () => {
    if (!fullscreenBtn) return;
    const isFs = document.fullscreenElement === shell;
    fullscreenBtn.textContent = isFs ? "🗗" : "⛶";
    fullscreenBtn.title = isFs ? "Exit Fullscreen" : "Fullscreen";
    fullscreenBtn.setAttribute("aria-label", isFs ? "Exit Fullscreen" : "Fullscreen");
  };
  let hideTimer = null;
  const scheduleControlsHide = () => {
    if (!shell) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      shell.classList.add("controls-hidden");
    }, 3000);
  };
  const showControls = () => {
    if (!shell) return;
    shell.classList.remove("controls-hidden");
    scheduleControlsHide();
  };
  playBtn?.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    refreshPlayLabel();
    showControls();
  });
  video.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    refreshPlayLabel();
    showControls();
  });
  video.addEventListener("play", refreshPlayLabel);
  video.addEventListener("pause", refreshPlayLabel);
  video.addEventListener("ended", refreshPlayLabel);

  const seekFromClientX = (clientX) => {
    if (!scrubber) return;
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = ratio * video.duration;
    updateTimeFn();
  };
  const showHoverPreview = async (clientX) => {
    if (!scrubber || !video.duration) return;
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const sec = Math.floor(ratio * video.duration);
    const topics = topicsGetter ? topicsGetter() : [];
    const nearest = [...topics].filter((t) => Number(t.time_seconds) <= sec).sort((a, b) => b.time_seconds - a.time_seconds)[0];
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    if (hoverPreview) {
      hoverPreview.innerHTML = `
        ${nearest?.thumbnail_data_url ? `<img src="${nearest.thumbnail_data_url}" alt="" />` : ""}
        <div><strong>${nearest?.title || "No topic"}</strong></div>
      `;
      hoverPreview.style.left = `${x}px`;
      hoverPreview.classList.remove("hidden");
    }
    if (hoverTime) {
      hoverTime.textContent = formatSecondsToClock(sec);
      hoverTime.style.left = `${x}px`;
      hoverTime.classList.remove("hidden");
    }
  };
  scrubber?.addEventListener("pointerdown", (e) => {
    scrubber.classList.add("scrubbing");
    seekFromClientX(e.clientX);
    scrubber.setPointerCapture(e.pointerId);
    showControls();
  });
  scrubber?.addEventListener("pointermove", (e) => {
    if (scrubber.classList.contains("scrubbing")) seekFromClientX(e.clientX);
    showHoverPreview(e.clientX).catch(() => {});
  });
  scrubber?.addEventListener("pointerup", (e) => {
    scrubber.classList.remove("scrubbing");
    scrubber.releasePointerCapture(e.pointerId);
  });
  scrubber?.addEventListener("pointerleave", () => {
    hoverPreview?.classList.add("hidden");
    hoverTime?.classList.add("hidden");
  });
  back10Btn?.addEventListener("click", () => {
    video.currentTime = Math.max(0, video.currentTime - 10);
    updateTimeFn();
  });
  fwd10Btn?.addEventListener("click", () => {
    video.currentTime = Math.min(Number(video.duration || video.currentTime + 10), video.currentTime + 10);
    updateTimeFn();
  });
  speed?.addEventListener("change", () => {
    video.playbackRate = Number(speed.value || 1);
  });
  volume?.addEventListener("input", () => {
    video.volume = Number(volume.value || 1);
  });
  fullscreenBtn?.addEventListener("click", () => {
    const target = shell || video;
    const isFs = document.fullscreenElement === target;
    if (isFs && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    }
    showControls();
  });
  video.addEventListener("loadedmetadata", () => {
    updateTimeFn();
    refreshPlayLabel();
    refreshFullscreenIcon();
    showControls();
  });
  video.addEventListener("progress", updateTimeFn);
  document.addEventListener("fullscreenchange", refreshFullscreenIcon);
  shell?.addEventListener("mousemove", () => showControls());
  shell?.addEventListener("mouseenter", () => showControls());
  shell?.addEventListener("mouseleave", () => {
    if (hideTimer) clearTimeout(hideTimer);
    shell.classList.remove("controls-hidden");
  });
  refreshFullscreenIcon();
}

function renderTimelineMarkers(container, tooltip, topics, duration, onSeek) {
  if (!container) return;
  container.innerHTML = "";
  if (!duration || !topics?.length) return;
  topics.forEach((topic) => {
    const marker = document.createElement("div");
    marker.className = "timeline-marker";
    marker.style.left = `${Math.max(0, Math.min(100, (topic.time_seconds / duration) * 100))}%`;
    marker.title = `${topic.title} @ ${formatSecondsToClock(topic.time_seconds)}`;
    marker.addEventListener("click", () => onSeek(topic.time_seconds));
    marker.addEventListener("mouseenter", () => showMarkerTooltip(tooltip, marker, topic, topic.thumbnail_data_url || ""));
    marker.addEventListener("mouseleave", () => hideMarkerTooltip(tooltip));
    container.appendChild(marker);
  });
}

async function captureThumbnailAt(videoUrl, seconds) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.src = videoUrl;
    video.muted = true;
    const done = (value) => resolve(value);
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.max(0, Math.min(seconds, Math.max(0, (video.duration || seconds) - 0.3)));
    });
    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 135;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done("");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        done("");
      }
    });
    video.addEventListener("error", () => done(""));
  });
}

function setCourseWizardStep(step) {
  state.courseWizardStep = step;
  el.cwStepDetails?.classList.toggle("hidden", step !== "details");
  el.cwStepVideo?.classList.toggle("hidden", step !== "video");
  el.cwStepTopics?.classList.toggle("hidden", step !== "topics");
  if (step === "topics") {
    ensureCourseVideoPreview();
    renderDraftTopics();
  }
}

function renderDraftTopics() {
  const target = el.cwTopicsDraftList;
  if (!target) return;
  const video = $("cwVideoPreview");
  target.innerHTML = "";
  if (!state.draftTopics.length) {
    target.innerHTML = `<div class="item"><div class="meta">No topics added yet.</div></div>`;
    if (video) renderTimelineMarkers(el.cwTimelineMarkers, el.cwMarkerTooltip, [], Number(video.duration || 0), () => {});
    return;
  }
  const sorted = [...state.draftTopics].sort((a, b) => a.time_seconds - b.time_seconds);
  sorted.forEach((t, idx) => {
    const node = document.createElement("div");
    node.className = "item topic-item";
    node.setAttribute("data-topic-item", String(t.time_seconds));
    node.innerHTML = `
      ${t.thumbnail_data_url ? `<img src="${t.thumbnail_data_url}" alt="" style="width:100%;border-radius:8px;border:1px solid #e5e7eb; margin-bottom:6px;" />` : ""}
      <div><strong>${t.title}</strong></div>
      <div class="meta">${formatSecondsToClock(t.time_seconds)}</div>
      <div class="actions">
        <button class="btn small" data-seek-topic="${t.time_seconds}">Go</button>
        <button class="btn small danger" data-remove-topic="${idx}">Remove</button>
      </div>
    `;
    target.appendChild(node);
  });
  target.querySelectorAll("[data-remove-topic]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.removeTopic);
      state.draftTopics = sorted.filter((_, i) => i !== idx);
      renderDraftTopics();
    });
  });
  target.querySelectorAll("[data-seek-topic]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!video) return;
      video.currentTime = Number(btn.dataset.seekTopic || 0);
      video.play().catch(() => {});
    });
  });
  if (video) {
    renderTimelineMarkers(el.cwTimelineMarkers, el.cwMarkerTooltip, sorted, Number(video.duration || 0), (seconds) => {
      video.currentTime = seconds;
      video.play().catch(() => {});
    });
  }
}

function resetCourseWizard() {
  state.activeDraftId = null;
  state.draftTopics = [];
  ["cwCourseTitle", "cwCourseCategory", "cwCourseThumbnail", "cwCourseDescription", "cwVideoUrl", "cwTopicTitle", "cwTopicTime"].forEach((id) => {
    const node = $(id);
    if (node) node.value = "";
  });
  const level = $("cwCourseLevel");
  if (level) level.value = "Beginner";
  const includesExam = $("cwIncludesExam");
  if (includesExam) includesExam.checked = true;
  const preview = $("cwVideoPreview");
  if (preview) preview.removeAttribute("src");
  if (el.cwTimelineMarkers) el.cwTimelineMarkers.innerHTML = "";
  hideMarkerTooltip(el.cwMarkerTooltip);
  const timeMeta = $("cwVideoTimeMeta");
  if (timeMeta) timeMeta.textContent = "Current: 00:00";
  setCourseWizardStep("details");
  const progress = $("cwUploadProgress");
  if (progress) progress.textContent = "";
  const thumbFile = $("cwThumbnailFile");
  if (thumbFile) thumbFile.value = "";
  const thumbPreview = $("cwThumbnailPreview");
  if (thumbPreview) {
    thumbPreview.setAttribute("src", "");
    thumbPreview.classList.add("hidden");
  }
  renderDraftTopics();
}

function refreshThumbnailPreview() {
  const url = $("cwCourseThumbnail")?.value?.trim();
  const preview = $("cwThumbnailPreview");
  if (!preview) return;
  if (!url) {
    preview.setAttribute("src", "");
    preview.classList.add("hidden");
    return;
  }
  preview.setAttribute("src", url);
  preview.classList.remove("hidden");
}

function setThumbnailValue(url) {
  const input = $("cwCourseThumbnail");
  if (input) input.value = url || "";
  refreshThumbnailPreview();
}

function captureFrameFromVideoElement(videoEl) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return "";
  }
}

function wizardPayload() {
  return {
    draft_id: state.activeDraftId,
    title: $("cwCourseTitle")?.value?.trim() || "",
    level: $("cwCourseLevel")?.value || "Beginner",
    category: $("cwCourseCategory")?.value?.trim() || "General",
    description: $("cwCourseDescription")?.value?.trim() || "",
    thumbnail_url: $("cwCourseThumbnail")?.value?.trim() || null,
    includes_exam: Boolean($("cwIncludesExam")?.checked),
    video_url: $("cwVideoUrl")?.value?.trim() || null,
    topics: state.draftTopics,
  };
}

async function saveDraftFromWizard() {
  const out = await api("POST", "/provider/workspace/courses/drafts", wizardPayload());
  state.activeDraftId = out.draft_id;
  return out;
}

async function refreshProviderDrafts() {
  // Always read latest posted courses first so stale drafts can be removed reliably.
  try {
    const latestCourses = await api("GET", "/provider/workspace/content/courses");
    state.providerCourses = latestCourses || [];
  } catch {
    // Fallback to in-memory state if course refresh fails.
  }

  const drafts = await api("GET", "/provider/workspace/courses/drafts");
  state.providerDrafts = Array.isArray(drafts) ? drafts : [];
  const postedDrafts = drafts.filter((d) => isDraftAlreadyPosted(d, state.providerCourses));
  const pendingDrafts = drafts.filter((d) => !isDraftAlreadyPosted(d, state.providerCourses));
  state.providerDrafts = pendingDrafts;

  // Cleanup legacy/stale drafts that already became posted courses.
  postedDrafts.forEach((d) => {
    api("DELETE", `/provider/workspace/courses/drafts/${d.draft_id}`).catch(() => {});
  });

  renderList(
    el.providerDraftsList,
    pendingDrafts,
    (d) => `
      <div><strong>${d.title || "Untitled Draft"}</strong></div>
      <div class="meta">Draft #${d.draft_id} | ${d.level} | Topics: ${d.topics_count} | ${formatTime(d.updated_at)}</div>
      <div class="actions"><button class="btn small" data-load-draft="${d.draft_id}">Open Draft</button></div>
    `,
    "No drafts saved yet.",
  );
  document.querySelectorAll("[data-load-draft]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const draft = await api("GET", `/provider/workspace/courses/drafts/${btn.dataset.loadDraft}`);
        state.activeDraftId = draft.draft_id;
        $("cwCourseTitle").value = draft.title || "";
        $("cwCourseLevel").value = draft.level || "Beginner";
        $("cwCourseCategory").value = draft.category || "General";
        $("cwCourseDescription").value = draft.description || "";
        $("cwCourseThumbnail").value = draft.thumbnail_url || "";
        refreshThumbnailPreview();
        $("cwIncludesExam").checked = Boolean(draft.includes_exam);
        $("cwVideoUrl").value = draft.video_url || "";
        if (draft.video_play_url && $("cwVideoPreview")) {
          $("cwVideoPreview").setAttribute("src", draft.video_play_url);
          $("cwVideoPreview").load();
        } else {
          ensureCourseVideoPreview();
        }
        state.draftTopics = draft.topics || [];
        renderDraftTopics();
        setCourseWizardStep("details");
        el.providerDraftsPage?.classList.add("hidden");
        el.courseWizard?.classList.remove("hidden");
        toast("Draft loaded");
      } catch {
        toast("Failed to load draft", "error");
      }
    });
  });
}

async function uploadLocalVideoInChunks(file) {
  const chunkSize = 2 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const init = await api("POST", "/provider/workspace/uploads/init", {
    filename: file.name,
    total_size: file.size,
    total_chunks: totalChunks,
    mime_type: file.type || "video/mp4",
  });
  const progress = $("cwUploadProgress");
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    const fd = new FormData();
    fd.append("chunk", blob, `${file.name}.part`);
    const headers = await getHeaders(true);
    delete headers["Content-Type"];
    const res = await fetch(`/provider/workspace/uploads/${init.session_id}/chunk?index=${i}`, {
      method: "PUT",
      headers,
      body: fd,
    });
    if (!res.ok) throw new Error("Chunk upload failed");
    if (progress) progress.textContent = `Uploading... ${i + 1}/${totalChunks} chunks`;
  }
  const done = await api("POST", `/provider/workspace/uploads/${init.session_id}/complete`);
  $("cwVideoUrl").value = done.storage_ref || done.file_url;
  if (done.file_url && $("cwVideoPreview")) {
    $("cwVideoPreview").setAttribute("src", done.file_url);
    $("cwVideoPreview").load();
  }
  if (progress) progress.textContent = `Upload complete`;
  return done.storage_ref || done.file_url;
}

async function refreshAnalytics() {
  const data = await api("GET", "/admin/analytics");
  renderAnalyticsCards(el.analyticsGrid, {
    "Onboarded Providers": data.onboarded_providers,
    Students: data.approved_students,
    "Enrolled Courses": data.enrolled_courses,
    "Issued Certificates": data.issued_certificates,
    "Pass Percentage": `${data.pass_percentage}%`,
  });
}

async function refreshAdminProctorSessions() {
  const out = await api("GET", "/proctoring/admin/sessions?flagged_only=true&page=1&page_size=12");
  const items = out.items || [];
  const evals = await Promise.all(
    items.map(async (item) => {
      try {
        const detail = await api("GET", `/proctoring/admin/sessions/${item.session_id}/evaluation`);
        return { session: item, detail };
      } catch {
        return { session: item, detail: null };
      }
    }),
  );
  renderList(
    el.adminProctorSessionsList,
    evals,
    ({ session, detail }) => {
      const ai = detail?.ai_evaluation || {};
      const counts = detail?.event_type_counts || {};
      const recent = detail?.recent_events || [];
      const timeline = detail?.timeline || [];
      const chips = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, count]) => `<span class="chip">${formatEventTypeLabel(name)}: ${count}</span>`)
        .join("");
      const maxTimelineScore = Math.max(1, ...timeline.map((t) => Number(t.score || 0)));
      const timelineMarkup = timeline.length
        ? `<div style="display:flex;align-items:flex-end;gap:4px;height:54px;margin-top:8px;padding:6px 8px;border:1px solid #dbe4f0;border-radius:10px;background:#f8fbff;">${
            timeline.map((bucket) => {
              const score = Number(bucket.score || 0);
              const h = Math.max(8, Math.round((score / maxTimelineScore) * 42));
              const color = Number(bucket.critical || 0) > 0 ? "#dc2626" : Number(bucket.warning || 0) > 0 ? "#f59e0b" : "#93c5fd";
              const title = `Slot ${Number(bucket.index) + 1}: critical ${bucket.critical}, warning ${bucket.warning}, info ${bucket.info}`;
              return `<div title="${title}" style="flex:1;height:${h}px;border-radius:6px 6px 2px 2px;background:${color};opacity:${score > 0 ? 0.95 : 0.35};"></div>`;
            }).join("")
          }</div>`
        : '<div class="meta" style="margin-top:8px;">No timeline available.</div>';
      const recentMarkup = recent
        .slice(0, 4)
        .map((ev) => `<div class="meta"><span class="status-pill ${severityTone(ev.severity)}">${String(ev.severity || "info")}</span> ${formatEventTypeLabel(ev.event_type)}${ev?.details?.reason ? ` - ${ev.details.reason}` : ""}</div>`)
        .join("");
      const prob = ai.final_probability != null ? `${(Number(ai.final_probability) * 100).toFixed(1)}%` : "-";
      return `
        <div><strong>Session #${session.session_id}</strong> <span class="status-pill ${severityTone(ai.decision || session.ai_decision)}">${String(ai.decision || session.ai_decision || "unknown")}</span></div>
        <div class="meta">User: ${session.actor_name || session.actor_email || session.actor_user_id} | Warnings: ${session.warning_count} | Events: ${session.events_count} | Evidence: ${session.evidence_count}</div>
        <div class="meta">Risk: ${prob} | Event Signal: ${ai.event_signal_score != null ? (Number(ai.event_signal_score) * 100).toFixed(1) + "%" : "-"} | Model: ${ai.model_used || "n/a"} | Review: ${session.admin_review_status || "pending"}</div>
        <div class="chips" style="margin-top:8px;">${chips || '<span class="chip">No event counts</span>'}</div>
        ${timelineMarkup}
        <div style="margin-top:8px;">${recentMarkup || '<div class="meta">No recent events recorded.</div>'}</div>
      `;
    },
    "No flagged proctor sessions.",
  );
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function refreshAdminTrainingReviews() {
  const out = await api("GET", "/proctoring/admin/training-reviews?page=1&page_size=100");
  const items = out.items || [];
  renderList(
    el.adminTrainingReviewsList,
    items,
    (row) => {
      const verdict = row.feedback_label === "correct" ? "Pass (model correct)" : "Fail (model wrong)";
      const pillCls = row.feedback_label === "correct" ? "status-resolved" : "status-open";
      const ctx = row.context === "preview" ? "Preview proctor session" : "Student attempt";
      const pass = row.final_result_passed;
      const passTxt = pass === null || pass === undefined ? "n/a" : pass ? "exam marked pass" : "exam marked fail";
      const prob =
        typeof row.model_probability === "number" && Number.isFinite(row.model_probability)
          ? `${(Number(row.model_probability) * 100).toFixed(1)}%`
          : "-";
      const commentBlock = row.comment
        ? `<div style="margin-top:8px;"><strong>Comment</strong><div class="meta">${escapeHtmlAttr(row.comment)}</div></div>`
        : '<div class="meta" style="margin-top:8px;">No comment.</div>';
      return `
        <div><strong>#${row.id}</strong> <span class="status-pill ${pillCls}">${verdict}</span> <span class="meta">${ctx}</span></div>
        <div class="meta">${formatTime(row.created_at)} | Reviewer: ${escapeHtmlAttr(row.actor_name || "-")} (${escapeHtmlAttr(row.actor_email || "-")})</div>
        <div class="meta">Proctor session: ${row.session_id ?? "-"} | Attempt: ${row.attempt_id ?? "-"} | Exam ID: ${row.exam_id ?? "-"} | Mode: ${escapeHtmlAttr(row.session_mode || "-")}</div>
        <div class="meta">Model at save: ${escapeHtmlAttr(row.model_decision || "-")} | Model risk: ${prob} | Exam outcome: ${passTxt}</div>
        ${commentBlock}
      `;
    },
    "No training reviews saved yet.",
  );
}

function applyModerationFilters(items) {
  const q = (el.moderationSearch?.value || "").toLowerCase().trim();
  const status = el.moderationStatusFilter?.value || "all";
  return items.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (!q) return true;
    const blob = `${item.details || ""} ${item.reporter_name || ""} ${item.complainant_name || ""} ${item.reporter_email || ""} ${item.complainant_email || ""}`.toLowerCase();
    return blob.includes(q);
  });
}

function renderModerationPanel() {
  const raw = state.moderationMode === "reports" ? state.reports : state.complaints;
  const items = applyModerationFilters(raw);
  const byStatus = raw.reduce((acc, item) => ((acc[item.status] = (acc[item.status] || 0) + 1), acc), {});

  renderSimpleStats(el.moderationSummary, {
    Total: raw.length,
    Open: byStatus.open || 0,
    "In Review": byStatus.in_review || 0,
    Resolved: byStatus.resolved || 0,
    Dismissed: byStatus.dismissed || 0,
  });

  const byType = raw.reduce((acc, item) => {
    const type = item.report_type || item.complaint_type || "Other";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  if (el.moderationTypeCounts) el.moderationTypeCounts.innerHTML = Object.entries(byType).map(([k, v]) => `<span class="chip">${k}: ${v}</span>`).join("");

  renderList(
    el.moderationList,
    items,
    (item) => {
      const type = item.report_type || item.complaint_type;
      const person = item.reporter_name || item.complainant_name || "Unknown";
      const email = item.reporter_email || item.complainant_email || "-";
      const path = state.moderationMode === "reports" ? `/admin/reports/${item.id}/status` : `/admin/complaints/${item.id}/status`;
      return `
        <div><strong>#${item.id}</strong> ${type} <span class="status-pill status-${item.status}">${item.status.replace("_", " ")}</span></div>
        <div class="meta">By ${person} (${email}) | ${formatTime(item.created_at)}</div>
        <div style="margin-top:6px;">${item.details || "-"}</div>
        <div class="actions">
          <select data-status-select="${item.id}">
            <option value="open" ${item.status === "open" ? "selected" : ""}>Open</option>
            <option value="in_review" ${item.status === "in_review" ? "selected" : ""}>In Review</option>
            <option value="resolved" ${item.status === "resolved" ? "selected" : ""}>Resolved</option>
            <option value="dismissed" ${item.status === "dismissed" ? "selected" : ""}>Dismissed</option>
          </select>
          <button class="btn small" data-status-save="${item.id}" data-status-path="${path}">Update Status</button>
        </div>
      `;
    },
    "No items found.",
  );

  document.querySelectorAll("[data-status-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.statusSave;
      const path = btn.dataset.statusPath;
      const status = document.querySelector(`[data-status-select="${id}"]`)?.value;
      try {
        await api("POST", path, { status });
        toast("Status updated");
        await refreshModerationData();
      } catch (err) {
        toast("Failed to update status", "error");
      }
    });
  });
}

async function refreshModerationData() {
  const reports = await api("GET", "/admin/reports?page=1&page_size=100");
  const complaints = await api("GET", "/admin/complaints?page=1&page_size=100");
  state.reports = reports.items || [];
  state.complaints = complaints.items || [];
  renderModerationPanel();
}

async function refreshAdminBadges() {
  const badgeData = await api("GET", "/admin/workspace-badges");
  setBadge(el.reportsBadge, badgeData.open_moderation);
  setBadge(el.approvalsBadge, badgeData.pending_approvals);
}

async function approvalDecision(kind, id, approve) {
  const reason = approve ? null : (prompt("Rejection reason") || "Profile invalid");
  let url = "";
  if (kind === "student") url = `/admin/approvals/students/${id}/decision`;
  if (kind === "provider") url = `/admin/approvals/providers/${id}/decision`;
  if (kind === "provider-user") url = `/admin/approvals/providers/users/${id}/decision`;
  await api("POST", url, { approve, rejection_reason: reason });
  toast("Approval updated");
  await refreshApprovals();
  await refreshAdminBadges();
}

async function refreshApprovals() {
  const summary = await api("GET", "/admin/approvals/summary");
  const studentsResp = await api("GET", "/admin/approvals/students?page=1&page_size=50");
  const providersResp = await api("GET", "/admin/approvals/providers?page=1&page_size=50");
  const students = studentsResp.items || [];
  const providers = providersResp.items || [];

  renderSimpleStats(el.approvalSummary, {
    "Pending Students": summary.pending_students,
    "Pending Providers": summary.pending_providers,
  });

  renderList(
    el.pendingStudents,
    students,
    (s) => `
      <div><strong>${s.full_name}</strong> (${s.email})</div>
      <div class="meta">Student ID: ${s.user_id}</div>
      <div class="actions">
        <button class="btn small" data-student-approve="${s.user_id}">Approve</button>
        <button class="btn small danger" data-student-reject="${s.user_id}">Reject</button>
        <a class="btn small" href="mailto:${s.email}?subject=Certora%20Approval%20Update">Email</a>
      </div>
    `,
    "No pending students.",
  );

  renderList(
    el.pendingProviders,
    providers,
    (p) => `
      <div><strong>${p.display_name}</strong> (${p.email})</div>
      <div class="meta">Provider ID: ${p.provider_id ?? "-"} | User ID: ${p.user_id} | ${p.provider_type}</div>
      <div class="meta">Profile: ${p.profile_created ? "Submitted" : "Not submitted yet (direct signup)"}</div>
      <div class="meta">Docs: ${(p.documents || []).map((d) => `<a href="${d.file_url}" target="_blank">${d.document_type}</a>`).join(" | ") || "None"}</div>
      <div class="actions">
        ${
          p.provider_id
            ? `<button class="btn small" data-provider-approve="${p.provider_id}">Approve</button>
               <button class="btn small danger" data-provider-reject="${p.provider_id}">Reject</button>`
            : `<button class="btn small" data-provider-user-approve="${p.user_id}">Approve</button>
               <button class="btn small danger" data-provider-user-reject="${p.user_id}">Reject</button>`
        }
        <a class="btn small" href="mailto:${p.email}?subject=Certora%20Approval%20Update">Email</a>
      </div>
    `,
    "No pending providers.",
  );

  document.querySelectorAll("[data-student-approve]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("student", btn.dataset.studentApprove, true)));
  document.querySelectorAll("[data-student-reject]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("student", btn.dataset.studentReject, false)));
  document.querySelectorAll("[data-provider-approve]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("provider", btn.dataset.providerApprove, true)));
  document.querySelectorAll("[data-provider-reject]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("provider", btn.dataset.providerReject, false)));
  document.querySelectorAll("[data-provider-user-approve]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("provider-user", btn.dataset.providerUserApprove, true)));
  document.querySelectorAll("[data-provider-user-reject]").forEach((btn) => btn.addEventListener("click", () => approvalDecision("provider-user", btn.dataset.providerUserReject, false)));
  renderApprovalsTab();
}

async function refreshBilling() {
  const data = await api("GET", "/admin/billing-payments");
  renderList(el.billingPanel, [data], (x) => `<div>${x.message}</div>`, "No billing data.");
}

async function refreshProviderHome() {
  const data = await api("GET", "/provider/workspace/home");
  renderProviderHomeCards(el.providerHomeStats, data);
}

async function refreshStudentDashboard() {
  const data = await api("GET", "/student/dashboard");
  const certs = await api("GET", "/student/certificates");
  renderSimpleStats(el.studentStats, {
    "Enrolled Courses": data.stats?.total_enrolled ?? 0,
    "Completed Courses": data.stats?.completed_courses ?? 0,
    "Avg Progress %": `${data.stats?.avg_progress ?? 0}%`,
    "Exam Eligible": data.stats?.exam_eligible_courses ?? 0,
    "Certificates": data.stats?.certificates_issued ?? 0,
  });
  renderList(
    el.studentCertificatesList,
    certs || [],
    (c) => `
      <div>
        <div><strong>${c.course_name}</strong></div>
        <div class="meta">Certificate ID: ${c.certificate_id} | Issued: ${formatTime(c.issued_at)}</div>
        <div class="actions">
          ${c.download_url ? `<a class="btn small" href="${c.download_url}" target="_blank" rel="noreferrer">Download PDF</a>` : ""}
          <a class="btn small" href="${c.verification_link}" target="_blank" rel="noreferrer">Verify</a>
        </div>
      </div>
    `,
    "No certificates issued yet.",
  );
  renderList(
    el.studentAvailableCourses,
    data.available || [],
    (c) => `
      <div class="course-card">
        ${c.thumbnail_url ? `<img src="${c.thumbnail_url}" alt="" class="course-thumb" />` : `<div class="course-thumb"></div>`}
        <div>
          <div><strong>${c.title}</strong></div>
          <div class="meta">Category: ${c.category || "-"}</div>
          <div class="actions"><button class="btn small" data-student-enroll="${c.course_id}">Enroll</button></div>
        </div>
      </div>
    `,
    "No available courses right now.",
  );
  renderList(
    el.studentEnrolledCourses,
    data.enrolled || [],
    (c) => `
      <div class="course-card">
        ${c.thumbnail_url ? `<img src="${c.thumbnail_url}" alt="" class="course-thumb" />` : `<div class="course-thumb"></div>`}
        <div>
          <div><strong>${c.title}</strong></div>
          <div class="meta">Category: ${c.category || "-"}</div>
          <div style="margin-top:6px;">
            <div style="height:8px;border:1px solid #dbe4f0;border-radius:999px;background:#eef2ff;overflow:hidden;">
              <div style="height:100%;width:${Math.max(0, Math.min(100, Number(c.progress_pct || 0)))}%;background:linear-gradient(90deg,#2563eb,#0ea5e9);"></div>
            </div>
            <div class="meta" style="margin-top:4px;">${Number(c.progress_pct || 0).toFixed(0)}% completed</div>
          </div>
          <div class="actions"><button class="btn small" data-student-view-course="${c.course_id}">View Course</button></div>
        </div>
      </div>
    `,
    "No enrolled courses yet.",
  );
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

async function refreshProviderContent() {
  const items = await api("GET", "/provider/workspace/content/courses");
  state.providerCourses = items || [];
  renderList(
    el.providerCoursesList,
    state.providerCourses,
    (c) => {
      const firstLesson = findPrimaryLesson(c);
      const firstLiveLesson = findLiveLessons(c)[0] || null;
      const thumb = resolveCourseThumbnail(c, firstLesson);
      const durationLabel = firstLesson?.recorded_video_url
        ? (state.videoDurationByUrl[firstLesson.recorded_video_url] != null
          ? formatSecondsToClock(state.videoDurationByUrl[firstLesson.recorded_video_url])
          : "Loading...")
        : "-";
      return `
        <div class="course-card">
          ${thumb ? `<img src="${thumb}" alt="" class="course-thumb" />` : `<div class="course-thumb"></div>`}
          <div>
            <div><strong>${c.title}</strong> <span class="status-pill ${c.is_published ? "status-resolved" : "status-open"}">${c.is_published ? "active" : "inactive"}</span></div>
            <div class="meta">Duration: <span data-course-duration="${c.id}">${durationLabel}</span></div>
            <div class="actions">
              ${firstLesson?.recorded_video_url ? `<button class="btn small" data-view-course="${c.id}">View Class</button>` : ""}
              ${firstLiveLesson?.live_class_url ? `<button class="btn small" data-open-live-course="${c.id}">Open Live Class</button>` : ""}
              ${!c.is_published ? `<button class="btn small" data-activate-course="${c.id}">Activate Course</button>` : ""}
              ${canDeleteCourseFromUi() ? `<button class="btn small danger" data-delete-course="${c.id}">Delete Course</button>` : ""}
            </div>
          </div>
        </div>
      `;
    },
    "No courses yet. Click + to create your first course.",
  );
  const durationTasks = state.providerCourses.map(async (course) => {
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

async function loadProviderDraftsRaw() {
  try {
    const drafts = await api("GET", "/provider/workspace/courses/drafts");
    const allDrafts = Array.isArray(drafts) ? drafts : [];
    state.providerDrafts = allDrafts.filter((d) => !isDraftAlreadyPosted(d, state.providerCourses));
  } catch {
    state.providerDrafts = [];
  }
}

function getAssessmentSourceValue() {
  return $("abCourseSelect")?.value || "";
}

function getSelectedAssessmentCourseId() {
  const raw = getAssessmentSourceValue();
  if (!raw || !raw.startsWith("course:")) return null;
  return Number(raw.split(":")[1] || 0);
}

function isAssessmentDraftSourceSelected() {
  const raw = getAssessmentSourceValue();
  return raw.startsWith("draft:");
}

function resetAssessmentBuilder() {
  state.assessmentEditingExamId = null;
  state.assessmentDraftQuestions = [];
  $("abCourseFilter").value = "all";
  $("abCourseSelect").value = "";
  $("abCourseMeta").textContent = "No course selected.";
  $("abTitle").value = "";
  $("abPassScore").value = "60";
  $("abMaxAttempts").value = "1";
  $("abQuestionsPerAttempt").value = "10";
  $("abNegativeMarking").checked = false;
  $("abShuffleQuestions").checked = true;
  $("abShuffleOptions").checked = true;
  $("abCertificateEnabled").checked = true;
  $("abTimingMode").value = "assessment";
  $("abDurationMinutes").value = "60";
  $("abTimePerQuestionSeconds").value = "90";
  $("abQuestionType").value = "mcq_single_correct";
  $("abQuestionText").value = "";
  $("abQuestionMarks").value = "1";
  $("abQuestionNegativeMarks").value = "0";
  $("abCourseSelect").disabled = false;
  $("abCourseFilter").disabled = false;
  ["abOption1", "abOption2", "abOption3", "abOption4"].forEach((id) => {
    const node = $(id);
    if (node) node.value = "";
  });
  document.querySelectorAll("[data-ab-correct]").forEach((n) => {
    n.checked = false;
  });
  renderAssessmentPool();
  renderAssessmentCourseOptions();
  applyAssessmentTimingMode();
  const title = $("assessmentBuilderScreen")?.querySelector("h2");
  if (title) title.textContent = "Assessment Builder";
  const saveBtn = $("abSaveDraftBtn");
  const publishBtn = $("abPublishBtn");
  if (saveBtn) saveBtn.textContent = "Save Assessment Draft";
  if (publishBtn) publishBtn.textContent = "Publish Assessment";
}

function openAssessmentBuilder() {
  resetAssessmentBuilder();
  el.assessmentBuilderScreen?.classList.remove("hidden");
}

function closeAssessmentBuilder() {
  el.assessmentBuilderScreen?.classList.add("hidden");
  resetAssessmentBuilder();
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

function applyAssessmentTimingMode() {
  const mode = $("abTimingMode")?.value || "assessment";
  $("abDurationMinutes")?.classList.toggle("hidden", mode !== "assessment");
  $("abTimePerQuestionSeconds")?.classList.toggle("hidden", mode !== "question");
}

function renderAssessmentPool() {
  const list = state.assessmentDraftQuestions || [];
  const perAttempt = Number($("abQuestionsPerAttempt")?.value || 0);
  const recommendedPool = perAttempt > 0 ? perAttempt * 2 : 0;
  if (el.abPoolMeta) {
    const recommendation = recommendedPool > 0 ? ` Recommended pool: ${recommendedPool}+` : "";
    el.abPoolMeta.textContent = `${list.length} questions in pool.${recommendation}`;
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
      renderAssessmentPool();
    });
  });
}

async function openAssessmentBuilderForEdit(assessment) {
  await Promise.all([refreshProviderContent(), loadProviderDraftsRaw()]);
  openAssessmentBuilder();
  state.assessmentEditingExamId = Number(assessment.exam_id);
  const titleNode = $("assessmentBuilderScreen")?.querySelector("h2");
  if (titleNode) titleNode.textContent = `Edit Draft Assessment #${assessment.exam_id}`;
  const saveBtn = $("abSaveDraftBtn");
  const publishBtn = $("abPublishBtn");
  if (saveBtn) saveBtn.textContent = "Save Changes";
  if (publishBtn) publishBtn.textContent = "Save & Publish";

  $("abTitle").value = assessment.title || "";
  $("abPassScore").value = String(assessment.pass_score ?? 60);
  $("abMaxAttempts").value = String(assessment.max_attempts ?? 1);
  $("abQuestionsPerAttempt").value = String(assessment.questions_per_attempt > 0 ? assessment.questions_per_attempt : Math.max(assessment.question_count || 1, 1));
  $("abNegativeMarking").checked = Boolean(assessment.negative_marking);
  $("abShuffleQuestions").checked = Boolean(assessment.shuffle_questions);
  $("abShuffleOptions").checked = Boolean(assessment.shuffle_options);
  $("abCertificateEnabled").checked = Boolean(assessment.certificate_enabled);
  $("abTimingMode").value = assessment.timing_mode || "assessment";
  $("abDurationMinutes").value = String(assessment.duration_minutes || 60);
  $("abTimePerQuestionSeconds").value = String(assessment.time_per_question_seconds || 90);
  applyAssessmentTimingMode();

  renderAssessmentCourseOptions();
  $("abCourseSelect").value = `course:${assessment.course_id}`;
  $("abCourseSelect").disabled = true;
  $("abCourseFilter").disabled = true;
  updateAssessmentSourceMeta();

  const existingQuestions = await api("GET", `/exams/${assessment.exam_id}/questions`);
  state.assessmentDraftQuestions = (existingQuestions || []).map((q) => ({
    question_id: q.question_id,
    question_text: q.question_text,
    question_type: q.question_type,
    marks: q.marks,
    negative_marks: q.negative_marks,
    options: (q.options || []).map((o) => ({
      option_text: o.option_text,
      is_correct: o.is_correct,
      position: o.position,
    })),
  }));
  renderAssessmentPool();
}

function buildQuestionFromAssessmentForm() {
  const questionType = $("abQuestionType")?.value || "mcq_single_correct";
  const questionText = $("abQuestionText")?.value?.trim() || "";
  const marksRaw = Number($("abQuestionMarks")?.value || 1);
  const negativeRaw = Number($("abQuestionNegativeMarks")?.value || 0);
  const marks = Number.isFinite(marksRaw) && marksRaw > 0 ? marksRaw : 1;
  const negativeMarks = Number.isFinite(negativeRaw) && negativeRaw >= 0 ? negativeRaw : 0;
  const optionsText = ["abOption1", "abOption2", "abOption3", "abOption4"]
    .map((id) => ($(id)?.value || "").trim());
  const correctChecks = Array.from(document.querySelectorAll("[data-ab-correct]"));
  const options = optionsText
    .map((txt, idx) => ({
      option_text: txt,
      is_correct: Boolean(correctChecks[idx]?.checked),
      position: idx + 1,
    }))
    .filter((o) => o.option_text);
  if (!questionText) throw new Error("Question text is required");
  if (options.length < 2) throw new Error("At least 2 options are required");
  const correctCount = options.filter((o) => o.is_correct).length;
  if (questionType === "mcq_single_correct" && correctCount !== 1) throw new Error("Single correct MCQ needs exactly 1 correct option");
  if (questionType === "mcq_multiple_correct" && correctCount < 1) throw new Error("Multiple correct MCQ needs at least 1 correct option");
  return {
    question_text: questionText,
    question_type: questionType,
    marks,
    negative_marks: negativeMarks,
    options,
  };
}

async function createAssessmentFromBuilder(publishNow) {
  if (isAssessmentDraftSourceSelected()) {
    throw new Error("Draft videos are not eligible. Publish the course first.");
  }
  const courseId = getSelectedAssessmentCourseId();
  if (!courseId) throw new Error("Choose an active/inactive course");
  const title = $("abTitle")?.value?.trim() || "";
  const passScore = Number($("abPassScore")?.value || 60);
  const maxAttempts = Number($("abMaxAttempts")?.value || 1);
  const questionsPerAttempt = Number($("abQuestionsPerAttempt")?.value || 0);
  const timingMode = $("abTimingMode")?.value || "assessment";
  const durationMinutes = Number($("abDurationMinutes")?.value || 60);
  const timePerQuestionSeconds = Number($("abTimePerQuestionSeconds")?.value || 0);
  const questionPool = state.assessmentDraftQuestions || [];

  if (!title) throw new Error("Assessment title is required");
  if (!questionPool.length) throw new Error("Add at least one question");
  if (questionsPerAttempt <= 0) throw new Error("Questions shown to student must be greater than 0");
  if (questionsPerAttempt > questionPool.length) {
    throw new Error("Questions shown to student cannot exceed pool size");
  }
  if (timingMode === "assessment" && durationMinutes <= 0) throw new Error("Assessment duration must be greater than 0");
  if (timingMode === "question" && timePerQuestionSeconds <= 0) throw new Error("Time per question must be greater than 0");
  if (questionPool.length < questionsPerAttempt * 2) {
    toast("Recommendation: keep at least 2x pool size for better randomization.");
  }

  const examPayload = {
    title,
    duration_minutes: durationMinutes,
    timing_mode: timingMode,
    time_per_question_seconds: timingMode === "question" ? timePerQuestionSeconds : null,
    questions_per_attempt: questionsPerAttempt,
    pass_score: passScore,
    negative_marking: Boolean($("abNegativeMarking")?.checked),
    shuffle_questions: Boolean($("abShuffleQuestions")?.checked),
    shuffle_options: Boolean($("abShuffleOptions")?.checked),
    max_attempts: maxAttempts,
    certificate_enabled: Boolean($("abCertificateEnabled")?.checked),
  };

  let examId = state.assessmentEditingExamId;
  if (examId) {
    await api("PUT", `/exams/${examId}`, examPayload);
    for (const q of questionPool) {
      if (q.question_id) continue;
      const out = await api("POST", `/exams/${examId}/questions`, q);
      q.question_id = out.question_id;
    }
  } else {
    const createdExam = await api("POST", "/exams", { course_id: courseId, ...examPayload });
    examId = createdExam.id;
    for (const q of questionPool) {
      const out = await api("POST", `/exams/${examId}/questions`, q);
      q.question_id = out.question_id;
    }
  }
  await api("POST", `/exams/${examId}/rule`, {
    min_questions: questionPool.length,
    min_pass_score: 60,
    max_easy_ratio: 0.7,
    min_syllabus_areas: 1,
    max_duplicate_ratio: 0.1,
    max_ambiguous_ratio: 0.1,
  });
  if (publishNow) {
    await api("POST", `/exams/${examId}/publish`);
  }
  return { id: examId };
}

function clearAssessmentPreviewTimer() {
  if (state.assessmentPreview.timerId) {
    clearInterval(state.assessmentPreview.timerId);
    state.assessmentPreview.timerId = null;
  }
}

function updateAssessmentStartEligibility() {
  const p = state.assessmentPreview.proctor;
  const precheckReady = Boolean(p.precheckReady);
  const attested = Boolean(p.environmentAttested);
  if (el.apStartTestBtn) {
    // Keep start clickable after precheck so users get an explicit toast if attestation is missing.
    el.apStartTestBtn.disabled = !precheckReady;
  }
  if (el.apEnvironmentStatus) {
    el.apEnvironmentStatus.textContent = attested
      ? "Environment declaration accepted. Camera and proctoring will start when the assessment starts."
      : "Assessment start remains blocked until you confirm the test machine is local-only.";
  }
}

function pauseAssessmentTimer() {
  const preview = state.assessmentPreview;
  preview.warningPauseCount += 1;
  preview.timerPaused = true;
}

function resumeAssessmentTimer() {
  const preview = state.assessmentPreview;
  preview.warningPauseCount = Math.max(0, preview.warningPauseCount - 1);
  preview.timerPaused = preview.warningPauseCount > 0;
}

function openProctorWarningModal(message) {
  if (!el.proctorWarningModal || !el.proctorWarningBody || !el.proctorWarningAcknowledgeBtn || !el.proctorWarningCountdown) return;
  pauseAssessmentTimer();
  el.proctorWarningBody.textContent = message;
  el.proctorWarningAcknowledgeBtn.disabled = true;
  el.proctorWarningCountdown.textContent = "You can continue after 5 seconds.";
  el.proctorWarningModal.classList.remove("hidden");
  let remaining = 5;
  const tick = () => {
    remaining -= 1;
    if (remaining <= 0) {
      el.proctorWarningCountdown.textContent = "Click Understood to continue the assessment.";
      el.proctorWarningAcknowledgeBtn.disabled = false;
      return;
    }
    el.proctorWarningCountdown.textContent = `You can continue after ${remaining} second${remaining === 1 ? "" : "s"}.`;
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

function closeProctorWarningModal() {
  el.proctorWarningModal?.classList.add("hidden");
  resumeAssessmentTimer();
}

function updateProctorBadge() {
  const p = state.assessmentPreview.proctor;
  if (el.apProctorBadge) {
    el.apProctorBadge.textContent = `Warnings: ${p.warnings}/${p.maxWarnings}`;
    el.apProctorBadge.classList.toggle("proctor-warn", p.warnings > 0);
    el.apProctorBadge.classList.toggle("proctor-danger", p.warnings >= p.maxWarnings - 1);
  }
}

async function ensureFaceLandmarker() {
  if (!faceLandmarkerCachePromise) {
    faceLandmarkerCachePromise = (async () => {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
      const filesetResolver = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
      );
      const faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
        },
        runningMode: "VIDEO",
        numFaces: 2,
      });
      return faceLandmarker;
    })();
  }
  return faceLandmarkerCachePromise;
}

async function ensureHandLandmarker() {
  if (!handLandmarkerCachePromise) {
    handLandmarkerCachePromise = (async () => {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
      const filesetResolver = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
      );
      const handLandmarker = await vision.HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
      return handLandmarker;
    })();
  }
  return handLandmarkerCachePromise;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(s);
  });
}

async function ensurePhoneDetector() {
  if (!phoneDetectorCachePromise) {
    phoneDetectorCachePromise = (async () => {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
      if (!window.cocoSsd) throw new Error("coco-ssd not available");
      const model = await window.cocoSsd.load();
      return model;
    })();
  }
  return phoneDetectorCachePromise;
}

function stopProctoringMonitoring() {
  const p = state.assessmentPreview.proctor;
  if (p.monitorId) {
    clearInterval(p.monitorId);
    p.monitorId = null;
  }
  if (p.visibilityHandler) {
    document.removeEventListener("visibilitychange", p.visibilityHandler);
    p.visibilityHandler = null;
  }
  if (p.blurHandler) {
    window.removeEventListener("blur", p.blurHandler);
    p.blurHandler = null;
  }
  if (p.focusHandler) {
    window.removeEventListener("focus", p.focusHandler);
    p.focusHandler = null;
  }
  if (p.fullscreenHandler) {
    document.removeEventListener("fullscreenchange", p.fullscreenHandler);
    p.fullscreenHandler = null;
  }
}

function shutdownProctoringMedia() {
  const p = state.assessmentPreview.proctor;
  stopProctoringMonitoring();
  if (p.stream) {
    p.stream.getTracks().forEach((t) => t.stop());
    p.stream = null;
  }
  if (p.audioContext) {
    p.audioContext.close().catch(() => {});
    p.audioContext = null;
    p.analyser = null;
  }
  p.lastFrame = null;
  p.startingUp = false;
  if (el.apProctorVideo) {
    el.apProctorVideo.pause?.();
    el.apProctorVideo.srcObject = null;
  }
}

function pushProctorWarning(reason, eventType = "proctor_warning", severity = "warning", options = {}) {
  const p = state.assessmentPreview.proctor;
  const key = `${eventType}:${reason}`;
  const now = Date.now();
  const last = p.lastWarnAt[key] || 0;
  if (!options?.bypassCooldown && now - last < p.warnCooldownMs) return;
  p.lastWarnAt[key] = now;
  p.warnings = Math.min(Number(p.maxWarnings || 0), Number(p.warnings || 0) + 1);
  updateProctorBadge();
  logProctorEvent(severity, eventType, { warnings: p.warnings, reason }).catch(() => {});
  captureAndUploadProctorSnapshot("warning", reason).catch(() => {});
  if (el.apProctorHints) {
    el.apProctorHints.textContent = `Warning ${p.warnings}: ${reason}`;
  }
  if (p.warnings >= p.maxWarnings) {
    toast("Maximum warnings reached. Test ended.");
    showAssessmentPreviewResult("max_warnings");
  } else {
    openProctorWarningModal(reason);
  }
}

async function startServerProctorSession() {
  if (state.assessmentPreview.proctor.sessionId) {
    return { session_id: state.assessmentPreview.proctor.sessionId };
  }
  const examId = state.assessmentPreview.exam?.exam_id || null;
  const attemptId = state.assessmentPreview.attemptId || null;
  const mode = state.assessmentPreview.mode === "student_attempt" ? "attempt" : "preview";
  const out = await api("POST", "/proctoring/sessions/start", {
    mode,
    exam_id: examId,
    attempt_id: attemptId,
  });
  state.assessmentPreview.proctor.sessionId = out.session_id;
  return out;
}

async function logProctorEvent(severity, eventType, details = {}) {
  const sessionId = state.assessmentPreview.proctor.sessionId;
  if (!sessionId) return;
  await api("POST", `/proctoring/sessions/${sessionId}/events`, {
    event_type: eventType,
    severity,
    confidence: null,
    details,
  });
}

async function captureAndUploadProctorSnapshot(eventType, reason) {
  const sessionId = state.assessmentPreview.proctor.sessionId;
  const video = el.apProctorVideo;
  if (!sessionId || !video || !video.videoWidth || !video.videoHeight) return false;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(640, video.videoWidth);
  canvas.height = Math.min(360, video.videoHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
  if (!blob) return false;
  const fd = new FormData();
  fd.append("file", blob, `snapshot_${Date.now()}.jpg`);
  fd.append("evidence_type", "image");
  fd.append("event_id", "");
  const headers = await getHeaders(true);
  delete headers["Content-Type"];
  await fetch(`/proctoring/sessions/${sessionId}/evidence`, {
    method: "POST",
    headers,
    body: fd,
  });
  await logProctorEvent("info", "evidence_snapshot_uploaded", { eventType, reason });
  return true;
}

async function captureAndUploadBaselineClip() {
  const sessionId = state.assessmentPreview.proctor.sessionId;
  const p = state.assessmentPreview.proctor;
  if (!sessionId || !p.stream || typeof MediaRecorder === "undefined") return false;
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(p.stream, { mimeType: "video/webm" });
  } catch {
    return false;
  }
  return await new Promise((resolve) => {
    const done = async () => {
      try {
        const blob = new Blob(chunks, { type: "video/webm" });
        if (!blob.size) {
          resolve(false);
          return;
        }
        const fd = new FormData();
        fd.append("file", blob, `baseline_${Date.now()}.webm`);
        fd.append("evidence_type", "video");
        const headers = {};
        if (state.auth?.currentUser) {
          headers.Authorization = `Bearer ${await state.auth.currentUser.getIdToken()}`;
        }
        await fetch(`/proctoring/sessions/${sessionId}/evidence`, {
          method: "POST",
          headers,
          body: fd,
        });
        await logProctorEvent("info", "baseline_clip_uploaded", {});
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    rec.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      done().catch(() => resolve(false));
    };
    rec.start(250);
    setTimeout(() => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        resolve(false);
      }
    }, 2600);
  });
}

async function finalizeServerProctorSession(reason) {
  const sessionId = state.assessmentPreview.proctor.sessionId;
  if (!sessionId) return null;
  const out = await api("POST", `/proctoring/sessions/${sessionId}/finalize`, {
    ended_reason: reason,
  });
  state.assessmentPreview.proctor.finalized = out;
  return out;
}

async function ensureAssessmentFullscreen() {
  if (!el.assessmentPreviewScreen?.requestFullscreen) return;
  if (document.fullscreenElement === el.assessmentPreviewScreen) return;
  await el.assessmentPreviewScreen.requestFullscreen();
}

async function captureProctorBrightness() {
  const video = el.apProctorVideo;
  if (!video || !video.videoWidth || !video.videoHeight) return 0;
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return total / (data.length / 4);
}

function detectFrameMovement() {
  const p = state.assessmentPreview.proctor;
  const video = el.apProctorVideo;
  if (!video || !video.videoWidth || !video.videoHeight) return;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!p.lastFrame) {
    p.lastFrame = frame;
    return;
  }
  let diff = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const cur = (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
    const prev = (p.lastFrame[i] + p.lastFrame[i + 1] + p.lastFrame[i + 2]) / 3;
    diff += Math.abs(cur - prev);
  }
  const avgDiff = diff / (frame.length / 4);
  p.lastFrame = frame;
  const metrics = p.lastFaceMetrics;
  const ref = p.faceReference;
  const horizontalShift = metrics && ref
    ? Math.abs(Number(metrics.faceCenterX || 0) - Number(ref.faceCenterX || 0))
    : 0;
  const verticalShift = metrics && ref
    ? Math.abs(Number(metrics.faceCenterY || 0) - Number(ref.faceCenterY || 0))
    : 0;
  const scaleShift = metrics && ref && Number(ref.eyeDist || 0) > 0
    ? Math.abs(Number(metrics.eyeDist || 0) - Number(ref.eyeDist || 0)) / Number(ref.eyeDist || 1)
    : 0;
  const likelyNormalNod = verticalShift > 0.025 && verticalShift < 0.11 && horizontalShift < 0.035 && scaleShift < 0.16;
  const suspiciousMotion = avgDiff > 24 && !likelyNormalNod && (horizontalShift > 0.045 || scaleShift > 0.18 || p.sideHandFrames >= 1);
  if (suspiciousMotion) p.movementFrames += 1;
  else p.movementFrames = Math.max(0, p.movementFrames - 1);
  if (p.movementFrames >= 3) {
    pushProctorWarning("Unusual movement detected. Stay centered.", "unusual_movement");
    p.movementFrames = 0;
  }
}

function detectAudioAnomaly() {
  const p = state.assessmentPreview.proctor;
  if (!p.analyser) return false;
  const rms = detectAudioRms();
  const threshold = Math.max(0.06, (p.audioBaselineRms || 0.03) * 2.2);
  return rms > threshold;
}

function detectLoudSpeechAnomaly() {
  const p = state.assessmentPreview.proctor;
  if (!p.analyser) return false;
  const rms = detectAudioRms();
  const loudThreshold = Math.max(0.11, (p.audioBaselineRms || 0.03) * 3.4);
  return rms > loudThreshold;
}

function detectVoicePersistence() {
  const p = state.assessmentPreview.proctor;
  if (!p.analyser) return false;
  const rms = detectAudioRms();
  const talkThreshold = Math.max(0.05, (p.audioBaselineRms || 0.03) * 1.7);
  return rms > talkThreshold;
}

async function detectMobilePhoneInFrame() {
  const p = state.assessmentPreview.proctor;
  const video = el.apProctorVideo;
  if (!p.phoneModelReady || !video || !video.videoWidth || !video.videoHeight) return;
  let model = null;
  try {
    model = await ensurePhoneDetector();
  } catch {
    p.phoneModelReady = false;
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    const preds = await model.detect(canvas);
    const hasPhone = preds.some((x) => x.class === "cell phone" && Number(x.score || 0) >= 0.45);
    if (hasPhone) p.phoneFrames += 1;
    else p.phoneFrames = Math.max(0, p.phoneFrames - 1);
    if (p.phoneFrames >= 2) {
      pushProctorWarning(
        "Mobile phone detected. Assessment will be terminated.",
        "mobile_phone_detected",
        "critical",
      );
      p.phoneFrames = 0;
      showAssessmentPreviewResult("mobile_phone_detected");
    }
  } catch {}
}

function analyzeHandFrame() {
  const p = state.assessmentPreview.proctor;
  const video = el.apProctorVideo;
  if (!p.handModel || !video || !video.videoWidth || !video.videoHeight) return;
  let result;
  try {
    result = p.handModel.detectForVideo(video, performance.now());
  } catch {
    return;
  }
  const hands = result?.landmarks || [];
  if (!hands.length) {
    p.sideHandFrames = Math.max(0, p.sideHandFrames - 1);
    p.handNearFaceFrames = Math.max(0, p.handNearFaceFrames - 1);
    return;
  }

  let sideHandDetected = false;
  let handNearFaceDetected = false;
  const ref = p.faceReference;
  for (const hand of hands) {
    if (!Array.isArray(hand) || !hand.length) continue;
    const xs = hand.map((pt) => Number(pt.x || 0));
    const ys = hand.map((pt) => Number(pt.y || 0));
    const centerX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const centerY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const spreadX = maxX - minX;
    if ((centerX < 0.14 || centerX > 0.86 || minX < 0.06 || maxX > 0.94) && centerY > 0.2 && centerY < 0.86 && spreadX > 0.05) {
      sideHandDetected = true;
    }
    if (ref && Number.isFinite(Number(ref.faceCenterX)) && Number.isFinite(Number(ref.faceCenterY))) {
      const dx = centerX - Number(ref.faceCenterX);
      const dy = centerY - Number(ref.faceCenterY);
      const dist = Math.hypot(dx, dy);
      const faceScale = Math.max(0.09, Number(ref.eyeDist || 0.1) * 2.6);
      const nearFace = dist < faceScale && spreadX > 0.05;
      const lateralBias = Math.abs(dx) > faceScale * 0.42;
      const edgeBias = centerX < 0.24 || centerX > 0.76;
      const correlatedSuspicion = sumGazeSuspicionWindow(p) >= 1 || p.sideHandFrames >= 1;
      if (nearFace && (lateralBias || edgeBias || correlatedSuspicion)) {
        handNearFaceDetected = true;
      }
    }
  }

  if (sideHandDetected) p.sideHandFrames += 1;
  else p.sideHandFrames = Math.max(0, p.sideHandFrames - 1);
  if (handNearFaceDetected) p.handNearFaceFrames += 1;
  else p.handNearFaceFrames = Math.max(0, p.handNearFaceFrames - 1);

  if (p.sideHandFrames >= 5) {
    pushProctorWarning(
      "Repeated hand activity near the side of the laptop detected. Remove any nearby phone or device.",
      "side_hand_activity_detected",
      "critical",
    );
    p.sideHandFrames = 0;
  }
  if (p.handNearFaceFrames >= 6) {
    pushProctorWarning(
      "Hand repeatedly near face detected. Keep hands away from face and off any nearby device.",
      "hand_near_face_repeated",
      "critical",
    );
    p.handNearFaceFrames = 0;
  }
}

function analyzeFaceFrame() {
  const p = state.assessmentPreview.proctor;
  const video = el.apProctorVideo;
  if (!p.faceModel || !video || !video.videoWidth || !video.videoHeight) return;
  let result;
  try {
    result = p.faceModel.detectForVideo(video, performance.now());
  } catch {
    return;
  }
  const faces = result?.faceLandmarks || [];
  if (!faces.length) {
    p.faceAbsentFrames += 1;
  } else {
    p.faceAbsentFrames = 0;
  }
  if (p.faceAbsentFrames >= 3) {
    pushProctorWarning("Face not visible. Keep your face in frame.", "face_not_visible");
    p.faceAbsentFrames = 0;
  }

  if (faces.length > 1) {
    p.multiFaceFrames += 1;
  } else {
    p.multiFaceFrames = 0;
  }
  if (p.multiFaceFrames >= 2) {
    pushProctorWarning("Multiple faces detected. Only one person is allowed.", "multiple_faces_detected", "critical");
    p.multiFaceFrames = 0;
  }

  if (faces.length) {
    const lm = faces[0];
    const metrics = computeFaceMetrics(lm);
    if (metrics) {
      p.lastFaceMetrics = metrics;
      tickGazeThreeLayerModel(p, metrics, Date.now());
      if (p.faceReference) {
        const d0 = Math.abs((metrics.noseLeft || 0) - (p.faceReference.noseLeft || 0));
        const d1 = Math.abs((metrics.noseRight || 0) - (p.faceReference.noseRight || 0));
        const d2 = Math.abs((metrics.eyeDist || 0) - (p.faceReference.eyeDist || 0));
        const mismatch = d0 + d1 + d2 > 0.42;
        if (mismatch) p.faceMismatchFrames += 1;
        else p.faceMismatchFrames = Math.max(0, p.faceMismatchFrames - 1);
        if (p.faceMismatchFrames >= 4) {
          pushProctorWarning(
            "Face mismatch detected. Ensure only registered candidate is visible.",
            "face_identity_mismatch",
            "critical",
          );
          p.faceMismatchFrames = 0;
        }
        const refEyeDist = Number(p.faceReference.eyeDist || 0);
        const tooFar = refEyeDist > 0 && metrics.eyeDist < refEyeDist * 0.72;
        if (tooFar) p.faceTooFarFrames += 1;
        else p.faceTooFarFrames = Math.max(0, p.faceTooFarFrames - 1);
        if (p.faceTooFarFrames >= 4) {
          pushProctorWarning(
            "You moved too far from the laptop screen. Stay close and keep your eyes on the exam screen.",
            "moved_far_from_screen",
          );
          p.faceTooFarFrames = 0;
        }
      }
    }
  } else {
    p.lastFaceMetrics = null;
  }
}

async function runFaceCalibration() {
  const p = state.assessmentPreview.proctor;
  if (!p.faceModel || !isPlayableVideoElement(el.apProctorVideo)) return false;
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 2200) {
    try {
      const out = p.faceModel.detectForVideo(el.apProctorVideo, performance.now());
      const faces = out?.faceLandmarks || [];
      if (faces.length !== 1) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const m = computeFaceMetrics(faces[0]);
      if (m) samples.push(m);
    } catch {}
    await new Promise((r) => setTimeout(r, 180));
  }
  if (!samples.length) return false;
  const avg = (key) => samples.reduce((acc, cur) => acc + (Number(cur[key]) || 0), 0) / samples.length;
  p.faceReference = {
    eyeDist: avg("eyeDist"),
    noseLeft: avg("noseLeft"),
    noseRight: avg("noseRight"),
    ratio: avg("ratio"),
    faceCenterX: avg("faceCenterX"),
    faceCenterY: avg("faceCenterY"),
    leftGazeX: avg("leftGazeX"),
    rightGazeX: avg("rightGazeX"),
    leftGazeY: avg("leftGazeY"),
    rightGazeY: avg("rightGazeY"),
    mouthOpenRatio: avg("mouthOpenRatio"),
  };
  p.behaviorSignature = buildBehaviorSignature(p.faceReference, p.audioBaselineRms);
  p.calibrated = true;
  return true;
}

async function collectLivePrecheckQualitySamples(durationMs = 1800) {
  const p = state.assessmentPreview.proctor;
  const samples = {
    brightness: [],
    audio: [],
    faceCount: 0,
    singleFaceCount: 0,
    stableFaceMetricCount: 0,
    largeFaceCount: 0,
  };
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const brightness = await captureProctorBrightness().catch(() => 0);
    if (brightness > 0) samples.brightness.push(brightness);
    const rms = detectAudioRms();
    if (Number.isFinite(rms)) samples.audio.push(rms);
    if (p.faceModel && isPlayableVideoElement(el.apProctorVideo)) {
      try {
        const out = p.faceModel.detectForVideo(el.apProctorVideo, performance.now());
        const faces = out?.faceLandmarks || [];
        samples.faceCount += 1;
        if (faces.length === 1) {
          samples.singleFaceCount += 1;
          const metrics = computeFaceMetrics(faces[0]);
          if (metrics) {
            samples.stableFaceMetricCount += 1;
            if (Number(metrics.eyeDist || 0) >= 0.055) samples.largeFaceCount += 1;
          }
        }
      } catch {
        // ignore per-frame model errors during precheck sampling
      }
    }
    await new Promise((r) => setTimeout(r, 140));
  }
  return samples;
}

function summarizeLivePrecheckQuality(samples) {
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const peak = (arr) => arr.length ? Math.max(...arr) : 0;
  const brightnessAvg = avg(samples.brightness);
  const audioAvg = avg(samples.audio);
  const audioPeak = peak(samples.audio);
  const singleFaceRatio = samples.faceCount > 0 ? samples.singleFaceCount / samples.faceCount : 0;
  const clearFaceRatio = samples.singleFaceCount > 0 ? samples.largeFaceCount / samples.singleFaceCount : 0;
  const checks = {
    lightingOk: brightnessAvg >= 42,
    faceVisibleOk: singleFaceRatio >= 0.72 && samples.stableFaceMetricCount >= 5,
    faceSizeOk: clearFaceRatio >= 0.68,
    audioSignalOk: audioPeak >= 0.006,
    audioNoiseOk: audioAvg <= 0.11,
  };
  return {
    brightnessAvg,
    audioAvg,
    audioPeak,
    singleFaceRatio,
    clearFaceRatio,
    checks,
  };
}

function getLivePrecheckFailureMessage(summary) {
  const c = summary.checks;
  if (!c.lightingOk) return "Lighting is too low. Brighten your face and screen area before starting.";
  if (!c.faceVisibleOk) return "Face visibility is weak. Keep only one face centered and clearly visible to the camera.";
  if (!c.faceSizeOk) return "Move slightly closer to the laptop so your eyes and face are captured clearly.";
  if (!c.audioSignalOk) return "Microphone signal is too weak. Check microphone permission and speak once near the laptop.";
  if (!c.audioNoiseOk) return "Background noise is too high. Move to a quieter room before starting.";
  return "";
}

function renderLivePrecheckQualitySummary(summary) {
  const checks = summary.checks;
  const tag = (ok, label) => `${ok ? "PASS" : "FAIL"} ${label}`;
  if (el.apProctorHints) {
    el.apProctorHints.textContent = [
      tag(checks.lightingOk, "lighting"),
      tag(checks.faceVisibleOk && checks.faceSizeOk, "camera clarity"),
      tag(checks.audioSignalOk && checks.audioNoiseOk, "audio clarity"),
    ].join(" | ");
  }
}

function startProctoringMonitoring() {
  const p = state.assessmentPreview.proctor;
  scheduleNextAttentionChallenge(45000, 75000);
  p.visibilityHandler = () => {
    if (document.hidden) pushProctorWarning("Tab switching detected. Stay on the test screen.");
  };
  p.blurHandler = () => pushProctorWarning("Window focus lost. Switching is not allowed.");
  p.focusHandler = () => {
    if (el.assessmentPreviewScreen && !document.fullscreenElement && el.assessmentPreviewScreen.requestFullscreen) {
      el.assessmentPreviewScreen.requestFullscreen().catch(() => {});
    }
  };
  p.fullscreenHandler = () => {
    if (el.assessmentPreviewScreen?.classList.contains("hidden")) return;
    if (!document.fullscreenElement) {
      pushProctorWarning("Exited fullscreen. Fullscreen is required.");
      if (el.assessmentPreviewScreen?.requestFullscreen) {
        el.assessmentPreviewScreen.requestFullscreen().catch(() => {});
      }
    }
  };
  document.addEventListener("visibilitychange", p.visibilityHandler);
  window.addEventListener("blur", p.blurHandler);
  window.addEventListener("focus", p.focusHandler);
  document.addEventListener("fullscreenchange", p.fullscreenHandler);
  p.monitorId = setInterval(async () => {
    p.monitorTick += 1;
    const brightness = await captureProctorBrightness();
    if (brightness > 0 && brightness < 40) {
      pushProctorWarning("Low lighting detected. Improve lighting.", "low_lighting");
    }
    analyzeFaceFrame();
    maybeRunAttentionChallenge();
    analyzeHandFrame();
    detectFrameMovement();
    if (p.monitorTick % 2 === 0) {
      await detectMobilePhoneInFrame();
    }
    const loud = detectAudioAnomaly();
    const persistentVoice = detectVoicePersistence();
    if (loud || persistentVoice) p.speechFrames += 1;
    else p.speechFrames = Math.max(0, p.speechFrames - 1);
    if (p.speechFrames >= 3) {
      pushProctorWarning("Continuous external voice/noise detected.", "external_voice_detected", "critical");
      p.speechFrames = 0;
    }
    const loudSpeech = detectLoudSpeechAnomaly();
    if (loudSpeech) p.loudVoiceFrames += 1;
    else p.loudVoiceFrames = Math.max(0, p.loudVoiceFrames - 1);
    if (p.loudVoiceFrames >= 2) {
      pushProctorWarning(
        "Loud self-speaking detected. Reading or speaking loudly during the test is not allowed.",
        "loud_voice_detected",
        "critical",
      );
      p.loudVoiceFrames = 0;
    }
    const candidateSpeech = detectCandidateSpeech();
    if (candidateSpeech) p.candidateSpeechFrames += 1;
    else p.candidateSpeechFrames = Math.max(0, p.candidateSpeechFrames - 1);
    if (p.candidateSpeechFrames >= 3) {
      pushProctorWarning(
        "Reading aloud or self-speaking detected. Candidates must remain silent during the test.",
        "reading_aloud_detected",
        "critical",
      );
      p.candidateSpeechFrames = 0;
    }
    const backgroundVoice = detectBackgroundVoice();
    if (backgroundVoice) p.backgroundVoiceFrames += 1;
    else p.backgroundVoiceFrames = Math.max(0, p.backgroundVoiceFrames - 1);
    if (p.backgroundVoiceFrames >= 4) {
      pushProctorWarning(
        "Voice detected near the candidate without matching mouth movement. Possible nearby external speaker.",
        "background_voice_detected",
        "critical",
      );
      p.backgroundVoiceFrames = 0;
    }
    const drift = evaluateBehaviorDrift();
    if (drift.score >= 2.3 && drift.reasons.length >= 2) p.behaviorDriftFrames += 1;
    else p.behaviorDriftFrames = Math.max(0, p.behaviorDriftFrames - 1);
    if (p.behaviorDriftFrames >= 4) {
      pushProctorWarning(
        "Behavior pattern drift detected. Your gaze, posture, and interaction pattern no longer match the verified exam baseline.",
        "behavior_signature_drift",
        "critical",
      );
      logProctorEvent("critical", "behavior_signature_drift_detail", {
        reasons: drift.reasons,
        score: Number(drift.score.toFixed(3)),
      }).catch(() => {});
      p.behaviorDriftFrames = 0;
    }
  }, 500);
}

async function runProctoringPrecheck() {
  const p = state.assessmentPreview.proctor;
  const isMobileDevice = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent || "");
  if (isMobileDevice) {
    p.precheckReady = false;
    if (el.apPrecheckStatus) el.apPrecheckStatus.textContent = "Assessments are blocked on mobile devices. Use a desktop/laptop.";
    if (el.apProctorHints) el.apProctorHints.textContent = "Mobile device usage is not permitted for proctored exams.";
    if (el.apStartTestBtn) el.apStartTestBtn.disabled = true;
    return;
  }
  shutdownProctoringMedia();
  p.warnings = 0;
  p.faceAbsentFrames = 0;
  p.faceAwayFrames = 0;
  p.faceMismatchFrames = 0;
  p.gazeAwayFrames = 0;
  p.faceTooFarFrames = 0;
  p.multiFaceFrames = 0;
  p.speechFrames = 0;
  p.loudVoiceFrames = 0;
  p.candidateSpeechFrames = 0;
  p.backgroundVoiceFrames = 0;
  p.sideHandFrames = 0;
  p.handNearFaceFrames = 0;
  p.lookAwaySinceMs = 0;
  resetGazeSuspicionSessionState(p);
  p.faceReference = null;
  p.behaviorSignature = null;
  p.behaviorDriftFrames = 0;
  p.challengeActive = false;
  p.challengeTarget = "";
  p.challengeStartMs = 0;
  p.challengeDeadlineMs = 0;
  p.challengeCooldownUntil = 0;
  p.challengeNextAtMs = 0;
  p.challengePasses = 0;
  p.challengeFailures = 0;
  p.environmentAttested = Boolean(el.apEnvironmentAttest?.checked);
  p.precheckReady = true;
  p.calibrated = false;
  p.audioBaselineRms = 0.03;
  p.baselineEvidenceReady = false;
  p.monitorTick = 0;
  p.phoneFrames = 0;
  p.phoneModelReady = false;
  p.handModel = null;
  p.handModelReady = false;
  p.lastWarnAt = {};
  updateProctorBadge();
  clearAttentionChallengeOverlay();
  if (el.apProctorVideo) el.apProctorVideo.srcObject = null;
  if (el.apPrecheckStatus) el.apPrecheckStatus.textContent = "Pre-check complete. Camera and microphone will turn on only when you click Start Assessment.";
  if (el.apProctorHints) el.apProctorHints.textContent = "When the assessment starts, keep face visible, stay in frame, and avoid other voices.";
  updateAssessmentStartEligibility();
}

async function initializeProctoringForAssessmentStart() {
  const p = state.assessmentPreview.proctor;
  if (el.apPrecheckStatus) {
    el.apPrecheckStatus.textContent =
      "Starting camera/microphone and running lighting, face-clarity, and audio checks. Hold still for about 3 seconds...";
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  p.stream = stream;
  if (el.apProctorVideo) {
    el.apProctorVideo.srcObject = stream;
    await el.apProctorVideo.play().catch(() => {});
  }
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    p.audioContext = audioContext;
    p.analyser = analyser;
  } catch {}
  try {
    p.faceModel = await ensureFaceLandmarker();
    p.faceModelError = "";
  } catch {
    p.faceModel = null;
    p.faceModelError = "Face model unavailable";
  }
  try {
    await ensurePhoneDetector();
    p.phoneModelReady = true;
  } catch {
    p.phoneModelReady = false;
  }
  try {
    p.handModel = await ensureHandLandmarker();
    p.handModelReady = true;
  } catch {
    p.handModel = null;
    p.handModelReady = false;
  }
  await new Promise((r) => setTimeout(r, 700));
  const baselineRmsSamples = [];
  const baselineAudioStarted = Date.now();
  while (Date.now() - baselineAudioStarted < 1200) {
    baselineRmsSamples.push(detectAudioRms());
    await new Promise((r) => setTimeout(r, 120));
  }
  if (baselineRmsSamples.length) {
    p.audioBaselineRms = baselineRmsSamples.reduce((a, b) => a + b, 0) / baselineRmsSamples.length;
  }
  const precheckSamples = await collectLivePrecheckQualitySamples(1800);
  const precheckSummary = summarizeLivePrecheckQuality(precheckSamples);
  renderLivePrecheckQualitySummary(precheckSummary);
  const calibrated = await runFaceCalibration();
  const brightness = await captureProctorBrightness();
  let faceOk = true;
  if (p.faceModel) {
    try {
      if (!isPlayableVideoElement(el.apProctorVideo)) throw new Error("Video stream not ready");
      const out = p.faceModel.detectForVideo(el.apProctorVideo, performance.now());
      const faceCount = out?.faceLandmarks?.length || 0;
      faceOk = faceCount === 1;
    } catch {
      faceOk = false;
    }
  }
  const lightOk = brightness >= 40;
  const calibrationOk = !p.faceModel || calibrated;
  const qualityFailure = getLivePrecheckFailureMessage(precheckSummary);
  if (!(lightOk && faceOk && calibrationOk && p.phoneModelReady) || qualityFailure) {
    if (qualityFailure) throw new Error(qualityFailure);
    if (!lightOk) throw new Error("Lighting is too low. Improve lighting and try again.");
    if (!faceOk) throw new Error("Face check failed. Keep only one face visible and centered.");
    if (!p.phoneModelReady) throw new Error("Mobile-device detector unavailable. Try again.");
    throw new Error("Calibration failed. Keep still and look at screen.");
  }
  const baselineVideoOk = await captureAndUploadBaselineClip().catch(() => false);
  const baselinePhotoOk = await captureAndUploadProctorSnapshot("baseline", "candidate_calibrated").then(() => true).catch(() => false);
  p.baselineEvidenceReady = Boolean(baselineVideoOk && baselinePhotoOk);
  if (!p.baselineEvidenceReady) throw new Error("Baseline capture failed. Try again.");
  if (el.apPrecheckStatus) {
    el.apPrecheckStatus.textContent = "Pre-check passed: lighting, face visibility, and audio clarity are sufficient.";
  }
}

async function startAssessmentAfterPrecheck() {
  const p = state.assessmentPreview.proctor;
  if (p.startingUp) return;
  if (!p.environmentAttested) {
    toast("Assessment cannot start while screen sharing or remote desktop tools may be active. Confirm the local-only environment first.", "error");
    return;
  }
  if (!p.precheckReady) {
    toast("Run pre-check before starting the assessment.", "error");
    return;
  }
  p.startingUp = true;
  if (el.apStartTestBtn) el.apStartTestBtn.disabled = true;
  try {
    if (!(p.stream && p.baselineEvidenceReady && p.sessionId)) {
      await ensureAssessmentFullscreen();
      await startServerProctorSession();
      await initializeProctoringForAssessmentStart();
    }
  } catch (err) {
    shutdownProctoringMedia();
    await finalizeServerProctorSession("start_failed").catch(() => {});
    p.sessionId = null;
    if (el.apPrecheckStatus) el.apPrecheckStatus.textContent = err?.message || "Camera/microphone access is required for proctoring.";
    if (el.apProctorHints) el.apProctorHints.textContent = "Allow permissions and try starting the assessment again.";
    updateAssessmentStartEligibility();
    toast(err?.message || "Failed to start proctoring", "error");
    return;
  } finally {
    p.startingUp = false;
  }
  if (el.apPrecheckStatus) el.apPrecheckStatus.textContent = "Proctoring active. Assessment started.";
  if (el.apProctorHints) el.apProctorHints.textContent = "Keep face visible, stay in frame, avoid other voices, and do not switch tabs.";
  if (el.apPrecheckPanel) el.apPrecheckPanel.classList.add("hidden");
  if (el.apQuestionPanel) el.apQuestionPanel.classList.remove("hidden");
  if (el.apResultPanel) el.apResultPanel.classList.add("hidden");
  clearAttentionChallengeOverlay();
  renderAssessmentPreviewQuestion();
  startAssessmentPreviewTimer();
  startProctoringMonitoring();
  logProctorEvent("info", "assessment_started", {}).catch(() => {});
}

function confirmQuitAssessment() {
  const inProgress = !el.apQuestionPanel?.classList.contains("hidden") && el.apResultPanel?.classList.contains("hidden");
  if (!inProgress) {
    closeAssessmentPreview();
    return;
  }
  const quit = confirm("Do you want to quit the test?");
  if (!quit) return;
  showAssessmentPreviewResult("quit");
}

function closeAssessmentPreview() {
  clearAssessmentPreviewTimer();
  shutdownProctoringMedia();
  finalizeServerProctorSession("closed").catch(() => {});
  if (document.fullscreenElement === el.assessmentPreviewScreen && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  state.assessmentPreview = {
    mode: "preview",
    attemptId: null,
    exam: null,
    questions: [],
    index: 0,
    answers: {},
    latestResult: null,
    trainingFeedbackChoice: "",
    timerId: null,
    remainingSec: 0,
    timerPaused: false,
    warningPauseCount: 0,
    proctor: defaultProctorState(),
  };
  clearAttentionChallengeOverlay();
  closeProctorWarningModal();
  renderTrainingFeedbackPanel(null);
  el.assessmentPreviewScreen?.classList.add("hidden");
}

function readCurrentPreviewAnswer() {
  const current = state.assessmentPreview.questions[state.assessmentPreview.index];
  if (!current) return;
  const checked = Array.from(document.querySelectorAll("[data-ap-opt]:checked")).map((x) => Number(x.value));
  state.assessmentPreview.answers[current.question_id] = checked;
}

function renderAssessmentPreviewQuestion() {
  const preview = state.assessmentPreview;
  const q = preview.questions[preview.index];
  if (!q) return;
  el.apQuestionPanel?.classList.remove("question-enter");
  requestAnimationFrame(() => el.apQuestionPanel?.classList.add("question-enter"));
  if (el.apProgressText) el.apProgressText.textContent = `Question ${preview.index + 1}/${preview.questions.length}`;
  if (el.apQuestionText) el.apQuestionText.textContent = q.question_text;
  const existing = preview.answers[q.question_id] || [];
  const inputType = q.question_type === "mcq_multiple_correct" ? "checkbox" : "radio";
  const name = `ap-q-${q.question_id}`;
  renderList(
    el.apOptionsList,
    q.options || [],
    (o) => `
      <label class="preview-option">
        <input data-ap-opt type="${inputType}" name="${name}" value="${o.option_id}" ${existing.includes(o.option_id) ? "checked" : ""} />
        <span>${o.option_text}</span>
      </label>
    `,
    "No options.",
  );
  if (preview.mode === "student_attempt") {
    document.querySelectorAll("[data-ap-opt]").forEach((node) => {
      node.addEventListener("change", async () => {
        readCurrentPreviewAnswer();
        try {
          await persistCurrentStudentAttemptAnswer();
        } catch {}
      });
    });
  }
  const prevBtn = $("apPrevBtn");
  const nextBtn = $("apNextBtn");
  const submitBtn = $("apSubmitBtn");
  if (prevBtn) prevBtn.disabled = preview.index <= 0;
  const isLast = preview.index >= preview.questions.length - 1;
  if (nextBtn) nextBtn.classList.toggle("hidden", isLast);
  if (submitBtn) submitBtn.classList.toggle("hidden", !isLast);
  requestAnimationFrame(() => beginGazeQuestionGrace(preview.proctor));
}

function setTrainingFeedbackChoice(choice) {
  state.assessmentPreview.trainingFeedbackChoice = choice;
  el.apTrainingPassBtn?.classList.toggle("primary", choice === "correct");
  el.apTrainingFailBtn?.classList.toggle("primary", choice === "incorrect");
}

function trainingReviewEligible() {
  const preview = state.assessmentPreview;
  if (Boolean(preview.attemptId)) return true;
  return (
    preview.mode === "preview" &&
    Boolean(preview.latestResult) &&
    Boolean(preview.proctor?.sessionId)
  );
}

function renderTrainingFeedbackPanel(result = null) {
  if (!el.apTrainingFeedbackPanel) return;
  const activeResult = result || state.assessmentPreview.latestResult;
  const showReview = trainingReviewEligible();
  el.apTrainingFeedbackPanel.classList.toggle("hidden", !showReview);
  if (!showReview) return;
  const savedStatus = activeResult?.training_feedback_status || "";
  const savedComment = activeResult?.training_feedback_comment || "";
  const feedbackCount = Number(activeResult?.training_feedback_count || 0);
  if (!state.assessmentPreview.trainingFeedbackChoice && savedStatus) {
    state.assessmentPreview.trainingFeedbackChoice = savedStatus;
  }
  setTrainingFeedbackChoice(state.assessmentPreview.trainingFeedbackChoice || "");
  if (el.apTrainingComment) {
    el.apTrainingComment.value = savedComment;
  }
  if (el.apTrainingFeedbackStatus) {
    if (savedStatus) {
      const label = savedStatus === "correct" ? "Pass (model correct)" : "Fail (model wrong)";
      el.apTrainingFeedbackStatus.textContent = `Latest saved review: ${label}${feedbackCount > 1 ? ` | total saved: ${feedbackCount}` : ""}`;
    } else {
      el.apTrainingFeedbackStatus.textContent =
        "No training review saved yet. Use the score and proctor lines above, then choose Pass or Fail.";
    }
  }
}

async function saveTrainingFeedback() {
  const preview = state.assessmentPreview;
  const attemptId = preview.attemptId;
  const sessionId = preview.proctor?.sessionId;
  if (!attemptId && !sessionId) {
    toast("Cannot save: proctor session was lost. Close and re-run the assessment once.", "error");
    return;
  }
  const choice = preview.trainingFeedbackChoice;
  if (!choice) {
    toast("Choose Pass or Fail for the model review first.", "error");
    return;
  }
  const comment = el.apTrainingComment?.value?.trim() || "";
  let out;
  if (attemptId) {
    out = await api("POST", `/student/attempts/${attemptId}/proctor-training-feedback`, {
      training_result: choice,
      comment,
    });
  } else {
    out = await api("POST", `/proctoring/sessions/${sessionId}/training-feedback`, {
      training_result: choice,
      comment,
    });
  }
  state.assessmentPreview.latestResult = {
    ...(state.assessmentPreview.latestResult || {}),
    training_feedback_status: out.training_feedback_status,
    training_feedback_comment: out.training_feedback_comment,
    training_feedback_count: out.training_feedback_count,
  };
  renderTrainingFeedbackPanel(state.assessmentPreview.latestResult);
  toast("Training review saved");
}

function showAssessmentPreviewResult(reason = "completed") {
  clearAssessmentPreviewTimer();
  shutdownProctoringMedia();
  clearAttentionChallengeOverlay();
  const preview = state.assessmentPreview;
  if (preview.mode === "student_attempt") {
    if (el.apPrecheckPanel) el.apPrecheckPanel.classList.add("hidden");
    if (el.apQuestionPanel) el.apQuestionPanel.classList.add("hidden");
    if (el.apResultPanel) el.apResultPanel.classList.remove("hidden");
    (async () => {
      if (el.apResultSummary) el.apResultSummary.textContent = "Analyzing proctoring patterns and finalizing result...";
      const finalized = await finalizeServerProctorSession(reason).catch(() => null);
      const result = await api("POST", `/student/attempts/${preview.attemptId}/submit`);
      preview.latestResult = result;
      preview.trainingFeedbackChoice = result.training_feedback_status || "";
      const aiEval = finalized?.ai_evaluation || null;
      if (el.apResultSummary) {
        const hardFail = Boolean(result.proctor_hard_fail);
        const fairnessVerdict = result.proctor_hard_fail
          ? "UNFAIR"
          : result.proctor_review_required
            ? "REVIEW REQUIRED"
            : ["critical", "manual_review"].includes(String(result.proctor_decision || "").toLowerCase())
              ? "UNFAIR"
              : "FAIR";
        el.apResultSummary.innerHTML = `
          <div><strong>${hardFail ? "FAIL (Proctoring Violation)" : result.passed ? "PASS" : "FAIL"}</strong></div>
          <div style="margin-top:8px;">Percentage: ${Number(result.percentage || 0).toFixed(2)}%</div>
          <div>Correct: ${result.correct_count ?? "-"}</div>
          <div>Wrong: ${result.wrong_count ?? "-"}</div>
          <div>Proctor: ${(result.proctor_decision || aiEval?.decision || "clear").toUpperCase()}</div>
          <div>Assessment fairness: ${fairnessVerdict}</div>
          ${result.certificate?.certificate_id ? `
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid #dbe4f0;">
              <div><strong>Certificate Issued</strong></div>
              <div class="meta">Certificate ID: ${result.certificate.certificate_id}</div>
              <div class="actions" style="margin-top:8px;">
                ${result.certificate.download_url ? `<a class="btn small" href="${result.certificate.download_url}" target="_blank" rel="noreferrer">Download Certificate</a>` : ""}
                <a class="btn small" href="${result.certificate.verification_link}" target="_blank" rel="noreferrer">Verify Certificate</a>
              </div>
            </div>
          ` : ""}
          ${hardFail && result.proctor_hard_fail_reason ? `<div style="margin-top:8px;color:#b91c1c;"><strong>${result.proctor_hard_fail_reason}</strong></div>` : ""}
        `;
      }
      if (el.apWarningsSummary) {
        const prob = result.proctor_probability ?? aiEval?.final_probability;
        const ded = Number(result.proctor_deduction_pct || 0);
        const mode = result.proctor_deduction_mode || aiEval?.deduction_mode || "none";
        const probText = typeof prob === "number" ? `${(prob * 100).toFixed(1)}%` : "N/A";
        el.apWarningsSummary.textContent = `Warnings: ${preview.proctor.warnings} | Risk: ${probText} | Deduction: -${ded.toFixed(2)}% (${mode})${result.proctor_review_required ? " | Manual review required" : ""}`;
      }
      renderTrainingFeedbackPanel(result);
      logProctorEvent("info", "assessment_result_generated", {
        reason,
        pass: Boolean(result.passed),
        final_percentage: result.percentage,
        warnings: preview.proctor.warnings,
        proctor_decision: result.proctor_decision,
        proctor_probability: result.proctor_probability,
        proctor_deduction_pct: result.proctor_deduction_pct,
      }).catch(() => {});
    })().catch((err) => {
      if (el.apResultSummary) {
        el.apResultSummary.textContent = err?.message || "Failed to submit assessment.";
      }
    });
    return;
  }
  (async () => {
    await finalizeServerProctorSession(reason).catch(() => {});
    const exam = preview.exam;
    let correct = 0;
    let wrong = 0;
    let totalMarks = 0;
    let awarded = 0;
    for (const q of preview.questions) {
      const correctIds = (q.options || []).filter((o) => o.is_correct).map((o) => o.option_id).sort((a, b) => a - b);
      const selected = (preview.answers[q.question_id] || []).slice().sort((a, b) => a - b);
      totalMarks += Number(q.marks || 0);
      const isCorrect = selected.length === correctIds.length && selected.every((v, i) => v === correctIds[i]);
      if (isCorrect) {
        correct += 1;
        awarded += Number(q.marks || 0);
      } else {
        wrong += 1;
        if (exam?.negative_marking) awarded -= Math.abs(Number(q.negative_marks || 0));
      }
    }
    const percentage = totalMarks > 0 ? Math.max(0, (awarded / totalMarks) * 100) : 0;
    const warnings = preview.proctor.warnings;
    const penalty = warnings * Number(preview.proctor.penaltyPerWarningPct || 0);
    const finalPercentage = Math.max(0, percentage - penalty);
    const pass = finalPercentage >= Number(exam?.pass_score || 60);
    if (el.apPrecheckPanel) el.apPrecheckPanel.classList.add("hidden");
    if (el.apQuestionPanel) el.apQuestionPanel.classList.add("hidden");
    if (el.apResultPanel) el.apResultPanel.classList.remove("hidden");
    if (el.apResultSummary) {
      const fairnessVerdict = warnings >= 3 ? "REVIEW REQUIRED" : "FAIR";
      el.apResultSummary.innerHTML = `
      <div><strong>${pass ? "PASS" : "FAIL"}</strong></div>
      <div style="margin-top:8px;">Percentage: ${finalPercentage.toFixed(2)}%</div>
      <div>Correct: ${correct}</div>
      <div>Wrong: ${wrong}</div>
      <div>Assessment fairness: ${fairnessVerdict}</div>
    `;
    }
    if (el.apWarningsSummary) {
      el.apWarningsSummary.textContent = `Proctor warnings: ${warnings} | Penalty: -${penalty.toFixed(2)}%`;
    }
    preview.latestResult = {
      passed: pass,
      percentage: finalPercentage,
      training_feedback_status: null,
      training_feedback_comment: "",
      training_feedback_count: 0,
    };
    preview.trainingFeedbackChoice = "";
    const sid = preview.proctor?.sessionId;
    if (sid) {
      try {
        const fb = await api("GET", `/proctoring/sessions/${sid}/training-feedback/latest`);
        if (fb?.training_feedback_status) {
          preview.latestResult = {
            ...preview.latestResult,
            training_feedback_status: fb.training_feedback_status,
            training_feedback_comment: fb.training_feedback_comment || "",
            training_feedback_count: fb.training_feedback_count ?? 0,
          };
          preview.trainingFeedbackChoice = fb.training_feedback_status;
        }
      } catch {
        /* ignore missing prior labels */
      }
    }
    renderTrainingFeedbackPanel(preview.latestResult);
    logProctorEvent("info", "assessment_result_generated", {
      reason,
      pass,
      final_percentage: finalPercentage,
      warnings,
      penalty,
    }).catch(() => {});
  })().catch((err) => {
    if (el.apResultSummary) el.apResultSummary.textContent = err?.message || "Failed to show assessment result.";
  });
}

function startAssessmentPreviewTimer() {
  clearAssessmentPreviewTimer();
  const preview = state.assessmentPreview;
  const exam = preview.exam;
  if (!exam) return;
  if (exam.timing_mode === "question") {
    if (el.apTimerText) el.apTimerText.textContent = `${exam.time_per_question_seconds || 0}s/question`;
    return;
  }
  preview.remainingSec = Math.max(0, Number(exam.duration_minutes || 0) * 60);
  if (el.apTimerText) el.apTimerText.textContent = formatSecondsToClock(preview.remainingSec);
  preview.timerId = setInterval(() => {
    if (preview.timerPaused) return;
    preview.remainingSec -= 1;
    if (el.apTimerText) el.apTimerText.textContent = formatSecondsToClock(Math.max(0, preview.remainingSec));
    if (preview.remainingSec <= 0) {
      showAssessmentPreviewResult();
    }
  }, 1000);
}

async function openAssessmentPreview(examId) {
  const exam = state.providerAssessments.find((x) => Number(x.exam_id) === Number(examId));
  if (!exam) throw new Error("Assessment not found");
  const questions = await api("GET", `/exams/${examId}/questions`);
  if (!questions?.length) throw new Error("No questions available for preview");

  const mapped = questions.map((q) => ({
    question_id: q.question_id,
    question_text: q.question_text,
    question_type: q.question_type,
    marks: q.marks,
    negative_marks: q.negative_marks,
    options: (q.options || []).map((o) => ({ ...o })),
  }));
  if (exam.shuffle_questions) mapped.sort(() => Math.random() - 0.5);
  if (exam.questions_per_attempt > 0 && mapped.length > exam.questions_per_attempt) {
    mapped.length = exam.questions_per_attempt;
  }
  if (exam.shuffle_options) {
    mapped.forEach((q) => q.options.sort(() => Math.random() - 0.5));
  }

  state.assessmentPreview = {
    mode: "preview",
    attemptId: null,
    exam,
    questions: mapped,
    index: 0,
    answers: {},
    latestResult: null,
    trainingFeedbackChoice: "",
    timerId: null,
    remainingSec: 0,
    timerPaused: false,
    warningPauseCount: 0,
    proctor: defaultProctorState(),
  };
  if (el.apEnvironmentAttest) el.apEnvironmentAttest.checked = false;
  updateAssessmentStartEligibility();
  if (el.apMeta) el.apMeta.textContent = `${exam.title} | ${exam.course_title}`;
  if (el.apPrecheckPanel) el.apPrecheckPanel.classList.remove("hidden");
  if (el.apQuestionPanel) el.apQuestionPanel.classList.add("hidden");
  if (el.apResultPanel) el.apResultPanel.classList.add("hidden");
  renderTrainingFeedbackPanel(null);
  el.assessmentPreviewScreen?.classList.remove("hidden");
  await runProctoringPrecheck();
  try {
    await ensureAssessmentFullscreen();
    await startServerProctorSession();
    await initializeProctoringForAssessmentStart();
    if (el.apPrecheckStatus) {
      el.apPrecheckStatus.textContent = "Camera and microphone are active. Review the pre-check and click Start Assessment when ready.";
    }
    if (el.apProctorHints) {
      el.apProctorHints.textContent = "Fullscreen is active. Keep face visible, stay centered, and confirm the environment before starting.";
    }
    await logProctorEvent("info", "preview_opened", { exam_id: examId }).catch(() => {});
  } catch (err) {
    shutdownProctoringMedia();
    await finalizeServerProctorSession("preview_open_failed").catch(() => {});
    state.assessmentPreview.proctor.sessionId = null;
    if (el.apPrecheckStatus) {
      el.apPrecheckStatus.textContent = err?.message || "Could not start fullscreen camera/microphone preview.";
    }
    if (el.apProctorHints) {
      el.apProctorHints.textContent = "Allow fullscreen and camera/microphone permissions, then try again.";
    }
    toast(err?.message || "Failed to start preview proctoring", "error");
  }
}

function openCourseViewer(courseId) {
  const course = state.providerCourses.find((c) => Number(c.id) === Number(courseId));
  if (!course) return toast("Course not found", "error");
  const lesson = findPrimaryLesson(course);
  const liveLessons = findLiveLessons(course);
  if (!lesson?.recorded_video_url && !liveLessons.length) return toast("No recorded or live lesson found for this course", "error");

  const video = $("pcvVideo");
  if (video && lesson?.recorded_video_url) {
    video.src = lesson.recorded_video_url;
    video.load();
  } else if (video) {
    video.removeAttribute("src");
    video.load();
  }
  if (el.pcvTitle) el.pcvTitle.textContent = `${course.title} - Class Viewer`;
  $("providerCoursesHeader")?.classList.add("hidden");
  $("providerCoursesList")?.classList.add("hidden");
  $("providerDraftsPage")?.classList.add("hidden");
  $("courseWizard")?.classList.add("hidden");
  renderList(
    el.pcvTopicList,
    [...(lesson?.topics || [])].sort((a, b) => a.time_seconds - b.time_seconds),
    (t) => `
      <div class="topic-item" data-topic-item="${t.time_seconds}">
        ${t.thumbnail_data_url ? `<img src="${t.thumbnail_data_url}" alt="" style="width:100%;border-radius:8px;border:1px solid #e5e7eb; margin-bottom:6px;" />` : ""}
        <div><strong>${t.title}</strong></div>
        <div class="meta">${formatSecondsToClock(t.time_seconds)}</div>
        <div class="actions"><button class="btn small" data-pcv-seek="${t.time_seconds}">Go</button></div>
      </div>
    `,
    lesson ? "No topics available for this lesson." : "No recorded-video topics available.",
  );
  renderList(
    el.pcvLiveClassList,
    liveLessons,
    (l) => `
      <div>
        <div><strong>${l.title}</strong></div>
        <div class="meta">${l.module_title || "Live class"}</div>
        <div class="actions"><button class="btn small" data-pcv-join-live="${l.id}">Open Live Class</button></div>
      </div>
    `,
    "No live classes added.",
  );
  state.viewerTopics = [...(lesson?.topics || [])];
  document.querySelectorAll("[data-pcv-seek]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!video) return;
      video.currentTime = Number(btn.dataset.pcvSeek || 0);
      video.play().catch(() => {});
    });
  });
  document.querySelectorAll("[data-pcv-join-live]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const liveLesson = liveLessons.find((l) => Number(l.id) === Number(btn.dataset.pcvJoinLive));
      if (!liveLesson?.live_class_url) return toast("No live class link available", "error");
      window.open(liveLesson.live_class_url, "_blank", "noopener,noreferrer");
    });
  });
  el.providerCourseViewer?.classList.remove("hidden");
  const timeline = $("pcvTimelineMarkers");
  const tooltip = $("pcvMarkerTooltip");
  const applyMarkers = () => {
    renderTimelineMarkers(
      timeline,
      tooltip,
      lesson.topics || [],
      Number(video?.duration || 0),
      (seconds) => {
        if (!video) return;
        video.currentTime = seconds;
        video.play().catch(() => {});
      },
    );
  };
  if (lesson?.recorded_video_url) {
    video?.addEventListener("loadedmetadata", applyMarkers, { once: true });
    applyMarkers();
  } else if (timeline) {
    renderTimelineMarkers(timeline, tooltip, [], 0, () => {});
  }
}

async function openStudentCourseViewer(courseId) {
  const detail = await api("GET", `/student/courses/${courseId}/detail`);
  state.studentActiveCourseId = Number(courseId);
  state.studentVideoCompletionSent[Number(courseId)] = false;
  const lesson = findPrimaryLesson(detail);
  const liveLessons = findLiveLessons(detail);
  if (!lesson?.recorded_video_url && !liveLessons.length) {
    throw new Error("No recorded or live lesson available for this course.");
  }

  const video = $("scvVideo");
  const hasRecordedLesson = Boolean(lesson?.recorded_video_url);
  if (video && hasRecordedLesson) {
    video.src = lesson.recorded_video_url;
    video.load();
  } else if (video) {
    video.pause?.();
    video.removeAttribute("src");
    video.load();
  }
  if (el.scvTitle) el.scvTitle.textContent = `${detail.title} - Course Viewer`;
  if (el.scvMeta) el.scvMeta.textContent = `${detail.category || "General"} | ${detail.description || ""}`.trim();
  const progressPct = Number(detail.progress_pct || 0);
  if (el.scvProgressBar) el.scvProgressBar.style.width = `${Math.max(0, Math.min(100, progressPct))}%`;
  if (el.scvProgressText) el.scvProgressText.textContent = `${progressPct.toFixed(0)}%`;
  renderList(
    el.scvTopicList,
    [...(lesson?.topics || [])].sort((a, b) => a.time_seconds - b.time_seconds),
    (t) => `
      <div class="topic-item" data-topic-item="${t.time_seconds}">
        ${t.thumbnail_data_url ? `<img src="${t.thumbnail_data_url}" alt="" style="width:100%;border-radius:8px;border:1px solid #e5e7eb; margin-bottom:6px;" />` : ""}
        <div><strong>${t.title}</strong></div>
        <div class="meta">${formatSecondsToClock(t.time_seconds)}</div>
        <div class="actions"><button class="btn small" data-scv-seek="${t.time_seconds}">Go</button></div>
      </div>
    `,
    hasRecordedLesson ? "No topics available for this lesson." : "No recorded lesson topics available.",
  );
  renderList(
    el.scvLiveClassList,
    liveLessons,
    (l) => `
      <div>
        <div><strong>${l.title}</strong></div>
        <div class="meta">${l.module_title || "Live class"}</div>
        <div class="actions"><button class="btn small" data-scv-join-live="${l.id}">Join Live Class</button></div>
      </div>
    `,
    "No live classes available right now.",
  );
  const resources = lesson?.resources || [];
  renderList(
    el.scvResourceList,
    resources,
    (r) => `<div><a href="${r.url}" target="_blank" rel="noreferrer">${r.title || r.url}</a></div><div class="meta">${r.resource_type || "attachment"}</div>`,
    hasRecordedLesson ? "No resources attached." : "No lesson resources attached.",
  );
  state.studentViewerTopics = [...(lesson?.topics || [])];
  document.querySelectorAll("[data-scv-seek]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!video) return;
      video.currentTime = Number(btn.dataset.scvSeek || 0);
      video.play().catch(() => {});
    });
  });
  document.querySelectorAll("[data-scv-join-live]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lessonId = Number(btn.dataset.scvJoinLive || 0);
      if (!lessonId) return;
      try {
        const out = await api("POST", `/student/lessons/${lessonId}/join-live`);
        if (!out?.live_class_url) throw new Error("No live class link available");
        window.open(out.live_class_url, "_blank", "noopener,noreferrer");
      } catch (err) {
        toast(err?.message || "Failed to join live class", "error");
      }
    });
  });
  const videoShell = $("scvVideoShell");
  const timeline = $("scvTimelineMarkers");
  const tooltip = $("scvMarkerTooltip");
  if (videoShell) videoShell.classList.toggle("hidden", !hasRecordedLesson);
  if (tooltip) tooltip.classList.add("hidden");
  el.studentCourseViewer?.classList.remove("hidden");
  await refreshStudentAssessmentPanel(courseId, Boolean(detail.exam_eligible && hasRecordedLesson));
  const applyMarkers = () => {
    renderTimelineMarkers(
      timeline,
      tooltip,
      lesson?.topics || [],
      Number(video?.duration || 0),
      (seconds) => {
        if (!video) return;
        video.currentTime = seconds;
        video.play().catch(() => {});
      },
    );
  };
  if (hasRecordedLesson) {
    video?.addEventListener("loadedmetadata", applyMarkers, { once: true });
    applyMarkers();
  } else if (timeline) {
    renderTimelineMarkers(timeline, tooltip, [], 0, () => {});
  }
}

async function refreshStudentAssessmentPanel(courseId, examEligible) {
  if (!el.scvAssessmentPanel) return;
  if (!examEligible) {
    el.scvAssessmentPanel.innerHTML = `<span id="scvAssessmentStatus" class="meta">Watch the full video to unlock assessment.</span>`;
    return;
  }
  const out = await api("POST", `/student/courses/${courseId}/assessment-intent?ready=true`);
  const exams = out.exams || [];
  if (!exams.length) {
    el.scvAssessmentPanel.innerHTML = `<span id="scvAssessmentStatus" class="meta">Assessment will be available soon.</span>`;
    return;
  }
  el.scvAssessmentPanel.innerHTML = exams
    .map((e) => `<button class="btn primary" data-student-start-exam="${e.exam_id}">Start Assessment: ${e.title}</button>`)
    .join("");
  document.querySelectorAll("[data-student-start-exam]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await openStudentAssessmentAttempt(Number(btn.dataset.studentStartExam));
      } catch (err) {
        toast(err?.message || "Failed to start assessment", "error");
      }
    });
  });
}

async function openStudentAssessmentAttempt(examId) {
  const start = await api("POST", `/student/exams/${examId}/attempts/start`);
  const paper = await api("GET", `/student/attempts/${start.attempt_id}/paper`);
  const mapped = (paper.questions || []).map((q) => ({
    question_id: q.question_id,
    question_text: q.question_text,
    question_type: q.question_type,
    marks: q.marks,
    negative_marks: q.negative_marks,
    options: (q.options || []).map((o) => ({ ...o })),
  }));
  state.assessmentPreview = {
    mode: "student_attempt",
    attemptId: start.attempt_id,
    exam: {
      exam_id: paper.exam_id,
      title: paper.title,
      course_title: "Assessment",
      timing_mode: paper.timing_mode,
      duration_minutes: paper.duration_minutes,
      time_per_question_seconds: paper.time_per_question_seconds,
      pass_score: paper.pass_score,
      negative_marking: paper.negative_marking,
      shuffle_questions: false,
      shuffle_options: false,
    },
    questions: mapped,
    index: 0,
    answers: {},
    latestResult: null,
    trainingFeedbackChoice: "",
    timerId: null,
    remainingSec: 0,
    timerPaused: false,
    warningPauseCount: 0,
    proctor: defaultProctorState(),
  };
  if (el.apEnvironmentAttest) el.apEnvironmentAttest.checked = false;
  updateAssessmentStartEligibility();
  if (el.apMeta) el.apMeta.textContent = `${paper.title}`;
  if (el.apPrecheckPanel) el.apPrecheckPanel.classList.remove("hidden");
  if (el.apQuestionPanel) el.apQuestionPanel.classList.add("hidden");
  if (el.apResultPanel) el.apResultPanel.classList.add("hidden");
  renderTrainingFeedbackPanel(null);
  el.assessmentPreviewScreen?.classList.remove("hidden");
  await runProctoringPrecheck();
}

async function persistCurrentStudentAttemptAnswer() {
  const preview = state.assessmentPreview;
  if (preview.mode !== "student_attempt" || !preview.attemptId) return;
  const current = preview.questions[preview.index];
  if (!current) return;
  const selected = preview.answers[current.question_id] || [];
  await api("POST", `/student/attempts/${preview.attemptId}/answers`, {
    question_id: current.question_id,
    selected_option_ids: selected,
    text_answer: null,
  });
}

async function refreshProviderAssessments() {
  const list = await api("GET", "/provider/workspace/assessments");
  state.providerAssessments = Array.isArray(list) ? list : [];
  renderList(
    el.providerAssessmentsList,
    state.providerAssessments,
    (a) => `
      <div><strong>${a.title}</strong> <span class="status-pill ${a.status === "published" ? "status-resolved" : "status-open"}">${a.status}</span></div>
      <div class='meta'>Exam #${a.exam_id} | ${a.course_title}</div>
      <div class='meta'>Pool: ${a.question_count} | Student gets: ${a.questions_per_attempt > 0 ? a.questions_per_attempt : a.question_count}</div>
      <div class='meta'>Pass: ${a.pass_score}% | Attempts: ${a.max_attempts}</div>
      <div class='meta'>Timing: ${a.timing_mode === "question" ? `${a.time_per_question_seconds || 0}s/question` : `${a.duration_minutes} mins/assessment`}</div>
      <div class='actions'>
        <button class="icon-play-btn" data-assessment-preview="${a.exam_id}" title="Preview assessment" aria-label="Preview assessment">&#9654;</button>
        ${
  a.status === "published"
    ? ""
    : `<button class="btn small" data-assessment-edit="${a.exam_id}">Edit Draft</button>
       <button class="btn small danger" data-assessment-delete="${a.exam_id}">Delete Draft</button>
       <button class="btn small" data-assessment-publish="${a.exam_id}">Publish</button>`
}
      </div>
    `,
    "No assessments yet.",
  );
  document.querySelectorAll("[data-assessment-preview]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await openAssessmentPreview(Number(btn.dataset.assessmentPreview || 0));
      } catch (err) {
        toast(err?.message || "Failed to open assessment preview", "error");
      }
    });
  });
  document.querySelectorAll("[data-assessment-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const examId = Number(btn.dataset.assessmentEdit || 0);
      const item = state.providerAssessments.find((x) => Number(x.exam_id) === examId);
      if (!item) return;
      try {
        await openAssessmentBuilderForEdit(item);
      } catch {
        toast("Failed to open draft for editing", "error");
      }
    });
  });
  document.querySelectorAll("[data-assessment-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const examId = Number(btn.dataset.assessmentDelete || 0);
      if (!examId) return;
      const ok = confirm("Delete this draft assessment?");
      if (!ok) return;
      try {
        await api("DELETE", `/exams/${examId}`);
        toast("Draft deleted");
        await refreshProviderAssessments();
      } catch (err) {
        toast(err?.message || "Failed to delete draft", "error");
      }
    });
  });
  document.querySelectorAll("[data-assessment-publish]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api("POST", `/exams/${btn.dataset.assessmentPublish}/publish`);
        toast("Assessment published");
        await refreshProviderAssessments();
      } catch {
        toast("Failed to publish assessment", "error");
      }
    });
  });
}

async function refreshProviderFeedback() {
  const comments = await api("GET", "/provider/workspace/feedback/comments");
  const ratings = await api("GET", "/provider/workspace/feedback/ratings");

  renderList(
    el.providerCommentsList,
    comments,
    (c) => `
      <div><strong>${c.course_title}</strong> - ${c.student_name}</div>
      <div style="margin-top:4px;">${c.message}</div>
      <div class="meta">${formatTime(c.created_at)}</div>
      <div class="meta">Reply: ${c.provider_reply || "No reply yet"}</div>
      <div class="actions">
        <button class="btn small" data-reply-comment="${c.comment_id}">Reply</button>
      </div>
    `,
    "No comments yet.",
  );

  renderList(
    el.providerRatingsList,
    ratings,
    (r) => `
      <div><strong>${r.course_title}</strong> - ${r.student_name}</div>
      <div class="meta">Valuable Time: ${r.valuable_time_rating}/5 | Content: ${r.content_quality_rating}/5 | Clarity: ${r.instructor_clarity_rating}/5 | Practical: ${r.practical_usefulness_rating}/5</div>
      <div style="margin-top:4px;">${r.comment || "No comment"}</div>
    `,
    "No feedback ratings yet.",
  );

  document.querySelectorAll("[data-reply-comment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.replyComment;
      const reply = prompt("Reply to student");
      if (!reply) return;
      try {
        await api("POST", `/provider/workspace/feedback/comments/${id}/reply`, { reply });
        toast("Reply sent");
        await refreshProviderFeedback();
      } catch (err) {
        toast("Failed to reply", "error");
      }
    });
  });
}

async function refreshProviderNotifications() {
  const notes = await api("GET", "/provider/workspace/notifications");
  renderList(
    el.providerNotificationsList,
    notes,
    (n) => `
      <div><strong>${n.event_type}</strong> ${n.is_read ? "" : "<span class='status-pill status-open'>new</span>"}</div>
      <div style='margin-top:4px;'>${n.message}</div>
      <div class='meta'>${formatTime(n.created_at)}</div>
      ${n.is_read ? "" : `<div class='actions'><button class='btn small' data-note-read='${n.id}'>Mark read</button></div>`}
    `,
    "No notifications.",
  );
  document.querySelectorAll("[data-note-read]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api("POST", `/provider/workspace/notifications/${btn.dataset.noteRead}/read`);
        await refreshProviderNotifications();
      } catch {
        toast("Failed to update notification", "error");
      }
    });
  });
}

async function refreshProviderCertifications() {
  const list = await api("GET", "/provider/workspace/certifications");
  renderList(
    el.providerCertsList,
    list,
    (c) => `
      <div><strong>${c.certificate_id}</strong> - ${c.course_name}</div>
      <div class='meta'>Student: ${c.student_name} | Issued: ${formatTime(c.issued_at)}</div>
      <div class='actions'>
        <a class='btn small' href='${c.download_url}' target='_blank'>Download/Share</a>
        <a class='btn small' href='${c.verification_url}' target='_blank'>Verify</a>
      </div>
    `,
    "No certificates issued yet.",
  );
}

async function completeLiveClassAction() {
  const courseId = Number($("liveCourseId")?.value || 0);
  const note = $("liveCompletionNote")?.value?.trim() || "";
  if (!courseId) {
    toast("Course ID is required", "error");
    return;
  }
  const out = await api("POST", `/provider/workspace/live-class/${courseId}/complete?note=${encodeURIComponent(note)}`);
  toast("Live class marked complete. Assessments unlocked.");
  log("live_class_complete", out);
}

async function addModuleAction() {
  const courseId = Number($("moduleCourseId")?.value || 0);
  if (!courseId) throw new Error("Course ID is required");
  await api("POST", `/courses/${courseId}/modules`, {
    title: $("moduleTitle")?.value?.trim(),
    position: Number($("modulePosition")?.value || 1),
    syllabus_text: "",
  });
}

async function addLessonAction() {
  const moduleId = Number($("lessonModuleId")?.value || 0);
  if (!moduleId) throw new Error("Module ID is required");
  const lessonType = $("lessonType")?.value || "recorded_video";
  await api("POST", `/courses/modules/${moduleId}/lessons`, {
    title: $("lessonTitle")?.value?.trim(),
    lesson_type: lessonType,
    recorded_video_url: lessonType === "recorded_video" ? ($("lessonVideoUrl")?.value?.trim() || null) : null,
    live_class_url: lessonType === "live_class_link" ? ($("lessonLiveUrl")?.value?.trim() || null) : null,
    position: Number($("lessonPosition")?.value || 1),
  });
}

async function addResourceAction() {
  const lessonId = Number($("resourceLessonId")?.value || 0);
  if (!lessonId) throw new Error("Lesson ID is required");
  await api("POST", `/courses/lessons/${lessonId}/resources`, {
    title: $("resourceTitle")?.value?.trim(),
    url: $("resourceUrl")?.value?.trim(),
    resource_type: $("resourceType")?.value?.trim() || "attachment",
  });
}

async function publishCourseAction() {
  const courseId = Number($("publishCourseId")?.value || 0);
  if (!courseId) throw new Error("Course ID is required");
  await api("POST", `/courses/${courseId}/publish`);
}

async function createCourseFromWizard() {
  const title = $("cwCourseTitle")?.value?.trim();
  const level = $("cwCourseLevel")?.value || "Beginner";
  const category = $("cwCourseCategory")?.value?.trim() || "General";
  const description = $("cwCourseDescription")?.value?.trim() || "";
  let thumbnail = $("cwCourseThumbnail")?.value?.trim() || null;
  const videoUrl = $("cwVideoUrl")?.value?.trim();
  const includesExam = Boolean($("cwIncludesExam")?.checked);

  if (!title) throw new Error("Course name is required");
  if (!videoUrl) throw new Error("Video URL is required");
  if (!thumbnail) {
    const firstFrame = await captureThumbnailAt(videoUrl, 0);
    thumbnail = firstFrame || null;
    if (thumbnail) setThumbnailValue(thumbnail);
  }

  const course = await api("POST", "/courses", {
    title,
    description: `${description}\n\nLevel: ${level}`.trim(),
    category,
    thumbnail_url: thumbnail,
    includes_certification_exam: includesExam,
  });
  const module = await api("POST", `/courses/${course.id}/modules`, {
    title: `${title} - Core Module`,
    position: 1,
    syllabus_text: "",
  });
  const lesson = await api("POST", `/courses/modules/${module.id}/lessons`, {
    title: `${title} - Main Class`,
    lesson_type: "recorded_video",
    recorded_video_url: videoUrl,
    live_class_url: null,
    position: 1,
  });
  for (const topic of state.draftTopics) {
    await api("POST", `/provider/workspace/content/lessons/${lesson.id}/topics`, {
      title: topic.title,
      time_seconds: topic.time_seconds,
      thumbnail_data_url: topic.thumbnail_data_url || null,
    });
  }
  await api("POST", `/courses/${course.id}/publish`);
  if (state.activeDraftId) {
    await api("DELETE", `/provider/workspace/courses/drafts/${state.activeDraftId}`);
    state.activeDraftId = null;
  }
  return { courseId: course.id, moduleId: module.id, lessonId: lesson.id, topicsAdded: state.draftTopics.length };
}

async function loadSessionContext() {
  stopAdminPolling();
  const context = await api("GET", "/auth/me/context");
  if (context?.setup_required) {
    state.context = null;
    setSessionBadge("Account setup required");
    setUserUidBadge("");
    el.logoutBtns.forEach((b) => {
      b.disabled = false;
    });
    openAccountSetupForCurrentUser();
    if (el.signupName && context.full_name) el.signupName.value = context.full_name;
    if (el.signupEmail && context.email) el.signupEmail.value = context.email;
    return null;
  }
  state.context = context;
  setSessionBadge(`${context.full_name} (${context.role})`);
  setUserUidBadge(context.public_uid || "");
  el.logoutBtns.forEach((b) => {
    b.disabled = false;
  });

  if (context.role === "admin") {
    showView("admin");
    activateAdminSubView("home");
    await Promise.all([
      refreshAnalytics(),
      refreshAdminProctorSessions(),
      refreshAdminTrainingReviews(),
      refreshModerationData(),
      refreshApprovals(),
      refreshBilling(),
      refreshAdminBadges(),
    ]);
    state.adminPollingId = setInterval(async () => {
      try {
        await Promise.all([
          refreshModerationData(),
          refreshApprovals(),
          refreshAdminBadges(),
          refreshAdminProctorSessions(),
          refreshAdminTrainingReviews(),
        ]);
      } catch (err) {
        log("admin_poll_error", String(err));
      }
    }, 10000);
    return;
  }

  if (context.role === "provider") {
    if (context.approval_status !== "approved") {
      showView("non-admin");
      renderNonAdminRoleFix(context);
      const waitingText = context.approval_status === "pending"
        ? "Your provider profile is pending admin approval. You will get access after approval."
        : `Your provider profile is invalid (${context.rejection_reason || "rejected"}). Please contact support/admin.`;
      if (el.nonAdminText) el.nonAdminText.textContent = waitingText;
      return;
    }
    showView("provider");
    activateProviderSubView("home");
    await Promise.all([refreshProviderHome(), refreshProviderAssessments(), refreshProviderFeedback(), refreshProviderNotifications(), refreshProviderCertifications()]);
    await refreshProviderContent();
    await refreshProviderDrafts();
    return;
  }

  if (context.role === "student") {
    if (context.approval_status !== "approved") {
      showView("non-admin");
      renderNonAdminRoleFix(context);
      const waitingText = context.approval_status === "pending"
        ? "Your student profile is pending admin approval. You will get access after approval."
        : `Your student profile is invalid (${context.rejection_reason || "rejected"}). Please contact support/admin.`;
      if (el.nonAdminText) el.nonAdminText.textContent = waitingText;
      return;
    }
    showView("student");
    activateStudentSubView("home");
    await refreshStudentDashboard();
    return;
  }

  showView("non-admin");
  renderNonAdminRoleFix(context);
  const statusText = context.approval_status === "approved"
    ? "Approved"
    : context.approval_status === "pending"
      ? "Pending approval"
      : `Invalid profile (${context.rejection_reason || "rejected"})`;
  if (el.nonAdminText) el.nonAdminText.textContent = `Logged in as ${context.role}. Status: ${statusText}.`;
}

async function initFirebase() {
  setAuthActionState(false);
  const cfg = await api("GET", "/config/firebase", null, false);
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
  await setPersistence(state.auth, browserLocalPersistence);
  setAuthActionState(true);
  onAuthStateChanged(state.auth, async (user) => {
    state.context = null;
    if (state.authRoleSetupInFlight) return;
    if (state.authLoginFallbackTimer) {
      clearTimeout(state.authLoginFallbackTimer);
      state.authLoginFallbackTimer = null;
    }
    if (!user) {
      state.authLoginInFlight = false;
      setSessionBadge("Not signed in");
      setUserUidBadge("");
      el.logoutBtns.forEach((b) => {
        b.disabled = true;
      });
      showView("auth");
      showAuthMode("login");
      return;
    }
    try {
      const context = await loadSessionContext();
      if (state.authLoginInFlight && context) toast("Login successful");
      if (state.authLoginInFlight && !context) toast("Complete account setup by choosing Student or Provider.", "error");
      state.authLoginInFlight = false;
      if (!context) return;
    } catch (err) {
      state.authLoginInFlight = false;
      log("session_error", String(err));
      if (isRoleRegistrationRequiredError(err)) {
        openAccountSetupForCurrentUser();
        toast("Complete account setup by choosing Student or Provider.", "error");
        return;
      }
      toast(formatAuthError(err, "Session load failed"), "error");
      showView("auth");
      showAuthMode("login");
    }
  });
}

function handleKeyboardShortcuts(event) {
  if (!el.assessmentPreviewScreen?.classList.contains("hidden")) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      $("apPrevBtn")?.click();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const submitVisible = !$("apSubmitBtn")?.classList.contains("hidden");
      if (submitVisible) $("apSubmitBtn")?.click();
      else $("apNextBtn")?.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      confirmQuitAssessment();
      return;
    }
  }
  const tag = event.target?.tagName?.toLowerCase();
  if (["input", "textarea", "select"].includes(tag)) return;
  if (!state.context) return;
  if (state.context.role === "admin") {
    if (event.key === "1") activateAdminSubView("home");
    if (event.key === "2") activateAdminSubView("reports");
    if (event.key === "3") activateAdminSubView("approvals");
    if (event.key === "4") activateAdminSubView("billing");
  }
  if (state.context.role === "provider") {
    if (event.key === "1") activateProviderSubView("home");
    if (event.key === "2") activateProviderSubView("courses");
    if (event.key === "3") activateProviderSubView("assessments");
    if (event.key === "4") activateProviderSubView("feedback");
    if (event.key === "5") activateProviderSubView("live");
    if (event.key === "6") activateProviderSubView("certifications");
  }
  if (state.context.role === "student") {
    if (event.key === "1") activateStudentSubView("home");
    if (event.key === "2") activateStudentSubView("available");
    if (event.key === "3") activateStudentSubView("enrolled");
  }
}

function bindEvents() {
  el.showSignupBtn?.addEventListener("click", () => showAuthMode("signup"));
  el.showLoginBtn?.addEventListener("click", () => showAuthMode("login"));

  $("loginBtn")?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    const email = el.loginEmail.value.trim().toLowerCase();
    const rawPassword = el.loginPassword.value;
    const trimmedPassword = rawPassword.trim();
    try {
      state.authLoginInFlight = true;
      try {
        await signInWithEmailAndPassword(state.auth, email, rawPassword);
      } catch (primaryErr) {
        // Common operator mistake: copied password with leading/trailing spaces.
        if (
          String(primaryErr?.code || "").includes("auth/invalid-credential")
          && rawPassword !== trimmedPassword
        ) {
          await signInWithEmailAndPassword(state.auth, email, trimmedPassword);
          toast("Removed leading/trailing spaces from password input.");
        } else {
          throw primaryErr;
        }
      }
      if (state.authLoginFallbackTimer) clearTimeout(state.authLoginFallbackTimer);
      state.authLoginFallbackTimer = setTimeout(async () => {
        if (!state.authLoginInFlight || !state.auth?.currentUser) return;
        try {
          const context = await loadSessionContext();
          if (context) toast("Login successful");
        } catch (err) {
          toast(formatAuthError(err, "Session load failed"), "error");
        } finally {
          state.authLoginInFlight = false;
        }
      }, 1200);
    } catch (err) {
      state.authLoginInFlight = false;
      toast(formatAuthError(err, "Login failed"), "error");
      log("login_error", String(err));
    }
  });

  $("googleBtn")?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    try {
      state.authLoginInFlight = true;
      const provider = new GoogleAuthProvider();
      await signInWithPopup(state.auth, provider);
      if (state.authLoginFallbackTimer) clearTimeout(state.authLoginFallbackTimer);
      state.authLoginFallbackTimer = setTimeout(async () => {
        if (!state.authLoginInFlight || !state.auth?.currentUser) return;
        try {
          const context = await loadSessionContext();
          if (context) toast("Login successful");
        } catch (err) {
          toast(formatAuthError(err, "Session load failed"), "error");
        } finally {
          state.authLoginInFlight = false;
        }
      }, 1200);
    } catch (err) {
      state.authLoginInFlight = false;
      toast(formatAuthError(err, "Google login failed"), "error");
      log("google_error", String(err));
    }
  });

  $("signupBtn")?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    try {
      const name = el.signupName.value.trim();
      const email = el.signupEmail.value.trim().toLowerCase();
      const password = el.signupPassword.value.trim();
      const role = el.signupRole.value;
      if (!name || !email || !password) throw new Error("Name, email, and password are required.");
      state.authRoleSetupInFlight = true;
      let cred = null;
      try {
        cred = await createUserWithEmailAndPassword(state.auth, email, password);
      } catch (firebaseErr) {
        if (String(firebaseErr?.code || "").includes("auth/email-already-in-use")) {
          // Existing Firebase auth user: continue setup if password is valid.
          try {
            cred = await signInWithEmailAndPassword(state.auth, email, password);
          } catch (signInErr) {
            if (String(signInErr?.code || "").includes("auth/invalid-credential")) {
              throw new Error(
                "This email is already registered with a different password. Use Login (or reset password) instead of Signup.",
              );
            }
            throw signInErr;
          }
        } else {
          throw firebaseErr;
        }
      }
      await updateProfile(cred.user, { displayName: name });
      let roleSetupDone = false;
      let lastRoleErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await api("POST", "/auth/register-role", { full_name: name, role });
          roleSetupDone = true;
          break;
        } catch (roleErr) {
          lastRoleErr = roleErr;
          await cred.user.getIdToken(true).catch(() => {});
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      if (!roleSetupDone && lastRoleErr) throw lastRoleErr;
      await cred.user.getIdToken(true).catch(() => {});
      state.authRoleSetupInFlight = false;
      await loadSessionContext();
      toast("Account created");
    } catch (err) {
      state.authRoleSetupInFlight = false;
      const requestedEmail = String(el.signupEmail?.value || "").trim().toLowerCase();
      const currentEmail = String(state.auth?.currentUser?.email || "").trim().toLowerCase();
      if (requestedEmail && currentEmail && currentEmail === requestedEmail) {
        try {
          await loadSessionContext();
          toast("Account created");
          return;
        } catch {}
      }
      toast(formatAuthError(err, "Signup failed"), "error");
      log("signup_error", String(err));
    }
  });

  el.logoutBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        stopAdminPolling();
        await signOut(state.auth);
        showView("auth");
        showAuthMode("login");
        setSessionBadge("Not signed in");
        setUserUidBadge("");
        el.logoutBtns.forEach((b) => {
          b.disabled = true;
        });
        toast("Logged out");
      } catch (err) {
        toast("Logout failed", "error");
      }
    });
  });

  $("nonAdminBackToLoginBtn")?.addEventListener("click", async () => {
    try {
      if (state.auth?.currentUser) await signOut(state.auth);
    } catch {}
    showView("auth");
    showAuthMode("login");
    setSessionBadge("Not signed in");
    setUserUidBadge("");
    el.logoutBtns.forEach((b) => {
      b.disabled = true;
    });
  });

  el.nonAdminUpdateRoleBtn?.addEventListener("click", async () => {
    try {
      if (!ensureAuthReady()) return;
      const nextRole = el.nonAdminRoleSelect?.value || "student";
      const fullName = state.auth?.currentUser?.displayName || state.context?.full_name || "User";
      await api("POST", "/auth/register-role", { full_name: fullName, role: nextRole });
      await state.auth?.currentUser?.getIdToken(true).catch(() => {});
      toast("Account type updated");
      await loadSessionContext();
    } catch (err) {
      toast(err?.message || "Failed to update account type", "error");
    }
  });

  el.settingsToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const menu = toggle.nextElementSibling;
      if (!(menu instanceof HTMLElement)) return;
      const willOpen = menu.classList.contains("hidden");
      el.settingsMenus.forEach((m) => m.classList.add("hidden"));
      if (willOpen) menu.classList.remove("hidden");
    });
  });
  el.collapseWorkspaceBtns.forEach((btn) => {
    btn.addEventListener("click", () => toggleWorkspaceCollapse());
  });
  el.workspaceExpandFab?.addEventListener("click", () => {
    if (!document.body.classList.contains("workspace-collapsed")) return;
    applyWorkspaceCollapse(false);
    try {
      localStorage.setItem("certora_workspace_collapsed", "0");
    } catch {}
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const insideAnySettings = el.settingsToggles.some((t) => t.contains(target))
      || el.settingsMenus.some((m) => m.contains(target));
    if (!insideAnySettings) {
      el.settingsMenus.forEach((m) => m.classList.add("hidden"));
    }
  });

  document.querySelectorAll(".nav-btn:not(.provider-nav-btn)").forEach((btn) => {
    btn.addEventListener("click", () => activateAdminSubView(btn.dataset.view));
  });

  document.querySelectorAll(".provider-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => activateProviderSubView(btn.dataset.providerView));
  });
  document.querySelectorAll(".student-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => activateStudentSubView(btn.dataset.studentView));
  });

  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-tab").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      state.moderationMode = btn.dataset.mode;
      renderModerationPanel();
    });
  });

  document.querySelectorAll(".approval-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.approvalsTab = btn.dataset.approvalTab;
      renderApprovalsTab();
    });
  });

  el.moderationSearch?.addEventListener("input", () => renderModerationPanel());
  el.moderationStatusFilter?.addEventListener("change", () => renderModerationPanel());

  const downloadFile = async (url, filename) => {
    const res = await fetch(url, { headers: await getHeaders(true) });
    if (!res.ok) throw new Error(`Failed to export ${filename}`);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  };

  $("exportReportsBtn")?.addEventListener("click", async () => {
    try { await downloadFile("/admin/reports/export.csv", "reports.csv"); toast("Reports CSV exported"); } catch { toast("Export failed", "error"); }
  });
  $("exportComplaintsBtn")?.addEventListener("click", async () => {
    try { await downloadFile("/admin/complaints/export.csv", "complaints.csv"); toast("Compliants CSV exported"); } catch { toast("Export failed", "error"); }
  });
  $("exportApprovalsBtn")?.addEventListener("click", async () => {
    try { await downloadFile("/admin/approvals/export.csv", "pending_approvals.csv"); toast("Approvals CSV exported"); } catch { toast("Export failed", "error"); }
  });

  $("openCourseWizardBtn")?.addEventListener("click", () => {
    el.courseWizard?.classList.remove("hidden");
    el.providerDraftsPage?.classList.add("hidden");
    resetCourseWizard();
  });
  $("openDraftsPageBtn")?.addEventListener("click", async () => {
    try {
      await refreshProviderDrafts();
      $("providerCoursesHeader")?.classList.add("hidden");
      $("providerCoursesList")?.classList.add("hidden");
      $("courseWizard")?.classList.add("hidden");
      el.providerCourseViewer?.classList.add("hidden");
      el.providerDraftsPage?.classList.remove("hidden");
    } catch {
      toast("Failed to open drafts", "error");
    }
  });
  $("closeDraftsPageBtn")?.addEventListener("click", () => {
    el.providerDraftsPage?.classList.add("hidden");
    $("providerCoursesHeader")?.classList.remove("hidden");
    $("providerCoursesList")?.classList.remove("hidden");
  });
  $("refreshDraftsBtn")?.addEventListener("click", () => refreshProviderDrafts().catch(() => toast("Failed to refresh drafts", "error")));
  $("closeCourseWizardBtn")?.addEventListener("click", () => {
    el.courseWizard?.classList.add("hidden");
  });
  $("cwSaveDraftBtn")?.addEventListener("click", async () => {
    try {
      const out = await saveDraftFromWizard();
      toast(`Draft saved (#${out.draft_id})`);
      await refreshProviderDrafts();
    } catch {
      toast("Failed to save draft", "error");
    }
  });
  $("cwSaveDraftBtn2")?.addEventListener("click", async () => {
    try {
      const out = await saveDraftFromWizard();
      toast(`Draft saved (#${out.draft_id})`);
      await refreshProviderDrafts();
    } catch {
      toast("Failed to save draft", "error");
    }
  });
  $("cwUploadVideoBtn")?.addEventListener("click", async () => {
    const file = $("cwVideoFile")?.files?.[0];
    if (!file) return toast("Choose a local video file first", "error");
    try {
      await uploadLocalVideoInChunks(file);
      toast("Video uploaded");
    } catch {
      toast("Video upload failed", "error");
    }
  });
  $("cwThumbnailFile")?.addEventListener("change", async () => {
    const file = $("cwThumbnailFile")?.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setThumbnailValue(String(dataUrl));
      toast("Thumbnail selected");
    } catch {
      toast("Failed to load thumbnail image", "error");
    }
  });
  $("cwUseCurrentFrameBtn")?.addEventListener("click", async () => {
    const preview = $("cwVideoPreview");
    const videoUrl = $("cwVideoUrl")?.value?.trim();
    if (!videoUrl) return toast("Video URL required first", "error");
    let frame = "";
    if (preview && preview.getAttribute("src")) {
      frame = captureFrameFromVideoElement(preview);
    }
    if (!frame) {
      const seconds = Math.floor(preview?.currentTime || 0);
      frame = await captureThumbnailAt(videoUrl, seconds);
    }
    if (!frame) return toast("Could not capture frame from video", "error");
    setThumbnailValue(frame);
    toast("Thumbnail captured from video");
  });
  $("cwCourseThumbnail")?.addEventListener("input", () => refreshThumbnailPreview());
  $("cwNextToVideoBtn")?.addEventListener("click", () => {
    const title = $("cwCourseTitle")?.value?.trim();
    if (!title) return toast("Course name is required", "error");
    setCourseWizardStep("video");
  });
  $("cwBackToDetailsBtn")?.addEventListener("click", () => setCourseWizardStep("details"));
  $("cwNextToTopicsBtn")?.addEventListener("click", () => {
    const videoUrl = $("cwVideoUrl")?.value?.trim();
    if (!videoUrl) return toast("Video URL is required", "error");
    setCourseWizardStep("topics");
  });
  $("cwBackToVideoBtn")?.addEventListener("click", () => setCourseWizardStep("video"));
  $("cwLoadVideoPreviewBtn")?.addEventListener("click", () => {
    ensureCourseVideoPreview();
    updateVideoTimeMeta();
    renderDraftTopics();
  });
  $("cwUseCurrentTimeBtn")?.addEventListener("click", () => {
    const video = $("cwVideoPreview");
    const input = $("cwTopicTime");
    if (!video || !input) return;
    input.value = formatSecondsToClock(Math.floor(video.currentTime || 0));
  });
  $("cwVideoPreview")?.addEventListener("timeupdate", () => updateVideoTimeMeta());
  $("cwVideoPreview")?.addEventListener("loadedmetadata", () => {
    updateVideoTimeMeta();
    renderDraftTopics();
  });
  $("cwAddTopicBtn")?.addEventListener("click", async () => {
    const title = $("cwTopicTitle")?.value?.trim();
    const timeRaw = $("cwTopicTime")?.value?.trim();
    const seconds = parseTimeToSeconds(timeRaw);
    if (!title) return toast("Topic name is required", "error");
    if (Number.isNaN(seconds)) return toast("Invalid topic time. Use mm:ss or hh:mm:ss", "error");
    const videoUrl = $("cwVideoUrl")?.value?.trim();
    const thumb = videoUrl ? await captureThumbnailAt(videoUrl, seconds) : "";
    state.draftTopics.push({ title, time_seconds: seconds, thumbnail_data_url: thumb });
    $("cwTopicTitle").value = "";
    $("cwTopicTime").value = "";
    renderDraftTopics();
  });
  $("pcvCloseBtn")?.addEventListener("click", () => {
    el.providerCourseViewer?.classList.add("hidden");
    $("providerCoursesHeader")?.classList.remove("hidden");
    $("providerCoursesList")?.classList.remove("hidden");
    $("providerDraftsPage")?.classList.add("hidden");
  });
  $("pcvVideo")?.addEventListener("timeupdate", () => updateViewerTimeMeta());
  $("pcvVideo")?.addEventListener("loadedmetadata", () => updateViewerTimeMeta());
  $("scvVideo")?.addEventListener("timeupdate", () => {
    updateStudentViewerTimeMeta();
    maybeUnlockAssessmentFromPlayback().catch(() => {});
  });
  $("scvVideo")?.addEventListener("loadedmetadata", () => updateStudentViewerTimeMeta());
  $("scvCloseBtn")?.addEventListener("click", () => {
    el.studentCourseViewer?.classList.add("hidden");
  });

  bindCustomPlayerControls({
    videoId: "cwVideoPreview",
    shellId: "cwVideoShell",
    playBtnId: "cwPlayBtn",
    back10BtnId: "cwBack10Btn",
    fwd10BtnId: "cwFwd10Btn",
    scrubberId: "cwScrubber",
    hoverPreviewId: "cwHoverPreview",
    hoverTimeId: "cwHoverTime",
    speedId: "cwSpeed",
    volumeId: "cwVolume",
    fullscreenBtnId: "cwFullscreenBtn",
    topicsGetter: () => state.draftTopics || [],
    updateTimeFn: updateVideoTimeMeta,
  });
  bindCustomPlayerControls({
    videoId: "pcvVideo",
    shellId: "pcvVideoShell",
    playBtnId: "pcvPlayBtn",
    back10BtnId: "pcvBack10Btn",
    fwd10BtnId: "pcvFwd10Btn",
    scrubberId: "pcvScrubber",
    hoverPreviewId: "pcvHoverPreview",
    hoverTimeId: "pcvHoverTime",
    speedId: "pcvSpeed",
    volumeId: "pcvVolume",
    fullscreenBtnId: "pcvFullscreenBtn",
    topicsGetter: () => state.viewerTopics || [],
    updateTimeFn: updateViewerTimeMeta,
  });
  bindCustomPlayerControls({
    videoId: "scvVideo",
    shellId: "scvVideoShell",
    playBtnId: "scvPlayBtn",
    back10BtnId: "scvBack10Btn",
    fwd10BtnId: "scvFwd10Btn",
    scrubberId: "scvScrubber",
    hoverPreviewId: "scvHoverPreview",
    hoverTimeId: "scvHoverTime",
    speedId: "scvSpeed",
    volumeId: "scvVolume",
    fullscreenBtnId: "scvFullscreenBtn",
    topicsGetter: () => state.studentViewerTopics || [],
    updateTimeFn: updateStudentViewerTimeMeta,
  });
  $("cwCreateCourseBtn")?.addEventListener("click", async () => {
    try {
      const out = await createCourseFromWizard();
      toast(`Course created (ID ${out.courseId})`);
      el.courseWizard?.classList.add("hidden");
      await refreshProviderHome();
      await refreshProviderContent();
      await refreshProviderDrafts();
    } catch {
      toast("Failed to create course", "error");
    }
  });

  $("openAssessmentBuilderBtn")?.addEventListener("click", async () => {
    await Promise.all([refreshProviderContent(), loadProviderDraftsRaw()]);
    openAssessmentBuilder();
  });
  $("refreshProctorSessionsBtn")?.addEventListener("click", () => refreshAdminProctorSessions().catch(() => toast("Failed to refresh proctor sessions", "error")));
  $("refreshTrainingReviewsBtn")?.addEventListener("click", () =>
    refreshAdminTrainingReviews().catch(() => toast("Failed to refresh training reviews", "error")),
  );
  $("assessmentBuilderCloseBtn")?.addEventListener("click", () => closeAssessmentBuilder());
  $("assessmentPreviewCloseBtn")?.addEventListener("click", () => confirmQuitAssessment());
  $("apRerunChecksBtn")?.addEventListener("click", () => runProctoringPrecheck().catch(() => toast("Failed to run proctor checks", "error")));
  $("apStartTestBtn")?.addEventListener("click", () => startAssessmentAfterPrecheck());
  $("apPrevBtn")?.addEventListener("click", () => {
    (async () => {
      readCurrentPreviewAnswer();
      if (state.assessmentPreview.mode === "student_attempt") await persistCurrentStudentAttemptAnswer();
      finalizeGazeQuestionForNavigation(state.assessmentPreview, false);
      state.assessmentPreview.index = Math.max(0, state.assessmentPreview.index - 1);
      renderAssessmentPreviewQuestion();
    })().catch(() => {});
  });
  $("apNextBtn")?.addEventListener("click", () => {
    (async () => {
      readCurrentPreviewAnswer();
      if (state.assessmentPreview.mode === "student_attempt") await persistCurrentStudentAttemptAnswer();
      finalizeGazeQuestionForNavigation(state.assessmentPreview, true);
      state.assessmentPreview.index = Math.min(state.assessmentPreview.questions.length - 1, state.assessmentPreview.index + 1);
      renderAssessmentPreviewQuestion();
    })().catch(() => {});
  });
  $("apSubmitBtn")?.addEventListener("click", () => {
    (async () => {
      readCurrentPreviewAnswer();
      if (state.assessmentPreview.mode === "student_attempt") await persistCurrentStudentAttemptAnswer();
      finalizeGazeQuestionForNavigation(state.assessmentPreview, true);
      showAssessmentPreviewResult();
    })().catch(() => {});
  });
  $("apTrainingPassBtn")?.addEventListener("click", () => {
    setTrainingFeedbackChoice("correct");
    if (el.apTrainingFeedbackStatus) {
      el.apTrainingFeedbackStatus.textContent = "Selected: Pass (model correct)";
    }
  });
  $("apTrainingFailBtn")?.addEventListener("click", () => {
    setTrainingFeedbackChoice("incorrect");
    if (el.apTrainingFeedbackStatus) {
      el.apTrainingFeedbackStatus.textContent = "Selected: Fail (model wrong)";
    }
  });
  $("apTrainingSaveBtn")?.addEventListener("click", () => {
    saveTrainingFeedback().catch((err) => toast(err?.message || "Failed to save training review", "error"));
  });
  $("apEnvironmentAttest")?.addEventListener("change", (event) => {
    state.assessmentPreview.proctor.environmentAttested = Boolean(event.target?.checked);
    updateAssessmentStartEligibility();
  });
  $("proctorWarningAcknowledgeBtn")?.addEventListener("click", () => {
    closeProctorWarningModal();
  });
  $("abCourseFilter")?.addEventListener("change", () => renderAssessmentCourseOptions());
  $("abCourseSelect")?.addEventListener("change", () => updateAssessmentSourceMeta());
  $("abTimingMode")?.addEventListener("change", () => applyAssessmentTimingMode());
  $("abQuestionsPerAttempt")?.addEventListener("input", () => renderAssessmentPool());
  document.querySelectorAll("[data-ab-correct]").forEach((node) => {
    node.addEventListener("change", () => {
      if (($("abQuestionType")?.value || "mcq_single_correct") !== "mcq_single_correct") return;
      if (!node.checked) return;
      document.querySelectorAll("[data-ab-correct]").forEach((other) => {
        if (other !== node) other.checked = false;
      });
    });
  });
  $("abQuestionType")?.addEventListener("change", () => {
    if (($("abQuestionType")?.value || "mcq_single_correct") !== "mcq_single_correct") return;
    let seen = false;
    document.querySelectorAll("[data-ab-correct]").forEach((n) => {
      if (n.checked && !seen) {
        seen = true;
      } else if (n.checked && seen) {
        n.checked = false;
      }
    });
  });
  $("abAddQuestionBtn")?.addEventListener("click", () => {
    try {
      const q = buildQuestionFromAssessmentForm();
      state.assessmentDraftQuestions.push(q);
      $("abQuestionText").value = "";
      $("abQuestionNegativeMarks").value = "0";
      ["abOption1", "abOption2", "abOption3", "abOption4"].forEach((id) => {
        if ($(id)) $(id).value = "";
      });
      document.querySelectorAll("[data-ab-correct]").forEach((n) => {
        n.checked = false;
      });
      renderAssessmentPool();
      toast("Question added to pool");
    } catch (err) {
      toast(err?.message || "Invalid question", "error");
    }
  });
  $("abSaveDraftBtn")?.addEventListener("click", async () => {
    try {
      await createAssessmentFromBuilder(false);
      toast("Assessment draft saved");
      closeAssessmentBuilder();
      await Promise.all([refreshProviderHome(), refreshProviderAssessments()]);
    } catch (err) {
      toast(err?.message || "Failed to save assessment draft", "error");
    }
  });
  $("abPublishBtn")?.addEventListener("click", async () => {
    try {
      await createAssessmentFromBuilder(true);
      toast("Assessment published");
      closeAssessmentBuilder();
      await Promise.all([refreshProviderHome(), refreshProviderAssessments()]);
    } catch (err) {
      toast(err?.message || "Failed to publish assessment", "error");
    }
  });

  $("refreshProviderCoursesBtn")?.addEventListener("click", () => refreshProviderContent().catch(() => toast("Failed to refresh courses", "error")));
  $("refreshStudentDashboardBtn")?.addEventListener("click", () => refreshStudentDashboard().catch(() => toast("Failed to refresh dashboard", "error")));
  $("refreshProviderAssessmentsBtn")?.addEventListener("click", () => refreshProviderAssessments().catch(() => toast("Failed to refresh assessments", "error")));
  $("refreshProviderCommentsBtn")?.addEventListener("click", () => refreshProviderFeedback().catch(() => toast("Failed to refresh feedback", "error")));
  $("refreshProviderNotificationsBtn")?.addEventListener("click", () => refreshProviderNotifications().catch(() => toast("Failed to refresh notifications", "error")));
  $("refreshProviderCertsBtn")?.addEventListener("click", () => refreshProviderCertifications().catch(() => toast("Failed to refresh certifications", "error")));
  $("completeLiveClassBtn")?.addEventListener("click", () => completeLiveClassAction().catch(() => toast("Failed to complete live class", "error")));

  document.addEventListener("keydown", handleKeyboardShortcuts);
}

(async function boot() {
  try {
    applyWorkspaceCollapse(localStorage.getItem("certora_workspace_collapsed") === "1");
  } catch {
    applyWorkspaceCollapse(false);
  }
  bindEvents();
  showAuthMode("login");
  showView("auth");
  try {
    await initFirebase();
  } catch (err) {
    setAuthActionState(false);
    toast(formatAuthError(err, "Authentication setup failed"), "error");
    log("firebase_init_error", String(err));
  }
  log("ready", { message: "Admin + provider workspace loaded." });
})();
