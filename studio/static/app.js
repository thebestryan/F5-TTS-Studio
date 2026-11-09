const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LAST_JOB_KEY = "f5studio.job";
const LAST_REF_KEY = "f5studio.ref";
const SETTINGS_KEY = "f5studio.settings";
const DRAFT_KEY = "f5studio.draft";
const REFTEXT_KEY = "f5studio.reftext";

const GENERATION_KEYS = new Set([
  "nfe_step", "cfg_strength", "sway_sampling_coef", "speed", "seed", "target_rms", "emphasis_slowdown",
]);
const BUILD_KEYS = new Set(["max_chars", "pause_ms", "paragraph_pause_ms"]);
const POST_KEYS = new Set([
  "post_speed", "post_pitch", "normalize_loudness", "crossfade_ms", "trim_silence", "emphasis_gain_db",
]);
const ACTIVE_STATUSES = new Set(["queued", "generating", "assembling"]);

const state = {
  config: null,
  health: null,
  job: null,
  settings: {},
  reference: null,
  references: [],
  selection: null,
  drag: null,
  audioKey: null,
  audioType: null,
  audioId: null,
  refPosition: null,
  playing: false,
  pollTimer: null,
  polling: false,
  settingsTimer: null,
  settingsChain: Promise.resolve(),
  chunkTimers: new Map(),
  dirtyChunks: new Set(),
  finalDirty: false,
  lastFinalVersion: null,
  rebuildNeeded: false,
  pacingDirty: false,
  voiceDirty: false,
  clearVoiceOnIdle: false,
  lastCurrent: null,
  lastError: null,
  toastTimer: null,
  healthTimer: null,
  draftTimer: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheEls();
  bindStatic();
  try {
    const [config, health] = await Promise.all([api("/api/config"), api("/api/health")]);
    state.config = config;
    state.health = health;
    const restored = readJson(localStorage.getItem(SETTINGS_KEY), {});
    state.settings = { ...config.defaults, ...restored };
    syncControls();
  } catch (err) {
    toast(`Could not reach the studio server: ${err.message}`, true);
    return;
  }
  bindSettings();
  updateHealthChip();
  state.healthTimer = setInterval(refreshHealth, 4000);
  await Promise.all([loadReferences(), refreshSessions()]);
  const lastId = localStorage.getItem(LAST_JOB_KEY);
  if (lastId) {
    try {
      const job = await api(`/api/jobs/${lastId}`);
      loadJob(job);
      return;
    } catch {
      localStorage.removeItem(LAST_JOB_KEY);
    }
  }
  const lastRef = localStorage.getItem(LAST_REF_KEY);
  if (lastRef) {
    const known = state.references.find((r) => r.id === lastRef);
    if (known) setReference(known);
  }
  const draft = localStorage.getItem(DRAFT_KEY) || "";
  if (draft) {
    els.script.value = draft;
    updateScriptStats();
  }
  const savedRefText = localStorage.getItem(REFTEXT_KEY) || "";
  if (savedRefText && state.reference) els.refText.value = savedRefText;
  updateRefTextCount();
  updateBanners();
  renderChunks();
  renderProgress();
  renderFinal();
  requestAnimationFrame(drawAll);
}

