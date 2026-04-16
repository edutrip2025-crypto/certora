import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  EmailAuthProvider,
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  setPersistence,
  updatePassword,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const state = {
  auth: null,
  context: null,
  authLoginInFlight: false,
  authLoginFallbackTimer: null,
  authProgressTimer: null,
  authProgressVisible: false,
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
  providerLiveSessions: [],
  providerLiveEditSessionId: null,
  studentLiveSessions: [],
  studentLiveReminderTimers: {},
  studentLiveReminderSent: {},
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
  liveRoom: {
    active: false,
    sessionId: null,
    role: null,
    lastMessageId: 0,
    pollerId: null,
    classTimerId: null,
    classTimerStartedAt: 0,
    ws: null,
    wsConnected: false,
    wsPingId: null,
    wsReconnectId: null,
    participantMap: {},
    moderation: null,
    selectedParticipantId: 0,
    accessStatus: "admitted",
    hostMuted: false,
    stagePeerId: "",
    focusPeerId: "",
    speakerMonitorId: null,
    speakerScores: {},
    peerAudioContexts: {},
    toolsOpen: false,
    chatOpen: false,
    reactionOpen: false,
    participantsOpen: false,
    sidePanel: "",
    sharedPanel: "",
    qaItems: [],
    boardServerText: "",
    boardDraftDirty: false,
    controlDockIdleTimer: null,
    controlDockPointerInside: false,
    controlDockVisible: true,
    reactionBurstRecent: {},
    screenShareInFlight: false,
    recording: {
      mediaRecorder: null,
      chunks: [],
      mimeType: "video/webm",
      active: false,
      uploadInFlight: false,
    },
    rtc: {
      peers: {},
      remoteStreams: {},
      signalSeenIds: {},
      signalSeenKeys: {},
      localStream: null,
      cameraStream: null,
      screenStream: null,
      outboundVideoTrack: null,
      micMuted: false,
    },
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
      if (parsed?.status === 403 || parsed?.status === 503) {
        return String(parsed?.data?.detail || `${fallback}.`);
      }
    } catch {}
  }
  if (code === "auth/invalid-credential") {
    return "Invalid email/password. Use Forgot Password to reset this account.";
  }
  if (code === "auth/wrong-password") {
    return "Current password is incorrect.";
  }
  if (code === "auth/weak-password") {
    return "New password is too weak. Use at least 8 characters.";
  }
  if (code === "auth/requires-recent-login") {
    return "Session is old. Login again and retry password change.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Wait a bit and try again.";
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
  changePasswordBtns: Array.from(document.querySelectorAll(".js-change-password-btn")),
  adminRecoveryBtns: Array.from(document.querySelectorAll(".js-admin-recovery-btn")),
  adminPasswordBtns: Array.from(document.querySelectorAll(".js-admin-password-btn")),
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
  adminProctorOverview: $("adminProctorOverview"),
  adminProctorSessionsList: $("adminProctorSessionsList"),
  adminTrainingOverview: $("adminTrainingOverview"),
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
  forgotPasswordBtn: $("forgotPasswordBtn"),
  signupBtn: $("signupBtn"),
  providerHomeStats: $("providerHomeStats"),
  studentStats: $("studentStats"),
  studentCertificatesList: $("studentCertificatesList"),
  studentCertificatesTabList: $("studentCertificatesTabList"),
  studentAvailableCourses: $("studentAvailableCourses"),
  studentEnrolledCourses: $("studentEnrolledCourses"),
  studentLiveClassesList: $("studentLiveClassesList"),
  studentCourseViewer: $("studentCourseViewer"),
  scvTitle: $("scvTitle"),
  scvMeta: $("scvMeta"),
  scvTopicList: $("scvTopicList"),
  scvLiveClassList: $("scvLiveClassList"),
  scvResourceList: $("scvResourceList"),
  scvProgressBar: $("scvProgressBar"),
  scvProgressText: $("scvProgressText"),
  scvCourseRatingSummary: $("scvCourseRatingSummary"),
  scvRateValue: $("scvRateValue"),
  scvRateContent: $("scvRateContent"),
  scvRateClarity: $("scvRateClarity"),
  scvRatePractical: $("scvRatePractical"),
  scvRatingComment: $("scvRatingComment"),
  scvSaveRatingBtn: $("scvSaveRatingBtn"),
  scvRatingStatus: $("scvRatingStatus"),
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
  openLiveClassSchedulerBtn: $("openLiveClassSchedulerBtn"),
  closeLiveClassSchedulerBtn: $("closeLiveClassSchedulerBtn"),
  cancelLiveClassSchedulerBtn: $("cancelLiveClassSchedulerBtn"),
  providerLiveCreateScreen: $("providerLiveCreateScreen"),
  providerLiveStats: $("providerLiveStats"),
  refreshProviderLiveClassesBtn: $("refreshProviderLiveClassesBtn"),
  providerLiveClassSessionsList: $("providerLiveClassSessionsList"),
  createLiveClassBtn: $("createLiveClassBtn"),
  liveClassTitle: $("liveClassTitle"),
  liveClassDescription: $("liveClassDescription"),
  liveClassTimezone: $("liveClassTimezone"),
  liveClassStartAt: $("liveClassStartAt"),
  liveClassEndAt: $("liveClassEndAt"),
  liveClassRecurrencePattern: $("liveClassRecurrencePattern"),
  liveClassRecurrenceCount: $("liveClassRecurrenceCount"),
  liveClassCustomDaysRow: $("liveClassCustomDaysRow"),
  liveClassMode: $("liveClassMode"),
  liveClassExternalUrl: $("liveClassExternalUrl"),
  liveClassMaxParticipants: $("liveClassMaxParticipants"),
  liveClassAllowChat: $("liveClassAllowChat"),
  liveClassAllowRaiseHand: $("liveClassAllowRaiseHand"),
  liveClassAllowReactions: $("liveClassAllowReactions"),
  liveClassGenerateAgendaBtn: $("liveClassGenerateAgendaBtn"),
  liveClassGeneratePollBtn: $("liveClassGeneratePollBtn"),
  liveClassGenerateSummaryBtn: $("liveClassGenerateSummaryBtn"),
  liveClassAiOutput: $("liveClassAiOutput"),
  liveClassAppendAiBtn: $("liveClassAppendAiBtn"),
  liveClassReplaceAiBtn: $("liveClassReplaceAiBtn"),
  refreshStudentLiveClassesBtn: $("refreshStudentLiveClassesBtn"),
  liveClassroomScreen: $("liveClassroomScreen"),
  liveRoomTitle: $("liveRoomTitle"),
  liveRoomMeta: $("liveRoomMeta"),
  liveRoomPresenceBadge: $("liveRoomPresenceBadge"),
  liveRoomSignalStatus: $("liveRoomSignalStatus"),
  liveRoomStageShell: $("liveRoomStageShell"),
  liveRoomControlDock: $("liveRoomControlDock"),
  liveRoomStageVideo: $("liveRoomStageVideo"),
  liveRoomStagePlaceholder: $("liveRoomStagePlaceholder"),
  liveRoomFocusTile: $("liveRoomFocusTile"),
  liveRoomFocusVideo: $("liveRoomFocusVideo"),
  liveRoomFocusLabel: $("liveRoomFocusLabel"),
  liveRoomToggleToolsBtn: $("liveRoomToggleToolsBtn"),
  liveRoomToggleChatBtn: $("liveRoomToggleChatBtn"),
  liveRoomReactBtn: $("liveRoomReactBtn"),
  liveRoomReactionMenu: $("liveRoomReactionMenu"),
  liveRoomReactionBurstLayer: $("liveRoomReactionBurstLayer"),
  liveRoomFullscreenBtn: $("liveRoomFullscreenBtn"),
  liveRoomToolsPanel: $("liveRoomToolsPanel"),
  liveRoomChatPanel: $("liveRoomChatPanel"),
  liveRoomWaitingOverlay: $("liveRoomWaitingOverlay"),
  liveRoomWaitingText: $("liveRoomWaitingText"),
  liveRoomVideoStartBtn: $("liveRoomVideoStartBtn"),
  liveRoomVideoStopBtn: $("liveRoomVideoStopBtn"),
  liveRoomToggleMicBtn: $("liveRoomToggleMicBtn"),
  liveRoomShareScreenBtn: $("liveRoomShareScreenBtn"),
  liveRoomStopShareOverlayBtn: $("liveRoomStopShareOverlayBtn"),
  liveRoomParticipantsBtn: $("liveRoomParticipantsBtn"),
  liveRoomParticipantsMenu: $("liveRoomParticipantsMenu"),
  liveRoomParticipantsCountBadge: $("liveRoomParticipantsCountBadge"),
  liveRoomParticipantsCountText: $("liveRoomParticipantsCountText"),
  liveRoomStopShareBtn: $("liveRoomStopShareBtn"),
  liveRoomStartRecordingBtn: $("liveRoomStartRecordingBtn"),
  liveRoomPauseRecordingBtn: $("liveRoomPauseRecordingBtn"),
  liveRoomStopRecordingBtn: $("liveRoomStopRecordingBtn"),
  liveRoomRecordingBadge: $("liveRoomRecordingBadge"),
  liveRoomLocalVideo: $("liveRoomLocalVideo"),
  liveRoomRemoteVideoGrid: $("liveRoomRemoteVideoGrid"),
  leaveLiveRoomBtn: $("leaveLiveRoomBtn"),
  liveRoomBoardText: $("liveRoomBoardText"),
  liveRoomSaveBoardBtn: $("liveRoomSaveBoardBtn"),
  liveRoomRaiseHandBtn: $("liveRoomRaiseHandBtn"),
  liveRoomPickStudentBtn: $("liveRoomPickStudentBtn"),
  liveRoomExportAttendanceBtn: $("liveRoomExportAttendanceBtn"),
  liveRoomTimerText: $("liveRoomTimerText"),
  liveRoomStartTimerBtn: $("liveRoomStartTimerBtn"),
  liveRoomStopTimerBtn: $("liveRoomStopTimerBtn"),
  liveRoomAiTopicInput: $("liveRoomAiTopicInput"),
  liveRoomAiExplainBtn: $("liveRoomAiExplainBtn"),
  liveRoomHandsList: $("liveRoomHandsList"),
  liveRoomWaitingToggle: $("liveRoomWaitingToggle"),
  liveRoomWaitingList: $("liveRoomWaitingList"),
  liveRoomPollQuestion: $("liveRoomPollQuestion"),
  liveRoomPollOptions: $("liveRoomPollOptions"),
  liveRoomStartPollBtn: $("liveRoomStartPollBtn"),
  liveRoomClosePollBtn: $("liveRoomClosePollBtn"),
  liveRoomPollPanel: $("liveRoomPollPanel"),
  liveRoomOpenWhiteboardBtn: $("liveRoomOpenWhiteboardBtn"),
  liveRoomOpenBreakoutBtn: $("liveRoomOpenBreakoutBtn"),
  liveRoomOpenPollBtn: $("liveRoomOpenPollBtn"),
  liveRoomOpenQaBtn: $("liveRoomOpenQaBtn"),
  liveRoomWhiteboardPanel: $("liveRoomWhiteboardPanel"),
  liveRoomPollComposerPanel: $("liveRoomPollComposerPanel"),
  liveRoomBreakoutPanel: $("liveRoomBreakoutPanel"),
  liveRoomQaPanel: $("liveRoomQaPanel"),
  liveRoomShareWhiteboardBtn: $("liveRoomShareWhiteboardBtn"),
  liveRoomShareBreakoutBtn: $("liveRoomShareBreakoutBtn"),
  liveRoomQaInput: $("liveRoomQaInput"),
  liveRoomAddQaBtn: $("liveRoomAddQaBtn"),
  liveRoomShareQaBtn: $("liveRoomShareQaBtn"),
  liveRoomQaList: $("liveRoomQaList"),
  liveRoomChatList: $("liveRoomChatList"),
  liveRoomChatInput: $("liveRoomChatInput"),
  liveRoomSendChatBtn: $("liveRoomSendChatBtn"),
  liveRoomParticipantsList: $("liveRoomParticipantsList"),
  liveRoomBreakoutName: $("liveRoomBreakoutName"),
  liveRoomAssignBreakoutBtn: $("liveRoomAssignBreakoutBtn"),
  liveRoomClearBreakoutsBtn: $("liveRoomClearBreakoutsBtn"),
  authProgressOverlay: $("authProgressOverlay"),
  authProgressTitle: $("authProgressTitle"),
  authProgressDetail: $("authProgressDetail"),
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

function showAuthProgress(title = "Signing you in", detail = "Please wait while we load your workspace.") {
  if (el.authProgressTitle) el.authProgressTitle.textContent = title;
  if (el.authProgressDetail) el.authProgressDetail.textContent = detail;
  if (state.authProgressTimer) {
    clearTimeout(state.authProgressTimer);
    state.authProgressTimer = null;
  }
  state.authProgressVisible = true;
  el.authProgressOverlay?.classList.remove("hidden");
}

function hideAuthProgress() {
  if (state.authProgressTimer) {
    clearTimeout(state.authProgressTimer);
    state.authProgressTimer = null;
  }
  state.authProgressVisible = false;
  el.authProgressOverlay?.classList.add("hidden");
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
  if (mode === "auth" && state.liveRoom.active) {
    clearLiveRoomState();
    el.liveClassroomScreen?.classList.add("hidden");
  }
  [el.authView, el.adminView, el.providerView, el.studentView, el.nonAdminView].forEach((n) => n && n.classList.add("hidden"));
  if (mode === "auth") el.authView?.classList.remove("hidden");
  if (mode === "admin") el.adminView?.classList.remove("hidden");
  if (mode === "provider") el.providerView?.classList.remove("hidden");
  if (mode === "student") el.studentView?.classList.remove("hidden");
  if (mode === "non-admin") el.nonAdminView?.classList.remove("hidden");
  el.workspaceBrand?.classList.toggle("hidden", mode === "auth");
  if (mode === "auth") {
    hideAuthProgress();
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

async function runAdminRecoveryFlow() {
  if (!ensureAuthReady()) return;
  if (!state.auth?.currentUser) {
    toast("Login first, then run admin recovery.", "error");
    return;
  }
  const key = window.prompt("Enter Admin Recovery Key");
  if (!key) return;
  try {
    await api("POST", "/auth/admin/recover-self", { recovery_key: key });
    await state.auth.currentUser.getIdToken(true).catch(() => {});
    await loadSessionContext();
    toast("Admin access granted to this account.");
  } catch (err) {
    toast(formatAuthError(err, "Admin recovery failed"), "error");
    log("admin_recovery_error", String(err));
  }
}

async function runAdminSetUserPasswordFlow() {
  if (!ensureAuthReady()) return;
  if (!state.auth?.currentUser) {
    toast("Login first, then set user password.", "error");
    return;
  }
  const email = window.prompt("User email to reset");
  if (!email) return;
  const newPassword = window.prompt("New password (min 8 chars)");
  if (!newPassword || newPassword.length < 8) {
    toast("Password must be at least 8 characters.", "error");
    return;
  }
  const key = window.prompt("Enter Admin Recovery Key");
  if (!key) return;
  try {
    await api("POST", "/auth/admin/set-user-password", {
      email: String(email).trim().toLowerCase(),
      new_password: String(newPassword).trim(),
      recovery_key: key,
    });
    toast("Password updated for user.");
  } catch (err) {
    toast(formatAuthError(err, "Set user password failed"), "error");
    log("admin_set_password_error", String(err));
  }
}

async function runSelfPasswordChangeFlow() {
  if (!ensureAuthReady()) return;
  const user = state.auth?.currentUser;
  if (!user?.email) {
    toast("No signed-in email user found.", "error");
    return;
  }
  const currentPassword = window.prompt("Current password");
  if (!currentPassword) return;
  const newPassword = window.prompt("New password (min 8 chars)");
  if (!newPassword || newPassword.length < 8) {
    toast("New password must be at least 8 characters.", "error");
    return;
  }
  const confirmPassword = window.prompt("Confirm new password");
  if (!confirmPassword) return;
  if (newPassword !== confirmPassword) {
    toast("Password confirmation does not match.", "error");
    return;
  }
  if (newPassword === currentPassword) {
    toast("New password must be different from current password.", "error");
    return;
  }
  try {
    const credential = EmailAuthProvider.credential(user.email, String(currentPassword));
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, String(newPassword));
    toast("Password changed successfully.");
  } catch (err) {
    toast(formatAuthError(err, "Password change failed"), "error");
    log("self_change_password_error", String(err));
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
  if (name === "live") {
    refreshProviderLiveClasses().catch(() => toast("Failed to load live classes", "error"));
  }
}

function activateStudentSubView(name) {
  if (name !== "enrolled") {
    el.studentCourseViewer?.classList.add("hidden");
  }
  document.querySelectorAll(".student-nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.studentView === name));
  document.querySelectorAll('[id^="student-view-"]').forEach((v) => v.classList.add("hidden"));
  const pane = document.getElementById(`student-view-${name}`);
  if (pane) pane.classList.remove("hidden");
  if (name === "live") {
    refreshStudentLiveClasses().catch(() => toast("Failed to load live classes", "error"));
  }
  if (name === "certifications") {
    refreshStudentCertifications().catch(() => toast("Failed to load certifications", "error"));
  }
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

function toLocalDatetimeValue(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const off = dt.getTimezoneOffset();
  const local = new Date(dt.getTime() - (off * 60 * 1000));
  return local.toISOString().slice(0, 16);
}

function toIsoFromLocalDatetime(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function formatCourseRating(average, count) {
  const avg = Number(average || 0);
  const cnt = Number(count || 0);
  if (!cnt || avg <= 0) return "No ratings yet";
  return `Rating ${avg.toFixed(1)}/5 (${cnt})`;
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
    await refreshStudentAssessmentPanel(courseId, {
      examEligible: true,
      hasRecordedLesson: true,
      progressPct: 100,
    });
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

function decisionTone(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("fail") || v.includes("flag")) return "status-open";
  if (v.includes("review")) return "status-in_review";
  return "status-resolved";
}

function normalizeDecision(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v.includes("fail") || v.includes("flag")) return "fail";
  if (v.includes("review")) return "manual_review";
  if (v.includes("pass") || v.includes("clean")) return "pass";
  return v;
}

function renderGlimpseOverview(target, kpis, bars) {
  if (!target) return;
  const total = Math.max(1, Number(bars?.reduce((sum, row) => sum + Number(row?.value || 0), 0) || 0));
  const kpiMarkup = (kpis || []).map((item) => `
    <div class="glimpse-kpi">
      <div class="k">${item.label}</div>
      <div class="v">${item.value}</div>
    </div>
  `).join("");
  const barsMarkup = (bars || []).map((item) => {
    const value = Number(item.value || 0);
    const pct = Math.max(0, Math.min(100, Math.round((value / total) * 100)));
    return `
      <div class="glimpse-bar-row">
        <div>
          <div class="label"><span>${item.label}</span><span>${value}</span></div>
          <div class="bar"><div class="fill" style="width:${pct}%;"></div></div>
        </div>
        <div class="meta">${pct}%</div>
      </div>
    `;
  }).join("");
  target.innerHTML = `
    <div class="glimpse-kpis">${kpiMarkup || '<div class="glimpse-kpi"><div class="k">No data</div><div class="v">-</div></div>'}</div>
    <div class="glimpse-bars">${barsMarkup || '<div class="meta">No chart data.</div>'}</div>
  `;
}

async function refreshAdminProctorSessions() {
  const out = await api("GET", "/proctoring/admin/sessions?flagged_only=true&page=1&page_size=24");
  const items = out.items || [];
  const decisionCounts = { pass: 0, fail: 0, manual_review: 0, unknown: 0 };
  const reviewCounts = { pending: 0, reviewed: 0 };
  let totalWarnings = 0;
  let totalRisk = 0;
  items.forEach((row) => {
    const decision = normalizeDecision(row.ai_decision);
    decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
    if (String(row.admin_review_status || "").toLowerCase() === "pending") reviewCounts.pending += 1;
    else reviewCounts.reviewed += 1;
    totalWarnings += Number(row.warning_count || 0);
    const riskProb = Number(row.ai_probability);
    totalRisk += Number.isFinite(riskProb) ? (riskProb * 100) : 0;
  });
  renderGlimpseOverview(
    el.adminProctorOverview,
    [
      { label: "Flagged Sessions", value: items.length },
      { label: "Pending Review", value: reviewCounts.pending },
      { label: "Avg Warnings", value: items.length ? (totalWarnings / items.length).toFixed(1) : "0.0" },
      { label: "Avg Model Risk", value: items.length ? `${(totalRisk / items.length).toFixed(1)}%` : "0.0%" },
      { label: "Manual Review", value: decisionCounts.manual_review || 0 },
      { label: "Fail Decisions", value: decisionCounts.fail || 0 },
    ],
    [
      { label: "Pass", value: decisionCounts.pass || 0 },
      { label: "Fail", value: decisionCounts.fail || 0 },
      { label: "Manual Review", value: decisionCounts.manual_review || 0 },
      { label: "Unknown", value: decisionCounts.unknown || 0 },
    ],
  );
  renderList(
    el.adminProctorSessionsList,
    items.slice(0, 6),
    (session) => {
      const decision = normalizeDecision(session.ai_decision);
      const actor = escapeHtmlAttr(session.actor_name || session.actor_email || session.actor_user_id || "Unknown");
      const reviewStatus = escapeHtmlAttr(session.admin_review_status || "pending");
      const prob = Number(session.ai_probability);
      const riskPct = Number.isFinite(prob)
        ? Math.max(0, Math.min(100, Math.round(prob * 100)))
        : Math.max(4, Math.min(100, Math.round((Number(session.warning_count || 0) * 14) + (Number(session.events_count || 0) * 3))));
      return `
        <div class="glimpse-item-head">
          <strong>Session #${session.session_id}</strong>
          <span class="status-pill ${decisionTone(decision)}">${escapeHtmlAttr(decision)}</span>
        </div>
        <div class="meta">${actor} | ${formatTime(session.started_at)}</div>
        <div class="glimpse-progress"><span style="width:${riskPct}%;"></span></div>
        <div class="meta">Risk ${riskPct}% | Warnings ${Number(session.warning_count || 0)} | Events ${Number(session.events_count || 0)} | Review ${reviewStatus}</div>
      `;
    },
    "No flagged sessions.",
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
  const correct = items.filter((row) => String(row.feedback_label || "").toLowerCase() === "correct").length;
  const incorrect = items.filter((row) => String(row.feedback_label || "").toLowerCase() === "incorrect").length;
  const preview = items.filter((row) => String(row.context || "").toLowerCase() === "preview").length;
  const attempt = items.length - preview;
  const modelRiskValues = items
    .map((row) => Number(row.model_probability))
    .filter((v) => Number.isFinite(v))
    .map((v) => v * 100);
  const avgModelRisk = modelRiskValues.length
    ? `${(modelRiskValues.reduce((a, b) => a + b, 0) / modelRiskValues.length).toFixed(1)}%`
    : "0.0%";
  renderGlimpseOverview(
    el.adminTrainingOverview,
    [
      { label: "Total Labels", value: items.length },
      { label: "Model Correct", value: correct },
      { label: "Model Wrong", value: incorrect },
      { label: "Preview Labels", value: preview },
      { label: "Attempt Labels", value: attempt },
      { label: "Avg Model Risk", value: avgModelRisk },
    ],
    [
      { label: "Correct", value: correct },
      { label: "Incorrect", value: incorrect },
      { label: "Preview", value: preview },
      { label: "Attempts", value: attempt },
    ],
  );
  renderList(
    el.adminTrainingReviewsList,
    items.slice(0, 6),
    (row) => {
      const verdict = row.feedback_label === "correct" ? "Model Correct" : "Model Wrong";
      const pillCls = row.feedback_label === "correct" ? "status-resolved" : "status-open";
      const ctx = row.context === "preview" ? "Preview" : "Student Attempt";
      const prob =
        typeof row.model_probability === "number" && Number.isFinite(row.model_probability)
          ? `${(Number(row.model_probability) * 100).toFixed(1)}%`
          : "-";
      return `
        <div class="glimpse-item-head">
          <strong>#${row.id}</strong>
          <span class="status-pill ${pillCls}">${verdict}</span>
        </div>
        <div class="meta">${formatTime(row.created_at)} | ${ctx}</div>
        <div class="meta">Reviewer: ${escapeHtmlAttr(row.actor_name || "-")} | Risk: ${prob} | Model: ${escapeHtmlAttr(row.model_decision || "-")}</div>
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
  renderSimpleStats(el.studentStats, {
    "Enrolled Courses": data.stats?.total_enrolled ?? 0,
    "Completed Courses": data.stats?.completed_courses ?? 0,
    "Avg Progress %": `${data.stats?.avg_progress ?? 0}%`,
    "Exam Eligible": data.stats?.exam_eligible_courses ?? 0,
    "Certificates": data.stats?.certificates_issued ?? 0,
  });
  renderList(
    el.studentAvailableCourses,
    data.available || [],
    (c) => `
      <div class="course-card">
        ${c.thumbnail_url ? `<img src="${c.thumbnail_url}" alt="" class="course-thumb" />` : `<div class="course-thumb"></div>`}
        <div>
          <div><strong>${c.title}</strong></div>
          <div class="meta">Category: ${c.category || "-"}</div>
          <div class="meta">${formatCourseRating(c.average_rating, c.rating_count)}</div>
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
          <div class="meta">${formatCourseRating(c.average_rating, c.rating_count)}${Number(c.my_rating || 0) > 0 ? ` | Your rating: ${Number(c.my_rating).toFixed(1)}` : ""}</div>
          <div style="margin-top:6px;">
            <div style="height:8px;border:1px solid #dbe4f0;border-radius:999px;background:#eef2ff;overflow:hidden;">
              <div style="height:100%;width:${Math.max(0, Math.min(100, Number(c.progress_pct || 0)))}%;background:linear-gradient(90deg,#2563eb,#0ea5e9);"></div>
            </div>
            <div class="meta" style="margin-top:4px;">${Number(c.progress_pct || 0).toFixed(0)}% completed</div>
            <div class="meta" style="margin-top:4px;">Assessment: ${
              c.assessment_available
                ? "Available"
                : c.exam_eligible
                  ? "Provider has not published assessment yet"
                  : "Locked until course completion"
            }</div>
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

async function refreshStudentCertifications() {
  const certs = await api("GET", "/student/certificates");
  const certItems = certs || [];
  const certRenderer = (c) => `
    <div>
      <div><strong>${c.course_name}</strong></div>
      <div class="meta">Certificate ID: ${c.certificate_id} | Issued: ${formatTime(c.issued_at)}</div>
      <div class="actions">
        ${c.download_url ? `<a class="btn small" href="${c.download_url}" target="_blank" rel="noreferrer">Download PDF</a>` : ""}
        <a class="btn small" href="${c.verification_link}" target="_blank" rel="noreferrer">Verify</a>
      </div>
    </div>
  `;
  renderList(el.studentCertificatesTabList, certItems, certRenderer, "No certificates issued yet.");
}

function providerLiveSchedulerSetVisible(visible) {
  if (!el.providerLiveCreateScreen) return;
  el.providerLiveCreateScreen.classList.toggle("hidden", !visible);
}

function applyProviderLiveModeUi() {
  const mode = String(el.liveClassMode?.value || "in_app");
  const external = mode === "external";
  if (el.liveClassExternalUrl) {
    el.liveClassExternalUrl.disabled = !external;
    if (!external) el.liveClassExternalUrl.value = "";
  }
}

function applyProviderLiveRecurrenceUi() {
  const pattern = String(el.liveClassRecurrencePattern?.value || "none");
  const isCustom = pattern === "custom";
  el.liveClassCustomDaysRow?.classList.toggle("hidden", !isCustom);
  if (pattern === "none" && el.liveClassRecurrenceCount) {
    el.liveClassRecurrenceCount.value = "1";
  }
}

function getLiveCustomDays() {
  return Array.from(document.querySelectorAll("[data-live-custom-day]:checked"))
    .map((node) => Number(node.getAttribute("data-live-custom-day") || -1))
    .filter((n) => n >= 0 && n <= 6);
}

function generateLiveClassAiDraft(kind = "agenda") {
  const title = String(el.liveClassTitle?.value || "Live Session").trim() || "Live Session";
  const desc = String(el.liveClassDescription?.value || "").trim();
  const topicSeed = desc || title;
  const compactTopic = topicSeed.length > 100 ? `${topicSeed.slice(0, 100)}...` : topicSeed;
  if (kind === "poll") {
    return [
      `Poll Pack for "${title}"`,
      "",
      "1) Which part needs more explanation?",
      "Options: Basics / Intermediate / Advanced / Real example",
      "",
      `2) How confident are you with "${compactTopic}"?`,
      "Options: 1-Low / 2 / 3 / 4 / 5-High",
      "",
      "3) What should we practice next?",
      "Options: Quiz / Case study / Hands-on / Discussion",
    ].join("\n");
  }
  if (kind === "summary") {
    return [
      `Recap Notes for "${title}"`,
      "",
      "- Key concept covered:",
      "- Common student mistakes observed:",
      "- Practical use-case discussed:",
      "- Assignment given:",
      "- Assessment readiness check:",
      "- Next class topic:",
    ].join("\n");
  }
  return [
    `Teaching Agenda for "${title}"`,
    "",
    "00:00 - 05:00  Welcome + class objectives",
    `05:00 - 20:00  Core concept walkthrough: ${compactTopic}`,
    "20:00 - 30:00  Whiteboard explanation + examples",
    "30:00 - 40:00  Interactive poll + raise-hand Q&A",
    "40:00 - 50:00  Practice exercise / mini case",
    "50:00 - 60:00  Summary + next steps + assessment prep",
    "",
    "Teaching prompts:",
    "- Ask one conceptual question every 10 minutes.",
    "- Use chat checkpoints to confirm understanding.",
    "- End with one practical application task.",
  ].join("\n");
}

function resetProviderLiveScheduler() {
  state.providerLiveEditSessionId = null;
  if (el.liveClassTitle) el.liveClassTitle.value = "";
  if (el.liveClassDescription) el.liveClassDescription.value = "";
  if (el.liveClassTimezone) el.liveClassTimezone.value = "Asia/Kolkata";
  if (el.liveClassStartAt) el.liveClassStartAt.value = "";
  if (el.liveClassEndAt) el.liveClassEndAt.value = "";
  if (el.liveClassRecurrencePattern) el.liveClassRecurrencePattern.value = "none";
  if (el.liveClassRecurrenceCount) el.liveClassRecurrenceCount.value = "1";
  document.querySelectorAll("[data-live-custom-day]").forEach((n) => { n.checked = false; });
  if (el.liveClassMode) el.liveClassMode.value = "in_app";
  if (el.liveClassExternalUrl) el.liveClassExternalUrl.value = "";
  if (el.liveClassMaxParticipants) el.liveClassMaxParticipants.value = "200";
  if (el.liveClassAllowChat) el.liveClassAllowChat.checked = true;
  if (el.liveClassAllowRaiseHand) el.liveClassAllowRaiseHand.checked = true;
  if (el.liveClassAllowReactions) el.liveClassAllowReactions.checked = true;
  if (el.liveClassAiOutput) el.liveClassAiOutput.value = "";
  if (el.createLiveClassBtn) el.createLiveClassBtn.textContent = "Create Live Class";
  applyProviderLiveModeUi();
  applyProviderLiveRecurrenceUi();
}

function fillProviderLiveScheduler(session) {
  if (!session) return;
  state.providerLiveEditSessionId = Number(session.session_id || 0);
  if (el.liveClassTitle) el.liveClassTitle.value = session.title || "";
  if (el.liveClassDescription) el.liveClassDescription.value = session.description || "";
  if (el.liveClassTimezone) el.liveClassTimezone.value = session.timezone || "Asia/Kolkata";
  if (el.liveClassStartAt) el.liveClassStartAt.value = toLocalDatetimeValue(session.scheduled_start_at);
  if (el.liveClassEndAt) el.liveClassEndAt.value = toLocalDatetimeValue(session.scheduled_end_at);
  if (el.liveClassRecurrencePattern) el.liveClassRecurrencePattern.value = session.recurrence_pattern || "none";
  if (el.liveClassRecurrenceCount) el.liveClassRecurrenceCount.value = String(session.recurrence_count || 1);
  const customDays = new Set((session.recurrence_custom_days || []).map((x) => Number(x)));
  document.querySelectorAll("[data-live-custom-day]").forEach((n) => {
    const day = Number(n.getAttribute("data-live-custom-day") || -1);
    n.checked = customDays.has(day);
  });
  if (el.liveClassMode) el.liveClassMode.value = session.meeting_mode || "in_app";
  if (el.liveClassExternalUrl) el.liveClassExternalUrl.value = session.external_meeting_url || "";
  if (el.liveClassMaxParticipants) el.liveClassMaxParticipants.value = String(session.max_participants || 200);
  if (el.liveClassAllowChat) el.liveClassAllowChat.checked = Boolean(session.allow_chat);
  if (el.liveClassAllowRaiseHand) el.liveClassAllowRaiseHand.checked = Boolean(session.allow_raise_hand);
  if (el.liveClassAllowReactions) el.liveClassAllowReactions.checked = Boolean(session.allow_reactions);
  if (el.createLiveClassBtn) el.createLiveClassBtn.textContent = "Update Live Class";
  applyProviderLiveModeUi();
  applyProviderLiveRecurrenceUi();
}

async function refreshProviderLiveClasses() {
  const out = await api("GET", "/provider/workspace/live-classes");
  const items = out?.items || [];
  state.providerLiveSessions = items;
  const liveCount = items.filter((s) => s.status === "live").length;
  const scheduledCount = items.filter((s) => s.status === "scheduled").length;
  const completedCount = items.filter((s) => s.status === "ended").length;
  renderSimpleStats(el.providerLiveStats, {
    "Scheduled": scheduledCount,
    "Live Now": liveCount,
    "Completed": completedCount,
  });
  renderList(
    el.providerLiveClassSessionsList,
    items,
    (s) => {
      const isLive = s.status === "live";
      const isClosed = s.status === "ended" || s.status === "cancelled";
      const isScheduled = s.status === "scheduled";
      const ratingClass = isLive ? "status-open" : (isClosed ? "status-dismissed" : "status-in_review");
      const modeLabel = s.meeting_mode === "external" ? "External" : "In-app";
      const recurrenceLabel = s.recurrence_pattern && s.recurrence_pattern !== "none"
        ? `${s.recurrence_pattern} x${Number(s.recurrence_count || 1)}`
        : "one-time";
      return `
        <div>
          <div class="row between">
            <strong>${escapeHtmlAttr(s.title || "Untitled class")}</strong>
            <span class="status-pill ${ratingClass}">${escapeHtmlAttr(s.status || "scheduled")}</span>
          </div>
          <div class="meta">Live Course: ${escapeHtmlAttr(s.course_title || `#${s.course_id}`)} (ID #${Number(s.course_id || 0)}) | Participants: ${Number(s.participant_count || 0)} | Mode: ${modeLabel}</div>
          <div class="meta">Schedule: ${escapeHtmlAttr(recurrenceLabel)}</div>
          <div class="meta">${formatTime(s.scheduled_start_at)}${s.scheduled_end_at ? ` to ${formatTime(s.scheduled_end_at)}` : ""} (${escapeHtmlAttr(s.timezone || "UTC")})</div>
          ${s.description ? `<div style="margin-top:4px;">${escapeHtmlAttr(s.description)}</div>` : ""}
          <div class="actions">
            ${isClosed ? "" : `<button class="btn small" data-provider-live-join="${s.session_id}">Join Room</button>`}
            ${isScheduled ? `<button class="btn small" data-provider-live-start="${s.session_id}">Start Session</button>` : ""}
            ${isLive ? `<button class="btn small danger" data-provider-live-end="${s.session_id}">Complete Session</button>` : ""}
            ${s.meeting_mode === "external" && s.external_meeting_url ? `<a class="btn small" href="${s.external_meeting_url}" target="_blank" rel="noreferrer">Open Meeting</a>` : ""}
            ${isScheduled ? `<button class="btn small" data-provider-live-edit="${s.session_id}">Edit</button>` : ""}
          </div>
        </div>
      `;
    },
    "No live classes scheduled yet.",
  );
  document.querySelectorAll("[data-provider-live-join]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = Number(btn.dataset.providerLiveJoin || 0);
      if (!sessionId) return;
      try {
        await api("POST", `/provider/workspace/live-classes/${sessionId}/join`);
        await openLiveClassroom(sessionId, "provider");
      } catch (err) {
        toast(err?.message || "Failed to join live class", "error");
      }
    });
  });
  document.querySelectorAll("[data-provider-live-start]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = Number(btn.dataset.providerLiveStart || 0);
      if (!sessionId) return;
      try {
        await api("POST", `/provider/workspace/live-classes/${sessionId}/start`);
        toast("Live class started");
        await refreshProviderLiveClasses();
      } catch (err) {
        toast(err?.message || "Failed to start live class", "error");
      }
    });
  });
  document.querySelectorAll("[data-provider-live-end]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = Number(btn.dataset.providerLiveEnd || 0);
      if (!sessionId) return;
      const ok = confirm("End this live class now? This will unlock assessments for enrolled students.");
      if (!ok) return;
      try {
        const out2 = await api("POST", `/provider/workspace/live-classes/${sessionId}/end`);
        toast(`Live class ended. Students unlocked: ${Number(out2?.students_unlocked || 0)}`);
        await refreshProviderLiveClasses();
      } catch (err) {
        toast(err?.message || "Failed to end live class", "error");
      }
    });
  });
  document.querySelectorAll("[data-provider-live-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sessionId = Number(btn.dataset.providerLiveEdit || 0);
      const sess = state.providerLiveSessions.find((row) => Number(row.session_id) === sessionId);
      if (!sess) return;
      fillProviderLiveScheduler(sess);
      providerLiveSchedulerSetVisible(true);
    });
  });
}

async function submitProviderLiveSchedule() {
  const title = String(el.liveClassTitle?.value || "").trim();
  const startIso = toIsoFromLocalDatetime(el.liveClassStartAt?.value || "");
  const endIsoRaw = toIsoFromLocalDatetime(el.liveClassEndAt?.value || "");
  const recurrencePattern = String(el.liveClassRecurrencePattern?.value || "none").trim() || "none";
  const recurrenceCount = Number(el.liveClassRecurrenceCount?.value || 1);
  const recurrenceCustomDays = getLiveCustomDays();
  const timezone = String(el.liveClassTimezone?.value || "Asia/Kolkata").trim() || "Asia/Kolkata";
  const meetingMode = String(el.liveClassMode?.value || "in_app").trim() || "in_app";
  const externalUrl = String(el.liveClassExternalUrl?.value || "").trim();
  const maxParticipants = Number(el.liveClassMaxParticipants?.value || 200);
  const payload = {
    title,
    description: String(el.liveClassDescription?.value || "").trim() || null,
    scheduled_start_at: startIso,
    scheduled_end_at: endIsoRaw || null,
    timezone,
    meeting_mode: meetingMode,
    external_meeting_url: externalUrl || null,
    max_participants: Number.isFinite(maxParticipants) && maxParticipants > 0 ? maxParticipants : 200,
    allow_chat: Boolean(el.liveClassAllowChat?.checked),
    allow_raise_hand: Boolean(el.liveClassAllowRaiseHand?.checked),
    allow_reactions: Boolean(el.liveClassAllowReactions?.checked),
    recurrence_pattern: recurrencePattern,
    recurrence_count: Number.isFinite(recurrenceCount) && recurrenceCount > 0 ? recurrenceCount : 1,
    recurrence_custom_days: recurrenceCustomDays,
  };
  if (!payload.title) throw new Error("Class title is required");
  if (!payload.scheduled_start_at) throw new Error("Scheduled start time is required");
  if (payload.meeting_mode === "external" && !payload.external_meeting_url) {
    throw new Error("External meeting URL is required when mode is external");
  }
  if (state.providerLiveEditSessionId) {
    await api("PATCH", `/provider/workspace/live-classes/${state.providerLiveEditSessionId}`, {
      title: payload.title,
      description: payload.description,
      scheduled_start_at: payload.scheduled_start_at,
      scheduled_end_at: payload.scheduled_end_at,
      timezone: payload.timezone,
      meeting_mode: payload.meeting_mode,
      external_meeting_url: payload.external_meeting_url,
      max_participants: payload.max_participants,
      allow_chat: payload.allow_chat,
      allow_raise_hand: payload.allow_raise_hand,
      allow_reactions: payload.allow_reactions,
      recurrence_pattern: payload.recurrence_pattern,
      recurrence_count: payload.recurrence_count,
      recurrence_custom_days: payload.recurrence_custom_days,
    });
    toast("Live class schedule updated");
  } else {
    const created = await api("POST", "/provider/workspace/live-classes", payload);
    toast(`Live class scheduled (${Number(created?.recurrence_count || 1)} session(s)). Auto course ID: ${Number(created?.course_id || 0)}`);
  }
  resetProviderLiveScheduler();
  providerLiveSchedulerSetVisible(false);
  await refreshProviderLiveClasses();
}

async function refreshStudentLiveClasses() {
  const out = await api("GET", "/student/live-classes");
  const items = out?.items || [];
  state.studentLiveSessions = items;
  const nowMs = Date.now();
  const validReminderKeys = {};
  items.forEach((s) => {
    const reminderAt = s.reminder_at ? new Date(s.reminder_at).getTime() : NaN;
    if (!Number.isFinite(reminderAt)) return;
    const key = `${s.session_id}:${s.reminder_at}`;
    validReminderKeys[key] = true;
    if (state.studentLiveReminderSent[key]) return;
    const delay = reminderAt - nowMs;
    const fireReminder = () => {
      if (state.studentLiveReminderSent[key]) return;
      state.studentLiveReminderSent[key] = true;
      const msg = `Reminder: "${s.title}" starts in 30 minutes.`;
      toast(msg);
      if ("Notification" in window) {
        if (Notification.permission === "granted") {
          try { new Notification("Certora Class Reminder", { body: msg }); } catch {}
        } else if (Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
      }
    };
    if (delay <= 0 && (s.reminder_due || false)) {
      fireReminder();
      return;
    }
    if (delay > 0 && !state.studentLiveReminderTimers[key]) {
      state.studentLiveReminderTimers[key] = setTimeout(fireReminder, delay);
    }
  });
  Object.keys(state.studentLiveReminderTimers).forEach((key) => {
    if (validReminderKeys[key]) return;
    clearTimeout(state.studentLiveReminderTimers[key]);
    delete state.studentLiveReminderTimers[key];
  });
  renderList(
    el.studentLiveClassesList,
    items,
    (s) => {
      const isClosed = s.status === "ended" || s.status === "cancelled";
      const statusClass = s.status === "live" ? "status-open" : (isClosed ? "status-dismissed" : "status-in_review");
      const recurrenceLabel = s.recurrence_pattern && s.recurrence_pattern !== "none"
        ? `${s.recurrence_pattern} x${Number(s.recurrence_count || 1)}`
        : "one-time";
      return `
        <div>
          <div class="row between">
            <strong>${escapeHtmlAttr(s.title || "Live class")}</strong>
            <span class="status-pill ${statusClass}">${escapeHtmlAttr(s.status || "scheduled")}</span>
          </div>
          <div class="meta">Course: ${escapeHtmlAttr(s.course_title || `#${s.course_id}`)} | Participants: ${Number(s.participant_count || 0)}</div>
          <div class="meta">Schedule: ${escapeHtmlAttr(recurrenceLabel)} | Reminder: 30 mins before</div>
          <div class="meta">${formatTime(s.scheduled_start_at)}${s.scheduled_end_at ? ` to ${formatTime(s.scheduled_end_at)}` : ""}</div>
          ${s.description ? `<div style="margin-top:4px;">${escapeHtmlAttr(s.description)}</div>` : ""}
          <div class="actions">
            ${isClosed ? "" : `<button class="btn small" data-student-live-join="${s.session_id}">${s.joined ? "Enter Room" : "Join Class"}</button>`}
            ${s.joined ? `<button class="btn small" data-student-live-leave="${s.session_id}">Leave</button>` : ""}
            ${s.meeting_mode === "external" && s.external_meeting_url ? `<a class="btn small" href="${s.external_meeting_url}" target="_blank" rel="noreferrer">Open Meeting</a>` : ""}
          </div>
        </div>
      `;
    },
    "No live classes for your enrolled courses.",
  );
  document.querySelectorAll("[data-student-live-join]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = Number(btn.dataset.studentLiveJoin || 0);
      if (!sessionId) return;
      try {
        const out2 = await api("POST", `/student/live-classes/${sessionId}/join`);
        await openLiveClassroom(sessionId, "student", out2?.room_state || null);
      } catch (err) {
        toast(err?.message || "Failed to join class", "error");
      }
    });
  });
  document.querySelectorAll("[data-student-live-leave]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = Number(btn.dataset.studentLiveLeave || 0);
      if (!sessionId) return;
      try {
        await api("POST", `/student/live-classes/${sessionId}/leave`);
        toast("You left the class");
        await refreshStudentLiveClasses();
      } catch (err) {
        toast(err?.message || "Failed to leave class", "error");
      }
    });
  });
}

function getLiveRoomApiPrefix(role = state.liveRoom.role) {
  return role === "provider" ? "/provider/workspace/live-classes" : "/student/live-classes";
}

function setLiveSignalStatus(connected) {
  state.liveRoom.wsConnected = Boolean(connected);
  if (!el.liveRoomSignalStatus) return;
  el.liveRoomSignalStatus.textContent = connected ? "Realtime: connected" : "Realtime: fallback";
  el.liveRoomSignalStatus.classList.toggle("status-resolved", connected);
  el.liveRoomSignalStatus.classList.toggle("status-in_review", !connected);
}

function setLiveWaitingOverlay(status, flags = {}) {
  state.liveRoom.accessStatus = String(status || "admitted");
  const waiting = state.liveRoom.accessStatus !== "admitted";
  if (!el.liveRoomWaitingOverlay) return;
  el.liveRoomWaitingOverlay.classList.toggle("hidden", !waiting);
  if (!waiting) return;
  let text = "You are waiting for host approval to enter the class.";
  if (state.liveRoom.accessStatus === "blocked" || flags.removed) {
    text = "Host removed you from this class.";
  }
  if (flags.breakout_room) {
    text = `Assigned breakout room: ${String(flags.breakout_room)}`;
  }
  if (el.liveRoomWaitingText) el.liveRoomWaitingText.textContent = text;
}

function ensureLiveParticipantSelectBinding() {
  if (!el.liveRoomParticipantsList) return;
  el.liveRoomParticipantsList.querySelectorAll("[data-live-participant-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const pid = Number(node.getAttribute("data-live-participant-id") || 0);
      state.liveRoom.selectedParticipantId = pid;
      el.liveRoomParticipantsList.querySelectorAll(".item").forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");
    });
  });
}

async function runHostAction(action, extras = {}) {
  if (state.liveRoom.role !== "provider") return;
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId) return;
  await api("POST", `/provider/workspace/live-classes/${sessionId}/host-action`, {
    action,
    ...extras,
  });
  await refreshLiveRoomState();
  await refreshLiveModerationState();
}

async function refreshLiveModerationState() {
  if (state.liveRoom.role !== "provider") return;
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId) return;
  const out = await api("GET", `/provider/workspace/live-classes/${sessionId}/moderation-state`);
  state.liveRoom.moderation = out || null;
  const waiting = out?.waiting_users || [];
  if (el.liveRoomWaitingToggle) {
    el.liveRoomWaitingToggle.checked = Boolean(out?.waiting_room_enabled ?? true);
  }
  renderList(
    el.liveRoomWaitingList,
    waiting,
    (w) => `
      <div class="row between">
        <span><strong>${escapeHtmlAttr(w.display_name || `User ${w.user_id}`)}</strong> <span class="meta">(${escapeHtmlAttr(w.role || "student")})</span></span>
        <span class="actions">
          <button class="btn small" data-live-admit="${w.user_id}">Admit</button>
          <button class="btn small danger" data-live-reject="${w.user_id}">Reject</button>
        </span>
      </div>
    `,
    "No users in waiting room.",
  );
  document.querySelectorAll("[data-live-admit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = Number(btn.getAttribute("data-live-admit") || 0);
      if (!uid) return;
      runHostAction("admit", { target_user_id: uid }).catch((err) => toast(err?.message || "Admit failed", "error"));
    });
  });
  document.querySelectorAll("[data-live-reject]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = Number(btn.getAttribute("data-live-reject") || 0);
      if (!uid) return;
      runHostAction("reject", { target_user_id: uid }).catch((err) => toast(err?.message || "Reject failed", "error"));
    });
  });
}

function setLiveRecordingUi(active) {
  if (el.liveRoomRecordingBadge) el.liveRoomRecordingBadge.classList.toggle("hidden", !active);
  if (el.liveRoomStartRecordingBtn) el.liveRoomStartRecordingBtn.disabled = Boolean(active);
  if (el.liveRoomPauseRecordingBtn) el.liveRoomPauseRecordingBtn.disabled = !active;
  if (el.liveRoomStopRecordingBtn) el.liveRoomStopRecordingBtn.disabled = !active;
  const stateText = String(state.liveRoom.recording?.mediaRecorder?.state || "");
  if (el.liveRoomPauseRecordingBtn) {
    const paused = stateText === "paused";
    el.liveRoomPauseRecordingBtn.classList.toggle("is-active", paused);
    el.liveRoomPauseRecordingBtn.setAttribute("title", paused ? "Resume recording" : "Pause recording");
    el.liveRoomPauseRecordingBtn.setAttribute("aria-label", paused ? "Resume recording" : "Pause recording");
  }
}

async function uploadLiveRecordingChunks(blob, mimeType = "video/webm") {
  if (state.liveRoom.role !== "provider") return;
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId) return;
  const fileName = `live_${sessionId}_${Date.now()}.webm`;
  const initForm = new FormData();
  initForm.append("filename", fileName);
  initForm.append("mime_type", mimeType);
  initForm.append("total_chunks", "0");
  const initRes = await fetch(`/provider/workspace/live-classes/${sessionId}/recordings/init`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await state.auth.currentUser.getIdToken()}` },
    body: initForm,
  });
  if (!initRes.ok) throw new Error("Recording init failed");
  const initData = await initRes.json();
  const uploadId = String(initData.upload_id || "");
  if (!uploadId) throw new Error("Recording upload id missing");
  const chunkSize = 1024 * 1024 * 2;
  const totalChunks = Math.max(1, Math.ceil(blob.size / chunkSize));
  for (let i = 0; i < totalChunks; i += 1) {
    const part = blob.slice(i * chunkSize, Math.min(blob.size, (i + 1) * chunkSize), mimeType);
    const fd = new FormData();
    fd.append("upload_id", uploadId);
    fd.append("index", String(i));
    fd.append("total_chunks", String(totalChunks));
    fd.append("is_last", String(i === totalChunks - 1));
    fd.append("chunk", new File([part], `${uploadId}_${i}.part`, { type: "application/octet-stream" }));
    const res = await fetch(`/provider/workspace/live-classes/${sessionId}/recordings/chunk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await state.auth.currentUser.getIdToken()}` },
      body: fd,
    });
    if (!res.ok) throw new Error(`Recording chunk ${i + 1}/${totalChunks} failed`);
  }
  const completeFd = new FormData();
  completeFd.append("upload_id", uploadId);
  completeFd.append("filename", fileName);
  completeFd.append("mime_type", mimeType);
  const finalRes = await fetch(`/provider/workspace/live-classes/${sessionId}/recordings/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await state.auth.currentUser.getIdToken()}` },
    body: completeFd,
  });
  if (!finalRes.ok) throw new Error("Recording finalize failed");
  return finalRes.json();
}

async function startLiveRecording() {
  if (state.liveRoom.role !== "provider") throw new Error("Only provider can record");
  const stream = el.liveRoomLocalVideo?.srcObject;
  if (!stream) throw new Error("Start camera before recording");
  const rec = state.liveRoom.recording;
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  rec.chunks = [];
  rec.mimeType = mimeType;
  rec.mediaRecorder = new MediaRecorder(stream, { mimeType });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) rec.chunks.push(e.data);
  };
  rec.mediaRecorder.onpause = () => setLiveRecordingUi(true);
  rec.mediaRecorder.onresume = () => setLiveRecordingUi(true);
  rec.mediaRecorder.start(1000);
  rec.active = true;
  setLiveRecordingUi(true);
}

async function stopLiveRecording() {
  const rec = state.liveRoom.recording;
  if (!rec.mediaRecorder || !rec.active) return;
  if (rec.uploadInFlight) return;
  rec.uploadInFlight = true;
  await new Promise((resolve) => {
    rec.mediaRecorder.onstop = resolve;
    rec.mediaRecorder.stop();
  });
  const blob = new Blob(rec.chunks, { type: rec.mimeType || "video/webm" });
  rec.mediaRecorder = null;
  rec.chunks = [];
  rec.active = false;
  setLiveRecordingUi(false);
  try {
    const out = await uploadLiveRecordingChunks(blob, rec.mimeType || "video/webm");
    toast(`Recording saved${out?.file_url ? "" : " (storage ref only)"}`);
  } finally {
    rec.uploadInFlight = false;
  }
}

function toggleLiveRecordingPause() {
  const rec = state.liveRoom.recording;
  if (!rec?.mediaRecorder || !rec.active) return;
  if (rec.mediaRecorder.state === "recording") rec.mediaRecorder.pause();
  else if (rec.mediaRecorder.state === "paused") rec.mediaRecorder.resume();
  setLiveRecordingUi(true);
}

function normalizeWsBase() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

function liveParticipantLabel(userId) {
  const key = String(Number(userId || 0));
  const row = state.liveRoom.participantMap[key];
  if (!row) return `Participant #${key}`;
  const role = String(row.actor_role || "participant");
  const name = String(row.display_name || `Participant #${key}`);
  return `${name} (${role})`;
}

function liveParticipantInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "U";
  const first = parts[0][0] || "";
  const second = (parts[1] && parts[1][0]) ? parts[1][0] : "";
  return `${first}${second}`.toUpperCase();
}

const LIVE_RTC_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

function liveRtcState() {
  return state.liveRoom.rtc;
}

function currentLiveUserId() {
  return Number(state.context?.id || 0);
}

function livePeerKey(userId) {
  return String(Number(userId || 0));
}

function shouldInitiateLiveOffer(selfUserId, peerUserId) {
  const selfId = Number(selfUserId || 0);
  const peerId = Number(peerUserId || 0);
  if (!selfId || !peerId || selfId === peerId) return false;
  // Deterministic initiator to avoid offer glare.
  return selfId > peerId;
}

function setLiveDrawerState(drawer, open) {
  if (drawer === "tools") state.liveRoom.toolsOpen = Boolean(open);
  if (drawer === "chat") state.liveRoom.chatOpen = Boolean(open);
  if (drawer === "reaction") state.liveRoom.reactionOpen = Boolean(open);
  if (drawer === "participants") state.liveRoom.participantsOpen = Boolean(open);
  if (el.liveRoomToolsPanel) el.liveRoomToolsPanel.classList.toggle("hidden", !state.liveRoom.toolsOpen);
  if (el.liveRoomChatPanel) el.liveRoomChatPanel.classList.toggle("hidden", !state.liveRoom.chatOpen);
  if (el.liveRoomReactionMenu) el.liveRoomReactionMenu.classList.toggle("hidden", !state.liveRoom.reactionOpen);
  if (el.liveRoomParticipantsMenu) el.liveRoomParticipantsMenu.classList.toggle("hidden", !state.liveRoom.participantsOpen);
  if (state.liveRoom.participantsOpen) positionLiveParticipantsMenu();
}

function renderLiveQaList() {
  if (!el.liveRoomQaList) return;
  const rows = Array.isArray(state.liveRoom.qaItems) ? state.liveRoom.qaItems : [];
  if (!rows.length) {
    el.liveRoomQaList.innerHTML = "<div class='item'><span class='meta'>No Q&A items yet.</span></div>";
    return;
  }
  el.liveRoomQaList.innerHTML = rows.map((q, idx) => `
    <div class="item">
      <div class="row between">
        <strong>Q${idx + 1}</strong>
        <span class="meta">${escapeHtmlAttr(q.author || "")}</span>
      </div>
      <div style="margin-top:4px;">${escapeHtmlAttr(q.text || "")}</div>
    </div>
  `).join("");
}

function setLiveSidePanel(kind = "", open = true) {
  const next = open ? String(kind || "") : "";
  state.liveRoom.sidePanel = next;
  if (el.liveRoomStageShell) el.liveRoomStageShell.classList.toggle("live-side-open", Boolean(next));
  if (el.liveRoomWhiteboardPanel) el.liveRoomWhiteboardPanel.classList.toggle("hidden", next !== "whiteboard");
  if (el.liveRoomPollComposerPanel) el.liveRoomPollComposerPanel.classList.toggle("hidden", next !== "poll-composer" && next !== "poll");
  if (el.liveRoomBreakoutPanel) el.liveRoomBreakoutPanel.classList.toggle("hidden", next !== "breakout");
  if (el.liveRoomQaPanel) el.liveRoomQaPanel.classList.toggle("hidden", next !== "qa");
}

function clearLiveControlDockIdleTimer() {
  if (state.liveRoom.controlDockIdleTimer) {
    clearTimeout(state.liveRoom.controlDockIdleTimer);
    state.liveRoom.controlDockIdleTimer = null;
  }
}

function setLiveControlDockVisibility(visible) {
  state.liveRoom.controlDockVisible = Boolean(visible);
  if (el.liveRoomControlDock) el.liveRoomControlDock.classList.toggle("is-hidden", !state.liveRoom.controlDockVisible);
}

function scheduleLiveControlDockAutoHide() {
  clearLiveControlDockIdleTimer();
  if (!state.liveRoom.active) return;
  state.liveRoom.controlDockIdleTimer = setTimeout(() => {
    if (!state.liveRoom.controlDockPointerInside) setLiveControlDockVisibility(false);
  }, 3000);
}

function pokeLiveControlDock() {
  setLiveControlDockVisibility(true);
  scheduleLiveControlDockAutoHide();
}

function normalizeSharedPanelKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "poll") return "poll";
  if (k === "whiteboard") return "whiteboard";
  if (k === "breakout") return "breakout";
  if (k === "qa") return "qa";
  return "";
}

