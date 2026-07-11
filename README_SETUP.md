# Guess My College — OTP Rebuild

The app is now a single flow: **Welcome (Name + Phone → OTP) → Predict**.
Google Auth and the Cashfree payment gate are kept in the code but disabled.
Free users get **4 predictions**; an **unlimited key** unlocks unlimited use
and reveals the **SuperAdmin** student-database panel (password-gated).

---

## Files in this drop

| File | What it is |
|---|---|
| `flask_app.py` | Backend. Added: `students` table, `/sync-phone`, `/admin/students`, `/admin/export-students`, free-4-then-key gate. Cashfree/Google paths left dormant. |
| `predict.html` | The live app. Welcome/OTP gate fronts it; form trimmed (no exam-date / PCM), percentile enlarged; saves student rows. |
| `index.html` | Now redirects into `predict.html`. Old marketing page saved as `index_OLD_marketing_backup.html`. |
| `dashboard.html` | SuperAdmin panel — student database + Excel/CSV export. Password-gated. |
| `firebase-auth.js` | Firebase phone-OTP module. **Paste your config here.** |
| `welcome.js` / `welcome.css` | The Welcome/OTP overlay. |
| `keyadmin.js` | Unlimited-key prompt + admin-panel entry button. |
| `global.js` | Unchanged from your upload (still included by pages). |

---

## 1. Firebase setup (you do this once)

1. https://console.firebase.google.com → **Add project**.
2. **Build → Authentication → Get started → Sign-in method → Phone → Enable**.
3. Project Overview → **`</>`** (web app) → register → copy the `firebaseConfig`.
4. **Paste that config** into `firebase-auth.js` (the `FIREBASE_CONFIG` block at the top).
5. **Authentication → Settings → Authorized domains** → add
   `parthsancheti.pythonanywhere.com` and `localhost`.
6. (Testing, no SMS used) Sign-in method → Phone → **Phone numbers for testing**
   → add e.g. `+91 9999999999` = `123456`.

> Free Spark plan ≈ 10 real SMS/day. Use test numbers while building; switch to
> Blaze (card) before launch.

## 2. Backend env vars (PythonAnywhere)

```
GMC_ADMIN_PASSWORD = <your superadmin password>     # required for the admin panel
GMC_PRODUCT_KEYS   = UNLIMITED-2026,ANOTHER-KEY      # your unlimited keys (comma-sep)
GEMINI_API_KEY     = <existing, optional>
```

Install the Excel lib once: `pip install openpyxl`

The `students` table is created automatically on first run (migration-safe — your
existing `Users.db` is untouched, just gains one new table).

## 3. Deploy

Upload all files to your web root (same place as before). Reload the web app on
PythonAnywhere. Done.

---

## How the flow works

- **New phone user** → `/sync-phone` creates a row keyed on `phone@phone.gmc`
  (so the whole existing backend keeps working) and seeds `tokens_left = 4`.
- **Each prediction** decrements a free token and writes one `students` row
  (name, phone, percentile, category, branch, city, shift, matches, time).
- **5th attempt** → backend returns `402 LIMIT_REACHED` → the key prompt appears.
- **Correct key** → `/redeem-key` sets `is_pro=1, tokens_left=99999` → unlimited,
  and the **Admin Panel** button appears.
- **Admin Panel** → `dashboard.html` → enter `GMC_ADMIN_PASSWORD` → full student
  table + **Excel** (server `.xlsx`) and **CSV** export.

Two-layer admin security: must have the **key** (to see the button) **and** the
**password** (to open the data).

---

## Notes / things you may want to tweak

- **Free count**: change `FREE_PREDICTIONS = 4` in `flask_app.py`.
- **Profile pic**: auto-generated from the name via `ui-avatars.com` and stored.
  Swap to uploads later if you want.
- **Shift field** kept as *optional* (slightly better accuracy). Remove if you
  prefer an even cleaner form.
- **Cashfree / Google**: still present but disabled — flip back on later if needed.
- Each prediction currently writes a row **per category×branch query**; if you
  only want one row per click, we can dedupe to the primary query — easy change.