function cacheEls() {
  const ids = [
    "modelChip", "modelDot", "modelLabel", "deviceChip", "jobChip", "newSessionBtn", "helpBtn", "helpDialog",
    "helpClose", "dropzone", "refFile", "dropIdle", "dropLoaded", "refCanvas", "refPlayBtn", "refTime", "refFormat",
    "refName", "refChangeBtn", "refWarning", "selLabel", "trimBtn", "refText", "transcribeBtn", "asrLang",
    "refTextCount", "txtFile", "clearScript", "script", "wordCount", "charCount", "scriptTimeEstimate", "buildBtn",
    "buildHint", "rebuildBanner", "rebuildText", "rebuildBtn", "cancelBtn", "regenAllBtn", "generateBtn",
    "progressWrap", "progressText", "etaText", "progressBar", "chunkList", "chunkEmpty", "chunksMeta", "resetSettings",
    "nfe_step", "cfg_strength", "sway_sampling_coef", "speed", "target_rms", "seed", "diceBtn", "autoSeedBtn",
    "voiceDirtyNote", "max_chars", "pause_ms", "paragraph_pause_ms", "crossfade_ms", "emphasis_slowdown",
    "emphasis_gain_db", "trim_silence", "auto_assemble", "post_speed", "post_pitch", "normalize_loudness",
    "finalBadge", "finalEmpty", "finalLoaded", "finalCanvas", "finalPlayBtn", "finalTime", "dlWav", "dlMp3",
    "finalDuration", "dlRaw", "finalStale", "assembleBtn", "sessionList", "toast", "audioEl",
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function bindStatic() {
  els.helpBtn.addEventListener("click", () => els.helpDialog.showModal());
  els.helpClose.addEventListener("click", () => els.helpDialog.close());
  els.helpDialog.addEventListener("click", (e) => {
    if (e.target === els.helpDialog) els.helpDialog.close();
  });

  els.dropzone.addEventListener("click", (e) => {
    if (e.target.closest("#dropLoaded, button, a, input")) return;
    els.refFile.click();
  });
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.target !== els.dropzone) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.refFile.click();
    }
  });
  els.refFile.addEventListener("change", () => {
    const file = els.refFile.files?.[0];
    if (file) uploadReference(file);
    els.refFile.value = "";
  });
  els.refChangeBtn.addEventListener("click", () => els.refFile.click());
  ["dragenter", "dragover"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadReference(file);
  });

  els.refPlayBtn.addEventListener("click", () => {
    if (!state.reference) return;
    toggleAudio("ref", null, referenceUrl(), els.refPlayBtn);
  });

  els.trimBtn.addEventListener("click", trimSelection);
  els.transcribeBtn.addEventListener("click", autoTranscribe);
  els.refText.addEventListener("input", () => {
    updateRefTextCount();
    localStorage.setItem(REFTEXT_KEY, els.refText.value);
    updateBanners();
  });
  els.asrLang.addEventListener("change", () => localStorage.setItem("f5studio.asrlang", els.asrLang.value));
  const savedLang = localStorage.getItem("f5studio.asrlang");
  if (savedLang) els.asrLang.value = savedLang;

  els.script.addEventListener("input", () => {
    updateScriptStats();
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => localStorage.setItem(DRAFT_KEY, els.script.value), 350);
    updateBanners();
  });
  els.txtFile.addEventListener("change", async () => {
    const file = els.txtFile.files?.[0];
    if (!file) return;
    try {
      els.script.value = await file.text();
      updateScriptStats();
      updateBanners();
      toast(`Loaded ${file.name}`);
    } catch (err) {
      toast(`Could not read text file: ${err.message}`, true);
    }
    els.txtFile.value = "";
  });
  $$("[data-insert]").forEach((btn) =>
    btn.addEventListener("click", () => insertAtCursor(els.script, btn.dataset.insert))
  );
  els.clearScript.addEventListener("click", () => {
    if (els.script.value && !confirm("Clear the script?")) return;
    els.script.value = "";
    updateScriptStats();
    updateBanners();
    els.script.focus();
  });

  els.buildBtn.addEventListener("click", () => buildJob({ autoGenerate: false }));
  els.rebuildBtn.addEventListener("click", () => buildJob({ autoGenerate: false }));
  els.generateBtn.addEventListener("click", () => startGenerate({ onlyPending: true, newSeed: false }));
  els.regenAllBtn.addEventListener("click", () => {
    if (!state.job) return;
    const hasAudio = state.job.chunks.some((c) => c.status === "done");
    if (hasAudio && !confirm("Regenerate every enabled chunk with new seeds? Existing takes will be replaced.")) return;
    state.clearVoiceOnIdle = true;
    startGenerate({ onlyPending: false, newSeed: true });
  });
  els.cancelBtn.addEventListener("click", cancelGeneration);
  els.assembleBtn.addEventListener("click", assembleNow);
  els.newSessionBtn.addEventListener("click", newSession);
  els.resetSettings.addEventListener("click", resetSettings);
  els.diceBtn.addEventListener("click", () => {
    state.settings.seed = Math.floor(Math.random() * 2147483000);
    els.seed.value = state.settings.seed;
    onSettingChanged("seed", state.settings.seed);
  });
  els.autoSeedBtn.addEventListener("click", () => {
    state.settings.seed = -1;
    els.seed.value = -1;
    onSettingChanged("seed", -1);
  });
  $$("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.settings.nfe_step = Number(btn.dataset.preset);
      els.nfe_step.value = state.settings.nfe_step;
      onSettingChanged("nfe_step", state.settings.nfe_step);
      toast(`NFE steps set to ${btn.dataset.preset}`);
    })
  );

  els.finalPlayBtn.addEventListener("click", () => {
    if (!state.job?.final) return;
    toggleAudio("final", state.job.final.version || 0, finalUrl("wav"), els.finalPlayBtn);
  });

  els.audioEl.addEventListener("play", () => {
    state.playing = true;
    updatePlayButtons();
    tickPlayback();
  });
  els.audioEl.addEventListener("pause", () => {
    state.playing = false;
    if (state.audioType === "ref") state.refPosition = els.audioEl.currentTime;
    updatePlayButtons();
  });
  els.audioEl.addEventListener("ended", () => {
    state.playing = false;
    if (state.audioType === "ref") state.refPosition = els.audioEl.currentTime;
    updatePlayButtons();
    drawAll();
  });
  els.audioEl.addEventListener("timeupdate", () => {
    if (state.audioType === "ref") state.refPosition = els.audioEl.currentTime;
    updateTimeLabels();
  });
  els.audioEl.addEventListener("loadedmetadata", () => updateTimeLabels());

  window.addEventListener("resize", () => requestAnimationFrame(drawAll));
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      if (!state.job) buildJob({ autoGenerate: true });
      else startGenerate({ onlyPending: true, newSeed: false });
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.job) assembleNow();
    } else if (e.key === "Escape") {
      els.audioEl.pause();
    }
  });

  setupSelection(els.refCanvas);
  els.finalCanvas.addEventListener("click", (e) => {
    if (!state.job?.final) return;
    const rect = els.finalCanvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekFinal(fraction);
  });

  els.sessionList.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    const row = e.target.closest("[data-session]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      if (!confirm("Delete this session and its audio from disk?")) return;
      try {
        await api(`/api/jobs/${id}`, { method: "DELETE" });
        if (state.job?.id === id) newSession(true);
        await refreshSessions();
        toast("Session deleted");
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    if (row) {
      try {
        const job = await api(`/api/jobs/${row.dataset.session}`);
        loadJob(job);
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
}

function bindSettings() {
  $$("[data-setting]").forEach((el) => {
    const handler = () => onSettingChanged(el.dataset.setting, readControl(el));
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  });
}

function readControl(el) {
  if (el.type === "checkbox") return el.checked;
  const value = Number(el.value);
  if (!Number.isFinite(value)) return state.settings[el.dataset.setting];
  return el.dataset.kind === "int" ? Math.round(value) : value;
}

function syncControls() {
  $$("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    const value = state.settings[key];
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value;
    updateOutput(key);
  });
}

function updateOutput(key) {
  const out = document.querySelector(`[data-out="${key}"]`);
  if (!out) return;
  const formatters = {
    nfe_step: (v) => `${Math.round(v)}`,
    cfg_strength: (v) => Number(v).toFixed(1),
    sway_sampling_coef: (v) => Number(v).toFixed(1),
    speed: (v) => Number(v).toFixed(2),
    target_rms: (v) => Number(v).toFixed(2),
    max_chars: (v) => `${Math.round(v)} chars`,
    pause_ms: (v) => `${Math.round(v)} ms`,
    paragraph_pause_ms: (v) => `${Math.round(v)} ms`,
    crossfade_ms: (v) => `${Math.round(v)} ms`,
    emphasis_slowdown: (v) => `${Number(v).toFixed(2)}×`,
    emphasis_gain_db: (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)} dB`,
    post_speed: (v) => `${Number(v).toFixed(2)}×`,
    post_pitch: (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)} st`,
  };
  const fmt = formatters[key];
  out.textContent = fmt ? fmt(state.settings[key]) : state.settings[key];
}

function onSettingChanged(key, value) {
  state.settings[key] = value;
  updateOutput(key);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  if (!state.job) return;
  if (GENERATION_KEYS.has(key) && state.job.chunks.some((c) => c.status === "done")) {
    state.voiceDirty = true;
    els.voiceDirtyNote.hidden = false;
  }
  if (BUILD_KEYS.has(key)) state.pacingDirty = true;
  if (POST_KEYS.has(key)) state.finalDirty = true;
  updateBanners();
  renderFinal();
  scheduleSettingsPatch();
}

function scheduleSettingsPatch() {
  clearTimeout(state.settingsTimer);
  state.settingsTimer = setTimeout(() => {
    state.settingsTimer = null;
    patchSettings();
  }, 450);
}

function patchSettings() {
  if (!state.job) return Promise.resolve();
  const id = state.job.id;
  const payload = { ...state.settings };
  state.settingsChain = state.settingsChain
    .catch(() => {})
    .then(async () => {
      if (!state.job || state.job.id !== id) return;
      const job = await api(`/api/jobs/${id}`, {
        method: "PATCH",
        body: { settings: payload },
      });
      if (state.job && state.job.id === id) applyJobUpdate(job);
    })
    .catch((err) => toast(err.message, true));
  return state.settingsChain;
}

async function flushSettings() {
  if (state.settingsTimer) {
    clearTimeout(state.settingsTimer);
    state.settingsTimer = null;
    await patchSettings();
  } else {
    await state.settingsChain.catch(() => {});
  }
}

function resetSettings() {
  if (!state.config) return;
  state.settings = { ...state.config.defaults };
  syncControls();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  if (state.job) {
    scheduleSettingsPatch();
    state.finalDirty = true;
    updateBanners();
    renderFinal();
  }
  toast("Settings reset to defaults");
}

async function api(path, { method = "GET", body, form } = {}) {
  const options = { method, headers: {} };
  if (form) {
    options.body = form;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res;
}

async function refreshHealth() {
  try {
    state.health = await api("/api/health");
    updateHealthChip();
  } catch {}
}

function updateHealthChip() {
  const health = state.health;
  if (!health) return;
  els.modelChip.classList.remove("ready", "loading", "error");
  if (health.status === "ready") {
    els.modelChip.classList.add("ready");
    els.modelLabel.textContent = "F5-TTS ready";
  } else if (health.status === "loading") {
    els.modelChip.classList.add("loading");
    els.modelLabel.textContent = "Loading F5-TTS…";
  } else if (health.status === "error") {
    els.modelChip.classList.add("error");
    els.modelLabel.textContent = "Model error";
  } else {
    els.modelLabel.textContent = "Model idle";
  }
  const backend = (health.backend || health.device || "cpu").toUpperCase();
  els.modelChip.title = `${health.model} · ${health.device} (${backend}) · torch ${health.torch}${health.error ? ` · ${health.error}` : ""}`;
  els.deviceChip.textContent = `${backend} · ${(health.sample_rate / 1000).toFixed(0)} kHz`;
  els.deviceChip.title = `PyTorch device: ${health.device.toUpperCase()}${health.gpu ? ` (${health.gpu})` : ""} · backend ${backend}. Set F5_TTS_DEVICE=rocm to force a Radeon GPU on Linux, or F5_TTS_DEVICE=cpu to force CPU.`;
}

async function loadReferences() {
  try {
    state.references = await api("/api/references");
  } catch {
    state.references = [];
  }
}

async function uploadReference(file) {
  if (file.size > 200 * 1024 * 1024) {
    toast("Audio file is larger than 200 MB", true);
    return;
  }
  const previous = els.refChangeBtn.innerHTML;
  els.refChangeBtn.disabled = true;
  els.refChangeBtn.innerHTML = "Uploading…";
  try {
    const form = new FormData();
    form.append("file", file);
    const meta = await api("/api/references", { method: "POST", form });
    state.references = [meta, ...state.references.filter((r) => r.id !== meta.id)];
    setReference(meta);
    localStorage.setItem(LAST_REF_KEY, meta.id);
    toast(`Reference loaded · ${fmtDuration(meta.duration)}`);
    updateBanners();
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.refChangeBtn.disabled = false;
    els.refChangeBtn.innerHTML = previous;
  }
}

function setReference(meta) {
  const prevId = state.reference?.id;
  state.reference = meta;
  state.selection = null;
  if (meta.id !== prevId) {
    state.refPosition = null;
    if (state.audioType === "ref") {
      els.audioEl.pause();
      els.audioEl.removeAttribute("src");
      state.audioKey = null;
      state.audioType = null;
      state.audioId = null;
    }
  }
  localStorage.setItem(LAST_REF_KEY, meta.id);
  if (!els.refText.value.trim() && localStorage.getItem(REFTEXT_KEY)) {
    els.refText.value = localStorage.getItem(REFTEXT_KEY);
  }
  updateRefTextCount();
  renderReference();
  if (!state.job) {
    state.rebuildNeeded = false;
    updateBanners();
  }
}

function referenceUrl() {
  if (!state.reference) return null;
  if (state.reference.audio_url) return state.reference.audio_url;
  return `/api/references/${state.reference.id}/audio`;
}

function renderReference() {
  const ref = state.reference;
  if (!ref) {
    els.dropIdle.hidden = false;
    els.dropLoaded.hidden = true;
    els.dropzone.classList.remove("has-audio");
    els.refName.textContent = "No reference loaded";
    els.refWarning.hidden = true;
    els.trimBtn.disabled = true;
    els.selLabel.textContent = "Drag to select a region · click to seek the playhead";
    drawRefWave();
    return;
  }
  els.dropIdle.hidden = true;
  els.dropLoaded.hidden = false;
  els.dropzone.classList.add("has-audio");
  els.refName.textContent = ref.name || "Reference";
  els.refFormat.textContent = `${(ref.sample_rate / 1000).toFixed(1)} kHz · mono`;
  els.refWarning.hidden = !(ref.duration > 12);
  if (ref.duration > 12) {
    els.refWarning.textContent = `This clip is ${ref.duration.toFixed(1)} s. F5-TTS uses at most 12 s — select and trim the best line.`;
  }
  els.refTime.textContent = `${fmtClock(0)} / ${fmtClock(ref.duration)}`;
  updateSelectionUi();
  drawRefWave();
}

function updateSelectionUi() {
  if (!state.selection || !state.reference) {
    els.trimBtn.disabled = true;
    els.selLabel.textContent = "Drag to select a region · click to seek the playhead";
    return;
  }
  const { start, end } = state.selection;
  els.selLabel.textContent = `${start.toFixed(2)} – ${end.toFixed(2)} s selected`;
  els.trimBtn.disabled = end - start < 0.2;
}

function timeFromEvent(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const duration = state.reference?.duration || 0;
  if (!duration) return null;
  return clamp(((e.clientX - rect.left) / rect.width) * duration, 0, duration);
}

function nearRefPlayhead(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const duration = state.reference?.duration || 0;
  const head = refPlayheadTime();
  if (!duration || head == null) return false;
  return Math.abs((head / duration) * rect.width - (e.clientX - rect.left)) <= 10;
}

function setupSelection(canvas) {
  canvas.addEventListener("pointerdown", (e) => {
    if (!state.reference) return;
    const t = timeFromEvent(canvas, e);
    if (t == null) return;
    canvas.setPointerCapture(e.pointerId);
    if (nearRefPlayhead(canvas, e)) {
      state.drag = { mode: "seek" };
      seekRef(t);
      return;
    }
    state.drag = { mode: "select", anchor: t, moved: false };
    state.selection = { start: t, end: t };
    updateSelectionUi();
    drawRefWave();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!state.drag) {
      canvas.style.cursor = nearRefPlayhead(canvas, e) ? "ew-resize" : "crosshair";
      return;
    }
    const t = timeFromEvent(canvas, e);
    if (t == null) return;
    if (state.drag.mode === "seek") {
      seekRef(t);
      return;
    }
    if (Math.abs(t - state.drag.anchor) > 0.02) state.drag.moved = true;
    state.selection = {
      start: Math.min(state.drag.anchor, t),
      end: Math.max(state.drag.anchor, t),
    };
    updateSelectionUi();
    drawRefWave();
  });
  const finish = (allowSeek) => {
    if (!state.drag) return;
    const drag = state.drag;
    state.drag = null;
    if (drag.mode === "seek") return;
    if (!drag.moved) {
      state.selection = null;
      if (allowSeek) seekRef(drag.anchor);
    } else if (state.selection && state.selection.end - state.selection.start < 0.05) {
      state.selection = null;
    }
    updateSelectionUi();
    drawRefWave();
  };
  canvas.addEventListener("pointerup", () => finish(true));
  canvas.addEventListener("pointercancel", () => finish(false));
}

function refPlayheadTime() {
  if (state.audioType === "ref" && els.audioEl.src) return els.audioEl.currentTime || 0;
  return state.refPosition;
}

function seekRef(t) {
  const ref = state.reference;
  if (!ref) return;
  const duration = ref.duration || 0;
  if (!duration) return;
  const target = clamp(t, 0, Math.max(0, duration - 0.02));
  const apply = () => {
    els.audioEl.currentTime = target;
    state.refPosition = target;
    updateTimeLabels();
    drawRefWave();
  };
  if (state.audioKey !== "ref:" || !els.audioEl.src) {
    if (state.audioKey && state.audioType !== "ref") els.audioEl.pause();
    els.audioEl.src = referenceUrl();
    state.audioKey = "ref:";
    state.audioType = "ref";
    state.audioId = null;
    els.audioEl.addEventListener("loadedmetadata", apply, { once: true });
  } else {
    apply();
  }
}

async function trimSelection() {
  if (!state.reference || !state.selection) return;
  const { start, end } = state.selection;
  els.trimBtn.disabled = true;
  try {
    const meta = await api(`/api/references/${state.reference.id}/trim`, {
      method: "POST",
      body: { start, end },
    });
    state.references = [meta, ...state.references.filter((r) => r.id !== meta.id)];
    setReference(meta);
    toast("Trimmed. Update the transcript to match the selected clip.");
    updateBanners();
  } catch (err) {
    toast(err.message, true);
  } finally {
    updateSelectionUi();
  }
}

async function autoTranscribe() {
  if (!state.reference) {
    toast("Load a reference clip first", true);
    return;
  }
  const language = els.asrLang.value;
  const original = els.transcribeBtn.innerHTML;
  els.transcribeBtn.disabled = true;
  els.transcribeBtn.innerHTML = `<svg class="icon spin"><use href="#i-refresh"/></svg>Transcribing…`;
  toast("Transcribing. The first run downloads Whisper and can take several minutes.");
  try {
    const result = await api(`/api/references/${state.reference.id}/transcribe`, {
      method: "POST",
      body: { language },
    });
    els.refText.value = result.text || "";
    updateRefTextCount();
    localStorage.setItem(REFTEXT_KEY, els.refText.value);
    updateBanners();
    toast("Transcript ready. Check it against the clip.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.transcribeBtn.disabled = false;
    els.transcribeBtn.innerHTML = original;
  }
}

function updateRefTextCount() {
  const value = els.refText.value;
  els.refTextCount.textContent = `${value.length} chars · ${countWords(value)} words`;
}

function updateScriptStats() {
  const value = els.script.value;
  els.wordCount.textContent = `${countWords(value)} words`;
  els.charCount.textContent = `${value.length} chars`;
  const seconds = countWords(value) / 2.5;
  els.scriptTimeEstimate.textContent = seconds > 1 ? `~${fmtDuration(seconds)} of speech` : "";
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  updateScriptStats();
  updateBanners();
}

async function buildJob({ autoGenerate = false } = {}) {
  if (!state.reference) {
    toast("Load a reference voice first", true);
    els.dropzone.focus();
    return;
  }
  if (!els.refText.value.trim()) {
    toast("Enter or auto-transcribe the reference transcript", true);
    els.refText.focus();
    return;
  }
  if (!els.script.value.trim()) {
    toast("Paste a script first", true);
    els.script.focus();
    return;
  }
  await flushSettings();
  setBusy(els.buildBtn, true, "Building…");
  try {
    const job = await api("/api/jobs", {
      method: "POST",
      body: {
        reference_id: state.reference.id,
        ref_text: els.refText.value.trim(),
        script: els.script.value,
        settings: state.settings,
      },
    });
    loadJob(job);
    localStorage.setItem(DRAFT_KEY, els.script.value);
    toast(`Built ${job.chunks.length} chunks`);
    await refreshSessions();
    if (autoGenerate) await startGenerate({ onlyPending: true, newSeed: false });
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(els.buildBtn, false);
  }
}

function loadJob(job) {
  state.job = job;
  state.finalDirty = false;
  state.rebuildNeeded = false;
  state.pacingDirty = false;
  state.voiceDirty = false;
  state.clearVoiceOnIdle = false;
  state.lastCurrent = null;
  state.audioKey = null;
  state.lastError = null;
  state.lastFinalVersion = job.final?.version ?? null;
  els.audioEl.pause();
  els.audioEl.removeAttribute("src");
  localStorage.setItem(LAST_JOB_KEY, job.id);
  if (job.settings) {
    state.settings = { ...state.config.defaults, ...job.settings };
    syncControls();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }
  els.script.value = job.script || "";
  els.refText.value = job.ref_text || "";
  updateScriptStats();
  updateRefTextCount();
  const known = state.references.find((r) => r.id === job.reference_id);
  if (known) {
    state.reference = known;
  } else {
    state.reference = {
      id: job.reference_id,
      name: job.reference_name || "Session reference",
      duration: job.reference_duration || 0,
      sample_rate: job.reference_sample_rate || 24000,
      peaks: job.reference_peaks || [],
      audio_url: `/api/jobs/${job.id}/reference`,
    };
  }
  state.selection = null;
  state.refPosition = null;
  renderReference();
  updateJobChip();
  renderChunks();
  renderProgress();
  renderFinal();
  updateBanners();
  if (ACTIVE_STATUSES.has(job.status)) startPolling();
  else stopPolling();
}

function applyJobUpdate(job) {
  const previousStatus = state.job?.status;
  state.job = job;
  reconcileFinal(job);
  syncChunksFromJob(job);
  renderProgress();
  renderFinal();
  updateJobChip();
  updateBanners();
  if (job.status === "done" && state.clearVoiceOnIdle) {
    state.voiceDirty = false;
    state.clearVoiceOnIdle = false;
    els.voiceDirtyNote.hidden = true;
  }
  if (ACTIVE_STATUSES.has(job.status)) {
    startPolling();
  } else if (previousStatus && ACTIVE_STATUSES.has(previousStatus)) {
    stopPolling();
    refreshSessions();
  }
  if (job.status === "error" && job.error && job.error !== state.lastError) {
    state.lastError = job.error;
    toast(job.error, true);
  }
}

function reconcileFinal(job) {
  const version = job.final?.version ?? null;
  if (version === null) {
    state.lastFinalVersion = null;
    return;
  }
  if (state.lastFinalVersion !== null && version !== state.lastFinalVersion) {
    state.finalDirty = false;
  }
  state.lastFinalVersion = version;
}

function updateJobChip() {
  const job = state.job;
  if (!job) {
    els.jobChip.hidden = true;
    return;
  }
  els.jobChip.hidden = false;
  els.jobChip.textContent = `${job.title || "Session"} · ${job.status} · ${job.chunks.length} chunks`;
}

function updateBanners() {
  const job = state.job;
  if (!job) {
    els.rebuildBanner.hidden = true;
    els.voiceDirtyNote.hidden = true;
    return;
  }
  const scriptDirty = els.script.value !== job.script;
  const refTextDirty = els.refText.value.trim() !== (job.ref_text || "").trim();
  const refChanged = state.reference && state.reference.id !== job.reference_id;
  const reasons = [];
  if (scriptDirty) reasons.push("script");
  if (refTextDirty) reasons.push("transcript");
  if (refChanged) reasons.push("voice");
  if (state.pacingDirty) reasons.push("pacing settings");
  const needed = reasons.length > 0;
  els.rebuildBanner.hidden = !needed;
  if (needed) {
    els.rebuildText.textContent = `Changed ${reasons.join(", ")}. Build a new session to apply, or keep editing the current chunks.`;
  }
  els.voiceDirtyNote.hidden = !state.voiceDirty;
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (!state.job || state.polling) return;
    state.polling = true;
    try {
      const status = await api(`/api/jobs/${state.job.id}/status`);
      mergeStatus(status);
    } catch (err) {
      stopPolling();
      toast(err.message, true);
    } finally {
      state.polling = false;
    }
  }, 1000);
}

