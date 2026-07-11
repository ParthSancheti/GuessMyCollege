/* ============================================================================
   GUESS MY COLLEGE — PROFILE MENU · KEY · ADMIN  (OTP rebuild, v2)
   Powers the header profile dropdown in predict.html: name/phone/avatar,
   plan badge, always-available key entry, admin button (pro only), logout.
   Also exposes gmcPromptKey() for when the 4 free predictions run out.
   ========================================================================== */

function gmcIsPro() { return localStorage.getItem("gmc-is-premium") === "true"; }

function gmcRefreshProfileMenu() {
  const name  = localStorage.getItem("gmc-user-name")  || "Student";
  const phone = localStorage.getItem("gmc-user-phone") || "";
  const pic   = localStorage.getItem("gmc-user-pic")
             || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=6d28d9&color=fff&bold=true`;
  const pro   = gmcIsPro();
  const tokens = parseInt(localStorage.getItem("gmc-tokens-left") || "0", 10);
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };

  set("gmc-profile-img", el => el.src = pic);
  set("gmc-menu-img",    el => el.src = pic);
  set("gmc-menu-name",   el => el.textContent = name);
  set("gmc-menu-phone",  el => el.textContent = phone ? ("+91 " + phone) : "—");

  set("gmc-plan-badge", el => {
    if (pro) {
      el.style.background = "rgba(34,197,94,.18)"; el.style.color = "#86efac";
      el.innerHTML = "♾️ Unlimited";
    } else {
      el.style.background = "rgba(124,58,237,.18)"; el.style.color = "#c4b5fd";
      el.innerHTML = `Free · <span id="gmc-free-left">${Math.max(0, tokens)}</span> left`;
    }
  });

  set("header-token-count", el => el.textContent = pro ? "♾️" : Math.max(0, tokens));
  set("token-pill-label",   el => el.textContent = pro ? "Plan" : "Free");
  set("gmc-admin-btn",   el => el.classList.toggle("hidden", !pro));
  set("gmc-key-section", el => el.style.display = pro ? "none" : "block");
}

function gmcToggleProfile(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById("gmc-profile-menu");
  if (!menu) return;
  const opening = menu.classList.contains("hidden");
  menu.classList.toggle("hidden");
  if (opening) gmcRefreshProfileMenu();
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("gmc-profile-menu");
  const btn  = document.getElementById("gmc-profile-btn");
  if (!menu || !btn) return;
  if (!menu.classList.contains("hidden") && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

async function gmcDoRedeem(key) {
  const email = localStorage.getItem("gmc-user-email") || "";
  if (!email) { if (typeof gmcShowWelcome === "function") gmcShowWelcome(); return { ok:false }; }
  key = String(key || "").trim().toUpperCase();
  if (!key) return { ok:false, error:"Please enter a key." };
  try {
    const res = await fetch(`${API_BASE}/redeem-key`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, key })
    });
    const data = await res.json();
    if (data.result !== "success") return { ok:false, error: data.error || "Invalid key." };
    localStorage.setItem("gmc-is-premium", "true");
    localStorage.setItem("gmc-tokens-left", "99999");
    return { ok:true };
  } catch (e) { return { ok:false, error:"Network error. Try again." }; }
}

async function gmcRedeemFromMenu() {
  const inp = document.getElementById("gmc-key-input");
  const r = await gmcDoRedeem(inp ? inp.value : "");
  if (!r.ok) {
    Swal.fire({ icon:"error", title:"Invalid Key", text:r.error,
      customClass:{ popup:"glass-swal", confirmButton:"glass-swal-confirm" }});
    return;
  }
  Swal.fire({ icon:"success", title:"Unlimited Unlocked!", text:"Admin Panel is now available in your profile.",
    customClass:{ popup:"glass-swal", confirmButton:"glass-swal-confirm" }
  }).then(() => window.location.reload());
}

function gmcPromptKey() {
  const email = localStorage.getItem("gmc-user-email") || "";
  if (!email) { if (typeof gmcShowWelcome === "function") gmcShowWelcome(); return; }
  Swal.fire({
    title: "Unlock Unlimited",
    html: `<p style="font-size:13px;font-weight:600;opacity:.75;margin:-4px 0 16px;">
             You've used your 4 free predictions. Enter an unlimited key to keep going.</p>
           <input id="gmc-key-in" maxlength="40" autocomplete="off" spellcheck="false" placeholder="ENTER KEY"
             style="width:100%;box-sizing:border-box;text-align:center;text-transform:uppercase;letter-spacing:.12em;
                    font-weight:900;font-size:1.1rem;padding:16px 14px;border-radius:1rem;
                    border:1.5px solid rgba(124,58,237,.4);background:rgba(124,58,237,.06);color:inherit;outline:none;">`,
    showCancelButton: true, confirmButtonText: "Activate", cancelButtonText: "Later",
    customClass: { popup: "glass-swal", confirmButton: "glass-swal-confirm" },
    focusConfirm: false,
    preConfirm: async () => {
      const r = await gmcDoRedeem(document.getElementById("gmc-key-in").value);
      if (!r.ok) { Swal.showValidationMessage(r.error || "Invalid key."); return false; }
      return true;
    }
  }).then(r => {
    if (r.isConfirmed) {
      Swal.fire({ icon:"success", title:"Unlimited Unlocked!", text:"Predictions are now unlimited.",
        customClass:{ popup:"glass-swal", confirmButton:"glass-swal-confirm" }
      }).then(() => window.location.reload());
    }
  });
}

function gmcOpenAdmin() { window.location.href = "dashboard.html"; }

function gmcLogout() {
  ["gmc-logged-in","gmc-user-email","gmc-user-name","gmc-user-phone","gmc-user-pic",
   "gmc-is-premium","gmc-tokens-left","gmc-refer-code"].forEach(k => localStorage.removeItem(k));
  if (typeof fbSignOut === "function") { try { fbSignOut(); } catch(_){} }
  window.location.reload();
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => { try { gmcRefreshProfileMenu(); } catch (_) {} }, 300);
});