async function broadcastLiveToolPanel(kind = "", open = true) {
  const panel = normalizeSharedPanelKind(kind);
  await sendLiveSignal("tool_panel", { panel, open: Boolean(open) }).catch(() => {});
}

function setIconButtonLabel(button, icon, label) {
  if (!button) return;
  if (label) {
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.dataset.tip = label;
  }
  button.innerHTML = `<span class="ico">${icon}</span><span class="lbl">${escapeHtmlAttr(label)}</span>`;
}

function liveUiIcon(name) {
  const stroke = "currentColor";
  const w = 18;
  const base = (path) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  if (name === "tools") return base("<rect x='4' y='4' width='6' height='6' rx='1.2'/><rect x='14' y='4' width='6' height='6' rx='1.2'/><rect x='4' y='14' width='6' height='6' rx='1.2'/><rect x='14' y='14' width='6' height='6' rx='1.2'/>");
  if (name === "chat") return base("<path d='M4 6h16v10H8l-4 4z'/>");
  if (name === "reaction") return base("<path d='M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z'/>");
  if (name === "fullscreen") return base("<path d='M9 4H4v5M15 4h5v5M9 20H4v-5M20 20h-5v-5'/>");
  if (name === "fullscreen-exit") return base("<path d='M9 4v5H4M20 9h-5V4M9 20v-5H4M20 15h-5v5'/>");
  if (name === "camera") return base("<rect x='3' y='7' width='13' height='10' rx='2'/><path d='M16 10l5-3v10l-5-3z'/>");
  if (name === "camera-off") return base("<rect x='3' y='7' width='13' height='10' rx='2'/><path d='M16 10l5-3v10l-5-3z'/><path d='M4 4l16 16'/>");
  if (name === "mic") return base("<rect x='9' y='4' width='6' height='10' rx='3'/><path d='M5 11a7 7 0 0 0 14 0M12 18v2'/>");
  if (name === "mic-off") return base("<rect x='9' y='4' width='6' height='10' rx='3'/><path d='M5 11a7 7 0 0 0 14 0M12 18v2M4 4l16 16'/>");
  if (name === "screen") return base("<rect x='3' y='4' width='18' height='12' rx='2'/><path d='M8 20h8M12 16v4'/>");
  if (name === "participants") return base("<circle cx='8' cy='9' r='3'/><circle cx='16' cy='10' r='2.5'/><path d='M3.5 18c1.4-2.3 3-3.5 4.5-3.5S11 15.7 12.5 18M14 18c.9-1.6 2-2.5 3.3-2.5 1.2 0 2.3.9 3.2 2.5'/>");
  if (name === "leave") return base("<path d='M15 6l6 6-6 6'/><path d='M21 12H10'/><path d='M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5'/>");
  if (name === "whiteboard") return base("<rect x='4' y='4' width='16' height='12' rx='2'/><path d='M8 20h8M12 16v4M8 8h8M8 11h5'/>");
  if (name === "breakout") return base("<rect x='3' y='4' width='8' height='7' rx='1.5'/><rect x='13' y='4' width='8' height='7' rx='1.5'/><rect x='8' y='13' width='8' height='7' rx='1.5'/>");
  if (name === "poll") return base("<path d='M5 19V9M12 19V5M19 19v-8'/>");
  if (name === "qa") return base("<circle cx='12' cy='12' r='9'/><path d='M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.8.7-1.7 1.2-1.7 2.2'/><path d='M12 16h.01'/>");
  if (name === "stop-share") return base("<rect x='3' y='4' width='18' height='12' rx='2'/><path d='M8 20h8M12 16v4M5 5l14 10'/>");
  if (name === "record") return "<svg viewBox='0 0 24 24' width='14' height='14' aria-hidden='true'><circle cx='12' cy='12' r='6' fill='currentColor'/></svg>";
  if (name === "pause") return "<svg viewBox='0 0 24 24' width='14' height='14' aria-hidden='true'><rect x='7' y='6' width='3' height='12' fill='currentColor'/><rect x='14' y='6' width='3' height='12' fill='currentColor'/></svg>";
  if (name === "stop") return "<svg viewBox='0 0 24 24' width='14' height='14' aria-hidden='true'><rect x='7' y='7' width='10' height='10' fill='currentColor'/></svg>";
  if (name === "send") return base("<path d='M21 3L3 11l7 2 2 7 9-17z'/>");
  return base("<circle cx='12' cy='12' r='8'/>");
}