function mergeStatus(status) {
  const job = state.job;
  if (!job || status.id !== job.id) return;
  const previousStatus = job.status;
  job.status = status.status;
  job.progress = status.progress || job.progress;
  job.error = status.error;
  if (status.final) job.final = status.final;
  const updates = new Map(status.chunks.map((chunk) => [chunk.id, chunk]));
  job.chunks.forEach((chunk) => {
    const update = updates.get(chunk.id);
    if (update) Object.assign(chunk, update);
  });
  reconcileFinal(job);
  syncChunksFromJob(job);
  renderProgress();
  renderFinal();
  updateJobChip();
  updateBanners();
  if (job.status === "done" && state.clearVoiceOnIdle) {
    state.voiceDirty = false;
    state.clearVoiceOnIdle = false;
    els.voiceDirtyNote.hidden = true;
  }
  if (!ACTIVE_STATUSES.has(job.status) && previousStatus && ACTIVE_STATUSES.has(previousStatus)) {
    stopPolling();
    refreshSessions();
  }
  if (job.status === "error" && job.error && job.error !== state.lastError) {
    state.lastError = job.error;
    toast(job.error, true);
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function startGenerate({ onlyPending = true, newSeed = false, chunkIds = null } = {}) {
  if (!state.job) {
    toast("Build chunks first", true);
    return;
  }
  if (ACTIVE_STATUSES.has(state.job.status)) {
    toast("Generation is already running");
    return;
  }
  updateBanners();
  await flushSettings();
  try {
    const job = await api(`/api/jobs/${state.job.id}/generate`, {
      method: "POST",
      body: { chunk_ids: chunkIds, only_pending: onlyPending, new_seed: newSeed },
    });
    applyJobUpdate(job);
    startPolling();
    if (chunkIds) toast("Chunk queued for regeneration");
  } catch (err) {
    toast(err.message, true);
  }
}

async function cancelGeneration() {
  if (!state.job) return;
  els.cancelBtn.disabled = true;
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" });
    toast("Cancelling after the current chunk finishes");
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.cancelBtn.disabled = false;
  }
}

async function assembleNow() {
  if (!state.job) {
    toast("Nothing to assemble yet", true);
    return;
  }
  if (ACTIVE_STATUSES.has(state.job.status)) {
    toast("Wait for generation to finish", true);
    return;
  }
  await flushSettings();
  setBusy(els.assembleBtn, true, "Assembling…");
  try {
    const job = await api(`/api/jobs/${state.job.id}/assemble`, { method: "POST" });
    state.finalDirty = false;
    state.job = job;
    reconcileFinal(job);
    syncChunksFromJob(job);
    renderProgress();
    renderFinal();
    updateJobChip();
    updateBanners();
    toast("Final audio assembled");
    await refreshSessions();
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(els.assembleBtn, false);
    updateAssembleState();
  }
}

function renderChunks() {
  const job = state.job;
  const list = els.chunkList;
  list.innerHTML = "";
  if (!job || !job.chunks.length) {
    list.appendChild(els.chunkEmpty);
    els.chunkEmpty.hidden = false;
    els.chunksMeta.textContent = "—";
    return;
  }
  els.chunkEmpty.hidden = true;
  els.chunksMeta.textContent = `${job.chunks.length} chunks · ${job.progress.total} enabled`;
  const frag = document.createDocumentFragment();
  job.chunks.forEach((chunk) => frag.appendChild(buildChunkCard(chunk)));
  list.appendChild(frag);
}

function buildChunkCard(chunk) {
  const card = document.createElement("div");
  card.className = "chunk";
  card.dataset.chunk = chunk.id;
  card.dataset.status = chunk.status;
  card.dataset.enabled = String(chunk.enabled);
  card.dataset.stale = String(Boolean(chunk.stale));
  card.dataset.playing = "false";
  card.innerHTML = `
    <div class="chunk-top">
      <span class="chunk-num">${String(chunk.index).padStart(2, "0")}</span>
      <span class="chunk-status"></span>
      <span class="chunk-dur"></span>
      <span class="chunk-badge" hidden></span>
      <span class="chunk-actions-mini">
        <button class="icon-btn chunk-play" type="button" title="Play chunk"><svg class="icon"><use href="#i-play"/></svg></button>
        <button class="icon-btn chunk-regen" type="button" title="Regenerate this chunk. Shift-click keeps the seed."><svg class="icon"><use href="#i-refresh"/></svg></button>
      </span>
    </div>
    <textarea class="chunk-text" rows="2" spellcheck="true" aria-label="Chunk ${chunk.index} text"></textarea>
    <div class="chunk-foot">
      <label><input type="checkbox" class="chunk-emph"> emphasis</label>
      <label>pause <input type="number" class="chunk-pause" min="0" max="10000" step="50"> ms</label>
      <label><input type="checkbox" class="chunk-enabled"> use</label>
    </div>
    <div class="chunk-error" hidden></div>`;

  const textarea = $(".chunk-text", card);
  const emph = $(".chunk-emph", card);
  const pause = $(".chunk-pause", card);
  const enabled = $(".chunk-enabled", card);
  textarea.value = chunk.text;
  emph.checked = Boolean(chunk.emphasis);
  pause.value = chunk.pause_ms;
  enabled.checked = Boolean(chunk.enabled);

  textarea.addEventListener("input", () => {
    scheduleChunkSave(chunk.id, card, 650);
  });
  textarea.addEventListener("blur", () => {
    scheduleChunkSave(chunk.id, card, 0);
  });
  emph.addEventListener("change", () => scheduleChunkSave(chunk.id, card, 0));
  pause.addEventListener("change", () => scheduleChunkSave(chunk.id, card, 0));
  enabled.addEventListener("change", () => scheduleChunkSave(chunk.id, card, 0));

  $(".chunk-play", card).addEventListener("click", () => {
    const current = state.job?.chunks.find((c) => c.id === chunk.id);
    if (!current || current.status !== "done") {
      toast("Generate this chunk first", true);
      return;
    }
    const url = `/api/jobs/${state.job.id}/chunks/${chunk.id}/audio?v=${current.audio_version}`;
    toggleAudio("chunk", chunk.id, url, $(".chunk-play", card));
  });

  $(".chunk-regen", card).addEventListener("click", (e) => {
    if (!state.job || ACTIVE_STATUSES.has(state.job.status)) return;
    startGenerate({ onlyPending: false, newSeed: !e.shiftKey, chunkIds: [chunk.id] });
  });

  syncChunkCard(card, chunk);
  return card;
}

function syncChunksFromJob(job) {
  job.chunks.forEach((chunk) => {
    const card = els.chunkList.querySelector(`[data-chunk="${chunk.id}"]`);
    if (card) syncChunkCard(card, chunk);
  });
  els.chunksMeta.textContent = `${job.chunks.length} chunks · ${job.progress.total} enabled`;
}

function syncChunkCard(card, chunk) {
  card.dataset.status = chunk.status;
  card.dataset.enabled = String(chunk.enabled);
  card.dataset.stale = String(Boolean(chunk.stale));
  $(".chunk-dur", card).textContent = chunk.duration ? `${chunk.duration.toFixed(1)}s` : "—";
  const badge = $(".chunk-badge", card);
  const error = $(".chunk-error", card);
  if (chunk.status === "error") {
    badge.hidden = false;
    badge.textContent = "error";
    badge.className = "chunk-badge error";
    error.hidden = false;
    error.textContent = chunk.error || "Generation failed";
  } else if (chunk.stale) {
    badge.hidden = false;
    badge.textContent = "edited";
    badge.className = "chunk-badge";
    error.hidden = true;
  } else {
    badge.hidden = true;
    error.hidden = true;
  }
  const textarea = $(".chunk-text", card);
  if (document.activeElement !== textarea && !state.dirtyChunks.has(chunk.id) && textarea.value !== chunk.text) {
    textarea.value = chunk.text;
  }
  const locked = Boolean(state.job && ACTIVE_STATUSES.has(state.job.status));
  textarea.disabled = locked;
  const emph = $(".chunk-emph", card);
  if (document.activeElement !== emph) emph.checked = Boolean(chunk.emphasis);
  emph.disabled = locked;
  const pause = $(".chunk-pause", card);
  if (document.activeElement !== pause) pause.value = chunk.pause_ms;
  pause.disabled = locked;
  const enabled = $(".chunk-enabled", card);
  enabled.checked = Boolean(chunk.enabled);
  enabled.disabled = locked;
  $(".chunk-play", card).disabled = chunk.status !== "done";
  $(".chunk-regen", card).disabled = locked || !chunk.enabled;
  if (state.job?.progress?.current === chunk.id) {
    card.dataset.current = "true";
    if (state.lastCurrent !== chunk.id) {
      state.lastCurrent = chunk.id;
      const rect = card.getBoundingClientRect();
      const view = els.chunkList.getBoundingClientRect();
      if (rect.top < view.top || rect.bottom > view.bottom) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  } else {
    delete card.dataset.current;
  }
}

function scheduleChunkSave(chunkId, card, delay) {
  clearTimeout(state.chunkTimers.get(chunkId));
  const timer = setTimeout(() => {
    state.chunkTimers.delete(chunkId);
    saveChunk(chunkId, card);
  }, delay);
  state.chunkTimers.set(chunkId, timer);
}

async function saveChunk(chunkId, card) {
  if (!state.job) return;
  const patch = {
    text: $(".chunk-text", card).value,
    pause_ms: Number($(".chunk-pause", card).value) || 0,
    emphasis: $(".chunk-emph", card).checked,
    enabled: $(".chunk-enabled", card).checked,
  };
  const known = state.job.chunks.find((c) => c.id === chunkId);
  if (
    known &&
    known.text === patch.text &&
    known.pause_ms === patch.pause_ms &&
    Boolean(known.emphasis) === patch.emphasis &&
    Boolean(known.enabled) === patch.enabled
  ) {
    return;
  }
  state.dirtyChunks.add(chunkId);
  try {
    const job = await api(`/api/jobs/${state.job.id}/chunks/${chunkId}`, {
      method: "PATCH",
      body: patch,
    });
    state.job = job;
    state.dirtyChunks.delete(chunkId);
    syncChunksFromJob(job);
    renderProgress();
    renderFinal();
    updateBanners();
    if (job.final) state.finalDirty = true;
    renderFinal();
  } catch (err) {
    state.dirtyChunks.delete(chunkId);
    toast(err.message, true);
  }
}

function renderProgress() {
  const job = state.job;
  const active = job && ACTIVE_STATUSES.has(job.status);
  if (!job || !job.chunks.length) {
    els.progressWrap.hidden = true;
    els.generateBtn.disabled = true;
    els.regenAllBtn.disabled = true;
    els.cancelBtn.hidden = true;
    els.assembleBtn.disabled = true;
    return;
  }
  const { done, total, message } = job.progress;
  els.progressWrap.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
  let label = message || "Ready";
  if (job.status === "generating") label = message || `Generating ${done}/${total}`;
  else if (job.status === "assembling") label = "Assembling final audio…";
  else if (job.status === "done") label = "Final audio ready";
  else if (job.status === "partial") label = `${done}/${total} chunks generated`;
  else if (job.status === "cancelled") label = "Cancelled";
  else if (job.status === "error") label = job.error || "Generation failed";
  els.progressText.textContent = label;
  els.etaText.textContent = active ? estimateEta(job) : "";
  const needsWork = job.chunks.some((c) => c.enabled && (c.status !== "done" || c.stale));
  els.generateBtn.disabled = active || !needsWork;
  els.regenAllBtn.disabled = active || total === 0;
  els.cancelBtn.hidden = !active;
  els.cancelBtn.disabled = false;
  updateAssembleState();
}

function estimateEta(job) {
  if (job.status === "assembling") return "";
  const doneChunks = job.chunks.filter((c) => c.status === "done" && c.gen_seconds);
  if (!doneChunks.length) return "Speed varies";
  const avg = doneChunks.reduce((sum, c) => sum + c.gen_seconds, 0) / doneChunks.length;
  const remaining = Math.max(0, job.progress.total - job.progress.done);
  if (!remaining) return "";
  return `~${fmtDuration(avg * remaining)} left`;
}

function updateAssembleState() {
  const job = state.job;
  if (!job) {
    els.assembleBtn.disabled = true;
    return;
  }
  const hasAudio = job.chunks.some((c) => c.status === "done");
  const active = ACTIVE_STATUSES.has(job.status);
  els.assembleBtn.disabled = !hasAudio || active;
  els.assembleBtn.textContent = job.final ? "Reassemble final" : "Assemble final";
}

function renderFinal() {
  const job = state.job;
  const final = job?.final;
  const hasAudio = job?.chunks.some((c) => c.status === "done");
  if (!job || !final) {
    els.finalLoaded.hidden = true;
    els.finalEmpty.hidden = false;
    els.finalEmpty.textContent = hasAudio
      ? "Chunks are ready. Assemble them into a final mix."
      : "Generate chunks to create a final mix.";
    els.finalBadge.hidden = true;
    els.dlWav.removeAttribute("href");
    els.dlMp3.removeAttribute("href");
    els.dlRaw.removeAttribute("href");
    updateAssembleState();
    return;
  }
  const stale = Boolean(final.stale) || state.finalDirty;
  els.finalLoaded.hidden = false;
  els.finalEmpty.hidden = true;
  els.finalBadge.hidden = false;
  els.finalBadge.textContent = stale ? "out of date" : "ready";
  els.finalBadge.className = `badge ${stale ? "warn" : "good"}`;
  els.finalStale.hidden = !stale;
  const hasStaleChunks = job.chunks.some((c) => c.stale);
  els.finalStale.textContent = hasStaleChunks
    ? "A chunk was edited after generation. Regenerate that chunk to match the text, then reassemble."
    : "Chunks or master settings changed. Reassemble to update.";
  els.finalDuration.textContent = `${fmtDuration(final.duration)} · 24 kHz mono`;
  if (!(state.audioType === "final" && state.playing)) {
    els.finalTime.textContent = `${fmtClock(0)} / ${fmtClock(final.duration)}`;
  }
  const version = final.version || 0;
  els.dlWav.href = `/api/jobs/${job.id}/final?format=wav&download=1&v=${version}`;
  els.dlMp3.href = `/api/jobs/${job.id}/final?format=mp3&download=1&v=${version}`;
  els.dlRaw.href = `/api/jobs/${job.id}/final?format=wav&raw=1&download=1&v=${version}`;
  updateAssembleState();
  drawFinalWave();
  if (state.audioKey && state.audioKey.startsWith("final:") && state.audioKey !== `final:${version}`) {
    els.audioEl.pause();
    state.audioKey = null;
  }
}

function finalUrl(format = "wav") {
  const job = state.job;
  if (!job?.final) return null;
  return `/api/jobs/${job.id}/final?format=${format}&v=${job.final.version || 0}`;
}

function toggleAudio(type, id, url, button) {
  if (!url) return;
  const key = `${type}:${id ?? ""}`;
  if (state.audioKey === key && !els.audioEl.paused) {
    els.audioEl.pause();
    return;
  }
  if (state.audioKey !== key || !els.audioEl.src) {
    els.audioEl.src = url;
    state.audioKey = key;
    state.audioType = type;
    state.audioId = id;
  }
  els.audioEl.play().catch((err) => toast(err.message, true));
}

function updatePlayButtons() {
  const playing = state.playing;
  const refPlaying = playing && state.audioType === "ref";
  const finalPlaying = playing && state.audioType === "final";
  setPlayIcon(els.refPlayBtn, refPlaying);
  setPlayIcon(els.finalPlayBtn, finalPlaying);
  $$(".chunk").forEach((card) => {
    const col = card.querySelector(".chunk-play");
    const active = playing && state.audioType === "chunk" && state.audioId === card.dataset.chunk;
    setPlayIcon(col, active);
    card.dataset.playing = String(active);
  });
}

function setPlayIcon(button, playing) {
  if (!button) return;
  button.classList.toggle("playing", Boolean(playing));
  const use = button.querySelector("use");
  if (use) use.setAttribute("href", playing ? "#i-pause" : "#i-play");
}

function tickPlayback() {
  if (!state.playing) return;
  updateTimeLabels();
  drawAll();
  requestAnimationFrame(tickPlayback);
}

function updateTimeLabels() {
  const audio = els.audioEl;
  if (state.audioType === "ref" && state.reference) {
    els.refTime.textContent = `${fmtClock(audio.currentTime || 0)} / ${fmtClock(state.reference.duration || 0)}`;
  }
  if (state.audioType === "final" && state.job?.final) {
    els.finalTime.textContent = `${fmtClock(audio.currentTime || 0)} / ${fmtClock(state.job.final.duration || 0)}`;
  }
}

function seekFinal(fraction) {
  const job = state.job;
  if (!job?.final) return;
  const url = finalUrl("wav");
  const apply = () => {
    const duration = job.final.duration || els.audioEl.duration || 0;
    els.audioEl.currentTime = Math.max(0, Math.min(duration - 0.05, fraction * duration));
    els.audioEl.play().catch(() => {});
  };
  if (state.audioKey !== `final:${job.final.version || 0}` || !els.audioEl.src) {
    els.audioEl.src = url;
    state.audioKey = `final:${job.final.version || 0}`;
    state.audioType = "final";
    state.audioId = null;
    els.audioEl.addEventListener("loadedmetadata", apply, { once: true });
  } else {
    apply();
  }
}

function drawAll() {
  drawRefWave();
  drawFinalWave();
}

function drawRefWave() {
  const ref = state.reference;
  drawWave(els.refCanvas, ref?.peaks || [], {
    duration: ref?.duration || 0,
    selection: state.selection,
    playhead: refPlayheadTime(),
    accent: "#e3a85b",
  });
}

function drawFinalWave() {
  const final = state.job?.final;
  const playing = state.audioType === "final" && state.playing;
  drawWave(els.finalCanvas, final?.peaks || [], {
    duration: final?.duration || 0,
    selection: null,
    playhead: playing && final ? els.audioEl.currentTime : null,
    accent: "#8fc4a8",
  });
}

function drawWave(canvas, peaks, { duration = 0, selection = null, playhead = null, accent = "#e3a85b" }) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.floor(rect.width * dpr);
  const height = Math.floor(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#090a0d";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + 0.5);
  ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();

  if (selection && duration > 0) {
    const x1 = clamp(selection.start / duration, 0, 1) * w;
    const x2 = clamp(selection.end / duration, 0, 1) * w;
    ctx.fillStyle = "rgba(227,168,91,0.12)";
    ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), h);
    ctx.strokeStyle = "rgba(227,168,91,0.55)";
    ctx.beginPath();
    ctx.moveTo(Math.min(x1, x2) + 0.5, 0);
    ctx.lineTo(Math.min(x1, x2) + 0.5, h);
    ctx.moveTo(Math.max(x1, x2) - 0.5, 0);
    ctx.lineTo(Math.max(x1, x2) - 0.5, h);
    ctx.stroke();
  }

  const n = peaks?.length || 0;
  if (n) {
    const step = w / n;
    const barWidth = Math.max(0.7, Math.min(2.4, step * 0.62));
    const mid = h / 2;
    const baseAlpha = accent === "#8fc4a8" ? 0.55 : 0.72;
    for (let i = 0; i < n; i++) {
      const raw = clamp(Number(peaks[i]) || 0, 0, 1);
      const amp = Math.pow(raw, 0.72) * (h * 0.46);
      const x = i * step + (step - barWidth) / 2;
      const t = n > 1 ? i / (n - 1) : 0;
      const selected = selection && duration > 0 && t * duration >= selection.start && t * duration <= selection.end;
      const played = playhead != null && duration > 0 && t * duration <= playhead;
      ctx.fillStyle = selected
        ? hexToRgba(accent, 0.95)
        : played
          ? hexToRgba(accent, 0.8)
          : hexToRgba(accent, baseAlpha * 0.55);
      ctx.fillRect(x, mid - amp, barWidth, Math.max(1, amp * 2));
    }
  } else {
    ctx.fillStyle = "rgba(139,146,157,0.35)";
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText("no audio", w / 2, h / 2 + 4);
  }

  if (playhead != null && duration > 0) {
    const x = clamp(playhead / duration, 0, 1) * w;
    ctx.strokeStyle = hexToRgba(accent, 0.95);
    ctx.lineWidth = 1.5;
    ctx.shadowColor = hexToRgba(accent, 0.6);
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const bigint = parseInt(value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

async function refreshSessions() {
  try {
    const jobs = await api("/api/jobs");
    renderSessions(jobs.slice(0, 12));
  } catch {}
}

function renderSessions(jobs) {
  els.sessionList.innerHTML = "";
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "dim";
    empty.style.fontSize = "10.5px";
    empty.textContent = "No saved sessions yet.";
    els.sessionList.appendChild(empty);
    return;
  }
  jobs.forEach((job) => {
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.session = job.id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const statusClass = ACTIVE_STATUSES.has(job.status) ? "generating" : job.status === "done" ? "done" : job.status === "error" ? "error" : "";
    row.innerHTML = `
      <span class="s-status ${statusClass}"></span>
      <span class="s-title"></span>
      <span class="s-meta"></span>
      <button class="icon-btn del" type="button" data-del="${job.id}" title="Delete session"><svg class="icon"><use href="#i-trash"/></svg></button>`;
    $(".s-title", row).textContent = job.title || "Untitled";
    const duration = job.duration ? ` · ${fmtDuration(job.duration)}` : "";
    $(".s-meta", row).textContent = `${job.done}/${job.chunk_count}${duration}`;
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") row.click();
    });
    els.sessionList.appendChild(row);
  });
}

