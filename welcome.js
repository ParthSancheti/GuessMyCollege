/* ============================================================================
   GUESS MY COLLEGE — WELCOME GATE  (OTP rebuild)
   ----------------------------------------------------------------------------
   Shows a Name + Phone -> OTP overlay on top of the app. On success it calls
   /sync-phone, stores the user (with an auto-generated avatar), and reveals
   the predictor. If the user is already verified (localStorage), it stays
   hidden and the app loads normally.
   Requires: firebase-auth.js (fbSendOtp/fbVerifyOtp) and global.js (API_BASE).
   ========================================================================== */

const GMC_AVATAR_BASE = "https://ui-avatars.com/api/?background=6d28d9&color=fff&bold=true&name=";

function gmcAvatarFor(name) {
  const n = encodeURIComponent((name || "Student").trim() || "Student");
  return `${GMC_AVATAR_BASE}${n}`;
}

function gmcIsVerified() {
  return localStorage.getItem("gmc-logged-in") === "true"
      && !!localStorage.getItem("gmc-user-phone");
}

/* ── Build + inject the overlay markup once ────────────────────────────────── */
function gmcBuildWelcome() {
  if (document.getElementById("gmc-welcome")) return;
  const el = document.createElement("div");
  el.id = "gmc-welcome";
  el.innerHTML = `
    <div class="gmc-w-card">
      <div class="gmc-w-logo">
        <img src="bin/logo.png" alt="GMC" onerror="this.style.display='none'">
      </div>
      <h1 class="gmc-w-title">Guess My College</h1>
      <p class="gmc-w-sub">Verify your number to get started — it's quick.</p>

      <!-- STEP 1: name + phone -->
      <div id="gmc-step-1" class="gmc-w-step">
        <label class="gmc-w-label">Your Name</label>
        <input id="gmc-w-name" type="text" autocomplete="name" placeholder="e.g. Dhananjay Patil" class="gmc-w-input">

        <label class="gmc-w-label">Phone Number</label>
        <div class="gmc-w-phone">
          <span class="gmc-w-cc">+91</span>
          <input id="gmc-w-phone" type="tel" inputmode="numeric" maxlength="10" autocomplete="tel" placeholder="10-digit mobile" class="gmc-w-input gmc-w-input-phone">
        </div>

        <button id="gmc-w-send" class="gmc-w-btn">Send OTP</button>
      </div>

      <!-- STEP 2: otp -->
      <div id="gmc-step-2" class="gmc-w-step" style="display:none;">
        <p class="gmc-w-otpinfo">Enter the 6-digit code sent to <b id="gmc-w-tonum"></b></p>
        <input id="gmc-w-otp" type="text" inputmode="numeric" maxlength="6" placeholder="• • • • • •" class="gmc-w-input gmc-w-otp">
        <button id="gmc-w-verify" class="gmc-w-btn">Verify &amp; Continue</button>
        <button id="gmc-w-back" class="gmc-w-link">← Change number</button>
        <button id="gmc-w-resend" class="gmc-w-link" disabled>Resend code (<span id="gmc-w-timer">30</span>s)</button>
      </div>

      <p id="gmc-w-err" class="gmc-w-err"></p>
      <div id="gmc-recaptcha"></div>
      <p class="gmc-w-fine">We use your number only to save your prediction. No spam.</p>
    </div>
  `;
  document.body.appendChild(el);
  gmcWireWelcome();
}

let _gmcResendTimer = null;

function gmcStartResendTimer() {
  const btn = document.getElementById("gmc-w-resend");
  const span = document.getElementById("gmc-w-timer");
  let t = 30;
  btn.disabled = true;
  clearInterval(_gmcResendTimer);
  _gmcResendTimer = setInterval(() => {
    t--; if (span) span.textContent = t;
    if (t <= 0) {
      clearInterval(_gmcResendTimer);
      btn.disabled = false;
      btn.innerHTML = "Resend code";
    }
  }, 1000);
}

function gmcWErr(msg) {
  const e = document.getElementById("gmc-w-err");
  if (e) { e.textContent = msg || ""; e.style.display = msg ? "block" : "none"; }
}