function positionLiveParticipantsMenu() {
  if (!el.liveRoomParticipantsMenu || !el.liveRoomParticipantsBtn || !el.liveRoomStageShell) return;
  const shellRect = el.liveRoomStageShell.getBoundingClientRect();
  const btnRect = el.liveRoomParticipantsBtn.getBoundingClientRect();
  const menu = el.liveRoomParticipantsMenu;
  const width = menu.offsetWidth || 320;
  const preferredLeft = (btnRect.left - shellRect.left) + (btnRect.width / 2) - (width / 2);
  const left = Math.max(8, Math.min(preferredLeft, el.liveRoomStageShell.clientWidth - width - 8));
  const bottom = Math.max(70, (shellRect.bottom - btnRect.top) + 8);
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.bottom = `${bottom}px`;
  menu.style.transform = "none";
}

function initializeLiveIconButtons() {
  setIconButtonLabel(el.liveRoomToggleToolsBtn, liveUiIcon("tools"), "Tools");
  setIconButtonLabel(el.liveRoomToggleChatBtn, liveUiIcon("chat"), "Chat");
  setIconButtonLabel(el.liveRoomReactBtn, liveUiIcon("reaction"), "Reactions");
  setIconButtonLabel(el.liveRoomFullscreenBtn, liveUiIcon("fullscreen"), "Fullscreen");
  setIconButtonLabel(el.leaveLiveRoomBtn, liveUiIcon("leave"), "Leave");
  if (el.liveRoomParticipantsBtn) {
    el.liveRoomParticipantsBtn.setAttribute("title", "Participants");
    el.liveRoomParticipantsBtn.setAttribute("aria-label", "Participants");
    el.liveRoomParticipantsBtn.dataset.tip = "Participants";
    const pIcon = el.liveRoomParticipantsBtn.querySelector(".ico");
    if (pIcon) pIcon.innerHTML = liveUiIcon("participants");
  }
  if (el.liveRoomStopShareOverlayBtn) el.liveRoomStopShareOverlayBtn.innerHTML = `<span class="ico">${liveUiIcon("stop-share")}</span><span class="lbl">Stop sharing</span>`;
  if (el.liveRoomStartRecordingBtn) el.liveRoomStartRecordingBtn.innerHTML = `<span class="ico">${liveUiIcon("record")}</span>`;
  if (el.liveRoomPauseRecordingBtn) el.liveRoomPauseRecordingBtn.innerHTML = `<span class="ico">${liveUiIcon("pause")}</span>`;
  if (el.liveRoomStopRecordingBtn) el.liveRoomStopRecordingBtn.innerHTML = `<span class="ico">${liveUiIcon("stop")}</span>`;
  if (el.liveRoomOpenWhiteboardBtn) el.liveRoomOpenWhiteboardBtn.querySelector(".ico").innerHTML = liveUiIcon("whiteboard");
  if (el.liveRoomOpenBreakoutBtn) el.liveRoomOpenBreakoutBtn.querySelector(".ico").innerHTML = liveUiIcon("breakout");
  if (el.liveRoomOpenPollBtn) el.liveRoomOpenPollBtn.querySelector(".ico").innerHTML = liveUiIcon("poll");
  if (el.liveRoomOpenQaBtn) el.liveRoomOpenQaBtn.querySelector(".ico").innerHTML = liveUiIcon("qa");
  if (el.liveRoomSendChatBtn) el.liveRoomSendChatBtn.innerHTML = `<span class="ico">${liveUiIcon("send")}</span><span class="lbl">Send</span>`;
}