function newSession(silent = false) {
  if (!silent && state.job) {
    const message = ACTIVE_STATUSES.has(state.job.status)
      ? "This session is still generating. Start a new session? The old job keeps running and stays in Sessions."
      : "Start a new session? Current chunks stay saved in Sessions.";
    if (!confirm(message)) return;
  }
  stopPolling();
  els.audioEl.pause();
  els.audioEl.removeAttribute("src");
  state.job = null;
  state.finalDirty = false;
  state.rebuildNeeded = false;
  state.pacingDirty = false;
  state.voiceDirty = false;
  state.clearVoiceOnIdle = false;
  state.audioKey = null;
  state.refPosition = null;
  state.lastCurrent = null;
  localStorage.removeItem(LAST_JOB_KEY);
  els.script.value = "";
  updateScriptStats();
  els.chunkList.innerHTML = "";
  els.chunkList.appendChild(els.chunkEmpty);
  els.chunkEmpty.hidden = false;
  els.chunksMeta.textContent = "—";
  els.progressWrap.hidden = true;
  els.generateBtn.disabled = true;
  els.regenAllBtn.disabled = true;
  els.cancelBtn.hidden = true;
  els.jobChip.hidden = true;
  els.voiceDirtyNote.hidden = true;
  renderFinal();
  updateBanners();
  refreshSessions();
  els.script.focus();
}

function setBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.previous = button.innerHTML;
    button.dataset.wasDisabled = String(button.disabled);
    button.disabled = true;
    button.innerHTML = `<svg class="icon spin"><use href="#i-refresh"/></svg>${label}`;
  } else {
    if (button.dataset.previous) button.innerHTML = button.dataset.previous;
    button.disabled = button.dataset.wasDisabled === "true";
    delete button.dataset.previous;
    delete button.dataset.wasDisabled;
  }
}

function toast(message, isError = false) {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.className = "toast";
  }, isError ? 6000 : 3200);
}

function fmtClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function fmtDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value >= 3600) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.round((value % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (value >= 60) {
    const minutes = Math.floor(value / 60);
    const secs = Math.round(value % 60);
    return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${value.toFixed(1)}s`;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function readJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
