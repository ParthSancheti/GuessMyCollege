/* ============================================================================
   GUESS MY COLLEGE — FIREBASE PHONE OTP MODULE  (OTP rebuild)
   ----------------------------------------------------------------------------
   This replaces Google Auth as the live login path. It powers the Welcome
   screen (Name + Phone -> OTP -> verified) and then hands identity to the
   existing backend via /sync-phone (which synthesizes phone@phone.gmc).

   SETUP (you do this in the Firebase console — see the guide):
     1. Create project, enable Phone sign-in.
     2. Register a Web App, copy its firebaseConfig.
     3. PASTE that config into FIREBASE_CONFIG below.
     4. Add your domain to Authentication -> Settings -> Authorized domains.
   ========================================================================== */

  const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC6f1fRfdCyoNfKbDCw8zhiMIrQJ7wIEwM",
  authDomain: "guess-my-collage.firebaseapp.com",
  projectId: "guess-my-collage",
  storageBucket: "guess-my-collage.firebasestorage.app",
  messagingSenderId: "707147040157",
  appId: "1:707147040157:web:f84445b8b3e44d4aebdb74",
  measurementId: "G-R3T9RGVSX6"
};

// Loaded once. Uses the Firebase compat SDK (added via <script> in the HTML).
let _fbAuth = null;
let _confirmationResult = null;
let _recaptchaVerifier = null;

function fbInit() {
  if (_fbAuth) return _fbAuth;
  if (typeof firebase === "undefined") {
    console.error("Firebase SDK not loaded. Check the <script> tags.");
    return null;
  }
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  _fbAuth = firebase.auth();
  _fbAuth.useDeviceLanguage();
  return _fbAuth;
}

/** Builds (once) an invisible reCAPTCHA tied to a container element id. */
function fbEnsureRecaptcha(containerId) {
  const auth = fbInit();
  if (!auth) throw new Error("Firebase not ready");
  if (_recaptchaVerifier) return _recaptchaVerifier;
  _recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, {
    size: "invisible",
    callback: () => {}            // solved automatically
  });
  return _recaptchaVerifier;
}

/**
 * Send an OTP to an Indian phone number.
 * @param {string} rawPhone  10-digit number (with or without +91)
 * @param {string} recaptchaContainerId  id of an empty div for invisible reCAPTCHA
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function fbSendOtp(rawPhone, recaptchaContainerId) {
  try {
    const auth = fbInit();
    if (!auth) return { ok: false, error: "Auth service unavailable." };

    const digits = String(rawPhone || "").replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, error: "Enter a valid 10-digit number." };
    const e164 = digits.length === 10 ? `+91${digits}` : `+${digits}`;

    const verifier = fbEnsureRecaptcha(recaptchaContainerId);
    _confirmationResult = await auth.signInWithPhoneNumber(e164, verifier);
    return { ok: true };
  } catch (e) {
    // Reset reCAPTCHA so the next attempt gets a fresh token.
    try { if (_recaptchaVerifier) { _recaptchaVerifier.clear(); _recaptchaVerifier = null; } } catch (_) {}
    let msg = "Could not send OTP. Try again.";
    if (e && e.code === "auth/too-many-requests") msg = "Too many attempts. Wait a while and retry.";
    else if (e && e.code === "auth/invalid-phone-number") msg = "That phone number looks invalid.";
    else if (e && e.code === "auth/quota-exceeded") msg = "Daily OTP limit reached. Try later.";
    console.error("fbSendOtp:", e);
    return { ok: false, error: msg };
  }
}

/**
 * Verify the 6-digit OTP the user typed.
 * @returns {Promise<{ok:boolean, phone?:string, error?:string}>}
 */
async function fbVerifyOtp(code) {
  try {
    if (!_confirmationResult) return { ok: false, error: "Please request an OTP first." };
    const cred = await _confirmationResult.confirm(String(code).trim());
    const phone = (cred.user && cred.user.phoneNumber) ? cred.user.phoneNumber.replace(/\D/g, "") : "";
    return { ok: true, phone };
  } catch (e) {
    let msg = "Incorrect or expired code.";
    if (e && e.code === "auth/code-expired") msg = "Code expired. Request a new one.";
    console.error("fbVerifyOtp:", e);
    return { ok: false, error: msg };
  }
}

/** Optional: sign the Firebase session out (our app state lives in localStorage). */
async function fbSignOut() {
  try { const a = fbInit(); if (a) await a.signOut(); } catch (_) {}
}
