<div align="center">
  <img src="v2.5/bin/logo.png" alt="Guess My College Logo" width="150" height="150">
  
  # Guess My College 🎓
  **Calculate & Predict Your Future Instantly**

  A premium MHT-CET score calculator and college prediction engine powered by AI.

  <p align="center">
    <a href="#features">Features</a> •
    <a href="#project-structure">Structure</a> •
    <a href="#tech-stack">Tech Stack</a> •
    <a href="#tailwind-setup">Tailwind</a> •
    <a href="#backend--pythonanywhere-setup">Backend Setup</a> •
    <a href="#deploy">Deploy</a>
  </p>
</div>

---

## 🌟 Overview

**Guess My College** is designed to seamlessly process student response sheets from the MHT-CET exam, calculate raw scores automatically without needing error tracking, and run those scores against over 10,000 historical cutoffs. It uses advanced mapping (incorporating categories and branches) alongside Google's Gemini AI to offer Safe, Moderate, and Reach college options.

### What Does the App Do?
- **Instant Calculations:** Upload a response sheet, and the system parses the official format instantly.
- **AI-Powered Predictions:** Recommends colleges tailored specifically to the calculated score and user category.
- **Premium Services:** SaaS monetization with Cashfree allows users to buy premium plans or book one-on-one sessions.
- **Incredible Aesthetics:** A highly modern UI using glassmorphism, dynamic hue-shifting animations, and native dark mode.

---

## 🖼️ Glimpses of the UI

| Calculate | Predict |
|-----------|---------|
| <img src="v2.5/bin/g1.png" width="400"> | <img src="v2.5/bin/g2.png" width="400"> |


---

## 📁 Project Structure (What is Where)

The project consists of an older, base iteration at the root and a highly polished `v2.5` directory which is the current flagship version.

```text
GuessMyCollege/
├── v2.5/                      # (VvIMP) THE LATEST AND GREATEST VERSION
│   ├── index.html             # Stunning animated Landing Page
│   ├── predict.html           # The Core AI Prediction Engine UI
│   ├── calc.html              # The Marks Calculator UI
│   ├── booking.html           # 1-on-1 Session Booking UI
│   ├── dashboard.html         # SuperAdmin Dashboard for Database Management
│   ├── global.js              # Global JS state, animations, and API helpers
│   ├── bin/                   # Contains all Images, SVGs, and Tailwind Output CSS
│   ├── ServerSide/            # The Python Backend Environment
│   │   ├── flask_app.py       # The massive Flask Engine (API, Auth, Gemini)
│   │   ├── MHTCET_Master.db   # 10,000+ Past Cutoffs Read-Only Database
│   │   └── Users.db           # SaaS User Accounts, Economy, Tokens
│   └── DataBase/              # Zip files of the scraping engines and data
├── package.json               # Node setup for Tailwind CSS
├── tailwind.config.js         # Configuration for Tailwind build
├── input.css                  # Source CSS for Tailwind
├── index.html, predict.html   # (Legacy) Older iterations of the UI
├── firebase-auth.js           # Firebase OTP logic
└── README_SETUP.md            # Legacy instructions for OTP rebuild
```

---

## 🛠️ Tech Stack

- **Frontend:** HTML5, Vanilla JavaScript, Tailwind CSS (v3.4)
- **Backend:** Python 3.x, Flask (`flask_app.py`)
- **Database:** SQLite (`MHTCET_Master.db` for data, `Users.db` for auth/logs)
- **Payments:** Cashfree Payment Gateway SDK
- **AI/ML:** Google Gemini API (`google-genai`)
- **Authentication:** Google Identity Services (`gsi/client`) & Firebase Phone Auth

---

## 🎨 Tailwind CSS Setup & Commands

The project uses Tailwind CSS for rapid UI development. The config watches your HTML and JS files for changes.

1. **Install Node.js** (if you don't have it).
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Compile the CSS (Development/Watch Mode):**
   This command watches your files and live-compiles `output.css` whenever you hit save.
   ```bash
   npx tailwindcss -i ./input.css -o ./v2.5/bin/output.css --watch
   ```
4. **Compile for Production:**
   ```bash
   npx tailwindcss -i ./input.css -o ./v2.5/bin/output.css --minify
   ```

*Note: The `tailwind.config.js` is already set up to scan `**/*.html` and `*.js` for class names, including the `v2.5` directory.*

---

## ☁️ Backend & PythonAnywhere Setup

The backend logic resides in `v2.5/ServerSide/flask_app.py`. To deploy this on PythonAnywhere (or any other VPS):

### 1. Requirements Installation
Open a bash console on your host and install the dependencies:
```bash
pip install flask python-dotenv google-genai requests bs4 openpyxl flask-cors
```

### 2. Environment Variables (.env)
You must set up the following environment variables. In PythonAnywhere, you can add this to a `.env` file in the same directory as `flask_app.py`, or set them via the WSGI script.

```ini
GEMINI_API_KEY=your_gemini_api_key_here
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key
CASHFREE_ENV=production  # Use 'sandbox' for testing
GMC_ADMIN_PASSWORD=your_superadmin_password
GMC_PRODUCT_KEYS=UNLIMITED-2026,ANOTHER-KEY
```

### 3. Deploy on PythonAnywhere
- Upload the `v2.5` directory to your web app's source folder.
- In the PythonAnywhere **Web** tab, set the source code directory to the location of `v2.5/ServerSide`.
- Set your WSGI file to import `app` from `flask_app`. Example WSGI config:
  ```python
  import sys
  path = '/home/yourusername/mysite/v2.5/ServerSide'
  if path not in sys.path:
      sys.path.append(path)
  
  from flask_app import app as application
  ```
- Hit **Reload** on PythonAnywhere.

---

## 🔐 Firebase Auth Setup (OTP)

If you are using the Phone OTP setup mentioned in the legacy configuration (`firebase-auth.js`):
1. Go to the [Firebase Console](https://console.firebase.google.com).
2. Create a project → Enable Authentication → Sign-in method → Phone.
3. Add your domain (`yourdomain.com`) to the **Authorized domains** list.
4. Copy your `firebaseConfig` block and paste it into `firebase-auth.js` or `global.js` where the authentication initializes.

---

## 👑 The Admin Dashboard

The platform includes a hidden SuperAdmin dashboard (`dashboard.html` in `v2.5`). 
- **Security:** It requires a valid `GMC_PRODUCT_KEYS` to unlock the button, and the `GMC_ADMIN_PASSWORD` to view the data.
- **Features:** It allows you to view all registered students, their scores, and export the database seamlessly to Excel or CSV.

---

## 🚀 How to dump this to GitHub

1. Initialize Git (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Initial commit of Guess My College v2.5"
   ```
2. Create a repository on GitHub.
3. Link your local repository to GitHub:
   ```bash
   git remote add origin https://github.com/YourUsername/GuessMyCollege.git
   git branch -M main
   git push -u origin main
   ```
   
> **100-Year Guarantee:** Even if you open this repository a century from now, just run the tailwind watch command for styling, spin up the Flask app in `v2.5/ServerSide`, and everything will click back into place! 🚀