function refreshLiveFullscreenButton() {
  if (!el.liveRoomFullscreenBtn) return;
  const target = el.liveRoomStageShell || el.liveClassroomScreen;
  const isFs = Boolean(target && document.fullscreenElement === target);
  setIconButtonLabel(el.liveRoomFullscreenBtn, liveUiIcon(isFs ? "fullscreen-exit" : "fullscreen"), isFs ? "Exit Fullscreen" : "Fullscreen");
}

function setVideoElementStream(videoEl, stream, options = {}) {
  if (!videoEl) return;
  const mirror = Boolean(options.mirror);
  // Meet-style rendering: mirror only local self-view; keep sent/remote feeds unmirrored.
  videoEl.style.transform = mirror ? "scaleX(-1)" : "scaleX(1)";
  videoEl.style.webkitTransform = mirror ? "scaleX(-1)" : "scaleX(1)";
  videoEl.style.transformOrigin = "center center";
  videoEl.style.backfaceVisibility = "hidden";
  videoEl.style.objectFit = "cover";
  videoEl.style.objectPosition = "center center";
  videoEl.playsInline = true;
  if (Object.prototype.hasOwnProperty.call(options, "muted")) {
    videoEl.muted = Boolean(options.muted);
  }
  const nextStream = stream || null;
  if (videoEl.srcObject !== nextStream) {
    videoEl.srcObject = nextStream;
  }
}

function preferredCameraVideoConstraints() {
  return {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    aspectRatio: { ideal: 1.7777777778 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: "user",
    resizeMode: "crop-and-scale",
  };
}

function preferredCameraAudioConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
}

async function requestCameraStream() {
  if (!navigator?.mediaDevices?.getUserMedia) {
    throw new Error("Camera is unavailable in this browser/environment.");
  }
  const attempts = [
    { video: preferredCameraVideoConstraints(), audio: preferredCameraAudioConstraints() },
    { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: preferredCameraAudioConstraints() },
    { video: { facingMode: "user" }, audio: preferredCameraAudioConstraints() },
    { video: true, audio: preferredCameraAudioConstraints() },
    { video: true, audio: true },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Unable to access camera and microphone.");
}

async function tuneCapturedVideoTrack(videoTrack) {
  if (!videoTrack) return;
  try {
    videoTrack.contentHint = "detail";
  } catch {}
  try {
    await videoTrack.applyConstraints(preferredCameraVideoConstraints());
  } catch {}
  try {
    const caps = videoTrack.getCapabilities?.() || {};
    const advanced = [];
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) advanced.push({ focusMode: "continuous" });
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes("continuous")) advanced.push({ exposureMode: "continuous" });
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes("continuous")) advanced.push({ whiteBalanceMode: "continuous" });
    if (advanced.length) await videoTrack.applyConstraints({ advanced });
  } catch {}
}

function tuneVideoSenderQuality(sender) {
  if (!sender || sender.track?.kind !== "video") return;
  try {
    if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") return;
    const params = sender.getParameters() || {};
    const encodings = Array.isArray(params.encodings) && params.encodings.length ? params.encodings : [{}];
    params.encodings = encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: Math.max(Number(encoding.maxBitrate || 0), 2500000),
      maxFramerate: Math.min(30, Number(encoding.maxFramerate || 30)),
      scaleResolutionDownBy: 1,
      priority: encoding.priority || "high",
    }));
    params.degradationPreference = "maintain-resolution";
    sender.setParameters(params).catch(() => {});
  } catch {}
}

function refreshLiveControlButtonStates() {
  const rtc = liveRtcState();
  const camOn = Boolean(rtc.localStream?.getVideoTracks?.().some((t) => t.readyState === "live" && t.enabled));
  const screenOn = Boolean(rtc.screenStream?.getVideoTracks?.().some((t) => t.readyState === "live"));
  const participantCount = Object.keys(state.liveRoom.participantMap || {}).length;
  if (el.liveRoomVideoStartBtn) {
    el.liveRoomVideoStartBtn.classList.toggle("is-active", camOn);
    el.liveRoomVideoStartBtn.classList.toggle("is-muted", !camOn);
    setIconButtonLabel(el.liveRoomVideoStartBtn, liveUiIcon(camOn ? "camera" : "camera-off"), camOn ? "Camera On" : "Camera Off");
  }
  if (el.liveRoomShareScreenBtn) {
    el.liveRoomShareScreenBtn.disabled = Boolean(state.liveRoom.screenShareInFlight);
    el.liveRoomShareScreenBtn.classList.toggle("is-active", screenOn);
    setIconButtonLabel(el.liveRoomShareScreenBtn, liveUiIcon("screen"), screenOn ? "Sharing" : "Share");
  }
  if (el.liveRoomStopShareOverlayBtn) el.liveRoomStopShareOverlayBtn.classList.toggle("hidden", !screenOn);
  if (el.liveRoomParticipantsCountBadge) el.liveRoomParticipantsCountBadge.textContent = String(participantCount);
  if (el.liveRoomParticipantsCountText) el.liveRoomParticipantsCountText.textContent = `${participantCount} online`;
  if (state.liveRoom.participantsOpen) positionLiveParticipantsMenu();
}

function streamHasActiveVideo(stream) {
  return Boolean(stream?.getVideoTracks?.().some((t) => t.readyState === "live" && t.enabled !== false));
}

function toggleLiveDrawer(drawer) {
  const nextOpen = drawer === "tools"
    ? !state.liveRoom.toolsOpen
    : drawer === "chat"
      ? !state.liveRoom.chatOpen
      : drawer === "reaction"
        ? !state.liveRoom.reactionOpen
        : !state.liveRoom.participantsOpen;
  setLiveDrawerState("tools", false);
  setLiveDrawerState("chat", false);
  setLiveDrawerState("reaction", false);
  setLiveDrawerState("participants", false);
  if (nextOpen) setLiveDrawerState(drawer, true);
}

function streamForPeer(peerId) {
  return liveRtcState().remoteStreams[livePeerKey(peerId)] || null;
}

function pickProviderPeerId() {
  const entries = Object.values(state.liveRoom.participantMap || {});
  const provider = entries.find((p) => String(p.actor_role || "").toLowerCase() === "provider" && Number(p.user_id || 0) !== currentLiveUserId());
  return provider ? String(Number(provider.user_id || 0)) : "";
}

function pickLastJoinedRemotePeerId() {
  const entries = Object.values(state.liveRoom.participantMap || {})
    .filter((p) => Number(p.user_id || 0) !== currentLiveUserId() && streamForPeer(p.user_id))
    .sort((a, b) => {
      const ta = new Date(a.joined_at || 0).getTime();
      const tb = new Date(b.joined_at || 0).getTime();
      return tb - ta;
    });
  return entries.length ? String(Number(entries[0].user_id || 0)) : "";
}

function updateLiveStageAndFocusVideo() {
  const selfId = currentLiveUserId();
  const rtc = liveRtcState();
  const providerPeer = pickProviderPeerId();
  const activePeer = state.liveRoom.focusPeerId || pickLastJoinedRemotePeerId();
  state.liveRoom.focusPeerId = activePeer || "";
  const focusStream = activePeer ? streamForPeer(activePeer) : null;
  if (el.liveRoomFocusTile) el.liveRoomFocusTile.classList.toggle("hidden", !activePeer || !focusStream);
  setVideoElementStream(el.liveRoomFocusVideo, focusStream, { muted: true, mirror: false });
  if (el.liveRoomFocusLabel) el.liveRoomFocusLabel.textContent = activePeer ? liveParticipantLabel(activePeer) : "Active speaker";

  let stageStream = null;
  let stageLabel = "";
  if (state.liveRoom.role === "student") {
    const preferred = providerPeer || activePeer;
    stageStream = preferred ? streamForPeer(preferred) : null;
    stageLabel = preferred ? liveParticipantLabel(preferred) : "Live stage";
  } else {
    stageStream = rtc.localStream || null;
    stageLabel = "You";
  }
  if (!stageStream && activePeer) {
    stageStream = streamForPeer(activePeer);
    stageLabel = liveParticipantLabel(activePeer);
  }
  if (!stageStream && rtc.localStream) {
    stageStream = rtc.localStream;
    stageLabel = selfId ? "You" : "Live stage";
  }
  const sharingScreen = streamHasActiveVideo(rtc.screenStream);
  const showingLocalStage = Boolean(stageStream && stageStream === rtc.localStream);
  if (sharingScreen && showingLocalStage) {
    // Avoid recursive hall-of-mirrors by not previewing the shared screen on the main stage.
    stageStream = streamHasActiveVideo(rtc.cameraStream) ? rtc.cameraStream : null;
    stageLabel = stageStream ? "You" : "You (sharing screen)";
  }
  const stageHasVideo = streamHasActiveVideo(stageStream);
  const stageRenderStream = stageHasVideo ? stageStream : null;
  const isLocalStage = Boolean(stageRenderStream && stageRenderStream === rtc.localStream);
  setVideoElementStream(el.liveRoomStageVideo, stageRenderStream, { muted: isLocalStage, mirror: false });
  if (el.liveRoomStagePlaceholder) el.liveRoomStagePlaceholder.classList.toggle("hidden", Boolean(stageRenderStream));
  if (el.liveRoomMeta) {
    const base = el.liveRoomMeta.textContent || "";
    if (stageLabel) {
      const noSpeaker = base.replace(/\s\|\sSpeaker:.*$/i, "");
      el.liveRoomMeta.textContent = `${noSpeaker} | Speaker: ${stageLabel}`;
    }
  }
}

function setupLiveAudioAnalyzer(peerUserId, stream) {
  const rtc = liveRtcState();
  const key = livePeerKey(peerUserId);
  if (!stream) return;
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;
  if (rtc.peerAudioContexts[key]) return;
  try {
    const ac = new AudioContext();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    rtc.peerAudioContexts[key] = { ac, analyser };
  } catch {}
}

