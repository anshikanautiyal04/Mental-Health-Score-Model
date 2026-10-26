/* =========================================================
   MindScope · script.js
   Talks to the FastAPI backend and renders the real result.
   ========================================================= */
"use strict";

// ---------- Configuration ----------
const API_URL = "https://mental-health-score-model-1-y93o.onrender.com";

// The backend does not define a score range. This value is ONLY used to size
// the decorative progress ring (score / RING_SCALE_MAX, clamped to 0–1).
// The number shown to the user is always the exact value the API returned.
const RING_SCALE_MAX = 10;

// ---------- Element references ----------
const $ = (id) => document.getElementById(id);
const form = $("assessmentForm");
const predictBtn = $("predictBtn");
const loader = $("loader");
const formAlert = $("formAlert");
const resultSection = $("resultSection");
const announcer = $("announcer");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Small helpers ---------- */
const announce = (msg) => { announcer.textContent = ""; setTimeout(() => (announcer.textContent = msg), 50); };

function showAlert(msg) {
  formAlert.textContent = msg;
  formAlert.hidden = false;
  formAlert.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  announce(msg);
}
const hideAlert = () => { formAlert.hidden = true; formAlert.textContent = ""; };

function setFieldError(el, message) {
  const wrap = el.closest(".field");
  wrap.classList.toggle("invalid", Boolean(message));
  wrap.querySelector(".err").textContent = message || "";
  el.setAttribute("aria-invalid", message ? "true" : "false");
}

/* ---------- Validation ---------- */
// Returns an error string for one control, or "" if valid.
function validateField(el) {
  const raw = el.value.trim();
  if (raw === "") return "This field is required.";

  if (el.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return "Enter a valid number.";
    if (el.dataset.type === "int" && !Number.isInteger(n)) return "Enter a whole number.";
    if (el.min !== "" && n < Number(el.min)) return `Must be at least ${el.min}.`;
    if (el.max !== "" && n > Number(el.max)) return `Must be at most ${el.max}.`;
  }
  return "";
}

function validateForm() {
  let firstInvalid = null;
  form.querySelectorAll("input[name], select[name]").forEach((el) => {
    const msg = validateField(el);
    setFieldError(el, msg);
    if (msg && !firstInvalid) firstInvalid = el;
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

/* ---------- Payload: exact field names + correct types ---------- */
function buildPayload() {
  const payload = {};
  form.querySelectorAll("input[name], select[name]").forEach((el) => {
    const value = el.value.trim();
    if (el.dataset.type === "int") payload[el.name] = parseInt(value, 10);
    else if (el.dataset.type === "float") payload[el.name] = parseFloat(value);
    else payload[el.name] = value; // strings: gender, country, platform, etc.
  });
  return payload;
}

/* ---------- API call ---------- */
// Turns FastAPI's 422 detail array into field-level messages.
function applyBackendErrors(detail) {
  const general = [];
  detail.forEach((d) => {
    const name = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null;
    const el = name ? form.elements[name] : null;
    if (el) setFieldError(el, d.msg || "Invalid value.");
    else general.push(d.msg || "Invalid input.");
  });
  return general.length ? general.join(" ") : "The server rejected some values. Please check the highlighted fields.";
}

async function requestPrediction(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = null;
  try { data = await response.json(); } catch (_) { /* non-JSON body */ }

  if (!response.ok) {
    const err = new Error("http");
    err.status = response.status;
    err.detail = data && data.detail;
    throw err;
  }
  const score = data && data.predicted_mental_health_score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    const err = new Error("bad-response");
    throw err;
  }
  return score;
}

/* ---------- Result display ---------- */
function animateCounter(target, el, duration = 1600) {
  if (reducedMotion) { el.textContent = target.toFixed(2); return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (target * eased).toFixed(2);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = target.toFixed(2); // end exactly on the real value
  };
  requestAnimationFrame(tick);
}

function showResult(score) {
  const bar = $("gaugeBar");
  const circumference = 2 * Math.PI * 90;
  bar.style.strokeDashoffset = circumference; // reset, so re-runs animate again

  resultSection.hidden = false;
  $("scoreValue").textContent = (0).toFixed(2);
  $("resultText").textContent =
    `The model returned ${score.toFixed(2)} for the values you submitted. This is a numerical estimate from a machine learning model, not a diagnosis.`;
  $("scaleNote").textContent =
    `The ring is a visual aid drawn on a 0–${RING_SCALE_MAX} scale. The backend does not define the score's range or meaning.`;

  resultSection.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });

  // Two frames later so the browser registers the reset before transitioning
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fraction = Math.min(Math.max(score / RING_SCALE_MAX, 0), 1);
    bar.style.strokeDashoffset = circumference * (1 - fraction);
    animateCounter(score, $("scoreValue"));
  }));

  $("resultCard").focus({ preventScroll: true });
  announce(`Prediction ready. The model estimate is ${score.toFixed(2)}.`);
}

/* ---------- Submit handler ---------- */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideAlert();
  if (!validateForm()) return;

  predictBtn.disabled = true;
  loader.hidden = false;
  announce("Generating your prediction.");

  try {
    const score = await requestPrediction(buildPayload());
    showResult(score);
  } catch (err) {
    if (err.message === "http" && err.status === 422 && Array.isArray(err.detail)) {
      showAlert(applyBackendErrors(err.detail));
    } else if (err.message === "http") {
      showAlert(`The server could not process the request (error ${err.status}). Please try again.`);
    } else if (err.message === "bad-response") {
      showAlert("The server replied, but the response was not in the expected format.");
    } else {
      showAlert("Could not reach the prediction server. Make sure the FastAPI backend is running on http://127.0.0.1:2200 and try again.");
    }
  } finally {
    // Always runs: success, validation error, or network failure
    loader.hidden = true;
    predictBtn.disabled = false;
  }
});

/* ---------- Live validation feedback ---------- */
form.addEventListener("input", (e) => {
  if (e.target.name && e.target.closest(".field").classList.contains("invalid")) {
    setFieldError(e.target, validateField(e.target));
  }
});
form.addEventListener("reset", () => {
  hideAlert();
  form.querySelectorAll(".field").forEach((f) => { f.classList.remove("invalid"); f.querySelector(".err").textContent = ""; });
  resultSection.hidden = true;
});
$("againBtn").addEventListener("click", () => {
  form.reset();
  $("assessment").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
});

/* ---------- Mobile menu ---------- */
const burger = $("burger");
const navLinks = $("navLinks");
const setMenu = (open) => { navLinks.classList.toggle("open", open); burger.setAttribute("aria-expanded", String(open)); };
burger.addEventListener("click", () => setMenu(!navLinks.classList.contains("open")));
navLinks.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

/* ---------- Scroll reveal with stagger ---------- */
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add("in"); observer.unobserve(entry.target); }
  });
}, { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach((el, i) => {
  el.style.setProperty("--d", `${(i % 3) * 0.1}s`);
  observer.observe(el);
});

/* ---------- Floating background shapes ---------- */
(function createShapes() {
  if (reducedMotion) return;
  const host = $("bgShapes");
  for (let i = 0; i < 14; i++) {
    const s = document.createElement("i");
    const size = 40 + Math.random() * 140;
    Object.assign(s.style, {
      width: `${size}px`, height: `${size}px`, left: `${Math.random() * 100}%`,
      animationDuration: `${30 + Math.random() * 40}s`, animationDelay: `-${Math.random() * 40}s`,
      opacity: String(0.12 + Math.random() * 0.25),
    });
    host.appendChild(s);
  }
})();
