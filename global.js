// =====================================================================
// GUESS MY COLLEGE — MASTER STATE, GATEKEEPER & UI ENGINE  (Phase 2)
// =====================================================================

const API_BASE = "https://parthsancheti.pythonanywhere.com";

// ─────────────────────────────────────────────
//  0. MASTER REFERRAL CATCHER (Runs on every page)
// ─────────────────────────────────────────────
(function catchReferralLink() {
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    if (refCode) {
        localStorage.setItem('gmc-pending-ref', refCode.toUpperCase());
        
        // RED TEAM FIX: Only auto-pop login if they are on the Index page.
        // This prevents conflicting modals on premium.html
        if (!isLoggedIn() && isOnIndexPage() && typeof openLoginModal === 'function') {
            setTimeout(openLoginModal, 600);
        }
    }
})();

// ─────────────────────────────────────────────
//  1. STATE HELPERS
// ─────────────────────────────────────────────
function isLoggedIn()  { return localStorage.getItem('gmc-logged-in')   === 'true'; }
// FIX B2 helper: explicitly clear a consumed/expired pending referral code
function clearPendingRef() { localStorage.removeItem('gmc-pending-ref'); }
function isPremium()   { return localStorage.getItem('gmc-is-premium')  === 'true'; }
function getTokensLeft() { return parseInt(localStorage.getItem('gmc-tokens-left') || '0'); }
function isOnIndexPage() {
    const p = window.location.pathname;
    return p === '/' || p.endsWith('index.html') || p.endsWith('/');
}

/** Write every user field from a /sync-user or /get-user response to localStorage */
function saveUserToStorage(user, picOverride) {
    localStorage.setItem('gmc-logged-in',    'true');
    localStorage.setItem('gmc-user-email',   user.email      || '');
    localStorage.setItem('gmc-user-name',    user.name       || 'Student');
    localStorage.setItem('gmc-user-pic',     picOverride || user.picture || '');
    localStorage.setItem('gmc-is-premium',   user.is_pro     ? 'true' : 'false');
    localStorage.setItem('gmc-tokens-left',  user.tokens_left ?? 0);
    localStorage.setItem('gmc-refer-code',   user.my_refer_code   || '');
    localStorage.setItem('gmc-refer-count',  user.referral_count  || 0);
    localStorage.setItem('gmc-reward-claimed', user.reward_claimed || 0);
    if (user.created_at) localStorage.setItem('gmc-created-at', user.created_at);
}

// ─────────────────────────────────────────────
//  B1 — refreshUserState: sync fresh data from DB on every page load
// ─────────────────────────────────────────────
async function refreshUserState() {
    const email = localStorage.getItem('gmc-user-email');
    if (!email || !isLoggedIn()) return;
    try {
        const res  = await fetch(`${API_BASE}/get-user?email=${encodeURIComponent(email)}`);
        const data = await res.json();
        if (data.result === 'success') {
            saveUserToStorage(data.user);
            updateUIState();
            updateTokenBadge();
        }
    } catch (_) {
        // Silently fail — stale localStorage data is still usable
    }
}