function teardownLiveAudioAnalyzer(peerUserId) {
  const rtc = liveRtcState();
  const key = livePeerKey(peerUserId);
  const ref = rtc.peerAudioContexts[key];
  if (!ref) return;
  try { ref.ac.close(); } catch {}
  delete rtc.peerAudioContexts[key];
  delete state.liveRoom.speakerScores[key];
}

function computeAnalyserLevel(analyser) {
  const arr = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const d = (arr[i] - 128) / 128;
    sum += d * d;
  }
  return Math.sqrt(sum / arr.length);
}

function startLiveSpeakerMonitor() {
  if (state.liveRoom.speakerMonitorId) return;
  state.liveRoom.speakerMonitorId = setInterval(() => {
    const rtc = liveRtcState();
    let bestPeer = "";
    let bestScore = 0.02;
    Object.entries(rtc.peerAudioContexts || {}).forEach(([key, ref]) => {
      if (!ref?.analyser) return;
      const level = computeAnalyserLevel(ref.analyser);
      const smooth = (state.liveRoom.speakerScores[key] || 0) * 0.65 + level * 0.35;
      state.liveRoom.speakerScores[key] = smooth;
      if (smooth > bestScore) {
        bestScore = smooth;
        bestPeer = key;
      }
    });
    if (bestPeer) state.liveRoom.focusPeerId = bestPeer;
    else if (!state.liveRoom.focusPeerId) state.liveRoom.focusPeerId = pickLastJoinedRemotePeerId();
    updateLiveStageAndFocusVideo();
  }, 700);
}

function stopLiveSpeakerMonitor() {
  if (state.liveRoom.speakerMonitorId) {
    clearInterval(state.liveRoom.speakerMonitorId);
    state.liveRoom.speakerMonitorId = null;
  }
}

function renderLiveRemoteVideos() {
  if (!el.liveRoomRemoteVideoGrid) return;
  const rtc = liveRtcState();
  const entries = Object.entries(rtc.remoteStreams || {});
  if (!entries.length) {
    el.liveRoomRemoteVideoGrid.innerHTML = "<div class='item'><span class='meta'>Waiting for participants to turn on video.</span></div>";
    return;
  }
  const html = entries.map(([peerId]) => `
    <div class="live-video-tile" data-live-remote-peer="${escapeHtmlAttr(peerId)}">
      <video autoplay playsinline class="live-video-el"></video>
      <div class="live-video-label">${escapeHtmlAttr(liveParticipantLabel(peerId))}</div>
    </div>
  `).join("");
  el.liveRoomRemoteVideoGrid.innerHTML = html;
  entries.forEach(([peerId, stream]) => {
    const video = el.liveRoomRemoteVideoGrid.querySelector(`[data-live-remote-peer="${peerId}"] video`);
    if (!video) return;
    setVideoElementStream(video, stream, { muted: true, mirror: false });
  });
  updateLiveStageAndFocusVideo();
}

function attachLocalVideoPreview() {
  if (!el.liveRoomLocalVideo) return;
  setVideoElementStream(el.liveRoomLocalVideo, liveRtcState().localStream, { muted: true, mirror: false });
  el.liveRoomLocalVideo.classList.toggle("live-video-muted", Boolean(liveRtcState().micMuted));
  updateLiveStageAndFocusVideo();
}

function replaceLiveOutboundVideoTrack(newVideoTrack) {
  const rtc = liveRtcState();
  rtc.outboundVideoTrack = newVideoTrack || null;
  Object.values(rtc.peers || {}).forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && newVideoTrack) {
      sender.replaceTrack(newVideoTrack)
        .then(() => {
          tuneVideoSenderQuality(sender);
        })
        .catch(() => {});
    }
  });
}

function attachTracksToPeer(pc) {
  const rtc = liveRtcState();
  const stream = rtc.localStream;
  if (stream) {
    stream.getTracks().forEach((track) => {
      const hasSender = pc.getSenders().some((s) => s.track && s.track.id === track.id);
      if (!hasSender) {
        const sender = pc.addTrack(track, stream);
        tuneVideoSenderQuality(sender);
      }
    });
  } else {
    const hasVideo = pc.getTransceivers().some((t) => t.receiver?.track?.kind === "video");
    const hasAudio = pc.getTransceivers().some((t) => t.receiver?.track?.kind === "audio");
    if (!hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
    if (!hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });
  }
}

function closeLiveSignalSocket() {
  if (state.liveRoom.wsPingId) {
    clearInterval(state.liveRoom.wsPingId);
    state.liveRoom.wsPingId = null;
  }
  if (state.liveRoom.wsReconnectId) {
    clearTimeout(state.liveRoom.wsReconnectId);
    state.liveRoom.wsReconnectId = null;
  }
  const ws = state.liveRoom.ws;
  state.liveRoom.ws = null;
  if (ws) {
    try { ws.close(); } catch {}
  }
  setLiveSignalStatus(false);
}

