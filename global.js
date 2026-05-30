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

    if (isLoggedIn()) {
        const userName  = localStorage.getItem('gmc-user-name') || 'Student';
        const userPic   = localStorage.getItem('gmc-user-pic')  || 'https://i.pravatar.cc/150?img=11';
        const tokensLeft = getTokensLeft();
        const pro        = isPremium();

        // PRO badge — shows token dots + clear credit count for PRO users
        const tokenDots = pro ? _buildTokenDots(tokensLeft) : '';
        const creditColor = tokensLeft === 0
            ? 'text-red-500'
            : tokensLeft === 1
                ? 'text-amber-500'
                : 'text-purple-500 dark:text-purple-400';
        const creditLabel = tokensLeft === 0
            ? '0 Predictions — Top Up!'
            : `${tokensLeft} Prediction${tokensLeft === 1 ? '' : 's'} Left`;
        const badgeHTML = pro
            ? `<div class="mb-1 mt-1 inline-flex items-center gap-2 px-3 py-1 rounded-md bg-gradient-to-r from-purple-600 to-blue-600 text-[10px] font-black text-white uppercase tracking-widest shadow-md">
                   ⚡ Pro Member
               </div>
               <div class="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 mb-1 mt-1">
                   <span class="text-[11px] font-black ${creditColor}">${creditLabel}</span>
                   <span class="flex gap-1">${tokenDots}</span>
               </div>`
            : `<div class="mb-4 mt-1 inline-flex items-center px-3 py-1 rounded-md bg-gray-200 dark:bg-gray-800 text-[10px] font-black text-gray-500 dark:text-gray-400 uppercase tracking-widest">Free User</div>`;

        // Upgrade button for free users, ALWAYS show Top-Up for PRO users
        let actionHTML = '';
        if (!pro) {
            actionHTML = `<button onclick="window.location.href='premium.html'" class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-3 shadow-md">💎 Upgrade to Pro</button>`;
        } else {
            // "Get More" button permanently available in the dropdown for PRO users
            actionHTML = `<button onclick="openTopupFlow()" class="w-full flex items-center justify-center gap-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-600 dark:text-amber-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2 mt-3 shadow-sm">🔋 Get More Tokens</button>`;
        }

        authSection.innerHTML = `
            <div class="w-16 h-16 rounded-full border-[3px] border-purple-500 mb-3 overflow-hidden shadow-[0_0_20px_rgba(168,85,247,0.4)] p-0.5 bg-white dark:bg-[#050508]">
                <img src="${userPic}" class="w-full h-full rounded-full object-cover" onerror="this.src='https://i.pravatar.cc/150?img=11'">
            </div>
            <p class="text-xl font-black text-black dark:text-white mb-1 tracking-tight">${userName}</p>
            ${badgeHTML}
            ${actionHTML}
            <button onclick="openReferModal()" class="w-full flex items-center justify-center gap-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-600 dark:text-purple-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95 mb-2">
                🎁 Refer & Earn
            </button>
            <button onclick="logoutUser()" class="w-full flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 font-bold text-sm py-2.5 px-4 rounded-xl transition-all active:scale-95">
                Log Out
            </button>
        `;

        if (profileImg) profileImg.src = userPic;
        if (premiumDot) premiumDot.classList.toggle('hidden', !pro);

    } else {
        // Logged-out state
        authSection.innerHTML = `
            <div class="w-14 h-14 rounded-full bg-gradient-to-tr from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800 mb-3 flex items-center justify-center shadow-inner">
                <svg class="w-6 h-6 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
            </div>
            <p class="text-base font-black text-black dark:text-white mb-1">Guest User</p>
            <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-5">Login to sync your predictions</p>
            <button onclick="openLoginModal()" class="w-full flex items-center justify-center gap-2 bg-white dark:bg-[#0a0a12] text-black dark:text-white font-bold text-sm py-3 px-4 rounded-xl shadow-md border border-black/10 dark:border-white/10 hover:-translate-y-1 transition-all active:scale-95">
                <svg class="w-4 h-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Continue with Google
            </button>
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

function openLoginModal() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown) dropdown.classList.add('hidden', 'opacity-0', 'scale-95');

    const modal = document.getElementById('loginModal');
    const card  = document.getElementById('loginCard');
    if (!modal || !card) { window.location.href = 'login.html'; return; }

    document.body.style.overflow = 'hidden';
    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    setTimeout(() => {
        modal.classList.remove('opacity-0');
        card.classList.remove('scale-95');
        google.accounts.id.initialize({
            client_id: "707147040157-2lvmjbatj9j9tn4nbm98m3dqp9uh5o97.apps.googleusercontent.com",
            callback: handleCredentialResponse
        });
        google.accounts.id.renderButton(
            document.getElementById("google-button-container"),
            {
                theme: document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline',
                size: "large", width: 300, shape: "pill"
            }
        );
    }, 10);
}

function closeLoginModal() {
    const modal = document.getElementById('loginModal');
    const card  = document.getElementById('loginCard');
    if (!modal || !card) return;
    modal.classList.add('opacity-0');
    card.classList.add('scale-95');
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.body.style.overflow = '';
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

// B3 — Fix: was just an alert() stub
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
    .then(data => {
        if (data.result === 'success') {
            saveUserToStorage(data.user, userPic);
            updateUIState();
            updateTokenBadge();
            closeLoginModal();

            Swal.fire({
                toast: true, position: 'top-end', icon: 'success',
                title: 'Logged in!', showConfirmButton: false, timer: 2000,
                customClass: { popup: 'glass-swal' }
            });

            // B2 FIX: only auto-trigger predict flow if we're on the index page
            if (isOnIndexPage()) {
                handlePredictClick(new Event('click'));
            }
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
// Keep old name working for any pages that still call it
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
    // Force 'dark' as the absolute default if no preference is saved
    const saved = localStorage.getItem('gmc-theme') || 'dark';
    
    if (saved === 'light') {
        document.documentElement.classList.remove('dark');
        updateThemeText('Light');
    } else {
        document.documentElement.classList.add('dark');
        updateThemeText('Dark');
    }
}

initTheme();

function toggleGlobalTheme(event) {
    if (typeof triggerHaptic === 'function') triggerHaptic();
    
    const isDark = document.documentElement.classList.contains('dark');
    const circle = document.getElementById('theme-circle');

    // If we have an event and the circle exists, do the explosion
    if (circle && event) {
        // 1. Color the expanding circle as the *next* theme
        circle.style.backgroundColor = isDark ? '#f0f4f8' : '#050508';
        
        // 2. Position precisely at the mouse click (much safer than bounding boxes)
        circle.style.left = event.clientX + 'px';
        circle.style.top  = event.clientY + 'px';
        
        // 3. Reset any stuck animation states
        circle.classList.remove('expand-active');
        circle.style.transition = 'none';
        
        // 4. Force browser layout reflow so it registers the starting position
        void circle.offsetWidth;
        
        // 5. Execute the expansion
        circle.style.transition = 'transform 0.6s cubic-bezier(0.64, 0.04, 0.26, 1.01)';
        circle.classList.add('expand-active');
        
        // 6. Swap the theme in the background right as the screen gets covered
        setTimeout(() => {
            executeThemeSwap();
        }, 300);

        // 7. Hide the circle invisibly AFTER the body has finished its own CSS transition
        setTimeout(() => {
            circle.style.transition = 'none';
            circle.classList.remove('expand-active');
        }, 700);

    } else {
        // Instant fallback if animation fails
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
//  8. DYNAMIC FLOATING REFER & EARN BADGE
// ─────────────────────────────────────────────
function injectFloatingReferBadge() {
    if (document.getElementById('floating-refer-badge')) return;
    
    // Calculate waiting balance (₹50 per successful referral)
    const count = parseInt(localStorage.getItem('gmc-refer-count') || '0');
    const balance = count * 50;
    const subText = balance > 0 ? `<span class="text-green-300">₹${balance} Waiting to Withdraw</span>` : `<span class="text-blue-100">Get Free PRO & Cash</span>`;
    
    const badge = document.createElement('div');
    badge.id = 'floating-refer-badge';
    badge.className = 'fixed top-[60%] right-0 -translate-y-1/2 z-[150] translate-x-[76%] hover:translate-x-0 transition-transform duration-300 cursor-pointer shadow-2xl';
    
    badge.innerHTML = `
        <div onclick="openReferModal()" class="bg-gradient-to-l from-purple-900 to-blue-900 text-white p-3 pl-4 pr-5 rounded-l-2xl flex items-center gap-3 border border-r-0 border-white/20 shadow-[0_0_25px_rgba(168,85,247,0.6)]">
            <span class="text-2xl animate-pulse drop-shadow-md">💸</span>
            <div class="flex flex-col text-left">
                <span class="text-xs font-black uppercase tracking-widest leading-tight text-purple-200">Refer & Earn</span>
                <span class="text-[10px] font-bold">${subText}</span>
            </div>
        </div>
    `;
    document.body.appendChild(badge);
}