// ─────────────────────────────────────────────
//  2. UI STATE — profile panel + token badge
// ─────────────────────────────────────────────
function updateUIState() {
    const authSection = document.getElementById('auth-section');
    const profileImg  = document.getElementById('user-profile-img');
    const premiumDot  = document.getElementById('premium-dot');

    if (!authSection) return;

    // ── NEW: Bulletproof Glassmorphic Redeem UI (FLEXBOX FIXED) ──
    const redeemHTML = `
        <style>
            /* Self-contained CSS to guarantee it works on every page */
            #product-key-input::placeholder { color: #888; font-weight: 600; text-transform: none; }
            html.dark #product-key-input::placeholder { color: #aaa; }
            
            .safe-glass-input { 
                background: rgba(0,0,0,0.04); 
                border: 1.5px solid rgba(0,0,0,0.08); 
                color: #111; 
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); 
            }
            html.dark .safe-glass-input { 
                background: rgba(255,255,255,0.06); 
                border: 1.5px solid rgba(255,255,255,0.12); 
                color: #fff; 
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.2); 
            }
            .safe-glass-input:focus { 
                border-color: #8b5cf6; 
                outline: none; 
                box-shadow: 0 0 0 3px rgba(139,92,246,0.15); 
            }
        </style>

        <div class="w-full mt-4 mb-2">
            <!-- Message & Unlimited Badge -->
            <div class="flex items-center justify-between px-1 mb-1.5">
                <span class="text-[10px] font-black uppercase tracking-widest text-purple-600 dark:text-purple-400 flex items-center gap-1.5 min-w-0 truncate">
                    <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4v-3l8.44-8.44A6 6 0 0115 7h.01M15 7a2 2 0 00-2-2"></path></svg>
                    VIP Access
                </span>
                <span class="text-[9px] font-bold text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded-md shrink-0">Unlimited ♾️</span>
            </div>
            
            <!-- Input Box (min-w-0 prevents it from pushing the button out) -->
            <div class="flex items-center gap-1.5">
                <input type="text" id="product-key-input" placeholder="Enter key..." class="safe-glass-input flex-1 min-w-0 text-xs font-black uppercase rounded-xl px-2.5 py-2 transition-all" autocomplete="off" spellcheck="false">
                <button id="redeem-btn" onclick="redeemProductKey()" class="shrink-0 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white text-[10px] font-black uppercase tracking-wide px-3 py-2 rounded-xl active:scale-95 transition-all shadow-md">
                    Redeem
                </button>
            </div>
        </div>
    `;

    if (isLoggedIn()) {
        const userName  = localStorage.getItem('gmc-user-name') || 'Student';
        const userPic   = localStorage.getItem('gmc-user-pic')  || 'https://i.pravatar.cc/150?img=11';
        const tokensLeft = getTokensLeft();
        const pro        = isPremium();

        const tokenDots = pro ? _buildTokenDots(tokensLeft) : '';
        const creditColor = tokensLeft === 0 ? 'text-red-500' : tokensLeft === 1 ? 'text-amber-500' : 'text-purple-500 dark:text-purple-400';
        
        const creditLabel = tokensLeft === 0 
            ? '0 Predictions — Top Up!' 
            : tokensLeft > 1000 
                ? 'Unlimited Predictions ♾️' 
                : `${tokensLeft} Prediction${tokensLeft === 1 ? '' : 's'} Left`;
        const badgeHTML = pro
            ? `<div class="mb-1 mt-1 inline-flex items-center gap-2 px-3 py-1 rounded-md bg-gradient-to-r from-purple-600 to-blue-600 text-[10px] font-black text-white uppercase tracking-widest shadow-md">⚡ Pro Member</div>
               <div class="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 mb-1 mt-1">
                   <span class="text-[11px] font-black ${creditColor}">${creditLabel}</span>
                   <span class="flex gap-1">${tokenDots}</span>
               </div>`
            : `<div class="mb-4 mt-1 inline-flex items-center px-3 py-1 rounded-md bg-gray-200 dark:bg-gray-800 text-[10px] font-black text-gray-500 dark:text-gray-400 uppercase tracking-widest">Free User</div>`;

        let actionHTML = '';
        if (!pro) {
            actionHTML = `<button onclick="window.location.href='premium.html'" class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-3 shadow-md">💎 Upgrade to Pro</button>`;
        } else {
            actionHTML = `<button onclick="openTopupFlow()" class="w-full flex items-center justify-center gap-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-600 dark:text-amber-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-3 shadow-sm">🔋 Get More Tokens</button>`;
        }

        // ── Show Admin Dashboard ONLY to the whitelisted admin email (FIX B3) ──
        const ADMIN_EMAILS = ['parthsancheti@gmail.com']; // <-- set your real admin email(s) here
        const _curEmail = (localStorage.getItem('gmc-user-email') || '').toLowerCase();
        const isAdmin = ADMIN_EMAILS.map(e => e.toLowerCase()).includes(_curEmail);
        const adminBtnHTML = isAdmin ? `
            <button onclick="window.location.href='dashboard.html'" class="w-full flex items-center justify-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-1 shadow-sm">
                🛡️ Admin Dashboard
            </button>
        ` : '';

        authSection.innerHTML = `
            <div class="w-16 h-16 rounded-full border-[3px] border-purple-500 mb-3 overflow-hidden shadow-[0_0_20px_rgba(168,85,247,0.4)] p-0.5 bg-white dark:bg-[#050508]">
                <img src="${userPic}" class="w-full h-full rounded-full object-cover" onerror="this.src='https://i.pravatar.cc/150?img=11'">
            </div>
            <p class="text-xl font-black text-black dark:text-white mb-1 tracking-tight">${userName}</p>
            ${badgeHTML}
            ${actionHTML}
            
            ${!pro ? redeemHTML : ''}
            
            ${adminBtnHTML} <!-- Injects the Admin Button Here! -->
            
            <button onclick="openReferModal()" class="w-full flex items-center justify-center gap-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-600 dark:text-purple-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-1">
                🎁 Refer & Earn
            </button>
            <button onclick="logoutUser()" class="w-full flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95">
                Log Out
            </button>
        `;   

        if (profileImg) profileImg.src = userPic;
        if (premiumDot) premiumDot.classList.toggle('hidden', !pro);

    } else {
        authSection.innerHTML = `
            <div class="w-14 h-14 rounded-full bg-gradient-to-tr from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800 mb-3 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
            </div>
            <p class="text-base font-black text-black dark:text-white mb-1">Guest User</p>
            <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-5">Login to sync your predictions</p>
            <button onclick="openLoginModal()" class="w-full flex items-center justify-center gap-2 bg-white dark:bg-[#0a0a12] text-black dark:text-white font-bold text-sm py-3 px-4 rounded-xl shadow-md border border-black/10 dark:border-white/10 hover:-translate-y-1 transition-all active:scale-95 mb-2">
                <svg class="w-4 h-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Continue with Google
            </button>
            ${redeemHTML}
        `;
        if (profileImg) profileImg.src = "https://ui-avatars.com/api/?name=Guest&background=random";
        if (premiumDot) premiumDot.classList.add('hidden');
    }
}