async function openLiveSignalSocket() {
  closeLiveSignalSocket();
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId || !state.auth?.currentUser) return;
  const token = await state.auth.currentUser.getIdToken().catch(() => "");
  if (!token) return;
  const url = `${normalizeWsBase()}/ws/live/${sessionId}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  state.liveRoom.ws = ws;
  ws.onopen = () => {
    if (state.liveRoom.ws !== ws) return;
    setLiveSignalStatus(true);
    state.liveRoom.wsPingId = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, 15000);
    sendLiveSignal("presence", { media: "camera" }).catch(() => {});
  };
  ws.onclose = () => {
    if (state.liveRoom.ws !== ws) return;
    closeLiveSignalSocket();
    if (!state.liveRoom.active || !state.liveRoom.sessionId) return;
    state.liveRoom.wsReconnectId = setTimeout(() => {
      openLiveSignalSocket().catch(() => {});
    }, 1800);
  };
  ws.onerror = () => {
    setLiveSignalStatus(false);
  };
  ws.onmessage = (event) => {
    let msg = null;
    try {
      msg = JSON.parse(String(event.data || "{}"));
    } catch {
      return;
    }
    const type = String(msg?.type || "").toLowerCase();
    if (type === "signal") {
      handleLiveSignalEnvelope(msg).catch(() => {});
      return;
    }
    if (type === "presence") {
      refreshLiveRoomState().catch(() => {});
      if (state.liveRoom.role === "provider") refreshLiveModerationState().catch(() => {});
      return;
    }
    if (type === "room_access") {
      setLiveWaitingOverlay(msg?.status || "admitted", msg?.flags || {});
      refreshLiveRoomState().catch(() => {});
      return;
    }
    if (type === "room_flags") {
      const flags = msg?.flags || {};
      setLiveWaitingOverlay(state.liveRoom.accessStatus || "admitted", flags);
      setLiveHostMuted(Boolean(flags.muted));
      return;
    }
    if (type === "moderation" && state.liveRoom.role === "provider") {
      state.liveRoom.moderation = msg?.state || null;
      refreshLiveModerationState().catch(() => {});
    }
  };
}

async function sendLiveSignal(kind, data = {}, toUserId = null) {
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId) return;
  const ws = state.liveRoom.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: "signal",
        kind,
        to_user_id: toUserId ? Number(toUserId) : null,
        payload: data || {},
      }));
      return;
    } catch {}
  }
  const fromUserId = currentLiveUserId();
  if (!fromUserId) return;
  const prefix = getLiveRoomApiPrefix();
  await api("POST", `${prefix}/${sessionId}/messages`, {
    message_type: "signal",
    content: kind,
    payload: {
      kind,
      from_user_id: fromUserId,
      to_user_id: toUserId ? Number(toUserId) : null,
      ...data,
    },
  });
}

function closeLivePeerConnection(peerUserId) {
  const rtc = liveRtcState();
  const key = livePeerKey(peerUserId);
  const pc = rtc.peers[key];
  if (pc) {
    try { pc.onicecandidate = null; } catch {}
    try { pc.ontrack = null; } catch {}
    try { pc.close(); } catch {}
  }
  delete rtc.peers[key];
  delete rtc.remoteStreams[key];
  teardownLiveAudioAnalyzer(peerUserId);
  if (state.liveRoom.focusPeerId === key) state.liveRoom.focusPeerId = pickLastJoinedRemotePeerId();
  renderLiveRemoteVideos();
}

function createLivePeerConnection(peerUserId) {
  const rtc = liveRtcState();
  const key = livePeerKey(peerUserId);
  if (rtc.peers[key]) return rtc.peers[key];
  const pc = new RTCPeerConnection(LIVE_RTC_CONFIG);
  rtc.peers[key] = pc;
  attachTracksToPeer(pc);
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const candidate = typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate;
    sendLiveSignal("ice", { candidate }, Number(peerUserId)).catch(() => {});
  };
  pc.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (!stream) return;
    rtc.remoteStreams[key] = stream;
    setupLiveAudioAnalyzer(peerUserId, stream);
    if (!state.liveRoom.focusPeerId) state.liveRoom.focusPeerId = key;
    renderLiveRemoteVideos();
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      closeLivePeerConnection(peerUserId);
    }
  };
  return pc;
}

async function ensureLiveCameraStream() {
  const rtc = liveRtcState();
  const activeTrack = rtc.cameraStream?.getTracks?.().find((t) => t.readyState === "live");
  if (activeTrack) return rtc.cameraStream;
  rtc.cameraStream = await requestCameraStream();
  await tuneCapturedVideoTrack(rtc.cameraStream?.getVideoTracks?.()[0]);
  return rtc.cameraStream;
}

async function startLiveCamera() {
  const rtc = liveRtcState();
  const cameraStream = await ensureLiveCameraStream();
  if (!rtc.localStream) rtc.localStream = new MediaStream();
  rtc.localStream.getTracks().forEach((t) => t.stop());
  rtc.localStream = new MediaStream(cameraStream.getTracks());
  const videoTrack = rtc.localStream.getVideoTracks()[0] || null;
  replaceLiveOutboundVideoTrack(videoTrack);
  setLiveMicMuted(Boolean(rtc.micMuted));
  attachLocalVideoPreview();
  refreshLiveControlButtonStates();
  await sendLiveSignal("presence", { media: "camera" }).catch(() => {});
  await syncLiveRtcPeersFromRoom().catch(() => {});
  await renegotiateAllLivePeers().catch(() => {});
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => {
    try { t.stop(); } catch {}
  });
}

async function stopLiveCamera() {
  const rtc = liveRtcState();
  await sendLiveSignal("leave", {}).catch(() => {});
  stopTracks(rtc.screenStream);
  stopTracks(rtc.cameraStream);
  stopTracks(rtc.localStream);
  rtc.screenStream = null;
  rtc.cameraStream = null;
  rtc.localStream = null;
  rtc.outboundVideoTrack = null;
  Object.keys(rtc.peers || {}).forEach((peerId) => closeLivePeerConnection(Number(peerId)));
  attachLocalVideoPreview();
  refreshLiveControlButtonStates();
}

function setLiveMicMuted(muted) {
  const rtc = liveRtcState();
  rtc.micMuted = Boolean(muted);
  const streams = [rtc.localStream, rtc.cameraStream].filter(Boolean);
  streams.forEach((stream) => {
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !rtc.micMuted;
    });
  });
  if (el.liveRoomToggleMicBtn) {
    setIconButtonLabel(el.liveRoomToggleMicBtn, liveUiIcon(rtc.micMuted ? "mic-off" : "mic"), rtc.micMuted ? "Unmute" : "Mic");
    el.liveRoomToggleMicBtn.classList.toggle("is-muted", Boolean(rtc.micMuted));
    el.liveRoomToggleMicBtn.classList.toggle("is-active", !rtc.micMuted);
  }
  attachLocalVideoPreview();
}

function setLiveHostMuted(muted) {
  state.liveRoom.hostMuted = Boolean(muted);
  if (state.liveRoom.hostMuted) setLiveMicMuted(true);
  if (el.liveRoomToggleMicBtn) {
    el.liveRoomToggleMicBtn.disabled = state.liveRoom.hostMuted;
    if (state.liveRoom.hostMuted) {
      setIconButtonLabel(el.liveRoomToggleMicBtn, liveUiIcon("mic-off"), "Host Muted");
      el.liveRoomToggleMicBtn.classList.add("is-muted");
      el.liveRoomToggleMicBtn.classList.remove("is-active");
    } else {
      setLiveMicMuted(liveRtcState().micMuted);
    }
  }
}

async function toggleLiveMic() {
  const rtc = liveRtcState();
  if (!rtc.localStream) await startLiveCamera();
  setLiveMicMuted(!rtc.micMuted);
}

async function startLiveScreenShare() {
  if (state.liveRoom.screenShareInFlight) return false;
  const rtc = liveRtcState();
  if (rtc.screenStream?.getVideoTracks?.().some((t) => t.readyState === "live")) return false;
  const fullscreenTarget = el.liveRoomStageShell || el.liveClassroomScreen;
  const shouldRestoreFullscreen = Boolean(fullscreenTarget && document.fullscreenElement === fullscreenTarget);
  state.liveRoom.screenShareInFlight = true;
  if (el.liveRoomShareScreenBtn) {
    el.liveRoomShareScreenBtn.disabled = true;
    setIconButtonLabel(el.liveRoomShareScreenBtn, liveUiIcon("screen"), "Starting...");
  }
  try {
    if (!rtc.cameraStream) await ensureLiveCameraStream();
    rtc.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = rtc.screenStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error("Unable to start screen share");
    if (!rtc.localStream) rtc.localStream = new MediaStream(rtc.cameraStream.getTracks());
    const oldVideo = rtc.localStream.getVideoTracks()[0];
    if (oldVideo) rtc.localStream.removeTrack(oldVideo);
    rtc.localStream.addTrack(screenTrack);
    replaceLiveOutboundVideoTrack(screenTrack);
    attachLocalVideoPreview();
    refreshLiveControlButtonStates();
    screenTrack.onended = () => {
      stopLiveScreenShare().catch(() => {});
    };
    await sendLiveSignal("presence", { media: "screen" }).catch(() => {});
    await renegotiateAllLivePeers().catch(() => {});
    if (shouldRestoreFullscreen && !document.fullscreenElement) {
      await fullscreenTarget?.requestFullscreen?.().catch(() => {});
    }
    return true;
  } finally {
    state.liveRoom.screenShareInFlight = false;
    if (el.liveRoomShareScreenBtn) el.liveRoomShareScreenBtn.disabled = false;
    refreshLiveControlButtonStates();
  }
}

async function stopLiveScreenShare() {
  const rtc = liveRtcState();
  if (!rtc.screenStream && !state.liveRoom.screenShareInFlight) return;
  stopTracks(rtc.screenStream);
  rtc.screenStream = null;
  if (!rtc.cameraStream) await ensureLiveCameraStream();
  if (!rtc.localStream) rtc.localStream = new MediaStream();
  const existingVideo = rtc.localStream.getVideoTracks()[0];
  if (existingVideo) rtc.localStream.removeTrack(existingVideo);
  const cameraVideo = rtc.cameraStream.getVideoTracks()[0];
  if (cameraVideo) rtc.localStream.addTrack(cameraVideo);
  replaceLiveOutboundVideoTrack(cameraVideo || null);
  attachLocalVideoPreview();
  refreshLiveControlButtonStates();
  await sendLiveSignal("presence", { media: "camera" }).catch(() => {});
  await renegotiateAllLivePeers().catch(() => {});
}

async function sendLiveOfferToPeer(peerUserId) {
  const selfId = currentLiveUserId();
  if (!shouldInitiateLiveOffer(selfId, peerUserId)) return;
  const pc = createLivePeerConnection(peerUserId);
  attachTracksToPeer(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendLiveSignal("offer", { sdp: offer.sdp, sdp_type: offer.type }, peerUserId);
}

async function renegotiateLivePeer(peerUserId) {
  const pc = createLivePeerConnection(peerUserId);
  attachTracksToPeer(pc);
  if (pc.signalingState !== "stable") return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendLiveSignal("offer", { sdp: offer.sdp, sdp_type: offer.type }, peerUserId);
}

async function renegotiateAllLivePeers() {
  const keys = Object.keys(liveRtcState().peers || {});
  await Promise.all(keys.map((key) => renegotiateLivePeer(Number(key)).catch(() => {})));
}

function liveSignalSeen(rtc, signalId, signalKey) {
  if (signalId && rtc.signalSeenIds[signalId]) return true;
  if (signalKey && rtc.signalSeenKeys[signalKey]) return true;
  if (signalId) rtc.signalSeenIds[signalId] = true;
  if (signalKey) rtc.signalSeenKeys[signalKey] = true;
  return false;
}

async function handleLiveSignalCore(input) {
  const rtc = liveRtcState();
  const signalId = String(input?.id || "").trim();
  const kind = String(input?.kind || "").trim().toLowerCase();
  const toUserId = Number(input?.to_user_id || 0);
  const fromUserId = Number(input?.from_user_id || 0);
  const signalKey = `${kind}:${fromUserId}:${toUserId}:${String(input?.ts || "")}`;
  if (liveSignalSeen(rtc, signalId, signalKey)) return;
  if (!kind) return;
  const payload = input?.payload || {};
  const selfId = currentLiveUserId();
  if (!fromUserId || fromUserId === selfId) return;
  if (toUserId && toUserId !== selfId) return;
  const createdAtMs = Number(input?.ts || 0) || (input?.created_at ? new Date(input.created_at).getTime() : Date.now());
  if (Number.isFinite(createdAtMs) && (Date.now() - createdAtMs) > 90000) return;

  if (kind === "tool_panel") {
    const panel = normalizeSharedPanelKind(payload.panel);
    const open = Boolean(payload.open);
    state.liveRoom.sharedPanel = open ? panel : "";
    if (open && panel) setLiveSidePanel(panel, true);
    else if (!open && state.liveRoom.sharedPanel === "") setLiveSidePanel("", false);
    return;
  }
  if (kind === "qa_add") {
    const text = String(payload.text || "").trim();
    if (!text) return;
    state.liveRoom.qaItems.push({
      text,
      author: String(payload.author || "Participant"),
      ts: Date.now(),
    });
    renderLiveQaList();
    return;
  }

  if (kind === "offer") {
    const pc = createLivePeerConnection(fromUserId);
    if (pc.signalingState === "have-local-offer") {
      const selfId = currentLiveUserId();
      const keepLocalOffer = Number(selfId || 0) > Number(fromUserId || 0);
      if (keepLocalOffer) return;
      await pc.setLocalDescription({ type: "rollback" }).catch(() => {});
    }
    await pc.setRemoteDescription({ type: "offer", sdp: String(payload.sdp || "") });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendLiveSignal("answer", { sdp: answer.sdp, sdp_type: answer.type }, fromUserId);
    return;
  }
  if (kind === "answer") {
    const pc = createLivePeerConnection(fromUserId);
    if (pc.signalingState !== "have-local-offer") return;
    await pc.setRemoteDescription({ type: "answer", sdp: String(payload.sdp || "") });
    return;
  }
  if (kind === "ice" && payload.candidate) {
    const pc = createLivePeerConnection(fromUserId);
    await pc.addIceCandidate(payload.candidate).catch(() => {});
    return;
  }
  if (kind === "presence") {
    await sendLiveOfferToPeer(fromUserId).catch(() => {});
    return;
  }
  if (kind === "leave") {
    closeLivePeerConnection(fromUserId);
  }
}

async function handleLiveSignalEnvelope(msg) {
  await handleLiveSignalCore({
    id: msg?.id,
    kind: msg?.kind,
    from_user_id: msg?.from_user_id,
    to_user_id: msg?.to_user_id,
    payload: msg?.payload || {},
    ts: msg?.ts || Date.now(),
  });
}

async function handleLiveSignalMessage(item) {
  const payload = item?.payload || {};
  await handleLiveSignalCore({
    id: item?.id,
    kind: String(payload.kind || item?.content || "").trim().toLowerCase(),
    from_user_id: payload.from_user_id,
    to_user_id: payload.to_user_id,
    payload,
    ts: item?.created_at ? new Date(item.created_at).getTime() : Date.now(),
    created_at: item?.created_at,
  });
}

async function syncLiveRtcPeersFromRoom(room = null) {
  const currentRoom = room || state.liveRoom.lastRoomState || null;
  if (!currentRoom) return;
  const selfId = currentLiveUserId();
  const participantIds = (currentRoom.participants || [])
    .map((p) => Number(p.user_id || 0))
    .filter((id) => id && id !== selfId);
  const activeSet = new Set(participantIds.map((id) => livePeerKey(id)));
  Object.keys(liveRtcState().peers || {}).forEach((key) => {
    if (!activeSet.has(key)) closeLivePeerConnection(Number(key));
  });
  await Promise.all(participantIds.map((peerId) => sendLiveOfferToPeer(peerId).catch(() => {})));
}

function stopLiveRoomPolling() {
  if (state.liveRoom.pollerId) {
    clearInterval(state.liveRoom.pollerId);
    state.liveRoom.pollerId = null;
  }
}

function clearLiveRoomState() {
  clearLiveControlDockIdleTimer();
  state.liveRoom.controlDockPointerInside = false;
  state.liveRoom.controlDockVisible = true;
  closeLiveSignalSocket();
  try { stopLiveRecording().catch(() => {}); } catch {}
  stopLiveSpeakerMonitor();
  stopLiveRoomPolling();
  if (state.liveRoom.classTimerId) {
    clearInterval(state.liveRoom.classTimerId);
    state.liveRoom.classTimerId = null;
  }
  state.liveRoom.classTimerStartedAt = 0;
  state.liveRoom.active = false;
  state.liveRoom.sessionId = null;
  state.liveRoom.role = null;
  state.liveRoom.lastMessageId = 0;
  state.liveRoom.lastRoomState = null;
  state.liveRoom.participantMap = {};
  state.liveRoom.moderation = null;
  state.liveRoom.selectedParticipantId = 0;
  state.liveRoom.accessStatus = "admitted";
  state.liveRoom.hostMuted = false;
  state.liveRoom.stagePeerId = "";
  state.liveRoom.focusPeerId = "";
  state.liveRoom.speakerScores = {};
  state.liveRoom.toolsOpen = false;
  state.liveRoom.chatOpen = false;
  state.liveRoom.reactionOpen = false;
  state.liveRoom.participantsOpen = false;
  state.liveRoom.sidePanel = "";
  state.liveRoom.sharedPanel = "";
  state.liveRoom.qaItems = [];
  state.liveRoom.boardServerText = "";
  state.liveRoom.boardDraftDirty = false;
  state.liveRoom.controlDockPointerInside = false;
  state.liveRoom.controlDockVisible = true;
  state.liveRoom.reactionBurstRecent = {};
  state.liveRoom.screenShareInFlight = false;
  state.liveRoom.recording = {
    mediaRecorder: null,
    chunks: [],
    mimeType: "video/webm",
    active: false,
    uploadInFlight: false,
  };
  const rtc = liveRtcState();
  stopTracks(rtc.screenStream);
  stopTracks(rtc.cameraStream);
  stopTracks(rtc.localStream);
  Object.keys(rtc.peers || {}).forEach((peerId) => closeLivePeerConnection(Number(peerId)));
  Object.keys(rtc.peerAudioContexts || {}).forEach((peerId) => teardownLiveAudioAnalyzer(Number(peerId)));
  rtc.peers = {};
  rtc.remoteStreams = {};
  rtc.signalSeenIds = {};
  rtc.signalSeenKeys = {};
  rtc.localStream = null;
  rtc.cameraStream = null;
  rtc.screenStream = null;
  rtc.outboundVideoTrack = null;
  rtc.micMuted = false;
  rtc.peerAudioContexts = {};
  if (el.liveRoomChatList) el.liveRoomChatList.innerHTML = "";
  if (el.liveRoomParticipantsList) el.liveRoomParticipantsList.innerHTML = "";
  if (el.liveRoomHandsList) el.liveRoomHandsList.innerHTML = "";
  if (el.liveRoomRemoteVideoGrid) el.liveRoomRemoteVideoGrid.innerHTML = "";
  if (el.liveRoomStageVideo) el.liveRoomStageVideo.srcObject = null;
  if (el.liveRoomStagePlaceholder) el.liveRoomStagePlaceholder.classList.remove("hidden");
  if (el.liveRoomFocusVideo) el.liveRoomFocusVideo.srcObject = null;
  if (el.liveRoomFocusTile) el.liveRoomFocusTile.classList.add("hidden");
  attachLocalVideoPreview();
  setLiveRecordingUi(false);
  setLiveWaitingOverlay("admitted", {});
  setLiveDrawerState("tools", false);
  setLiveDrawerState("chat", false);
  setLiveDrawerState("reaction", false);
  refreshLiveControlButtonStates();
  if (el.liveRoomTimerText) el.liveRoomTimerText.textContent = "Timer: 00:00";
  if (el.liveRoomPollPanel) {
    el.liveRoomPollPanel.classList.add("hidden");
    el.liveRoomPollPanel.innerHTML = "";
  }
  setLiveControlDockVisibility(true);
  setLiveSidePanel("", false);
  renderLiveQaList();
}

function liveRoomMessageRow(item) {
  const typeRaw = String(item.message_type || "").toLowerCase();
  if (typeRaw === "reaction") {
    const emoji = escapeHtmlAttr(String(item.content || "").trim() || "\u{1F44D}");
    return `<div class="live-chat-reaction-item">${emoji}</div>`;
  }
  const who = escapeHtmlAttr(item.actor_name || item.actor_role || "User");
  const kind = escapeHtmlAttr(item.message_type || "chat");
  const content = escapeHtmlAttr(item.content || "");
  return `
    <div>
      <div class="row between">
        <strong>${who}</strong>
        <span class="meta">${kind}</span>
      </div>
      <div style="margin-top:4px;">${content}</div>
      <div class="meta">${formatTime(item.created_at)}</div>
    </div>
  `;
}

function burstLiveReactionOnStage(emoji, dedupeKey = "") {
  const layer = el.liveRoomReactionBurstLayer;
  const glyph = String(emoji || "").trim();
  if (!layer || !glyph) return;
  const now = Date.now();
  const key = String(dedupeKey || `glyph:${glyph}`);
  const lastAt = Number(state.liveRoom.reactionBurstRecent[key] || 0);
  if (now - lastAt < 220) return;
  state.liveRoom.reactionBurstRecent[key] = now;
  const node = document.createElement("span");
  node.className = "live-reaction-burst";
  node.textContent = glyph;
  const offset = Math.round((Math.random() * 54) - 27);
  const duration = 900 + Math.round(Math.random() * 350);
  node.style.setProperty("--rx", `${offset}px`);
  node.style.setProperty("--dur", `${duration}ms`);
  layer.appendChild(node);
  setTimeout(() => {
    try { node.remove(); } catch {}
  }, duration + 120);
}

function appendLiveRoomMessages(items) {
  if (!el.liveRoomChatList || !Array.isArray(items) || !items.length) return;
  const maxId = Math.max(...items.map((row) => Number(row.id || 0)));
  state.liveRoom.lastMessageId = Math.max(state.liveRoom.lastMessageId, maxId);
  const visibleItems = [];
  items.forEach((row) => {
    if (String(row?.message_type || "").toLowerCase() === "signal") {
      handleLiveSignalMessage(row).catch(() => {});
      return;
    }
    if (String(row?.message_type || "").toLowerCase() === "reaction") {
      burstLiveReactionOnStage(String(row?.content || ""), `msg:${Number(row?.id || 0)}`);
    }
    visibleItems.push(row);
  });
  if (!visibleItems.length) return;
  const nearBottom = (el.liveRoomChatList.scrollHeight - el.liveRoomChatList.scrollTop - el.liveRoomChatList.clientHeight) < 30;
  const html = visibleItems.map((row) => `<div class="item">${liveRoomMessageRow(row)}</div>`).join("");
  el.liveRoomChatList.insertAdjacentHTML("beforeend", html);
  if (nearBottom) el.liveRoomChatList.scrollTop = el.liveRoomChatList.scrollHeight;
}

function renderLiveRoomParticipants(room) {
  const participants = room?.participants || [];
  state.liveRoom.participantMap = {};
  participants.forEach((p) => {
    state.liveRoom.participantMap[String(Number(p.user_id || 0))] = p;
  });
  const isProvider = state.liveRoom.role === "provider";
  renderList(
    el.liveRoomParticipantsList,
    participants,
    (p) => `
      <div class="live-participant-row row between" data-live-participant-id="${Number(p.user_id || 0)}">
        <span class="live-participant-main">
          <span class="live-participant-avatar">${escapeHtmlAttr(liveParticipantInitials(p.display_name || "User"))}</span>
          <span class="live-participant-copy">
            <strong>${escapeHtmlAttr(p.display_name || "User")}${p.raised_hand ? " <span class='live-hand-indicator' aria-label='Raised hand' title='Raised hand'>✋</span>" : ""}</strong>
            <span class="meta">${escapeHtmlAttr(p.actor_role || "participant")}</span>
          </span>
        </span>
        <span class="actions">
          <span class='meta'>Active</span>
          ${isProvider && p.actor_role !== "provider" ? `<button class="btn small" title="Mute ${escapeHtmlAttr(p.display_name || "user")}" data-live-mute="${Number(p.user_id || 0)}">Mute</button><button class="btn small danger" title="Remove ${escapeHtmlAttr(p.display_name || "user")}" data-live-remove="${Number(p.user_id || 0)}">Remove</button>` : ""}
        </span>
      </div>
    `,
    "No active participants.",
  );
  renderList(
    el.liveRoomHandsList,
    participants.filter((p) => p.raised_hand),
    (p) => `<div><strong>${escapeHtmlAttr(p.display_name || "User")}</strong> <span class="meta">(${escapeHtmlAttr(p.actor_role || "participant")})</span></div>`,
    "No raised hands.",
  );
  ensureLiveParticipantSelectBinding();
  document.querySelectorAll("[data-live-mute]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = Number(btn.getAttribute("data-live-mute") || 0);
      if (!uid) return;
      runHostAction("mute", { target_user_id: uid }).catch((err) => toast(err?.message || "Mute failed", "error"));
    });
  });
  document.querySelectorAll("[data-live-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = Number(btn.getAttribute("data-live-remove") || 0);
      if (!uid) return;
      runHostAction("remove", { target_user_id: uid }).catch((err) => toast(err?.message || "Remove failed", "error"));
    });
  });
  renderLiveRemoteVideos();
}

function renderLivePollPanel(room) {
  if (!el.liveRoomPollPanel) return;
  const session = room?.session || {};
  const poll = session.active_poll || {};
  const options = Array.isArray(poll.options) ? poll.options : [];
  if (!poll.key || !options.length) {
    el.liveRoomPollPanel.classList.add("hidden");
    el.liveRoomPollPanel.innerHTML = "";
    if (state.liveRoom.sidePanel === "poll") setLiveSidePanel("", false);
    return;
  }
  const canVote = state.liveRoom.role === "student" && Boolean(poll.is_open);
  const totalVotes = Number(poll.total_votes || 0);
  const votes = Array.isArray(poll.votes) ? poll.votes : [];
  const myVote = (poll.my_vote === null || poll.my_vote === undefined) ? null : Number(poll.my_vote);
  el.liveRoomPollPanel.classList.remove("hidden");
  el.liveRoomPollPanel.innerHTML = `
    <div class="row between">
      <strong>${escapeHtmlAttr(poll.question || "Live poll")}</strong>
      <span class="meta">${poll.is_open ? "Open" : "Closed"} | Votes: ${totalVotes}</span>
    </div>
    <div class="list" style="margin-top:8px;">
      ${options.map((opt, idx) => {
    const count = Number(votes[idx] || 0);
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const active = myVote === idx ? "status-open" : "status-dismissed";
    return `
          <div>
            <div class="row between">
              <span>${escapeHtmlAttr(opt)}</span>
              <span class="status-pill ${active}">${count} (${pct}%)</span>
            </div>
            ${canVote ? `<div class="actions"><button class="btn small" data-live-poll-vote="${idx}">${myVote === idx ? "Selected" : "Vote"}</button></div>` : ""}
          </div>
        `;
  }).join("")}
    </div>
  `;
  if (canVote) {
    el.liveRoomPollPanel.querySelectorAll("[data-live-poll-vote]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const optionIndex = Number(btn.dataset.livePollVote || 0);
        try {
          await api("POST", `/student/live-classes/${state.liveRoom.sessionId}/poll-vote`, { option_index: optionIndex });
          await refreshLiveRoomState();
        } catch (err) {
          toast(err?.message || "Failed to submit poll vote", "error");
        }
      });
    });
  }
  if (state.liveRoom.sharedPanel === "poll" && state.liveRoom.sidePanel !== "poll") {
    setLiveSidePanel("poll", true);
  }
}

function applyLiveRoomState(room) {
  state.liveRoom.lastRoomState = room || null;
  const session = room?.session || {};
  const me = room?.me || {};
  setLiveWaitingOverlay(me.access_status || "admitted", {
    muted: Boolean(me.muted),
    removed: Boolean(me.removed),
    breakout_room: me.breakout_room || null,
  });
  setLiveHostMuted(Boolean(me.muted));
  if (el.liveRoomTitle) el.liveRoomTitle.textContent = session.title || "Live Classroom";
  if (el.liveRoomMeta) {
    const mode = session.meeting_mode === "external" ? "External meeting + in-app tools" : "In-app video classroom";
    el.liveRoomMeta.textContent = `${session.course_title || "Course"} | ${mode} | ${session.status || "scheduled"}`;
  }
  if (el.liveRoomPresenceBadge) {
    el.liveRoomPresenceBadge.textContent = `Participants: ${Number(room?.participant_count || 0)}`;
  }
  const boardServerText = String(session.board_text || "");
  state.liveRoom.boardServerText = boardServerText;

  const isProvider = state.liveRoom.role === "provider";
  if (el.liveRoomBoardText) {
    const boardFocused = document.activeElement === el.liveRoomBoardText;
    const shouldSyncBoard = !isProvider || !state.liveRoom.boardDraftDirty || !boardFocused;
    if (shouldSyncBoard && el.liveRoomBoardText.value !== boardServerText) {
      el.liveRoomBoardText.value = boardServerText;
    }
  }
  if (el.liveRoomBoardText) el.liveRoomBoardText.disabled = !isProvider;
  if (el.liveRoomSaveBoardBtn) el.liveRoomSaveBoardBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomPollQuestion) el.liveRoomPollQuestion.disabled = !isProvider;
  if (el.liveRoomPollOptions) el.liveRoomPollOptions.disabled = !isProvider;
  if (el.liveRoomStartPollBtn) el.liveRoomStartPollBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomClosePollBtn) el.liveRoomClosePollBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomOpenWhiteboardBtn) el.liveRoomOpenWhiteboardBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomOpenBreakoutBtn) el.liveRoomOpenBreakoutBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomOpenPollBtn) el.liveRoomOpenPollBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomOpenQaBtn) el.liveRoomOpenQaBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomShareWhiteboardBtn) el.liveRoomShareWhiteboardBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomShareBreakoutBtn) el.liveRoomShareBreakoutBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomShareQaBtn) el.liveRoomShareQaBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomPickStudentBtn) el.liveRoomPickStudentBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomExportAttendanceBtn) el.liveRoomExportAttendanceBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomStartTimerBtn) el.liveRoomStartTimerBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomStopTimerBtn) el.liveRoomStopTimerBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomAiTopicInput) el.liveRoomAiTopicInput.disabled = !isProvider;
  if (el.liveRoomAiExplainBtn) el.liveRoomAiExplainBtn.classList.toggle("hidden", !isProvider);

  const canRaise = !isProvider && Boolean(session.allow_raise_hand);
  if (el.liveRoomRaiseHandBtn) {
    el.liveRoomRaiseHandBtn.classList.toggle("hidden", !canRaise);
    el.liveRoomRaiseHandBtn.textContent = me.raised_hand ? "Lower Hand" : "Raise Hand";
  }
  if (el.liveRoomSendChatBtn) {
    el.liveRoomSendChatBtn.disabled = !session.allow_chat;
  }
  if (el.liveRoomChatInput) {
    el.liveRoomChatInput.disabled = !session.allow_chat || (me.access_status && me.access_status !== "admitted") || Boolean(me.muted);
    if (!session.allow_chat) el.liveRoomChatInput.placeholder = "Chat is disabled for this class";
    else if (Boolean(me.muted)) el.liveRoomChatInput.placeholder = "You are muted by host";
    else if (me.access_status && me.access_status !== "admitted") el.liveRoomChatInput.placeholder = "Waiting for host approval";
    else el.liveRoomChatInput.placeholder = "Type message";
  }
  if (el.liveRoomVideoStartBtn) el.liveRoomVideoStartBtn.disabled = false;
  if (el.liveRoomVideoStopBtn) el.liveRoomVideoStopBtn.disabled = false;
  if (el.liveRoomToggleMicBtn) {
    el.liveRoomToggleMicBtn.disabled = state.liveRoom.hostMuted;
    if (state.liveRoom.hostMuted) {
      setIconButtonLabel(el.liveRoomToggleMicBtn, liveUiIcon("mic-off"), "Host Muted");
      el.liveRoomToggleMicBtn.classList.add("is-muted");
      el.liveRoomToggleMicBtn.classList.remove("is-active");
    } else {
      setLiveMicMuted(liveRtcState().micMuted);
    }
  }
  if (el.liveRoomShareScreenBtn) el.liveRoomShareScreenBtn.disabled = false;
  if (el.liveRoomStopShareBtn) el.liveRoomStopShareBtn.disabled = false;
  if (el.liveRoomStartRecordingBtn) el.liveRoomStartRecordingBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomPauseRecordingBtn) el.liveRoomPauseRecordingBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomStopRecordingBtn) el.liveRoomStopRecordingBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomRecordingBadge) el.liveRoomRecordingBadge.classList.toggle("hidden", !(isProvider && state.liveRoom.recording.active));
  if (el.liveRoomParticipantsBtn) el.liveRoomParticipantsBtn.classList.toggle("hidden", false);
  if (el.liveRoomWaitingToggle) el.liveRoomWaitingToggle.closest("label")?.classList.toggle("hidden", !isProvider);
  if (el.liveRoomWaitingList) el.liveRoomWaitingList.parentElement?.classList.toggle("hidden", !isProvider);
  if (el.liveRoomAssignBreakoutBtn) el.liveRoomAssignBreakoutBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomClearBreakoutsBtn) el.liveRoomClearBreakoutsBtn.classList.toggle("hidden", !isProvider);
  if (el.liveRoomBreakoutName) el.liveRoomBreakoutName.classList.toggle("hidden", !isProvider);

  renderLiveRoomParticipants(room);
  renderLiveQaList();
  renderLivePollPanel(room);
  refreshLiveControlButtonStates();
  syncLiveRtcPeersFromRoom(room).catch(() => {});
}

async function refreshLiveRoomMessages() {
  if (!state.liveRoom.active || !state.liveRoom.sessionId) return;
  const prefix = getLiveRoomApiPrefix();
  const out = await api(
    "GET",
    `${prefix}/${state.liveRoom.sessionId}/messages?after_id=${state.liveRoom.lastMessageId}&limit=100`,
  );
  appendLiveRoomMessages(out?.items || []);
}

async function refreshLiveRoomState() {
  if (!state.liveRoom.active || !state.liveRoom.sessionId) return;
  const prefix = getLiveRoomApiPrefix();
  const room = await api("GET", `${prefix}/${state.liveRoom.sessionId}/room-state`);
  applyLiveRoomState(room);
}

async function refreshLiveRoom() {
  if (!state.liveRoom.active || !state.liveRoom.sessionId) return;
  const tasks = [refreshLiveRoomState(), refreshLiveRoomMessages()];
  if (state.liveRoom.role === "provider") tasks.push(refreshLiveModerationState());
  await Promise.all(tasks);
}

function startLiveRoomPolling() {
  stopLiveRoomPolling();
  state.liveRoom.pollerId = setInterval(() => {
    refreshLiveRoom().catch((err) => {
      log("live_room_poll_error", String(err));
    });
  }, 4000);
}

async function openLiveClassroom(sessionId, role, initialState = null) {
  state.liveRoom.active = true;
  state.liveRoom.sessionId = Number(sessionId);
  state.liveRoom.role = role;
  state.liveRoom.lastMessageId = 0;
  state.liveRoom.lastRoomState = null;
  if (liveRtcState().signalSeenIds) liveRtcState().signalSeenIds = {};
  if (liveRtcState().signalSeenKeys) liveRtcState().signalSeenKeys = {};
  state.liveRoom.moderation = null;
  state.liveRoom.selectedParticipantId = 0;
  state.liveRoom.accessStatus = "admitted";
  state.liveRoom.hostMuted = false;
  state.liveRoom.stagePeerId = "";
  state.liveRoom.focusPeerId = "";
  state.liveRoom.speakerScores = {};
  state.liveRoom.toolsOpen = false;
  state.liveRoom.chatOpen = false;
  state.liveRoom.reactionOpen = false;
  state.liveRoom.participantsOpen = false;
  state.liveRoom.sidePanel = "";
  state.liveRoom.sharedPanel = "";
  state.liveRoom.qaItems = [];
  state.liveRoom.boardServerText = "";
  state.liveRoom.boardDraftDirty = false;
  state.liveRoom.controlDockPointerInside = false;
  state.liveRoom.controlDockVisible = true;
  if (el.liveRoomChatList) el.liveRoomChatList.innerHTML = "";
  renderLiveRemoteVideos();
  attachLocalVideoPreview();
  setLiveSignalStatus(false);
  setLiveRecordingUi(false);
  setLiveWaitingOverlay("admitted", {});
  if (el.liveClassroomScreen) el.liveClassroomScreen.classList.remove("hidden");
  el.liveRoomStageShell?.requestFullscreen?.().catch(() => {});
  setLiveDrawerState("tools", false);
  setLiveDrawerState("chat", false);
  setLiveDrawerState("reaction", false);
  setLiveDrawerState("participants", false);
  setLiveControlDockVisibility(true);
  scheduleLiveControlDockAutoHide();
  setLiveSidePanel("", false);
  renderLiveQaList();
  refreshLiveControlButtonStates();
  if (initialState) applyLiveRoomState(initialState);
  await refreshLiveRoom();
  openLiveSignalSocket().catch(() => {});
  startLiveSpeakerMonitor();
  startLiveRoomPolling();
}

async function leaveLiveClassroom() {
  const { sessionId, role } = state.liveRoom;
  if (!sessionId || !role) {
    clearLiveRoomState();
    if (el.liveClassroomScreen) el.liveClassroomScreen.classList.add("hidden");
    return;
  }
  const prefix = getLiveRoomApiPrefix(role);
  try {
    await stopLiveCamera();
  } catch {}
  try {
    await api("POST", `${prefix}/${sessionId}/leave`);
  } catch (err) {
    log("live_room_leave_error", String(err));
  }
  clearLiveRoomState();
  if (el.liveClassroomScreen) el.liveClassroomScreen.classList.add("hidden");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (role === "provider") {
    refreshProviderLiveClasses().catch(() => {});
  } else {
    refreshStudentLiveClasses().catch(() => {});
  }
}

async function sendLiveRoomChatMessage(messageType = "chat", contentRaw = "") {
  const sessionId = Number(state.liveRoom.sessionId || 0);
  if (!sessionId) return;
  if (state.liveRoom.accessStatus && state.liveRoom.accessStatus !== "admitted") {
    throw new Error("Waiting for host approval");
  }
  if (messageType === "chat" && state.liveRoom.hostMuted && state.liveRoom.role === "student") {
    throw new Error("You are muted by host");
  }
  const content = String(contentRaw || "").trim();
  if (!content) return;
  const prefix = getLiveRoomApiPrefix();
  await api("POST", `${prefix}/${sessionId}/messages`, {
    message_type: messageType,
    content,
    payload: {},
  });
  if (el.liveRoomChatInput) el.liveRoomChatInput.value = "";
  await refreshLiveRoomMessages();
}

function formatTimerDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function startLiveClassTimer() {
  if (state.liveRoom.classTimerId) return;
  state.liveRoom.classTimerStartedAt = Date.now();
  if (el.liveRoomTimerText) el.liveRoomTimerText.textContent = "Timer: 00:00";
  state.liveRoom.classTimerId = setInterval(() => {
    if (!el.liveRoomTimerText || !state.liveRoom.classTimerStartedAt) return;
    el.liveRoomTimerText.textContent = `Timer: ${formatTimerDuration(Date.now() - state.liveRoom.classTimerStartedAt)}`;
  }, 1000);
}

function stopLiveClassTimer() {
  if (state.liveRoom.classTimerId) {
    clearInterval(state.liveRoom.classTimerId);
    state.liveRoom.classTimerId = null;
  }
}

function generateLiveTopicExplainer(topicRaw) {
  const topic = String(topicRaw || "").trim() || "Core concept";
  return [
    `AI Explainer: ${topic}`,
    "",
    `1) Definition`,
    `${topic} means the primary principle learners must understand before applying it.`,
    "",
    "2) Why it matters",
    `If ${topic} is clear, students can solve practical scenarios with fewer mistakes.`,
    "",
    "3) Example",
    `Show one real case, then ask students to identify where ${topic} appears.`,
    "",
    "4) Quick check question",
    `Ask: "In your own words, how would you apply ${topic} in real work?"`,
  ].join("\n");
}

function exportLiveAttendanceCsv() {
  const people = Array.from(el.liveRoomParticipantsList?.querySelectorAll(".item") || []);
  if (!people.length) {
    toast("No participants to export", "error");
    return;
  }
  const lines = ["name,role,status"];
  people.forEach((node) => {
    const txt = node.textContent || "";
    const row = txt.replace(/\s+/g, " ").trim();
    lines.push(`"${row.replace(/"/g, '""')}"`);
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `live-attendance-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
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
            <div class="meta">${formatCourseRating(c.average_rating, c.rating_count)}</div>
            <div class="actions">
              <button class="btn small" data-view-course="${c.id}">View Course</button>
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
  if (el.scvCourseRatingSummary) {
    el.scvCourseRatingSummary.textContent = formatCourseRating(detail.average_rating, detail.rating_count);
  }
  const myFeedback = detail.my_feedback || {};
  if (el.scvRateValue) el.scvRateValue.value = String(myFeedback.valuable_time_rating || 5);
  if (el.scvRateContent) el.scvRateContent.value = String(myFeedback.content_quality_rating || 5);
  if (el.scvRateClarity) el.scvRateClarity.value = String(myFeedback.instructor_clarity_rating || 5);
  if (el.scvRatePractical) el.scvRatePractical.value = String(myFeedback.practical_usefulness_rating || 5);
  if (el.scvRatingComment) el.scvRatingComment.value = String(myFeedback.comment || "");
  const canRateCourse = progressPct >= 100 || Boolean(detail.exam_eligible);
  if (el.scvSaveRatingBtn) el.scvSaveRatingBtn.disabled = !canRateCourse;
  if (el.scvRatingStatus) {
    if (!canRateCourse) {
      el.scvRatingStatus.textContent = "Complete this course to enable rating.";
    } else if (myFeedback.feedback_id) {
      el.scvRatingStatus.textContent = `Your latest rating is saved (${Number(myFeedback.overall_rating || 0).toFixed(1)}/5).`;
    } else {
      el.scvRatingStatus.textContent = "";
    }
  }
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
  await refreshStudentAssessmentPanel(courseId, {
    examEligible: Boolean(detail.exam_eligible),
    assessmentAvailable: Boolean(detail.assessment_available),
    publishedAssessments: Number(detail.published_assessments || 0),
    hasRecordedLesson,
    progressPct: Number(detail.progress_pct || 0),
  });
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

async function refreshStudentAssessmentPanel(courseId, options = {}) {
  if (!el.scvAssessmentPanel) return;
  let examEligible = Boolean(options.examEligible);
  let assessmentAvailable = Boolean(options.assessmentAvailable);
  let publishedAssessments = Number(options.publishedAssessments || 0);
  const hasRecordedLesson = Boolean(options.hasRecordedLesson);
  const progressPct = Number(options.progressPct || 0);

  if (!examEligible && progressPct >= 100) {
    try {
      await api("POST", `/student/courses/${courseId}/complete`);
      examEligible = true;
      if (el.scvProgressBar) el.scvProgressBar.style.width = "100%";
      if (el.scvProgressText) el.scvProgressText.textContent = "100%";
    } catch {}
  }

  if (!examEligible) {
    const canManualUnlock = progressPct >= 100 || !hasRecordedLesson;
    el.scvAssessmentPanel.innerHTML = `
      <span id="scvAssessmentStatus" class="meta">${
        hasRecordedLesson
          ? "Watch the full video to unlock assessment."
          : "Complete this course to unlock assessment."
      }</span>
      ${canManualUnlock ? '<button class="btn small" id="scvUnlockAssessmentBtn">Unlock Assessment</button>' : ""}
    `;
    $("scvUnlockAssessmentBtn")?.addEventListener("click", async () => {
      try {
        await api("POST", `/student/courses/${courseId}/complete`);
        if (el.scvProgressBar) el.scvProgressBar.style.width = "100%";
        if (el.scvProgressText) el.scvProgressText.textContent = "100%";
        await refreshStudentAssessmentPanel(courseId, {
          examEligible: true,
          hasRecordedLesson,
          progressPct: 100,
        });
        refreshStudentDashboard().catch(() => {});
        toast("Assessment unlocked");
      } catch (err) {
        toast(err?.message || "Failed to unlock assessment", "error");
      }
    });
    return;
  }
  const out = await api("POST", `/student/courses/${courseId}/assessment-intent?ready=true`);
  const exams = out.exams || [];
  if (out?.assessment_status) assessmentAvailable = out.assessment_status === "available";
  if (Number.isFinite(Number(out?.published_assessments))) {
    publishedAssessments = Number(out.published_assessments || 0);
  }
  if (!exams.length) {
    const reason = String(out?.message || "").trim()
      || (assessmentAvailable
        ? "Assessment is being prepared."
        : publishedAssessments > 0
          ? "Assessment cannot be started yet."
          : "No published assessment found for this course yet. Ask provider to publish it.");
    el.scvAssessmentPanel.innerHTML = `<span id="scvAssessmentStatus" class="meta">${reason}</span>`;
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
    return context;
  }

  if (context.role === "provider") {
    showView("provider");
    activateProviderSubView("home");
    await Promise.all([
      refreshProviderHome(),
      refreshProviderAssessments(),
      refreshProviderFeedback(),
      refreshProviderCertifications(),
      refreshProviderLiveClasses(),
    ]);
    await refreshProviderContent();
    await refreshProviderDrafts();
    return context;
  }

  if (context.role === "student") {
    showView("student");
    activateStudentSubView("home");
    await Promise.all([refreshStudentDashboard(), refreshStudentCertifications(), refreshStudentLiveClasses()]);
    return context;
  }

  showView("non-admin");
  renderNonAdminRoleFix(context);
  const statusText = context.approval_status === "approved"
    ? "Approved"
    : context.approval_status === "pending"
      ? "Pending approval"
      : `Invalid profile (${context.rejection_reason || "rejected"})`;
  if (el.nonAdminText) el.nonAdminText.textContent = `Logged in as ${context.role}. Status: ${statusText}.`;
  return context;
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
      hideAuthProgress();
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
      showAuthProgress(
        "Loading your workspace",
        "Fetching profile, permissions, and dashboard data...",
      );
      const context = await loadSessionContext();
      if (state.authLoginInFlight && context) toast("Login successful");
      if (state.authLoginInFlight && !context) toast("Complete account setup by choosing Student or Provider.", "error");
      state.authLoginInFlight = false;
      hideAuthProgress();
      if (!context) return;
    } catch (err) {
      state.authLoginInFlight = false;
      hideAuthProgress();
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
    if (event.key === "4") activateStudentSubView("live");
    if (event.key === "5") activateStudentSubView("certifications");
  }
}

function bindEvents() {
  initializeLiveIconButtons();
  refreshLiveFullscreenButton();
  window.addEventListener("resize", () => {
    if (state.liveRoom.participantsOpen) positionLiveParticipantsMenu();
  });
  el.liveRoomStageShell?.addEventListener("mousemove", () => {
    pokeLiveControlDock();
  });
  el.liveRoomStageShell?.addEventListener("pointermove", () => {
    pokeLiveControlDock();
  });
  el.liveRoomStageShell?.addEventListener("touchstart", () => {
    pokeLiveControlDock();
  }, { passive: true });
  el.liveRoomControlDock?.addEventListener("mouseenter", () => {
    state.liveRoom.controlDockPointerInside = true;
    setLiveControlDockVisibility(true);
    clearLiveControlDockIdleTimer();
  });
  el.liveRoomControlDock?.addEventListener("mouseleave", () => {
    state.liveRoom.controlDockPointerInside = false;
    scheduleLiveControlDockAutoHide();
  });
  el.liveRoomControlDock?.addEventListener("focusin", () => {
    state.liveRoom.controlDockPointerInside = true;
    setLiveControlDockVisibility(true);
    clearLiveControlDockIdleTimer();
  });
  el.liveRoomControlDock?.addEventListener("focusout", () => {
    state.liveRoom.controlDockPointerInside = false;
    scheduleLiveControlDockAutoHide();
  });
  el.showSignupBtn?.addEventListener("click", () => showAuthMode("signup"));
  el.showLoginBtn?.addEventListener("click", () => showAuthMode("login"));

  $("loginBtn")?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    const email = el.loginEmail.value.trim().toLowerCase();
    const rawPassword = el.loginPassword.value;
    const trimmedPassword = rawPassword.trim();
    try {
      state.authLoginInFlight = true;
      showAuthProgress("Signing you in", "Verifying email and password...");
      let loggedIn = false;
      let breakglassErrorMessage = "";
      try {
        await signInWithEmailAndPassword(state.auth, email, rawPassword);
        loggedIn = true;
      } catch (primaryErr) {
        if (String(primaryErr?.code || "").includes("auth/invalid-credential")) {
          // Common operator mistake: copied password with leading/trailing spaces.
          if (rawPassword !== trimmedPassword) {
            try {
              await signInWithEmailAndPassword(state.auth, email, trimmedPassword);
              loggedIn = true;
              toast("Removed leading/trailing spaces from password input.");
            } catch {}
          }
          // Break-glass admin login: admin email + recovery key in password field.
          if (!loggedIn) {
            try {
              const out = await api("POST", "/auth/admin/breakglass-login", { email, password: rawPassword }, false);
              if (out?.custom_token) {
                await signInWithCustomToken(state.auth, out.custom_token);
                loggedIn = true;
              } else if (out?.password_login_ready) {
                await signInWithEmailAndPassword(state.auth, email, rawPassword);
                loggedIn = true;
              }
            } catch (breakglassErr) {
              breakglassErrorMessage = String(breakglassErr?.message || breakglassErr || "").trim();
            }
          }
          if (!loggedIn && email === "admin@certora.in") {
            if (breakglassErrorMessage) {
              throw new Error(
                `Admin break-glass login failed. ${breakglassErrorMessage}`,
              );
            }
            throw new Error(
              "Admin break-glass login failed. Verify latest deployment and ADMIN_RECOVERY_KEY env variable.",
            );
          }
          if (!loggedIn) throw primaryErr;
        } else {
          throw primaryErr;
        }
      }
      if (state.authLoginFallbackTimer) clearTimeout(state.authLoginFallbackTimer);
      state.authLoginFallbackTimer = setTimeout(async () => {
        if (!state.authLoginInFlight || !state.auth?.currentUser) return;
        try {
          showAuthProgress("Loading your workspace", "Preparing your dashboard...");
          const context = await loadSessionContext();
          if (context) toast("Login successful");
        } catch (err) {
          toast(formatAuthError(err, "Session load failed"), "error");
        } finally {
          state.authLoginInFlight = false;
          hideAuthProgress();
        }
      }, 250);
    } catch (err) {
      state.authLoginInFlight = false;
      hideAuthProgress();
      toast(formatAuthError(err, "Login failed"), "error");
      log("login_error", String(err));
    }
  });

  $("googleBtn")?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    try {
      state.authLoginInFlight = true;
      showAuthProgress("Signing in with Google", "Authenticating your Google account...");
      const provider = new GoogleAuthProvider();
      await signInWithPopup(state.auth, provider);
      if (state.authLoginFallbackTimer) clearTimeout(state.authLoginFallbackTimer);
      state.authLoginFallbackTimer = setTimeout(async () => {
        if (!state.authLoginInFlight || !state.auth?.currentUser) return;
        try {
          showAuthProgress("Loading your workspace", "Preparing your dashboard...");
          const context = await loadSessionContext();
          if (context) toast("Login successful");
        } catch (err) {
          toast(formatAuthError(err, "Session load failed"), "error");
        } finally {
          state.authLoginInFlight = false;
          hideAuthProgress();
        }
      }, 250);
    } catch (err) {
      state.authLoginInFlight = false;
      hideAuthProgress();
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
      const activeEmail = String(state.auth?.currentUser?.email || "").trim().toLowerCase();
      if (activeEmail && activeEmail !== email) {
        await signOut(state.auth);
      }
      try {
        localStorage.setItem("certora_signup_role_intent", role);
      } catch {}
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
      let context = await loadSessionContext();
      if (context?.role && context.role !== role) {
        await api("POST", "/auth/register-role", { full_name: name, role });
        await cred.user.getIdToken(true).catch(() => {});
        context = await loadSessionContext();
      }
      try {
        localStorage.removeItem("certora_signup_role_intent");
      } catch {}
      toast("Account created");
    } catch (err) {
      state.authRoleSetupInFlight = false;
      const requestedEmail = String(el.signupEmail?.value || "").trim().toLowerCase();
      const currentEmail = String(state.auth?.currentUser?.email || "").trim().toLowerCase();
      if (requestedEmail && currentEmail && currentEmail === requestedEmail) {
        try {
          const fallbackRole = String(localStorage.getItem("certora_signup_role_intent") || "").trim().toLowerCase();
          let context = await loadSessionContext();
          if (["student", "provider"].includes(fallbackRole) && context?.role && context.role !== fallbackRole) {
            await api("POST", "/auth/register-role", { full_name: el.signupName?.value?.trim() || "User", role: fallbackRole });
            await state.auth.currentUser.getIdToken(true).catch(() => {});
            context = await loadSessionContext();
          }
          try {
            localStorage.removeItem("certora_signup_role_intent");
          } catch {}
          toast("Account created");
          return;
        } catch {}
      }
      toast(formatAuthError(err, "Signup failed"), "error");
      log("signup_error", String(err));
    }
  });

  el.forgotPasswordBtn?.addEventListener("click", async () => {
    if (!ensureAuthReady()) return;
    const email = String(el.loginEmail?.value || "").trim().toLowerCase();
    if (!email) {
      toast("Enter your email first, then click Forgot Password.", "error");
      return;
    }
    try {
      await sendPasswordResetEmail(state.auth, email);
      toast("Password reset email sent. Check inbox/spam.");
    } catch (err) {
      toast(formatAuthError(err, "Password reset failed"), "error");
      log("password_reset_error", String(err));
    }
  });

  el.logoutBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        stopAdminPolling();
        hideAuthProgress();
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
      hideAuthProgress();
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
  el.adminRecoveryBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      runAdminRecoveryFlow().catch(() => {});
    });
  });
  el.changePasswordBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      runSelfPasswordChangeFlow().catch(() => {});
    });
  });
  el.adminPasswordBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      runAdminSetUserPasswordFlow().catch(() => {});
    });
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
  $("scvSaveRatingBtn")?.addEventListener("click", async () => {
    const courseId = Number(state.studentActiveCourseId || 0);
    if (!courseId) {
      toast("Open a course first", "error");
      return;
    }
    try {
      const payload = {
        valuable_time_rating: Number(el.scvRateValue?.value || 5),
        content_quality_rating: Number(el.scvRateContent?.value || 5),
        instructor_clarity_rating: Number(el.scvRateClarity?.value || 5),
        practical_usefulness_rating: Number(el.scvRatePractical?.value || 5),
        comment: String(el.scvRatingComment?.value || "").trim() || null,
      };
      await api("POST", `/student/courses/${courseId}/feedback`, payload);
      if (el.scvRatingStatus) el.scvRatingStatus.textContent = "Rating saved.";
      toast("Course rating submitted");
      await refreshStudentDashboard().catch(() => {});
      await openStudentCourseViewer(courseId);
    } catch (err) {
      toast(err?.message || "Failed to submit rating", "error");
    }
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
  $("refreshStudentDashboardBtn")?.addEventListener("click", () =>
    Promise.all([refreshStudentDashboard(), refreshStudentCertifications(), refreshStudentLiveClasses()]).catch(() => toast("Failed to refresh dashboard", "error")));
  $("refreshStudentCertificationsBtn")?.addEventListener("click", () =>
    refreshStudentCertifications().catch(() => toast("Failed to refresh certifications", "error")));
  $("refreshProviderAssessmentsBtn")?.addEventListener("click", () => refreshProviderAssessments().catch(() => toast("Failed to refresh assessments", "error")));
  $("refreshProviderCommentsBtn")?.addEventListener("click", () => refreshProviderFeedback().catch(() => toast("Failed to refresh feedback", "error")));
  $("refreshProviderNotificationsBtn")?.addEventListener("click", () => refreshProviderNotifications().catch(() => toast("Failed to refresh notifications", "error")));
  $("refreshProviderCertsBtn")?.addEventListener("click", () => refreshProviderCertifications().catch(() => toast("Failed to refresh certifications", "error")));
  $("refreshProviderLiveClassesBtn")?.addEventListener("click", () => refreshProviderLiveClasses().catch(() => toast("Failed to refresh live classes", "error")));
  $("refreshStudentLiveClassesBtn")?.addEventListener("click", () => refreshStudentLiveClasses().catch(() => toast("Failed to refresh live classes", "error")));
  $("openLiveClassSchedulerBtn")?.addEventListener("click", () => {
    if (el.providerLiveCreateScreen?.classList.contains("hidden")) {
      resetProviderLiveScheduler();
      providerLiveSchedulerSetVisible(true);
    } else {
      providerLiveSchedulerSetVisible(false);
    }
  });
  $("closeLiveClassSchedulerBtn")?.addEventListener("click", () => {
    providerLiveSchedulerSetVisible(false);
    resetProviderLiveScheduler();
  });
  $("cancelLiveClassSchedulerBtn")?.addEventListener("click", () => {
    providerLiveSchedulerSetVisible(false);
    resetProviderLiveScheduler();
  });
  $("createLiveClassBtn")?.addEventListener("click", () => {
    submitProviderLiveSchedule().catch((err) => toast(err?.message || "Failed to save live class schedule", "error"));
  });
  $("liveClassMode")?.addEventListener("change", () => applyProviderLiveModeUi());
  $("liveClassRecurrencePattern")?.addEventListener("change", () => applyProviderLiveRecurrenceUi());
  $("liveClassGenerateAgendaBtn")?.addEventListener("click", () => {
    if (el.liveClassAiOutput) el.liveClassAiOutput.value = generateLiveClassAiDraft("agenda");
  });
  $("liveClassGeneratePollBtn")?.addEventListener("click", () => {
    if (el.liveClassAiOutput) el.liveClassAiOutput.value = generateLiveClassAiDraft("poll");
  });
  $("liveClassGenerateSummaryBtn")?.addEventListener("click", () => {
    if (el.liveClassAiOutput) el.liveClassAiOutput.value = generateLiveClassAiDraft("summary");
  });
  $("liveClassAppendAiBtn")?.addEventListener("click", () => {
    const ai = String(el.liveClassAiOutput?.value || "").trim();
    if (!ai) return;
    const current = String(el.liveClassDescription?.value || "").trim();
    el.liveClassDescription.value = current ? `${current}\n\n${ai}` : ai;
    toast("AI draft appended to description");
  });
  $("liveClassReplaceAiBtn")?.addEventListener("click", () => {
    const ai = String(el.liveClassAiOutput?.value || "").trim();
    if (!ai) return;
    el.liveClassDescription.value = ai;
    toast("Description replaced with AI draft");
  });
  $("leaveLiveRoomBtn")?.addEventListener("click", () => {
    leaveLiveClassroom().catch(() => toast("Failed to leave room", "error"));
  });
  $("liveRoomToggleToolsBtn")?.addEventListener("click", () => {
    toggleLiveDrawer("tools");
  });
  $("liveRoomToggleChatBtn")?.addEventListener("click", () => {
    toggleLiveDrawer("chat");
  });
  $("liveRoomReactBtn")?.addEventListener("click", () => {
    toggleLiveDrawer("reaction");
  });
  $("liveRoomFullscreenBtn")?.addEventListener("click", () => {
    const target = el.liveRoomStageShell || el.liveClassroomScreen;
    if (!target) return;
    if (document.fullscreenElement === target) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      target.requestFullscreen?.().catch(() => {});
    }
  });
  $("liveRoomVideoStartBtn")?.addEventListener("click", () => {
    startLiveCamera()
      .then(() => toast("Camera started"))
      .catch((err) => toast(err?.message || "Unable to start camera", "error"));
  });
  $("liveRoomVideoStopBtn")?.addEventListener("click", () => {
    stopLiveCamera()
      .then(() => toast("Camera stopped"))
      .catch((err) => toast(err?.message || "Unable to stop camera", "error"));
  });
  $("liveRoomToggleMicBtn")?.addEventListener("click", () => {
    toggleLiveMic()
      .catch((err) => toast(err?.message || "Unable to toggle microphone", "error"));
  });
  $("liveRoomShareScreenBtn")?.addEventListener("click", () => {
    startLiveScreenShare()
      .then((started) => {
        if (started) toast("Screen sharing started");
      })
      .catch((err) => toast(err?.message || "Unable to share screen", "error"));
  });
  $("liveRoomParticipantsBtn")?.addEventListener("click", () => {
    toggleLiveDrawer("participants");
  });
  $("liveRoomStopShareOverlayBtn")?.addEventListener("click", () => {
    stopLiveScreenShare()
      .then(() => toast("Screen sharing stopped"))
      .catch((err) => toast(err?.message || "Unable to stop screen share", "error"));
  });
  $("liveRoomStopShareBtn")?.addEventListener("click", () => {
    stopLiveScreenShare()
      .then(() => toast("Screen sharing stopped"))
      .catch((err) => toast(err?.message || "Unable to stop screen share", "error"));
  });
  $("liveRoomSendChatBtn")?.addEventListener("click", () => {
    sendLiveRoomChatMessage("chat", el.liveRoomChatInput?.value || "").catch((err) => toast(err?.message || "Failed to send message", "error"));
  });
  $("liveRoomChatInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    sendLiveRoomChatMessage("chat", el.liveRoomChatInput?.value || "").catch((err) => toast(err?.message || "Failed to send message", "error"));
  });
  document.querySelectorAll("[data-live-reaction]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const reaction = String(btn.dataset.liveReaction || "").trim();
      if (!reaction) return;
      sendLiveRoomChatMessage("reaction", reaction)
        .then(() => {
          burstLiveReactionOnStage(reaction, `local:${Date.now()}:${reaction}`);
        })
        .catch((err) => toast(err?.message || "Failed to send reaction", "error"));
      setLiveDrawerState("reaction", false);
    });
  });
  document.addEventListener("fullscreenchange", refreshLiveFullscreenButton);
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const insideReaction = target.closest("#liveRoomReactionMenu") || target.closest("#liveRoomReactBtn");
    if (!insideReaction && state.liveRoom.reactionOpen) setLiveDrawerState("reaction", false);
    const insideParticipants = target.closest("#liveRoomParticipantsMenu") || target.closest("#liveRoomParticipantsBtn");
    if (!insideParticipants && state.liveRoom.participantsOpen) setLiveDrawerState("participants", false);
    const insideTools = target.closest("#liveRoomToolsPanel") || target.closest("#liveRoomToggleToolsBtn");
    if (!insideTools && state.liveRoom.toolsOpen) setLiveDrawerState("tools", false);
  });
  $("liveRoomSaveBoardBtn")?.addEventListener("click", () => {
    const sessionId = Number(state.liveRoom.sessionId || 0);
    if (!sessionId || state.liveRoom.role !== "provider") return;
    api("POST", `/provider/workspace/live-classes/${sessionId}/tools/board`, {
      board_text: String(el.liveRoomBoardText?.value || ""),
    })
      .then(() => {
        state.liveRoom.boardDraftDirty = false;
      })
      .then(() => refreshLiveRoomState())
      .then(() => toast("Whiteboard updated"))
      .catch((err) => toast(err?.message || "Failed to save board", "error"));
  });
  $("liveRoomBoardText")?.addEventListener("input", () => {
    const draft = String(el.liveRoomBoardText?.value || "");
    state.liveRoom.boardDraftDirty = draft !== String(state.liveRoom.boardServerText || "");
  });
  $("liveRoomOpenWhiteboardBtn")?.addEventListener("click", () => {
    setLiveSidePanel("whiteboard", true);
  });
  $("liveRoomOpenBreakoutBtn")?.addEventListener("click", () => {
    setLiveSidePanel("breakout", true);
  });
  $("liveRoomOpenPollBtn")?.addEventListener("click", () => {
    setLiveSidePanel("poll-composer", true);
  });
  $("liveRoomOpenQaBtn")?.addEventListener("click", () => {
    setLiveSidePanel("qa", true);
  });
  $("liveRoomShareWhiteboardBtn")?.addEventListener("click", () => {
    setLiveSidePanel("whiteboard", true);
    broadcastLiveToolPanel("whiteboard", true).catch(() => {});
    toast("Whiteboard opened for everyone");
  });
  $("liveRoomShareBreakoutBtn")?.addEventListener("click", () => {
    setLiveSidePanel("breakout", true);
    broadcastLiveToolPanel("breakout", true).catch(() => {});
    toast("Breakout panel opened for everyone");
  });
  $("liveRoomAddQaBtn")?.addEventListener("click", () => {
    const text = String(el.liveRoomQaInput?.value || "").trim();
    if (!text) return;
    state.liveRoom.qaItems.push({ text, author: state.context?.name || "Host", ts: Date.now() });
    if (el.liveRoomQaInput) el.liveRoomQaInput.value = "";
    renderLiveQaList();
  });
  $("liveRoomShareQaBtn")?.addEventListener("click", () => {
    const latest = state.liveRoom.qaItems[state.liveRoom.qaItems.length - 1];
    if (!latest?.text) return toast("Add a Q&A item first", "error");
    setLiveSidePanel("qa", true);
    sendLiveSignal("qa_add", { text: latest.text, author: latest.author || "Host" }).catch(() => {});
    broadcastLiveToolPanel("qa", true).catch(() => {});
    toast("Q&A shared");
  });
  document.querySelectorAll("[data-live-side-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setLiveSidePanel("", false);
      if (state.liveRoom.role === "provider") broadcastLiveToolPanel("", false).catch(() => {});
    });
  });
  $("liveRoomRaiseHandBtn")?.addEventListener("click", () => {
    const sessionId = Number(state.liveRoom.sessionId || 0);
    if (!sessionId || state.liveRoom.role !== "student") return;
    api("POST", `/student/live-classes/${sessionId}/raise-hand`)
      .then(() => refreshLiveRoomState())
      .catch((err) => toast(err?.message || "Failed to update hand raise", "error"));
  });
  $("liveRoomStartPollBtn")?.addEventListener("click", () => {
    const sessionId = Number(state.liveRoom.sessionId || 0);
    if (!sessionId || state.liveRoom.role !== "provider") return;
    const question = String(el.liveRoomPollQuestion?.value || "").trim();
    const options = String(el.liveRoomPollOptions?.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    api("POST", `/provider/workspace/live-classes/${sessionId}/tools/poll`, { question, options })
      .then(() => {
        if (el.liveRoomPollQuestion) el.liveRoomPollQuestion.value = "";
        if (el.liveRoomPollOptions) el.liveRoomPollOptions.value = "";
        return refreshLiveRoomState();
      })
      .then(() => {
        setLiveSidePanel("poll", true);
        broadcastLiveToolPanel("poll", true).catch(() => {});
        toast("Poll shared");
      })
      .catch((err) => toast(err?.message || "Failed to start poll", "error"));
  });
  $("liveRoomClosePollBtn")?.addEventListener("click", () => {
    const sessionId = Number(state.liveRoom.sessionId || 0);
    if (!sessionId || state.liveRoom.role !== "provider") return;
    api("POST", `/provider/workspace/live-classes/${sessionId}/tools/poll/close`)
      .then(() => refreshLiveRoomState())
      .then(() => {
        broadcastLiveToolPanel("", false).catch(() => {});
        setLiveSidePanel("", false);
        toast("Poll closed");
      })
      .catch((err) => toast(err?.message || "Failed to close poll", "error"));
  });
  $("liveRoomStartTimerBtn")?.addEventListener("click", () => {
    startLiveClassTimer();
    toast("Class timer started");
  });
  $("liveRoomStopTimerBtn")?.addEventListener("click", () => {
    stopLiveClassTimer();
    toast("Class timer stopped");
  });
  $("liveRoomAiExplainBtn")?.addEventListener("click", () => {
    const topic = String(el.liveRoomAiTopicInput?.value || "").trim();
    if (!topic) return toast("Enter a topic first", "error");
    const draft = generateLiveTopicExplainer(topic);
    const existing = String(el.liveRoomBoardText?.value || "").trim();
    el.liveRoomBoardText.value = existing ? `${existing}\n\n${draft}` : draft;
    state.liveRoom.boardDraftDirty = true;
    toast("AI explanation added to board. Save board to publish.");
  });
  $("liveRoomPickStudentBtn")?.addEventListener("click", () => {
    const participants = Array.from(el.liveRoomParticipantsList?.querySelectorAll(".item strong") || [])
      .map((n) => String(n.textContent || "").trim())
      .filter(Boolean);
    if (!participants.length) return toast("No participants available", "error");
    const chosen = participants[Math.floor(Math.random() * participants.length)];
    toast(`Selected student: ${chosen}`);
    sendLiveRoomChatMessage("announcement", `Random pick: ${chosen}, please answer.`).catch(() => {});
  });
  $("liveRoomExportAttendanceBtn")?.addEventListener("click", () => {
    exportLiveAttendanceCsv();
  });
  $("liveRoomWaitingToggle")?.addEventListener("change", () => {
    runHostAction("toggle_waiting_room", { enabled: Boolean(el.liveRoomWaitingToggle?.checked) })
      .catch((err) => toast(err?.message || "Failed to update waiting room", "error"));
  });
  $("liveRoomAssignBreakoutBtn")?.addEventListener("click", () => {
    const uid = Number(state.liveRoom.selectedParticipantId || 0);
    const room = String(el.liveRoomBreakoutName?.value || "").trim();
    if (!uid) return toast("Select a participant first", "error");
    if (!room) return toast("Enter breakout room name", "error");
    runHostAction("assign_breakout", { target_user_id: uid, room })
      .then(() => toast("Breakout assigned"))
      .catch((err) => toast(err?.message || "Failed to assign breakout", "error"));
  });
  $("liveRoomClearBreakoutsBtn")?.addEventListener("click", () => {
    runHostAction("clear_breakouts")
      .then(() => toast("Breakout rooms closed"))
      .catch((err) => toast(err?.message || "Failed to close breakouts", "error"));
  });
  $("liveRoomStartRecordingBtn")?.addEventListener("click", () => {
    startLiveRecording()
      .then(() => toast("Recording started"))
      .catch((err) => toast(err?.message || "Failed to start recording", "error"));
  });
  $("liveRoomPauseRecordingBtn")?.addEventListener("click", () => {
    try {
      toggleLiveRecordingPause();
    } catch (err) {
      toast(err?.message || "Failed to pause/resume recording", "error");
    }
  });
  $("liveRoomStopRecordingBtn")?.addEventListener("click", () => {
    stopLiveRecording()
      .then(() => toast("Recording stopped"))
      .catch((err) => toast(err?.message || "Failed to stop recording", "error"));
  });
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