function gmcWireWelcome() {
  const nameEl  = document.getElementById("gmc-w-name");
  const phoneEl = document.getElementById("gmc-w-phone");
  const sendBtn = document.getElementById("gmc-w-send");
  const step1   = document.getElementById("gmc-step-1");
  const step2   = document.getElementById("gmc-step-2");
  const otpEl   = document.getElementById("gmc-w-otp");
  const verifyBtn = document.getElementById("gmc-w-verify");

  phoneEl.addEventListener("input", () => { phoneEl.value = phoneEl.value.replace(/\D/g, "").slice(0,10); });
  otpEl  && otpEl.addEventListener("input", () => { otpEl.value = otpEl.value.replace(/\D/g, "").slice(0,6); });

  // SEND OTP
  sendBtn.addEventListener("click", async () => {
    gmcWErr("");
    const name  = (nameEl.value || "").trim();
    const phone = (phoneEl.value || "").trim();
    if (name.length < 2)  { gmcWErr("Please enter your name."); return; }
    if (phone.length !== 10) { gmcWErr("Enter a valid 10-digit number."); return; }

    sendBtn.disabled = true; sendBtn.textContent = "Sending…";
    const r = await fbSendOtp(phone, "gmc-recaptcha");
    sendBtn.disabled = false; sendBtn.textContent = "Send OTP";

    if (!r.ok) { gmcWErr(r.error); return; }
    document.getElementById("gmc-w-tonum").textContent = "+91 " + phone;
    step1.style.display = "none";
    step2.style.display = "block";
    gmcStartResendTimer();
    otpEl.focus();
  });

  // VERIFY OTP
  verifyBtn.addEventListener("click", async () => {
    gmcWErr("");
    const code = (otpEl.value || "").trim();
    if (code.length !== 6) { gmcWErr("Enter the 6-digit code."); return; }

    verifyBtn.disabled = true; verifyBtn.textContent = "Verifying…";
    const r = await fbVerifyOtp(code);
    if (!r.ok) { verifyBtn.disabled = false; verifyBtn.textContent = "Verify & Continue"; gmcWErr(r.error); return; }

    // verified → sync to backend
    const name  = (nameEl.value || "Student").trim();
    const phone = r.phone || (phoneEl.value || "").trim();
    const avatar = gmcAvatarFor(name);

    try {
      const res = await fetch(`${API_BASE}/sync-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, picture: avatar })
      });
      const data = await res.json();
      if (data.result !== "success") throw new Error(data.error || "sync failed");

      const u = data.user;
      // Persist using the SAME keys global.js already expects, plus phone.
      localStorage.setItem("gmc-logged-in",  "true");
      localStorage.setItem("gmc-user-email", u.email || "");
      localStorage.setItem("gmc-user-name",  u.name  || name);
      localStorage.setItem("gmc-user-phone", phone);
      localStorage.setItem("gmc-user-pic",   avatar);
      localStorage.setItem("gmc-is-premium", u.is_pro ? "true" : "false");
      localStorage.setItem("gmc-tokens-left", u.tokens_left ?? 0);
      localStorage.setItem("gmc-refer-code", u.my_refer_code || "");

      gmcHideWelcome(true);
    } catch (e) {
      verifyBtn.disabled = false; verifyBtn.textContent = "Verify & Continue";
      gmcWErr("Verified, but couldn't save. Check your connection and retry.");
      console.error(e);
    }
  });

  // BACK
  document.getElementById("gmc-w-back").addEventListener("click", () => {
    gmcWErr(""); step2.style.display = "none"; step1.style.display = "block";
  });

  // RESEND
  document.getElementById("gmc-w-resend").addEventListener("click", async () => {
    gmcWErr("");
    const phone = (phoneEl.value || "").trim();
    const r = await fbSendOtp(phone, "gmc-recaptcha");
    if (!r.ok) { gmcWErr(r.error); return; }
    gmcStartResendTimer();
  });
}

function gmcHideWelcome(reloadState) {
  const el = document.getElementById("gmc-welcome");
  if (el) el.classList.add("gmc-w-hide");
  document.body.classList.remove("gmc-locked");
  // refresh app UI now that we're logged in
  if (reloadState) {
    if (typeof updateUIState === "function") updateUIState();
    if (typeof refreshUserState === "function") refreshUserState();
    if (typeof window.gmcOnVerified === "function") window.gmcOnVerified();
  }
}

function gmcShowWelcome() {
  gmcBuildWelcome();
  document.body.classList.add("gmc-locked");
  const el = document.getElementById("gmc-welcome");
  if (el) el.classList.remove("gmc-w-hide");
}

/* ── Boot: decide whether to gate ──────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  if (gmcIsVerified()) {
    // already in — make sure avatar exists
    if (!localStorage.getItem("gmc-user-pic")) {
      localStorage.setItem("gmc-user-pic", gmcAvatarFor(localStorage.getItem("gmc-user-name")));
    }
  } else {
    gmcShowWelcome();
  }
});