/** B4 — Build the 3-dot token indicator for the profile panel */
function _buildTokenDots(count) {
    const MAX = 3;
    let dots = '';
    for (let i = 0; i < MAX; i++) {
        if (i < count) {
            dots += `<span class="w-3 h-3 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 shadow-[0_0_6px_rgba(168,85,247,0.6)]"></span>`;
        } else {
            dots += `<span class="w-3 h-3 rounded-full bg-gray-300 dark:bg-gray-700"></span>`;
        }
    }
    return dots;
}

/** B5 — update the floating token badge inside predict.html (if present) */
function updateTokenBadge() {
    const badge = document.getElementById('token-badge');
    if (!badge) return;
    const t = getTokensLeft();
    const pro = isPremium();
    if (!pro || !isLoggedIn()) { badge.classList.add('hidden'); return; }
    badge.classList.remove('hidden');

    const colors   = t === 0 ? 'bg-red-500/15 border-red-500/30 text-red-500'
                   : t === 1 ? 'bg-amber-500/15 border-amber-500/30 text-amber-500'
                   :           'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-300';
    const label    = t === 0 ? '0 left — Top Up' : `${t} prediction${t === 1 ? '' : 's'} left`;
    const dotsHTML = _buildTokenDots(t);

    badge.className = `fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-2xl border backdrop-blur-xl shadow-lg font-black text-xs cursor-pointer transition-all hover:-translate-y-1 ${colors}`;
    badge.innerHTML = `<span class="flex gap-1">${dotsHTML}</span> ${label}`;
    badge.onclick   = t === 0 ? openTopupFlow : null;
}

// ─────────────────────────────────────────────
//  3. THE IRON-CLAD GATEKEEPER
// ─────────────────────────────────────────────
function handlePredictClick(event) {
    event.preventDefault();
    if (!isLoggedIn()) {
        openLoginModal();
    } else if (!isPremium()) {
        window.location.href = 'premium.html';
    } else if (typeof launchExplosion === 'function') {
        launchExplosion(event, 'predict');
    } else {
        window.location.href = 'predict.html';
    }
}

// ─────────────────────────────────────────────
//  B7 — Top-Up flow shortcut (server decides is_topup from DB)
// ─────────────────────────────────────────────
function openTopupFlow() {
    // No localStorage flag needed — backend checks DB for is_pro
    window.location.href = 'premium.html?topup=1';
}

// ─────────────────────────────────────────────
//  4. MODAL CONTROLS
// ─────────────────────────────────────────────
function toggleProfileMenu() {
    const menu = document.getElementById('profile-dropdown');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
        menu.classList.remove('hidden');
        setTimeout(() => { menu.classList.remove('opacity-0', 'scale-95'); }, 10);
    } else {
        menu.classList.add('opacity-0', 'scale-95');
        setTimeout(() => menu.classList.add('hidden'), 200);
    }
}

document.addEventListener('click', (event) => {
    const profileBtn = document.getElementById('profile-btn');
    const dropdown   = document.getElementById('profile-dropdown');
    if (profileBtn && dropdown &&
        !profileBtn.contains(event.target) && !dropdown.contains(event.target)) {
        if (!dropdown.classList.contains('hidden')) {
            dropdown.classList.add('opacity-0', 'scale-95');
            setTimeout(() => dropdown.classList.add('hidden'), 200);
        }
    }
});

// ─────────────────────────────────────────────
//  4. MODAL CONTROLS (Updated with safe Google Render)
// ─────────────────────────────────────────────

function openLoginModal() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown) dropdown.classList.add('hidden', 'opacity-0', 'scale-95');

    const modal = document.getElementById('loginModal');
    const card  = document.getElementById('loginCard');
    if (!modal || !card) { window.location.href = 'index.html?login=1'; return; }

    document.body.style.overflow = 'hidden';
    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('scale-95');
        
        // ── FIX: Safely wait for Google script to load before rendering ──
        renderGoogleButtonSafe();
    }, 10);
}

// ── NEW HELPER: Ensures Google is loaded before rendering ──
function renderGoogleButtonSafe() {
    const container = document.getElementById("google-button-container");
    if (!container) return;

    // If Google library isn't fully loaded yet, show a spinner and retry in 100ms
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
        container.innerHTML = `<svg class="w-6 h-6 animate-spin mx-auto text-purple-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
        setTimeout(renderGoogleButtonSafe, 100);
        return;
    }

    container.innerHTML = ''; // Clear the spinner
    
    google.accounts.id.initialize({
        client_id: "707147040157-2lvmjbatj9j9tn4nbm98m3dqp9uh5o97.apps.googleusercontent.com",
        callback: handleCredentialResponse
    });
    
    google.accounts.id.renderButton(
        container,
        {
            theme: document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline',
            size: "large", width: 300, shape: "pill"
        }
    );
}

function closeLoginModal() {
    const modal = document.getElementById('loginModal');
    const card  = document.getElementById('loginCard');
    if (!modal || !card) return;

    modal.classList.add('opacity-0');
    card.classList.add('scale-95');

    setTimeout(() => {
        modal.style.display = 'none';
        modal.classList.add('hidden');
        document.body.style.overflow = 'auto'; // Restore scrolling
        
        // ── BUG FIX: Clear ghost redirects so they don't haunt future logins ──
        localStorage.removeItem('gmc-pending-redirect');
    }, 300);
}

function openPremiumModal() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown) dropdown.classList.add('hidden', 'opacity-0', 'scale-95');
    const modal = document.getElementById('premiumModal');
    const card  = document.getElementById('premiumCard');
    if (!modal || !card) { window.location.href = 'premium.html'; return; }
    document.body.style.overflow = 'hidden';
    modal.style.display = 'flex';
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('scale-95');
    }, 10);
}

function closePremiumModal() {
    const modal = document.getElementById('premiumModal');
    const card  = document.getElementById('premiumCard');
    if (!modal || !card) return;
    modal.classList.add('opacity-0');
    card.classList.add('scale-95');
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }, 300);
}

function payForPremium() {
    window.location.href = 'premium.html';
}

// ─────────────────────────────────────────────
//  5. GOOGLE LOGIN & DB SYNC
// ─────────────────────────────────────────────
function handleCredentialResponse(response) {
    const payload  = decodeJwtResponse(response.credential);
    const userEmail = payload.email;
    const userName  = payload.name;
    const userPic   = payload.picture;

    const loginCard = document.getElementById('loginCard');
    if (loginCard) loginCard.style.opacity = '0.5';

    fetch(`${API_BASE}/sync-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, name: userName, picture: userPic })
    })
    .then(r => r.json())
    .then(async data => {
        if (data.result === 'success') {
            
            // 1. Save user data to local storage
            saveUserToStorage(data.user, userPic);
            
            // 2. THE FIX: Instant UI Update (No refresh needed!)
            if (typeof updateUIState === 'function') updateUIState();
            if (typeof updateTokenBadge === 'function') updateTokenBadge();

            // 3. Auto-Redeem Pending Product Key
            const pendingKey = localStorage.getItem('gmc-pending-key');
            
            if (pendingKey) {
                localStorage.removeItem('gmc-pending-key');
                try {
                    const rKey = await fetch(`${API_BASE}/redeem-key`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: userEmail, key: pendingKey })
                    });
                    const dKey = await rKey.json();
                    
                    if (dKey.result === 'success') {
                        Swal.fire({ 
                            toast: true, position: 'top-end', icon: 'success', 
                            title: 'Product Key Redeemed! PRO Unlocked.', 
                            showConfirmButton: false, timer: 1500, 
                            customClass: { popup: 'glass-swal' } 
                        });
                        
                        closeLoginModal();
                        
                        // Force a reload ONLY on successful key redeem to apply PRO features
                        setTimeout(() => window.location.reload(), 1500);
                        return; 
                    } else {
                        // Key failed, but they are still logged in
                        Swal.fire({ 
                            icon: 'error', title: 'Invalid Key', text: dKey.error, 
                            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' } 
                        });
                    }
                } catch(e) {
                    console.error("Key redemption failed during login:", e);
                }
            } else {
                // 4. Standard Login Success
                Swal.fire({
                    toast: true, position: 'top-end', icon: 'success',
                    title: 'Logged in!', showConfirmButton: false, timer: 1000,
                    customClass: { popup: 'glass-swal' }
                });
            }

            // Clean up and close modal for both standard logins and failed keys
            if (loginCard) loginCard.style.opacity = '1';
            closeLoginModal();

        } else {
            throw new Error(data.error || 'Sync failed');
        }
    })
    .catch(err => {
        if (loginCard) loginCard.style.opacity = '1';
        Swal.fire({
            icon: 'error', title: 'Login Error',
            text: 'Could not connect to the server. Make sure Python backend is running.',
            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
        });
    });
}

function decodeJwtResponse(token) {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(
        window.atob(base64).split('').map(c =>
            '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        ).join('')
    ));
}

// ─────────────────────────────────────────────
//  LOGOUT
// ─────────────────────────────────────────────
function logoutUser() {
    const keys = [
        'gmc-logged-in','gmc-user-email','gmc-user-name','gmc-user-pic',
        'gmc-is-premium','gmc-tokens-left','gmc-refer-code','gmc-refer-count',
        'gmc-reward-claimed','gmc-created-at'
    ];
    keys.forEach(k => localStorage.removeItem(k));
    
    if (typeof updateUIState === 'function') updateUIState();
    if (typeof updateTokenBadge === 'function') updateTokenBadge();

    // RED TEAM FIX: Kick them to home if they are on ANY protected page
    const protectedPages = ['predict', 'calc', 'booking', 'refer', 'premium'];
    const isProtected = protectedPages.some(page => window.location.pathname.includes(page));
    
    if (isProtected) {
        window.location.href = 'index.html';
    }
}
function logoutTest() { logoutUser(); }

// ─────────────────────────────────────────────
//  6. REFER & EARN REDIRECT
// ─────────────────────────────────────────────
function openReferModal() {
    if (!isLoggedIn()) {
        Swal.fire({
            icon: 'warning', title: 'Login Required',
            text: 'Please login to view your Referral Dashboard.',
            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
        });
        return;
    }
    // Redirect straight to the new page instead of opening a popup
    window.location.href = 'refer.html';
}

// ─────────────────────────────────────────────
//  7. THEME ENGINE
// ─────────────────────────────────────────────
function initTheme() {
    // 1. Check for saved user preference
    const saved = localStorage.getItem('gmc-theme');
    
    // 2. Check system OS preference
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    // 3. Apply dark mode if user explicitly saved 'dark', 
    // OR if there's no saved preference and the system is in dark mode.
    const useDark = saved === 'dark' || (saved === null && sysDark);
    
    if (useDark) {
        document.documentElement.classList.add('dark');
        updateThemeText('Dark');
    } else {
        document.documentElement.classList.remove('dark');
        updateThemeText('Light');
    }
}

initTheme();

function toggleGlobalTheme(event) {
    if (typeof triggerHaptic === 'function') triggerHaptic();
    const isDark    = document.documentElement.classList.contains('dark');
    const targetBtn = event?.currentTarget || null;
    const circle    = document.getElementById('theme-circle');

    if (circle && targetBtn) {
        const rect = targetBtn.getBoundingClientRect();
        circle.style.backgroundColor = isDark ? '#f0f4f8' : '#050508';
        circle.style.left = (rect.left + rect.width / 2) + 'px';
        circle.style.top  = (rect.top  + rect.height / 2) + 'px';
        circle.style.transform = 'scale(400)';
        targetBtn.style.pointerEvents = 'none';
        setTimeout(() => {
            executeThemeSwap();
            circle.style.transition = 'none';
            circle.style.transform  = 'scale(0)';
            setTimeout(() => {
                circle.style.transition = 'transform 0.6s cubic-bezier(0.64,0.04,0.26,1.01)';
                targetBtn.style.pointerEvents = 'auto';
            }, 50);
        }, 300);
    } else {
        executeThemeSwap();
    }
}

function executeThemeSwap() {
    document.documentElement.classList.toggle('dark');
    const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    localStorage.setItem('gmc-theme', mode);
    updateThemeText(mode === 'dark' ? 'Dark' : 'Light');
}

function updateThemeText(mode) {
    const el = document.getElementById('theme-status');
    if (el) el.textContent = mode;
}

// ─────────────────────────────────────────────
//  8. (removed) Dead floating refer badge — index.html has its own #refer-wrapper button.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  9. PRODUCT KEY SYSTEM
// ─────────────────────────────────────────────
async function redeemProductKey() {
    const keyInput = document.getElementById('product-key-input');
    const key = keyInput ? keyInput.value.trim() : '';
    const email = localStorage.getItem('gmc-user-email');

    if (!key) {
        Swal.fire({ 
            icon: 'warning', title: 'Empty Field', text: 'Please enter a valid product key.', 
            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
        });
        return;
    }

    // If the user isn't logged in, save the key and trigger the login modal!
    if (!isLoggedIn() || !email) {
        localStorage.setItem('gmc-pending-key', key);
        
        Swal.fire({ 
            icon: 'info', title: 'Login Required', text: 'Please log in with Google first so we can tie the PRO access to your account!', 
            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
        }).then(() => {
            openLoginModal();
        });
        return;
    }

    const btn = document.getElementById('redeem-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/redeem-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, key: key })
        });
        
        const data = await res.json();

        if (data.result === 'success') {
            Swal.fire({ 
                icon: 'success', title: 'Unlocked!', text: data.message, 
                customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
            }).then(() => {
                // Single reload after user acknowledges (FIX B7: removed duplicate failsafe reload)
                window.location.reload();
            });

            keyInput.value = '';
            
        } else {
            Swal.fire({ 
                icon: 'error', title: 'Invalid Key', text: data.error, 
                customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
            });
        }
    } catch (err) {
        Swal.fire({ 
            icon: 'error', title: 'Error', text: 'Could not connect to the server.', 
            customClass: { popup: 'glass-swal', confirmButton: 'glass-swal-confirm' }
        });
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// ── BUG FIX: Close modal on outside click ──
window.addEventListener('click', (event) => {
    const modal = document.getElementById('loginModal');
    const card = document.getElementById('loginCard');
    
    // If the modal is visible and the user clicked directly on the dark overlay (not the card inside)
    if (modal && modal.style.display === 'flex' && event.target === modal) {
        closeLoginModal();
    }
});


// ── BUG FIX B1: Sync UI across multiple tabs instantly (use REAL keys) ──
window.addEventListener('storage', (event) => {
    // Any change to a core auth/state key in another tab should re-render this tab
    if (event.key && event.key.startsWith('gmc-')) {
        if (typeof updateUIState === 'function') updateUIState();
        if (typeof updateTokenBadge === 'function') updateTokenBadge();
    }
});